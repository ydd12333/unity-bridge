// 多实例 / 多会话路由自测（不依赖真实 Unity）：
//   在临时目录下搭两个“Unity 项目”（projA / projB，各自带 Library/UnityBridgePort.txt
//   + .json 边车），起两个假 Unity Bridge HTTP 服务，复现用户报告的“两个编辑器 +
//   两个 DSH 会话互相连错”场景，验证新路由逻辑只连到本会话所属项目/钉选的实例。
//
// 运行：node scripts/unity-bridge.multieditor.test.mjs
import { strict as assert } from 'node:assert'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginUrl = pathToFileURL(path.join(here, '..', 'plugin', 'unity-bridge.mjs')).href
const mod = await import(pluginUrl)
const {
  normalizePath, parsePid, readPortFileEntry, portFileRefsFor,
  intendedRootFor, ambiguityFor, portForExec, findPortByHealth,
} = mod._internals

const ROOT = path.join(here, '.tmp-ub-multi')
const P_A = path.join(ROOT, 'projA')          // 项目 A
const P_B = path.join(ROOT, 'projB')          // 项目 B（会话目录）
const P_REPO = path.join(ROOT, 'repo')        // “插件仓库”目录（不属于任何项目）
const PORT_A = 29321                          // 假 Unity A 监听端口
const PORT_B = 29322                          // 假 Unity B 监听端口
const PID_A = 901
const PID_B = 902

let servers = []
let passed = 0
const savedEnv = {}

function saveEnv() {
  for (const k of ['UNITY_BRIDGE_PORT', 'UNITY_BRIDGE_PID', 'UNITY_BRIDGE_PROJECT']) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
}
function restoreEnv() {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

function writePortFiles(projRoot, port, pid) {
  const lib = path.join(projRoot, 'Library')
  fs.mkdirSync(lib, { recursive: true })
  fs.writeFileSync(path.join(lib, 'UnityBridgePort.txt'), String(port))
  fs.writeFileSync(path.join(lib, 'UnityBridgePort.json'), JSON.stringify({
    port, pid, project: path.basename(projRoot),
    projectPath: projRoot.replace(/\//g, '\\'),
    startTimeUtc: '2026-09-09T00:00:00Z', host: '127.0.0.1',
  }))
}

// 假 Unity Bridge 服务：任何请求都返回 /health 形状（ok/data）。
function startFakeUnity(port, projRoot, pid) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        ok: true,
        data: {
          running: true, compiling: false, updating: false,
          project: path.basename(projRoot),
          unityVersion: '2022.3.62f3c1',
          port,
          projectPath: projRoot.replace(/\//g, '\\'),
          pid,
          startTimeUtc: '2026-09-09T00:00:00Z',
        },
      }))
    })
    srv.listen(port, '127.0.0.1', () => { servers.push(srv); resolve(srv) })
  })
}

const exec = (cwd) => ({ agent: { session: { header: { cwd } } } })

function ok(name) { passed++; console.log(`  ✓ ${name}`) }

