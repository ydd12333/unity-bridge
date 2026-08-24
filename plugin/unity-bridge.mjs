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
// 优先级：环境变量 UNITY_BRIDGE_PORT > 发现缓存 > 端口文件（多候选） > 固定端口 8321。
function portForExec(exec) {
  const cwd = sessionCwd(exec)
  const envPort = parsePort(process.env.UNITY_BRIDGE_PORT)
  if (envPort) return envPort

  // 发现缓存：之前扫描命中过的 { cwd → port }。
  // 注意 cache 存的是“已确认能响应的端口”，比端口文件更可信（文件可能残留/被覆盖）。
  const cached = cacheGet(cwd)
  if (cached) return cached

  for (const pf of cachedPortFileCandidates(cwd)) {
    const fromFile = readPortFile(pf)
    if (fromFile) return fromFile
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
// 端口定位优先级：UNITY_BRIDGE_PORT 环境变量 > 端口文件 > 固定端口 8321。
// 主候选连不上时，主动扫描 Unity 侧允许的顺延端口范围（8321~8576），
// 用 /health 探测找到实际监听的端口——覆盖“端口文件读不到/失效”时
// Unity 已顺延到 8325 等非默认端口而 DSH 侧仍只试 8321 的失配问题。
// 扫描按“最接近默认端口优先”顺序，避免连错同项目多实例。
async function call(exec, method, path, body, timeoutMs) {
  const primary = portForExec(exec)
  const envPort = parsePort(process.env.UNITY_BRIDGE_PORT)
  const isHealth = path === '/health'
  const useTimeout = isHealth ? HEALTH_TIMEOUT_MS : (timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const useFirstByte = isHealth ? true : Boolean(timeoutMs === undefined)

  // 先试主候选（环境变量 / 端口文件 / 固定端口）。
  try {
    return await request(method, path, body, useTimeout, exec && exec.signal, primary, useFirstByte ? FIRST_BYTE_TIMEOUT_MS : undefined)
  } catch (err) {
    // 环境变量显式指定时，用户意图明确，不扫描（避免扫描到别的实例端口）。
    if (envPort) throw err

    // 范围扫描：从 DEFAULT_PORT 起逐个探测 /health，找到有响应的端口即为 Unity 实际端口。
    // 并发窗口 8，避免 256 个端口串行探测拖垮整体；命中即视为本次调用的目标端口。
    const hit = await findPortByHealth(exec, PORT_SCAN_START, PORT_SCAN_COUNT, primary)
    if (hit == null) throw err // 扫描不到任何响应端口，报主候选错误

    if (hit !== primary) {
      cachePut(sessionCwd(exec), hit)
      await logOnce(`Unity Bridge 自动发现：端口 ${primary} 不可用，已定位到顺延端口 ${hit}（Unity 侧自动顺延所致）。后续请求将优先使用 ${hit}。`)
    }
    return request(method, path, body, useTimeout, exec && exec.signal, hit, useFirstByte ? FIRST_BYTE_TIMEOUT_MS : undefined)
  }
}

// 探测端口范围（含 start，共 count 个），返回第一个 /health 有响应且**与参照匹配**的端口。
// 内部用并发窗口逐批探测，任一命中即返回；全无响应返回 null。跳过 skipPort 不探测。
// 短超时探测避免对黑洞/无响应端口等满完整超时。
// 参照匹配优先级（hp = 探测端口实际 /health.projectPath 的规范化值）：
//   ① 存在端口文件 r: r.projectRoot == hp 且 r.port == 探测端口 → 命中（最强证据：
//      端口文件当前有效，数字与项目身份双向一致）；
//   ② 存在端口文件 r: r.projectRoot == hp → 命中（端口文件数字可能过时/顺延过，
//      但项目身份一致——该端口就是此项目实例当前实际监听端口）；
//   ③ hp == cwd 规范化值 → 命中（会话就在该项目内）；
//   ④ 无任何参照（无 cwd、无端口文件）→ 任一有响应的端口即命中（兜底可用性）。
// 其它情况一律视为“别的实例”，跳过继续探测，避免多实例下连错项目。
// 收集候选链中所有存在的端口文件参照。
// 端口文件形如 <项目根>/Library/UnityBridgePort.txt，项目根 = 文件目录的父目录。
// 返回 [{ port, projectRoot, file }, ...]；一个文件都没有返回 []。
function portFileRefsFor(cwd) {
  const refs = []
  for (const pf of cachedPortFileCandidates(cwd)) {
    const fromFile = readPortFile(pf)
    if (!fromFile) continue
    refs.push({
      port: fromFile,
      projectRoot: normalizePath(path.dirname(path.dirname(pf))),
      file: pf,
    })
  }
  return refs
}

async function findPortByHealth(exec, start, count, skipPort) {
  const cwd = sessionCwd(exec)
  const batchSize = 8
  const ports = []
  for (let i = 0; i < count; i++) {
    const p = start + i
    if (p === skipPort) continue
    ports.push(p)
  }
  const refs = portFileRefsFor(cwd)
  const normCwd = cwd ? normalizePath(cwd) : ''

  for (let b = 0; b < ports.length; b += batchSize) {
    const batch = ports.slice(b, b + batchSize)
    const results = await Promise.all(batch.map(async (p) => {
      try {
        const h = await request('GET', '/health', undefined, HEALTH_TIMEOUT_MS, exec && exec.signal, p, FIRST_BYTE_TIMEOUT_MS)
        const hp = h && h.projectPath ? normalizePath(h.projectPath) : ''
        // 当前探测端口上实际托管的项目（hp），与端口文件参照的项目做身份比对：
        const matchRefs = refs.filter((r) => hp && hp === r.projectRoot)
        // ① 数字 + 项目身份双向一致 → 最强证据。
        if (matchRefs.some((r) => r.port === p)) return p
        // ② 项目身份一致（端口文件数字可能过时/顺延过，但项目是对的）→ 命中。
        if (matchRefs.length) return p
        // ③ 会话目录即该项目根 → 命中。
        if (normCwd && hp && hp === normCwd) return p
        // ④ 无任何参照 → 任一响应兜底。
        if (!normCwd && !refs.length) return p
        // 其余 → 这是别的项目实例，跳过。
        return null
      } catch {
        return null
      }
    }))
    const hit = results.find((p) => p != null)
    if (hit != null) return hit
  }
  return null
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
// 例外：某个端口文件（最权威来源）明确指向某项目，且 /health 返回的正是该项目时，
// 即使与会话 cwd 不同也放行——覆盖“会话在插件仓库、Unity 项目是兄弟目录”的
// 正常用法（此时端口文件已通过同级目录候选被发现）。
async function healthChecked(exec) {
  const h = await call(exec, 'GET', '/health')
  const cwd = sessionCwd(exec)
  const hp = h.projectPath ? normalizePath(h.projectPath) : ''
  const refs = portFileRefsFor(cwd)
  const refMatches = refs.some((r) => hp && hp === r.projectRoot)
  if (cwd && hp && normalizePath(cwd) !== hp && !refMatches) {
    throw new Error(
      `项目不匹配：当前会话目录 ${cwd} 与 Unity 实例项目 ${h.projectPath} 不一致（端口文件指向其他实例或选错项目）。\n` +
      `解决方法：① 在目标项目目录（${h.projectPath}）下新建 DSH 会话，或将会话工作目录切到该项目目录；` +
      `② 或设置环境变量 UNITY_BRIDGE_PORT=<端口> 指向目标实例对应的监听端口后重试。\n` +
      `若您确实想在本会话操作该项目，可忽略本错误直接使用不校验项目的其它 unity_* 工具。`
    )
  }
  return h
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
