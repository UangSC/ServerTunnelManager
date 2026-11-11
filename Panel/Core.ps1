#requires -Version 7.0
# ============================================================
#  Tunnel Studio - core engine
#  Config store, runtime state, tunnel operations, metrics.
#  Requires PowerShell 7.x on Windows
# ============================================================

$ErrorActionPreference = 'Stop'

$script:AppName = 'tunnel-studio'
$script:AppVersion = '1.5.0'
$script:PanelDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$script:RootDir = Split-Path -Parent $script:PanelDir
$script:WebDir = Join-Path $script:PanelDir 'web'
$script:ConfigPath = Join-Path $script:PanelDir 'config.json'
$script:LogDir = Join-Path $script:PanelDir 'logs'
$script:RuntimePath = Join-Path $script:PanelDir 'runtime.json'
$script:PidPath = Join-Path $script:PanelDir 'panel.pid.json'
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$script:LogBuffer = New-Object System.Collections.ArrayList
$script:ActivityBuffer = New-Object System.Collections.ArrayList
$script:State = @{}
$script:ProcessRecords = @{}
$script:PasswordJobs = @{}
$script:PasswordSecrets = @{}
$script:MetricsHistory = New-Object System.Collections.ArrayList
$script:LogCounter = 0
$script:ActivityCounter = 0
$script:StartedAt = [DateTime]::UtcNow
$script:Config = $null
$script:Token = ''
$script:LastRateAt = [DateTime]::UtcNow
$script:LastRateBytes = 0
$script:CurrentRate = 0
$script:LastHistoryAt = [DateTime]::MinValue
$script:ShutdownRequested = $false
$script:LastSettingsSave = [DateTime]::MinValue
. (Join-Path $script:PanelDir 'Ports.ps1')

# ------------------------------------------------------------
#  Basic helpers
# ------------------------------------------------------------

function NowUtc {
    return [DateTime]::UtcNow
}

function To-Iso($value) {
    if ($null -eq $value) { return $null }
    if ($value -is [string]) { return $value }
    try { return ([DateTime]$value).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture) }
    catch { return $null }
}

function New-Id([string]$prefix, [int]$length = 8) {
    return $prefix + [guid]::NewGuid().ToString('N').Substring(0, $length)
}

