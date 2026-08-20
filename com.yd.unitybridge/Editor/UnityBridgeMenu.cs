// 作者: ydd12333
//
// Unity Bridge 菜单入口：启动服务、发送测试请求。
// 注意：已移除会弹模态对话框的交互式菜单（Status、Stop）——它们会阻塞
// Unity 主线程，导致通过 bridge（/health 等）的调用全部超时。如需停止
// 服务，直接关闭 Unity 编辑器即可（服务随编辑器退出自动停止）。

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

        [MenuItem("Tools/Unity Bridge/Test Request", false, 1)]
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
