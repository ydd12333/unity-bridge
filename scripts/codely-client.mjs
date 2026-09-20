// Codely Bridge 命令行客户端（仓库自测/调试用）。
//
// 实际实现（发现 + 协议 + 命令目录）都在 plugin/codely-client.mjs —— DSH 插件的
// codely_* 工具用的就是同一份代码，这里只做 CLI 包装，避免两份实现漂移。
//
// 用法：
//   node scripts/codely-client.mjs <项目根目录> ping
//   node scripts/codely-client.mjs <项目根目录> manage_editor '{"action":"get_state"}'
//   node scripts/codely-client.mjs <项目根目录> manage_asset '{"action":"get_components","path":"Assets/X.prefab"}'
//   node scripts/codely-client.mjs --catalog
import path from 'node:path'
import { codelyCall, codelyCatalogText, discoverCodely, readCodelyRegistry } from '../plugin/codely-client.mjs'

const args = process.argv.slice(2)
if (args[0] === '--catalog') {
  console.log(codelyCatalogText())
  process.exit(0)
}

const [target, type = 'ping', paramsJson] = args
const params = paramsJson ? JSON.parse(paramsJson) : {}
if (!target) {
  console.error('用法: node scripts/codely-client.mjs <项目根目录> [命令] [params JSON]')
  process.exit(2)
}

const cwd = path.resolve(target)
const reg = readCodelyRegistry(cwd)
if (reg) {
  console.log(`# 心跳: port=${reg.port} host=${reg.host} project=${reg.rawRoot} reloading=${reg.reloading} reason=${reg.reason || '-'} lastUpdated=${reg.lastUpdated || '-'}`)
} else {
  console.log(`# 该目录无心跳文件（${path.join(cwd, 'Temp', '.com-unity-codely.json')}）；尝试按同级目录发现`)
}
const discovered = discoverCodely(cwd, {})
console.log(`# 目标实例: ${discovered.host}:${discovered.port} project=${discovered.rawRoot || discovered.projectRoot}`)

const res = await codelyCall(type, params, { cwd, timeoutMs: 120000 })
console.log(`# welcome: ${res.raw ? '' : ''}serverVersion=${res.serverVersion}`)
console.log(res.raw)