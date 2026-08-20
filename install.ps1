# ============================================================
#  Unity Bridge 一键安装脚本
#
#  安装两部分：
#    1. DSH 全局插件（unity-bridge）
#       默认通过 `dsh plugin --profile <name> add <本仓库>` 安装（dsh plugin
#       内部即在 DSH profile 目录执行 pnpm add，装好后自动把声明了
#       dsh.bundle 的本包加入 profile 层栈，无需手改配置）。
#       找不到 dsh 命令时回退为"复制文件 + 手写 cordis.patch.yml"方式。
#       插件作为 host 全局插件：任何 preset、任何会话都可使用 unity_* 工具。
#    2. Unity UPM 包 -> 指定 Unity 项目的 Packages/manifest.json
#                      （通过 git URL 添加，Package Manager 自动解析）
#
#  用法：
#    .\install.ps1                              # 仅安装 DSH 插件（默认 web profile）
#    .\install.ps1 -ProfileName cli             # 安装到指定 profile
#    .\install.ps1 -InstallMethod copy          # 强制用复制+patch 方式
#    .\install.ps1 -DshCommand "pnpm dsh" -DshCwd D:\deepseek-harness   # 用 harness 源码目录的 pnpm dsh
#    .\install.ps1 -UnityProject D:\proj        # 同时把 UPM 包加入项目
#    .\install.ps1 -UnityProject D:\proj -UnityRepoUrl https://github.com/<you>/unity-bridge.git
#
#  说明：
#    - pnpm 方式安装后需重启 DSH（bundle 成员在启动时固定；profile 运行中
#      编辑 cordis.patch.yml 才会热生效）
#    - copy 方式保存 cordis.patch.yml 即热生效（无需重启）
#    - 旧版 agent preset（$DSH_HOME/.agent-presets/unity-bridge/）会被自动
#      清理（已由全局插件替代）
#    - Unity 包加进 manifest 后需等 Unity 重新解析包（通常自动触发）
# ============================================================

[CmdletBinding()]
param(
    # 目标 DSH profile 名（对应 $DSH_HOME/profiles/<name>/）。默认 web（GUI）。
    [string]$ProfileName = 'web',

    # 安装方式：auto=优先 dsh plugin（找不到则回退 copy）；pnpm=必须 dsh plugin；copy=复制+手写 patch。
    [ValidateSet('auto', 'pnpm', 'copy')]
    [string]$InstallMethod = 'auto',

    # 自定义 dsh 调用命令（dsh 不在 PATH 时用，如 "pnpm dsh"）；配合 -DshCwd 指定工作目录（如 harness 源码目录）。
    [string]$DshCommand,

    # dsh 命令的工作目录（如 deepseek-harness 源码目录 D:\deepseek-harness）。
    [string]$DshCwd,

    # Unity 项目根目录（含 Assets/、Packages/）。不传则只装 DSH 插件。
    [string]$UnityProject,

    # UnityBridge UPM 包在仓库内的相对路径（git URL 的 ?path= 参数）
    [string]$PackagePath = 'com.yd.unitybridge',

    # 仓库 git URL（从远端拉取时自动推导；本地运行默认用本仓库路径）
    [string]$UnityRepoUrl
)

$ErrorActionPreference = 'Stop'
$RepoRoot = $PSScriptRoot

$PluginFile   = 'unity-bridge.mjs'
$PatchEntryId = 'tool-unity-bridge'
$LegacyPreset = '.agent-presets\unity-bridge'

# 引号感知地把命令行字符串拆成可执行+参数（"pnpm dsh" -> pnpm,dsh；
# "node 'D:\Program Files\...\bin.js'" -> node,完整路径；带空格路径请加引号）。
function Split-CommandLine([string]$Line) {
    $tokens = $null; $errors = $null
    [System.Management.Automation.Language.Parser]::ParseInput($Line, [ref]$tokens, [ref]$errors) | Out-Null
    $result = [System.Collections.Generic.List[string]]::new()
    foreach ($t in $tokens) {
        if ($t.Kind -eq 'EndOfInput') { continue }
        if ($t.Kind -eq 'StringLiteral') { $result.Add([string]$t.Value) }
        else { $result.Add([string]$t.Text) }
    }
    return $result.ToArray()
}

$PatchTemplate = @'
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).
'@

# 追加到 cordis.patch.yml 的插件段（顶层 YAML 数组项，注意缩进）
$InsertBlock = @"

# ── Unity Bridge 全局插件 ──────────────────────────────────────────────
# 由 unity-bridge 预设迁移而来：注册 unity_* 工具（编译/刷新/日志/执行/场景/
# 资源/MCP 透传），经本机 HTTP（127.0.0.1:8321）控制 Unity 编辑器。
# 作为 host 全局插件存在，任何预设、任何对话都可用。
# 卸载：运行仓库 uninstall.ps1，或手动删除本段与 unity-bridge.mjs（保存即热生效）。
- insert:
    - id: $PatchEntryId
      name: './$PluginFile'
