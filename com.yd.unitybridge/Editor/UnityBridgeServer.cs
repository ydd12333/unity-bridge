// 作者: ydd12333
//
// Unity Bridge —— 常驻本地 HTTP 服务（127.0.0.1:8321，占用自动顺延）。
// 让 DSH（或任意 HTTP 客户端）控制 Unity 编辑器：编译、刷新资产、
// 读取 Console 日志与编译错误、执行编辑器静态方法、打开场景、查询资源。
//
// 端口固定 + 占用顺延（支持同时打开多个 Unity 实例）：
//   首选端口 = DefaultPort(8321)。固定端口避免哈希派生撞上 Windows 动态
//   端口排除区（Hyper-V/WSL2/Docker 保留段）导致整段端口不可用。
//   首选端口被占用时自动顺延（最多 PortAttempts 个端口），因此同一项目
//   多实例、或端口被其他程序占用时都能启动成功。
//   实际监听端口写入 <项目根>/Library/UnityBridgePort.txt（git 忽略），
//   DSH 侧优先读该文件动态发现端口；读不到时回退固定端口 DefaultPort。
//   /health 额外返回项目路径供 DSH 做交叉校验兜底。
//
// 设计要点：
//  - HttpListener 后台线程接收请求，Unity Editor API 一律通过主线程队列执行，
//    避免跨线程调用 Unity API。
//  - 编译操作采用「触发 + 轮询」模型：请求立即返回，不阻塞等待编译结束，
//    因为编译成功可能触发 domain reload（重建本服务），阻塞等待会导致响应中断。
//    客户端（DSH 插件）随后轮询 /health 直到 compiling == false，再读 /logs 拿错误。

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using MCPForUnity.Editor.Tools;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEditor.SceneManagement;
using UnityEngine;

namespace UnityBridge
{
    [InitializeOnLoad]
    public static class UnityBridgeServer
    {
        public const string Host = "127.0.0.1";
        // 固定监听端口：不再按项目路径哈希派生，避免哈希结果撞上 Windows
        // 动态端口排除区（Hyper-V/WSL2/Docker 保留段）导致整段端口不可用。
        public const int DefaultPort = 8321;

        // 本项目的项目根绝对路径（规范化后），用于 /health 校验与端口文件路径。
        private static readonly string ProjectRoot = GetProjectRoot();
        private static readonly string ProjectPath = NormalizePath(ProjectRoot);

        // 端口占用自动顺延：从固定端口起逐个尝试，最多试 PortAttempts 个。
        private const int PortAttempts = 256;
        // 实际监听端口（顺延后的结果），启动成功后被 /health 与端口文件使用。
        private static int _listenPort;
        // 服务启动时刻（UTC），随 /health 返回，供 DSH 侧确认实例是否为会话期新启动。
        private static readonly string StartTimeUtc = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'");
        // 实际端口写入 Library/UnityBridgePort.txt，供 DSH 侧动态发现。
        private static readonly string PortFile = Path.Combine(ProjectRoot, "Library", "UnityBridgePort.txt");

        // 日志环形缓冲，主线程写入，读取时加锁快照。
        private const int MaxLogCount = 500;
        private static readonly List<LogEntry> Logs = new List<LogEntry>();
        private static readonly object LogLock = new object();

        // HTTP 后台线程投递、EditorApplication.update 消费的主线程队列。
        private static readonly ConcurrentQueue<WorkItem> MainQueue = new ConcurrentQueue<WorkItem>();

        // 与 MainQueue 类似，但承载返回 Task<object> 的工厂（用于 MCP async 命令），
        // 在主线程启动异步调用后立即返回其 Task，不阻塞主线程。
        private static readonly ConcurrentQueue<AsyncWorkItem> MainAsyncQueue = new ConcurrentQueue<AsyncWorkItem>();

        private static HttpListener _listener;
        private static CancellationTokenSource _cts;
        private static volatile bool _running;

        static UnityBridgeServer()
        {
            Start();
        }

        // ── 启动 / 停止 ──────────────────────────────────────────────────────

        public static bool IsRunning => _running;

        public static int Port => _listenPort > 0 ? _listenPort : DefaultPort;

