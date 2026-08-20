# ============================================================
#  Unity Bridge 卸载脚本
#
#  移除两部分：
#    1. DSH 全局插件（unity-bridge）
#       优先用 `dsh plugin --profile <name> remove unity-bridge`（内部 pnpm
#       remove，同时从 bundle 层栈移除）；随后清理 copy 方式可能遗留的
#       $DSH_HOME/profiles/<name>/unity-bridge.mjs 与 cordis.patch.yml 段。
#    2. Unity 项目 manifest.json 里的 com.yd.unitybridge 依赖（可选）
#
#  用法：
#    .\uninstall.ps1                          # 仅卸载 DSH 插件（默认 web profile）
#    .\uninstall.ps1 -ProfileName cli         # 卸载指定 profile 中的插件
#    .\uninstall.ps1 -UnityProject D:\proj    # 同时从项目移除 UPM 包
#    .\uninstall.ps1 -DshCommand "pnpm dsh" -DshCwd D:\deepseek-harness
# ============================================================

[CmdletBinding()]
param(
    # 目标 DSH profile 名（对应 $DSH_HOME/profiles/<name>/）。默认 web（GUI）。
    [string]$ProfileName = 'web',

    # 自定义 dsh 调用命令（dsh 不在 PATH 时用，如 "pnpm dsh"）；配合 -DshCwd 指定工作目录。
    [string]$DshCommand,

    # dsh 命令的工作目录（如 deepseek-harness 源码目录）。
    [string]$DshCwd,

    [string]$UnityProject
)

$ErrorActionPreference = 'Stop'

$PluginFile   = 'unity-bridge.mjs'
$PatchEntryId = 'tool-unity-bridge'
$LegacyPreset = '.agent-presets\unity-bridge'
$PackageName  = 'unity-bridge'

# 引号感知地把命令行字符串拆成可执行+参数（支持带空格的路径，路径请加引号）。
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

# 从 patch 文件内容中删除包含指定 id 的顶层条目块。
# 规则：顶层 YAML 数组项以行首无缩进的 `- ` 开始；块 = 该项起到下一个
# `- ` 项之前的所有行。删除目标块时，连带删除其上方紧邻的连续注释行
# （注释与块之间无空行），以及它们上方的一个分隔空行。
function Remove-PatchEntryContaining {
    param([string]$Content, [string]$Needle)

    $lines = @($Content -split "`n")
    $n = $lines.Count

    $starts = @()
    for ($i = 0; $i -lt $n; $i++) {
        if ($lines[$i] -match '^-\s') { $starts += $i }
    }

    $remove = New-Object 'System.Collections.Generic.HashSet[int]'
    for ($k = 0; $k -lt $starts.Count; $k++) {
        $s = $starts[$k]
        $e = if ($k + 1 -lt $starts.Count) { $starts[$k + 1] } else { $n }
        $blockText = ($lines[$s..($e - 1)] -join "`n")
        if ($blockText -match [regex]::Escape($Needle)) {
            for ($i = $s; $i -lt $e; $i++) { [void]$remove.Add($i) }
            # 上方紧邻的连续注释行（不跨空行）
            $j = $s - 1
            while ($j -ge 0 -and $lines[$j] -match '^\s*#') { [void]$remove.Add($j); $j-- }
            # 再吞掉一个分隔空行
            if ($j -ge 0 -and $lines[$j].Trim() -eq '') { [void]$remove.Add($j) }
        }
    }

    $out = for ($i = 0; $i -lt $n; $i++) {
        if (-not $remove.Contains($i)) { $lines[$i] }
    }
    return ($out -join "`n")
}

Write-Host ''
Write-Host '=============================================' -ForegroundColor Cyan
Write-Host '  Unity Bridge 卸载' -ForegroundColor Cyan
Write-Host '=============================================' -ForegroundColor Cyan

# ---------- 1. 卸载 DSH 全局插件 ----------
Write-Host ''
Write-Host '[1/2] 卸载 DSH 全局插件 ...' -ForegroundColor Yellow

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$profileDir = Join-Path (Join-Path $dshHome 'profiles') $ProfileName

# 1a. 优先用 dsh plugin remove（若 dsh 可用）
$dshArgs = @()
if ($DshCommand) {
    $dshArgs = @(Split-CommandLine -Line $DshCommand)
}
elseif (Get-Command dsh -ErrorAction SilentlyContinue) {
    $dshArgs = @('dsh')
}
if ($dshArgs.Count -gt 0 -and (Test-Path (Join-Path $profileDir 'package.json'))) {
    $prevLocation = $null
    try {
        if ($DshCwd) {
            if (-not (Test-Path $DshCwd)) { throw "指定的 dsh 工作目录不存在：$DshCwd" }
            $prevLocation = Get-Location
            Push-Location $DshCwd
        }
        $dshRest = if ($dshArgs.Count -gt 1) { $dshArgs[1..($dshArgs.Count - 1)] } else { @() }
        & $dshArgs[0] @($dshRest) plugin --profile $ProfileName remove $PackageName
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  已通过 dsh plugin remove 卸载 npm 包：$PackageName" -ForegroundColor Green
        }
        else {
            Write-Host "  dsh plugin remove 失败（退出码 $LASTEXITCODE），继续手动清理..." -ForegroundColor DarkGray
        }
    }
    finally {
        if ($prevLocation) { Pop-Location }
    }
}
else {
    Write-Host "  未找到 dsh 命令，跳过 pnpm 卸载（若有 node_modules 残留请手动 dsh plugin remove）" -ForegroundColor DarkGray
}

# 1b. 清理 copy 方式遗留：cordis.patch.yml 段 + 插件文件
if (-not (Test-Path $profileDir)) {
    Write-Host "  未找到 DSH profile：$profileDir（插件可能未安装或已卸载）" -ForegroundColor DarkGray
}
else {
    $patchPath = Join-Path $profileDir 'cordis.patch.yml'
    if (Test-Path $patchPath) {
        $content = Get-Content $patchPath -Raw -Encoding UTF8
        $updated  = Remove-PatchEntryContaining -Content $content -Needle $PatchEntryId
        if ($updated -ne $content) {
            Set-Content -Path $patchPath -Value $updated -Encoding UTF8
            Write-Host "  已从 cordis.patch.yml 移除 $PatchEntryId：$patchPath" -ForegroundColor Green
            Write-Host "  ⚠ 若 DSH 正在运行：保存即热生效，unity_* 工具将移除" -ForegroundColor Cyan
        }
        else {
            Write-Host "  cordis.patch.yml 中未找到 $PatchEntryId，跳过" -ForegroundColor DarkGray
        }
    }
    else {
        Write-Host "  cordis.patch.yml 不存在，跳过" -ForegroundColor DarkGray
    }

    $pluginDst = Join-Path $profileDir $PluginFile
    if (Test-Path $pluginDst) {
        Remove-Item $pluginDst -Force
        Write-Host "  已删除插件文件：$pluginDst" -ForegroundColor Green
    }
    else {
        Write-Host "  插件文件不存在：$pluginDst（可能已删除）" -ForegroundColor DarkGray
    }
}

# 1c. 清理旧版 agent preset（如有残留）
$legacy = Join-Path $dshHome $LegacyPreset
if (Test-Path $legacy) {
    Remove-Item $legacy -Recurse -Force
    Write-Host "  已清理旧版 agent preset：$legacy" -ForegroundColor Green
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
