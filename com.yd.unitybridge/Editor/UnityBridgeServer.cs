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
            for (var attempt = 0; attempt < PortAttempts; attempt++)
            {
                var port = DefaultPort + attempt;
                var ok = TryStartOnPort(port, out lastError);
                if (ok) return true;

                // 非端口占用异常（权限、系统错误等）没有顺延意义，立即中止。
                if (!IsPortInUse(lastError)) break;
            }

            Debug.LogWarning($"[UnityBridge] 启动失败：端口 {DefaultPort}~{DefaultPort + PortAttempts - 1} 均被占用（最后一次错误：{lastError?.Message}）。" +
                             "请关闭占用这些端口的程序后重试，或重启 Unity 编辑器。");
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

        private static Task<object> RunOnMain(Func<object> action)
        {
            var item = new WorkItem { Action = action };
            MainQueue.Enqueue(item);
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

            // 编译错误：形如 "error CS..." 的日志条目。
            var compileErrors = snapshot
                .Where(l => l.level == "error" && l.message != null && l.message.Contains("error CS"))
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
            if (className == "__menu")
            {
                EditorApplication.ExecuteMenuItem(methodName);
                return new { executed = true, result = $"menu item invoked: {methodName}" };
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
            return new { executed = true, result = result == null ? "null" : result.ToString() };
        }

        private static object DoOpenScene(JObject args)
        {
            var path = args["path"]?.Value<string>();
            if (string.IsNullOrWhiteSpace(path))
                throw new Exception("scene/open 需要 path");

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

        // /mcp/catalog：反射枚举所有 [McpForUnityTool] 工具清单（名称 + 描述 + 分组）。
        private static object GetMcpCatalog()
        {
            var list = new List<McpToolInfo>();
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type[] types;
                try { types = assembly.GetTypes(); }
                catch { continue; }

                foreach (var type in types)
                {
                    var attr = type.GetCustomAttribute<McpForUnityToolAttribute>();
                    if (attr == null) continue;

                    var method = type.GetMethod("HandleCommand",
                        BindingFlags.Public | BindingFlags.Static,
                        null, new[] { typeof(JObject) }, null);
                    if (method == null) continue;

                    list.Add(new McpToolInfo
                    {
                        tool = string.IsNullOrEmpty(attr.Name) ? ToSnakeCase(type.Name) : attr.Name,
                        type = type.FullName,
                        description = attr.Description,
                        group = attr.Group,
                    });
                }
            }

            return new
            {
                count = list.Count,
                tools = list.OrderBy(t => t.tool).Select(t => new
                {
                    t.tool,
                    t.type,
                    t.description,
                    t.group,
                }).ToList(),
            };
        }

        private sealed class McpToolInfo
        {
            public string tool;
            public string type;
            public string description;
            public string group;
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
            return Convert.ChangeType(value, underlying);
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