        public static bool Start()
        {
            if (_running) return true;

            var lastError = (Exception)null;
            var lastAttemptPort = 0;
            // 提前中止（非端口占用错误）：true 时不是“全部端口都被占”，而是首个失败端口即不可顺延。
            var abortedEarly = false;
            for (var attempt = 0; attempt < PortAttempts; attempt++)
            {
                var port = DefaultPort + attempt;
                var ok = TryStartOnPort(port, out lastError);
                if (ok) return true;
                lastAttemptPort = port;

                // 非端口占用异常（权限、系统错误等）没有顺延意义，立即中止。
                if (!IsPortInUse(lastError))
                {
                    abortedEarly = true;
                    break;
                }
            }

            // 按失败原因给出准确提示，避免一律误报“所有端口均被占用”。
            if (abortedEarly)
            {
                // 非端口占用错误（未命中 10013/32）：更换端口不会解决，
                // 列出异常类型、可能的根因与各自解决途径，并附微软官方文档。
                Debug.LogWarning($"[UnityBridge] 启动失败：在端口 {lastAttemptPort} 上遇到非端口占用错误：{lastError?.GetType().Name}: {lastError?.Message}\n" +
                                 "该类错误与端口是否空闲无关，更换端口不会解决。请按下面方向排查：\n" +
                                 "  ① 权限问题（UnauthorizedAccessException / ErrorCode 5 等）：确认当前 Windows 用户对监听地址有访问权，\n" +
                                 "     一般无需配置；若改动过 URL 前缀 ACL，可用 netsh http show urlacl 检查。官方参考：\n" +
                                 "     https://learn.microsoft.com/en-us/windows/win32/http/add-urlacl\n" +
                                 "  ② 系统资源/网络栈问题（句柄耗尽、端口保留段被 Hyper-V/WSL2/Docker 占用等）：\n" +
                                 "     检查 Windows 动态端口排除区是否覆盖了 8321~8576：netsh int ipv4 show excludedportrange protocol=tcp\n" +
                                 "     官方排查手册：https://learn.microsoft.com/en-us/troubleshoot/windows-client/networking/tcp-ip-port-exhaustion-troubleshooting\n" +
                                 "  ③ 若为防火墙/杀软拦截：放行 127.0.0.1 本地回环监听后重试。");
            }
            else if (WinErrorCode(lastError) == 32)
            {
                // ERROR_SHARING_VIOLATION：共享冲突——常见于同一地址已被另一实例/残留句柄独占，
                // 与普通端口占用（10013）的解决方向不同，单独提示。
                Debug.LogWarning($"[UnityBridge] 启动失败：端口 {DefaultPort}~{DefaultPort + PortAttempts - 1} 均被占用，且最后一次为共享冲突（ErrorCode 32，ERROR_SHARING_VIOLATION）：{lastError?.Message}\n" +
                                 "共享冲突通常是“同一地址已存在另一个监听者”，请按下面方向排查：\n" +
                                 "  ① 检查是否有其它 Unity 编辑器实例在跑（每个实例都会从 8321 起顺延占用端口，\n" +
                                 "     同项目多实例还会互相覆盖端口文件）；确认后关闭多余实例重试；\n" +
                                 "  ② 也可能是上次退出未释放的残留监听（服务异常退出导致句柄未释放），重启 Unity 编辑器即可；\n" +
                                 "  ③ 仍不行再查占用进程：netstat -ano | findstr 8321，再 taskkill /PID <PID> /F。");
            }
            else
            {
                // 10013（WSAEACCES）等：最典型是端口确实被其他进程占用，或 URL ACL 拒绝绑定。
                Debug.LogWarning($"[UnityBridge] 启动失败：端口 {DefaultPort}~{DefaultPort + PortAttempts - 1} 均被占用（最后一次错误码 {WinErrorCode(lastError)}：{lastError?.Message}）。\n" +
                                 "请按下面方向排查：\n" +
                                 "  ① 找出占用端口的进程并结束：netstat -ano | findstr 8321，再 taskkill /PID <PID> /F；\n" +
                                 "     若 8321 空闲但 8322~8576 被占，把 8321 换成对应最小编号的占用端口再查；\n" +
                                 "  ② 若端口段被 Windows 动态端口保留区占满（Hyper-V/WSL2/Docker 会保留整段端口）：\n" +
                                 "     netsh int ipv4 show excludedportrange protocol=tcp 查看保留段，必要时重启以刷新保留表；\n" +
                                 "  ③ 也可重启 Unity 编辑器重试（服务随编辑器启动自动顺延）。");
            }
            Stop();
            return false;
        }

        // HttpListener 在端口被占用时抛 HttpListenerException（ErrorCode 为
        // ERROR_ACCESS_DENIED 10013 或 ERROR_SHARING_VIOLATION 32）。
        private static bool IsPortInUse(Exception ex)
        {
            return ex is HttpListenerException hle &&
                   (hle.ErrorCode == 10013 || hle.ErrorCode == 32);
        }

        // 取 Windows 原生错误码（HttpListenerException.ErrorCode 即 Win32 码）；
        // 非 HttpListenerException 时返回 -1，用于区分“端口占用”与“其它错误”。
        private static int WinErrorCode(Exception ex)
        {
            return (ex as HttpListenerException)?.ErrorCode ?? -1;
        }

