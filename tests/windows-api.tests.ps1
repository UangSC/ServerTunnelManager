#requires -Version 7.0
<#
Windows end-to-end API/CLI test. Run with pwsh.exe, not against a user's
checkout: an explicit source-only whitelist is copied into a unique temp root.
The only configuration is newly-created, empty and simulation=true. A compiled
no-network ssh.exe sentinel is first on the server's PATH as an extra safeguard.
No real keys or production configurations/tunnels are used. System integration
is only queried; no desktop links or startup entries are installed/removed.
All child processes and temporary files are cleaned up.
#>
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw '此端到端测试需要 PowerShell 7.x。' }
$sourceRoot = Split-Path -Parent $PSScriptRoot
$node = Get-Command node.exe -ErrorAction Stop
$powerShell = Join-Path $PSHOME 'pwsh.exe'
$temporary = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('tunnel-studio-api-tests-' + [guid]::NewGuid().ToString('N'))))
$testRoot = Join-Path $temporary 'project with spaces'
$panelDir = Join-Path $testRoot 'Panel'
$serverPath = Join-Path $panelDir 'Server.ps1'
$cliPath = Join-Path $testRoot 'bin/tunnel.mjs'
$guardDir = Join-Path $temporary 'ssh-guard'
$sshMarker = Join-Path $temporary 'unexpected-ssh.txt'
$utf8 = New-Object Text.UTF8Encoding($false)
$serverProcess = $null
$sessionToken = $null
$base = ''
$script:passed = 0

function Assert-Api([bool]$condition, [string]$message) {
    if (-not $condition) { throw ('断言失败：' + $message) }
    $script:passed++
    Write-Output ('通过：' + $message)
}
function Get-FreeLoopbackPort {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try { $listener.Start(); return [int]$listener.LocalEndpoint.Port }
    finally { $listener.Stop() }
}
function Invoke-TestProcess([string]$file, [string[]]$arguments) {
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $file
    foreach ($argument in $arguments) { $start.ArgumentList.Add($argument) }
    $start.WorkingDirectory = $testRoot
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = $utf8
    $start.StandardErrorEncoding = $utf8
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $start
    try {
        [void]$process.Start()
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(60000)) {
            $process.Kill()
            [void]$process.WaitForExit(5000)
            throw '临时CLI子进程超时，已停止该子进程。'
        }
        return [pscustomobject]@{
            code = $process.ExitCode
            stdout = $stdoutTask.GetAwaiter().GetResult()
            stderr = $stderrTask.GetAwaiter().GetResult()
        }
    } finally {
        try { if (-not $process.HasExited) { $process.Kill(); [void]$process.WaitForExit(5000) } } catch { }
        $process.Dispose()
    }
}
function Invoke-TestCli([string[]]$arguments, [switch]$ExpectFailure) {
    $result = Invoke-TestProcess $node.Source (@($cliPath, '--url', $base, '--timeout', '10000') + $arguments)
    if ($sessionToken -and ($result.stdout.Contains($sessionToken) -or $result.stderr.Contains($sessionToken))) {
        throw 'CLI输出包含会话token，已拒绝打印该输出。'
    }
    if ($ExpectFailure) {
        Assert-Api ($result.code -ne 0) '失败API操作产生非零CLI退出码' | Out-Host
        return ConvertFrom-Json -InputObject $result.stderr
    }
    if ($result.code -ne 0) {
        # Never dump stdout (a broken auth-redaction implementation could leak
        # the temporary token). Commands contain only fixture names/paths.
        throw ('Node CLI 失败，exit=' + $result.code + '，命令=' + ($arguments -join ' ') + '，错误=' + $result.stderr)
    }
    return ConvertFrom-Json -InputObject $result.stdout
}
function Wait-TestRuntime([string]$id, [string]$expected) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ($timer.ElapsedMilliseconds -lt 10000) {
        $snapshot = ConvertFrom-Json -InputObject (Invoke-PanelApi $testRoot '/api/state' GET '' $port)
        if (-not $snapshot.simulation) { throw '测试面板离开演示模式，立即取消。' }
        if ($snapshot.runtime.$id.status -eq $expected) { return $snapshot.runtime.$id }
        Start-Sleep -Milliseconds 60
    }
    throw ('临时演示隧道未到达状态：' + $expected)
}

