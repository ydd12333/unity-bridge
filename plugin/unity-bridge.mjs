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
// Unity 侧组件（UPM 包 com.yd.unitybridge）需要单独安装：本插件在
// systemPrompt 注入 Install.md 的绝对路径（见下方 resolveInstallDoc），
// AI 会话据此读取安装指南并自动完成 Unity 侧安装。
//
// 注意：本文件经包入口加载，内部无法解析 harness 的 @deepseek-ai/dsh-tools，
// 因此手写完整 ToolDefinition 传给 ctx.tools.register。
// register 的 parameters 直接投影给模型，必须是完整 JSON Schema。

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HOST = '127.0.0.1'
const DEFAULT_PORT = 8321
const DEFAULT_TIMEOUT_MS = 30000
// /health 探测用短超时：避免主线程被 Modal 对话框等阻塞时，每次探测都等满默认超时。
const HEALTH_TIMEOUT_MS = 5000
// 「黑洞端口」防护：TCP 握手成功但 10s 内无任何响应字节时立即放弃，
// 避免对不响应实例（主线程卡死/Modal 阻塞/防火墙半开放）空等 timeoutMs（最长 180s）。
const FIRST_BYTE_TIMEOUT_MS = 10000
// 编译/刷新轮询上限：默认 120s，可用 UNITY_BRIDGE_COMPILE_TIMEOUT_MS 覆盖
//（大项目首次编译/首次 git 包拉取可能 >2 分钟，见 Install.md §3）。
const DEFAULT_COMPILE_TIMEOUT_MS = 120000
function compileTimeoutMs() {
  const v = Number(process.env.UNITY_BRIDGE_COMPILE_TIMEOUT_MS)
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_COMPILE_TIMEOUT_MS
}

// 编译/刷新互斥锁：防止模型并发调用 unity_compile/unity_refresh 时产生双份
// 「触发 + 轮询」——后到的调用直接报告"已有编译任务进行中"，不再重复触发与轮询，
// 避免两个调用各自空等同一段编译时间。
let compileLock = null
function withCompileLock(fn) {
  if (compileLock) {
    return Promise.resolve({ skipped: true, reason: '已有编译/刷新任务进行中（另一调用正在轮询）。请等待其完成，或稍后重试。' })
  }
  compileLock = fn()
  const release = () => { compileLock = null }
  compileLock.then(release, release)
  return compileLock
}

// 定位随包分发的 Install.md（Unity 侧安装指南）。两种安装布局都要覆盖：
//   - pnpm / dsh plugin 安装：<profile>/node_modules/unity-bridge/plugin/unity-bridge.mjs
//     → Install.md 在本文件上一级（node_modules/unity-bridge/Install.md）
//   - copy 方式安装：<profile>/unity-bridge.mjs
//     → Install.md 与本文件同级（<profile>/Install.md）
// 返回第一个存在者的绝对路径；都不存在（例如仓库内直接运行）则返回 undefined。
function resolveInstallDoc() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.join(here, '..', 'Install.md'), // pnpm 布局
    path.join(here, 'Install.md'),       // copy 布局
  ]
  return candidates.find((p) => fs.existsSync(p))
}

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

// 把字符串解析成合法进程号（1~2^31-1），非法返回 undefined。UNITY_BRIDGE_PID 钉选用。
function parsePid(value) {
  if (value === undefined || value === null || value === '') return undefined
  const pid = Number(value)
  return Number.isInteger(pid) && pid > 0 && pid < 2147483648 ? pid : undefined
}

// 读取端口文件条目。主文件 <项目根>/Library/UnityBridgePort.txt 为纯数字端口；
// Unity 侧同时写 JSON 边车 <项目根>/Library/UnityBridgePort.json
// （{ port, pid, project, projectPath, startTimeUtc }），供多实例身份校验与诊断。
// 仅当边车 port 与主文件一致时才采信边车 pid——主文件可能被后启动的另一实例
// 覆盖（同项目多实例共享 Library），数字一致说明边车与主文件同源，pid 才可信。
// 返回 null（读不到）或 { port, file, projectRoot, rawRoot, pid?, startTimeUtc? }。
function readPortFileEntry(portFile) {
  const port = readPortFile(portFile)
  if (!port) return null
  const projectRoot = path.dirname(path.dirname(portFile))
  const entry = {
    port,
    file: portFile,
    projectRoot: normalizePath(projectRoot),
    rawRoot: projectRoot, // 原样路径（未规范化），用于用户可读的错误提示
  }
  try {
    const meta = JSON.parse(fs.readFileSync(portFile.replace(/\.txt$/i, '.json'), 'utf8'))
    if (Number(meta.port) === port) {
      const pid = parsePid(meta.pid)
      if (pid) entry.pid = pid
      if (typeof meta.startTimeUtc === 'string' && meta.startTimeUtc) entry.startTimeUtc = meta.startTimeUtc
    }
  } catch { /* 无 JSON 边车或解析失败：仅主文件数字可用，pid 未知 */ }
  return entry
}