        // 尝试在指定端口启动监听；成功则写端口文件并挂接日志/更新回调。
        private static bool TryStartOnPort(int port, out Exception error)
        {
            error = null;
            try
            {
                _cts = new CancellationTokenSource();
                _listener = new HttpListener();
                _listener.Prefixes.Add($"http://{Host}:{port}/");
                _listener.Start();
                _listenPort = port;
                _running = true;

                Application.logMessageReceived += OnLogReceived;
                EditorApplication.update += OnEditorUpdate;

                var thread = new Thread(ListenLoop) { IsBackground = true, Name = "UnityBridgeServer" };
                thread.Start();

                WritePortFile(port);
                Debug.Log($"[UnityBridge] 已启动，监听 http://{Host}:{port}/ （项目 {ProjectPath}，窗口: Tools/Unity Bridge）");
                return true;
            }
            catch (Exception ex)
            {
                error = ex;
                // 释放本次尝试占用的资源，继续尝试下一个端口。
                try { _cts?.Cancel(); } catch { }
                try { _listener?.Close(); } catch { }
                _listener = null;
                _cts = null;
                _running = false;
                return false;
            }
        }

        // 把实际监听端口写入 Library/UnityBridgePort.txt（Library 已被 git 忽略，不进版本库）。
        // 先写临时文件再原子替换，避免 DSH 侧读到写入一半的内容。
        private static void WritePortFile(int port)
        {
            try
            {
                var dir = Path.GetDirectoryName(PortFile);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                var tmp = PortFile + ".tmp";
                File.WriteAllText(tmp, port.ToString());
                // .NET Framework 的 File.Move 无 overwrite 参数：先删旧文件再移动。
                if (File.Exists(PortFile)) File.Delete(PortFile);
                File.Move(tmp, PortFile);
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[UnityBridge] 写入端口文件失败（{PortFile}）：{ex.Message}");
            }
        }

        public static void Stop()
        {
            if (!_running && _listener == null) return;

            try { _cts?.Cancel(); } catch { }
            try { _listener?.Close(); } catch { }
            _listener = null;
            _cts = null;
            _running = false;

            Application.logMessageReceived -= OnLogReceived;
            EditorApplication.update -= OnEditorUpdate;
            _listenPort = 0;
            DeletePortFile();
            Debug.Log("[UnityBridge] 已停止");
        }

        private static void DeletePortFile()
        {
            try
            {
                if (File.Exists(PortFile)) File.Delete(PortFile);
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[UnityBridge] 删除端口文件失败（{PortFile}）：{ex.Message}");
            }
        }

        // ── HTTP 接收循环 ────────────────────────────────────────────────────

        private static void ListenLoop()
        {
            while (_running)
            {
                HttpListenerContext context;
                try
                {
                    context = _listener.GetContext();
                }
                catch
                {
                    break; // listener 已关闭
                }

                // 每个请求一个后台任务，互不阻塞。
                _ = Task.Run(() => HandleRequest(context));
            }
        }

        private static async Task HandleRequest(HttpListenerContext context)
        {
            try
            {
                var request = context.Request;
                var method = request.HttpMethod;
                var path = (request.Url.AbsolutePath ?? "/").TrimEnd('/');

                // 读取并限制请求体大小。
                string body = null;
                if (request.ContentLength64 > 0)
                {
                    if (request.ContentLength64 > 1024 * 1024)
                        throw new Exception("request body too large");
                    using var reader = new StreamReader(request.InputStream, Encoding.UTF8);
                    body = await reader.ReadToEndAsync();
                }

                var data = await Dispatch(method, path, body);
                await WriteJson(context, 200, new { ok = true, data });
            }
            catch (Exception ex)
            {
                await WriteJson(context, 500, new { ok = false, error = ex.Message });
            }
        }

        private static async Task WriteJson(HttpListenerContext context, int status, object payload)
        {
            var json = JsonConvert.SerializeObject(payload, Formatting.None);
            var bytes = Encoding.UTF8.GetBytes(json);
            context.Response.StatusCode = status;
            context.Response.ContentType = "application/json; charset=utf-8";
            context.Response.ContentLength64 = bytes.Length;
            context.Response.AddHeader("Access-Control-Allow-Origin", "*");
            await context.Response.OutputStream.WriteAsync(bytes, 0, bytes.Length);
            context.Response.Close();
        }

        // ── 路由分发 ─────────────────────────────────────────────────────────