function New-Token {
    $bytes = New-Object byte[] 24
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

function Ensure-Directory([string]$path) {
    if (-not [string]::IsNullOrWhiteSpace($path) -and -not (Test-Path -LiteralPath $path)) {
        New-Item -ItemType Directory -Force -Path $path | Out-Null
    }
}

function As-Array($value) {
    if ($null -eq $value) { return @() }
    if ($value -is [System.Array]) { return $value }
    if ($value -is [System.Collections.IList] -and -not ($value -is [string])) { return @($value) }
    return @($value)
}

function Add-RingItem($list, $item, [int]$max) {
    [void]$list.Add($item)
    while ($list.Count -gt $max) { $list.RemoveAt(0) }
}

function ConvertTo-Data($value) {
    if ($null -eq $value) { return $null }
    if ($value -is [string] -or $value -is [ValueType]) { return $value }
    if ($value -is [System.Management.Automation.PSCustomObject]) {
        $table = [ordered]@{}
        foreach ($property in $value.PSObject.Properties) {
            $table[$property.Name] = ConvertTo-Data $property.Value
        }
        return $table
    }
    if ($value -is [System.Collections.IDictionary]) {
        $table = [ordered]@{}
        foreach ($key in $value.Keys) { $table[$key] = ConvertTo-Data $value[$key] }
        return $table
    }
    if ($value -is [System.Collections.IEnumerable]) {
        $items = New-Object System.Collections.ArrayList
        foreach ($item in $value) { [void]$items.Add((ConvertTo-Data $item)) }
        return ,$items.ToArray()
    }
    return $value
}

function Read-JsonFile([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try {
        $raw = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
        if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
        return ConvertTo-Data (ConvertFrom-Json -InputObject $raw)
    } catch {
        throw "读取 JSON 失败：$path — $($_.Exception.Message)"
    }
}

function Write-JsonFile([string]$path, $value, [switch]$Compress) {
    $json = if ($Compress) { ConvertTo-Json -InputObject $value -Depth 14 -Compress } else { ConvertTo-Json -InputObject $value -Depth 14 }
    $temporary = "$path." + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [System.IO.File]::WriteAllText($temporary, $json, $script:Utf8NoBom)
        if (Test-Path -LiteralPath $path) {
            try { [System.IO.File]::Replace($temporary, $path, "$path.bak") }
            catch {
                [System.IO.File]::Copy($temporary, $path, $true)
                [System.IO.File]::Delete($temporary)
            }
        } else {
            [System.IO.File]::Move($temporary, $path)
        }
    } finally {
        if (Test-Path -LiteralPath $temporary) {
            try { [System.IO.File]::Delete($temporary) } catch { }
        }
    }
}

function To-Bool($value, [bool]$default = $false) {
    if ($null -eq $value) { return $default }
    if ($value -is [bool]) { return $value }
    return [bool]([string]$value -match '^(?i:1|true|yes|on)$')
}

function Test-PortValue($value) {
    $number = 0
    if (-not [int]::TryParse([string]$value, [ref]$number)) { return $false }
    return ($number -ge 1 -and $number -le 65535)
}

function Format-Bytes([double]$bytes) {
    if ($bytes -lt 1024) { return ('{0} B' -f [math]::Round($bytes)) }
    if ($bytes -lt 1048576) { return ('{0:0.0} KB' -f ($bytes / 1024)) }
    if ($bytes -lt 1073741824) { return ('{0:0.0} MB' -f ($bytes / 1048576)) }
    return ('{0:0.00} GB' -f ($bytes / 1073741824))
}

# ------------------------------------------------------------
#  Logging and activity
# ------------------------------------------------------------

function Get-LogFilePath {
    return Join-Path $script:LogDir ('panel-' + (Get-Date).ToString('yyyyMMdd') + '.log')
}

function Add-Log {
    param(
        [ValidateSet('debug', 'info', 'warn', 'error', 'success')]
        [string]$Level = 'info',
        [string]$Source = 'panel',
        [string]$Text = '',
        [string]$TunnelId = '',
        [switch]$NoFile
    )
    $script:LogCounter++
    $entry = [ordered]@{
        id       = $script:LogCounter
        ts       = To-Iso (NowUtc)
        level    = $Level
        source   = $Source
        tunnelId = $TunnelId
        text     = $Text
    }
    Add-RingItem $script:LogBuffer $entry 2400
    if (-not $NoFile) {
        try {
            Ensure-Directory $script:LogDir
            $line = '[' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '] [' + $Level.ToUpperInvariant() + '] [' + $Source + '] ' + $Text + [Environment]::NewLine
            [System.IO.File]::AppendAllText((Get-LogFilePath), $line, $script:Utf8NoBom)
        } catch { }
    }
}

function Add-Activity {
    param(
        [ValidateSet('info', 'success', 'warning', 'error')]
        [string]$Kind = 'info',
        [string]$Title = '',
        [string]$Detail = '',
        [string]$TunnelId = ''
    )
    $script:ActivityCounter++
    $entry = [ordered]@{
        id       = $script:ActivityCounter
        ts       = To-Iso (NowUtc)
        kind     = $Kind
        title    = $Title
        detail   = $Detail
        tunnelId = $TunnelId
    }
    Add-RingItem $script:ActivityBuffer $entry 160
}

# ------------------------------------------------------------
#  Config: defaults, migration, settings
# ------------------------------------------------------------

function New-DefaultSettings {
    return [ordered]@{
        theme                 = 'dark'
        accent                = 'violet'
        simulation            = $true
        refreshMs             = 1500
        latencyProbe          = $true
        autoReconnect         = $true
        confirmDelete         = $true
        autoOpenOnLaunch      = $false
        panelPort             = 9666
        defaultUser           = 'root'
        defaultPort           = 22
        defaultKeyPath        = '~/.ssh/id_ed25519'
        connectTimeout        = 10
        serverAliveInterval   = 30
        serverAliveCountMax   = 3
        strictHostKeyChecking = $true
        openBrowserOnStart    = $true
        logRetention          = 2000
    }
}

function New-DefaultConfig {
    $now = To-Iso (NowUtc)
    return [ordered]@{
        version   = 2
        createdAt = $now
        updatedAt = $now
        settings  = New-DefaultSettings
        servers   = @()
        tunnels   = @()
    }
}

function Get-Setting([string]$name, $fallback = $null) {
    if ($null -eq $script:Config) { return $fallback }
    $settings = $script:Config.settings
    if ($null -eq $settings) { return $fallback }
    if ($settings -is [System.Collections.IDictionary] -and $settings.Contains($name)) {
        $value = $settings[$name]
        if ($null -ne $value) { return $value }
    }
    return $fallback
}

function Set-Setting([string]$name, $value) {
    if ($null -eq $script:Config.settings) { $script:Config.settings = New-DefaultSettings }
    $script:Config.settings[$name] = $value
}

function Merge-Settings($loaded) {
    $defaults = New-DefaultSettings
    $merged = [ordered]@{}
    foreach ($key in $defaults.Keys) {
        if ($null -ne $loaded -and $loaded -is [System.Collections.IDictionary] -and $loaded.Contains($key) -and $null -ne $loaded[$key]) {
            $merged[$key] = $loaded[$key]
        } else {
            $merged[$key] = $defaults[$key]
        }
    }
    return $merged
}

function Get-Tunnels {
    return As-Array $script:Config.tunnels
}

function Get-Servers {
    return As-Array $script:Config.servers
}

function Get-Tunnel([string]$id) {
    if ([string]::IsNullOrWhiteSpace($id)) { return $null }
    foreach ($tunnel in @(Get-Tunnels)) {
        if ($tunnel.id -eq $id) { return $tunnel }
    }
    return $null
}

function Get-Server([string]$id) {
    if ([string]::IsNullOrWhiteSpace($id)) { return $null }
    foreach ($server in @(Get-Servers)) {
        if ($server.id -eq $id) { return $server }
    }
    return $null
}

function Save-Config {
    if ($null -eq $script:Config) { return }
    $script:Config.updatedAt = To-Iso (NowUtc)
    $script:Config.servers = @(Get-Servers)
    $script:Config.tunnels = @(Get-Tunnels)
    Write-JsonFile $script:ConfigPath $script:Config
}

function Import-LegacyConfig([string]$HostName = '') {
    # Legacy mappings do not identify their SSH destination. Require an
    # explicit host for migration instead of binding them to a bundled server.
    if ([string]::IsNullOrWhiteSpace($HostName)) { return $null }
    if ($HostName -notmatch '^[A-Za-z0-9.:\-]+$') { throw '旧配置迁移的服务器地址无效。' }
    $legacyPath = Join-Path $script:RootDir 'ServerTunnels.json'
    if (-not (Test-Path -LiteralPath $legacyPath)) { return $null }
    try {
        $legacy = Read-JsonFile $legacyPath
    } catch {
        return $null
    }
    $items = As-Array $legacy
    if ($items.Count -eq 0) { return $null }

    $config = New-DefaultConfig
    $server = [ordered]@{
        id           = 'srv-legacy'
        name         = '旧配置服务器'
        host         = $HostName
        port         = 22
        user         = 'root'
        keyPath      = '~/.ssh/id_ed25519'
        note         = '从 ServerTunnels.json 自动导入'
        color        = 'violet'
        passwordless = $true
        lastCheck    = $null
        lastLatency  = $null
        createdAt    = To-Iso (NowUtc)
    }
    $config.servers = @($server)

    $index = 0
    $tunnels = New-Object System.Collections.ArrayList
    foreach ($item in $items) {
        $index++
        $localPort = 0
        $remotePort = 0
        if (-not [int]::TryParse([string]$item.LocalPort, [ref]$localPort)) { continue }
        if (-not [int]::TryParse([string]$item.RemotePort, [ref]$remotePort)) { continue }
        if ($localPort -lt 1 -or $localPort -gt 65535 -or $remotePort -lt 1 -or $remotePort -gt 65535) { continue }
        $probe = switch ([string]$item.Probe) {
            'Http' { 'http' }
            'Socks5' { 'socks5' }
            'None' { 'none' }
            default { 'auto' }
        }
        $openUrl = ''
        if ($remotePort -eq 9090) { $openUrl = "http://127.0.0.1:$localPort/ui/" }
        elseif ($remotePort -eq 8317 -or $remotePort -eq 18318) { $openUrl = "http://127.0.0.1:$localPort/management.html" }
        elseif ($probe -eq 'http') { $openUrl = "http://127.0.0.1:$localPort/" }
        $group = if ($remotePort -eq 9090 -or $remotePort -eq 7890) { '代理' } else { '服务面板' }
        [void]$tunnels.Add([ordered]@{
            id          = (New-Id 't-')
            legacyId    = $index
            name        = [string]$item.Name
            serverId    = $server.id
            localHost   = '127.0.0.1'
            localPort   = $localPort
            remoteHost  = '127.0.0.1'
            remotePort  = $remotePort
            probe       = $probe
            openUrl     = $openUrl
            group       = $group
            note        = ''
            autoOpen    = $false
            createdAt   = To-Iso (NowUtc)
            updatedAt   = To-Iso (NowUtc)
        })
    }
    $config.tunnels = $tunnels.ToArray()
    return $config
}

function Load-Config {
    $loaded = $null
    if (Test-Path -LiteralPath $script:ConfigPath) {
        try { $loaded = Read-JsonFile $script:ConfigPath } catch { $loaded = $null }
    }
    if ($null -eq $loaded) { $loaded = Import-LegacyConfig }
    if ($null -eq $loaded) { $loaded = New-DefaultConfig }
    if ($loaded -isnot [System.Collections.IDictionary]) { $loaded = New-DefaultConfig }

    $config = [ordered]@{
        version   = 2
        createdAt = if ($loaded.Contains('createdAt')) { $loaded.createdAt } else { To-Iso (NowUtc) }
        updatedAt = To-Iso (NowUtc)
        settings  = Merge-Settings $(if ($loaded.Contains('settings')) { $loaded.settings } else { $null })
        servers   = @()
        tunnels   = @()
    }

    $servers = New-Object System.Collections.ArrayList
    foreach ($server in (As-Array $(if ($loaded.Contains('servers')) { $loaded.servers } else { @() }))) {
        if ($null -eq $server -or $server -isnot [System.Collections.IDictionary]) { continue }
        if ([string]::IsNullOrWhiteSpace([string]$server.host)) { continue }
        $id = [string]$server.id
        if ([string]::IsNullOrWhiteSpace($id)) { $id = New-Id 'srv-' 6 }
        $port = 22
        [void][int]::TryParse([string]$server.port, [ref]$port)
        [void]$servers.Add([ordered]@{
            id           = $id
            name         = if ([string]::IsNullOrWhiteSpace([string]$server.name)) { [string]$server.host } else { [string]$server.name }
            host         = [string]$server.host
            port         = if ($port -ge 1 -and $port -le 65535) { $port } else { 22 }
            user         = if ([string]::IsNullOrWhiteSpace([string]$server.user)) { [string](Get-Setting 'defaultUser' 'root') } else { [string]$server.user }
            keyPath      = if ($null -eq $server.keyPath) { [string](Get-Setting 'defaultKeyPath' '~/.ssh/id_ed25519') } else { [string]$server.keyPath }
            note         = [string]$server.note
            color        = if ([string]::IsNullOrWhiteSpace([string]$server.color)) { 'violet' } else { [string]$server.color }
            passwordless = To-Bool $server.passwordless $true
            lastCheck    = $server.lastCheck
            lastLatency  = $server.lastLatency
            createdAt    = if ($server.createdAt) { $server.createdAt } else { To-Iso (NowUtc) }
        })
    }
    $config.servers = $servers.ToArray()

    $defaultServerId = if ($servers.Count -gt 0) { $servers[0].id } else { '' }
    $tunnels = New-Object System.Collections.ArrayList
    foreach ($tunnel in (As-Array $(if ($loaded.Contains('tunnels')) { $loaded.tunnels } else { @() }))) {
        if ($null -eq $tunnel -or $tunnel -isnot [System.Collections.IDictionary]) { continue }
        if ([string]::IsNullOrWhiteSpace([string]$tunnel.name)) { continue }
        $localPort = 0
        $remotePort = 0
        [void][int]::TryParse([string]$tunnel.localPort, [ref]$localPort)
        [void][int]::TryParse([string]$tunnel.remotePort, [ref]$remotePort)
        if ($localPort -lt 1 -or $localPort -gt 65535) { continue }
        if ($remotePort -lt 1 -or $remotePort -gt 65535) { continue }
        $serverId = [string]$tunnel.serverId
        if (-not (Get-ServerFrom $servers $serverId)) { $serverId = $defaultServerId }
        $probe = [string]$tunnel.probe
        if ($probe -notin @('auto', 'http', 'socks5', 'tcp', 'none')) { $probe = 'auto' }
        [void]$tunnels.Add([ordered]@{
            id         = if ([string]::IsNullOrWhiteSpace([string]$tunnel.id)) { New-Id 't-' } else { [string]$tunnel.id }
            kind = if ($tunnel.kind -eq 'dedicated') { 'dedicated' } else { 'standard' }
            proxyAccount = [string]$tunnel.proxyAccount
            ispId = [string]$tunnel.ispId
            proxyExitIp = [string]$tunnel.proxyExitIp
            proxyRoute = if ($tunnel.proxyRoute -in @('direct', 'vpn')) { [string]$tunnel.proxyRoute } else { 'unknown' }
            legacyId   = $tunnel.legacyId
            name       = [string]$tunnel.name
            serverId   = $serverId
            localHost  = if ([string]::IsNullOrWhiteSpace([string]$tunnel.localHost)) { '127.0.0.1' } else { [string]$tunnel.localHost }
            localPort  = $localPort
            remoteHost = if ([string]::IsNullOrWhiteSpace([string]$tunnel.remoteHost)) { '127.0.0.1' } else { [string]$tunnel.remoteHost }
            remotePort = $remotePort
            probe      = $probe
            openUrl    = [string]$tunnel.openUrl
            group      = [string]$tunnel.group
            note       = [string]$tunnel.note
            autoOpen   = To-Bool $tunnel.autoOpen $false
            createdAt  = if ($tunnel.createdAt) { $tunnel.createdAt } else { To-Iso (NowUtc) }
            updatedAt  = if ($tunnel.updatedAt) { $tunnel.updatedAt } else { To-Iso (NowUtc) }
        })
    }
    $config.tunnels = $tunnels.ToArray()
    $script:Config = $config
    Save-Config
}

function Get-ServerFrom($servers, [string]$id) {
    foreach ($server in $servers) { if ($server.id -eq $id) { return $server } }
    return $null
}

# ------------------------------------------------------------
#  Validation + CRUD
# ------------------------------------------------------------

function Get-TunnelInput($body, [string]$existingId = '') {
    if ($null -eq $body) { $body = @{} }
    $kind = if ($null -eq $body.kind) { 'standard' } else { [string]$body.kind }
    if ($kind -notin @('standard', 'dedicated')) { throw '隧道类型无效。' }
    $proxyRoute = if ($null -eq $body.proxyRoute) { 'unknown' } else { [string]$body.proxyRoute }
    if ($proxyRoute -notin @('unknown', 'direct', 'vpn')) { throw '代理路由无效。' }
    foreach ($field in @('proxyAccount', 'ispId', 'proxyExitIp')) {
        $limit = if ($field -eq 'proxyAccount') { 100 } elseif ($field -eq 'ispId') { 32 } else { 45 }
        if ($null -ne $body[$field] -and ($body[$field] -isnot [string] -or $body[$field].Length -gt $limit -or $body[$field] -match '[\x00-\x1f\x7f]')) { throw '专用隧道字段格式无效。' }
    }
    $proxyExitIp = ([string]$body.proxyExitIp).Trim()
    $parsedIp = $null
    if ($proxyExitIp -and -not [Net.IPAddress]::TryParse($proxyExitIp, [ref]$parsedIp)) { throw '出口 IP 格式无效。' }
    if ($proxyExitIp -and $parsedIp.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork -and $proxyExitIp -cne $parsedIp.ToString()) { throw '出口 IPv4 必须为完整的四段地址。' }
    $name = ([string]$body.name).Trim()
    if ([string]::IsNullOrWhiteSpace($name)) { throw '隧道名称不能为空。' }
    if ($name.Length -gt 60) { throw '隧道名称不能超过 60 个字符。' }
    if ($name -match '[\x00-\x1f]') { throw '隧道名称不能包含控制字符。' }

    if (-not (Test-PortValue $body.localPort)) { throw '本机端口必须为 1 - 65535 的整数。' }
    if (-not (Test-PortValue $body.remotePort)) { throw '服务器端口必须为 1 - 65535 的整数。' }
    $localPort = [int]$body.localPort
    $remotePort = [int]$body.remotePort

    $serverId = [string]$body.serverId
    $server = Get-Server $serverId
    if ($null -eq $server) { throw '请选择有效的服务器配置。' }

    $localHost = ([string]$body.localHost).Trim()
    if ([string]::IsNullOrWhiteSpace($localHost)) { $localHost = '127.0.0.1' }
    if ($localHost -notmatch '^[A-Za-z0-9\.\:\-]+$') { throw '本机监听地址格式不正确。' }
    $remoteHost = ([string]$body.remoteHost).Trim()
    if ([string]::IsNullOrWhiteSpace($remoteHost)) { $remoteHost = '127.0.0.1' }
    if ($remoteHost -notmatch '^[A-Za-z0-9\.\:\-]+$') { throw '远端目标地址格式不正确。' }

    foreach ($tunnel in @(Get-Tunnels)) {
        if ($tunnel.id -eq $existingId) { continue }
        if ([int]$tunnel.localPort -eq $localPort -and (Test-ListenerAddressConflict ([string]$tunnel.localHost) $localHost)) {
            throw "本机端口 $localPort 已被「$($tunnel.name)」使用。"
        }
    }
    $panelPort = [int](Get-Setting 'panelPort' 9666)
    if ($localPort -eq $panelPort -and ($localHost -eq '127.0.0.1' -or $localHost -eq 'localhost' -or $localHost -eq '0.0.0.0')) {
        throw "本机端口 $localPort 是控制面板自身端口，请换一个端口。"
    }

    $probe = ([string]$body.probe).ToLowerInvariant()
    if ($probe -notin @('auto', 'http', 'socks5', 'tcp', 'none')) { $probe = 'auto' }

    $openUrl = ([string]$body.openUrl).Trim()
    if ($openUrl -and $openUrl -notmatch '^(?i)https?://') { throw '跳转地址必须以 http:// 或 https:// 开头。' }
    if ($openUrl.Length -gt 500) { throw '跳转地址过长。' }

    $group = ([string]$body.group).Trim()
    if ($group.Length -gt 24) { throw '分组名称不能超过 24 个字符。' }
    $note = ([string]$body.note).Trim()
    if ($note.Length -gt 200) { throw '备注不能超过 200 个字符。' }

    return [ordered]@{
        kind = $kind
        proxyAccount = ([string]$body.proxyAccount).Trim()
        ispId = ([string]$body.ispId).Trim()
        proxyExitIp = $proxyExitIp
        proxyRoute = $proxyRoute
        name       = $name
        serverId   = $serverId
        localHost  = $localHost
        localPort  = $localPort
        remoteHost = $remoteHost
        remotePort = $remotePort
        probe      = $probe
        openUrl    = $openUrl
        group      = $group
        note       = $note
        autoOpen   = To-Bool $body.autoOpen $false
    }
}

function Add-Tunnel($body) {
    $input = Get-TunnelInput $body
    $now = To-Iso (NowUtc)
    $tunnel = [ordered]@{
        kind = $input.kind
        proxyAccount = $input.proxyAccount
        ispId = $input.ispId
        proxyExitIp = $input.proxyExitIp
        proxyRoute = $input.proxyRoute
        id        = New-Id 't-'
        name      = $input.name
        serverId  = $input.serverId
        localHost = $input.localHost
        localPort = $input.localPort
        remoteHost = $input.remoteHost
        remotePort = $input.remotePort
        probe     = $input.probe
        openUrl   = $input.openUrl
        group     = $input.group
        note      = $input.note
        autoOpen  = $input.autoOpen
        createdAt = $now
        updatedAt = $now
    }
    $script:Config.tunnels = @(Get-Tunnels) + @($tunnel)
    Initialize-TunnelState $tunnel.id | Out-Null
    Save-Config
    Add-Log info 'panel' "新增隧道「$($tunnel.name)」127.0.0.1:$($tunnel.localPort) → $($tunnel.remoteHost):$($tunnel.remotePort)"
    Add-Activity -Kind 'info' -Title '新增隧道' -Detail "$($tunnel.name) · 127.0.0.1:$($tunnel.localPort)" -TunnelId $tunnel.id
    return $tunnel
}

function Update-Tunnel([string]$id, $body) {
    $tunnel = Get-Tunnel $id
    if ($null -eq $tunnel) { throw '隧道不存在或已被删除。' }
    $input = Get-TunnelInput $body $id
    $wasOnline = (Get-TunnelState $id).status -in @('online', 'connecting')
    foreach ($key in $input.Keys) { $tunnel[$key] = $input[$key] }
    $tunnel.updatedAt = To-Iso (NowUtc)
    Save-Config
    if ($tunnel.kind -eq 'dedicated') { Sync-EdgeProfilesForTunnel $tunnel }
    Add-Log info 'panel' "更新隧道「$($tunnel.name)」"
    Add-Activity -Kind 'info' -Title '修改隧道' -Detail "$($tunnel.name) · 配置已更新" -TunnelId $id
    if ($wasOnline) {
        Add-Activity -Kind 'warning' -Title '需要重启隧道' -Detail "$($tunnel.name) 的配置已变更，重启后生效" -TunnelId $id
    }
    return $tunnel
}

function Remove-Tunnel([string]$id) {
    $tunnel = Get-Tunnel $id
    if ($null -eq $tunnel) { throw '隧道不存在或已被删除。' }
    $state = Get-TunnelState $id
    if ($state.status -in @('online', 'connecting', 'closing')) {
        Stop-TunnelHard $id
    }
    $script:Config.tunnels = @(Get-Tunnels | Where-Object { $_.id -ne $id })
    if ($script:State.ContainsKey($id)) { $script:State.Remove($id) }
    Remove-ProcessRecord $id
    Save-Config
    Add-Log info 'panel' "删除隧道「$($tunnel.name)」"
    Add-Activity -Kind 'warning' -Title '删除隧道' -Detail "$($tunnel.name) · 映射已移除" -TunnelId ''
    return $tunnel
}

function Get-ServerInput($body, [string]$existingId = '') {
    if ($null -eq $body) { $body = @{} }
    $name = ([string]$body.name).Trim()
    $hostName = ([string]$body.host).Trim()
    if ([string]::IsNullOrWhiteSpace($hostName)) { throw '服务器地址不能为空。' }
    if ($hostName -notmatch '^[A-Za-z0-9\.\-_:]+$') { throw '服务器地址格式不正确。' }
    if ($hostName.Length -gt 253) { throw '服务器地址过长。' }
    if ([string]::IsNullOrWhiteSpace($name)) { $name = $hostName }
    if ($name.Length -gt 40) { throw '服务器名称不能超过 40 个字符。' }
    if (-not (Test-PortValue $body.port)) { throw 'SSH 端口必须为 1 - 65535 的整数。' }
    $user = ([string]$body.user).Trim()
    if ([string]::IsNullOrWhiteSpace($user)) { $user = [string](Get-Setting 'defaultUser' 'root') }
    if ($user -notmatch '^[A-Za-z0-9._\-]+$') { throw '用户名格式不正确。' }
    $keyPath = ([string]$body.keyPath).Trim()
    if ([string]::IsNullOrWhiteSpace($keyPath)) { $keyPath = [string](Get-Setting 'defaultKeyPath' '~/.ssh/id_ed25519') }
    if ($keyPath.Length -gt 260) { throw '密钥路径过长。' }
    $color = ([string]$body.color).Trim()
    if ($color -notin @('violet', 'ocean', 'emerald', 'amber', 'rose')) { $color = 'violet' }
    $note = ([string]$body.note).Trim()
    if ($note.Length -gt 200) { throw '备注不能超过 200 个字符。' }
    foreach ($server in @(Get-Servers)) {
        if ($server.id -eq $existingId) { continue }
        if ($server.host -ieq $hostName -and [int]$server.port -eq [int]$body.port -and $server.user -ieq $user) {
            throw "已存在相同地址与用户的服务器「$($server.name)」。"
        }
    }
    return [ordered]@{
        name         = $name
        host         = $hostName
        port         = [int]$body.port
        user         = $user
        keyPath      = $keyPath
        note         = $note
        color        = $color
        passwordless = To-Bool $body.passwordless $false
    }
}

function Add-Server($body) {
    $input = Get-ServerInput $body
    $server = [ordered]@{
        id           = New-Id 'srv-' 6
        name         = $input.name
        host         = $input.host
        port         = $input.port
        user         = $input.user
        keyPath      = $input.keyPath
        note         = $input.note
        color        = $input.color
        passwordless = $input.passwordless
        lastCheck    = $null
        lastLatency  = $null
        createdAt    = To-Iso (NowUtc)
    }
    $script:Config.servers = @(Get-Servers) + @($server)
    Save-Config
    Add-Log info 'panel' "新增服务器「$($server.name)」$($server.user)@$($server.host):$($server.port)"
    Add-Activity -Kind 'info' -Title '新增服务器' -Detail "$($server.user)@$($server.host):$($server.port)"
    return $server
}

function Update-Server([string]$id, $body) {
    $server = Get-Server $id
    if ($null -eq $server) { throw '服务器不存在或已被删除。' }
    $input = Get-ServerInput $body $id
    foreach ($key in $input.Keys) { $server[$key] = $input[$key] }
    Save-Config
    Add-Log info 'panel' "更新服务器「$($server.name)」"
    Add-Activity -Kind 'info' -Title '修改服务器' -Detail "$($server.user)@$($server.host):$($server.port)"
    return $server
}

function Remove-Server([string]$id) {
    $server = Get-Server $id
    if ($null -eq $server) { throw '服务器不存在或已被删除。' }
    $linked = @(Get-Tunnels | Where-Object { $_.serverId -eq $id })
    if ($linked.Count -gt 0) {
        throw "该服务器仍关联 $($linked.Count) 条隧道，请先删除或迁移这些隧道。"
    }
    $script:Config.servers = @(Get-Servers | Where-Object { $_.id -ne $id })
    Save-Config
    Add-Log info 'panel' "删除服务器「$($server.name)」"
    Add-Activity -Kind 'warning' -Title '删除服务器' -Detail "$($server.user)@$($server.host):$($server.port)"
    return $server
}

# ------------------------------------------------------------
#  Runtime state
# ------------------------------------------------------------

function New-RuntimeState {
    $now = NowUtc
    return [ordered]@{
        status           = 'offline'
        error            = ''
        pid              = $null
        procStartTicks   = $null
        openedAt         = $null
        statusChanged    = $now
        connectAt        = $null
        closeAt          = $null
        verifyAt         = $null
        pendingOpen      = $false
        retryAt          = $null
        reconnectCount   = 0
        latency          = $null
        latencyHistory   = @()
        latencyAt        = [DateTime]::MinValue
        baseLatency      = 42
        bytesIn          = 0.0
        bytesOut         = 0.0
        lastTickAt       = $now
        lastTrafficLogAt = $now
        lastProbeAt      = [DateTime]::MinValue
        probeError       = ''
        stderrPath       = ''
        stdoutPath       = ''
        attempts         = 0
    }
}

function Initialize-TunnelState([string]$id) {
    if (-not $script:State.ContainsKey($id)) { $script:State[$id] = New-RuntimeState }
    return $script:State[$id]
}

function Sync-RuntimeStates {
    $valid = @{}
    foreach ($tunnel in @(Get-Tunnels)) {
        $valid[$tunnel.id] = $true
        Initialize-TunnelState $tunnel.id | Out-Null
    }
    foreach ($id in @($script:State.Keys)) {
        if (-not $valid.ContainsKey($id)) { $script:State.Remove($id) }
    }
}

function Get-TunnelState([string]$id) {
    if (-not $script:State.ContainsKey($id)) { return Initialize-TunnelState $id }
    return $script:State[$id]
}

function Get-ForwardSpec($tunnel) {
    return "$($tunnel.localHost):$($tunnel.localPort):$($tunnel.remoteHost):$($tunnel.remotePort)"
}

function Get-TunnelUrl($tunnel) {
    $url = [string]$tunnel.openUrl
    if (-not [string]::IsNullOrWhiteSpace($url)) { return $url }
    if ($tunnel.probe -eq 'http') { return "http://127.0.0.1:$($tunnel.localPort)/" }
    return ''
}

function Get-EffectiveProbe($tunnel) {
    $probe = [string]$tunnel.probe
    if ($probe -and $probe -ne 'auto') { return $probe }
    switch ([int]$tunnel.remotePort) {
        9090 { return 'http' }
        7890 { return 'socks5' }
        default { return 'tcp' }
    }
}

function Get-SshPath {
    $command = Get-Command ssh.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $candidate = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
    if (Test-Path -LiteralPath $candidate) { return $candidate }
    return $null
}

function Resolve-KeyPath([string]$path) {
    if ([string]::IsNullOrWhiteSpace($path)) { return '' }
    $value = [Environment]::ExpandEnvironmentVariables($path.Trim())
    if ($value.StartsWith('~')) {
        $rest = $value.Substring(1).TrimStart('\', '/')
        $rest = $rest -replace '/', '\'
        $value = if ($rest) { Join-Path $env:USERPROFILE $rest } else { $env:USERPROFILE }
    }
    return $value
}

function Get-StderrTail([string]$path, [int]$lines = 12) {
    if ([string]::IsNullOrWhiteSpace($path) -or -not (Test-Path -LiteralPath $path)) { return '' }
    try {
        $content = @(Get-Content -LiteralPath $path -Tail $lines -ErrorAction SilentlyContinue)
        return ($content -join "`n").Trim()
    } catch { return '' }
}

function Save-ProcessRecords {
    try {
        $data = [ordered]@{}
        foreach ($id in $script:ProcessRecords.Keys) { $data[$id] = $script:ProcessRecords[$id] }
        Write-JsonFile $script:RuntimePath $data -Compress
    } catch { }
}

function Remove-ProcessRecord([string]$id) {
    if ($script:ProcessRecords.Contains($id)) {
        $script:ProcessRecords.Remove($id)
        Save-ProcessRecords
    }
}

function Test-ProcessRecord($record) {
    if ($null -eq $record -or $null -eq $record.pid) { return $false }
    try {
        $process = Get-Process -Id ([int]$record.pid) -ErrorAction Stop
        if ($process.ProcessName -ne 'ssh') { return $false }
        if ($record.ticks -and $process.StartTime.ToUniversalTime().Ticks.ToString() -ne [string]$record.ticks) { return $false }
        return $true
    } catch { return $false }
}

function Restore-ProcessRecords {
    if (To-Bool (Get-Setting 'simulation' $true) $true) { return }
    if (-not (Test-Path -LiteralPath $script:RuntimePath)) { return }
    try {
        $records = Read-JsonFile $script:RuntimePath
        if ($null -eq $records) { return }
        foreach ($id in @($records.Keys)) {
            $record = $records[$id]
            $tunnel = Get-Tunnel $id
            if ($null -eq $tunnel) { continue }
            [void](Restore-OwnedTunnel $tunnel $record)
        }
        Save-ProcessRecords
    } catch { }
}

function Test-LocalListener($tunnel, $pidValue) {
    try {
        $listeners = @(Get-PortListeners ([int]$tunnel.localPort) ([string]$tunnel.localHost))
        foreach ($listener in $listeners) {
            if ($listener.OwningProcess -eq [int]$pidValue) { return $true }
        }
        return $false
    } catch {
        # 仅 TCP 能连接不能证明属于目标 PID，不作为归属校验的替代证据。
        return $false
    }
}

function Test-PortInUse([int]$port, [string]$localHost = '127.0.0.1') {
    try {
        $listeners = @(Get-PortListeners $port $localHost)
        return ($listeners.Count -gt 0)
    } catch {
        throw '无法检查本机监听端口，请检查权限或系统网络组件。'
    }
}

# ------------------------------------------------------------
#  Real SSH operations
# ------------------------------------------------------------

function Start-RealTunnel($tunnel, $state) {
    $server = Get-Server $tunnel.serverId
    if ($null -eq $server) { throw '服务器配置不存在。' }
    $ssh = Get-SshPath
    if (-not $ssh) { throw '未找到 ssh.exe，请先安装 Windows OpenSSH 客户端。' }
    $key = Resolve-KeyPath $server.keyPath
    if ($key -and -not (Test-Path -LiteralPath $key)) { throw "找不到 SSH 私钥：$key" }
    $record = $script:ProcessRecords[$tunnel.id]
    if ($record -and (Restore-OwnedTunnel $tunnel $record)) { return }
    $portInfo = Get-TunnelPortInfo $tunnel
    if ($portInfo.kind -eq 'unknown' -and $portInfo.listeners.Count -eq 0) { throw $portInfo.message }
    if ($portInfo.kind -ne 'free') {
        $owners = @($portInfo.listeners | ForEach-Object { "$($_.name) (PID $($_.pid))：$($_.detail)" }) -join '；'
        throw "本机端口 $($tunnel.localHost):$($tunnel.localPort) 被占用。$owners 可查看端口诊断或修改本机端口。"
    }

    Ensure-Directory (Join-Path $script:LogDir 'tunnels')
    $stderr = Join-Path $script:LogDir ('tunnels\' + $tunnel.id + '.stderr.log')
    $stdout = Join-Path $script:LogDir ('tunnels\' + $tunnel.id + '.stdout.log')
    foreach ($file in @($stderr, $stdout)) {
        try { if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force } } catch { }
    }

    $strict = if (To-Bool (Get-Setting 'strictHostKeyChecking' $true) $true) { 'yes' } else { 'accept-new' }
    $connectTimeout = [int](Get-Setting 'connectTimeout' 10)
    $aliveInterval = [int](Get-Setting 'serverAliveInterval' 30)
    $aliveCount = [int](Get-Setting 'serverAliveCountMax' 3)
    $arguments = @('-N', '-T', '-p', [string]$server.port)
    if ($key) { $arguments += @('-i', ('"{0}"' -f $key)) }
    $arguments += @(
        '-o', 'BatchMode=yes',
        '-o', "StrictHostKeyChecking=$strict",
        '-o', 'IdentitiesOnly=yes',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', "ConnectTimeout=$connectTimeout",
        '-o', "ServerAliveInterval=$aliveInterval",
        '-o', "ServerAliveCountMax=$aliveCount",
        '-L', (Get-ForwardSpec $tunnel),
        "$($server.user)@$($server.host)"
    )

    Add-Log info $tunnel.name "启动 SSH：$ssh -N -L $(Get-ForwardSpec $tunnel) $($server.user)@$($server.host)"
    $process = Start-Process -FilePath $ssh -ArgumentList $arguments -WindowStyle Hidden -PassThru `
        -RedirectStandardError $stderr -RedirectStandardOutput $stdout
    $state.pid = $process.Id
    $state.procStartTicks = $process.StartTime.ToUniversalTime().Ticks.ToString()
    $state.stderrPath = $stderr
    $state.stdoutPath = $stdout
    $state.verifyAt = (NowUtc).AddSeconds(15)
    $script:ProcessRecords[$tunnel.id] = [ordered]@{
        pid       = $process.Id
        ticks     = $state.procStartTicks
        openedAt  = To-Iso (NowUtc)
        forward   = (Get-ForwardSpec $tunnel)
        destination = "$($server.user)@$($server.host)"
        port      = [int]$server.port
    }
    Save-ProcessRecords
}

function Stop-RealTunnel($tunnel, $state) {
    $pidValue = $state.pid
    if ($null -eq $pidValue) { Remove-ProcessRecord $tunnel.id; return $true }
    $process = Get-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue
    if (-not $process) {
        Remove-ProcessRecord $tunnel.id
        return $true
    }
    if ($process.ProcessName -ne 'ssh') {
        Add-Log warn $tunnel.name "PID $pidValue 已不是 ssh 进程，为安全起见未终止。"
        return $false
    }
    if ($state.procStartTicks -and $process.StartTime.ToUniversalTime().Ticks.ToString() -ne [string]$state.procStartTicks) {
        Add-Log warn $tunnel.name "PID $pidValue 的创建时间与记录不一致，为安全起见未终止。"
        return $false
    }
    $record = $script:ProcessRecords[$tunnel.id]
    if (-not $record -or [int]$record.pid -ne [int]$pidValue -or -not $record.ticks -or
        $process.StartTime.ToUniversalTime().Ticks.ToString() -ne [string]$record.ticks) {
        Add-Log warn $tunnel.name '缺少匹配的运行归属记录，未结束该进程。'
        return $false
    }
    try {
        $info = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$pidValue)" -ErrorAction Stop
        $server = Get-Server $tunnel.serverId
        $recordPort = if ($record.port) { [int]$record.port } elseif ($server) { [int]$server.port } else { 22 }
        if (-not (Test-SshIdentityMatch (Get-SshIdentity $info.CommandLine) $record.forward $record.destination $recordPort)) {
            Add-Log warn $tunnel.name 'SSH 目标或独立转发规则与归属记录不匹配，未结束该进程。'
            return $false
        }
    } catch {
        Add-Log warn $tunnel.name '无法核实 SSH 进程命令，未结束该进程。'
        return $false
    }
    try {
        $process.Kill()
        if (-not $process.WaitForExit(5000)) {
            Add-Log warn $tunnel.name "等待 SSH 进程退出超时，未移除运行记录。"
            return $false
        }
        Add-Log info $tunnel.name "SSH 进程已终止 (PID $pidValue)"
        Remove-ProcessRecord $tunnel.id
        return $true
    } catch {
        Add-Log warn $tunnel.name "终止 SSH 进程失败：$($_.Exception.Message)"
        return $false
    }
}

function Stop-TunnelHard([string]$id) {
    $tunnel = Get-Tunnel $id
    if ($null -eq $tunnel) { return }
    $state = Get-TunnelState $id
    if (-not (To-Bool (Get-Setting 'simulation' $true) $true)) {
        $stopped = Stop-RealTunnel $tunnel $state
        if (-not $stopped) {
            throw "无法安全终止「$($tunnel.name)」的 SSH 进程（PID $($state.pid)），操作已取消。"
        }
    } else {
        Remove-ProcessRecord $tunnel.id
    }
    $state.status = 'offline'
    $state.statusChanged = NowUtc
    $state.pid = $null
    $state.openedAt = $null
    $state.pendingOpen = $false
    $state.connectAt = $null
    $state.closeAt = $null
    $state.retryAt = $null
    $state.error = ''
}

# ------------------------------------------------------------
#  Open / close / restart
# ------------------------------------------------------------

function Invoke-OpenTunnel([string]$id) {
    $tunnel = Get-Tunnel $id
    if ($null -eq $tunnel) { throw '隧道不存在或已被删除。' }
    $state = Get-TunnelState $id
    if ($state.status -in @('online', 'connecting')) { return $state }

    $state.error = ''
    $state.retryAt = $null
    $state.pendingOpen = $false
    $state.status = 'connecting'
    $state.statusChanged = NowUtc
    $simulation = To-Bool (Get-Setting 'simulation' $true) $true

    if ($simulation) {
        $state.pid = $null # Simulation has no real SSH process.
        $state.connectAt = (NowUtc).AddMilliseconds((Get-Random -Minimum 380 -Maximum 900))
        $state.baseLatency = Get-Random -Minimum 17 -Maximum 68
        Add-Log info $tunnel.name "解析配置：127.0.0.1:$($tunnel.localPort) → $($tunnel.remoteHost):$($tunnel.remotePort)（演示模式）" -TunnelId $id -NoFile
        Add-Log debug $tunnel.name "ssh -N -T -L $($tunnel.localPort):$($tunnel.remoteHost):$($tunnel.remotePort)（演示模式，未实际执行）" -TunnelId $id -NoFile
        Add-Activity -Kind 'info' -Title '正在开启隧道' -Detail "$($tunnel.name) · 正在建立加密通道" -TunnelId $id
    } else {
        try {
            Start-RealTunnel $tunnel $state
            Add-Activity -Kind 'info' -Title '正在开启隧道' -Detail "$($tunnel.name) · SSH 进程已启动 (PID $($state.pid))" -TunnelId $id
        } catch {
            $state.status = if ($_.Exception.Message -match '占用') { 'occupied' } else { 'error' }
            $state.statusChanged = NowUtc
            $state.error = $_.Exception.Message
            Add-Log error $tunnel.name "开启失败：$($state.error)" -TunnelId $id
            Add-Activity -Kind 'error' -Title '开启失败' -Detail "$($tunnel.name) · $($state.error)" -TunnelId $id
            throw
        }
    }
    return $state
}

function Invoke-CloseTunnel([string]$id) {
    $tunnel = Get-Tunnel $id
    if ($null -eq $tunnel) { throw '隧道不存在或已被删除。' }
    $state = Get-TunnelState $id
    $simulation = To-Bool (Get-Setting 'simulation' $true) $true

    if ($state.status -eq 'offline') { return $state }
    if ($state.status -eq 'error' -and -not $state.pid) {
        $state.status = 'offline'
        $state.statusChanged = NowUtc
        $state.error = ''
        $state.openedAt = $null
        return $state
    }

    $state.status = 'closing'
    $state.statusChanged = NowUtc
    if ($simulation) {
        $state.closeAt = (NowUtc).AddMilliseconds(280)
        Add-Log debug $tunnel.name "发送断开指令，等待本机监听释放…（演示模式）" -TunnelId $id -NoFile
        Add-Activity -Kind 'info' -Title '正在关闭隧道' -Detail $tunnel.name -TunnelId $id
    } else {
        $stopped = Stop-RealTunnel $tunnel $state
        if (-not $stopped) {
            $state.status = 'error'
            $state.statusChanged = NowUtc
            $state.error = "SSH 进程校验失败，未终止 PID $($state.pid)。请检查该进程后重试。"
            Add-Log error $tunnel.name $state.error
            Add-Activity -Kind 'error' -Title '关闭失败' -Detail "$($tunnel.name) · $($state.error)" -TunnelId $id
            return $state
        }
        $state.pid = $null
        $state.openedAt = $null
        $state.status = 'offline'
        $state.error = ''
        Add-Log info $tunnel.name '隧道已关闭'
        Add-Activity -Kind 'success' -Title '隧道已关闭' -Detail $tunnel.name -TunnelId $id
    }
    return $state
}

function Invoke-RestartTunnel([string]$id) {
    $tunnel = Get-Tunnel $id
    if ($null -eq $tunnel) { throw '隧道不存在或已被删除。' }
    $state = Get-TunnelState $id
    $state.pendingOpen = $true
    if (To-Bool (Get-Setting 'simulation' $true) $true) {
        Invoke-CloseTunnel $id | Out-Null
        $state.status = 'connecting'
        $state.statusChanged = NowUtc
        $state.pid = $null # Simulation has no real SSH process.
        $state.connectAt = (NowUtc).AddMilliseconds((Get-Random -Minimum 500 -Maximum 1000))
        $state.baseLatency = Get-Random -Minimum 17 -Maximum 68
        $state.error = ''
        Add-Log info $tunnel.name '正在重启隧道（演示模式）' -TunnelId $id -NoFile
        Add-Activity -Kind 'info' -Title '重启隧道' -Detail $tunnel.name -TunnelId $id
    } else {
        $stopped = Stop-RealTunnel $tunnel $state
        if (-not $stopped) {
            $state.status = 'error'
            $state.statusChanged = NowUtc
            $state.error = "SSH 进程校验失败，未终止 PID $($state.pid)。"
            Add-Log error $tunnel.name $state.error
            return $state
        }
        $state.status = 'offline'
        $state.pid = $null
        $state.openedAt = $null
        $state.error = ''
        Invoke-OpenTunnel $id | Out-Null
    }
    return $state
}

# ------------------------------------------------------------
#  Latency probe
# ------------------------------------------------------------

function Measure-TunnelLatency($tunnel) {
    $simulation = To-Bool (Get-Setting 'simulation' $true) $true
    $probe = Get-EffectiveProbe $tunnel
    if ($probe -eq 'none') { return [ordered]@{ ok = $false; ms = $null; kind = 'none'; error = '未启用探测' } }

    if ($simulation) {
        $state = Get-TunnelState $tunnel.id
        $base = [int]$state.baseLatency
        if ($base -le 0) { $base = 42 }
        $ms = [int][math]::Max(7, $base + (Get-Random -Minimum -9 -Maximum 12))
        return [ordered]@{ ok = $true; ms = $ms; kind = $probe; error = '' }
    }

    $client = New-Object System.Net.Sockets.TcpClient
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $pending = $client.ConnectAsync([string]$tunnel.localHost, [int]$tunnel.localPort)
        if (-not $pending.Wait(1500)) { return [ordered]@{ ok = $false; ms = $null; kind = $probe; error = '连接超时' } }
        if ($probe -eq 'tcp') {
            $watch.Stop()
            return [ordered]@{ ok = $true; ms = [int]$watch.ElapsedMilliseconds; kind = 'tcp'; error = '' }
        }
        $stream = $client.GetStream()
        $stream.ReadTimeout = 1800
        $stream.WriteTimeout = 1800
        if ($probe -eq 'http') {
            $bytes = [System.Text.Encoding]::ASCII.GetBytes("HEAD / HTTP/1.0`r`nHost: localhost`r`nConnection: close`r`n`r`n")
            $stream.Write($bytes, 0, $bytes.Length)
            $first = $stream.ReadByte()
            if ($first -lt 0) { return [ordered]@{ ok = $false; ms = $null; kind = 'http'; error = '无响应' } }
        } elseif ($probe -eq 'socks5') {
            $bytes = [byte[]]@(5, 1, 0)
            $stream.Write($bytes, 0, $bytes.Length)
            if ($stream.ReadByte() -ne 5) { return [ordered]@{ ok = $false; ms = $null; kind = 'socks5'; error = '响应异常' } }
            if ($stream.ReadByte() -ne 0) { return [ordered]@{ ok = $false; ms = $null; kind = 'socks5'; error = '需要认证' } }
        }
        $watch.Stop()
        return [ordered]@{ ok = $true; ms = [int]$watch.ElapsedMilliseconds; kind = $probe; error = '' }
    } catch {
        return [ordered]@{ ok = $false; ms = $null; kind = $probe; error = '探测失败' }
    } finally {
        $client.Dispose()
    }
}

function Update-TunnelLatency($tunnel) {
    $state = Get-TunnelState $tunnel.id
    if ($state.status -ne 'online') { return }
    if (-not (To-Bool (Get-Setting 'latencyProbe' $true) $true)) { return }
    $result = Measure-TunnelLatency $tunnel
    $state.latencyAt = NowUtc
    if ($result.ok) {
        $state.latency = [int]$result.ms
        $state.probeError = ''
        $state.latencyHistory = @($state.latencyHistory) + @([int]$result.ms)
        while ($state.latencyHistory.Count -gt 40) {
            $state.latencyHistory = @($state.latencyHistory)[1..($state.latencyHistory.Count - 1)]
        }
    } else {
        $state.probeError = [string]$result.error
    }
}

# ------------------------------------------------------------
#  Tick engine
# ------------------------------------------------------------

function Get-TotalTraffic {
    $total = 0.0
    foreach ($tunnel in @(Get-Tunnels)) {
        $state = Get-TunnelState $tunnel.id
        $total += [double]$state.bytesIn + [double]$state.bytesOut
    }
    return $total
}

function Push-MetricsHistory {
    $online = 0
    $latSum = 0.0
    $latCount = 0
    foreach ($tunnel in @(Get-Tunnels)) {
        $state = Get-TunnelState $tunnel.id
        if ($state.status -eq 'online') {
            $online++
            if ($null -ne $state.latency) { $latSum += [double]$state.latency; $latCount++ }
        }
    }
    $entry = [ordered]@{
        t       = To-Iso (NowUtc)
        online  = $online
        latency = if ($latCount -gt 0) { [int][math]::Round($latSum / $latCount) } else { 0 }
        rate    = [int]$script:CurrentRate
    }
    Add-RingItem $script:MetricsHistory $entry 60
    $script:LastHistoryAt = NowUtc
}

function Complete-SimulatedOpen($tunnel, $state) {
    $state.status = 'online'
    $state.statusChanged = NowUtc
    $state.openedAt = NowUtc
    $state.connectAt = $null
    $state.error = ''
    $state.bytesIn = Get-Random -Minimum 3000 -Maximum 24000
    $state.bytesOut = Get-Random -Minimum 1500 -Maximum 9000
    $state.latencyAt = NowUtc
    $state.latency = [math]::Max(8, [int]$state.baseLatency + (Get-Random -Minimum -6 -Maximum 9))
    $state.latencyHistory = @($state.latency)
    Add-Log info $tunnel.name "本机监听已建立 127.0.0.1:$($tunnel.localPort)（演示模式）" -TunnelId $tunnel.id -NoFile
    Add-Log success $tunnel.name "隧道握手完成 · RTT $($state.latency) ms（演示模式）" -TunnelId $tunnel.id -NoFile
    Add-Activity -Kind 'success' -Title '隧道已开启' -Detail "$($tunnel.name) · 127.0.0.1:$($tunnel.localPort) → $($tunnel.remoteHost):$($tunnel.remotePort)" -TunnelId $tunnel.id
}

function Complete-SimulatedClose($tunnel, $state) {
    $state.status = 'offline'
    $state.statusChanged = NowUtc
    $state.pid = $null
    $state.openedAt = $null
    $state.closeAt = $null
    $state.latency = $null
    $state.probeError = ''
    Add-Log info $tunnel.name '隧道已关闭' -TunnelId $tunnel.id -NoFile
    Add-Activity -Kind 'success' -Title '隧道已关闭' -Detail $tunnel.name -TunnelId $tunnel.id
    if ($state.pendingOpen) {
        $state.pendingOpen = $false
        try { Invoke-OpenTunnel $tunnel.id | Out-Null } catch { }
    }
}

function Handle-RealConnectionFailure($tunnel, $state, [string]$reason) {
    $process = if ($state.pid) { Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue } else { $null }
    if ($process -and -not (Stop-RealTunnel $tunnel $state)) {
        $state.status = 'error'
        $state.error = "$reason；无法核实或停止原进程，已保留运行记录，请检查端口归属。"
        $state.retryAt = $null
        return
    }
    $tail = Get-StderrTail $state.stderrPath 5
    $message = $reason
    if ($tail) { $message = $reason + ' ' + ($tail -replace "`r?`n", ' | ') }
    $state.status = if ($tail -match 'Address already in use|cannot listen to port|bind.*(failed|Permission denied)') { 'occupied' } else { 'error' }
    $state.statusChanged = NowUtc
    $state.error = $message
    $state.pid = $null
    $state.openedAt = $null
    Remove-ProcessRecord $tunnel.id
    Add-Log error $tunnel.name "连接失败：$message" -TunnelId $tunnel.id
    Add-Activity -Kind 'error' -Title '连接失败' -Detail "$($tunnel.name) · $reason" -TunnelId $tunnel.id

    if ($state.status -ne 'occupied' -and (To-Bool (Get-Setting 'autoReconnect' $true) $true) -and $state.reconnectCount -lt 5) {
        $state.reconnectCount++
        $delay = [math]::Min(30, 5 * $state.reconnectCount)
        $state.retryAt = (NowUtc).AddSeconds($delay)
        Add-Log warn $tunnel.name "$delay 秒后自动重连（第 $($state.reconnectCount)/5 次）"
        Add-Activity -Kind 'warning' -Title '计划自动重连' -Detail "$($tunnel.name) · $delay 秒后重试第 $($state.reconnectCount) 次" -TunnelId $tunnel.id
    }
}

function Invoke-PanelTick {
    $now = NowUtc
    $simulation = To-Bool (Get-Setting 'simulation' $true) $true
    $latencyEnabled = To-Bool (Get-Setting 'latencyProbe' $true) $true
    $reconnectEnabled = To-Bool (Get-Setting 'autoReconnect' $true) $true

    foreach ($tunnel in @(Get-Tunnels)) {
        $state = Get-TunnelState $tunnel.id
        $elapsed = [math]::Max(0.0, ($now - [DateTime]$state.lastTickAt).TotalSeconds)

        switch ($state.status) {
            'connecting' {
                if ($simulation) {
                    if ($state.connectAt -and $now -ge $state.connectAt) { Complete-SimulatedOpen $tunnel $state }
                } else {
                    if ($null -eq $state.pid) {
                        Handle-RealConnectionFailure $tunnel $state 'SSH 进程未启动'
                    } elseif (-not (Test-ProcessRecord ([ordered]@{ pid = $state.pid; ticks = $state.procStartTicks }))) {
                        Handle-RealConnectionFailure $tunnel $state 'SSH 进程已退出'
                    } elseif (Test-LocalListener $tunnel $state.pid) {
                        $state.status = 'online'
                        $state.statusChanged = NowUtc
                        $state.openedAt = NowUtc
                        $state.error = ''
                        $state.reconnectCount = 0
                        $state.bytesIn = 0
                        $state.bytesOut = 0
                        Add-Log success $tunnel.name "隧道已开启：127.0.0.1:$($tunnel.localPort) → $($tunnel.remoteHost):$($tunnel.remotePort)"
                        Add-Activity -Kind 'success' -Title '隧道已开启' -Detail "$($tunnel.name) · 本机监听已就绪" -TunnelId $tunnel.id
                    } elseif ($state.verifyAt -and $now -gt $state.verifyAt) {
                        Handle-RealConnectionFailure $tunnel $state '等待本机端口监听超时'
                    }
                }
            }
            'online' {
                if (-not $simulation) {
                    if (-not (Test-ProcessRecord ([ordered]@{ pid = $state.pid; ticks = $state.procStartTicks }))) {
                        Handle-RealConnectionFailure $tunnel $state 'SSH 进程意外退出'
                    }
                } else {
                    if ($elapsed -gt 0) {
                        $state.bytesIn += (Get-Random -Minimum 180 -Maximum 2600) * $elapsed
                        $state.bytesOut += (Get-Random -Minimum 90 -Maximum 1400) * $elapsed
                    }
                    if ($state.latencyAt -eq [DateTime]::MinValue -or ($now - $state.latencyAt).TotalSeconds -ge 2.2) {
                        $state.latency = [math]::Max(7, [int]$state.baseLatency + (Get-Random -Minimum -9 -Maximum 12))
                        $state.latencyAt = $now
                        $state.latencyHistory = @($state.latencyHistory) + @([int]$state.latency)
                        while ($state.latencyHistory.Count -gt 40) {
                            $state.latencyHistory = @($state.latencyHistory)[1..($state.latencyHistory.Count - 1)]
                        }
                    }
                    if (($now - $state.lastTrafficLogAt).TotalSeconds -ge 22) {
                        $state.lastTrafficLogAt = $now
                        Add-Log debug $tunnel.name ("转发流量 · 入 {0} / 出 {1}（演示模式）" -f (Format-Bytes $state.bytesIn), (Format-Bytes $state.bytesOut)) -TunnelId $tunnel.id -NoFile
                    }
                }
            }
            'closing' {
                if ($simulation) {
                    if ($state.closeAt -and $now -ge $state.closeAt) { Complete-SimulatedClose $tunnel $state }
                } elseif ($null -eq $state.pid) {
                    $state.status = 'offline'
                    $state.statusChanged = NowUtc
                    $state.openedAt = $null
                }
            }
            'error' {
                if ($reconnectEnabled -and $null -ne $state.retryAt -and $now -ge $state.retryAt) {
                    $state.retryAt = $null
                    try { Invoke-OpenTunnel $tunnel.id | Out-Null } catch { }
                }
            }
        }
        $state.lastTickAt = $now
    }

    # Round-robin real latency probing (at most one tunnel per tick).
    if (-not $simulation -and $latencyEnabled) {
        $candidates = @()
        foreach ($tunnel in @(Get-Tunnels)) {
            $state = Get-TunnelState $tunnel.id
            if ($state.status -eq 'online' -and ($now - [DateTime]$state.latencyAt).TotalSeconds -ge 6) {
                $candidates += [pscustomobject]@{ Tunnel = $tunnel; At = $state.latencyAt }
            }
        }
        if ($candidates.Count -gt 0) {
            $next = $candidates | Sort-Object At | Select-Object -First 1
            Update-TunnelLatency $next.Tunnel
        }
    }

    # Traffic rate + history.
    $total = Get-TotalTraffic
    $seconds = [math]::Max(0.05, ($now - $script:LastRateAt).TotalSeconds)
    if ($seconds -ge 0.5) {
        $rate = ($total - $script:LastRateBytes) / $seconds
        $script:CurrentRate = [int][math]::Max(0, ($script:CurrentRate * 0.55) + ($rate * 0.45))
        $script:LastRateBytes = $total
        $script:LastRateAt = $now
    }
    if (($now - $script:LastHistoryAt).TotalSeconds -ge 2) { Push-MetricsHistory }
}

# ------------------------------------------------------------
#  Snapshots for the API
# ------------------------------------------------------------

function Get-ServerRuntimeStatus([string]$serverId) {
    $online = 0
    $connecting = 0
    foreach ($tunnel in @(Get-Tunnels)) {
        if ($tunnel.serverId -ne $serverId) { continue }
        $state = Get-TunnelState $tunnel.id
        if ($state.status -eq 'online') { $online++ }
        elseif ($state.status -eq 'connecting') { $connecting++ }
    }
    if ($online -gt 0) { return 'online' }
    if ($connecting -gt 0) { return 'connecting' }
    return 'idle'
}

function Get-Metrics {
    $online = 0
    $connecting = 0
    $errors = 0
    $latSum = 0.0
    $latCount = 0
    $bytesIn = 0.0
    $bytesOut = 0.0
    foreach ($tunnel in @(Get-Tunnels)) {
        $state = Get-TunnelState $tunnel.id
        switch ($state.status) {
            'online' { $online++ }
            'connecting' { $connecting++ }
            'error' { $errors++ }
        }
        if ($state.status -eq 'online' -and $null -ne $state.latency) {
            $latSum += [double]$state.latency
            $latCount++
        }
        $bytesIn += [double]$state.bytesIn
        $bytesOut += [double]$state.bytesOut
    }
    $history = @()
    foreach ($entry in $script:MetricsHistory) { $history += $entry }
    return [ordered]@{
        total      = @(Get-Tunnels).Count
        online     = $online
        connecting = $connecting
        errors     = $errors
        avgLatency = if ($latCount -gt 0) { [int][math]::Round($latSum / $latCount) } else { 0 }
        rate       = [int]$script:CurrentRate
        traffic    = [ordered]@{ in = [long]$bytesIn; out = [long]$bytesOut; total = [long]($bytesIn + $bytesOut) }
        history    = $history
        uptimeSec  = [int]((NowUtc) - $script:StartedAt).TotalSeconds
        startedAt  = To-Iso $script:StartedAt
    }
}

function Get-RuntimeSnapshot {
    $result = [ordered]@{}
    foreach ($tunnel in @(Get-Tunnels)) {
        $state = Get-TunnelState $tunnel.id
        $uptime = 0
        if ($state.status -eq 'online' -and $state.openedAt) {
            $uptime = [int]((NowUtc) - [DateTime]$state.openedAt).TotalSeconds
        }
        $result[$tunnel.id] = [ordered]@{
            status         = $state.status
            error          = $state.error
            pid            = $state.pid
            since          = To-Iso $state.statusChanged
            openedAt       = To-Iso $state.openedAt
            uptimeSec      = $uptime
            latency        = $state.latency
            latencyHistory = @($state.latencyHistory)
            probeError     = $state.probeError
            bytesIn        = [long]$state.bytesIn
            bytesOut       = [long]$state.bytesOut
            reconnectCount = $state.reconnectCount
            retryIn        = if ($state.retryAt) { [int][math]::Max(0, ([DateTime]$state.retryAt - (NowUtc)).TotalSeconds) } else { 0 }
            url            = Get-TunnelUrl $tunnel
            probe          = Get-EffectiveProbe $tunnel
        }
    }
    return $result
}

function Get-ActivitySnapshot([int]$limit = 60) {
    $items = @()
    foreach ($entry in $script:ActivityBuffer) { $items += $entry }
    if ($items.Count -gt $limit) { $items = @($items)[($items.Count - $limit)..($items.Count - 1)] }
    [array]::Reverse($items)
    return $items
}

function Get-ServersSnapshot {
    $result = @()
    foreach ($server in @(Get-Servers)) {
        $tunnels = @(Get-Tunnels | Where-Object { $_.serverId -eq $server.id })
        $online = 0
        foreach ($tunnel in $tunnels) {
            if ((Get-TunnelState $tunnel.id).status -eq 'online') { $online++ }
        }
        $copy = [ordered]@{}
        foreach ($key in $server.Keys) { $copy[$key] = $server[$key] }
        $copy['status'] = Get-ServerRuntimeStatus $server.id
        $copy['tunnelCount'] = $tunnels.Count
        $copy['onlineCount'] = $online
        $copy['hasKey'] = if ($server.keyPath) { Test-Path -LiteralPath (Resolve-KeyPath $server.keyPath) } else { $false }
        $copy['resolvedKeyPath'] = Resolve-KeyPath $server.keyPath
        $result += $copy
    }
    return $result
}

function Get-TunnelsSnapshot {
    $result = @()
    foreach ($tunnel in @(Get-Tunnels)) {
        $server = Get-Server $tunnel.serverId
        $copy = [ordered]@{}
        foreach ($key in $tunnel.Keys) { $copy[$key] = $tunnel[$key] }
        $copy['server'] = if ($server) { [ordered]@{ id = $server.id; name = $server.name; host = $server.host; port = $server.port; user = $server.user; color = $server.color } } else { $null }
        $copy['url'] = Get-TunnelUrl $tunnel
        $copy['effectiveProbe'] = Get-EffectiveProbe $tunnel
        $result += $copy
    }
    return $result
}

function Get-Bootstrap {
    $browserStatus = Get-EdgeProfileStatus
    return [ordered]@{
        ok       = $true
        app      = $script:AppName
        version  = $script:AppVersion
        token    = $script:Token
        now      = To-Iso (NowUtc)
        settings = $script:Config.settings
        servers  = @(Get-ServersSnapshot)
        tunnels  = @(Get-TunnelsSnapshot)
        browserProfiles = $browserStatus.profiles
        browserProfileSupport = $browserStatus
        runtime  = Get-RuntimeSnapshot
        metrics  = Get-Metrics
        activity = @(Get-ActivitySnapshot 50)
        autostart = Get-AutostartInfo
        applicationShortcut = Get-ApplicationShortcutInfo
        env      = [ordered]@{
            platform    = [System.Environment]::OSVersion.VersionString
            powershell  = $PSVersionTable.PSVersion.ToString()
            ssh         = Get-SshPath
            sshAvailable = [bool](Get-SshPath)
            panelPort   = [int](Get-Setting 'panelPort' 9666)
            dataPath    = $script:ConfigPath
            logsPath    = $script:LogDir
            rootPath    = $script:RootDir
            demo        = To-Bool (Get-Setting 'simulation' $true) $true
            startedAt   = To-Iso $script:StartedAt
        }
        commands = Get-SshCommandBundle -HostName ([string](Get-Setting 'defaultHost' '')) -Port ([int](Get-Setting 'defaultPort' 22)) -User ([string](Get-Setting 'defaultUser' 'root')) -KeyPath ([string](Get-Setting 'defaultKeyPath' '~/.ssh/id_ed25519')) -Alias 'tunnelstudio'
    }
}

function Get-StateSnapshot {
    return [ordered]@{
        ok        = $true
        now       = To-Iso (NowUtc)
        runtime   = Get-RuntimeSnapshot
        metrics   = Get-Metrics
        activity  = @(Get-ActivitySnapshot 50)
        servers   = @(Get-ServersSnapshot)
        simulation = To-Bool (Get-Setting 'simulation' $true) $true
        sshAvailable = [bool](Get-SshPath)
        autostart = Get-AutostartInfo
        applicationShortcut = Get-ApplicationShortcutInfo
    }
}

function Get-LogSnapshot([string]$source = 'all', [long]$since = 0, [int]$limit = 300, [string]$query = '') {
    $items = @()
    foreach ($entry in $script:LogBuffer) {
        if ($entry.id -le $since) { continue }
        if ($source -and $source -ne 'all') {
            if ($source -eq 'panel') { if ($entry.tunnelId) { continue } }
            elseif ($entry.tunnelId -ne $source) { continue }
        }
        if ($query) {
            if ($entry.text -notmatch [regex]::Escape($query)) { continue }
        }
        $items += $entry
    }
    if ($items.Count -gt $limit) { $items = @($items)[($items.Count - $limit)..($items.Count - 1)] }
    return [ordered]@{ ok = $true; lines = $items; lastId = $script:LogCounter }
}

function Clear-Logs {
    $script:LogBuffer.Clear()
    Add-Log info 'panel' '日志已清空'
}

# ------------------------------------------------------------
#  Init
# ------------------------------------------------------------

function Initialize-Core {
    Ensure-Directory $script:LogDir
    Ensure-Directory $script:WebDir
    Ensure-Directory (Join-Path $script:LogDir 'tunnels')
    $script:Token = New-Token
    $script:MetricsHistory.Clear()
    Load-Config
    Sync-RuntimeStates
    $script:StartedAt = NowUtc

    if (Test-Path -LiteralPath $script:RuntimePath) {
        try {
            $records = Read-JsonFile $script:RuntimePath
            if ($records) { $script:ProcessRecords = $records }
        } catch { }
    }
    Restore-ProcessRecords

    Add-Log info 'panel' "Tunnel Studio v$($script:AppVersion) 已启动 · $([System.Environment]::OSVersion.VersionString)"
    Add-Activity -Kind 'success' -Title '控制台已就绪' -Detail "面板 v$($script:AppVersion) · $(Get-Tunnels | Measure-Object | Select-Object -ExpandProperty Count) 条隧道配置"

    if (To-Bool (Get-Setting 'autoOpenOnLaunch' $false) $false) {
        foreach ($tunnel in @(Get-Tunnels)) {
            if (To-Bool $tunnel.autoOpen $false) {
                try { Invoke-OpenTunnel $tunnel.id | Out-Null } catch { }
            }
        }
    }
}
