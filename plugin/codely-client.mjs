// Codely Bridge（cn.tuanjie.codely.bridge / NativeTcpBridge）客户端与项目发现。
//
// 为什么需要它：Codely Bridge 自带一整套编辑器工具（manage_gameobject / manage_asset /
// manage_scene / manage_script / manage_editor / manage_input / manage_screenshot /
// execute_csharp_script …），完全不依赖 MCP，也不依赖本项目自己的 UPM 包。它用原生
// TCP 服务 + 内置 Roslyn，因此即使项目当前编译不过（域不重载），它的服务照样在线。
//
// 线上协议（从 codely.exe 内打包的 JS 客户端还原，并已实测）：
//   1) 连接后服务端先发一行 ASCII：
//      WELCOME UNITY-TCP 1 FRAMING=1 SERVER_VERSION=<n> PROJECT_ROOT=<urlencoded>\n
//   2) 服务端 SERVER_VERSION>=2 时，客户端必须先发一帧纯文本 CLIENT_VERSION=2
//   3) 帧 = 8 字节大端 uint64 长度 + UTF-8 负载（长度 0 的帧跳过）
//   4) 命令帧 JSON：{"type":"<命令>","params":{...},"request_id":"<id>"}
//      特例：ping 的负载是纯文本 "ping"，响应 {"success":true,"message":"pong"}
//   5) 响应帧 JSON：{"success":..,"message":..,"data":..,"request_id":..}；
//      带 notification_type 的帧是服务端推送（本客户端忽略）
// 端口来自 <项目根>/Temp/.com-unity-codely.json（原生心跳写入，内容形如
// { unity_port, project_path, reloading, reason, last_updated }）。

import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'

export const CODELY_REGISTRY_FILE = '.com-unity-codely.json'
export const CODELY_DEFAULT_HOST = '127.0.0.1'
const FRAMED_MAX = 64 * 1024 * 1024
const CLIENT_VERSION = 2
const HANDSHAKE_TIMEOUT_MS = 8000

