#requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet('Menu', 'Status', 'List', 'Open', 'Close', 'OpenAll', 'CloseAll', 'Add', 'Remove')]
    [string]$Action = 'Menu',
    [string]$Ids = '',
    [string]$ConfigPath = '',
    [string]$Destination = '',
    [string]$TunnelName = '',
    [int]$LocalPort = 0,
    [int]$RemotePort = 0,
    [ValidateSet('Auto', 'Http', 'Socks5', 'None')][string]$Probe = 'Auto'
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($ConfigPath)) { $ConfigPath = Join-Path $PSScriptRoot 'ServerTunnels.json' }
if ([string]::IsNullOrWhiteSpace($Destination)) { $Destination = [string]$env:TUNNEL_STUDIO_DESTINATION }
if ($Destination -and $Destination -notmatch '^[A-Za-z0-9._\-]+@[A-Za-z0-9.:\-]+$') {
    throw 'Destination 必须是明确的 user@host，不接受空白、选项或命令。'
}
$keyPath = Join-Path $env:USERPROFILE '.ssh\id_ed25519'
$script:hadFailure = $false

function Read-TunnelConfig {
    $parsed = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $items = @($parsed)
    $seenIds = @{}
    $seenPorts = @{}
    foreach ($item in $items) {
        foreach ($field in @('Id', 'LocalPort', 'RemotePort')) {
            $value = [string]$item.$field
            if ($value -notmatch '^[1-9][0-9]{0,4}$' -or [int]$value -gt 65535) {
                throw "配置中的 $field 必须为 1 至 65535 的整数。"
            }
        }
        if ([string]::IsNullOrWhiteSpace($item.Name)) { throw '隧道名称不能为空。' }
        if ($seenIds.ContainsKey([int]$item.Id)) { throw "重复序号：$($item.Id)" }
        if ($seenPorts.ContainsKey([int]$item.LocalPort)) { throw "重复本机端口：$($item.LocalPort)" }
        $seenIds[[int]$item.Id] = $true
        $seenPorts[[int]$item.LocalPort] = $true
        # 保留旧面板脚本的状态目录和映射，两个入口可互相识别。
        if ([int]$item.LocalPort -eq 9090 -and [int]$item.RemotePort -ne 9090) {
            throw '本机 9090 已保留给控制面板，远端端口也必须为 9090。'
        }
    }
    return $items | Sort-Object { [int]$_.Id }
}

function Get-TunnelPaths($Tunnel) {
    $folderName = if ([int]$Tunnel.LocalPort -eq 9090) { 'kkidc-panel' } else { "kkidc-port-$($Tunnel.LocalPort)" }
    $folder = Join-Path $env:LOCALAPPDATA "CodexSshTunnels\$folderName"
    return [pscustomobject]@{
        Directory = $folder
        State = Join-Path $folder 'tunnel.json'
        ErrorLog = Join-Path $folder 'ssh-error.log'
        OutputLog = Join-Path $folder 'ssh-output.log'
    }
}

