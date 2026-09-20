# Install.md — Unity 侧安装指南（供 AI 读取执行）

> 本文件是给 **DSH 会话中的 AI** 看的操作手册。用户已安装 DSH 插件
> （`unity-bridge`，即本文件所在包），但 **Unity 侧 UPM 包（com.yd.unitybridge）
> 可能尚未安装**。请按下面的步骤判断并完成安装、验证连通。
>
> 典型场景：用户打开了一个 Unity 项目，希望在 DSH 里用 `unity_*` 工具控制它。
> 若目标项目从未装过 Unity Bridge，`unity_*` 工具会全部连接失败——原因就是
> Unity 侧服务不存在，需要先装 UPM 包。

---

## 0. 目标与前置

- **目标**：把 UPM 包 `com.yd.unitybridge` 装进目标 Unity 项目，使 Unity 编辑器
  启动时自动监听 `127.0.0.1:8321`（端口顺延见文末），DSH 即可控制。
- **前置**：
  - 用户已打开目标 Unity 项目（编辑器运行中）。
  - 你能读写该项目的 `Packages/manifest.json`（若会话工作目录不是项目目录，
    先向用户确认项目路径，或请用户把会话工作目录切到项目目录）。
- **唯一依赖**：`com.unity.nuget.newtonsoft-json`（注册表包，UPM 自动解析）。
- **可选依赖**：`com.coplaydev.unity-mcp`（MCP for Unity，git 包）。**本包不声明它**
  ——UPM 不允许「包与包之间的 git 依赖」，Git URL 只能写在**项目**的
  `Packages/manifest.json`。装了它才会多出 `unity_mcp` / `unity_mcp_catalog`
  两个透传工具；不装也不影响编译、启动与其余全部功能（见第 2.1 节）。

---

## 1. 判断目标项目

先调用 `unity_health`：

- **能返回项目名/版本/端口** → 服务已就绪，跳到第 4 步验证即可（用户可能已装过）。
- **报“项目不匹配”** → Unity 已开，但当前会话目录 ≠ Unity 实例项目目录。
  端口文件 `<项目>/Library/UnityBridgePort.txt` 指向的是 Unity 实例项目。
  请**在目标 Unity 项目目录下新建 DSH 会话**（或让用户把工作目录切到项目目录）
  后再试；本会话无法对该实例做项目交叉校验。
- **报“检测到多个 Unity 项目可连接…”** → 有多个 Unity 实例在跑，且当前会话目录
  不在其中任何一个项目内。按报错提示设 `UNITY_BRIDGE_PROJECT=<项目绝对路径>`
  （或 `UNITY_BRIDGE_PORT=<端口>`）后重试，或在目标项目目录开会话。
- **连接失败（无法连接/ECONNREFUSED）** → Unity 侧服务未启动，进入第 2 步安装。
  也可能 Unity 未打开：先让用户确认已打开目标项目。

> 判断目标项目路径的另一途径：询问用户，或查看 `unity_health` 返回的
> `projectPath`（服务存在时）。本文件统一用 `<项目>` 指代目标项目根目录
> （含 `Assets/`、`Packages/` 的那一层）。

---

## 2. 安装 UPM 包（两种方式，任选其一）

### 方式 A：编辑 manifest.json（推荐，AI 可全程自动完成）

1. 读取 `<项目>/Packages/manifest.json`。
2. 检查 `dependencies` 是否已有 `com.yd.unitybridge`：
   - **已有** → 无需安装，跳到第 3 步。
   - **没有** → 在 `dependencies` 中加入：

   ```json
   "com.yd.unitybridge": "https://github.com/ydd12333/unity-bridge.git?path=/com.yd.unitybridge"
   ```

   （保持 JSON 合法，逗号别漏。）
3. 保存文件，然后触发 Unity 重新解析包：
   - 调用 `unity_refresh`（若此时服务已因旧版存在而可用）；或
   - 请用户回 Unity 等待 Package Manager 自动解析（通常保存 manifest 后数秒内
     自动触发；也可让用户打开 **Window → Package Manager** 查看）。

> ⚠ 不要把 `com.coplaydev.unity-mcp` 之类的 git 地址写进 `com.yd.unitybridge`
> 的 `package.json`——UPM 会直接报
> `Version 'https://...' is invalid. Expected a 'SemVer' compatible value.` 并拒绝
> 安装本包。git 依赖只能出现在**项目** manifest 里。

### 方式 B：Unity Package Manager（需要用户手动操作）

让用户在 Unity 中执行 **Window → Package Manager → + → Add package from git URL…**，
粘贴：

```
https://github.com/ydd12333/unity-bridge.git?path=/com.yd.unitybridge
```

> 若 `unity_mcp` 可用（说明 MCP for Unity 已在项目里），也可以尝试
> `unity_mcp` 的 `manage_packages` `add_package`；但 git URL 依赖可能不被
> 该工具支持，失败时请回退到方式 A。

## 2.1 可选：安装 MCP for Unity（启用 `unity_mcp` 透传工具）

只有需要 `unity_mcp` / `unity_mcp_catalog`（约 30 个 MCP for Unity 工具，
覆盖资源/场景/GameObject/组件/脚本/构建/测试/材质/UI/包管理等）时才需要这一步。