        private static Task<object> Dispatch(string method, string path, string body)
        {
            var args = string.IsNullOrEmpty(body) ? new JObject() : JObject.Parse(body);

            switch (path)
            {
                case "/health":     return RunOnMain(() => GetHealth());
                case "/compile":    return RunOnMain(() => DoCompile());
                case "/refresh":    return RunOnMain(() => DoRefresh());
                case "/logs":       return RunOnMain(() => GetLogs(args));
                case "/execute":    return RunOnMain(() => DoExecute(args));
                case "/scene/open": return RunOnMain(() => DoOpenScene(args));
                case "/asset/get":  return RunOnMain(() => DoGetAsset(args));
                case "/mcp":        return RunMcp(args);
                case "/mcp/catalog": return RunOnMain(() => GetMcpCatalog());
                default:            throw new Exception($"unknown endpoint: {path}");
            }
        }

        // ── 主线程执行辅助 ───────────────────────────────────────────────────
        //
        // 借鉴团结 AI（CodelyBridge / InvokeOnMainThreadWithTimeout）的防卡死设计：
        // 主线程调度不设无限期等待。若 Unity 主线程被模态对话框 / 长任务 / 编译
        // 阻塞，OnEditorUpdate 不会消费 MainQueue，此时给 HTTP 端一个确定的超时
        // 错误响应（而非永久挂起），让 DSH 侧能快速失败并给出诊断指引。
        private const int MainThreadTimeoutMs = 15000;

        private static Task<object> RunOnMain(Func<object> action)
        {
            var item = new WorkItem { Action = action };
            MainQueue.Enqueue(item);
            // 超时兜底：主线程队列迟迟不被消费时，返回错误响应而不是让 HTTP 线程无限等。
            _ = ScheduleTimeout(item, MainThreadTimeoutMs, "Unity 主线程无响应");
            return item.Completion.Task;
        }

        private static void OnEditorUpdate()
        {
            while (MainQueue.TryDequeue(out var item))
            {
                try
                {
                    item.Completion.TrySetResult(item.Action());
                }
                catch (Exception ex)
                {
                    item.Completion.TrySetException(ex);
                }
            }

            while (MainAsyncQueue.TryDequeue(out var item))
            {
                try
                {
                    item.Completion.TrySetResult(item.Factory());
                }
                catch (Exception ex)
                {
                    item.Completion.TrySetException(ex);
                }
            }
        }

        private sealed class WorkItem
        {
            public Func<object> Action;
            public readonly TaskCompletionSource<object> Completion =
                new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
        }

        private sealed class AsyncWorkItem
        {
            public Func<Task<object>> Factory;
            public readonly TaskCompletionSource<Task<object>> Completion =
                new TaskCompletionSource<Task<object>>(TaskCreationOptions.RunContinuationsAsynchronously);
        }

        // 超时兜底：主线程队列项在 timeoutMs 内未被消费时，用错误结果完成其 TCS。
        // 仅当 TCS 尚未完成时生效（TrySet 幂等），任务迟到的正常完成会被忽略。
        private static async Task ScheduleTimeout(WorkItem item, int timeoutMs, string reason)
        {
            await Task.Delay(timeoutMs).ConfigureAwait(false);
            item.Completion.TrySetException(new TimeoutException(
                $"{reason}（等待主线程队列超过 {timeoutMs / 1000}s）。可能原因：Unity 主线程被模态对话框阻塞、正在执行长任务（构建/烘焙/编译）、或编辑器已卡死。请到 Unity 窗口检查。"));
        }

        private static async Task ScheduleTimeout(AsyncWorkItem item, int timeoutMs, string reason)
        {
            await Task.Delay(timeoutMs).ConfigureAwait(false);
            item.Completion.TrySetException(new TimeoutException(
                $"{reason}（等待主线程队列超过 {timeoutMs / 1000}s）。可能原因：Unity 主线程被模态对话框阻塞、正在执行长任务（构建/烘焙/编译）、或编辑器已卡死。请到 Unity 窗口检查。"));
        }

        // ── 日志收集 ─────────────────────────────────────────────────────────

        private static void OnLogReceived(string condition, string stackTrace, LogType type)
        {
            lock (LogLock)
            {
                Logs.Add(new LogEntry
                {
                    time = DateTime.Now.ToString("HH:mm:ss"),
                    level = type.ToString().ToLowerInvariant(),
                    message = condition,
                    stack = stackTrace,
                });
                if (Logs.Count > MaxLogCount) Logs.RemoveAt(0);
            }
        }

        // ── 命令实现（全部运行在主线程）────────────────────────────────────

        private static object GetHealth()
        {
            return new
            {
                running = true,
                compiling = EditorApplication.isCompiling,
                updating = EditorApplication.isUpdating,
                project = Application.productName,
                unityVersion = Application.unityVersion,
                port = Port,
                projectPath = ProjectPath,
                // 进程标识与启动时间：多实例场景下帮助 DSH 侧区分连的是哪个 Unity 实例。
                pid = System.Diagnostics.Process.GetCurrentProcess().Id,
                startTimeUtc = StartTimeUtc,
            };
        }

