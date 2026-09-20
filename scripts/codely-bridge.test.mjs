// Codely Bridge DSH 工具的自测/联调脚本。
//
// 用假的 Cordis ctx 调 plugin/unity-bridge.mjs 的 apply()，抓取注册的工具定义，
// 再以真实会话 cwd 调用 codely_health / codely_catalog / codely_call —— 也就是
// 走 DSH 实际会走的那条代码路径，直接打到本机正在运行的 Codely Bridge。
//
// 用法：
//   node scripts/codely-bridge.test.mjs [目标项目根目录]
// 默认目标项目：D:\Unity\Island\islandclient（含 Codely Bridge 心跳的那个）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, _internals } from '../plugin/unity-bridge.mjs'

const PROJECT = process.argv[2] || 'D:\\Unity\\Island\\islandclient'
const PREFAB = 'Assets/Art/Effect/Buff/Prefabs/vfx_buff_bleed.prefab'
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// —— 1. 注册表（假 ctx，等价于 DSH 启动时 plugin_manager 装载）——
console.log('—— 工具注册 ——')
const tools = new Map()
const sections = []
apply({
  systemPrompt: { section: (s) => sections.push(s.name) },
  tools: { register: (def) => tools.set(def.name, def) },
})
for (const name of ['unity_health', 'unity_mcp', 'codely_health', 'codely_catalog', 'codely_call']) {
  check(`注册 ${name}`, tools.has(name))
}
check('注入 codely systemPrompt 节', sections.includes('unity-bridge-codely'), sections.join(','))
check('全部工具都有 parameters/output', [...tools.values()].every((t) => t.parameters && t.output?.schema))

const execWith = (cwd) => ({ agent: { session: { header: { cwd } } } })
const run = async (name, args, cwd) => {
  const def = tools.get(name)
  const out = await def.execute(args, execWith(cwd))
  try { return JSON.parse(out.text) } catch { return out.text }
}

// —— 2. 从仓库目录发现兄弟项目里的 Codely Bridge ——
console.log('\n—— codely_health（cwd=插件仓库，靠同级目录发现项目）——')
const health = await run('codely_health', {}, REPO)
check('installed', health.installed === true, JSON.stringify(health))
check('alive（握手 + ping 通过）', health.alive === true)
check('serverVersion >= 2', Number(health.serverVersion) >= 2, String(health.serverVersion))
check('项目根指向 islandclient', String(health.projectRoot).toLowerCase().includes('islandclient'), health.projectRoot)
check('心跳文件路径正确', String(health.heartbeat || '').endsWith(path.join('Temp', '.com-unity-codely.json')), health.heartbeat)

// —— 3. 目录 ——
console.log('\n—— codely_catalog ——')
const catalog = await run('codely_catalog', {}, PROJECT)
check('含命令目录文本', typeof catalog.catalog === 'string' && catalog.catalog.includes('manage_asset'))
check('含自定义工具查询结果', catalog.customTools !== undefined)
check('catalog 不再重复 info 字段', catalog.info === undefined)

// —— 4. 透传调用（只读，安全）——
// 输出已展平：外层路由响应的内层 handler 响应被拆开，业务失败直接抛错。
console.log('\n—— codely_call（只读）——')
const state = await run('codely_call', { tool: 'manage_editor', params: { action: 'get_state' } }, PROJECT)
check('manage_editor/get_state ok', state.ok === true && state.data?.isPlaying === false, JSON.stringify(state).slice(0, 300))
check('manage_editor 的 state 字段被平铺保留', state.state?.editor?.playMode === 'stopped', JSON.stringify(state.state || {}).slice(0, 200))
const comps = await run('codely_call', { tool: 'manage_asset', params: { action: 'get_components', path: PREFAB } }, PROJECT)
check('manage_asset/get_components 读到预制体组件', Array.isArray(comps.data) && comps.data.length > 0, JSON.stringify(comps).slice(0, 300))
const info = await run('codely_call', { tool: 'manage_asset', params: { action: 'get_info', path: PREFAB } }, PROJECT)
check('manage_asset/get_info 返回 guid', typeof info.data?.guid === 'string', JSON.stringify(info).slice(0, 200))

// 内置 Roslyn：真正执行一段 C#（只读表达式）
const csharp = await run('codely_call', { tool: 'execute_csharp_script', params: { action: 'editor', script: 'return Application.dataPath;' } }, PROJECT)
const csharpText = JSON.stringify(csharp)
check('execute_csharp_script 实跑成功', csharp.ok === true && csharpText.includes('islandclient'), csharpText.slice(0, 300))

// 业务失败必须抛错（不是 ok:true + 嵌套 success:false）
let businessError = ''
try {
  await tools.get('codely_call').execute({ tool: 'execute_csharp_script', params: { action: 'editor' } }, execWith(PROJECT))
} catch (e) { businessError = e.message }
check('业务失败抛错并带原始信息', businessError.includes("'script' parameter is required"), businessError.slice(0, 200))

// —— 5. 错误路径 ——
console.log('\n—— 错误路径 ——')
let notFound = ''
try { await _internals.discoverCodely(path.join(os.tmpdir(), 'dsh-no-codely-here')) } catch (e) { notFound = e.message }
check('无心跳时报“未检测到 Codely Bridge”', notFound.includes('未检测到 Codely Bridge'), notFound.slice(0, 120))

// 人造双项目，验证“多项目歧义拒绝自动选择”
const fixtureRoot = path.join(os.tmpdir(), `dsh-codely-fixture-${process.pid}`)
const sessionDir = path.join(fixtureRoot, 'session')
for (const p of ['projA', 'projB']) {
  const dir = path.join(fixtureRoot, p, 'Temp')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '.com-unity-codely.json'), JSON.stringify({
    unity_port: 1, project_path: `${path.join(fixtureRoot, p, 'Assets').replace(/\\/g, '/')}`, reloading: false, reason: 'ready',
  }))
}
fs.mkdirSync(sessionDir, { recursive: true })
let ambiguous = ''
try { _internals.discoverCodely(sessionDir) } catch (e) { ambiguous = e.message }
check('多项目时拒绝自动选择', ambiguous.includes('检测到多个可用的 Codely Bridge 项目'), ambiguous.slice(0, 140))
// 指定项目后应能解析
let resolved = null
try { resolved = _internals.discoverCodely(sessionDir, { envProject: path.join(fixtureRoot, 'projB') }) } catch (e) { resolved = { error: e.message } }
check('UNITY_BRIDGE_PROJECT 指定后解析成功', resolved && !resolved.error && resolved.port === 1, JSON.stringify(resolved))
fs.rmSync(fixtureRoot, { recursive: true, force: true })

console.log(`\n${fail === 0 ? '全部通过' : '存在失败'}（${pass} 通过 / ${fail} 失败）`)
process.exit(fail === 0 ? 0 : 1)