// 端口文件读取失败时，除了按会话目录找，还尝试这些候选目录。
// Unity 项目与 DSH 会话目录未必一致（如从插件仓库开会话、会话是项目子目录等），
// 一处读不到不代表端口文件不存在——多候选能覆盖更多实际布局。
//
// 候选生成规则（Windows）：
//   1) cwd 自身（cwd 可能就是项目根或项目内部）；
//   2) cwd 的每一级祖先（项目可能在会话目录的母目录，如会话在仓库子目录）；
//   3) cwd 的所有同级目录（会话在插件仓库、Unity 项目是兄弟目录时，是唯一的命中路径）。
//   路径一律不解析符号链接/大小写（端口文件在 Library 下，而读取时的 cwd 是实路径，
//   Windows 大小写不敏感，File.existsSync 能命中），仅做 existsSync 探测，零成本。
function portFileCandidates(cwd) {
  if (!cwd) return []
  const list = []
  const add = (p) => {
    if (p && !list.includes(p)) list.push(p)
  }
  // ① cwd 自身 + 逐级祖先（含盘符根到顶的防死循环保护）。
  add(portFileForCwd(cwd))
  for (let d = path.dirname(cwd); d && d !== cwd && d.length > 2; d = path.dirname(d)) {
    add(portFileForCwd(d))
    if (d.length <= 3) break // 盘符根（如 "D:\"）到顶
  }
  // ② 每个祖先层级的所有同级目录（会话在插件仓库、Unity 项目是兄弟目录时，
  //    只有这里能命中项目根）。这里只遍历“祖先的父目录”，不重复祖先本身。
  //    需要 readdir 的目录集合 = { cwd 各层祖先的父目录 }，去重后逐层扫描。
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
      if (!ent.isDirectory()) continue
      add(portFileForCwd(path.join(parent, ent.name)))
    }
  }
  return list.filter(Boolean)
}

// 按 projectPath 索引的端口发现缓存：findPortByHealth 命中后写入，
// 后续请求直接命中缓存端口，避免每个请求都全范围扫描。
const portDiscoveryCache = new Map()

function cacheGet(cwd) {
  if (!cwd) return undefined
  const norm = normalizePath(cwd)
  return portDiscoveryCache.get(norm)
}

function cachePut(cwd, port) {
  if (!cwd || !port) return
  portDiscoveryCache.set(normalizePath(cwd), port)
}

// 端口文件候选结果按 cwd 缓存（目录结构不会在会话期内变化），避免
// waitCompileDone 每轮轮询都重建候选列表 + readdir 盘根目录的浪费。
const portCandidatesCache = new Map()
function cachedPortFileCandidates(cwd) {
  if (!cwd) return []
  const norm = normalizePath(cwd)
  if (!portCandidatesCache.has(norm)) {
    portCandidatesCache.set(norm, portFileCandidates(cwd))
  }
  return portCandidatesCache.get(norm)
}

// 从工具执行上下文取当前会话项目目录，据此定位对应的 Unity 实例。
// 优先级：UNITY_BRIDGE_PORT 环境变量 > 发现缓存 > 意图项目端口文件 > 固定端口 8321。
// “意图项目”= intendedRootFor 的结果：会话目录所在项目 / 唯一可连项目 / UNITY_BRIDGE_PROJECT。
// 只信任属于意图项目的端口文件作为主候选——兄弟项目残留的端口文件（如"另一个编辑器
// 项目"的 Library/UnityBridgePort.txt）不参与主候选，杜绝主候选本身就指向别的实例。
function portForExec(exec) {
  const cwd = sessionCwd(exec)
  const envPort = parsePort(process.env.UNITY_BRIDGE_PORT)
  if (envPort) return envPort

  // 发现缓存：之前扫描命中过的 { cwd → port }。
  // 注意 cache 存的是“已确认能响应的端口”，比端口文件更可信（文件可能残留/被覆盖）。
  const cached = cacheGet(cwd)
  if (cached) return cached

  const refs = portFileRefsFor(cwd)
  const intended = intendedRootFor(cwd, refs)
  for (const r of refs) {
    if (r.port && (!intended || r.projectRoot === intended)) return r.port
  }
  return DEFAULT_PORT
}