function Add-Tunnel([string]$Name, [int]$Local, [int]$Remote, [string]$ProbeType = 'Auto') {
    if ([string]::IsNullOrWhiteSpace($Name) -or $Name.Length -gt 80 -or $Name -match '[\x00-\x1f]') {
        throw '名称需为 1 至 80 个字符，不能包含控制字符。'
    }
    if ($Local -lt 1 -or $Local -gt 65535 -or $Remote -lt 1 -or $Remote -gt 65535) {
        throw '本机端口和服务器端口都必须为 1 至 65535 的整数。'
    }
    if ($Local -eq 9090 -and $Remote -ne 9090) { throw '本机 9090 已保留给控制面板。' }
    $lock = [System.Threading.Mutex]::new($false, 'Local\CodexKkidcPanelTunnel')
    $ownsLock = $false
    try {
        try { $ownsLock = $lock.WaitOne(10000) } catch [System.Threading.AbandonedMutexException] { $ownsLock = $true }
        if (-not $ownsLock) { throw '另一项操作正在运行，请稍后重试。' }
        $current = @(Read-TunnelConfig)
        if ($current | Where-Object { [int]$_.LocalPort -eq $Local }) { throw "本机端口 $Local 已在列表中，请使用其他端口。" }
        $nextId = [int](($current | Measure-Object -Property Id -Maximum).Maximum) + 1
        if ($nextId -gt 65535) { throw '序号已超过允许范围。' }
        $item = [pscustomobject][ordered]@{ Id = $nextId; Name = $Name.Trim(); LocalPort = $Local; RemotePort = $Remote; Probe = $ProbeType }
        $current += $item
        $fullConfigPath = [System.IO.Path]::GetFullPath($ConfigPath)
        $temporaryPath = $fullConfigPath + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
        try {
            ConvertTo-Json -InputObject @($current) -Depth 4 |
                Set-Content -LiteralPath $temporaryPath -Encoding UTF8
            [System.IO.File]::Replace($temporaryPath, $fullConfigPath, ($fullConfigPath + '.bak'))
        } finally {
            if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force }
        }
        Write-Host "已保存 [$nextId] $($item.Name)：本机 $Local -> 服务器 $Remote。输入 o $nextId 即可开启。" -ForegroundColor Green
    } finally {
        if ($ownsLock) { $lock.ReleaseMutex() }
        $lock.Dispose()
    }
}

function Get-Forward($Tunnel) {
    return "127.0.0.1:$($Tunnel.LocalPort):127.0.0.1:$($Tunnel.RemotePort)"
}

function Get-TunnelState($Tunnel, $ListenerSnapshot = $null) {
    $paths = Get-TunnelPaths $Tunnel
    $result = [pscustomobject]@{ Status = '已关闭'; Process = $null; Record = $null; Paths = $paths; Active = $false }
    if (Test-Path -LiteralPath $paths.State) {
        try {
            $record = Get-Content -LiteralPath $paths.State -Raw | ConvertFrom-Json
            if (-not $record.ProcessId -or -not $record.StartTimeTicks) { throw '状态记录缺少进程标识。' }
            $process = Get-Process -Id $record.ProcessId -ErrorAction SilentlyContinue
            if ($process -and $process.ProcessName -eq 'ssh' -and
                $process.StartTime.ToUniversalTime().Ticks.ToString() -eq $record.StartTimeTicks) {
                if (($destination -and $record.Destination -ne $destination) -or $record.Forward -ne (Get-Forward $Tunnel)) {
                    $result.Status = '配置与运行记录不一致'
                    return $result
                }
                $result.Active = $true
                $result.Process = $process
                $result.Record = $record
                $result.Status = '进程运行，未监听'
            }
        } catch {
            $result.Status = '状态记录异常'
            return $result
        }
    }
    $listeners = if ($null -ne $ListenerSnapshot) {
        @($ListenerSnapshot | Where-Object { $_.LocalPort -eq $Tunnel.LocalPort })
    } else { @(Get-NetTCPConnection -State Listen -LocalPort $Tunnel.LocalPort -ErrorAction SilentlyContinue) }
    if ($result.Active) {
        if ($listeners | Where-Object { $_.OwningProcess -eq $result.Process.Id -and $_.LocalAddress -eq '127.0.0.1' }) {
            $result.Status = '已开启'
        }
    } elseif ($listeners.Count -gt 0) {
        $result.Status = '端口被其他进程占用'
    }
    return $result
}