function normalizePath(p) {
  if (!p) return ''
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

export function parseCodelyPort(value) {
  if (value === undefined || value === null || value === '') return undefined
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined
}

// ── 心跳文件与项目发现 ─────────────────────────────────────────────────────

export function codelyRegistryPath(projectRoot) {
  return projectRoot ? path.join(projectRoot, 'Temp', CODELY_REGISTRY_FILE) : undefined
}

// 读取并规范化心跳文件。project_path 是 Unity 的 Application.dataPath（<项目根>/Assets），
// 因此项目根取其父目录；文件里没有项目根时退回传入的 projectRoot。
export function readCodelyRegistry(projectRoot) {
  const file = codelyRegistryPath(projectRoot)
  if (!file) return null
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  const port = parseCodelyPort(raw.unity_port)
  if (!port) return null
  const assetPath = typeof raw.project_path === 'string' && raw.project_path ? raw.project_path.replace(/\//g, '\\').replace(/\\+$/, '') : ''
  const root = assetPath ? path.dirname(assetPath) : projectRoot
  return {
    file,
    port,
    host: typeof raw.unity_host === 'string' && raw.unity_host ? raw.unity_host : CODELY_DEFAULT_HOST,
    projectRoot: normalizePath(root),
    rawRoot: root,
    assetPath,
    reloading: raw.reloading === true,
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    lastUpdated: typeof raw.last_updated === 'string' ? raw.last_updated
      : typeof raw.last_heartbeat === 'string' ? raw.last_heartbeat : '',
  }
}

// 候选项目根：cwd 自身、cwd 的逐级祖先、以及各祖先层级的同级目录。
// 与 unity-bridge 端口文件的候选策略一致：会话在插件仓库、Unity 项目是兄弟目录时，
// 只有“同级目录”这一层能命中。
export function codelyProjectCandidates(cwd) {
  if (!cwd) return []
  const roots = []
  const add = (p) => {
    if (p && !roots.includes(p)) roots.push(p)
  }
  add(cwd)
  for (let d = path.dirname(cwd); d && d !== cwd && d.length > 2; d = path.dirname(d)) {
    add(d)
    if (d.length <= 3) break
  }
  const parents = []
  for (let d = cwd; d && d.length > 2; d = path.dirname(d)) {
    const parent = path.dirname(d)
    if (!parent || parent === d || parent.length <= 3) break
    if (!parents.includes(parent)) parents.push(parent)
  }
  for (const parent of parents) {
    let entries = []
    try { entries = fs.readdirSync(parent, { withFileTypes: true }) } catch { continue }
    for (const ent of entries) {
      if (ent.isDirectory()) add(path.join(parent, ent.name))
    }
  }
  return roots
}

// 定位本次调用应操作的 Codely Bridge 实例。
// 优先级：UNITY_BRIDGE_PROJECT（精确指定项目）> cwd 覆盖的项目 > 唯一候选项目；
// 多候选且 cwd 不在其中 → 拒绝静默选择（避免连错实例）。
// 允许 UNITY_BRIDGE_CODELY_PORT 直连：此时不要求心跳文件存在（但项目校验会跳过）。
// 统一返回形状：{ host, port, projectRoot, rawRoot, registry|null, viaEnvPort }。
// registry 保留原始心跳对象（file/reloading/reason/lastUpdated），供上层做提示与诊断。
function targetFromRegistry(reg, viaEnvPort = false) {
  return {
    host: reg.host,
    port: reg.port,
    projectRoot: reg.projectRoot,
    rawRoot: reg.rawRoot,
    registry: reg,
    viaEnvPort,
  }
}

export function discoverCodely(cwd, opts = {}) {
  const envProject = opts.envProject ? String(opts.envProject) : ''
  const envPort = parseCodelyPort(opts.envPort)
  const envHost = opts.envHost ? String(opts.envHost) : ''

  if (envPort) {
    return {
      port: envPort,
      host: envHost || CODELY_DEFAULT_HOST,
      projectRoot: normalizePath(envProject),
      rawRoot: envProject || '',
      registry: null,
      viaEnvPort: true,
    }
  }

  const found = []
  for (const root of codelyProjectCandidates(cwd)) {
    const reg = readCodelyRegistry(root)
    if (!reg) continue
    if (found.some((r) => r.projectRoot === reg.projectRoot)) continue
    found.push(reg)
  }

  if (envProject) {
    const want = normalizePath(envProject)
    const hit = found.find((r) => r.projectRoot === want)
    if (!hit) {
      throw new Error(
        `UNITY_BRIDGE_PROJECT=${envProject} 下没有 Codely Bridge 心跳文件（期望 ${path.join(envProject, 'Temp', CODELY_REGISTRY_FILE)}）。` +
        `请确认该 Unity 项目装了 cn.tuanjie.codely.bridge（并在运行），或改用 UNITY_BRIDGE_CODELY_PORT=<端口> 直连。`
      )
    }
    return targetFromRegistry(hit)
  }

  const normCwd = normalizePath(cwd)
  if (normCwd) {
    const covering = found
      .filter((r) => normCwd === r.projectRoot || normCwd.startsWith(r.projectRoot + '\\'))
      .sort((a, b) => b.projectRoot.length - a.projectRoot.length)
    if (covering.length) return targetFromRegistry(covering[0])
  }

  if (found.length === 1) return targetFromRegistry(found[0])
  if (found.length === 0) {
    throw new Error(
      `未检测到 Codely Bridge：${cwd || '(会话目录未知)'} 及其祖先/同级目录下都没有 <项目根>/Temp/${CODELY_REGISTRY_FILE}。\n` +
      `可能原因：目标 Unity 项目没装 cn.tuanjie.codely.bridge，或该包未启动（心跳文件由原生 TCP 服务写入）。\n` +
      `解决方法：① 确认目标项目装了 Codely Bridge 并处于运行状态；② 设置 UNITY_BRIDGE_PROJECT=<目标项目绝对路径> 指定项目；` +
      `③ 或设置 UNITY_BRIDGE_CODELY_PORT=<端口> 直连（先看该项目的 Temp/${CODELY_REGISTRY_FILE} 里的 unity_port）。`
    )
  }
  const raw = found.map((r) => r.rawRoot || r.projectRoot)
  throw new Error(
    `检测到多个可用的 Codely Bridge 项目（${raw.join('、')}），而当前会话目录 ${cwd || '(未设置)'} 不在其中任何一个项目内，` +
    `已拒绝自动选择以免连错实例。解决方法：① 在目标 Unity 项目目录下开会话；` +
    `② 设置 UNITY_BRIDGE_PROJECT=<目标项目绝对路径>；③ 或设置 UNITY_BRIDGE_CODELY_PORT=<端口> 直连。`
  )
}

// ── TCP 客户端 ─────────────────────────────────────────────────────────────

const encodeFrame = (payload) => {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8')
  const header = Buffer.allocUnsafe(8)
  header.writeBigUInt64BE(BigInt(body.length), 0)
  return Buffer.concat([header, body])
}

export class CodelyClient {
  constructor({ host = CODELY_DEFAULT_HOST, port, debug = false } = {}) {
    this.host = host
    this.port = port
    this.debug = debug
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.waiters = new Map()
    this.nextId = 1
    this.serverVersion = 1
    this.welcome = ''
    this.notifications = []
  }

  get projectRootFromWelcome() {
    const m = /PROJECT_ROOT=([^\s]+)/.exec(this.welcome || '')
    if (!m) return ''
    try { return decodeURIComponent(m[1]) } catch { return m[1] }
  }

  connect(timeoutMs = HANDSHAKE_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.port, this.host)
      this.socket = socket
      let acc = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { socket.destroy() } catch {}
        reject(new Error(`Codely Bridge 握手超时（${this.host}:${this.port}，${timeoutMs}ms）`))
      }, timeoutMs)

      const done = (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        err ? reject(err) : resolve(this)
      }

      const onFirst = (chunk) => {
        acc += chunk.toString('latin1')
        const nl = acc.indexOf('\n')
        if (nl < 0) return
        const line = acc.slice(0, nl)
        const rest = Buffer.from(acc.slice(nl + 1), 'latin1')
        acc = ''
        socket.removeListener('data', onFirst)
        socket.on('data', (c) => this.#onData(c))

        this.welcome = line
        if (!line.includes('WELCOME UNITY-TCP') || !line.includes('FRAMING=1')) {
          try { socket.destroy() } catch {}
          done(new Error(`Codely Bridge 握手响应异常（期望 "WELCOME UNITY-TCP ... FRAMING=1"）：${line}`))
          return
        }
        const m = /SERVER_VERSION=(\d+)/.exec(line)
        this.serverVersion = m ? Number.parseInt(m[1], 10) : 1
        if (this.serverVersion >= 2) socket.write(encodeFrame(`CLIENT_VERSION=${CLIENT_VERSION}`))
        done(null)
        if (rest.length) this.#onData(rest)
      }

      socket.on('data', onFirst)
      socket.once('error', (e) => done(e))
      socket.once('close', () => done(new Error(`Codely Bridge 连接在握手前关闭（${this.host}:${this.port}）`)))
    })
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 8) {
      const len = Number(this.buffer.readBigUInt64BE(0))
      if (len === 0) { this.buffer = this.buffer.subarray(8); continue }
      if (len > FRAMED_MAX) {
        this.#failAll(new Error(`Codely Bridge 帧长度非法：${len}`))
        return
      }
      if (this.buffer.length < 8 + len) return
      const payload = Buffer.from(this.buffer.subarray(8, 8 + len))
      this.buffer = this.buffer.subarray(8 + len)
      this.#dispatch(payload)
    }
  }

  #dispatch(payload) {
    const text = payload.toString('utf8')
    let msg = null
    try { msg = JSON.parse(text) } catch { msg = null }
    if (this.debug) console.warn(`[codely] <- ${text.slice(0, 200)}`)

    if (msg && typeof msg.notification_type === 'string') {
      this.notifications.push({ notification_type: msg.notification_type, payload: msg.payload ?? null, timestamp: msg.timestamp })
      return
    }
    if (msg && msg.success === true && msg.message === 'pong') {
      const w = this.waiters.get('__ping__')
      if (w) { this.waiters.delete('__ping__'); w.resolve(text) }
      return
    }
    if (msg && typeof msg.request_id === 'string' && this.waiters.has(msg.request_id)) {
      const w = this.waiters.get(msg.request_id)
      this.waiters.delete(msg.request_id)
      w.resolve(text)
      return
    }
    // 无 request_id 的响应（老服务端/未知形状）：交给唯一等待者，避免永久挂起。
    if (this.waiters.size === 1) {
      const [key, w] = [...this.waiters.entries()][0]
      this.waiters.delete(key)
      w.resolve(text)
    }
  }

  #failAll(err) {
    for (const [, w] of this.waiters) w.reject(err)
    this.waiters.clear()
  }

  ping(timeoutMs = 5000) {
    return this.#request('ping', {}, timeoutMs)
  }

  // 发送命令并等待响应原文（JSON 字符串）。
  send(type, params = {}, timeoutMs = 120000) {
    return this.#request(type, params, timeoutMs)
  }

  #request(type, params, timeoutMs) {
    const isPing = type === 'ping'
    const requestId = isPing ? '' : String(this.nextId++)
    const payload = isPing ? 'ping' : JSON.stringify({ type, params: params || {}, request_id: requestId })
    const key = isPing ? '__ping__' : requestId
    if (this.debug) console.warn(`[codely] -> ${payload.slice(0, 200)}`)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(key)
        reject(new Error(`Codely Bridge 命令 ${type} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this.waiters.set(key, {
        resolve: (text) => { clearTimeout(timer); resolve(text) },
        reject: (err) => { clearTimeout(timer); reject(err) },
      })
      try {
        this.socket.write(encodeFrame(payload))
      } catch (e) {
        clearTimeout(timer)
        this.waiters.delete(key)
        reject(e)
      }
    })
  }

  close() {
    try { this.socket?.destroy() } catch { /* 已关闭 */ }
    this.socket = null
    this.#failAll(new Error('Codely Bridge 连接已关闭'))
  }
}

// ── 一次调用的门面：发现实例 → 连接 → 校验项目 → 执行 → 关闭 ───────────────
//
// 每次调用独立连接（Codely 支持多客户端），避免域重载/超时后留下失效连接。
// 项目校验：welcome 的 PROJECT_ROOT 与发现的实例项目根必须一致，否则拒绝执行
// （多实例场景下这是最后一道防连错的闸门）。
export async function codelyCall(type, params, opts = {}) {
  const cwd = opts.cwd
  const target = opts.target || discoverCodely(cwd, {
    envProject: opts.envProject ?? process.env.UNITY_BRIDGE_PROJECT,
    envPort: opts.envPort ?? process.env.UNITY_BRIDGE_CODELY_PORT,
    envHost: opts.envHost ?? process.env.UNITY_BRIDGE_CODELY_HOST,
  })
  const timeoutMs = opts.timeoutMs ?? 120000
  const attempts = opts.attempts ?? 2
  let lastError

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const client = new CodelyClient({ host: target.host, port: target.port, debug: opts.debug === true })
    try {
      await client.connect(Math.min(timeoutMs, HANDSHAKE_TIMEOUT_MS))
      const welcomeRoot = normalizePath(client.projectRootFromWelcome)
      if (welcomeRoot && target.projectRoot && welcomeRoot !== target.projectRoot) {
        throw new Error(
          `项目不匹配：Codely Bridge 实例项目 ${client.projectRootFromWelcome} 与会话目标项目 ${target.rawRoot || target.projectRoot} 不一致。` +
          `可能原因：心跳文件残留/被其他实例覆盖。请确认目标项目，或用 UNITY_BRIDGE_PROJECT 精确指定。`
        )
      }
      if (type !== 'ping' && target.registry && target.registry.reloading) {
        // 域重载中：稍等再连，避免刚好撞上不可用窗口。
        await new Promise((r) => setTimeout(r, 1500))
      }
      const text = await client.send(type, params, timeoutMs)
      let json = null
      try { json = JSON.parse(text) } catch { json = null }
      return {
        ok: true,
        port: target.port,
        host: target.host,
        projectRoot: client.projectRootFromWelcome || target.rawRoot || target.projectRoot,
        serverVersion: client.serverVersion,
        raw: text,
        response: json,
      }
    } catch (err) {
      lastError = err
      const retriable = /ECONNRESET|ECONNREFUSED|EPIPE|握手|关闭/.test(String(err && err.message))
      if (attempt < attempts && retriable) {
        await new Promise((r) => setTimeout(r, 1200))
        continue
      }
      break
    } finally {
      client.close()
    }
  }
  throw lastError
}

// ── 命令目录（供模型选工具用；action 取自 Codely 源码，可能随版本增减）──────
export const CODELY_COMMANDS = {
  manage_editor: {
    desc: '编辑器状态与编辑器级操作（编译/刷新/播放模式/标签层级/窗口）',
    actions: ['get_state', 'get_current_state', 'refresh', 'request_compile', 'get_compilation_summary', 'wait_for_idle', 'play', 'pause', 'resume', 'stop', 'step', 'get_project_root', 'get_windows', 'get_active_tool', 'get_selection', 'set_active_tool', 'focus_window', 'get_tags', 'add_tag', 'remove_tag', 'get_layers', 'add_layer', 'remove_layer'],
  },
  manage_gameobject: {
    desc: '场景/预制体里的 GameObject：查找、创建、改属性、增删组件（searchMethod: by_id/by_name/by_path/by_tag/by_layer/by_component）',
    actions: ['create', 'create_batch', 'modify', 'edit_batch', 'delete', 'find', 'list_children', 'get_components', 'add_component', 'remove_component', 'set_component_property', 'ensure_component', 'ensure_renderer_material', 'ensure_mesh_collider_mesh', 'ensure_prefab_default_sprite', 'select'],
  },
  manage_asset: {
    desc: '资源（含 .prefab/.asset）：查询、创建、改属性、导入、复制移动删除。改预制体用 modify（内部会 PrefabUtility.SavePrefabAsset 落盘）',
    actions: ['get_info', 'get_components', 'search', 'create', 'modify', 'import', 'duplicate', 'move', 'delete', 'create_folder', 'ensure_has_meta', 'ensure_meta_integrity'],
  },
  manage_scene: {
    desc: '场景：打开/新建/保存、层级快照、构建设置',
    actions: ['get_active', 'get_hierarchy', 'load', 'save', 'create', 'ensure_scene_open', 'ensure_scene_saved', 'get_build_settings'],
  },
  manage_script: {
    desc: '脚本文件：读写、整体替换、按类/方法增删、文本补丁、语法校验',
    actions: ['create', 'read', 'update', 'delete', 'apply_text_edits', 'validate', 'edit', 'get_sha', 'replace_class', 'delete_class', 'replace_method', 'delete_method', 'insert_method', 'anchor_insert', 'anchor_replace', 'anchor_delete'],
  },
  read_console: {
    desc: 'Console 日志与编译错误',
    actions: ['get', 'clear'],
  },
  execute_csharp_script: {
    desc: '内置 Roslyn：执行任意 C# 脚本（editor=编辑器进程、play=运行中），这是“任意编辑器操作”的终极通道',
    actions: ['editor', 'play', 'session_status'],
  },
  execute_menu_item: {
    desc: '执行 Unity 菜单项（注意：会弹模态框的菜单会阻塞主线程，优先用 manage_dialog 兜底）',
    actions: ['execute', 'get_available_menus'],
  },
  manage_screenshot: {
    desc: '截图/录制：GameView、SceneView、指定相机、UI Toolkit、多角度刀具视图',
    actions: ['capture', 'capture_asset', 'capture_game_view', 'capture_scene_view', 'capture_scene_camera', 'capture_main_camera', 'capture_specific_camera', 'capture_ui_toolkit', 'start_game_view_recording', 'finish_game_view_recording', 'top', 'bottom', 'front', 'back', 'left', 'right', 'iso', 'cardinal', 'wireframe', 'shadedwireframe', 'all'],
  },
  manage_input: {
    desc: '模拟输入（虚拟设备/鼠标键盘）',
    actions: ['mouse_move', 'mouse_click', 'mouse_clickui', 'mouse_drag', 'mouse_scroll', 'mouse_down', 'mouse_up', 'key_press', 'key_down', 'key_up', 'type_text', 'create_virtual_devices', 'destroy_virtual_devices'],
  },
  manage_gameview: {
    desc: 'GameView 分辨率',
    actions: ['get_resolution', 'set_resolution', 'list_resolutions'],
  },
  manage_package: {
    desc: 'UPM 包管理',
    actions: ['list_packages', 'install_package', 'remove_package'],
  },
  manage_bake: {
    desc: '烘焙：光照/NavMesh',
    actions: ['bake_lighting', 'bake_navmesh', 'wait_for_bake', 'clear_baked_data', 'clear_navmesh'],
  },
  manage_job: {
    desc: '长任务作业控制（后台线程可执行，主线程被阻塞时仍可用）',
    actions: ['list', 'status', 'check', 'cancel'],
  },
  manage_dialog: {
    desc: '点击/关闭阻塞主线程的模态对话框（后台线程可执行）',
    actions: ['click'],
  },
  manage_window_bridge: {
    desc: '原生窗口/内嵌流：窗口列表、聚焦、鼠标键盘输入、离屏流',
    actions: ['list_windows', 'focus_window', 'resolve_native_window', 'input', 'keydown', 'keyup', 'mousedown', 'mouseup', 'mousemove', 'wheel', 'textinput', 'start_stream_server', 'stop_stream_server', 'get_stream_server_status', 'start_offscreen_stream', 'stop_offscreen_stream'],
  },
  get_custom_tools: {
    desc: '列出目标项目自定义的 Codely 工具（execute_custom_tool 用）',
    actions: [],
  },
  execute_custom_tool: {
    desc: '执行项目自定义 Codely 工具',
    actions: [],
  },
}

export function codelyCatalogText() {
  const lines = ['# Codely Bridge 命令目录（tool → 常用 action）', '']
  for (const [tool, info] of Object.entries(CODELY_COMMANDS)) {
    lines.push(`- ${tool}：${info.desc}`)
    if (info.actions.length) lines.push(`  action: ${info.actions.join(' / ')}`)
  }
  lines.push('')
  lines.push('调用方式：codely_call({ tool, params })，params 里必须含 action（除 get_custom_tools/ping 类）。')
  lines.push('通用查找参数：searchMethod=by_id|by_name|by_path|by_tag|by_layer|by_component，配合 target=...。')
  lines.push('结果统一为 { success, message, data }；业务失败会由 codely_call 抛错。')
  return lines.join('\n')
}