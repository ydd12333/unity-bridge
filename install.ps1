# ============================================================
#  Unity Bridge 一键安装脚本
#
#  安装两部分：
#    1. DSH preset   -> ~/.dsh/.agent-presets/unity-bridge/
#    2. Unity UPM 包 -> 指定 Unity 项目的 Packages/manifest.json
#                      （通过 git URL 添加，Package Manager 自动解析）
#
#  用法：
#    .\install.ps1                          # 仅安装 DSH preset
#    .\install.ps1 -UnityProject D:\proj     # 同时把 UPM 包加入项目
#    .\install.ps1 -UnityProject D:\proj -UnityRepoUrl https://github.com/<you>/unity-bridge.git
#
#  说明：
#    - DSH preset 装好后需重启 DSH 会话（或新建会话）才生效
#    - Unity 包加进 manifest 后需等 Unity 重新解析包（通常自动触发）
# ============================================================

[CmdletBinding()]
param(
    # Unity 项目根目录（含 Assets/、Packages/）。不传则只装 DSH preset。
    [string]$UnityProject,

    # UnityBridge UPM 包在仓库内的相对路径（git URL 的 ?path= 参数）
    [string]$PackagePath = 'com.yd.unitybridge',

    # 仓库 git URL（从远端拉取时自动推导；本地运行默认用本仓库路径）
    [string]$UnityRepoUrl
)

$ErrorActionPreference = 'Stop'
$RepoRoot = $PSScriptRoot

Write-Host ''
Write-Host '=============================================' -ForegroundColor Cyan
Write-Host '  Unity Bridge 一键安装' -ForegroundColor Cyan
Write-Host '=============================================' -ForegroundColor Cyan

# ---------- 1. 安装 DSH preset ----------
Write-Host ''
Write-Host '[1/2] 安装 DSH preset ...' -ForegroundColor Yellow

$presetSrc = Join-Path $RepoRoot 'preset'
if (-not (Test-Path (Join-Path $presetSrc 'agent.cordis.yml'))) {
    throw "找不到 preset 目录：$presetSrc（请确认在仓库根目录运行本脚本）"
}

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$presetDst = Join-Path $dshHome '.agent-presets\unity-bridge'

if (-not (Test-Path $dshHome)) {
    Write-Host "  警告：未检测到 DSH 数据目录 $dshHome" -ForegroundColor Red
    Write-Host "  请确认已安装 DeepSeek Harness；否则 preset 不会生效。" -ForegroundColor Red
}

if (Test-Path $presetDst) {
    $backup = "$presetDst.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Write-Host "  检测到旧版本，备份到：$backup" -ForegroundColor DarkGray
    Copy-Item $presetDst $backup -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $presetDst | Out-Null
Copy-Item "$presetSrc\*" $presetDst -Recurse -Force
Write-Host "  已安装到：$presetDst" -ForegroundColor Green
Write-Host "  ⚠ 请重启 DSH 会话（或新建会话）后生效" -ForegroundColor Cyan

# ---------- 2. 安装 Unity UPM 包 ----------
if ($UnityProject) {
    Write-Host ''
    Write-Host '[2/2] 把 UnityBridge 加入 Unity 项目 ...' -ForegroundColor Yellow

    $manifestPath = Join-Path $UnityProject 'Packages\manifest.json'
    if (-not (Test-Path $manifestPath)) {
        throw "不是有效的 Unity 项目（缺少 Packages\manifest.json）：$UnityProject"
    }

    # 推导 git URL：优先显式参数，其次从本仓库 remote 推导
    $repoUrl = $UnityRepoUrl
    if (-not $repoUrl) {
        $remote = git -C $RepoRoot remote get-url origin 2>$null
        if ($remote -and $remote -match '^(https?://|git@)') {
            $repoUrl = $remote.Trim()
        }
    }
    if (-not $repoUrl) {
        throw '无法推导仓库 git URL：请用 -UnityRepoUrl 显式传入（如 https://github.com/<you>/unity-bridge.git）'
    }

    # 规范化 git URL 的 path 参数。
    # UPM 规范：https://github.com/user/repo.git?path=/subdir （保留 .git）
    $baseUrl = $repoUrl
    if ($baseUrl -match '\?path=') {
        $baseUrl = $baseUrl -replace '\?path=.*$', ''
    }
    if ($baseUrl -notmatch '\.git$') {
        $baseUrl = "$baseUrl.git"
    }
    $depUrl = "$baseUrl`?path=/$PackagePath"

    $manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable
    $deps = $manifest['dependencies']
    if ($deps -and $deps.ContainsKey('com.yd.unitybridge')) {
        $existing = $deps['com.yd.unitybridge']
        if ($existing -eq $depUrl) {
            Write-Host "  com.yd.unitybridge 已存在于 manifest.json（$existing），跳过" -ForegroundColor Green
        }
        else {
            $deps['com.yd.unitybridge'] = $depUrl
            Write-Host "  com.yd.unitybridge 已存在，更新 URL：$existing -> $depUrl" -ForegroundColor Yellow
        }
    }
    else {
        $deps['com.yd.unitybridge'] = $depUrl
        Write-Host "  已添加 com.yd.unitybridge：$depUrl" -ForegroundColor Green
    }

    $json = $manifest | ConvertTo-Json -Depth 10
    Set-Content -Path $manifestPath -Value $json -Encoding UTF8
    Write-Host "  manifest.json 已更新：$manifestPath" -ForegroundColor Green
    Write-Host "  ⚠ 回到 Unity 等待包解析完成（Package Manager 会自动拉取 git 包）" -ForegroundColor Cyan
}
else {
    Write-Host ''
    Write-Host '[2/2] 跳过 Unity 包安装（未传 -UnityProject）' -ForegroundColor DarkGray
    Write-Host '  如需安装到 Unity 项目，重新运行：' -ForegroundColor DarkGray
    Write-Host '    .\install.ps1 -UnityProject <项目根目录>' -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '=============================================' -ForegroundColor Cyan
Write-Host '  安装完成。' -ForegroundColor Green
Write-Host '  - DSH：重启会话后可用 unity_* 工具' -ForegroundColor Green
Write-Host '  - Unity：检查 Package Manager 是否已加载 Unity Bridge' -ForegroundColor Green
Write-Host '=============================================' -ForegroundColor Cyan
Write-Host ''