function Get-PortLatency($Tunnel, $State) {
    if ($State.Status -ne '已开启') { return '-' }
    $kind = [string]$Tunnel.Probe
    if (-not $kind -or $kind -eq 'Auto') {
        $kind = switch ([int]$Tunnel.RemotePort) { 9090 { 'Http' }; 7890 { 'Socks5' }; default { 'None' } }
    }
    if ($kind -eq 'None') { return '未探测' }
    $client = [System.Net.Sockets.TcpClient]::new()
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $pending = $client.ConnectAsync('127.0.0.1', [int]$Tunnel.LocalPort)
        if (-not $pending.Wait(1000)) { return '超时' }
        $stream = $client.GetStream()
        $stream.ReadTimeout = 1500
        $stream.WriteTimeout = 1500
        if ($kind -eq 'Http') {
            $bytes = [System.Text.Encoding]::ASCII.GetBytes("HEAD / HTTP/1.0`r`nHost: localhost`r`nConnection: close`r`n`r`n")
            $stream.Write($bytes, 0, $bytes.Length)
            if ($stream.ReadByte() -ne 72) { return '响应异常' }
        } elseif ($kind -eq 'Socks5') {
            $bytes = [byte[]]@(5, 1, 0)
            $stream.Write($bytes, 0, $bytes.Length)
            if ($stream.ReadByte() -ne 5) { return '响应异常' }
            if ($stream.ReadByte() -ne 0) { return '需要认证' }
        } else { return '未探测' }
        return ('{0} ms' -f [math]::Round($timer.Elapsed.TotalMilliseconds))
    } catch { return '超时/失败' } finally { $client.Dispose() }
}

function Format-Cell([string]$Text, [int]$Width) {
    $used = 0
    $result = ''
    foreach ($character in $Text.ToCharArray()) {
        $size = if ([int]$character -ge 0x2E80) { 2 } else { 1 }
        if ($used + $size -gt $Width - 1) { $result += '~'; $used++; break }
        $result += $character
        $used += $size
    }
    return $result + (' ' * [math]::Max(0, $Width - $used))
}

function Show-Header([string]$Title) {
    if (-not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected) { Clear-Host }
    Write-Host ''
    $targetLabel = if ($destination) { $destination } else { '未设置 SSH 目标（开启需 -Destination user@host）' }
    Write-Host ('  Tunnel Studio  /  ' + $targetLabel) -ForegroundColor Cyan
    Write-Host ('  ' + ('─' * 72)) -ForegroundColor DarkGray
    Write-Host "  $Title"
    Write-Host ''
}

function Show-Tunnels($Tunnels, [switch]$ActiveOnly) {
    $rows = @()
    $snapshot = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue)
    foreach ($tunnel in $Tunnels) {
        $state = Get-TunnelState $tunnel $snapshot
        if ($ActiveOnly -and -not $state.Active) { continue }
        $rows += [pscustomobject]@{ Tunnel = $tunnel; State = $state }
    }
    if ($rows.Count -eq 0) { Write-Host '  暂无隧道。' -ForegroundColor DarkGray; return }
    Write-Host ('  ' + (Format-Cell '序号' 6) + (Format-Cell '名称' 22) + (Format-Cell '本机 → 远端' 17) + (Format-Cell '状态' 14) + '端口延迟') -ForegroundColor DarkGray
    foreach ($row in $rows) {
        $tunnel = $row.Tunnel
        $latency = Get-PortLatency $tunnel $row.State
        Write-Host ('  ' + (Format-Cell ([string]$tunnel.Id) 6) + (Format-Cell $tunnel.Name 22) +
            (Format-Cell "$($tunnel.LocalPort) → $($tunnel.RemotePort)" 17) + (Format-Cell $row.State.Status 14) + $latency)
    }
    Write-Host ''
    Write-Host '  延迟：经 SSH 隧道的 HTTP/SOCKS 响应耗时；未知协议不探测。' -ForegroundColor DarkGray
}

function Read-MenuInput([string]$Prompt) {
    Write-Host ''
    Write-Host ('  ' + ('─' * 72)) -ForegroundColor DarkGray
    Write-Host ''
    return (Read-Host "  $Prompt").Trim()
}

function Test-Back([string]$Value) { return $Value -match '^(0|b|q)$' }

function Wait-Back { [void](Read-MenuInput '按 Enter 返回') }

function Save-TunnelConfig($Items) {
    $fullPath = [System.IO.Path]::GetFullPath($ConfigPath)
    $tempPath = $fullPath + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        ConvertTo-Json -InputObject @($Items) -Depth 4 | Set-Content -LiteralPath $tempPath -Encoding UTF8
        [System.IO.File]::Replace($tempPath, $fullPath, ($fullPath + '.bak'))
    } finally {
        if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force }
    }
}

