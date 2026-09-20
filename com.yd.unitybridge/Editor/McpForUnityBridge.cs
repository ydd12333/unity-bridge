// 作者: ydd12333
//
// MCP for Unity（com.coplaydev.unity-mcp）反射桥接层。
//
// 为什么用反射，而不是直接引用 MCP 的类型：
//   UPM 不支持「包与包之间的 Git 依赖」——Git URL 只能写在项目的
//   Packages/manifest.json，不能写在某个包的 package.json 里。之前的实现
//   在 package.json 里写了
//     "com.coplaydev.unity-mcp": "https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity#main"
//   结果 Unity 直接拒绝安装本包：
//     Package com.yd.unitybridge@<git> has invalid dependencies ...
//     Version 'https://github.com/...' is invalid. Expected a 'SemVer' compatible value.
//
//   因此本包不再声明 com.coplaydev.unity-mcp 依赖，改为运行时反射探测：
//     · 项目装了 MCP for Unity → /mcp 与 /mcp/catalog 全功能可用（随 MCP 升级自适应）；
//     · 项目没装 → 本包照常编译并启动服务，相关端点返回明确的「未安装 + 安装方法」。
//
//   反射目标（MCP for Unity 的 public API）：
//     · MCPForUnity.Editor.Tools.CommandRegistry.InvokeCommandAsync(string, JObject)
//     · MCPForUnity.Editor.Helpers.{Success,Error,Pending}Response
//     · MCPForUnity.Editor.Services.MCPServiceLocator.ToolDiscovery.DiscoverAllTools()
//     · MCPForUnity.Editor.Tools.McpForUnityToolAttribute（分类目录轻量回退）

using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;

namespace UnityBridge
{
    internal static class McpForUnityBridge
    {
        // MCP for Unity 的包名与安装地址（用于生成提示；git 依赖只能写进项目 manifest）。
        public const string PackageId = "com.coplaydev.unity-mcp";
        public const string PackageUrl =
            "https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity#main";

        public static readonly string InstallHint =
            $"当前项目未安装 MCP for Unity（{PackageId}），无法使用 MCP 工具。\n" +
            "安装方法：在 <项目>/Packages/manifest.json 的 dependencies 中加入一行" +
            $"（Git 依赖只能声明在项目 manifest，不能声明在包里）：\n" +
            $"  \"{PackageId}\": \"{PackageUrl}\"\n" +
            "保存后等待 Unity 解析并编译完成（首次拉取较慢），再重试。";

        private const string RegistryTypeName = "MCPForUnity.Editor.Tools.CommandRegistry";
        private const string ServiceLocatorTypeName = "MCPForUnity.Editor.Services.MCPServiceLocator";
        private const string DiscoveryServiceTypeName = "MCPForUnity.Editor.Services.ToolDiscoveryService";
        private const string ToolAttributeTypeName = "MCPForUnity.Editor.Tools.McpForUnityToolAttribute";

        private static readonly object LookupLock = new object();
        private static bool _registryLookupDone;
        private static Type _registryType;

        /// <summary>MCP for Unity 是否已装进当前项目（按 CommandRegistry 类型是否可反射到判断）。</summary>
        public static bool IsInstalled
        {
            get { return RegistryType != null; }
        }

        /// <summary>MCP for Unity 的版本信息（取不到返回 null）。</summary>
        public static string Version
        {
            get
            {
                var registry = RegistryType;
                if (registry == null) return null;

                try
                {
                    var info = registry.Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>();
                    if (info != null && !string.IsNullOrEmpty(info.InformationalVersion))
                        return info.InformationalVersion;
                }
                catch
                {
                    // 取不到版本不影响功能，继续走 AssemblyVersion。
                }

                try
                {
                    var name = registry.Assembly.GetName();
                    return name.Version != null ? name.Version.ToString() : null;
                }
                catch
                {
                    return null;
                }
            }
        }

        private static Type RegistryType
        {
            get
            {
                lock (LookupLock)
                {
                    // 域重载后静态字段会重置，因此缓存只在单次域生命周期内有效。
                    if (!_registryLookupDone)
                    {
                        _registryLookupDone = true;
                        _registryType = FindType(RegistryTypeName);
                    }
                    return _registryType;
                }
            }
        }

        // ── 工具调用 ─────────────────────────────────────────────────────────

