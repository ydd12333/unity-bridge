# Unity Bridge

让 **DeepSeek Harness（DSH）** 或任意 HTTP 客户端控制本机 Unity 编辑器。

- 常驻本地 HTTP 服务：`127.0.0.1:8321`（端口被占用时自动顺延，实际端口写入 `Library/UnityBridgePort.txt` 供 DSH 动态发现）
- 能力：触发编译、刷新资产、读取 Console 日志与编译错误、执行编辑器静态方法、打开场景、查询资源，并可透传调用 **MCP for Unity** 的全部工具（约 30 个）
- 由两部分组成：
  - **Unity 侧**：UPM 包 `com.yd.unitybridge`（编辑器脚本，通过 git URL 安装）
  - **DSH 侧**：host 全局插件（`unity-bridge.mjs`，作为 npm 插件包经 `dsh plugin`/pnpm 一键安装，注册 `unity_*` 工具）

> DSH 侧由旧版 **agent preset**（`~/.dsh/.agent-presets/unity-bridge/`，需会话选择 preset）迁移为 **host 全局插件包**：任何预设、任何对话都可用 `unity_*` 工具，并支持 `dsh plugin ... add`（内部 pnpm）一键安装。

---

## 目录结构

```
unity-bridge/
├── package.json                 # npm 插件包清单（dsh.bundle 声明，pnpm 安装入口）
├── cordis.patch.yml             # 插件 bundle 的 patch 层（insert tool-unity-bridge）
├── install.ps1                  # 一键安装（DSH 插件 + 可选 Unity 项目）
├── uninstall.ps1                # 卸载
├── README.md
├── plugin/                      # DSH 全局插件（harness 侧，包 main 入口）
│   └── unity-bridge.mjs
└── com.yd.unitybridge/          # UPM 包（Unity 侧，git URL ?path= 取用）
    ├── package.json
    └── Editor/
        ├── UnityBridgeServer.cs
        └── UnityBridgeMenu.cs
```

---

## 安装

### 方式一：pnpm / `dsh plugin` 一键安装（推荐）

本仓库本身就是标准 DSH 插件包（根 `package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`），因此可以直接用 pnpm 安装到任意 DSH profile。`dsh plugin` 是 pnpm 的封装：装好后自动把本包加入该 profile 的 `dsh.profile.bundles` 层栈，**无需手改任何配置**。

**从仓库目录安装**（dsh 在 PATH 时）：

```powershell
git clone https://github.com/ydd12333/unity-bridge.git
cd unity-bridge

dsh plugin --profile web add .            # 装入 web profile（GUI）
dsh plugin --profile cli add .            # 或其它 profile
```

**从 deepseek-harness 源码目录安装**（dsh 不在 PATH，用 pnpm 调源码里的 dsh）：

```powershell
cd D:\deepseek-harness                    # harness 源码 checkout
pnpm dsh plugin --profile web add D:\Unity\Island\ydd12333\unity-bridge
# 或从 git 远端：
pnpm dsh plugin --profile web add https://github.com/ydd12333/unity-bridge.git
```

> 相对路径 spec（`.`、`../xx`）会被锚定到**调用 dsh 时的目录**；绝对路径直接透传。装的是 `file:`/git 依赖，包名为 `unity-bridge`。

安装后**重启 DSH（或重启该 profile）生效**：bundle 成员在启动时固定（profile 运行中编辑 `cordis.patch.yml` 才会热生效）。卸载同理：

```powershell
dsh plugin --profile web remove unity-bridge
pnpm dsh plugin --profile web remove unity-bridge   # harness 源码目录
```

### 方式二：一键脚本

```powershell
# 克隆仓库
git clone https://github.com/ydd12333/unity-bridge.git
cd unity-bridge

# 仅安装 DSH 插件（默认装入 web profile；优先走 dsh plugin，找不到则回退复制）
.\install.ps1

# 安装到指定 DSH profile
.\install.ps1 -ProfileName cli

# 同时安装到某个 Unity 项目（自动写 Packages/manifest.json）
.\install.ps1 -UnityProject D:\MyUnityProject

# dsh 不在 PATH 时，指定用 harness 源码目录的 pnpm dsh
.\install.ps1 -DshCommand "pnpm dsh" -DshCwd D:\deepseek-harness
```

也可以直接从远端一行执行（PowerShell 5+）：

```powershell
irm https://raw.githubusercontent.com/ydd12333/unity-bridge/main/install.ps1 | iex
```

> 从远端执行时 `-UnityProject` 参数无法传递，只会安装 DSH 插件；Unity 包请用下面的方式四。