function Remove-Tunnels([string]$Selection) {
    $lock = [System.Threading.Mutex]::new($false, 'Local\CodexKkidcPanelTunnel')
    $ownsLock = $false
    try {
        try { $ownsLock = $lock.WaitOne(10000) } catch [System.Threading.AbandonedMutexException] { $ownsLock = $true }
        if (-not $ownsLock) { throw '另一项操作正在运行，请稍后重试。' }
        $current = @(Read-TunnelConfig)
        $selected = @(Select-Tunnels $current $Selection)
        foreach ($tunnel in $selected) {
            $state = Get-TunnelState $tunnel
            if (-not $state.Active -and $state.Status -notin @('已关闭', '端口被其他进程占用')) {
                throw "[$($tunnel.Id)] $($state.Status)，请先解决状态异常。"
            }
        }
        foreach ($tunnel in $selected) {
            $state = Get-TunnelState $tunnel
            if ($state.Active) { Close-Tunnel $tunnel }
        }
        $remaining = @($current | Where-Object { $selected.Id -notcontains $_.Id })
        Save-TunnelConfig $remaining
        Write-Host "已从列表删除：$($selected.Id -join ', ')。其余序号保持不变。" -ForegroundColor Green
    } finally {
        if ($ownsLock) { $lock.ReleaseMutex() }
        $lock.Dispose()
    }
}


function Select-Tunnels($Tunnels, [string]$Selection) {
    $parts = @($Selection.Trim() -split '[\s,;，；、|]+' | Where-Object { $_ })
    if ($parts.Count -eq 0) { throw '请输入至少一个序号，例如：1 2 或 1,2。' }
    $selected = @()
    foreach ($part in $parts) {
        if ($part -notmatch '^[1-9][0-9]{0,4}$') { throw "无效序号：$part" }
        $match = @($Tunnels | Where-Object { [int]$_.Id -eq [int]$part })
        if ($match.Count -ne 1) { throw "列表中没有序号 $part；本次尚未执行任何操作。" }
        if ($selected.Id -notcontains $match[0].Id) { $selected += $match[0] }
    }
    return $selected
}