try {
  saveEnv()
  // 目录 + 端口文件：A、B 两项目均“有实例”（真实场景：两个编辑器各自写了自己的文件）
  fs.mkdirSync(P_A, { recursive: true })
  fs.mkdirSync(P_B, { recursive: true })
  fs.mkdirSync(P_REPO, { recursive: true })
  writePortFiles(P_A, PORT_A, PID_A)
  writePortFiles(P_B, PORT_B, PID_B)
  await startFakeUnity(PORT_A, P_A, PID_A)
  await startFakeUnity(PORT_B, P_B, PID_B)

  const nA = normalizePath(P_A)
  const nB = normalizePath(P_B)

  console.log('—— 意图项目判定 intendedRootFor ——')
  assert.equal(intendedRootFor(P_B, portFileRefsFor(P_B)), nB, 'cwd=projB 意图应为 B（覆盖自身）')
  ok('cwd=projB → 意图 B')
  assert.equal(intendedRootFor(P_A, portFileRefsFor(P_A)), nA, 'cwd=projA 意图应为 A')
  ok('cwd=projA → 意图 A')
  assert.equal(intendedRootFor(P_REPO, portFileRefsFor(P_REPO)), '', 'cwd=仓库且 A/B 都在 → 歧义')
  ok('cwd=仓库（双项目）→ 歧义')

  console.log('—— 歧义拦截 ambiguityFor ——')
  assert.ok(!ambiguityFor(P_B, portFileRefsFor(P_B)), 'projB 会话无歧义')
  ok('projB 会话无歧义')
  assert.ok(ambiguityFor(P_REPO, portFileRefsFor(P_REPO)), '仓库会话(双项目)应报歧义')
  ok('仓库会话(双项目)报歧义')
  process.env.UNITY_BRIDGE_PID = String(PID_A)
  assert.ok(!ambiguityFor(P_REPO, portFileRefsFor(P_REPO)), 'pid 钉选后歧义解除')
  ok('pid 钉选后歧义解除')
  delete process.env.UNITY_BRIDGE_PID

  console.log('—— 扫描身份匹配 findPortByHealth（核心回归：低端口实例先扫到也不许连错） ——')
  const hitB = await findPortByHealth(exec(P_B), PORT_A, 6, 0)
  assert.equal(hitB, PORT_B, 'cwd=projB 必须扫到 B(29322)，即使 A(29321) 更靠前')
  ok('cwd=projB → 命中 B(29322)，不会连到更靠前的 A')
  const hitA = await findPortByHealth(exec(P_A), PORT_A, 6, 0)
  assert.equal(hitA, PORT_A, 'cwd=projA 扫到 A(29321)')
  ok('cwd=projA → 命中 A(29321)')
  const hitRepo = await findPortByHealth(exec(P_REPO), PORT_A, 6, 0)
  assert.equal(hitRepo, null, 'cwd=仓库(双项目) 歧义 → 扫描不得命中任何端口')
  ok('cwd=仓库(双项目) 歧义 → 扫描拒绝命中')

  console.log('—— pid 钉选 ——')
  process.env.UNITY_BRIDGE_PID = String(PID_B)
  assert.equal(await findPortByHealth(exec(P_REPO), PORT_A, 6, 0), PORT_B, '钉选 902 → B')
  ok('UNITY_BRIDGE_PID=902 → B')
  process.env.UNITY_BRIDGE_PID = String(PID_A)
  assert.equal(await findPortByHealth(exec(P_REPO), PORT_A, 6, 0), PORT_A, '钉选 901 → A')
  ok('UNITY_BRIDGE_PID=901 → A')
  delete process.env.UNITY_BRIDGE_PID

  console.log('—— 端口文件被覆盖/残留（用户实际现象：文件端口 ≠ 编辑器打印端口） ——')
  // 模拟：后启动的残留实例把 projB 的端口文件覆盖成 29325（该端口无人监听），
  // 而 B 的真实编辑器仍在 29322 上（pid 902）。会话 cwd=projB。
  writePortFiles(P_B, 29325, 999)
  const primary = portForExec(exec(P_B))
  assert.equal(primary, 29325, '主候选读取到被覆盖的 29325（随后会被扫描纠正）')
  ok('主候选=被覆盖端口 29325（属预期，接下来靠扫描纠正）')
  const fixed = await findPortByHealth(exec(P_B), PORT_A, 8, primary)
  assert.equal(fixed, PORT_B, '扫描必须纠正回 B 的真实端口 29322')
  ok('残留文件下扫描纠正回 B(29322)')
  // 还原干净文件供后续用例
  writePortFiles(P_B, PORT_B, PID_B)

  console.log('—— JSON 边车读取（pid 采信规则） ——')
  const e1 = readPortFileEntry(path.join(P_B, 'Library', 'UnityBridgePort.txt'))
  assert.equal(e1.port, PORT_B)
  assert.equal(e1.pid, PID_B, '边车 port 与主文件一致 → 采信 pid')
  ok('边车一致 → pid 采信')
  const P_C = path.join(ROOT, 'projC')
  fs.mkdirSync(path.join(P_C, 'Library'), { recursive: true })
  fs.writeFileSync(path.join(P_C, 'Library', 'UnityBridgePort.txt'), '29325')
  fs.writeFileSync(path.join(P_C, 'Library', 'UnityBridgePort.json'), JSON.stringify({
    port: PORT_B, pid: PID_B, projectPath: P_C.replace(/\//g, '\\'),
  }))
  const e2 = readPortFileEntry(path.join(P_C, 'Library', 'UnityBridgePort.txt'))
  assert.equal(e2.port, 29325)
  assert.equal(e2.pid, undefined, '边车 port 与主文件不一致（跨实例覆盖）→ 不采信 pid')
  ok('边车不一致（跨实例覆盖）→ 不采信 pid')

  console.log(`\n全部通过（${passed} 项断言）`)
} finally {
  restoreEnv()
  for (const s of servers) s.close()
  fs.rmSync(ROOT, { recursive: true, force: true })
}
