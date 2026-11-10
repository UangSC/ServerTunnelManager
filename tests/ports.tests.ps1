#requires -Version 5.1
[CmdletBinding()]
param([switch]$LiveSsh)
$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'Panel\Core.ps1')
$script:passed = 0
function Assert-That([bool]$condition, [string]$message) {
    if (-not $condition) { throw "断言失败：$message" }
    $script:passed++
}

$forward = '127.0.0.1:19090:127.0.0.1:9090'
$destination = 'root@192.0.2.15'
$prefix = '"C:\Windows\System32\OpenSSH\ssh.exe" -N -T -p 22 -i "C:\test keys\id_ed25519" -o BatchMode=yes '
$cases = @(
    @(($prefix + '-L ' + $forward + ' ' + $destination), $true, '完整匹配'),
    @(($prefix + '-L ' + $forward + ' deploy@192.0.2.15'), $false, '不同用户'),
    @(($prefix + '-L ' + $forward + ' root@192.0.2.150'), $false, '地址前缀相同'),
    @(($prefix.Replace('-p 22', '-p 2222') + '-L ' + $forward + ' ' + $destination), $false, '不同 SSH 端口'),
    @(($prefix + '-L ' + $forward + ' -L 127.0.0.1:18317:127.0.0.1:8317 ' + $destination), $false, '同进程多个转发'),
    @(($prefix + '-o LocalForward=18080:localhost:80 -L ' + $forward + ' ' + $destination), $false, '额外隐式转发'),
    @(($prefix + '-L ' + $forward + ' ' + $destination + ' echo hello'), $false, '携带远程命令'),
    @(($prefix + '-L 127.0.0.1:19090:127.0.0.1:9091 ' + $destination), $false, '不同远端服务'),
    @(($prefix + '-o "ProxyCommand=echo ' + $destination + '" -L ' + $forward + ' other@other-host'), $false, '参数中伪装目标')
)
foreach ($case in $cases) {
    $match = Test-SshIdentityMatch (Get-SshIdentity $case[0]) $forward $destination 22
    Assert-That ($match -eq $case[1]) $case[2]
}
Assert-That (Test-ListenerAddressConflict '0.0.0.0' '127.0.0.1') '通配监听冲突'
Assert-That (-not (Test-ListenerAddressConflict '127.0.0.2' '127.0.0.1')) '不同具体地址不误报冲突'
Assert-That (Test-ListenerAddressConflict '::1' 'localhost') 'localhost 包含 IPv6 回环'
Assert-That (Test-ListenerAddressConflict 'localhost' '127.0.0.1') '反向别名冲突也能识别'
Assert-That (Test-SshRetrySupervisor 'pwsh' 'for ($attempt=1; $attempt -le 5; $attempt++) { ssh -N root@host; if($LASTEXITCODE){Start-Sleep -Seconds 3} }') '检测 PowerShell 中的 SSH 重试循环'
Assert-That (-not (Test-SshRetrySupervisor 'pwsh' 'ssh -N root@host')) '单次 SSH 不误报重试'
Assert-That (-not (Test-SshRetrySupervisor 'codex' 'for ($attempt=1; $attempt -le 5; $attempt++) { ssh -N root@host; Start-Sleep -Seconds 3 }')) '不将通用宿主标记为可停止脚本'

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
$sshProcess = $null
$secondListener = $null
$testRuntime = Join-Path ([System.IO.Path]::GetTempPath()) ('tunnel-studio-test-' + [guid]::NewGuid().ToString('N') + '.json')
$script:RuntimePath = $testRuntime
try {
    $listener.Start()
    $testPort = $listener.LocalEndpoint.Port
    $server = [ordered]@{ id = 'test-server'; user = 'root'; host = '192.0.2.15'; port = 22; keyPath = '~/.ssh/id_ed25519' }
    $tunnel = [ordered]@{ id = 'test-tunnel'; name = '端口归属测试'; serverId = $server.id; localHost = '127.0.0.1'; localPort = $testPort; remoteHost = '127.0.0.1'; remotePort = 9090 }
    $script:Config = [ordered]@{ settings = [ordered]@{ simulation = $false }; servers = @($server); tunnels = @($tunnel) }
    $testState = Initialize-TunnelState $tunnel.id
    $portInfo = Get-TunnelPortInfo $tunnel
    Assert-That ($portInfo.kind -eq 'external') '真实非 SSH 监听识别为外部程序'
    Assert-That (@($portInfo.listeners | Where-Object { $_.pid -eq $PID }).Count -eq 1) '返回真实监听 PID'
    Assert-That (Test-LocalListener $tunnel $PID) '正确 PID 拥有监听'
    Assert-That (-not (Test-LocalListener $tunnel ($PID + 100000))) '不能仅因 TCP 可连接就认可其他 PID'
    $listener.Stop()
    Assert-That ((Get-TunnelPortInfo $tunnel).kind -eq 'free') '释放监听后显示空闲'

    if ($LiveSsh) {
        $sshPath = Get-SshPath
        $args = '-N -T -p 22 -o BatchMode=yes -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes -o ConnectTimeout=8 -L ' + (Get-ForwardSpec $tunnel) + ' ' + $destination
        $sshProcess = Start-Process -FilePath $sshPath -ArgumentList $args -WindowStyle Hidden -PassThru
        $deadline = (Get-Date).AddSeconds(12)
        while (-not (Test-LocalListener $tunnel $sshProcess.Id) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 150; $sshProcess.Refresh(); if ($sshProcess.HasExited) { throw '测试 SSH 提前退出' } }
        Assert-That (Test-LocalListener $tunnel $sshProcess.Id) '临时 SSH 真实监听成功'
        Assert-That ((Get-TunnelPortInfo $tunnel).kind -eq 'matching') '相同映射无运行记录时不冒充本项目进程'
        $record = [ordered]@{ pid = $sshProcess.Id; ticks = $sshProcess.StartTime.ToUniversalTime().Ticks.ToString(); forward = Get-ForwardSpec $tunnel; destination = $destination; port = 22; openedAt = To-Iso (NowUtc) }
        $script:ProcessRecords[$tunnel.id] = $record
        Assert-That ((Get-TunnelPortInfo $tunnel).kind -eq 'managed') '有效记录与完整命令匹配'
        Assert-That (Restore-OwnedTunnel $tunnel $record) '恢复既有 SSH 管理成功'
        Assert-That ($testState.pid -eq $sshProcess.Id -and $testState.status -eq 'online') '恢复后使用原 PID'
        $record.openedAt = [DateTime]::UtcNow.AddMinutes(-3)
        Assert-That (Restore-OwnedTunnel $tunnel $record) '支持 JSON 自动解析的时间对象'
        Assert-That ([Math]::Abs(($testState.openedAt - $record.openedAt).TotalSeconds) -lt 1) '重启恢复不产生时区偏移'
        $record.ticks = '1'
        Assert-That (-not (Test-OwnedTunnelRecord $record $tunnel)) '拒绝 PID 复用或错误创建时间'
        Assert-That (-not (Stop-RealTunnel $tunnel $testState)) '错误归属记录不能结束真实 SSH'
        $sshProcess.Refresh()
        Assert-That (-not $sshProcess.HasExited) '拒绝结束后原 SSH 仍运行'
        $record.ticks = $sshProcess.StartTime.ToUniversalTime().Ticks.ToString()
        $script:ProcessRecords = [ordered]@{ 'test-tunnel' = $record }
        Assert-That (Stop-RealTunnel $tunnel $testState) '有效归属记录可正常关闭测试 SSH'
        Assert-That (-not $script:ProcessRecords.Contains($tunnel.id)) '从磁盘恢复的有序字典可正常移除记录'
        $sshProcess.Refresh()
        Assert-That $sshProcess.HasExited '仅测试 SSH 已退出'

        $secondListener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
        $secondListener.Start()
        $secondPort = $secondListener.LocalEndpoint.Port
        $secondListener.Stop()
        $multiArgs = $args.Replace(' ' + $destination, ' -L 127.0.0.1:' + $secondPort + ':127.0.0.1:8317 ' + $destination)
        $sshProcess.Dispose()
        $sshProcess = Start-Process -FilePath $sshPath -ArgumentList $multiArgs -WindowStyle Hidden -PassThru
        $deadline = (Get-Date).AddSeconds(12)
        while (-not (Test-LocalListener $tunnel $sshProcess.Id) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 150; $sshProcess.Refresh(); if ($sshProcess.HasExited) { throw '多转发测试 SSH 提前退出' } }
        Assert-That (Test-LocalListener $tunnel $sshProcess.Id) '多转发临时 SSH 监听成功'
        $record.pid = $sshProcess.Id
        $record.ticks = $sshProcess.StartTime.ToUniversalTime().Ticks.ToString()
        $script:ProcessRecords[$tunnel.id] = $record
        $testState.pid = $sshProcess.Id
        $testState.procStartTicks = $record.ticks
        Assert-That (-not (Test-OwnedTunnelRecord $record $tunnel)) '单条运行记录不能接管多转发进程'
        Assert-That (-not (Stop-RealTunnel $tunnel $testState)) '拒绝因关闭一条映射而结束共享 SSH'
        $sshProcess.Refresh()
        Assert-That (-not $sshProcess.HasExited) '共享 SSH 拒绝结束后仍运行'
    }
    $aliasRejected = $false
    try { Get-TunnelInput @{ name = '别名监听冲突'; serverId = $server.id; localPort = $testPort; remotePort = 80; localHost = 'localhost'; remoteHost = '127.0.0.1' } | Out-Null }
    catch { $aliasRejected = $_.Exception.Message -like '*已被*' }
    Assert-That $aliasRejected '配置校验识别 localhost 与回环地址重复'
} finally {
    $listener.Stop()
    if ($secondListener) { $secondListener.Stop() }
    if ($sshProcess) { $sshProcess.Refresh(); if (-not $sshProcess.HasExited) { $sshProcess.Kill(); $sshProcess.WaitForExit() }; $sshProcess.Dispose() }
    if (Test-Path -LiteralPath $testRuntime) { Remove-Item -LiteralPath $testRuntime -Force }
}
Write-Output "通过 $script:passed 项端口归属断言（真实 SSH：$LiveSsh）。"
