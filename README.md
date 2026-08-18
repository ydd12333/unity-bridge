# Unity Bridge

让 **DeepSeek Harness（DSH）** 或任意 HTTP 客户端控制本机 Unity 编辑器。

- 常驻本地 HTTP 服务：`127.0.0.1:8321`（端口被占用时自动顺延，实际端口写入 `Library/UnityBridgePort.txt` 供 DSH 动态发现）
- 能力：触发编译、刷新资产、读取 Console 日志与编译错误、执行编辑器静态方法、打开场景、查询资源，并可透传调用 **MCP for Unity** 的全部工具（约 30 个）
- 由两部分组成：
  - **Unity 侧**：UPM 包 `com.yd.unitybridge`（编辑器脚本，通过 git URL 安装）
  - **DSH 侧**：preset（`~/.dsh/.agent-presets/unity-bridge/`，提供 `unity_*` 工具）

---

## 目录结构

```
unity-bridge/
├── install.ps1                 # 一键安装（DSH preset + 可选 Unity 项目）
├── uninstall.ps1               # 卸载
├── README.md
├── preset/                     # DSH preset（harness 侧）
│   ├── agent.cordis.yml
│   ├── preset.yml
│   └── unity-bridge.mjs
└── com.yd.unitybridge/         # UPM 包（Unity 侧）
    ├── package.json
    └── Editor/
        ├── UnityBridgeServer.cs
        └── UnityBridgeMenu.cs
```

---

## 安装

### 方式一：一键脚本（推荐）

```powershell
# 克隆仓库
git clone https://github.com/ydd12333/unity-bridge.git
cd unity-bridge

# 仅安装 DSH preset（Unity 侧稍后单独装）
.\install.ps1

# 同时安装到某个 Unity 项目（自动写 Packages/manifest.json）
.\install.ps1 -UnityProject D:\MyUnityProject
```

也可以直接从远端一行执行（PowerShell 5+）：

```powershell
irm https://raw.githubusercontent.com/ydd12333/unity-bridge/main/install.ps1 | iex
```

> 从远端执行时 `-UnityProject` 参数无法传递，只会安装 DSH preset；Unity 包请用下面的方式二。

### 方式二：手动（Unity 侧）

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
2. 重启 DSH 会话（让 preset 生效）
3. 在 DSH 中即可调用：`unity_health` / `unity_compile` / `unity_refresh` / `unity_logs` / `unity_execute` / `unity_scene_open` / `unity_asset_get` / `unity_mcp` / `unity_mcp_catalog`

**端口规则**：
- 默认监听 `127.0.0.1:8321`
- 被占用时自动顺延（最多 256 个端口），实际端口写入 `<项目>/Library/UnityBridgePort.txt`
- DSH 侧优先读该文件动态发现端口；读不到时回退固定端口 8321
- 可用环境变量 `UNITY_BRIDGE_PORT` 强制指定端口（DSH 侧）

**排查**：
- 服务未启动：Unity Console 应看到 `[UnityBridge] 已启动`；若看到端口占用警告，说明 8321~8576 全被占，检查是否有程序（Hyper-V/WSL2/Docker 保留区）占用
- DSH 连不上：确认 Unity 已打开、会话已重启

---

## 卸载

```powershell
# 仅卸载 DSH preset
.\uninstall.ps1

# 同时从 Unity 项目移除包
.\uninstall.ps1 -UnityProject D:\MyUnityProject
```

---

## 工作原理

```
┌─────────────┐  HTTP (127.0.0.1:8321+)  ┌──────────────────┐
│  DSH (Agent) │ ◄──────────────────────► │  Unity 编辑器     │
│  unity-bridge│                          │  UnityBridgeServer│
│  preset 插件 │                          │  (UPM 包, Editor) │
└─────────────┘                          └──────────────────┘
   · 端口文件动态发现                        · [InitializeOnLoad] 自动启动
   · 编译触发+轮询                          · 主线程队列执行 Unity API
   · 项目路径交叉校验                        · /mcp 透传 MCP for Unity
```

- Unity 侧 `[InitializeOnLoad]` 静态构造自动启动 HTTP 服务，`HttpListener` 后台线程收请求，Unity API 通过主线程队列执行
- 编译采用「触发 + 轮询」：触发后立即返回，DSH 轮询 `/health` 直到 `compiling == false`，再读 `/logs` 拿编译错误
- 端口文件 `<项目>/Library/UnityBridgePort.txt`（git 忽略）记录实际端口，DSH 优先读取

---

## License

MIT
