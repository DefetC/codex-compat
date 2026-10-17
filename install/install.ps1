# 中文注释：codex-compat 官方 Windows 安装引导脚本；只使用 npm 包名，不硬编码任何下载地址。
# 中文注释：本文件以 UTF-8（带 BOM）保存，Windows PowerShell 5.1 与 PowerShell 7+ 都能正确解析中文提示。
#
# 用法（在 PowerShell 中执行；pwsh 与 Windows PowerShell 均可）：
#   pwsh -File install.ps1                  # 安装 npm 上的最新版 codex-compat
#   powershell -File install.ps1 -DryRun    # 只打印将执行的命令，不做任何变更
#   pwsh -File install.ps1 -Version 0.1.0   # 安装指定版本

[CmdletBinding()]
param(
  # 中文注释：要安装的 codex-compat 版本，默认 latest（npm 上的最新版本）
  [string]$Version = 'latest',
  # 中文注释：预演开关；打开后只打印将执行的命令，不执行安装
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

# 中文注释：最低支持的 Node 主版本，与 package.json 的 engines 字段保持一致
$MinimumNodeMajor = 18

# 中文注释：统一的日志输出前缀
function Write-Step {
  param([string]$Message)
  Write-Host "[install] $Message"
}

# 中文注释：把 Node 版本字符串（形如 v22.14.0）解析为主版本号；无法解析时返回 -1
function Get-NodeMajorVersion {
  param([string]$RawVersion)
  $normalized = $RawVersion.Trim().TrimStart('v', 'V')
  $majorText = ($normalized -split '\.')[0]
  if ($majorText -notmatch '^\d+$') {
    return -1
  }
  return [int]$majorText
}

# 中文注释：检查 Node.js 是否存在且主版本满足要求，不满足时打印安装指引并退出 1
function Assert-NodeRequirement {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Step '未检测到 Node.js，请先安装 Node.js 18 或更高版本（推荐 LTS 版本）。'
    Write-Step '  Windows 推荐：winget install OpenJS.NodeJS.LTS'
    Write-Step '  也可以前往 Node.js 官方网站下载 LTS 安装包，安装完成后重新运行本脚本。'
    exit 1
  }

  # 中文注释：不用管道截断输出，避免提前结束 node 进程导致退出码被误判为失败
  $rawVersion = ([string](& node -v)).Trim()
  if ($LASTEXITCODE -ne 0) {
    Write-Step '执行 node -v 失败，请确认 Node.js 安装完整后重试。'
    exit 1
  }
  # 中文注释：node -v 只输出一行，这里仍按行取值以兼容额外输出
  $rawVersion = ($rawVersion -split '\r?\n')[0].Trim()

  $major = Get-NodeMajorVersion -RawVersion $rawVersion
  if ($major -lt 0) {
    Write-Step "无法解析 Node.js 版本号：$rawVersion，请重新安装 Node.js 18 或更高版本。"
    exit 1
  }
  if ($major -lt $MinimumNodeMajor) {
    Write-Step "当前 Node.js 版本为 $rawVersion，低于要求的 v$MinimumNodeMajor。"
    Write-Step '请先升级 Node.js 后重试：'
    Write-Step '  Windows 推荐：winget install OpenJS.NodeJS.LTS'
    Write-Step '  也可以前往 Node.js 官方网站下载 LTS 安装包。'
    exit 1
  }

  Write-Step "Node.js 版本：$rawVersion（满足 >= v$MinimumNodeMajor）"
}

# 中文注释：npm 随 Node.js 一起安装，缺失时给出明确指引并退出 1
function Assert-NpmAvailable {
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Step '未检测到 npm，请重新安装 Node.js（npm 随 Node.js 一起安装）。'
    exit 1
  }
}

# 中文注释：执行外部命令；非零退出码时抛出异常，由入口统一转换为退出码 1
function Invoke-ExternalCommand {
  param(
    [string]$Command,
    [string[]]$Arguments
  )
  $display = "$Command $($Arguments -join ' ')"
  Write-Step "执行：$display"
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "命令执行失败（退出码 $LASTEXITCODE）：$display"
  }
}

try {
  Write-Step 'codex-compat 安装引导开始。'
  Assert-NodeRequirement
  Assert-NpmAvailable

  # 中文注释：默认安装 npm 上最新的 codex-compat；指定版本时使用“包名@版本”形式
  $packageSpec = 'codex-compat'
  if (-not [string]::IsNullOrWhiteSpace($Version) -and $Version -ne 'latest') {
    $packageSpec = "codex-compat@$Version"
  }

  Write-Step '将执行以下命令：'
  Write-Step "  1) npm install -g $packageSpec"
  Write-Step '  2) codex-compat install'

  if ($DryRun) {
    Write-Step 'DryRun 模式：未执行任何命令，退出码 0。'
    exit 0
  }

  Invoke-ExternalCommand -Command 'npm' -Arguments @('install', '-g', $packageSpec)
  Invoke-ExternalCommand -Command 'codex-compat' -Arguments @('install')

  Write-Step '安装完成：重新启动 Codex 后生效。'
  exit 0
}
catch {
  Write-Step "安装失败：$($_.Exception.Message)"
  exit 1
}