try {
    $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $temporary.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($temporary) -notmatch '^tunnel-studio-api-tests-[a-f0-9]{32}$') {
        throw '临时副本路径检查失败，未开始测试。'
    }
    foreach ($relative in @('Panel/web', 'bin', 'portable/TunnelStudio/bin')) {
        New-Item -ItemType Directory -Path (Join-Path $testRoot $relative) -Force | Out-Null
    }
    New-Item -ItemType Directory -Path $guardDir -Force | Out-Null
    # Never copy directories or wildcard Panel/*: those can include live
    # config/runtime/key material. Only these source files are test inputs.
    foreach ($name in @('Core.ps1', 'Server.ps1', 'Extras.ps1', 'Ports.ps1', 'Sync.ps1', 'Dsh.ps1', 'Http.ps1', 'Shortcuts.ps1', 'ApiClient.ps1')) {
        Copy-Item -LiteralPath (Join-Path (Join-Path $sourceRoot 'Panel') $name) -Destination (Join-Path $panelDir $name)
    }
    foreach ($name in @('Start-Panel.ps1', 'Stop-Panel.ps1')) {
        Copy-Item -LiteralPath (Join-Path $sourceRoot $name) -Destination (Join-Path $testRoot $name)
    }
    foreach ($relative in @('Panel/web/index.html', 'bin/tunnel.mjs', 'bin/api.ps1', 'portable/TunnelStudio/bin/tunnel.mjs')) {
        Copy-Item -LiteralPath (Join-Path $sourceRoot $relative) -Destination (Join-Path $testRoot $relative)
    }
    $version = Invoke-TestProcess $node.Source @('--version')
    Assert-Api ($version.code -eq 0 -and [version]$version.stdout.Trim().TrimStart('v') -ge [version]'22.0.0') 'Node22或更新版本可用'
    $sentinelSource = @'
