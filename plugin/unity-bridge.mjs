// 作者: ydd12333
//
// DSH 侧 Unity Bridge 客户端插件（host 全局插件，npm 包 main 入口）。
// 由真实 Node ESM 加载（非动态 Cordis 沙箱），因此可用 node:http 与 Unity
// 侧的本地 HTTP 服务通信。注册 9 个模型可调用的工具：
//   unity_health / unity_compile / unity_refresh / unity_logs /
//   unity_execute / unity_scene_open / unity_asset_get /
//   unity_mcp_catalog / unity_mcp
//
// 安装（推荐）：把本仓库作为 DSH 插件包一键安装——
//   cd unity-bridge 仓库目录
//   dsh plugin --profile web add .          # 或 pnpm dsh plugin --profile web add .
//   或从 git：dsh plugin --profile web add https://github.com/ydd12333/unity-bridge.git
// dsh plugin 内部在 DSH profile 目录执行 pnpm add，装好后自动把声明了
// dsh.bundle 的本包加入 profile 层栈（见仓库根 cordis.patch.yml 与
// package.json 的 dsh.bundle 声明），无需手改任何配置；重启 profile 生效。
//
// 作为 host 全局插件，任何 preset、任何会话都可用 unity_* 工具。
//
// 注意：本文件经包入口加载，内部无法解析 harness 的 @deepseek-ai/dsh-tools，
// 因此手写完整 ToolDefinition 传给 ctx.tools.register。
// register 的 parameters 直接投影给模型，必须是完整 JSON Schema。

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const HOST = '127.0.0.1'
const DEFAULT_PORT = 8321
const DEFAULT_TIMEOUT_MS = 30000

export const name = 'unity-bridge'
export const inject = ['tools', 'systemPrompt']

