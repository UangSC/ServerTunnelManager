#requires -Version 5.1
<#
    Tunnel Studio · stop the local panel service.
    Verifies the process command line before terminating it. SSH tunnels that
    were started by the panel are independent processes and are not touched.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$panelDir = Join-Path $root 'Panel'
$pidPath = Join-Path $panelDir 'panel.pid.json'
$configPath = Join-Path $panelDir 'config.json'

function Get-PanelPort {
    if (Test-Path -LiteralPath $configPath) {
        try {
            $raw = [System.IO.File]::ReadAllText($configPath, [System.Text.Encoding]::UTF8)
            $cfg = ConvertFrom-Json -InputObject $raw
            if ($cfg.settings.panelPort) { return [int]$cfg.settings.panelPort }
        } catch { }
    }
    return 9666
}

$port = Get-PanelPort
$health = $null
try {
    $health = Invoke-RestMethod -Uri ("http://127.0.0.1:$port/api/health") -TimeoutSec 1
} catch { }

$pidValue = 0
if ($health -and $health.pid) {
    $pidValue = [int]$health.pid
    if ($health.port) { $port = [int]$health.port }
} elseif (Test-Path -LiteralPath $pidPath) {
    try {
        $raw = [System.IO.File]::ReadAllText($pidPath, [System.Text.Encoding]::UTF8)
        $info = ConvertFrom-Json -InputObject $raw
        if ($info.pid) { $pidValue = [int]$info.pid }
    } catch { }
}

if ($pidValue -le 0) {
    Write-Host '  没有发现正在运行的面板服务。' -ForegroundColor DarkGray
    exit 0
}

$process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
if (-not $process) {
    Write-Host "  面板进程 $pidValue 已不存在，清理 PID 文件。" -ForegroundColor DarkGray
    if (Test-Path -LiteralPath $pidPath) { Remove-Item -LiteralPath $pidPath -Force }
    exit 0
}

$info = $null
try { $info = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue" -ErrorAction Stop } catch { }
$expectedServerPath = [IO.Path]::GetFullPath((Join-Path $panelDir 'Server.ps1'))
$serverCommandPattern = '(?i)(?:^|\s|")' + [regex]::Escape($expectedServerPath) + '(?:"|\s|$)'
if (-not $info -or [string]$info.CommandLine -notmatch $serverCommandPattern) {
    Write-Host "  进程 $pidValue 不是本面板服务，已取消操作。" -ForegroundColor Yellow
    exit 1
}

try {
    Stop-Process -Id $pidValue -Force -ErrorAction Stop
    [void]$process.WaitForExit(5000)
    Write-Host "  面板服务已停止（PID $pidValue）。后台 SSH 隧道继续运行。" -ForegroundColor Yellow
} catch {
    Write-Host "  无法停止面板服务：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

if (Test-Path -LiteralPath $pidPath) {
    try { Remove-Item -LiteralPath $pidPath -Force } catch { }
}
exit 0