1. 读取 `<项目>/Packages/manifest.json`，在 `dependencies` 加入：

   ```json
   "com.coplaydev.unity-mcp": "https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity#main"
   ```

   （同样只能加在**项目** manifest 里。用户也可用 Package Manager →
   Add package from git URL… 粘贴同一个地址。）
2. 等 Unity 拉取并编译（首次较慢），然后调 `unity_health` 确认
   `mcpInstalled == true`。
3. 未安装时：`unity_health` 的 `mcpInstalled` 为 `false`，`unity_mcp_catalog`
   返回 `{ "installed": false, "count": 0, "hint": "…安装方法…" }`，
   `unity_mcp` 会直接报错并附安装指引——**这不是故障**，按需装或不装都可以。

---

## 3. 等待编译完成

包加入后 Unity 会重新解析并编译（可能耗时 1~5 分钟；若同时装了 MCP for Unity，
首次拉取更久）。此阶段：

- 不要反复调用 `unity_*` 工具（服务可能尚未就绪）。
- 可以轮询 `unity_health`：能返回且 `compiling == false` 即就绪。
- 也可提示用户留意 Unity Console：应看到 `[UnityBridge] 已启动`。

## 4. 验证连通

调用（前两项应成功）：

1. `unity_health` → 返回项目名、Unity 版本、监听端口、`compiling: false`
   （并含 `mcpInstalled` / `mcpVersion`）。
2. `unity_logs` / `unity_compile` 各调一次，确认读写正常。
3. 若装了 MCP for Unity：`unity_mcp_catalog` → `installed: true` 且约 30 个工具。

---

## 5. 常见问题

| 现象 | 原因与处理 |
|---|---|
| Package Manager 报 `Package com.yd.unitybridge@... has invalid dependencies ... Version 'https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity#main' is invalid. Expected a 'SemVer' compatible value.` | 旧版本本包在 `package.json` 里声明了 MCP 的 **git 依赖**，UPM 不支持包间 git 依赖，故拒装。升级到本包 ≥1.1.0（已移除该依赖、改为运行时反射探测）并清掉项目里的旧解析记录：从 manifest 删除 `com.yd.unitybridge` → 关闭 Package Manager 报错 → 重新按第 2 步添加。必要时删除 `<项目>/Library/PackageCache/com.yd.unitybridge@*` 后重试 |
| `unity_health` 连接失败 | Unity 未打开 / UPM 包未装 / 仍在编译。确认编辑器运行中且第 2、3 步已完成 |
| `unity_health` 正常但 `unity_mcp_catalog` / `unity_mcp` 报错 | 项目未装 MCP for Unity（`mcpInstalled: false`）。按第 2.1 节安装，或忽略这两个工具用其余端点 |
| 报“项目不匹配”或“检测到多个 Unity 项目可连接…” | 会话目录 ≠ 目标实例项目。在目标项目目录开会话；若会话目录不便切换，设环境变量 `UNITY_BRIDGE_PROJECT=<项目绝对路径>`（或 `UNITY_BRIDGE_PORT=<端口>`）后重试 |
| 同时开着多个 Unity 编辑器、多个 DSH 会话互相连错 | 会话按工作目录自动路由到对应项目：把每个会话的工作目录切到各自目标项目即可。若端口文件被其他（含无窗口/残留）实例覆盖（文件端口 ≠ 编辑器打印端口），插件会扫描并按项目身份纠正。同一项目开了多个编辑器时，用 `UNITY_BRIDGE_PID=<进程号>` 按实例精确指定（`/health` 的 `pid` 即实例进程号） |
| 端口占用 | 8321 被占自动顺延（最多 256 个端口 8321~8576）。DSH 侧会读 `<项目>/Library/UnityBridgePort.txt`（及 JSON 边车）动态发现实际端口；若端口文件读不到（如会话不在项目目录）或内容过时/被覆盖，还会自动扫描顺延端口段并按项目身份定位正确实例。试到全部端口失败时 Unity Console 警告区分两类：① 256 个端口全被占（`netstat`/`taskkill` 结束占用进程；检查 Hyper-V/WSL2/Docker 保留区 `netsh int ipv4 show excludedportrange protocol=tcp`；关多余 Unity 实例/重启编辑器）；② 权限或系统资源问题（换端口无效，附官方文档链接） |
| 服务启动失败 | Unity Console 应显示 `[UnityBridge] 已启动` 或具体异常；把报错信息转给用户排查 |
| bridge 全部超时（含 `/health`） | 大概率是刚才通过菜单/静态方法触发了**模态对话框**（如某些 Status/Stop 类菜单，本包已移除自己的弹窗菜单），阻塞了 Unity 主线程。无法自动关闭——请用户到 Unity 窗口手动点掉对话框后恢复。**以后不要通过 bridge 调用任何会弹窗的交互式菜单** |

---

## 6. 卸载（如需）

- 从 `<项目>/Packages/manifest.json` 的 `dependencies` 删除 `com.yd.unitybridge`
  （MCP for Unity 与本包无关，按需保留或删除）。
- 或运行仓库 `uninstall.ps1 -UnityProject <项目>`。