// 统一反斜杠、去尾分隔符、仅 ASCII 小写（与 Unity 侧 NormalizePath 对齐，
// 用于 /health 项目路径交叉校验）。
function normalizePath(path) {
  if (!path) return ''
  return path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

// Unity 侧在启动成功后把实际监听端口（含顺延结果）写入
// <项目根>/Library/UnityBridgePort.txt。DSH 侧优先读该文件做动态发现，
// 彻底绕开“固定端口被占用后顺延”的失配问题。
// 读不到时回退：UNITY_BRIDGE_PORT 环境变量 > 固定端口 DEFAULT_PORT。
function portFileForCwd(cwd) {
  if (!cwd) return undefined
  try {
    return path.join(cwd, 'Library', 'UnityBridgePort.txt')
  } catch {
    return undefined
  }
}

function readPortFile(portFile) {
  if (!portFile) return undefined
  try {
    return parsePort(fs.readFileSync(portFile, 'utf8').trim())
  } catch {
    return undefined
  }
}

// 从工具执行上下文取当前会话项目目录，据此定位对应的 Unity 实例。
function portForExec(exec) {
  const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header
    ? exec.agent.session.header.cwd
    : undefined
  const envPort = parsePort(process.env.UNITY_BRIDGE_PORT)
  if (envPort) return envPort
  const fromFile = readPortFile(portFileForCwd(cwd))
  if (fromFile) return fromFile
  return DEFAULT_PORT
}

// 把字符串解析成合法端口（1~65535），非法值返回 undefined。
function parsePort(value) {
  if (value === undefined || value === null || value === '') return undefined
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined
}

// ── HTTP 客户端 ────────────────────────────────────────────────────────────

function request(method, path, body, timeoutMs = DEFAULT_TIMEOUT_MS, signal, port) {
  const base = `http://${HOST}:${port}`
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const req = http.request(
      `${base}${path}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': data.length } : {}),
        },
        timeout: timeoutMs,
        ...(signal ? { signal } : {}),
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          let text = Buffer.concat(chunks).toString('utf8')
          if (!text) text = '{}'
          let parsed
          try { parsed = JSON.parse(text) } catch { parsed = { ok: false, error: 'invalid JSON response' } }
          if (res.statusCode >= 500) {
            reject(new Error(`Unity 返回错误(${res.statusCode}): ${parsed.error || text}`))
            return
          }
          if (parsed.ok === false) {
            reject(new Error(parsed.error || 'Unity 操作失败'))
            return
          }
          resolve(parsed.data)
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)))
    req.on('error', (err) => reject(new Error(`无法连接 Unity Bridge（${base}）：${err.message}。请确认 Unity 已打开且 Tools/Unity Bridge 已启动。`)))
    if (data) req.write(data)
    req.end()
  })
}

// 按当前会话项目目录发起请求（自动定位端口并携带取消信号）。
// 端口文件指向的端口连不上时，回退尝试固定端口 DEFAULT_PORT——覆盖
// “同一项目多实例时端口文件被覆盖”与“端口文件残留”两类场景。
// 回退前先用短超时探测 /health，避免对无响应实例等满完整超时。
async function call(exec, method, path, body, timeoutMs) {
  const primary = portForExec(exec)
  const fallback = process.env.UNITY_BRIDGE_PORT ? undefined : DEFAULT_PORT

  try {
    return await request(method, path, body, timeoutMs, exec && exec.signal, primary)
  } catch (err) {
    if (fallback && fallback !== primary) {
      // 短超时探测回退端口是否真的有响应，避免等满 timeoutMs。
      try {
        await request('GET', '/health', undefined, 3000, exec && exec.signal, fallback)
      } catch {
        throw err // 回退端口无响应，报主候选错误
      }
      return request(method, path, body, timeoutMs, exec && exec.signal, fallback)
    }
    throw err
  }
}

// /health 且校验项目路径：兜底连错实例（多实例/端口文件失配）时立即报错。
async function healthChecked(exec) {
  const h = await call(exec, 'GET', '/health')
  const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header
    ? exec.agent.session.header.cwd
    : undefined
  if (cwd && h.projectPath && normalizePath(cwd) !== normalizePath(h.projectPath)) {
    throw new Error(`项目不匹配：当前会话目录 ${cwd} 与 Unity 实例项目 ${h.projectPath} 不一致（端口文件指向其他实例或选错项目）。请确认已打开对应项目的 Unity 实例。`)
  }
  return h
}

// 轮询直到编译结束。
// 编译触发 domain reload 时服务会重建，期间 /health 可能短暂连接失败
//（ECONNREFUSED/ECONNRESET），属预期行为：捕获后等待重试，不中断轮询。
async function waitCompileDone(exec, intervalMs = 800, maxWaitMs = 120000) {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    try {
      const h = await call(exec, 'GET', '/health')
      if (!h.compiling) return h
    } catch {
      // reload 窗口：服务正在重建，稍等继续轮询
      await sleep(Math.max(intervalMs, 1200))
      continue
    }
    await sleep(intervalMs)
  }
  return call(exec, 'GET', '/health')
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// ── 工具定义辅助 ───────────────────────────────────────────────────────────

// 把 property map（每个属性带 description 与可选 required:true）转成完整
// JSON Schema（ctx.tools.register 的 parameters 直接投影给模型）。
function paramSchema(props) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(props || {})) {
    const { required: isRequired, ...rest } = spec
    properties[key] = rest
    if (isRequired) required.push(key)
  }
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  }
}

// output 的 canonical schema：{ text: string }。
const TEXT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
}

function register(ctx, name, description, props, execute, timeoutMs) {
  ctx.tools.register({
    name,
    description,
    parameters: paramSchema(props),
    output: {
      schema: TEXT_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    ...(timeoutMs ? { timeoutMs } : {}),
    async execute(args, exec) {
      const result = await execute(args, exec)
      return { text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }
    },
  })
}

// ── Unity Bridge 工具速查表 ────────────────────────────────────────────────
//
// 通过 systemPrompt section 注入，帮助模型高效调用 unity_mcp 透传工具。
// 直接调用：unity_mcp 的 tool 与 params.action 见下表。

const UNITY_BRIDGE_CHEATSHEET = `# Unity Bridge 工具速查表

本插件提供两类 Unity 编辑器工具：
- 精选工具（unity_health/compile/refresh/logs/execute/scene_open/asset_get）：已做参数约束与编译轮询。
- 透传工具 unity_mcp：调用 Unity 内 MCP for Unity 包的任意工具。先用 unity_mcp_catalog 查清单，再传 { tool, params }。

常用映射（tool → action，params 里先传 action 再传其余参数）：
- 场景 manage_scene：get_active / load / save / create / get_hierarchy / get_build_settings / screenshot / close_scene / set_active_scene / get_loaded_scenes / move_to_scene / modify_build_settings
- 资源 manage_asset：import / create / modify / delete / duplicate / move / rename / search / get_info / create_folder / get_components
- 游戏对象 manage_gameobject：create / modify / delete / duplicate / move_relative / look_at
- 查找 find_gameobjects：searchMethod(by_name/by_path/by_tag/by_layer/by_component…) + searchTerm
- 组件 manage_components：add / remove / set_property
- 预制体 manage_prefabs：create_from_gameobject / get_info / get_hierarchy / modify_contents / open_prefab_stage / save_prefab_stage / close_prefab_stage
- 脚本 manage_script：create / read / update / delete / apply_text_edits / validate / edit / replace_class / delete_class / replace_method / delete_method / insert_method / anchor_*
- 构建 manage_build：build / status / platform / settings / scenes / profiles / batch / cancel
- 测试 run_tests + get_test_job：run_tests(启动, mode=EditMode/PlayMode) → get_test_job(job_id 查结果)
- 日志 read_console：plain / json / detailed
- 刷新 refresh_unity：mode(force/if_dirty) + scope + compile
- 菜单 execute_menu_item：menu_path（如 "File/Save Project"）
- 编辑器 manage_editor：play / pause / stop / undo / redo / set_resolution / set_quality / add_tag / remove_tag / add_layer / remove_layer
- 材质 manage_material：create / set_material_color / assign_material_to_renderer / get_material_info
- UI manage_ui：create / read / update / delete / list / render_ui / get_visual_tree
- 包管理 manage_packages：add_package / remove_package / list_packages / search_packages / get_package_info / resolve_packages
- 脚本化对象 manage_scriptable_object：set / array_resize
- 纹理 manage_texture：create / create_sprite / modify / delete / set_import_settings
- 着色器 manage_shader：create / read / update / delete
- 动画 manage_animation：get_info / play / crossfade / set_parameter / set_speed / add_transition / add_parameter
- 相机 manage_camera：create_camera / screenshot / list_cameras / set_lens
- 物理 manage_physics：raycast / raycast_all / get_settings / set_settings / create_physics_material
- 分析器 manage_profiler：profiler_start / profiler_stop / get_frame_timing / memory_take_snapshot
- 反射 unity_reflect：get_type / get_member / search
- VFX manage_vfx、图形 manage_graphics、ProBuilder manage_probuilder、ExecuteCode execute_code 等按需用 unity_mcp_catalog 查询。

调用约定：
- unity_mcp 参数：{ tool: "manage_scene", params: { action: "get_active" } }。
- 结果统一为 { success, data } 或 { success, error }；先看 success 判断成败。
- 破坏性操作（删除/覆盖/构建）前先用只读 action（get_info/list/get_active）确认目标。`

// ── 插件入口 ───────────────────────────────────────────────────────────────

export function apply(ctx) {
  ctx.systemPrompt.section({
    name: 'unity-bridge-tools',
    order: 150,
    text: UNITY_BRIDGE_CHEATSHEET,
  })

  register(ctx, 'unity_health',
    '查询 Unity 编辑器状态（是否正在编译/刷新、项目名、Unity 版本、监听端口、项目路径）。',
    {},
    (_args, exec) => healthChecked(exec))

  register(ctx, 'unity_compile',
    '触发 Unity 脚本编译并等待完成，返回编译是否成功以及编译错误列表。',
    {},
    async (_args, exec) => {
      await call(exec, 'POST', '/compile', {}, DEFAULT_TIMEOUT_MS)
      await waitCompileDone(exec)
      const health = await healthChecked(exec)
      // reload 后服务刚重建，日志缓冲可能尚未就绪：失败时重试一次。
      let logs
      try {
        logs = await call(exec, 'POST', '/logs', { level: 'error' })
      } catch {
        await sleep(1000)
        logs = await call(exec, 'POST', '/logs', { level: 'error' })
      }
      const errors = logs.compileErrors || []
      return {
        success: errors.length === 0,
        compiling: health.compiling,
        errorCount: errors.length,
        errors,
      }
    }, 180000)

  register(ctx, 'unity_refresh',
    '刷新 Unity 资源数据库（AssetDatabase.Refresh），并等待编译结束。',
    {},
    async (_args, exec) => {
      await call(exec, 'POST', '/refresh', {}, DEFAULT_TIMEOUT_MS)
      await waitCompileDone(exec)
      return { refreshed: true }
    }, 180000)

  register(ctx, 'unity_logs',
    '读取 Unity Console 日志与编译错误。',
    {
      limit: { type: 'integer', description: '返回的日志条数上限，默认 200。' },
      level: { type: 'string', description: '按级别过滤：all / log / warning / error，默认 all。' },
    },
    (args, exec) => call(exec, 'POST', '/logs', {
      limit: args.limit ?? 200,
      level: args.level ?? 'all',
    }))

  register(ctx, 'unity_execute',
    '执行 Unity 编辑器静态方法，或按菜单路径执行菜单项。className 传 "__menu" 时按菜单路径执行（如 "File/Save Project"）；否则按 命名空间.类名.方法名 反射执行静态方法（方法名可选）。',
    {
      className: { type: 'string', required: true, description: '类全名，或 "__menu" 表示执行菜单项。' },
      methodName: { type: 'string', required: true, description: '静态方法名，或菜单路径（className 为 __menu 时）。' },
      args: { type: 'array', items: { type: 'string' }, description: '方法参数字符串数组（可选）。' },
    },
    (args, exec) => call(exec, 'POST', '/execute', {
      className: args.className,
      methodName: args.methodName,
      args: args.args ?? [],
    }))

  register(ctx, 'unity_scene_open',
    '在 Unity 编辑器中打开场景（路径相对 Assets/，如 "Assets/GameMain/Scenes/Main.unity"）。',
    {
      path: { type: 'string', required: true, description: '场景资源路径。' },
    },
    (args, exec) => call(exec, 'POST', '/scene/open', { path: args.path }))

  register(ctx, 'unity_asset_get',
    '按路径或 GUID 加载 Unity 资源，返回其类型、路径与依赖列表。',
    {
      path: { type: 'string', description: '资源路径（相对 Assets/）。' },
      guid: { type: 'string', description: '资源 GUID。' },
    },
    (args, exec) => call(exec, 'POST', '/asset/get', { path: args.path, guid: args.guid }))

  register(ctx, 'unity_mcp_catalog',
    '列出当前 Unity 实例可用的 MCP for Unity 工具清单（名称、类型、描述、分组），用于确定某个操作该调用哪个工具。',
    {},
    (_args, exec) => call(exec, 'GET', '/mcp/catalog'))

  register(ctx, 'unity_mcp',
    '透传调用 Unity 编辑器内 MCP for Unity 包的任意工具（约 30 个，覆盖资源/场景/GameObject/组件/脚本/构建/测试/材质/UI/包管理等）。先调用 unity_mcp_catalog 获取可用工具清单，再指定 tool 与对应 params 执行。',
    {
      tool: { type: 'string', required: true, description: 'MCP 工具名（如 manage_scene、manage_asset、manage_gameobject、manage_script、manage_build、run_tests 等），见 unity_mcp_catalog。' },
      params: { type: 'object', description: '传给该工具的参数字典（含 action 子操作名与具体参数）。' },
    },
    (args, exec) => call(exec, 'POST', '/mcp', {
      tool: args.tool,
      params: args.params ?? {},
    }, 180000))
}