        private static object DoCompile()
        {
            // 触发脚本编译，立即返回；结果由客户端轮询 /health + /logs 获得。
            // 编译成功且脚本变化时可能触发 domain reload，本服务会被重建。
            CompilationPipeline.RequestScriptCompilation();
            return new { accepted = true, wasCompiling = EditorApplication.isCompiling };
        }

        private static object DoRefresh()
        {
            EnsureWriteSafe("refresh", "刷新资源数据库");
            AssetDatabase.Refresh(ImportAssetOptions.ForceUpdate);
            return new { accepted = true };
        }

        private static object GetLogs(JObject args)
        {
            var limit = args["limit"]?.Value<int>() ?? 200;
            var level = (args["level"]?.Value<string>() ?? "all").ToLowerInvariant();
            if (limit < 1) limit = 1;
            if (limit > MaxLogCount) limit = MaxLogCount;

            List<LogEntry> snapshot;
            lock (LogLock) { snapshot = new List<LogEntry>(Logs); }

            if (level != "all")
            {
                snapshot = snapshot.Where(l => l.level == level).ToList();
            }

            var tail = snapshot.Skip(Math.Max(0, snapshot.Count - limit)).ToList();

            // 编译错误：优先匹配 Unity 编译条目（"error CS..." / "error XXXX..." / "error URG..." 等），
            // 兜底匹配 level==error 且非本服务自身日志的条目，避免遗漏 shader/资源编译错误。
            var compileErrors = snapshot
                .Where(l => l.level == "error" && l.message != null
                    && !l.message.StartsWith("[UnityBridge]", StringComparison.Ordinal)
                    && (l.message.Contains("error CS")
                        || l.message.Contains("error URG")
                        || l.message.Contains("error BC")
                        || l.message.Contains("error LIT")
                        || l.message.Contains("error X")
                        || l.message.Contains("Compilation failed")
                        || l.message.Contains("Failed to compile")))
                .Select(l => l.message)
                .ToList();

            return new
            {
                total = tail.Count,
                logs = tail,
                compileErrors,
            };
        }

        private static object DoExecute(JObject args)
        {
            var className = args["className"]?.Value<string>();
            var methodName = args["methodName"]?.Value<string>();
            if (string.IsNullOrWhiteSpace(className) || string.IsNullOrWhiteSpace(methodName))
                throw new Exception("execute 需要 className 与 methodName");

            // 特殊通道：className == "__menu" 时，methodName 为 Unity 菜单路径。
            // Play/Pause 模式下拦截菜单执行（弹窗/运行态修改会破坏编辑器状态）。
            if (className == "__menu")
            {
                EnsureWriteSafe("execute_menu", $"执行菜单 {methodName}");
                EditorApplication.ExecuteMenuItem(methodName);
                return new { executed = true, result = $"menu item invoked: {methodName}" };
            }
            // 反射静态方法：仅对已知破坏性类型做写保护（EditorApplication/SceneManagement 等）。
            if (IsDestructiveType(className))
            {
                EnsureWriteSafe("execute_reflect", $"执行 {className}.{methodName}");
            }

            var type = FindType(className)
                ?? throw new Exception($"未找到类型: {className}");

            var rawArgs = args["args"] as JArray;
            var stringArgs = rawArgs == null
                ? Array.Empty<string>()
                : rawArgs.Select(t => t.Value<string>()).ToArray();

            var methods = type.GetMethods(
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.FlattenHierarchy)
                .Where(m => m.Name == methodName)
                .ToList();

            if (methods.Count == 0)
                throw new Exception($"未找到静态方法: {className}.{methodName}");

            MethodInfo method = null;
            object[] invokeArgs = null;
            Exception lastError = null;

            foreach (var candidate in methods)
            {
                var parameters = candidate.GetParameters();
                if (parameters.Length != stringArgs.Length) continue;

                try
                {
                    if (parameters.Length == 0)
                    {
                        method = candidate;
                        invokeArgs = null;
                        break;
                    }
                    var converted = new object[parameters.Length];
                    for (var i = 0; i < parameters.Length; i++)
                    {
                        converted[i] = ConvertArg(stringArgs[i], parameters[i].ParameterType);
                    }
                    method = candidate;
                    invokeArgs = converted;
                    break;
                }
                catch (Exception ex)
                {
                    lastError = ex;
                }
            }