"@

Write-Host ''
Write-Host '=============================================' -ForegroundColor Cyan
Write-Host '  Unity Bridge 一键安装' -ForegroundColor Cyan
Write-Host '=============================================' -ForegroundColor Cyan

# ---------- 1. 安装 DSH 全局插件 ----------
Write-Host ''
Write-Host '[1/2] 安装 DSH 全局插件 ...' -ForegroundColor Yellow

if (-not (Test-Path (Join-Path $RepoRoot 'package.json'))) {
    throw "找不到插件包清单：$(Join-Path $RepoRoot 'package.json')（请确认在仓库根目录运行本脚本）"
}

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
if (-not (Test-Path $dshHome)) {
    Write-Host "  警告：未检测到 DSH 数据目录 $dshHome" -ForegroundColor Red
    Write-Host "  请确认已安装 DeepSeek Harness；否则插件不会生效。" -ForegroundColor Red
}

# profile 名规则与 `dsh --profile <name>` 一致：不得含路径分隔符等
if ($ProfileName -match '[/\\]' -or $ProfileName -eq '' -or $ProfileName -eq '.' -or $ProfileName -eq '..') {
    throw "非法的 profile 名：$ProfileName"
}

# 决定调用 dsh 的方式（dsh plugin 内部即 pnpm add）
$dshFound = $false
$dshArgs  = @()
if ($DshCommand) {
    $dshArgs = @(Split-CommandLine -Line $DshCommand)
    if ($dshArgs.Count -eq 0) { throw "无法解析 -DshCommand：$DshCommand" }
    $dshFound = $true
}
elseif (Get-Command dsh -ErrorAction SilentlyContinue) {
    $dshArgs = @('dsh')
    $dshFound = $true
}

$usePnpm = ($InstallMethod -eq 'pnpm') -or ($InstallMethod -eq 'auto' -and $dshFound)
if ($InstallMethod -eq 'pnpm' -and -not $dshFound) {
    throw 'pnpm 方式需要 dsh 命令（或 -DshCommand 指定，如 "pnpm dsh" 配 -DshCwd <harness 源码目录>）'
}