// 把字符串解析成合法端口（1~65535），非法值返回 undefined。
function parsePort(value) {
  if (value === undefined || value === null || value === '') return undefined
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined
}

// ── HTTP 客户端 ────────────────────────────────────────────────────────────

// 发起单个请求。timeoutMs 为整体超时（socket idle 超时）；
// firstByteTimeoutMs 为「首字节等待」上限：TCP 已建立但 HTTP 迟迟不响应
//（Unity 主线程被 Modal 阻塞 / 编译卡死 / 半开放防火墙）时，避免空等完整
// timeoutMs——这是「任务卡死」最主要的成因。
function request(method, path, body, timeoutMs = DEFAULT_TIMEOUT_MS, signal, port, firstByteTimeoutMs) {
  const base = `http://${HOST}:${port}`
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    // 首字节计时器：连接建立后指定时间内无任何响应字节 → 判定为黑洞/无响应，
    // 立即中止，避免吞满整体超时。仅在显式传入 firstByteTimeoutMs 时启用。
    let firstByteTimer = null
    let firstByteTimedOut = false
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
        // 收到响应头即视为「有响应」，取消首字节计时。
        if (firstByteTimer) clearTimeout(firstByteTimer)
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
    if (firstByteTimeoutMs) {
      firstByteTimer = setTimeout(() => {
        firstByteTimedOut = true
        req.destroy(new Error(`Unity Bridge 无响应（${firstByteTimeoutMs}ms 内未返回任何数据）。可能原因：Unity 主线程被模态对话框阻塞、正在执行长任务（构建/烘焙/编译）、或服务已卡死。请到 Unity 窗口检查并手动关闭对话框。`))
      }, firstByteTimeoutMs)
      if (firstByteTimer.unref) firstByteTimer.unref()
    }
    req.on('timeout', () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)))
    req.on('error', (err) => {
      if (firstByteTimer) clearTimeout(firstByteTimer)
      // 首字节超时中止会触发 error；保留其原始诊断信息，避免被下面的通用文案覆盖。
      const message = firstByteTimedOut ? err.message : `无法连接 Unity Bridge（${base}）：${err.message}。请确认 Unity 已打开且 Tools/Unity Bridge 已启动。`
      reject(new Error(message))
    })
    if (data) req.write(data)
    req.end()
  })
}

// Unity 侧顺延参数镜像（与 com.yd.unitybridge/Editor/UnityBridgeServer.cs 保持一致）：
// 首选 8321，被占时顺延最多 256 个端口（8321~8576）。
const PORT_SCAN_START = DEFAULT_PORT
const PORT_SCAN_COUNT = 256

