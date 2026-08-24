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
  - UPM 包会**自动拉取依赖** `com.coplaydev.unity-mcp`（MCP for Unity，git 包）
    与 `com.unity.nuget.newtonsoft-json`，无需单独安装。

---

## 1. 判断目标项目

先调用 `unity_health`：

- **能返回项目名/版本/端口** → 服务已就绪，跳到第 4 步验证即可（用户可能已装过）。
- **报“项目不匹配”** → Unity 已开，但当前会话目录 ≠ Unity 实例项目目录。
  端口文件 `<项目>/Library/UnityBridgePort.txt` 指向的是 Unity 实例项目。
  请**在目标 Unity 项目目录下新建 DSH 会话**（或让用户把工作目录切到项目目录）
  后再试；本会话无法对该实例做项目交叉校验。
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

### 方式 B：Unity Package Manager（需要用户手动操作）

让用户在 Unity 中执行 **Window → Package Manager → + → Add package from git URL…**，
粘贴：

```
https://github.com/ydd12333/unity-bridge.git?path=/com.yd.unitybridge
```

> 若 `unity_mcp` 可用（说明 MCP for Unity 已在项目里），也可以尝试
> `unity_mcp` 的 `manage_packages` `add_package`；但 git URL 依赖可能不被
> 该工具支持，失败时请回退到方式 A。

---

## 3. 等待编译完成

包加入后 Unity 会拉取 git 依赖并重新编译（可能耗时 1~5 分钟，首次拉取
MCP for Unity 更久）。此阶段：

- 不要反复调用 `unity_*` 工具（服务可能尚未就绪）。
- 可以轮询 `unity_health`：能返回且 `compiling == false` 即就绪。
- 也可提示用户留意 Unity Console：应看到 `[UnityBridge] 已启动`。

## 4. 验证连通

调用（全部应成功）：

1. `unity_health` → 返回项目名、Unity 版本、监听端口、`compiling: false`。
2. `unity_mcp_catalog` → 返回约 30 个 MCP for Unity 工具清单。
3. （可选）`unity_logs` / `unity_compile` 各调一次确认读写正常。

---

## 5. 常见问题

| 现象 | 原因与处理 |
|---|---|
| `unity_health` 连接失败 | Unity 未打开 / UPM 包未装 / 仍在编译。确认编辑器运行中且第 2、3 步已完成 |
| 报“项目不匹配” | 会话目录 ≠ Unity 实例项目。在目标项目目录开会话 |
| `unity_health` 正常但 `unity_mcp_catalog` 失败 | MCP for Unity 未随包解析成功；回 Unity 看 Package Manager 是否报错 |
| 端口占用 | 8321 被占自动顺延（最多 256 个端口 8321~8576）。DSH 侧会读 `<项目>/Library/UnityBridgePort.txt` 动态发现实际端口；若端口文件读不到（如会话不在项目目录）或内容过时，还会自动扫描顺延端口段并按项目身份定位正确实例。试到全部端口失败时 Unity Console 警告区分两类：① 256 个端口全被占（`netstat`/`taskkill` 结束占用进程；检查 Hyper-V/WSL2/Docker 保留区 `netsh int ipv4 show excludedportrange protocol=tcp`；关多余 Unity 实例/重启编辑器）；② 权限或系统资源问题（换端口无效，附官方文档链接） |
| 服务启动失败 | Unity Console 应显示 `[UnityBridge] 已启动` 或具体异常；把报错信息转给用户排查 |
| bridge 全部超时（含 `/health`） | 大概率是刚才通过菜单/静态方法触发了**模态对话框**（如某些 Status/Stop 类菜单，本包已移除自己的弹窗菜单），阻塞了 Unity 主线程。无法自动关闭——请用户到 Unity 窗口手动点掉对话框后恢复。**以后不要通过 bridge 调用任何会弹窗的交互式菜单** |

---

## 6. 卸载（如需）

- 从 `<项目>/Packages/manifest.json` 的 `dependencies` 删除 `com.yd.unitybridge`
  （及其不再需要的依赖 `com.coplaydev.unity-mcp`）。
- 或运行仓库 `uninstall.ps1 -UnityProject <项目>`。
