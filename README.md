# Unity Bridge

让 **DeepSeek Harness（DSH）** 或任意 HTTP 客户端控制本机 Unity 编辑器。

- 常驻本地 HTTP 服务 `127.0.0.1:8321`（端口占用自动顺延，实际端口写入 `<项目>/Library/UnityBridgePort.txt` 供动态发现）
- 提供 `unity_*` 工具：编译、刷新资产、读日志/编译错误、执行编辑器方法、打开场景、查询资源；项目若另外装了 **MCP for Unity**，还会自动启用其全部工具的透传调用（`unity_mcp` / `unity_mcp_catalog`）
- 两部分组成：
  - **DSH 侧**：npm 插件包（`unity-bridge`，`dsh plugin` / pnpm 安装，host 全局插件，任何会话可用）
  - **Unity 侧**：UPM 包 `com.yd.unitybridge`（编辑器脚本，git URL 安装）

> 插件只负责 DSH 侧工具注册；**必须同时把 Unity 侧 UPM 包装进目标项目**才能连通。安装插件后，AI 会话会被告知读取仓库根目录的 [Install.md](Install.md) 完成 Unity 侧安装。

---

## 快速安装

### 1. 安装 DSH 插件（三选一）

```powershell
# 方式 A（推荐）：pnpm 一键安装 GitHub 远端插件，无需本地 clone。
# dsh plugin 内部即在 DSH profile 目录执行 pnpm add，装完自动把声明了
# dsh.bundle 的本包加入 profile 层栈，无需手改任何配置。
dsh plugin --profile web add github:ydd12333/unity-bridge

#   固定分支/标签/提交（可选，默认拉取仓库默认分支）：
#   dsh plugin --profile web add github:ydd12333/unity-bridge#main
#   dsh plugin --profile web add github:ydd12333/unity-bridge#v1.0.0

# 方式 B：从本地 checkout 安装（开发/离线场景）
git clone https://github.com/ydd12333/unity-bridge.git
cd unity-bridge
dsh plugin --profile web add .

# 方式 C：一键脚本（找不到 dsh 时自动回退复制安装）
.\install.ps1
```

> 纯 pnpm 等价命令为 `pnpm add github:ydd12333/unity-bridge`（在 profile 目录执行），
> 但不会自动更新 `dsh.profile.bundles`，请优先使用 `dsh plugin`（内部即 pnpm）。
> 若 `dsh` 不在 PATH，可在 deepseek-harness 源码目录用 `pnpm dsh plugin --profile web add github:ydd12333/unity-bridge`。
> 默认安装到 `web` profile，可用 `--profile <name>` 换成其它 profile。
> 装完需重启 DSH 会话（bundle 成员在启动时固定）。

### 2. 安装 Unity 侧 UPM 包

打开目标 Unity 项目的 `Packages/manifest.json`，在 `dependencies` 加：

```json
"com.yd.unitybridge": "https://github.com/ydd12333/unity-bridge.git?path=/com.yd.unitybridge"
```

或在 Unity 中 **Window → Package Manager → + → Add package from git URL…** 粘贴上述 URL。

> 也可让 AI 按 [Install.md](Install.md) 自动完成。UPM 包唯一依赖是注册表包
> `com.unity.nuget.newtonsoft-json`。

**MCP for Unity（`com.coplaydev.unity-mcp`）是可选依赖**：UPM 不支持包与包之间的
git 依赖（Git URL 只能写在项目 manifest），所以本包不声明它，改为运行时反射探测。
需要 `unity_mcp` 透传工具时，把这个 git 地址加进**项目 manifest 的 `dependencies`**：

```json
"com.coplaydev.unity-mcp": "https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity#main"
```

装上后 `unity_health` 的 `mcpInstalled` 为 `true`（`mcpVersion` 为版本）；
没装也能正常使用其余全部功能，只是 `unity_mcp` 会提示安装方法。

### 3. 验证

打开目标项目后，在 DSH 会话调用 `unity_health`，应返回项目名、版本与监听端口。

---

## 使用

工具（12 个）：

- 走**本仓库 UPM 包**（HTTP `127.0.0.1:8321`）：`unity_health` / `unity_compile` / `unity_refresh` / `unity_logs` / `unity_execute` / `unity_scene_open` / `unity_asset_get` / `unity_mcp_catalog` / `unity_mcp`
- 走**第三方 Codely Bridge**（原生 TCP，团结 AI `cn.tuanjie.codely.bridge`，可选）：`codely_health` / `codely_catalog` / `codely_call`