// 按当前会话项目目录发起请求（自动定位端口并携带取消信号）。
// 端口定位优先级：UNITY_BRIDGE_PORT 环境变量 > 发现缓存 > 意图项目端口文件 > 固定端口 8321。
// 主候选连不上时，主动扫描 Unity 侧允许的顺延端口范围（8321~8576），
// 用 /health 探测并按“意图项目身份”找到实际监听的端口——覆盖“端口文件被其他实例
// 覆盖/残留/失效”时 Unity 实际端口与端口文件不一致的失配，且绝不连到别的项目实例。
async function call(exec, method, path, body, timeoutMs) {
  const cwd = sessionCwd(exec)
  const envPort = parsePort(process.env.UNITY_BRIDGE_PORT)
  const isHealth = path === '/health'
  const useTimeout = isHealth ? HEALTH_TIMEOUT_MS : (timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const useFirstByte = isHealth ? true : Boolean(timeoutMs === undefined)

  // 多项目歧义前置拦截（覆盖全部工具，含未做 healthChecked 的 unity_logs/unity_mcp 等）：
  // 会话目录不在任何可连项目内、又有多个项目可连时，禁止静默猜测目标实例。
  if (!envPort) {
    const refs = portFileRefsFor(cwd)
    const ambiguous = ambiguityFor(cwd, refs)
    if (ambiguous) throw new Error(ambiguous)
  }

  const primary = portForExec(exec)

  // 命中目标端口后执行实际请求；UNITY_BRIDGE_PID 钉选时先做一次实例身份校验。
  const run = async (port) => {
    if (!isHealth) await assertPid(exec, port)
    return request(method, path, body, useTimeout, exec && exec.signal, port, useFirstByte ? FIRST_BYTE_TIMEOUT_MS : undefined)
  }

  // 先试主候选（环境变量 / 发现缓存 / 意图项目端口文件 / 固定端口）。
  try {
    return await run(primary)
  } catch (err) {
    // 环境变量显式指定时，用户意图明确，不扫描（避免扫描到别的实例端口）。
    if (envPort) throw err

    // 范围扫描：从 DEFAULT_PORT 起按“意图项目身份”探测 /health。
    // 并发窗口内逐批探测，命中即视为本次调用的目标端口。
    const hit = await findPortByHealth(exec, PORT_SCAN_START, PORT_SCAN_COUNT, primary)
    if (hit == null) throw err // 扫描不到身份匹配的响应端口，报主候选错误

    if (hit !== primary) {
      cachePut(cwd, hit)
      await logOnce(`Unity Bridge 自动发现：端口 ${primary} 不可用/不属于目标项目，已定位到 ${hit}（端口文件可能被其他实例覆盖或残留）。后续请求将优先使用 ${hit}。`)
    }
    return run(hit)
  }
}

// ── 意图项目判定与端口发现（多实例/多会话路由核心）────────────────────────

// 收集候选链中所有存在的端口文件参照（含 JSON 边车的 pid）。
// 端口文件形如 <项目根>/Library/UnityBridgePort.txt（另有 .json 边车），
// 项目根 = 文件目录的父目录。返回 [{ port, file, projectRoot, rawRoot, pid?, ... }, ...]；
// 一个文件都没有返回 []。
function portFileRefsFor(cwd) {
  const refs = []
  for (const pf of cachedPortFileCandidates(cwd)) {
    const entry = readPortFileEntry(pf)
    if (entry) refs.push(entry)
  }
  return refs
}

// 判定会话“意图项目根”（规范化小写绝对路径；'' = 无法唯一确定）。优先级：
//   ① 环境变量 UNITY_BRIDGE_PROJECT（会话不在任何项目内时精确指定目标项目）；
//   ② 覆盖会话目录的端口文件参照（cwd == 项目根 或 cwd 在项目根之下）→ 取最深覆盖者
//      （会话目录是项目内任意子目录时仍归到项目根）；
//   ③ 参照去重后只剩 1 个项目根 → 该项目（“会话在插件仓库、唯一项目在兄弟目录”场景）；
//   ④ 否则 ''——多个不同项目并存且会话不在其中任一内 → 歧义，调用方必须拒绝静默选择。
function intendedRootFor(cwd, refs) {
  const envProject = normalizePath(process.env.UNITY_BRIDGE_PROJECT)
  if (envProject) return envProject
  const normCwd = cwd ? normalizePath(cwd) : ''
  if (!normCwd) return ''
  const covering = refs
    .filter((r) => normCwd === r.projectRoot || normCwd.startsWith(r.projectRoot + '\\'))
    .sort((a, b) => b.projectRoot.length - a.projectRoot.length)
  if (covering.length) return covering[0].projectRoot
  const uniqueRoots = []
  for (const r of refs) {
    if (r.projectRoot && !uniqueRoots.includes(r.projectRoot)) uniqueRoots.push(r.projectRoot)
  }
  return uniqueRoots.length === 1 ? uniqueRoots[0] : ''
}

// 多项目歧义检查：返回需要报给用户的说明（'' = 无歧义）。
// 会话目录不在任何可连项目内、且端口文件参照指向 ≥2 个不同项目 → 歧义，
// 此时无法从目录推断目标，绝不允许静默挑一个（那正是“连错编辑器”的根源）。
// 例外：设置了 UNITY_BRIDGE_PID 时 pid 本身就是实例级唯一标识，无歧义；
// 设置了 UNITY_BRIDGE_PROJECT 时由 intendedRootFor 直接确定目标，同样无歧义。
function ambiguityFor(cwd, refs) {
  if (!cwd) return ''
  if (parsePid(process.env.UNITY_BRIDGE_PID)) return ''
  if (intendedRootFor(cwd, refs)) return ''
  const roots = []
  for (const r of refs) {
    const rr = r.rawRoot || r.projectRoot
    if (rr && !roots.includes(rr)) roots.push(rr)
  }
  if (roots.length < 2) return ''
  return (
    `检测到多个 Unity 项目可连接（${roots.join('、')}），而当前会话目录 ${cwd} 不在其中任何一个项目内，` +
    `无法判断本会话应操作哪个编辑器，已拒绝自动选择以免连错实例。\n` +
    `解决方法：① 在目标 Unity 项目目录下新建 DSH 会话，或把本会话工作目录切到目标项目；` +
    `② 设置环境变量 UNITY_BRIDGE_PROJECT=<目标项目绝对路径>（如 d:\\unity\\island\\islandclient）后重试；` +
    `③ 或设置 UNITY_BRIDGE_PORT=<端口> 直连目标实例。`
  )
}

// 探测端口范围（含 start，共 count 个），返回“身份匹配”的端口；全无返回 null。
// 跳过 skipPort 不探测。内部用并发窗口逐批探测，短超时（SCAN_PROBE_*）避免对
// “TCP 可连但永不响应”的僵尸/卡死实例（batchmode 残留、主线程被阻塞等）等满完整超时。
// 身份匹配优先级（h = 探测端口实际 /health；hp = h.projectPath 规范化值；pid = h.pid）：
//   ① UNITY_BRIDGE_PID 钉选：h.pid == 钉选 pid → 立即命中（用户显式指定具体实例进程）；
//   ② 命中会话“意图项目”的实例（hp == intendedRoot）→ 命中；其中端口文件的 pid 与
//      实例 pid 一致（rank 0，端口文件直指该实例）比仅项目一致（rank 1）证据更强；
//   ③ 无任何参照且无会话目录 → 任一有响应端口兜底（老用法）。
// 其它情况（hp 属于别的项目/别的实例）一律跳过，杜绝多实例下连错项目——
// 这是修复“两个编辑器 + 两个会话互相连错”的关键：兄弟项目的端口文件只能用来
// 识别“存在哪些项目”，绝不能当作本会话目标项目的匹配依据。
const SCAN_BATCH_SIZE = 8
const SCAN_PROBE_TIMEOUT_MS = 2500
async function findPortByHealth(exec, start, count, skipPort) {
  const cwd = sessionCwd(exec)
  const refs = portFileRefsFor(cwd)
  const normCwd = cwd ? normalizePath(cwd) : ''
  const intended = intendedRootFor(cwd, refs)
  const pinPid = parsePid(process.env.UNITY_BRIDGE_PID)
  const ports = []
  for (let i = 0; i < count; i++) {
    const p = start + i
    if (p === skipPort) continue
    ports.push(p)
  }
  let best = null // { rank, port }，rank 越小证据越强
  const consider = (rank, p) => {
    if (!best || rank < best.rank || (rank === best.rank && p < best.port)) best = { rank, port: p }
  }
  for (let b = 0; b < ports.length; b += SCAN_BATCH_SIZE) {
    const batch = ports.slice(b, b + SCAN_BATCH_SIZE)
    const results = await Promise.all(batch.map(async (p) => {
      try {
        const h = await request('GET', '/health', undefined, SCAN_PROBE_TIMEOUT_MS, exec && exec.signal, p, SCAN_PROBE_TIMEOUT_MS)
        const hp = h && h.projectPath ? normalizePath(h.projectPath) : ''
        const pid = h && h.pid ? Number(h.pid) : 0
        // ① pid 钉选：实例级精确命中。
        if (pinPid && pid && pid === pinPid) return { pin: true, p }
        // ② 意图项目命中（intended 优先于裸会话目录：目录不在项目内时用唯一项目/环境变量判定）。
        const target = intended || normCwd
        if (target && hp && hp === target) {
          const exact = refs.some((r) => r.projectRoot === target && r.port === p && r.pid && pid && r.pid === pid)
          return { rank: exact ? 0 : 1, p }
        }
        // ③ 无任何参照且无会话目录 → 任一响应兜底（老用法）。
        if (!normCwd && !refs.length) return { rank: 2, p }
        // 其余 → 别的项目/别的实例，跳过。
        return null
      } catch {
        return null
      }
    }))
    const pinned = results.find((r) => r != null && r.pin)
    if (pinned) return pinned.p
    for (const r of results) {
      if (r != null && !r.pin) consider(r.rank, r.p)
    }
  }
  return best ? best.port : null
}

// UNITY_BRIDGE_PID 钉选校验：向目标端口发出实际业务请求前，先确认该端口上的
// Unity 实例进程号与钉选一致（同一项目开多个编辑器、或编辑器重启后端口被复用时的
// 最后一道保险）。
async function assertPid(exec, port) {
  const pinPid = parsePid(process.env.UNITY_BRIDGE_PID)
  if (!pinPid) return
  const h = await request('GET', '/health', undefined, HEALTH_TIMEOUT_MS, exec && exec.signal, port, FIRST_BYTE_TIMEOUT_MS)
  const pid = h && h.pid ? Number(h.pid) : 0
  if (pid !== pinPid) {
    throw new Error(
      `UNITY_BRIDGE_PID 校验失败：端口 ${port} 上的 Unity 实例进程号为 ${pid || '未知'}，与指定的 ${pinPid} 不一致。` +
      `目标实例可能已重启/换端口，或该端口已被其他实例占用。请先调用 unity_health 确认目标实例的 pid 后重试。`
    )
  }
}

// 只打印一次的全局标记：自动发现端口对用户来说是有价值的信息，但每个请求都打会刷屏。
let loggedDiscovery = false
function logOnce(msg) {
  if (loggedDiscovery) return
  loggedDiscovery = true
  console.warn(`[unity-bridge] ${msg}`)
}

// 取当前会话项目目录（供 health 校验与错误提示使用）。
function sessionCwd(exec) {
  return exec && exec.agent && exec.agent.session && exec.agent.session.header
    ? exec.agent.session.header.cwd
    : undefined
}

// /health 且校验项目路径：兜底连错实例（多实例/端口文件失配）时立即报错。
// 判定“允许”的三种情况：
//   A. /health 项目 == 会话目录（会话就在该项目内）；
//   B. /health 项目 == 意图项目 intendedRoot（会话在插件仓库、唯一项目在兄弟目录，
//      或通过 UNITY_BRIDGE_PROJECT 指定的正常用法）；
//   C. UNITY_BRIDGE_PID 钉选命中（同项目多实例时按进程号精确定位）。
// 不再有“任意端口文件参照匹配即放行”的宽松通道——兄弟项目的端口文件不能为
// 连到别的项目开绿灯。
async function healthChecked(exec) {
  const cwd = sessionCwd(exec)
  const refs = portFileRefsFor(cwd)
  const h = await call(exec, 'GET', '/health')
  const normCwd = cwd ? normalizePath(cwd) : ''
  const hp = h && h.projectPath ? normalizePath(h.projectPath) : ''
  const pid = h && h.pid ? Number(h.pid) : 0
  const pinPid = parsePid(process.env.UNITY_BRIDGE_PID)

  const intended = intendedRootFor(cwd, refs)
  if (normCwd && hp && hp === normCwd) return h // A：会话就在该项目内
  if (intended && hp && hp === intended) return h // B：意图项目
  if (pinPid && pid && pid === pinPid) return h // C：pid 钉选
  if (!normCwd && !refs.length) return h // 无任何参照（老用法兜底）

  const roots = []
  for (const r of refs) {
    const rr = r.rawRoot || r.projectRoot
    if (rr && !roots.includes(rr)) roots.push(rr)
  }
  throw new Error(
    `项目不匹配：当前会话目录 ${cwd || '(未设置)'} 与 Unity 实例项目 ${h.projectPath || '(未知)'} 不一致` +
    (roots.length ? `（已检测到可连接的 Unity 项目：${roots.join('、')}）` : '') +
    `。可能原因：端口文件被其他实例覆盖/残留、会话工作目录选错、或连到了非目标实例。\n` +
    `解决方法：① 在目标 Unity 项目目录下新建 DSH 会话，或把本会话工作目录切到该项目目录；` +
    `② 设置环境变量 UNITY_BRIDGE_PROJECT=<目标项目绝对路径> 后重试；` +
    `③ 或设置 UNITY_BRIDGE_PORT=<端口> 直连目标实例（同一项目开了多个编辑器时再附加 ` +
    `UNITY_BRIDGE_PID=<进程号> 精确指定实例）。\n` +
    `若您确实想在本会话操作当前已连上的项目，可忽略本错误直接使用其它 unity_* 工具。`
  )
}

// 轮询直到编译结束。
// 编译触发 domain reload 时服务会重建，期间 /health 可能短暂连接失败
//（ECONNREFUSED/ECONNRESET），属预期行为：捕获后等待重试，不中断轮询。
// 增强：
//  - 指数退避（0.8s → 1.6s → 3.2s … 封顶 5s），减少空转请求数；
//  - 同时把 `updating`（AssetDatabase 刷新中）视为未完成，避免刷新后读到旧快照；
//  - reload 恢复窗口内连续失败超过阈值（服务真正下线）即放弃并抛错，不再空耗整个窗口；
//  - 超时后抛错而不是静默返回「可能仍在编译」的 health，防止调用方误判成功。
async function waitCompileDone(exec, maxWaitMs = 120000) {
  const start = Date.now()
  let intervalMs = 800
  let consecutiveFailures = 0
  const maxConsecutiveFailures = 4 // 连续 4 次失败（含 reload 抖动）视为服务不可用
  while (Date.now() - start < maxWaitMs) {
    try {
      const h = await call(exec, 'GET', '/health')
      consecutiveFailures = 0
      if (!h.compiling && !h.updating) return h
    } catch {
      // reload 窗口：服务正在重建，稍等继续轮询；连续失败过多则放弃。
      consecutiveFailures++
      if (consecutiveFailures >= maxConsecutiveFailures) {
        throw new Error(
          `Unity 在编译/刷新期间连续 ${maxConsecutiveFailures} 次无法响应（${Math.round((Date.now() - start) / 1000)}s），` +
          `可能是服务未恢复或 Unity 已崩溃。请稍后调用 unity_health 检查，或联系用户确认 Unity 状态。`
        )
      }
      await sleep(Math.max(intervalMs, 1200))
      intervalMs = Math.min(intervalMs * 2, 5000)
      continue
    }
    await sleep(intervalMs)
    intervalMs = Math.min(intervalMs * 2, 5000)
  }
  throw new Error(
    `编译/刷新在 ${Math.round(maxWaitMs / 1000)}s 内未完成（compiling/updating 仍为 true）。` +
    `可能原因：编译卡死、Unity 主线程被长任务或模态对话框阻塞。请到 Unity 窗口检查，或稍后重试。`
  )
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
  ⚠ 禁止调用会弹模态对话框的交互式菜单（本包已移除 Status/Stop 等弹窗菜单；其它包如 MCP 的某些菜单也会弹窗）——会阻塞 Unity 主线程，导致 bridge 与 /health 全部超时，必须人工点掉对话框才恢复。只调用无 UI 的菜单项。
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
- 结果统一为 { success, data }；业务失败（参数缺省/资源不存在/动作不支持）会直接抛错，无需再人工检查 success 字段。
- 破坏性操作（删除/覆盖/构建）前先用只读 action（get_info/list/get_active）确认目标。
- 注意：manage_asset search 的 searchTerm 过滤可能无效（会返回全量资产第一页，如 3.6 万条），优先用 get_info(path) 精确定位资源。
- 注意：unity_execute 反射调用尽量选返回简单值的方法；复杂对象会以结构化 JSON 返回（数组限量 500 项）。`

// ── 插件入口 ───────────────────────────────────────────────────────────────

export function apply(ctx) {
  ctx.systemPrompt.section({
    name: 'unity-bridge-tools',
    order: 150,
    text: UNITY_BRIDGE_CHEATSHEET,
  })

  // 把 Unity 侧安装指南的位置告诉 AI：安装插件 ≠ 已能连上 Unity，
  // 目标项目还需安装 UPM 包 com.yd.unitybridge 才会启动本地服务。
  const installDoc = resolveInstallDoc()
  if (installDoc) {
    ctx.systemPrompt.section({
      name: 'unity-bridge-install-guide',
      order: 149,
      text: `# Unity Bridge Unity 侧安装（如未安装）

本插件（DSH 侧）已就绪，但控制 Unity 还需要目标项目安装 Unity 侧组件
（UPM 包 com.yd.unitybridge）。若 \`unity_health\` 连接失败或报"项目不匹配"，
请先读取安装指南并按步骤安装/验证：\`${installDoc}\`

要点：把 \`com.yd.unitybridge\`（git URL \`https://github.com/ydd12333/unity-bridge.git?path=/com.yd.unitybridge\`）
加入目标项目 \`Packages/manifest.json\` 的 \`dependencies\`，等 Unity 解析编译后
服务自动启动（127.0.0.1:8321）。详见 Install.md。`,
    })
  }

  register(ctx, 'unity_health',
    '查询 Unity 编辑器状态（是否正在编译/刷新、项目名、Unity 版本、监听端口、项目路径）。',
    {},
    (_args, exec) => healthChecked(exec))

  register(ctx, 'unity_compile',
    '触发 Unity 脚本编译并等待完成，返回编译是否成功以及编译错误列表。',
    {},
    async (_args, exec) => {
      // 前置校验项目匹配 + 服务可用：避免在连错实例/会话目录不符时白白触发编译
      // 并空等编译结束（校验失败时空转的浪费比任何工具都大）。
      await healthChecked(exec)
      // 互斥：已有编译/刷新任务在轮询时，新调用直接告知现状，不再重复触发。
      const locked = await withCompileLock(async () => {
        await call(exec, 'POST', '/compile', {}, DEFAULT_TIMEOUT_MS)
        await waitCompileDone(exec, compileTimeoutMs())
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
      })
      return locked
    }, 180000)

  register(ctx, 'unity_refresh',
    '刷新 Unity 资源数据库（AssetDatabase.Refresh），并等待编译结束。',
    {},
    async (_args, exec) => {
      // 同 unity_compile：先校验再触发副作用 + 互斥。
      await healthChecked(exec)
      const locked = await withCompileLock(async () => {
        await call(exec, 'POST', '/refresh', {}, DEFAULT_TIMEOUT_MS)
        await waitCompileDone(exec, compileTimeoutMs())
        return { refreshed: true }
      })
      return locked
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
    '执行 Unity 编辑器静态方法，或按菜单路径执行菜单项。className 传 "__menu" 时按菜单路径执行（如 "File/Save Project"）；否则按 命名空间.类名.方法名 反射执行静态方法（方法名可选）。⚠ 禁止执行会弹模态对话框的交互式菜单（本包已移除 Status/Stop 等弹窗菜单；其它包如 MCP 的某些菜单也会弹窗）——会阻塞 Unity 主线程导致 bridge 卡死超时。',
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
    '透传调用 Unity 编辑器内 MCP for Unity 包的任意工具（约 30 个，覆盖资源/场景/GameObject/组件/脚本/构建/测试/材质/UI/包管理等）。先调用 unity_mcp_catalog 获取可用工具清单，再指定 tool 与对应 params 执行。工具的业务失败（参数缺省/资源不存在/动作不支持）会抛错返回，不再返回 success:false 让调用方自行解析。',
    {
      tool: { type: 'string', required: true, description: 'MCP 工具名（如 manage_scene、manage_asset、manage_gameobject、manage_script、manage_build、run_tests 等），见 unity_mcp_catalog。' },
      params: { type: 'object', description: '传给该工具的参数字典（含 action 子操作名与具体参数）。' },
    },
    async (args, exec) => {
      const data = await call(exec, 'POST', '/mcp', {
        tool: args.tool,
        params: args.params ?? {},
      }, 180000)
      // MCP 业务失败包装为 HTTP 200 + `success:false`（服务级 ok=false 才走 call 抛错）。
      // 这里做第二次校验：业务失败直接抛错，统一走错误通道，避免调用方把失败当成功继续执行。
      if (data && data.success === false) {
        const detail = data.error || data.code || 'unknown error'
        throw new Error(`MCP 工具 ${args.tool} 执行失败: ${detail}`)
      }
      return data
    })
}

// 内部逻辑导出：仅供仓库自测/调试（scripts/ 下的测试脚本与故障复现用），
// DSH 运行时只消费 apply/name/inject，额外的具名导出无副作用。
export const _internals = {
  normalizePath,
  parsePort,
  parsePid,
  readPortFile,
  readPortFileEntry,
  portFileCandidates,
  cachedPortFileCandidates,
  portFileRefsFor,
  intendedRootFor,
  ambiguityFor,
  sessionCwd,
  portForExec,
  findPortByHealth,
}