        /// <summary>反射调用 CommandRegistry.InvokeCommandAsync，返回其结果 Task（不阻塞调用线程）。</summary>
        public static Task<object> InvokeCommandAsync(string tool, JObject parameters)
        {
            var registry = RegistryType;
            if (registry == null) throw new Exception(InstallHint);

            var method = registry.GetMethod(
                "InvokeCommandAsync",
                BindingFlags.Public | BindingFlags.Static,
                null,
                new[] { typeof(string), typeof(JObject) },
                null);

            if (method == null)
            {
                throw new Exception(
                    $"MCP for Unity 版本不兼容：{Describe(registry)} 缺少 InvokeCommandAsync(string, JObject)。" +
                    $"请升级或重装 {PackageId}。");
            }

            object raw;
            try
            {
                raw = method.Invoke(null, new object[] { tool, parameters ?? new JObject() });
            }
            catch (TargetInvocationException tie)
            {
                throw tie.InnerException ?? tie;
            }

            if (raw == null) return Task.FromResult<object>(null);
            if (raw is Task<object> typed) return typed;
            if (raw is Task task) return UnwrapAsync(task);

            throw new Exception($"MCP for Unity 返回了非 Task 结果：{raw.GetType().FullName}");
        }

        // 非泛型 Task（未来版本可能性）用反射取 Result；continueOnCapturedContext 保持主线程语义。
        private static async Task<object> UnwrapAsync(Task task)
        {
            await task;

            var type = task.GetType();
            if (type.IsGenericType)
            {
                var result = type.GetProperty("Result", BindingFlags.Public | BindingFlags.Instance);
                if (result != null) return result.GetValue(task);
            }
            return null;
        }

        /// <summary>把 MCP 的响应对象统一成 { success, tool, ... } 形状（与旧版直接引用类型时一致）。</summary>
        public static object NormalizeResult(string tool, object result)
        {
            if (result == null)
            {
                return new { success = true, tool, data = (object)null };
            }

            // 按类型全名判定，避免依赖编译期引用；类型名不再匹配时走下面的透传兜底
            //（MCP 的响应类型带 JsonProperty，Newtonsoft 直接序列化即可）。
            switch (result.GetType().FullName)
            {
                case "MCPForUnity.Editor.Helpers.SuccessResponse":
                    return new
                    {
                        success = true,
                        tool,
                        message = Member(result, "Message") as string,
                        data = Member(result, "Data"),
                    };

                case "MCPForUnity.Editor.Helpers.ErrorResponse":
                    return new
                    {
                        success = false,
                        tool,
                        error = Member(result, "Error") as string,
                        code = Member(result, "Code") as string,
                        data = Member(result, "Data"),
                    };

                case "MCPForUnity.Editor.Helpers.PendingResponse":
                    return new
                    {
                        success = true,
                        tool,
                        pending = true,
                        message = Member(result, "Message") as string,
                        data = Member(result, "Data"),
                    };
            }

            return new { success = true, tool, data = result };
        }

        // ── 工具清单 ─────────────────────────────────────────────────────────

        /// <summary>返回 MCP 工具清单：{ installed, count, tools }；未安装时附带安装提示。</summary>
        public static object BuildCatalog()
        {
            if (!IsInstalled)
            {
                return new
                {
                    installed = false,
                    count = 0,
                    hint = InstallHint,
                    tools = new List<object>(),
                };
            }

            try
            {
                var tools = DiscoverTools();
                return new { installed = true, count = tools.Count, tools };
            }
            catch (Exception ex)
            {
                // 防御：MCP 包版本差异导致服务/元数据类型对不上时，回退到轻量反射（名称+分组，无参数）。
                return new
                {
                    installed = true,
                    count = -1,
                    fallback = true,
                    error = ex.Message,
                    tools = LightCatalog(),
                };
            }
        }

        // 完整清单：走 MCPServiceLocator.ToolDiscovery.DiscoverAllTools()，逐字段反射读取元数据。
        private static List<object> DiscoverTools()
        {
            var discovery = GetDiscoveryService();
            if (discovery == null)
            {
                throw new Exception(
                    $"MCP for Unity 版本不兼容：找不到 MCPServiceLocator.ToolDiscovery / ToolDiscoveryService。" +
                    $"请升级或重装 {PackageId}。");
            }

            var method = discovery.GetType().GetMethod(
                "DiscoverAllTools",
                BindingFlags.Public | BindingFlags.Instance,
                null,
                Type.EmptyTypes,
                null);

            if (method == null)
            {
                throw new Exception(
                    $"MCP for Unity 版本不兼容：{Describe(discovery.GetType())} 缺少 DiscoverAllTools()。" +
                    $"请升级或重装 {PackageId}。");
            }

            var raw = method.Invoke(discovery, null) as IEnumerable;
            if (raw == null) return new List<object>();

            var result = new List<object>();
            foreach (var tool in raw.Cast<object>()
                         .OrderBy(t => Member(t, "Name") as string ?? string.Empty, StringComparer.Ordinal))
            {
                var name = Member(tool, "Name") as string;
                var description = Member(tool, "Description") as string;

                var parameters = new List<object>();
                if (Member(tool, "Parameters") is IEnumerable parameterItems)
                {
                    parameters = parameterItems.Cast<object>()
                        .OrderByDescending(p => Member(p, "Required") as bool? ?? false)
                        .ThenBy(p => Member(p, "Name") as string ?? string.Empty, StringComparer.Ordinal)
                        .Select(p => (object)new
                        {
                            name = Member(p, "Name"),
                            type = Member(p, "Type"),
                            required = Member(p, "Required"),
                            description = Member(p, "Description"),
                            defaultValue = Member(p, "DefaultValue"),
                        })
                        .ToList();
                }

                result.Add(new
                {
                    tool = name,
                    description = string.IsNullOrEmpty(description) ? $"Tool: {name}" : description,
                    group = Member(tool, "Group"),
                    structuredOutput = Member(tool, "StructuredOutput"),
                    requiresPolling = Member(tool, "RequiresPolling"),
                    pollAction = Member(tool, "PollAction"),
                    parameters,
                });
            }

            return result;
        }

