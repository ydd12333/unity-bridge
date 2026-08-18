# ============================================================
#  Unity Bridge 卸载脚本
#
#  移除两部分：
#    1. DSH preset（~/.dsh/.agent-presets/unity-bridge/）
#    2. Unity 项目 manifest.json 里的 com.yd.unitybridge 依赖（可选）
#
#  用法：
#    .\uninstall.ps1                          # 仅卸载 DSH preset
#    .\uninstall.ps1 -UnityProject D:\proj     # 同时从项目移除 UPM 包
# ============================================================

[CmdletBinding()]
param(
    [string]$UnityProject
)

$ErrorActionPreference = 'Stop'

Write-Host ''
Write-Host '=============================================' -ForegroundColor Cyan
Write-Host '  Unity Bridge 卸载' -ForegroundColor Cyan
Write-Host '=============================================' -ForegroundColor Cyan

# ---------- 1. 卸载 DSH preset ----------
Write-Host ''
Write-Host '[1/2] 卸载 DSH preset ...' -ForegroundColor Yellow

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$presetDst = Join-Path $dshHome '.agent-presets\unity-bridge'

if (Test-Path $presetDst) {
    Remove-Item $presetDst -Recurse -Force
    Write-Host "  已删除：$presetDst" -ForegroundColor Green
}
else {
    Write-Host '  未找到 preset（可能已卸载）' -ForegroundColor DarkGray
}

# ---------- 2. 从 Unity 项目移除包 ----------
if ($UnityProject) {
    Write-Host ''
    Write-Host '[2/2] 从 Unity 项目移除 com.yd.unitybridge ...' -ForegroundColor Yellow

    $manifestPath = Join-Path $UnityProject 'Packages\manifest.json'
    if (-not (Test-Path $manifestPath)) {
        throw "不是有效的 Unity 项目（缺少 Packages\manifest.json）：$UnityProject"
    }

    $manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    $deps = $manifest['dependencies']
    if ($deps -and $deps.ContainsKey('com.yd.unitybridge')) {
        $deps.Remove('com.yd.unitybridge')
        $json = $manifest | ConvertTo-Json -Depth 10
        Set-Content -Path $manifestPath -Value $json -Encoding UTF8
        Write-Host "  已从 manifest.json 移除 com.yd.unitybridge" -ForegroundColor Green
    }
    else {
        Write-Host '  manifest.json 中无 com.yd.unitybridge，跳过' -ForegroundColor DarkGray
    }
}
else {
    Write-Host ''
    Write-Host '[2/2] 跳过 Unity 包移除（未传 -UnityProject）' -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '=============================================' -ForegroundColor Cyan
Write-Host '  卸载完成。' -ForegroundColor Green
Write-Host '=============================================' -ForegroundColor Cyan
Write-Host ''