function Open-Tunnel($Tunnel) {
    if ([string]::IsNullOrWhiteSpace($destination)) {
        throw '开启真实 SSH 前必须指定 -Destination user@host 或 TUNNEL_STUDIO_DESTINATION。'
    }
    $state = Get-TunnelState $Tunnel
    if ($state.Status -eq '已开启') { Write-Host "[$($Tunnel.Id)] 已开启，跳过。"; return }
    if ($state.Status -ne '已关闭') { throw "$($state.Status)。请先检查或关闭该隧道。" }
    if (-not (Test-Path -LiteralPath $keyPath)) { throw "找不到 SSH 密钥：$keyPath" }
    $paths = $state.Paths
    New-Item -ItemType Directory -Force -Path $paths.Directory | Out-Null
    $sshPath = (Get-Command ssh.exe -ErrorAction Stop).Source
    $forward = Get-Forward $Tunnel
    $arguments = @('-N', '-T', '-p', '22', '-i', ('"{0}"' -f $keyPath),
        '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'IdentitiesOnly=yes',
        '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10',
        '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-L', $forward, $destination)
    $process = $null
    try {
        $process = Start-Process -FilePath $sshPath -ArgumentList $arguments -WindowStyle Hidden -PassThru `
            -RedirectStandardError $paths.ErrorLog -RedirectStandardOutput $paths.OutputLog
        $ready = $false
        $timer = [System.Diagnostics.Stopwatch]::StartNew()
        while ($timer.Elapsed.TotalSeconds -lt 15) {
            Start-Sleep -Milliseconds 200
            $process.Refresh()
            if ($process.HasExited) { break }
            $listening = Get-NetTCPConnection -State Listen -LocalPort $Tunnel.LocalPort -ErrorAction SilentlyContinue |
                Where-Object { $_.OwningProcess -eq $process.Id -and $_.LocalAddress -eq '127.0.0.1' }
            if ($listening) { $ready = $true; break }
        }
        if (-not $ready) {
            $details = if (Test-Path -LiteralPath $paths.ErrorLog) { Get-Content -LiteralPath $paths.ErrorLog -Raw } else { '' }
            throw "SSH 启动失败。$details"
        }
        [ordered]@{
            ProcessId = $process.Id
            StartTimeTicks = $process.StartTime.ToUniversalTime().Ticks.ToString()
            Destination = $destination
            Forward = $forward
        } | ConvertTo-Json | Set-Content -LiteralPath $paths.State -Encoding UTF8
        Write-Host "[$($Tunnel.Id)] 已开启：127.0.0.1:$($Tunnel.LocalPort) -> 服务器:$($Tunnel.RemotePort)" -ForegroundColor Green
    } catch {
        if ($process) {
            $process.Refresh()
            if (-not $process.HasExited) { $process.Kill() }
        }
        throw
    }
}

function Close-Tunnel($Tunnel) {
    $state = Get-TunnelState $Tunnel
    if (-not $state.Active) {
        if ($state.Status -ne '已关闭') { throw "$($state.Status)，未终止任何进程。" }
        if (Test-Path -LiteralPath $state.Paths.State) { Remove-Item -LiteralPath $state.Paths.State -Force }
        Write-Host "[$($Tunnel.Id)] 已关闭，跳过。"
        return
    }
    $process = $state.Process
    $info = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)"
    $forward = Get-Forward $Tunnel
    $expectedDestination = if ($destination) { $destination } else { [string]$state.Record.Destination }
    if ($expectedDestination -notmatch '^[A-Za-z0-9._\-]+@[A-Za-z0-9.:\-]+$') {
        throw '运行记录缺少有效 SSH 目标，未终止任何进程。'
    }
    $destinationPattern = '(?:^|\s|")' + [regex]::Escape($expectedDestination) + '(?:"|\s|$)'
    $forwardPattern = '(?:^|\s|")' + [regex]::Escape($forward) + '(?:"|\s|$)'
    if (-not $info -or $info.CommandLine -notmatch $destinationPattern -or $info.CommandLine -notmatch $forwardPattern) {
        throw '进程命令不匹配，未终止任何进程。'
    }
    # 使用已经核对过创建时间的进程对象，避免关闭被复用的进程 ID。
    $process.Kill()
    if (-not $process.WaitForExit(5000)) { throw '等待 SSH 进程退出超时。' }
    Remove-Item -LiteralPath $state.Paths.State -Force
    Write-Host "[$($Tunnel.Id)] 已关闭：$($Tunnel.Name)" -ForegroundColor Yellow
}

function Invoke-TunnelBatch($Selected, [string]$Operation) {
    $lock = [System.Threading.Mutex]::new($false, 'Local\CodexKkidcPanelTunnel')
    $ownsLock = $false
    try {
        try { $ownsLock = $lock.WaitOne(10000) } catch [System.Threading.AbandonedMutexException] { $ownsLock = $true }
        if (-not $ownsLock) { throw '另一个隧道操作正在运行，请稍后重试。' }
        foreach ($tunnel in $Selected) {
            try {
                if ($Operation -eq 'Open') { Open-Tunnel $tunnel } else { Close-Tunnel $tunnel }
            } catch {
                $script:hadFailure = $true
                Write-Host "[$($tunnel.Id)] 失败：$($_.Exception.Message)" -ForegroundColor Red
            }
        }
    } finally {
        if ($ownsLock) { $lock.ReleaseMutex() }
        $lock.Dispose()
    }
}

function Show-ListPage([string]$Mode = 'List') {
    $page = 1
    $pageSize = 6
    $query = ''
    $title = switch ($Mode) { 'Open' { '开启隧道' }; 'Close' { '关闭隧道' }; 'Remove' { '删除映射' }; 'Logs' { '查看日志' }; default { '全部映射' } }
    while ($true) {
        $items = @(Read-TunnelConfig)
        $filtered = @($items | Where-Object {
            $haystack = "$($_.Id) $($_.Name) $($_.LocalPort) $($_.RemotePort)"
            $haystack.IndexOf($query, [StringComparison]::OrdinalIgnoreCase) -ge 0
        })
        $totalPages = [math]::Max(1, [math]::Ceiling($filtered.Count / $pageSize))
        $page = [math]::Max(1, [math]::Min($page, $totalPages))
        $visible = @($filtered | Select-Object -Skip (($page - 1) * $pageSize) -First $pageSize)
        Show-Header "$title  /  第 $page 页，共 $totalPages 页  /  $($filtered.Count) 条"
        if ($query) { Write-Host "  搜索：$query" -ForegroundColor Yellow; Write-Host '' }
        Show-Tunnels $visible
        Write-Host ''
        Write-Host '  n 下一页    p 上一页    s 搜索    r 刷新    0 返回'
        if ($Mode -eq 'List') { Write-Host '  o 序号 开启    c 序号 关闭    d 序号 删除' }
        else { Write-Host '  输入序号操作（支持 1 2、1,2）；序号跨页保持一致。' }
        $inputText = Read-MenuInput '请选择'
        if (Test-Back $inputText) { return }
        try {
            switch -Regex ($inputText) {
                '^n$' { $page = [math]::Min($totalPages, $page + 1); continue }
                '^p$' { $page = [math]::Max(1, $page - 1); continue }
                '^r$' { continue }
                '^s$' {
                    $term = Read-MenuInput '搜索名称、序号或端口（留空清除，0 返回）'
                    if (-not (Test-Back $term)) { $query = $term; $page = 1 }
                    continue
                }
                default {
                    $operation = $Mode
                    $selection = $inputText
                    if ($inputText -match '^(o|c|d)\s+(.+)$') {
                        $operation = switch ($Matches[1]) { 'o' { 'Open' }; 'c' { 'Close' }; 'd' { 'Remove' } }
                        $selection = $Matches[2]
                    } elseif ($Mode -eq 'List') { throw '请输入翻页、搜索命令，或 o/c/d 加序号。' }
                    $selected = @(Select-Tunnels $items $selection)
                    if ($operation -eq 'Remove') {
                        Write-Host "  即将删除序号 $($selected.Id -join ', ')，已运行的对应隧道也会关闭。" -ForegroundColor Yellow
                        $answer = Read-MenuInput '输入 y 确认删除；其他输入返回列表'
                        if ($answer -eq 'y') { Remove-Tunnels $selection; Wait-Back }
                    } elseif ($operation -eq 'Logs') {
                        Show-Header '错误日志'
                        foreach ($tunnel in $selected) {
                            $paths = Get-TunnelPaths $tunnel
                            Write-Host "  [$($tunnel.Id)] $($tunnel.Name)"
                            if (Test-Path -LiteralPath $paths.ErrorLog) { Get-Content -LiteralPath $paths.ErrorLog -Tail 12 | Out-Host }
                            else { Write-Host '  暂无日志。' }
                        }
                        Wait-Back
                    } else { Invoke-TunnelBatch $selected $operation; Wait-Back }
                }
            }
        } catch { Write-Host "  $($_.Exception.Message)" -ForegroundColor Red; Wait-Back }
    }
}

function Show-AddPage {
    Show-Header '新增映射  /  每一步输入 0 返回首页'
    $newName = Read-MenuInput '映射名称'
    if (Test-Back $newName) { return }
    $newLocal = Read-MenuInput '本机端口，例如 18080'
    if (Test-Back $newLocal) { return }
    $newRemote = Read-MenuInput '服务器端口，例如 8080'
    if (Test-Back $newRemote) { return }
    if ($newLocal -notmatch '^[0-9]{1,5}$' -or $newRemote -notmatch '^[0-9]{1,5}$') { throw '端口必须为 1 至 65535 的整数。' }
    Write-Host ''
    Write-Host '  延迟探测：1 HTTP    2 SOCKS5    3 不探测    Enter 自动'
    $probeChoice = Read-MenuInput '请选择（0 返回）'
    if (Test-Back $probeChoice) { return }
    $probeType = switch ($probeChoice) { '1' { 'Http' }; '2' { 'Socks5' }; '3' { 'None' }; '' { 'Auto' }; default { throw '无效探测类型。' } }
    Add-Tunnel $newName ([int]$newLocal) ([int]$newRemote) $probeType
    Wait-Back
}

try {
    $tunnels = @(Read-TunnelConfig)
    if ($Action -ne 'Menu') {
        switch ($Action) {
            'Status' { Show-Header '已开启的隧道'; Show-Tunnels $tunnels -ActiveOnly }
            'List' { Show-Header '全部映射'; Show-Tunnels $tunnels }
            'Open' { Invoke-TunnelBatch @(Select-Tunnels $tunnels $Ids) 'Open' }
            'Close' { Invoke-TunnelBatch @(Select-Tunnels $tunnels $Ids) 'Close' }
            'OpenAll' { Invoke-TunnelBatch $tunnels 'Open' }
            'CloseAll' { Invoke-TunnelBatch $tunnels 'Close' }
            'Add' { Add-Tunnel $TunnelName $LocalPort $RemotePort $Probe }
            'Remove' { Remove-Tunnels $Ids }
        }
        if ($script:hadFailure) { exit 1 }
        exit 0
    }
    while ($true) {
        $tunnels = @(Read-TunnelConfig)
        Show-Header '已开启的隧道'
        Show-Tunnels $tunnels -ActiveOnly
        Write-Host ''
        Write-Host '  1  开启隧道           2  关闭隧道'
        Write-Host '  3  全部开启           4  全部关闭'
        Write-Host ''
        Write-Host '  5  全部列表 / 搜索    6  查看日志'
        Write-Host '  7  新增映射           8  删除映射'
        Write-Host ''
        Write-Host '  r  刷新               0  退出（保留后台隧道）'
        Write-Host '  快捷：o 1 2 开启 / c 1,2 关闭' -ForegroundColor DarkGray
        $command = Read-MenuInput '请选择'
        if ($command -match '^(0|q)$') { break }
        try {
            if ($command -match '^(o|c)\s+(.+)$') {
                $operation = if ($Matches[1] -eq 'o') { 'Open' } else { 'Close' }
                $selection = $Matches[2]
                Invoke-TunnelBatch @(Select-Tunnels $tunnels $selection) $operation
                Wait-Back
            } else {
                switch ($command) {
                    '1' { Show-ListPage 'Open' }
                    '2' { Show-ListPage 'Close' }
                    { $_ -in @('3', 'a') } {
                        Show-Header '全部开启'
                        Write-Host "  将开启配置列表中的 $($tunnels.Count) 条映射。"
                        if ((Read-MenuInput 'Enter 开启，0 返回') -eq '') { Invoke-TunnelBatch $tunnels 'Open'; Wait-Back }
                    }
                    { $_ -in @('4', 'x') } {
                        Show-Header '全部关闭'
                        Write-Host '  将关闭本工具管理的所有已配置隧道。'
                        if ((Read-MenuInput 'Enter 关闭，0 返回') -eq '') { Invoke-TunnelBatch $tunnels 'Close'; Wait-Back }
                    }
                    '5' { Show-ListPage }
                    '6' { Show-ListPage 'Logs' }
                    '7' { Show-AddPage }
                    '8' { Show-ListPage 'Remove' }
                    'r' { }
                    default { Write-Host '  无效选项。' -ForegroundColor Yellow; Wait-Back }
                }
            }
        } catch { Write-Host "  $($_.Exception.Message)" -ForegroundColor Red; Wait-Back }
    }
    Write-Host '  已退出，后台隧道继续运行。'
} catch {
    Write-Host "错误：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
