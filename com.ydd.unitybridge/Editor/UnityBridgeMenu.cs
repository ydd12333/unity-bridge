// 作者: ydd12333
//
// Unity Bridge 菜单入口：启停服务、显示状态、发送测试请求。

using System;
using UnityEditor;
using UnityEngine;

namespace UnityBridge
{
    public static class UnityBridgeMenu
    {
        [MenuItem("Tools/Unity Bridge/Start", false, 0)]
        public static void Start()
        {
            UnityBridgeServer.Start();
        }

        [MenuItem("Tools/Unity Bridge/Stop", false, 1)]
        public static void Stop()
        {
            UnityBridgeServer.Stop();
        }

        [MenuItem("Tools/Unity Bridge/Status", false, 2)]
        public static void Status()
        {
            var running = UnityBridgeServer.IsRunning;
            EditorUtility.DisplayDialog(
                "Unity Bridge",
                running
                    ? $"运行中\nhttp://{UnityBridgeServer.Host}:{UnityBridgeServer.Port}/"
                    : "未运行",
                "确定");
        }

        [MenuItem("Tools/Unity Bridge/Test Request", false, 3)]
        public static void TestRequest()
        {
            if (!UnityBridgeServer.IsRunning)
            {
                UnityBridgeServer.Start();
                if (!UnityBridgeServer.IsRunning) return;
            }

            try
            {
                using var client = new System.Net.Http.HttpClient();
                client.Timeout = TimeSpan.FromSeconds(5);
                var response = client.GetStringAsync(
                    $"http://{UnityBridgeServer.Host}:{UnityBridgeServer.Port}/health").Result;
                Debug.Log("[UnityBridge] 测试响应: " + response);
            }
            catch (Exception ex)
            {
                Debug.LogError("[UnityBridge] 测试请求失败: " + ex.Message);
            }
        }
    }
}
