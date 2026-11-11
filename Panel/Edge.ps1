#requires -Version 7.0
# 本机 Edge 集成。管理记录与浏览器文件分开保存，演示模式完全隔离。

function Test-EdgeSimulation { return (To-Bool (Get-Setting 'simulation' $true) $true) }
function Get-EdgeRecordsPath {
    if (Test-EdgeSimulation) { return Join-Path $script:PanelDir 'edge-profiles.demo.json' }
    return Join-Path $script:PanelDir 'edge-profiles.json'
}
function Get-EdgeUserDataPath {
    if (Test-EdgeSimulation) { return Join-Path $script:PanelDir 'edge-simulation/User Data' }
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw '找不到 Windows 本地应用数据目录。' }
    return Join-Path $env:LOCALAPPDATA 'Microsoft/Edge/User Data'
}
function Get-EdgeExecutable {
    foreach ($base in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA)) {
        if (-not $base) { continue }
        $file = Join-Path $base 'Microsoft/Edge/Application/msedge.exe'
        if (Test-Path -LiteralPath $file -PathType Leaf) { return $file }
    }
    throw '找不到 Microsoft Edge。'
}
function Test-EdgeRunning {
    if (Test-EdgeSimulation) { return $false }
    return [bool](Get-Process msedge -ErrorAction SilentlyContinue)
}
function Assert-EdgePath([string]$path) {
    $current = [IO.Path]::GetFullPath($path)
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Edge 配置路径不能包含链接或重解析点。' }
        }
        $current = [IO.Path]::GetDirectoryName($current)
    }
}
function Get-EdgePreferencesPath([string]$directory) {
    if ($directory -cnotmatch '^(Default|Profile [1-9][0-9]{0,8})$') { throw 'Edge Profile 目录无效。' }
    $target = Join-Path (Get-EdgeUserDataPath) "$directory/Preferences"
    Assert-EdgePath $target
    return $target
}
function Read-EdgeJson([string]$path) {
    Assert-EdgePath $path
    if (-not (Test-Path -LiteralPath $path)) { return [ordered]@{} }
    try {
        $data = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($path)) -AsHashtable -Depth 100
        if ($data -isnot [System.Collections.IDictionary]) { throw 'JSON 必须为对象。' }
        return $data
    } catch { throw "读取 Edge 配置失败：$path — $($_.Exception.Message)" }
}
function Write-EdgeJson([string]$path, $value) {
    Assert-EdgePath $path
    # Edge 的 Preferences 比普通项目配置更深，禁止以项目默认深度截断。
    $json = ConvertTo-Json -InputObject $value -Depth 100 -WarningAction Stop
    Ensure-Directory ([IO.Path]::GetDirectoryName($path))
    $temporary = $path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
        if (Test-Path -LiteralPath $path) { [IO.File]::Move($temporary, $path, $true) }
        else { [IO.File]::Move($temporary, $path) }
    } finally { if (Test-Path -LiteralPath $temporary) { [IO.File]::Delete($temporary) } }
}
function Get-EdgeRecords {
    $value = Read-EdgeJson (Get-EdgeRecordsPath)
    if ($value.Contains('profiles')) { return @(As-Array $value.profiles) }
    return @()
}
function Save-EdgeRecords($records) {
    Write-EdgeJson (Get-EdgeRecordsPath) ([ordered]@{ version=1; profiles=@($records) })
}
function Get-EdgeProfile([string]$id) {
    $record = @(Get-EdgeRecords | Where-Object { $_.id -eq $id })[0]
    if (-not $record) { throw '浏览器配置不存在。' }
    return $record
}
function Get-EdgeTunnel($record) {
    $tunnel = Get-Tunnel ([string]$record.tunnelId)
    if ($tunnel -and $tunnel.kind -eq 'dedicated' -and $tunnel.localHost -in @('127.0.0.1', 'localhost', '0.0.0.0')) { return $tunnel }
    return $null
}
function Get-EdgeProxy($tunnel) {
    return [ordered]@{ mode='fixed_servers'; server="http://127.0.0.1:$($tunnel.localPort)"; bypass_list='localhost;127.0.0.1;[::1]' }
}
function Import-EdgeProfiles {
    $records = @(Get-EdgeRecords)
    $state = Read-EdgeJson (Join-Path (Get-EdgeUserDataPath) 'Local State')
    $tunnels = @(Get-Tunnels | Where-Object { $_.kind -eq 'dedicated' -and $_.localHost -in @('127.0.0.1', 'localhost', '0.0.0.0') })
    if ($state.profile.info_cache -is [System.Collections.IDictionary]) {
        foreach ($directory in $state.profile.info_cache.Keys) {
            if ($directory -cnotmatch '^(Default|Profile [1-9][0-9]{0,8})$' -or $directory -in $records.profileDirectory) { continue }
            $prefs = Read-EdgeJson (Get-EdgePreferencesPath $directory)
            # 仅接管明确指向本机 HTTP 专用隧道的配置，不能只凭端口匹配远程代理。
            if ($prefs.proxy.mode -ne 'fixed_servers' -or [string]$prefs.proxy.server -notmatch '^(?:http://)?127\.0\.0\.1:([0-9]{1,5})$') { continue }
            $port = [int]$Matches[1]
            $tunnel = @($tunnels | Where-Object { [int]$_.localPort -eq $port })[0]
            if (-not $tunnel) { continue }
            $name = [string]$state.profile.info_cache[$directory].name
            if (-not $name) { $name = $tunnel.proxyExitIp; if (-not $name) { $name = $tunnel.name } }
            $records += [ordered]@{ id=(New-Id 'bp-'); name=$name; tunnelId=$tunnel.id; enabled=$true; profileDirectory=$directory; createdAt=(To-Iso (NowUtc)); updatedAt=(To-Iso (NowUtc)) }
        }
    }
    Save-EdgeRecords $records
    return $records
}
function Get-EdgeProfiles {
    if (-not (Test-Path -LiteralPath (Get-EdgeRecordsPath))) { Import-EdgeProfiles | Out-Null }
    $state = Read-EdgeJson (Join-Path (Get-EdgeUserDataPath) 'Local State')
    $running = Test-EdgeRunning
    foreach ($record in @(Get-EdgeRecords)) {
        $copy = [ordered]@{}
        foreach ($key in $record.Keys) { $copy[$key] = $record[$key] }
        if (-not $copy.Contains('enabled')) { $copy.enabled = $true }
        $tunnel = Get-EdgeTunnel $record
        $copy.tunnel = if ($tunnel) { [ordered]@{ id=$tunnel.id; name=$tunnel.name; ispId=$tunnel.ispId; localPort=[int]$tunnel.localPort; proxyExitIp=$tunnel.proxyExitIp } } else { $null }
        $copy.running = $running
        $copy.pending = $false
        $copy.error = ''
        try {
            $prefs = Read-EdgeJson (Get-EdgePreferencesPath $record.profileDirectory)
            if ($tunnel -and $copy.enabled) {
                $proxy = Get-EdgeProxy $tunnel
                $actualName = if ($state.profile.info_cache) { $state.profile.info_cache[$record.profileDirectory].name } else { $null }
                $copy.pending = ($actualName -cne $record.name -or $prefs.profile.name -cne $record.name -or $prefs.proxy.mode -ne $proxy.mode -or $prefs.proxy.server -ne $proxy.server -or $prefs.proxy.bypass_list -ne $proxy.bypass_list)
            }
        } catch { $copy.pending = $true; $copy.error = $_.Exception.Message }
        $copy
    }
}
function Get-EdgeProfileStatus {
    try { return [ordered]@{ supported=$true; running=(Test-EdgeRunning); simulation=(Test-EdgeSimulation); profiles=@(Get-EdgeProfiles); error='' } }
    catch { return [ordered]@{ supported=$true; running=(Test-EdgeRunning); simulation=(Test-EdgeSimulation); profiles=@(); error=$_.Exception.Message } }
}
function Get-EdgeProfileInput($body, $existing=$null) {
    if ($body -isnot [System.Collections.IDictionary]) { throw '浏览器配置参数必须是 JSON 对象。' }
    foreach ($key in $body.Keys) { if ($key -notin @('name','tunnelId','enabled')) { throw "不支持的浏览器配置字段：$key" } }
    $tunnelId = if ($body.Contains('tunnelId')) { $body.tunnelId } elseif ($existing) { $existing.tunnelId } else { '' }
    if ($tunnelId -isnot [string]) { throw '隧道 ID 必须是字符串。' }
    $tunnel = Get-EdgeTunnel @{ tunnelId=$tunnelId }
    if ($tunnelId -and -not $tunnel) { throw '请选择绑定本机 IPv4 端口的有效专用隧道。' }
    $name = if ($body.Contains('name')) { $body.name } elseif ($existing) { $existing.name } else { '' }
    if ($name -isnot [string]) { throw '浏览器配置名称必须是字符串。' }
    if (-not $name.Trim() -and $tunnel) { $name = [string]$tunnel.proxyExitIp; if (-not $name) { $name = [string]$tunnel.name } }
    if (-not $name.Trim() -or $name.Length -gt 80 -or $name -match '[\x00-\x1f\x7f]') { throw '浏览器配置名称无效。' }
    $existingId = if ($existing) { [string]$existing.id } else { '' }
    if ($tunnelId -and @(Get-EdgeRecords | Where-Object { $_.id -ne $existingId -and $_.tunnelId -eq $tunnelId }).Count) { throw '该专用隧道已经绑定浏览器配置。' }
    $enabled = if ($body.Contains('enabled')) { $body.enabled } elseif ($existing -and $existing.Contains('enabled')) { $existing.enabled } else { $true }
    if ($enabled -isnot [bool]) { throw '启用状态必须为布尔值。' }
    return [ordered]@{ name=$name.Trim(); tunnelId=$tunnelId; enabled=$enabled }
}
function Add-EdgeProfile($body) {
    if (-not (Test-Path -LiteralPath (Get-EdgeRecordsPath))) { Import-EdgeProfiles | Out-Null }
    $input = Get-EdgeProfileInput $body
    if (-not $input.tunnelId) { throw '新建配置时请选择专用隧道。' }
    $records = @(Get-EdgeRecords)
    $root = Get-EdgeUserDataPath
    $state = Read-EdgeJson (Join-Path $root 'Local State')
    $used = @($records.profileDirectory)
    if ($state.profile.info_cache -is [System.Collections.IDictionary]) { $used += @($state.profile.info_cache.Keys) }
    $number = 1
    while ("Profile $number" -in $used -or (Test-Path -LiteralPath (Join-Path $root "Profile $number"))) { $number++ }
    $record = [ordered]@{ id=(New-Id 'bp-'); name=$input.name; tunnelId=$input.tunnelId; enabled=$input.enabled; profileDirectory="Profile $number"; createdAt=(To-Iso (NowUtc)); updatedAt=(To-Iso (NowUtc)) }
    Save-EdgeRecords ($records + @($record))
    return $record
}
function Update-EdgeProfile([string]$id, $body) {
    $records = @(Get-EdgeRecords)
    $record = @($records | Where-Object { $_.id -eq $id })[0]
    if (-not $record) { throw '浏览器配置不存在。' }
    $input = Get-EdgeProfileInput $body $record
    foreach ($key in $input.Keys) { $record[$key] = $input[$key] }
    $record.updatedAt = To-Iso (NowUtc)
    Save-EdgeRecords $records
    return $record
}
function Apply-EdgeProfile([string]$id) {
    $record = Get-EdgeProfile $id
    if ($record.Contains('enabled') -and -not $record.enabled) { throw '该浏览器配置已停用管理。' }
    $tunnel = Get-EdgeTunnel $record
    if (-not $tunnel) { throw '配置未绑定有效的专用隧道，无法应用或打开。' }
    if (Test-EdgeRunning) { throw '修改已保存在面板。请关闭所有 Edge 窗口及后台进程，再点击应用或打开。' }
    $prefsPath = Get-EdgePreferencesPath $record.profileDirectory
    $statePath = Join-Path (Get-EdgeUserDataPath) 'Local State'
    $prefs = Read-EdgeJson $prefsPath
    $state = Read-EdgeJson $statePath
    $prefs.proxy = Get-EdgeProxy $tunnel
    if (-not $prefs.profile) { $prefs.profile = [ordered]@{} }
    $prefs.profile.name = $record.name
    $prefs.profile.is_using_default_name = $false
    if (-not $state.profile) { $state.profile = [ordered]@{} }
    if (-not $state.profile.info_cache) { $state.profile.info_cache = [ordered]@{} }
    $cache = $state.profile.info_cache
    if (-not $cache.Contains($record.profileDirectory)) { $cache[$record.profileDirectory] = [ordered]@{ avatar_icon='chrome://theme/IDR_PROFILE_AVATAR_0'; user_name=''; is_ephemeral=$false; is_omitted_from_profile_list=$false } }
    $cache[$record.profileDirectory].name = $record.name
    $cache[$record.profileDirectory].shortcut_name = $record.name
    $cache[$record.profileDirectory].is_using_default_name = $false
    # 写入前校验完整序列化，并为两个文件建立同一批次的可恢复备份。
    $null = ConvertTo-Json -InputObject $prefs -Depth 100 -WarningAction Stop
    $null = ConvertTo-Json -InputObject $state -Depth 100 -WarningAction Stop
    $backup = Join-Path $script:PanelDir ('backups/edge-' + [guid]::NewGuid().ToString('N'))
    Assert-EdgePath $backup
    Ensure-Directory $backup
    $originals = @{}
    foreach ($file in @($prefsPath, $statePath)) {
        $originals[$file] = Test-Path -LiteralPath $file
        if ($originals[$file]) { [IO.File]::Copy($file, (Join-Path $backup ([IO.Path]::GetFileName($file)))) }
    }
    if (Test-EdgeRunning) { throw 'Edge 已启动，应用已取消；面板记录仍保留。' }
    try {
        Write-EdgeJson $prefsPath $prefs
        Write-EdgeJson $statePath $state
    } catch {
        foreach ($file in @($prefsPath, $statePath)) {
            if ($originals[$file]) { [IO.File]::Copy((Join-Path $backup ([IO.Path]::GetFileName($file))), $file, $true) }
            elseif (Test-Path -LiteralPath $file) { [IO.File]::Delete($file) }
        }
        throw
    }
    return $record
}
function Remove-EdgeProfile([string]$id) {
    $record = Get-EdgeProfile $id
    Save-EdgeRecords @(Get-EdgeRecords | Where-Object { $_.id -ne $id })
    return $record
}
function Open-EdgeProfile([string]$id) {
    if (Test-EdgeSimulation) { throw '演示模式不启动真实浏览器。' }
    $record = Get-EdgeProfile $id
    if ($record.Contains('enabled') -and -not $record.enabled) { throw '该浏览器配置已停用管理。' }
    $tunnel = Get-EdgeTunnel $record
    if (-not $tunnel) { throw '配置未绑定有效的专用隧道，无法应用或打开。' }
    $status = @(Get-EdgeProfiles | Where-Object { $_.id -eq $id })[0]
    if ($status.pending) { Apply-EdgeProfile $id | Out-Null }
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = Get-EdgeExecutable
    $start.UseShellExecute = $false
    $start.ArgumentList.Add('--profile-directory=' + $record.profileDirectory)
    $start.ArgumentList.Add('about:blank')
    $process = [Diagnostics.Process]::Start($start)
    $process.Dispose()
    return $record
}
function Sync-EdgeProfilesForTunnel($tunnel) {
    try {
        if (Test-EdgeRunning) { return }
        foreach ($record in @(Get-EdgeRecords | Where-Object { $_.tunnelId -eq $tunnel.id -and $_.enabled -ne $false })) {
            Apply-EdgeProfile $record.id | Out-Null
        }
    } catch { Add-Log warn 'panel' "Edge 配置等待应用：$($_.Exception.Message)" }
}