### codely_* —— 不依赖 MCP 的编辑器自动化通道

目标项目若装了 [Codely Bridge](https://www.tuanjie.cn/)（团结 AI 的编辑器自动化桥），本插件可直接驱动它：
命令集覆盖 `manage_gameobject` / `manage_asset`（含预制体 `modify` + `PrefabUtility.SavePrefabAsset`）/
`manage_scene` / `manage_script` / `manage_editor` / `manage_input` / `manage_screenshot` /
`manage_package` / `manage_bake` / `manage_dialog` / `manage_job`，以及内置 Roslyn 的
`execute_csharp_script`（**任意 C# 编辑器代码**）。它自带工具层与编译器，**既不依赖 MCP for Unity，
也不依赖本仓库的 UPM 包**；其原生 TCP 服务不依赖域重载，所以项目当前编译报错时它依然在线。

- 实例发现：读 `<项目根>/Temp/.com-unity-codely.json`（原生心跳文件，含 `unity_port` / `reloading` / `reason`）；
  候选目录策略与本插件的端口文件一致（会话目录、逐级祖先、各祖先的同级目录）。
- 协议：`WELCOME UNITY-TCP 1 FRAMING=1 SERVER_VERSION=n` 握手 → 帧 = `8 字节大端 uint64 长度 + UTF-8 负载`
  → 命令 `{"type","params","request_id"}`（实现见 `plugin/codely-client.mjs`）。
- 多实例/多项目同样按**会话工作目录**路由，歧义时拒绝自动选择；可用
  `UNITY_BRIDGE_PROJECT` / `UNITY_BRIDGE_CODELY_PORT` / `UNITY_BRIDGE_CODELY_HOST` 覆盖。
- 典型用法：
  ```jsonc
  // 读预制体
  { "tool": "manage_asset", "params": { "action": "get_components", "path": "Assets/X.prefab" } }
  // 改预制体（组件属性；内部会落盘保存）
  { "tool": "manage_asset", "params": { "action": "modify", "path": "Assets/X.prefab", "properties": { "m_Name": "NewName" } } }
  // 场景对象 / 任意 C#
  { "tool": "manage_gameobject", "params": { "action": "set_component_property", "target": "Player", "searchMethod": "by_name", "componentType": "Rigidbody", "propertyName": "mass", "value": 5 } }
  { "tool": "execute_csharp_script", "params": { "action": "editor", "code": "return Application.dataPath;" } }
  ```
- 自测：`node scripts/codely-bridge.test.mjs [项目根目录]`（对真实运行的编辑器跑 20 项断言）。
- 独立 CLI：`node scripts/codely-client.mjs <项目根> manage_editor '{"action":"get_state"}'`。

端口与路由规则（`unity_*`，多编辑器 / 多会话自动路由）：
- 默认 `127.0.0.1:8321`，被占用自动顺延；实际端口写 `<项目>/Library/UnityBridgePort.txt`，
  另写 JSON 边车 `UnityBridgePort.json`（含 pid / 项目身份，供多实例场景校验"文件是谁写的"）
- 每个 DSH 会话按其**工作目录**定位目标 Unity 实例（意图项目判定，多会话各连各的编辑器）：
  - 会话目录在项目内（含项目任意子目录）→ 操作该项目；
  - 会话目录在别处（如插件仓库）但只有 1 个可连项目 → 操作该项目；
  - 会话目录在别处且有多个可连项目 → **拒绝猜测并报错**（避免连错实例），可用下面任一方式指定：
    - `UNITY_BRIDGE_PROJECT=<项目绝对路径>` —— 按项目指定目标；
    - `UNITY_BRIDGE_PORT=<端口>` —— 按端口直连（先 `unity_health` 确认目标端口）；
    - `UNITY_BRIDGE_PID=<进程号>` —— 同一项目开了多个编辑器时，按实例进程号精确指定
      （`/health` 返回的 `pid` 即为当前实例进程号）
- 端口文件被其他实例覆盖 / 残留（文件端口 ≠ 编辑器实际打印端口）时，自动对 8321~8576
  发起 `/health` 扫描，并**严格按意图项目身份匹配**（兄弟项目的实例不会被选中），
  找到后写入发现缓存；扫描探测带 2.5s 短超时，不会卡死在无响应的僵尸实例上

## 卸载

```powershell
dsh plugin --profile web remove unity-bridge   # DSH 插件
.\uninstall.ps1 -UnityProject <项目路径>        # 或一键脚本（同时移除 UPM 包）
```

## License

MIT