            if (method == null)
            {
                throw new Exception(
                    $"参数数量/类型不匹配：{methodName} 的 {methods.Count} 个重载均无法匹配 {stringArgs.Length} 个参数" +
                    (lastError != null ? $"（{lastError.Message}）" : ""));
            }

            var result = method.Invoke(null, invokeArgs);
            return new { executed = true, result = FormatInvokeResult(result) };
        }

        // 把反射执行结果格式化为可供 AI 使用的信息：
        //  - 数组/集合/字典 → 序列化为 JSON（限量 500 项，标注 total/hasMore），避免 ToString 只给类型名；
        //  - UnityEngine.Object → 返回类型/名称/路径/GUID；
        //  - 其余简单值 → ToString。
        private static object FormatInvokeResult(object result)
        {
            if (result == null) return "null";

            if (result is UnityEngine.Object unityObj)
            {
                var path = AssetDatabase.GetAssetPath(unityObj);
                var guid = string.IsNullOrEmpty(path) ? "" : AssetDatabase.AssetPathToGUID(path);
                return new
                {
                    type = unityObj.GetType().FullName,
                    name = unityObj.name,
                    path,
                    guid,
                };
            }

            if (result is System.Collections.IEnumerable seq && !(result is string))
            {
                var list = new List<object>();
                var max = 500;
                var hasMore = false;
                foreach (var item in seq)
                {
                    if (list.Count >= max)
                    {
                        hasMore = true;
                        break;
                    }
                    list.Add(FormatScalarForJson(item));
                }
                return new
                {
                    type = result.GetType().FullName,
                    count = list.Count,
                    truncated = hasMore,
                    items = list,
                };
            }

            return result.ToString();
        }

        // 集合元素常规化：避免元素本身是复杂对象时 ToString 丢失信息。
        private static object FormatScalarForJson(object item)
        {
            if (item == null) return null;
            if (item is UnityEngine.Object uo)
            {
                var p = AssetDatabase.GetAssetPath(uo);
                return new { type = uo.GetType().FullName, name = uo.name, path = p };
            }
            if (item.GetType().IsPrimitive || item is string || item is decimal || item is DateTime)
                return item;
            return item.ToString();
        }

        private static object DoOpenScene(JObject args)
        {
            var path = args["path"]?.Value<string>();
            if (string.IsNullOrWhiteSpace(path))
                throw new Exception("scene/open 需要 path");

            EnsureWriteSafe("scene_open", $"打开场景 {path}");

            var scene = EditorSceneManager.OpenScene(path, OpenSceneMode.Single);
            return new { opened = scene.IsValid(), path = scene.path, name = scene.name };
        }

        private static object DoGetAsset(JObject args)
        {
            var path = args["path"]?.Value<string>();
            var guid = args["guid"]?.Value<string>();

            if (string.IsNullOrWhiteSpace(path) && !string.IsNullOrWhiteSpace(guid))
            {
                path = AssetDatabase.GUIDToAssetPath(guid);
            }
            if (string.IsNullOrWhiteSpace(path))
                throw new Exception("asset/get 需要 path 或 guid");

            var asset = AssetDatabase.LoadAssetAtPath<UnityEngine.Object>(path);
            if (asset == null)
                throw new Exception($"资源不存在或无法加载: {path}");

            var resolvedGuid = AssetDatabase.AssetPathToGUID(path);
            var dependencies = AssetDatabase.GetDependencies(path, false);

            return new
            {
                path,
                guid = resolvedGuid,
                type = asset.GetType().FullName,
                name = asset.name,
                dependencies,
            };
        }

        // ── MCP for Unity 桥接 ───────────────────────────────────────────────
        //
        // 复用项目已安装的 com.coplaydev.unity-mcp 包的全部编辑器工具（约 30 个，
        // 覆盖资源/场景/GameObject/组件/脚本/构建/测试/材质/UI/包管理等）。
        // 不复制其代码，直接调用其 CommandRegistry（public static）统一路由，
        // 随包升级自动获得新工具。

        // /mcp：执行任意 MCP 工具。body = { tool, params: {...} }。
        private static async Task<object> RunMcp(JObject args)
        {
            var tool = args["tool"]?.Value<string>();
            if (string.IsNullOrWhiteSpace(tool))
                throw new Exception("mcp 需要 tool");

            var parameters = args["params"] as JObject ?? new JObject();

            // 关键：MCP 命令必须在 Unity 主线程执行。先调度到主线程“发起”调用，
            // 其异步部分依赖 Unity 的同步上下文延续，从而保证全程主线程安全。
            var resultTask = await RunOnMainAsync(() => StartMcpInvoke(tool, parameters));
            object result;
            try
            {
                result = await resultTask;
            }
            catch (Exception ex)
            {
                var inner = ex;
                while (inner is System.Reflection.TargetInvocationException tie && tie.InnerException != null)
                    inner = tie.InnerException;
                throw new Exception($"MCP 工具 {tool} 执行失败: {inner.Message}", inner);
            }

            return NormalizeMcpResult(tool, result);
        }

