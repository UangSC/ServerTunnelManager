#requires -Version 7.0
<#
    Tunnel Studio · launcher
    Starts the local panel server in a hidden background process and opens
    the browser. Safe to run multiple times: an already-running panel is
    detected through its health endpoint.
#>
[CmdletBinding()]
param(
    [switch]$NoBrowser,
    [int]$Port = 0,
    [switch]$Foreground,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$panelDir = Join-Path $root 'Panel'
$server = Join-Path $panelDir 'Server.ps1'
$configPath = Join-Path $panelDir 'config.json'
$logDir = Join-Path $panelDir 'logs'

if (-not (Test-Path -LiteralPath $server)) {
    throw "找不到面板服务脚本：$server"
}
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Read-PanelSettings {
    if (-not (Test-Path -LiteralPath $configPath)) { return $null }
    try {
        $raw = [System.IO.File]::ReadAllText($configPath, [System.Text.Encoding]::UTF8)
        return ConvertFrom-Json -InputObject $raw
    } catch { return $null }
}

$settings = Read-PanelSettings
$listenPort = $Port
if ($listenPort -le 0) {
    $listenPort = 9666
    if ($settings -and $settings.settings -and $settings.settings.panelPort) {
        $parsed = 0
        if ([int]::TryParse([string]$settings.settings.panelPort, [ref]$parsed) -and $parsed -ge 1024 -and $parsed -le 65535) {
            $listenPort = $parsed
        }
    }
}
$url = "http://127.0.0.1:$listenPort/"

function Test-PanelOwner($health) {
    if (-not $health -or $health.app -ne 'tunnel-studio' -or -not $health.pid) { return $false }
    try {
        $info = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$health.pid) -ErrorAction Stop
        $expectedServer = [IO.Path]::GetFullPath($server)
        $pattern = '(?i)(?:^|\s|")' + [regex]::Escape($expectedServer) + '(?:"|\s|$)'
        return ($info -and [string]$info.CommandLine -match $pattern)
    } catch { return $false }
}

function Test-PanelHealth {
    try {
        $response = Invoke-RestMethod -Uri ($url + 'api/health') -TimeoutSec 1 -MaximumRedirection 0
        return Test-PanelOwner $response
    } catch {
        return $false
    }
}

# If the configured port changed while an older panel is still running, reuse
# the recorded port instead of trying to start a second instance.
if (-not (Test-PanelHealth)) {
    $pidFile = Join-Path $panelDir 'panel.pid.json'
    if (Test-Path -LiteralPath $pidFile) {
        try {
            $raw = [System.IO.File]::ReadAllText($pidFile, [System.Text.Encoding]::UTF8)
            $info = ConvertFrom-Json -InputObject $raw
            $recordedPort = 0
            if ($info.port -and [int]::TryParse([string]$info.port, [ref]$recordedPort) -and $recordedPort -gt 0 -and $recordedPort -ne $listenPort) {
                $probeUrl = "http://127.0.0.1:$recordedPort/"
                $probe = Invoke-RestMethod -Uri ($probeUrl + 'api/health') -TimeoutSec 1 -MaximumRedirection 0
                if (Test-PanelOwner $probe) {
                    $listenPort = $recordedPort
                    $url = $probeUrl
                }
            }
        } catch { }
    }
}

$openBrowser = -not $NoBrowser
if ($openBrowser -and $settings -and $settings.settings) {
    $preference = $settings.settings.openBrowserOnStart
    if ($null -ne $preference) {
        if ($preference -is [bool]) { $openBrowser = $preference }
        elseif ([string]$preference -match '^(?i:false|0|no|off)$') { $openBrowser = $false }
    }
}

if (Test-PanelHealth) {
    if ($openBrowser) { Start-Process $url }
    if (-not $Quiet) {
        Write-Host ''
        Write-Host "  Tunnel Studio 已在运行：$url" -ForegroundColor Cyan
        if ($openBrowser) { Write-Host '  已在默认浏览器中打开。' -ForegroundColor DarkGray }
    }
    exit 0
}

$currentExe = Join-Path $PSHOME 'pwsh.exe'

if ($Foreground) {
    & $currentExe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $server -Port $listenPort
    exit $LASTEXITCODE
}

$stdout = Join-Path $logDir 'server.out.log'
$stderr = Join-Path $logDir 'server.err.log'
if ($Port -gt 0) {
    $arguments = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $server), '-Port', [string]$listenPort)
} else {
    $arguments = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $server))
}

try {
    $process = Start-Process -FilePath $currentExe -ArgumentList $arguments -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr
} catch {
    if (-not $Quiet) {
        Write-Host ''
        Write-Host "  启动面板失败：$($_.Exception.Message)" -ForegroundColor Red
    }
    exit 1
}

$ready = $false
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 350
    if (Test-PanelHealth) { $ready = $true; break }
    $process.Refresh()
    if ($process.HasExited) { break }
}

if (-not $ready) {
    if (-not $Quiet) {
        Write-Host ''
        Write-Host "  面板未能在 20 秒内启动。" -ForegroundColor Red
        if (Test-Path -LiteralPath $stderr) {
            Write-Host '  ---- 错误输出 ----' -ForegroundColor DarkGray
            Get-Content -LiteralPath $stderr -Tail 14 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
        }
        if (Test-Path -LiteralPath $stdout) {
            Write-Host '  ---- 标准输出 ----' -ForegroundColor DarkGray
            Get-Content -LiteralPath $stdout -Tail 14 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
        }
        Write-Host "  如果端口被占用，请关闭占用程序，或修改 Panel\config.json 中的 panelPort。" -ForegroundColor Yellow
        Write-Host '  常用排查：Get-NetTCPConnection -State Listen -LocalPort ' -NoNewline -ForegroundColor DarkGray
        Write-Host $listenPort -ForegroundColor DarkGray
    }
    $process.Refresh()
    if (-not $process.HasExited) {
        # Do not leave an unhealthy background server behind.
        try { Stop-Process -Id $process.Id -Force -ErrorAction Stop } catch { }
    }
    exit 1
}

if ($openBrowser) {
    Start-Process $url
}

if (-not $Quiet) {
    Write-Host ''
    Write-Host '  Tunnel Studio · SSH 隧道控制台' -ForegroundColor Cyan
    Write-Host "  $url" -ForegroundColor White
    Write-Host '  面板已在后台运行。关闭浏览器不会停止面板或隧道。' -ForegroundColor DarkGray
    if ($openBrowser) { Write-Host '  已尝试在默认浏览器中打开。' -ForegroundColor DarkGray }
    Write-Host '  停止面板：Stop-Panel.cmd' -ForegroundColor DarkGray
    Write-Host ''
}
exit 0