if ($usePnpm) {
    # ---- 方式 A：dsh plugin add（内部 pnpm）----
    Write-Host "  使用 dsh plugin 安装（$($dshArgs -join ' ') plugin --profile $ProfileName add file:$RepoRoot）..." -ForegroundColor DarkGray

    $prevLocation = $null
    try {
        if ($DshCwd) {
            if (-not (Test-Path $DshCwd)) { throw "指定的 dsh 工作目录不存在：$DshCwd" }
            $prevLocation = Get-Location
            Push-Location $DshCwd
        }
        # 绝对路径用 file: 前缀透传给 pnpm（dsh plugin 会把相对路径锚定到调用目录）
        $dshRest = if ($dshArgs.Count -gt 1) { $dshArgs[1..($dshArgs.Count - 1)] } else { @() }
        & $dshArgs[0] @($dshRest) plugin --profile $ProfileName add "file:$RepoRoot"
        if ($LASTEXITCODE -ne 0) { throw "dsh plugin add 失败（退出码 $LASTEXITCODE）" }
    }
    finally {
        if ($prevLocation) { Pop-Location }
    }

    # 若之前是用 copy 方式装的，清理残留（避免新旧两套并存）
    $profileDir = Join-Path (Join-Path $dshHome 'profiles') $ProfileName
    if (Test-Path (Join-Path $profileDir $PluginFile)) {
        Remove-Item (Join-Path $profileDir $PluginFile) -Force
        Write-Host "  已清理旧 copy 方式遗留的 $PluginFile" -ForegroundColor DarkGray
    }
    $patchPath = Join-Path $profileDir 'cordis.patch.yml'
    if (Test-Path $patchPath) {
        $content = Get-Content $patchPath -Raw -Encoding UTF8
        if ($content -match [regex]::Escape($PatchEntryId)) {
            $lines = @($content -split "`n")
            $starts = @(); for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '^-\s') { $starts += $i } }
            $remove = New-Object 'System.Collections.Generic.HashSet[int]'
            for ($k = 0; $k -lt $starts.Count; $k++) {
                $s = $starts[$k]; $e = if ($k + 1 -lt $starts.Count) { $starts[$k + 1] } else { $lines.Count }
                if (($lines[$s..($e - 1)] -join "`n") -match [regex]::Escape($PatchEntryId)) {
                    for ($i = $s; $i -lt $e; $i++) { [void]$remove.Add($i) }
                    $j = $s - 1
                    while ($j -ge 0 -and $lines[$j] -match '^\s*#') { [void]$remove.Add($j); $j-- }
                    if ($j -ge 0 -and $lines[$j].Trim() -eq '') { [void]$remove.Add($j) }
                }
            }
            $out = for ($i = 0; $i -lt $lines.Count; $i++) { if (-not $remove.Contains($i)) { $lines[$i] } }
            Set-Content -Path $patchPath -Value ($out -join "`n") -Encoding UTF8
            Write-Host "  已清理旧 copy 方式写入的 cordis.patch.yml 段" -ForegroundColor DarkGray
        }
    }
    Write-Host "  已安装到 profile：$ProfileName（node_modules/unity-bridge，自动加入 bundle 层栈）" -ForegroundColor Green
    Write-Host "  ⚠ 请重启 DSH（或重启该 profile）后生效：bundle 成员在启动时固定" -ForegroundColor Cyan
}
else {
    # ---- 方式 B：复制文件 + 手写 cordis.patch.yml ----
    if ($InstallMethod -eq 'auto') {
        Write-Host "  未找到 dsh 命令，回退为复制+patch 方式安装。" -ForegroundColor DarkGray
        Write-Host "  提示：在 deepseek-harness 源码目录可用 'pnpm dsh plugin --profile <name> add <本仓库路径>' 一键安装。" -ForegroundColor DarkGray
    }

    $profileDir = Join-Path (Join-Path $dshHome 'profiles') $ProfileName
    if (-not (Test-Path $profileDir)) {
        $existing = @(
            Get-ChildItem (Join-Path $dshHome 'profiles') -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -ne 'node_modules' } |
                Select-Object -ExpandProperty Name
        )
        if ($existing.Count -gt 0) {
            throw "未找到 DSH profile：$profileDir（现有 profile：$($existing -join '、')，可用 -ProfileName 指定）"
        }
        throw "未找到 DSH profile：$profileDir（未发现任何 profile。请先运行一次 dsh web 初始化 web profile，或用 dsh plugin --profile <name> add @deepseek-ai/dsh-base 创建）"
    }

    $patchPath = Join-Path $profileDir 'cordis.patch.yml'
    if (-not (Test-Path $patchPath)) {
        Set-Content -Path $patchPath -Value $PatchTemplate -Encoding UTF8
        Write-Host "  已创建 profile patch 文件：$patchPath" -ForegroundColor DarkGray
    }

    $pluginSrc = Join-Path $RepoRoot 'plugin'
    $pluginDst = Join-Path $profileDir $PluginFile
    if (Test-Path $pluginDst) {
        $srcHash = (Get-FileHash (Join-Path $pluginSrc $PluginFile) -Algorithm SHA256).Hash
        $dstHash = (Get-FileHash $pluginDst -Algorithm SHA256).Hash
        if ($srcHash -eq $dstHash) {
            Write-Host "  插件文件已存在且一致：$pluginDst" -ForegroundColor Green
        }
        else {
            Write-Host "  插件文件已存在，覆盖更新：$pluginDst" -ForegroundColor Yellow
            Copy-Item (Join-Path $pluginSrc $PluginFile) $pluginDst -Force
        }
    }
    else {
        Copy-Item (Join-Path $pluginSrc $PluginFile) $pluginDst -Force
        Write-Host "  插件文件已复制：$pluginDst" -ForegroundColor Green
    }

    # 复制 Unity 侧安装指南（插件会把它注入 systemPrompt 供 AI 读取）
    $installDocSrc = Join-Path $RepoRoot 'Install.md'
    $installDocDst = Join-Path $profileDir 'Install.md'
    if (-not (Test-Path $installDocSrc)) {
        throw "找不到安装指南：$installDocSrc（请确认在仓库根目录运行本脚本）"
    }
    Copy-Item $installDocSrc $installDocDst -Force
    Write-Host "  安装指南已复制：$installDocDst" -ForegroundColor Green

    $patchContent = Get-Content $patchPath -Raw -Encoding UTF8
    if ($patchContent -match [regex]::Escape($PatchEntryId)) {
        Write-Host "  cordis.patch.yml 已包含 $PatchEntryId，跳过写入" -ForegroundColor Green
    }
    else {
        $newContent = $patchContent.TrimEnd() + "`n`n" + $InsertBlock
        Set-Content -Path $patchPath -Value $newContent -Encoding UTF8
        Write-Host "  已写入 cordis.patch.yml（insert $PatchEntryId）" -ForegroundColor Green
    }

    Write-Host "  ⚠ 若 DSH 正在运行：cordis.patch.yml 保存即热生效，无需重启" -ForegroundColor Cyan
}

# 迁移清理旧版 agent preset（已由全局插件替代）
$legacy = Join-Path $dshHome $LegacyPreset
if (Test-Path $legacy) {
    Remove-Item $legacy -Recurse -Force
    Write-Host "  已清理旧版 agent preset（已由全局插件替代）：$legacy" -ForegroundColor DarkGray
}

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
Write-Host '  - DSH：unity_* 工具已注册为全局插件（任何预设/会话可用）' -ForegroundColor Green
Write-Host '  - Unity：检查 Package Manager 是否已加载 Unity Bridge' -ForegroundColor Green
Write-Host '=============================================' -ForegroundColor Cyan
Write-Host ''