        // 在主线程启动 InvokeCommandAsync 并返回其 Task；不 await，避免阻塞主线程。
        private static Task<object> StartMcpInvoke(string tool, JObject parameters)
        {
            return CommandRegistry.InvokeCommandAsync(tool, parameters);
        }

        // 在主线程调度一个返回 Task 的工厂，通过 TCS 桥接给 HTTP 线程 await。
        private static Task<Task<object>> RunOnMainAsync(Func<Task<object>> factory)
        {
            var item = new AsyncWorkItem { Factory = factory };
            MainAsyncQueue.Enqueue(item);
            // MCP 工具耗时可能较长（构建/测试），超时放宽到 30s；
            // 主线程完全卡死（Modal/长任务）时仍会兜底报错而非无限等。
            _ = ScheduleTimeout(item, 30000, "MCP 调用无法在主线程启动");
            return item.Completion.Task;
        }

        private static object NormalizeMcpResult(string tool, object result)
        {
            // 统一响应形状：{ success, data } 或 { success, error }。
            if (result == null)
            {
                return new { success = true, tool, data = (object)null };
            }

            // SuccessResponse / ErrorResponse 是 MCPForUnity.Editor.Helpers 的 public 类型。
            if (result is MCPForUnity.Editor.Helpers.SuccessResponse sr)
            {
                return new { success = true, tool, message = sr.Message, data = sr.Data };
            }
            if (result is MCPForUnity.Editor.Helpers.ErrorResponse er)
            {
                return new { success = false, tool, error = er.Error, code = er.Code, data = er.Data };
            }
            if (result is MCPForUnity.Editor.Helpers.PendingResponse pr)
            {
                return new { success = true, tool, pending = true, message = pr.Message, data = pr.Data };
            }

            // 兜底：其它返回类型直接透传（由 Newtonsoft 序列化）。
            return new { success = true, tool, data = result };
        }

        // /mcp/catalog：复用 MCP 包的 ToolDiscoveryService（MCPServiceLocator）枚举全部工具，
        // 返回完整元数据：名称、描述（含 "Tool: xxx" 回退）、分组、以及每个参数的
        // 名称/类型/是否必填/默认值——解决「catalog 描述全 null、AI 只能靠试错猜参数」的问题。
        // 注意：该服务在首次调用时反射全程序集，可能耗时数百 ms，属一次性成本（有缓存）。
        private static object GetMcpCatalog()
        {
            List<MCPForUnity.Editor.Services.ToolMetadata> tools;
            try
            {
                tools = MCPForUnity.Editor.Services.MCPServiceLocator.ToolDiscovery.DiscoverAllTools();
            }
            catch (Exception ex)
            {
                // 防御：MCP 包版本差异导致找不到服务时，回退到轻量反射（名称+分组，无参数）。
                return new
                {
                    count = -1,
                    fallback = true,
                    error = ex.Message,
                    tools = GetMcpCatalogLight(),
                };
            }

            return new
            {
                count = tools?.Count ?? 0,
                tools = (tools ?? new List<MCPForUnity.Editor.Services.ToolMetadata>())
                    .OrderBy(t => t.Name)
                    .Select(t => new
                    {
                        tool = t.Name,
                        description = string.IsNullOrEmpty(t.Description) ? $"Tool: {t.Name}" : t.Description,
                        group = t.Group,
                        structuredOutput = t.StructuredOutput,
                        requiresPolling = t.RequiresPolling,
                        pollAction = t.PollAction,
                        parameters = (t.Parameters ?? new List<MCPForUnity.Editor.Services.ParameterMetadata>())
                            .OrderByDescending(p => p.Required)
                            .ThenBy(p => p.Name)
                            .Select(p => new
                            {
                                name = p.Name,
                                type = p.Type,
                                required = p.Required,
                                description = p.Description,
                                defaultValue = p.DefaultValue,
                            }).ToList(),
                    }).ToList(),
            };
        }

        // 轻量回退：仅反射 attribute（名称 + 类型 + 分组），无参数信息。
        private static List<object> GetMcpCatalogLight()
        {
            var list = new List<object>();
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type[] types;
                try { types = assembly.GetTypes(); }
                catch { continue; }

                foreach (var type in types)
                {
                    var attr = type.GetCustomAttribute<McpForUnityToolAttribute>();
                    if (attr == null) continue;

                    list.Add(new
                    {
                        tool = string.IsNullOrEmpty(attr.Name) ? ToSnakeCase(type.Name) : attr.Name,
                        type = type.FullName,
                        description = attr.Description,
                        group = attr.Group,
                    });
                }
            }
            return list;
        }