        // 轻量回退：仅扫描 [McpForUnityTool] attribute（名称 + 类型 + 分组），无参数信息。
        private static List<object> LightCatalog()
        {
            var list = new List<object>();
            var attributeType = FindType(ToolAttributeTypeName);

            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type[] types;
                try { types = assembly.GetTypes(); }
                catch { continue; }

                foreach (var type in types)
                {
                    object attr = null;
                    try
                    {
                        if (attributeType != null)
                        {
                            var attrs = type.GetCustomAttributes(attributeType, false);
                            if (attrs != null && attrs.Length > 0) attr = attrs[0];
                        }
                    }
                    catch
                    {
                        // 域重载期间类型元数据可能半加载，跳过即可。
                        continue;
                    }

                    if (attr == null) continue;

                    var name = Member(attr, "Name") as string;
                    list.Add(new
                    {
                        tool = string.IsNullOrEmpty(name) ? ToSnakeCase(type.Name) : name,
                        type = type.FullName,
                        description = Member(attr, "Description"),
                        group = Member(attr, "Group"),
                    });
                }
            }

            return list;
        }

        // 优先 MCPServiceLocator.ToolDiscovery；服务定位器缺失时退回直接实例化 ToolDiscoveryService。
        private static object GetDiscoveryService()
        {
            var locator = FindType(ServiceLocatorTypeName);
            if (locator != null)
            {
                var value = GetStaticMember(locator, "ToolDiscovery");
                if (value == null)
                {
                    // 属性名未来可能变化：扫描静态属性，取第一个带 DiscoverAllTools() 的实例。
                    foreach (var property in locator.GetProperties(BindingFlags.Public | BindingFlags.Static))
                    {
                        object candidate;
                        try { candidate = property.GetValue(null); }
                        catch { continue; }

                        if (candidate != null && candidate.GetType().GetMethod("DiscoverAllTools", Type.EmptyTypes) != null)
                        {
                            value = candidate;
                            break;
                        }
                    }
                }

                if (value != null) return value;
            }

            var discoveryType = FindType(DiscoveryServiceTypeName);
            if (discoveryType != null)
            {
                try { return Activator.CreateInstance(discoveryType); }
                catch { /* 构造不可用时交给上层走轻量回退。 */ }
            }

            return null;
        }

        // ── 反射小工具 ───────────────────────────────────────────────────────

        private static Type FindType(string fullName)
        {
            // Type.GetType 需要程序集限定名（或类型在 mscorlib/调用程序集里），
            // 这里逐个扫描已加载程序集，兼容 MCP 以任意程序集名加载的情况。
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type type;
                try { type = assembly.GetType(fullName, false); }
                catch { continue; }
                if (type != null) return type;
            }
            return null;
        }

        private static object GetStaticMember(Type type, string name)
        {
            try
            {
                var property = type.GetProperty(name, BindingFlags.Public | BindingFlags.Static);
                if (property != null) return property.GetValue(null);

                var field = type.GetField(name, BindingFlags.Public | BindingFlags.Static);
                if (field != null) return field.GetValue(null);
            }
            catch
            {
                // 静态成员初始化失败等同于不可用，交给上层回退。
            }
            return null;
        }

        private static object Member(object instance, string name)
        {
            if (instance == null) return null;

            var type = instance.GetType();
            try
            {
                var property = type.GetProperty(name, BindingFlags.Public | BindingFlags.Instance);
                if (property != null) return property.GetValue(instance);

                var field = type.GetField(name, BindingFlags.Public | BindingFlags.Instance);
                if (field != null) return field.GetValue(instance);
            }
            catch
            {
                return null;
            }

            return null;
        }

        private static string Describe(Type type)
        {
            return type != null ? type.FullName : "(unknown)";
        }

        private static string ToSnakeCase(string name)
        {
            var sb = new System.Text.StringBuilder();
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
    }
}