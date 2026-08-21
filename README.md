# Unity Bridge

让 **DeepSeek Harness（DSH）** 或任意 HTTP 客户端控制本机 Unity 编辑器。

- 常驻本地 HTTP 服务 `127.0.0.1:8321`（端口占用自动顺延，实际端口写入 `<项目>/Library/UnityBridgePort.txt` 供动态发现）
- 提供 `unity_*` 工具：编译、刷新资产、读日志/编译错误、执行编辑器方法、打开场景、查询资源，并透传 **MCP for Unity** 全部工具
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

> 也可让 AI 按 [Install.md](Install.md) 自动完成。UPM 包自动依赖 `com.coplaydev.unity-mcp` 与 `com.unity.nuget.newtonsoft-json`。

### 3. 验证

打开目标项目后，在 DSH 会话调用 `unity_health`，应返回项目名、版本与监听端口。

---

## 使用

工具：`unity_health` / `unity_compile` / `unity_refresh` / `unity_logs` / `unity_execute` / `unity_scene_open` / `unity_asset_get` / `unity_mcp_catalog` / `unity_mcp`

端口规则：
- 默认 `127.0.0.1:8321`，被占用自动顺延；实际端口写 `<项目>/Library/UnityBridgePort.txt`
- DSH 侧优先读端口文件，回退固定端口；可用 `UNITY_BRIDGE_PORT` 强制指定

## 卸载

```powershell
dsh plugin --profile web remove unity-bridge   # DSH 插件
.\uninstall.ps1 -UnityProject <项目路径>        # 或一键脚本（同时移除 UPM 包）
```

## License

MIT