        private static string ToSnakeCase(string name)
        {
            var sb = new StringBuilder();
            for (var i = 0; i < name.Length; i++)
            {
                var c = name[i];
                if (char.IsUpper(c))
                {
                    if (i > 0) sb.Append('_');
                    sb.Append(char.ToLowerInvariant(c));
                }
                else
                {
                    sb.Append(c);
                }
            }
            return sb.ToString();
        }

        // ── 写保护（WriteGuard 简化版，借鉴团结 AI CodelyBridge）──
        //
        // 在 Play/Pause 模式下拦截破坏性写操作：
        //  - execute 菜单路径（弹窗/运行态修改会破坏编辑器状态）
        //  - 已知破坏性的反射类型（编辑器生命周期 / 场景 / 资产导入）
        //  - scene/open 与 refresh（会替换当前场景 / 触发重新导入）
        // MCP 工具的写 action 由 MCP 包内部自行防护（其 WriteGuard 已有 18 处
        // EditorApplication.isPlaying 检查），这里只做本服务自带端点的兜底。

        private static bool IsInPlayMode =>
            EditorApplication.isPlaying || EditorApplication.isPaused;

        private static void EnsureWriteSafe(string op, string detail)
        {
            if (IsInPlayMode)
            {
                throw new InvalidOperationException(
                    $"已拒绝在播放模式下执行写操作 [{op}]：{detail}。请先停止播放（ManageEditor stop / Unity 编辑器 Play 按钮），再重试。");
            }
        }

        // 已知破坏性的反射目标类型：这些类型的静态方法会改动编辑器/场景/资产状态，
        // 在播放模式下一律拦截；其余只读查询类型（AssetDatabase 查询、Application 等）放行。
        private static readonly HashSet<string> DestructiveTypes = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "UnityEditor.EditorApplication",
            "UnityEditor.SceneManagement.EditorSceneManager",
            "UnityEditor.AssetDatabase",
            "UnityEditor.Compilation.CompilationPipeline",
            "UnityEngine.SceneManagement.SceneManager",
            "UnityEditor.Lightmapping",
            "UnityEditor.AudioImporter",
            "UnityEditor.EditorBuildSettings",
        };

        private static bool IsDestructiveType(string className)
        {
            if (string.IsNullOrEmpty(className)) return false;
            // 命中精确类型名或命名空间前缀（如 UnityEditor.SceneManagement.* 整个都是破坏性的）
            if (DestructiveTypes.Contains(className)) return true;
            foreach (var dangerous in DestructiveTypes)
            {
                if (className.StartsWith(dangerous + ".", StringComparison.OrdinalIgnoreCase))
                    return true;
            }
            return false;
        }

        // ── 工具方法 ─────────────────────────────────────────────────────────

        // 编辑器下 Application.dataPath = "<项目根>/Assets"，取父目录即项目根。
        private static string GetProjectRoot()
        {
            try
            {
                return Path.GetDirectoryName(Application.dataPath);
            }
            catch
            {
                return Directory.GetCurrentDirectory();
            }
        }

        // 与 DSH 侧保持一致的路径规范化：统一反斜杠、去尾分隔符、仅 ASCII 小写
        //（手动 ASCII 小写，避免 .NET 与 JS 的 Unicode 大小写表差异导致端口不一致）。
        private static string NormalizePath(string path)
        {
            if (string.IsNullOrEmpty(path)) return "";
            var chars = path.Replace('/', '\\').TrimEnd('\\').ToCharArray();
            for (var i = 0; i < chars.Length; i++)
            {
                var c = chars[i];
                if (c >= 'A' && c <= 'Z') chars[i] = (char)(c + 32);
            }
            return new string(chars);
        }

        private static Type FindType(string className)
        {
            var type = Type.GetType(className);
            if (type != null) return type;

            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                type = assembly.GetType(className, false);
                if (type != null) return type;
            }
            return null;
        }

        private static object ConvertArg(string value, Type target)
        {
            if (target == typeof(string)) return value;
            if (target.IsEnum) return Enum.Parse(target, value);

            var underlying = Nullable.GetUnderlyingType(target) ?? target;
            // 显式使用 InvariantCulture 转换数值：避免中文/欧洲系统区域性
            //（如小数分隔符为 ','）导致 "1.5" 解析失败。
            return Convert.ChangeType(value, underlying, System.Globalization.CultureInfo.InvariantCulture);
        }

        [Serializable]
        public class LogEntry
        {
            public string time;
            public string level;
            public string message;
            public string stack;
        }
    }
}
