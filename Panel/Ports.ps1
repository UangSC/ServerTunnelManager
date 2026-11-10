#requires -Version 7.0
# 本机监听归属诊断。未记录的 SSH 即使映射相同，也不自动接管或结束。
function Split-NativeCommandLine([string]$commandLine) {
    if (-not ('TunnelStudio.NativeArgs' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace TunnelStudio {
    public static class NativeArgs {
        [DllImport("shell32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
        private static extern IntPtr CommandLineToArgvW(string command, out int count);
        [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr pointer);
        public static string[] Split(string command) {
            int count; IntPtr pointer = CommandLineToArgvW(command, out count);
            if (pointer == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
            try {
                string[] result = new string[count];
                for (int i=0; i<count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer, i * IntPtr.Size));
                return result;
            } finally { LocalFree(pointer); }
        }
    }
}
'@ | Out-Null
    }
    return [TunnelStudio.NativeArgs]::Split($commandLine)
}

function Get-SshIdentity([string]$commandLine) {
    $result = [ordered]@{ valid = $false; forwards = @(); destination = ''; port = 22 }
    if (-not $commandLine) { return $result }
    $argv = @(Split-NativeCommandLine $commandLine)
    for ($i = 1; $i -lt $argv.Count; $i++) {
        $arg = $argv[$i]
        if ($arg -in @('-N', '-T', '-n', '-f')) { continue }
        if ($arg -in @('-L', '-p', '-i', '-o')) {
            $i++
            if ($i -ge $argv.Count) { return $result }
            $value = $argv[$i]
            switch ($arg) {
                '-L' { $result.forwards += $value }
                '-p' { if (-not (Test-PortValue $value)) { return $result }; $result.port = [int]$value }
                '-o' {
                    # 只识别本项目生成的参数；配置中的隐式转发、连接复用等不推断为独立隧道。
                    if ($value -notmatch '^(BatchMode|StrictHostKeyChecking|IdentitiesOnly|ExitOnForwardFailure|ConnectTimeout|ServerAliveInterval|ServerAliveCountMax)=') { return $result }
                }
            }
            continue
        }
        if ($arg.StartsWith('-') -or $result.destination) { return $result }
        $result.destination = $arg
    }
    $result.valid = [bool]$result.destination -and $result.forwards.Count -gt 0
    return $result
}

function Test-SshIdentityMatch($identity, [string]$forward, [string]$destination, [int]$port) {
    return ($identity.valid -and $identity.forwards.Count -eq 1 -and
        $identity.forwards[0] -ceq $forward -and $identity.destination -ceq $destination -and [int]$identity.port -eq $port)
}

function Test-ListenerAddressConflict([string]$bound, [string]$requested) {
    if ($bound -eq $requested -or $bound -eq '::' -or $requested -eq '::') { return $true }
    if ($bound -eq 'localhost') { return Test-ListenerAddressConflict $requested $bound }
    if ($requested -eq 'localhost') { return $bound -in @('127.0.0.1', '::1', '0.0.0.0') }
    if ($bound -eq '0.0.0.0' -or $requested -eq '0.0.0.0') { return (-not $bound.Contains(':') -and -not $requested.Contains(':')) }
    try {
        return [bool](@([System.Net.Dns]::GetHostAddresses($requested) | ForEach-Object { $_.ToString() }) -contains $bound)
    } catch { return $false }
}

function Get-PortListeners([int]$port, [string]$localHost) {
    # 先查监听表再筛选，避免将“没有匹配项”的 cmdlet 错误与查询失败混淆。
    $all = @(Get-NetTCPConnection -State Listen -ErrorAction Stop)
    return @($all | Where-Object { $_.LocalPort -eq $port -and (Test-ListenerAddressConflict ([string]$_.LocalAddress) $localHost) })
}

function Test-OwnedTunnelRecord($record, $tunnel) {
    if (-not $record -or -not $record.ticks -or -not (Test-ProcessRecord $record)) { return $false }
    $server = Get-Server $tunnel.serverId
    if (-not $server -or $record.forward -cne (Get-ForwardSpec $tunnel) -or $record.destination -cne "$($server.user)@$($server.host)") { return $false }
    try {
        $info = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$record.pid)" -ErrorAction Stop
        return (Test-SshIdentityMatch (Get-SshIdentity $info.CommandLine) $record.forward $record.destination ([int]$server.port)) -and (Test-LocalListener $tunnel $record.pid)
    } catch { return $false }
}

function Restore-OwnedTunnel($tunnel, $record) {
    if (-not (Test-OwnedTunnelRecord $record $tunnel)) { return $false }
    $state = Get-TunnelState $tunnel.id
    $state.status = 'online'
    $state.pid = [int]$record.pid
    $state.procStartTicks = [string]$record.ticks
    # PowerShell 7 会把 JSON 时间直接读成 DateTime，不能再转字符串解析而丢失时区。
    $state.openedAt = if ($record.openedAt -is [DateTime]) { $record.openedAt.ToUniversalTime() } elseif ($record.openedAt) { [DateTimeOffset]::Parse([string]$record.openedAt).UtcDateTime } else { NowUtc }
    $state.statusChanged = NowUtc
    $state.error = ''
    $state.retryAt = $null
    $record['port'] = [int](Get-Server $tunnel.serverId).port
    $script:ProcessRecords[$tunnel.id] = $record
    Add-Log info $tunnel.name "已恢复本项目记录的 SSH 隧道 (PID $($record.pid))"
    Add-Activity -Kind 'info' -Title '恢复隧道' -Detail "$($tunnel.name) · 已核对进程创建时间、SSH 目标和转发规则" -TunnelId $tunnel.id
    return $true
}

function Test-SshRetrySupervisor([string]$processName, [string]$commandLine) {
    return ($processName -in @('pwsh', 'powershell') -and
        $commandLine -match '(?is)\b(for|foreach|while|do)\s*[({]' -and
        $commandLine -match '(?i)\bssh(?:\.exe)?\s+-' -and
        $commandLine -match '(?i)Start-Sleep|LASTEXITCODE|\bretry\b')
}

function Get-ListenerParent($processInfo) {
    if (-not $processInfo -or -not $processInfo.ParentProcessId) { return $null }
    try {
        $parentInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$processInfo.ParentProcessId)" -ErrorAction Stop
        if (-not $parentInfo -or $parentInfo.CreationDate -gt $processInfo.CreationDate) { return $null }
        $parentName = [System.IO.Path]::GetFileNameWithoutExtension([string]$parentInfo.Name)
        return [ordered]@{
            pid = [int]$parentInfo.ProcessId
            name = $parentName
            retryDetected = Test-SshRetrySupervisor $parentName ([string]$parentInfo.CommandLine)
        }
    } catch { return $null }
}

function Get-TunnelPortInfo($tunnel) {
    $server = Get-Server $tunnel.serverId
    $items = @()
    try { $listeners = @(Get-PortListeners ([int]$tunnel.localPort) ([string]$tunnel.localHost)) }
    catch { return [ordered]@{ kind = 'unknown'; message = '无法读取本机监听表，请检查权限或系统网络组件。'; listeners = @() } }
    foreach ($listener in $listeners) {
        $ownerId = [int]$listener.OwningProcess
        $kind = 'external'
        $name = '未知进程'
        $startedTicks = ''
        $parent = $null
        $detail = '其他程序占用，面板不会结束该进程。'
        try {
            $process = Get-Process -Id $ownerId -ErrorAction Stop
            $name = $process.ProcessName
            $startedTicks = $process.StartTime.ToUniversalTime().Ticks.ToString()
            if ($name -eq 'ssh') {
                $info = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerId" -ErrorAction Stop
                $parent = Get-ListenerParent $info
                $identity = Get-SshIdentity $info.CommandLine
                $same = $identity.valid -and $identity.forwards -ccontains (Get-ForwardSpec $tunnel) -and $identity.destination -ceq "$($server.user)@$($server.host)" -and $identity.port -eq [int]$server.port
                $record = $script:ProcessRecords[$tunnel.id]
                if ($record -and [int]$record.pid -eq $ownerId -and (Test-OwnedTunnelRecord $record $tunnel)) {
                    $kind = 'managed'; $detail = '本项目有有效运行记录，可恢复管理。'
                } elseif ($same) {
                    $kind = 'matching'; $detail = 'SSH 目标及映射相同，但没有本项目的有效归属记录，无法证明来自上次运行；不会自动接管或结束。'
                    if ($identity.forwards.Count -gt 1) { $detail += " 该进程同时配置了 $($identity.forwards.Count) 条转发。" }
                } else {
                    $detail = '独立 SSH 会话：用户、服务器、端口或转发规则不匹配；也可能同时承载其他转发。'
                    if ($identity.valid) { $detail += " SSH 目标：$($identity.destination):$($identity.port)，共 $($identity.forwards.Count) 条转发。" }
                }
            }
        } catch { $kind = 'unknown'; $detail = '无法完整读取进程信息，不能判断归属；不会结束该进程。' }
        $items += [ordered]@{ pid = $ownerId; name = $name; startedTicks = $startedTicks; parent = $parent; address = [string]$listener.LocalAddress; kind = $kind; detail = $detail }
    }
    $kind = 'free'
    if ($items.Count -gt 0) {
        $kind = if (@($items | Where-Object { $_.kind -ne 'managed' }).Count -eq 0) { 'managed' } elseif (@($items | Where-Object { $_.kind -eq 'unknown' }).Count) { 'unknown' } elseif (@($items | Where-Object { $_.kind -eq 'matching' }).Count) { 'matching' } else { 'external' }
    }
    return [ordered]@{ kind = $kind; message = if ($kind -eq 'free') { '端口当前空闲。' } elseif ($kind -eq 'managed') { '该监听属于本项目已记录的隧道。' } else { '已找到冲突的本机监听。' }; listeners = $items }
}