**安装到哪、怎么生效**：
- 默认走 `dsh plugin --profile <name> add file:<本仓库>`（内部 pnpm），装进 `$DSH_HOME/profiles/<name>/node_modules/unity-bridge` 并自动加入 bundle 层栈；需重启 DSH 生效
- 找不到 dsh 命令时回退为**复制方式**：把 `plugin/unity-bridge.mjs` 复制到 `$DSH_HOME/profiles/<name>/` 并在 `cordis.patch.yml` 追加 `tool-unity-bridge` 段 —— 该方式保存即热生效（无需重启）。可加 `-InstallMethod copy` 强制
- 插件是 **host 全局插件**：不依赖任何 agent preset，所有预设、所有会话共享
- 旧版 agent preset（`~/.dsh/.agent-presets/unity-bridge/`）若存在会被自动清理，无需手动处理

### 方式三：手动（DSH 插件，复制方式）

1. 复制 `plugin/unity-bridge.mjs` 到目标 profile 目录：`$DSH_HOME/profiles/web/unity-bridge.mjs`
2. 在 `$DSH_HOME/profiles/web/cordis.patch.yml`（不存在则新建，内容为顶层 YAML 数组）末尾追加：

```yaml
- insert:
    - id: tool-unity-bridge
      name: './unity-bridge.mjs'
```

3. 保存即热生效（若 DSH 正在运行，无需重启）

### 方式四：手动（Unity 侧）

在 Unity 中打开 **Window → Package Manager → + → Add package from git URL…**，粘贴：

```
https://github.com/ydd12333/unity-bridge.git?path=/com.yd.unitybridge
```

或者直接编辑项目 `Packages/manifest.json` 的 `dependencies` 加一行：

```json
"com.yd.unitybridge": "https://github.com/ydd12333/unity-bridge.git?path=/com.yd.unitybridge"
```

> UPM 包自动依赖 `com.coplaydev.unity-mcp`（MCP for Unity，git 包）与 `com.unity.nuget.newtonsoft-json`，Package Manager 会一并解析。

---

## 使用

1. 确保 Unity 已打开目标项目（服务在编辑器启动时自动监听）
2. 在 DSH 中即可调用：`unity_health` / `unity_compile` / `unity_refresh` / `unity_logs` / `unity_execute` / `unity_scene_open` / `unity_asset_get` / `unity_mcp` / `unity_mcp_catalog`

**端口规则**：
- 默认监听 `127.0.0.1:8321`
- 被占用时自动顺延（最多 256 个端口），实际端口写入 `<项目>/Library/UnityBridgePort.txt`
- DSH 侧优先读该文件动态发现端口；读不到时回退固定端口 8321
- 可用环境变量 `UNITY_BRIDGE_PORT` 强制指定端口（DSH 侧）

**排查**：
- 服务未启动：Unity Console 应看到 `[UnityBridge] 已启动`；若看到端口占用警告，说明 8321~8576 全被占，检查是否有程序（Hyper-V/WSL2/Docker 保留区）占用
- DSH 连不上：确认 Unity 已打开、插件已装载（可 `dsh plugin --profile <name> list` 查包，或检查 profile 的 `cordis.patch.yml` 是否含 `tool-unity-bridge`）

---

## 卸载

```powershell
# pnpm 方式：dsh plugin remove（内部 pnpm，自动移出 bundle 层栈）
dsh plugin --profile web remove unity-bridge

# 一键脚本（两种安装方式都兼容清理）
.\uninstall.ps1
.\uninstall.ps1 -ProfileName cli
.\uninstall.ps1 -DshCommand "pnpm dsh" -DshCwd D:\deepseek-harness

# 同时从 Unity 项目移除包
.\uninstall.ps1 -UnityProject D:\MyUnityProject
```

---

## 工作原理

```
┌─────────────┐  HTTP (127.0.0.1:8321+)  ┌──────────────────┐
│  DSH (Agent) │ ◄──────────────────────► │  Unity 编辑器     │
│  unity-bridge│                          │  UnityBridgeServer│
│  全局插件     │                          │  (UPM 包, Editor) │
└─────────────┘                          └──────────────────┘
   · 端口文件动态发现                        · [InitializeOnLoad] 自动启动
   · 编译触发+轮询                          · 主线程队列执行 Unity API
   · 项目路径交叉校验                        · /mcp 透传 MCP for Unity
   · dsh plugin/pnpm 安装（bundle 层栈）
```

- Unity 侧 `[InitializeOnLoad]` 静态构造自动启动 HTTP 服务，`HttpListener` 后台线程收请求，Unity API 通过主线程队列执行
- DSH 侧 `unity-bridge.mjs` 是 npm 包 `unity-bridge` 的 main 入口：`dsh plugin` 安装后其 `cordis.patch.yml`（bundle patch）把 `tool-unity-bridge` 行插入组装树，注册 `unity_*` 工具，任意 preset/会话可用
- 编译采用「触发 + 轮询」：触发后立即返回，DSH 轮询 `/health` 直到 `compiling == false`，再读 `/logs` 拿编译错误
- 端口文件 `<项目>/Library/UnityBridgePort.txt`（git 忽略）记录实际端口，DSH 优先读取

---

## License

MIT