using System;
using System.IO;
public static class WindowsApiSshSentinel {
    public static int Main(string[] args) {
        string marker = Environment.GetEnvironmentVariable("TUNNEL_STUDIO_TEST_SSH_MARKER");
        if (!String.IsNullOrEmpty(marker)) File.AppendAllText(marker, "blocked SSH invocation\n");
        Console.Error.WriteLine("Real SSH is disabled in this isolated API test.");
        return 97;
    }
}
'@
    # Build a no-network sentinel with the Windows C# compiler; Add-Type on
    # .NET does not emit console executables. Production still uses pwsh only.
    $sentinelFile = Join-Path $guardDir 'sentinel.cs'
    [IO.File]::WriteAllText($sentinelFile, $sentinelSource, $utf8)
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    & $compiler /nologo /target:exe ('/out:' + (Join-Path $guardDir 'ssh.exe')) $sentinelFile
    if ($LASTEXITCODE -ne 0) { throw '无网络 SSH 测试桩编译失败。' }
    $port = Get-FreeLoopbackPort
    $keyFixture = Join-Path $temporary 'not-a-real-key'
    $configPath = Join-Path $panelDir 'config.json'
    $fixture = [ordered]@{
        version = 2
        createdAt = [DateTime]::UtcNow.ToString('o')
        settings = [ordered]@{
            simulation = $true; autoOpenOnLaunch = $false; openBrowserOnStart = $false
            latencyProbe = $false; autoReconnect = $false; panelPort = $port
            defaultUser = 'fixture'; defaultKeyPath = $keyFixture
        }
        servers = @()
        tunnels = @()
    }
    [IO.File]::WriteAllText($configPath, (ConvertTo-Json -InputObject $fixture -Depth 12), $utf8)
    $beforeLaunch = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($configPath, [Text.Encoding]::UTF8))
    Assert-Api ($beforeLaunch.settings.simulation -eq $true -and -not $beforeLaunch.settings.autoOpenOnLaunch -and $beforeLaunch.servers.Count -eq 0 -and $beforeLaunch.tunnels.Count -eq 0) '启动前确认全新空配置且仅演示模式'
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = $powerShell
    foreach ($argument in @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $serverPath, '-Port', [string]$port)) { $start.ArgumentList.Add($argument) }
    $start.WorkingDirectory = $testRoot
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = $utf8
    $start.StandardErrorEncoding = $utf8
    $start.EnvironmentVariables['PATH'] = $guardDir + ';' + $env:PATH
    $start.EnvironmentVariables['TUNNEL_STUDIO_TEST_SSH_MARKER'] = $sshMarker
    $start.EnvironmentVariables['TEMP'] = $temporary
    $start.EnvironmentVariables['TMP'] = $temporary
    $serverProcess = New-Object Diagnostics.Process
    $serverProcess.StartInfo = $start
    [void]$serverProcess.Start()
    $serverOutputTask = $serverProcess.StandardOutput.ReadToEndAsync()
    $serverErrorTask = $serverProcess.StandardError.ReadToEndAsync()
    $base = 'http://127.0.0.1:' + $port
    $ready = $false
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ($timer.ElapsedMilliseconds -lt 20000) {
        $serverProcess.Refresh()
        if ($serverProcess.HasExited) { break }
        try {
            $health = Invoke-RestMethod -Uri ($base + '/api/health') -TimeoutSec 1 -MaximumRedirection 0
            if ($health.ok -and $health.app -eq 'tunnel-studio' -and [int]$health.pid -eq $serverProcess.Id -and [int]$health.port -eq $port) { $ready = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 80
    }
    if (-not $ready) {
        $serverProcess.Refresh()
        $detail = if ($serverProcess.HasExited) { $serverErrorTask.GetAwaiter().GetResult() + $serverOutputTask.GetAwaiter().GetResult() } else { '启动超时。' }
        throw ('隔离Windows面板未健康启动：' + $detail)
    }
    . (Join-Path $panelDir 'ApiClient.ps1')
    $sessionToken = Get-PanelApiToken (Invoke-PanelHttpRequest ([uri]($base + '/')))
    $unauthenticatedRejected = $false
    try { Invoke-PanelHttpRequest ([uri]($base + '/api/settings')) | Out-Null }
    catch { $unauthenticatedRejected = $_.Exception.Message -like 'HTTP 401*' }
    Assert-Api $unauthenticatedRejected '实际Windows API拒绝缺少X-Panel-Token的请求'
    Assert-Api ($health.version -eq '1.5.0') '实际Windows健康接口版本1.5.0'
    Assert-Api ((Invoke-TestCli -arguments @('status')).simulation) '共享Node CLI识别Windows健康接口并读取演示状态'
    Assert-Api ((Invoke-TestCli -arguments @('server', 'list')).servers.Count -eq 0) '共享CLI读取初始空服务器集合'
    Assert-Api ((Invoke-TestCli -arguments @('tunnel', 'list')).tunnels.Count -eq 0) '共享CLI读取初始空隧道集合'
    $server = (Invoke-TestCli -arguments @('server', 'add', '--name', '隔离示例', '--host', '192.0.2.15', '--user', 'fixture', '--key-path', $keyFixture)).server
    Assert-Api (-not $server.passwordless) '新增服务器配置不伪报SSH免密验证成功'
    Assert-Api ((Invoke-TestCli -arguments @('server', 'get', $server.id)).server.name -eq '隔离示例') '共享CLI添加并读取Unicode服务器'
    Invoke-TestCli -arguments @('server', 'update', $server.id, '--note', '仅临时演示') | Out-Null
    Assert-Api ((Invoke-TestCli -arguments @('server', 'get', $server.id)).server.note -eq '仅临时演示') '共享CLI更新服务器'
    $localPort = Get-FreeLoopbackPort
    while ($localPort -eq $port) { $localPort = Get-FreeLoopbackPort }
    $tunnel = (Invoke-TestCli -arguments @('tunnel', 'add', '--name', '临时一', '--server-id', $server.id, '--local-port', [string]$localPort, '--remote-port', '8080', '--probe', 'none', '--auto-open', 'false', '--kind', 'dedicated', '--proxy-account', 'example', '--isp-id', 'ISP-01', '--proxy-exit-ip', '203.0.113.10', '--proxy-route', 'direct')).tunnel
    $otherPort = Get-FreeLoopbackPort
    while ($otherPort -in @($port, $localPort)) { $otherPort = Get-FreeLoopbackPort }
    $other = (Invoke-TestCli -arguments @('tunnel', 'add', '--name', '临时二', '--server-id', $server.id, '--local-port', [string]$otherPort, '--remote-port', '8081', '--probe', 'none', '--auto-open', 'false')).tunnel
    Assert-Api ((Invoke-TestCli -arguments @('tunnel', 'list')).tunnels.Count -eq 2) '共享CLI添加两条演示映射'
    Assert-Api (-not (Invoke-TestCli -arguments @('tunnel', 'get', $tunnel.id)).tunnel.autoOpen) '共享CLI读取单条映射'
    Invoke-TestCli -arguments @('tunnel', 'update', $tunnel.id, '--group', '临时测试') | Out-Null
    Assert-Api ((Invoke-TestCli -arguments @('tunnel', 'get', $tunnel.id)).tunnel.group -eq '临时测试') '共享CLI更新映射'
    Invoke-TestCli -arguments @('settings', 'set', '--theme', 'light', '--simulation', 'true', '--auto-open-on-launch', 'false', '--latency-probe', 'false') | Out-Null
    $dedicated = (Invoke-TestCli -arguments @('tunnel', 'get', $tunnel.id)).tunnel
    Assert-Api ($dedicated.kind -eq 'dedicated' -and $dedicated.proxyAccount -eq 'example' -and $dedicated.ispId -eq 'ISP-01' -and $dedicated.proxyExitIp -eq '203.0.113.10' -and $dedicated.proxyRoute -eq 'direct') '专用隧道元数据经CLI创建和部分更新保持完整'
    Invoke-TestCli -arguments @('tunnel', 'update', $tunnel.id, '--kind', 'invalid') -ExpectFailure | Out-Null
    Invoke-TestCli -arguments @('tunnel', 'update', $tunnel.id, '--proxy-exit-ip', 'invalid') -ExpectFailure | Out-Null
    Invoke-TestCli -arguments @('tunnel', 'update', $tunnel.id, '--proxy-route', 'invalid') -ExpectFailure | Out-Null
    $settings = Invoke-TestCli -arguments @('settings', 'get')
    Assert-Api ($settings.settings.theme -eq 'light' -and $settings.settings.simulation -and -not $settings.settings.autoOpenOnLaunch -and $settings.applicationShortcut.supported) '共享CLI设置读取含系统快捷图标状态且不离开演示模式'
    Assert-Api ($null -eq (Invoke-TestCli -arguments @('api', 'GET', '/api/bootstrap')).PSObject.Properties['token']) '共享CLI不输出Windows bootstrap token'
    $batch = Invoke-TestCli -arguments @('batch', 'open', '--all')
    Assert-Api ($batch.results.Count -eq 2 -and @($batch.results | Where-Object { -not $_.ok }).Count -eq 0) '共享CLI批量开启仅演示隧道'
    $runtime = Wait-TestRuntime $tunnel.id 'online'
    Assert-Api ($null -eq $runtime.pid -and -not (Test-Path -LiteralPath $sshMarker)) '演示online没有SSH PID且sentinel从未被调用'
    Invoke-TestCli -arguments @('batch', 'close', '--all') | Out-Null
    Wait-TestRuntime $tunnel.id 'offline' | Out-Null
    Assert-Api ((Invoke-TestCli -arguments @('status')).simulation) '批量关闭后仍为演示模式'
    $failedBatch = Invoke-TestCli -arguments @('batch', 'close', 'missing-fixture') -ExpectFailure
    Assert-Api ($failedBatch.result.results.Count -eq 1 -and -not $failedBatch.result.results[0].ok) '失败batch返回Windows单项错误并被共享CLI识别'
    $exportPath = Join-Path $temporary 'export.json'
    Invoke-TestCli -arguments @('export', '--out', $exportPath) | Out-Null
    $unsafe = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($exportPath, [Text.Encoding]::UTF8))
    $unsafe.settings.simulation = $false
    $unsafe.settings.autoOpenOnLaunch = $true
    foreach ($item in $unsafe.tunnels) { $item.autoOpen = $true }
    foreach ($item in $unsafe.servers) { $item.passwordless = $true }
    $importPath = Join-Path $temporary 'unsafe-import-fixture.json'
    [IO.File]::WriteAllText($importPath, (ConvertTo-Json -InputObject $unsafe -Depth 16), $utf8)
    $imported = Invoke-TestCli -arguments @('import', '--file', $importPath, '--yes')
    $backup = [IO.Path]::GetFullPath([string]$imported.imported.backup)
    Assert-Api ($backup.StartsWith(([IO.Path]::GetFullPath($panelDir) + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $backup)) '跨设备导入在临时Panel目录备份当前配置'
    $backedUp = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($backup, [Text.Encoding]::UTF8))
    Assert-Api ($backedUp.settings.simulation -and $backedUp.settings.theme -eq 'light' -and $backedUp.tunnels.Count -eq 2) '导入备份保留替换前完整配置而非覆盖后数据'
    $after = Invoke-TestCli -arguments @('api', 'GET', '/api/export')
    Assert-Api ($after.tunnels[0].kind -eq 'dedicated' -and $after.tunnels[0].proxyExitIp -eq '203.0.113.10') '导入归一化保留专用隧道配置'
    Assert-Api ($after.settings.simulation -and -not $after.settings.autoOpenOnLaunch -and @($after.tunnels | Where-Object { $_.autoOpen }).Count -eq 0 -and @($after.servers | Where-Object { $_.passwordless }).Count -eq 0) '导入强制演示且关闭自动开启和密码免登偏好'
    Assert-Api (-not (Test-Path -LiteralPath $sshMarker)) '恶意导入偏好仍不调用任何SSH进程'
    $raw = Invoke-TestProcess $powerShell @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $testRoot 'bin/api.ps1'), '-Path', '/api/settings', '-Port', [string]$port)
    Assert-Api ($raw.code -eq 0 -and (ConvertFrom-Json -InputObject $raw.stdout).settings.simulation -and -not $raw.stdout.Contains($sessionToken)) '无Node PowerShell API辅助可读取同一隔离进程且不输出token'
    Invoke-TestCli -arguments @('tunnel', 'delete', $tunnel.id, '--yes') | Out-Null
    Invoke-TestCli -arguments @('tunnel', 'delete', $other.id, '--yes') | Out-Null
    Invoke-TestCli -arguments @('server', 'delete', $server.id, '--yes') | Out-Null
    Assert-Api ((Invoke-TestCli -arguments @('server', 'list')).servers.Count -eq 0 -and (Invoke-TestCli -arguments @('tunnel', 'list')).tunnels.Count -eq 0) '共享CLI删除资源后集合为空'
    Invoke-TestCli -arguments @('api', 'POST', '/api/shutdown') | Out-Null
    Assert-Api ($serverProcess.WaitForExit(10000) -and $serverProcess.ExitCode -eq 0) 'API shutdown正常关闭实际Windows面板进程'
    Assert-Api (-not (Test-Path -LiteralPath $sshMarker)) '完整CRUD/settings/batch/import过程中没有SSH调用'
    Write-Output ('Windows真实HTTP/共享CLI回归通过：' + $script:passed + ' 项。')
} finally {
    if ($serverProcess) {
        try {
            $serverProcess.Refresh()
            if (-not $serverProcess.HasExited -and $base -and $sessionToken) {
                try { Invoke-PanelHttpRequest ([uri]($base + '/api/shutdown')) POST '{}' $sessionToken | Out-Null } catch { }
                [void]$serverProcess.WaitForExit(5000)
            }
            if (-not $serverProcess.HasExited) { $serverProcess.Kill(); [void]$serverProcess.WaitForExit(5000) }
        } catch { }
        $serverProcess.Dispose()
    }
    $sessionToken = $null
    # The absolute removal target must be our unique test directory, never the
    # checkout, any known-folder, or a path assembled from an unset variable.
    $resolved = [IO.Path]::GetFullPath($temporary)
    $prefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if ($resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($resolved) -match '^tunnel-studio-api-tests-[a-f0-9]{32}$' -and (Test-Path -LiteralPath $resolved)) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
