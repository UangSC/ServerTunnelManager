#requires -Version 5.1
# ============================================================
#  Tunnel Studio - local web server
#  Loopback-only HttpListener alternative (raw TcpListener),
#  static assets, JSON API, security token.
# ============================================================

[CmdletBinding()]
param(
    [int]$Port = 0
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    $consoleUtf8 = New-Object System.Text.UTF8Encoding($false)
    [Console]::OutputEncoding = $consoleUtf8
    [Console]::InputEncoding = $consoleUtf8
    $OutputEncoding = $consoleUtf8
} catch { }
$script:PanelDir = $PSScriptRoot
. (Join-Path $script:PanelDir 'Core.ps1')
. (Join-Path $script:PanelDir 'Extras.ps1')
. (Join-Path $script:PanelDir 'Dsh.ps1')
. (Join-Path $script:PanelDir 'Sync.ps1')
. (Join-Path $script:PanelDir 'Http.ps1')
. (Join-Path $script:PanelDir 'Shortcuts.ps1')

# ------------------------------------------------------------
#  HTTP response helpers
# ------------------------------------------------------------

$script:StatusText = @{
    200 = 'OK'; 201 = 'Created'; 204 = 'No Content'; 400 = 'Bad Request';
    401 = 'Unauthorized'; 403 = 'Forbidden'; 404 = 'Not Found'; 405 = 'Method Not Allowed';
    413 = 'Payload Too Large'; 415 = 'Unsupported Media Type'; 500 = 'Internal Server Error';
}

function Send-Bytes($client, [int]$status, [string]$contentType, [byte[]]$bytes, [hashtable]$extraHeaders = @{}) {
    $stream = $client.GetStream()
    $text = $script:StatusText[$status]
    if (-not $text) { $text = 'OK' }
    $header = "HTTP/1.1 $status $text`r`n"
    $header += "Content-Type: $contentType`r`n"
    $header += "Content-Length: $($bytes.Length)`r`n"
    $header += "Connection: close`r`n"
    $header += "Cache-Control: no-store, no-cache, must-revalidate`r`n"
    $header += "Pragma: no-cache`r`n"
    $header += "X-Content-Type-Options: nosniff`r`n"
    $header += "X-Frame-Options: DENY`r`n"
    $header += "Referrer-Policy: no-referrer`r`n"
    foreach ($key in $extraHeaders.Keys) { $header += "$key`: $($extraHeaders[$key])`r`n" }
    $header += "`r`n"
    $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
    $stream.Write($headerBytes, 0, $headerBytes.Length)
    if ($bytes.Length -gt 0) { $stream.Write($bytes, 0, $bytes.Length) }
    $stream.Flush()
}

function Send-Json($client, $data, [int]$status = 200) {
    $json = ConvertTo-Json -InputObject $data -Depth 16 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    Send-Bytes $client $status 'application/json; charset=utf-8' $bytes
}

function Send-Error($client, [string]$message, [int]$status = 400) {
    Send-Json $client ([ordered]@{ ok = $false; error = $message }) $status
}

function Get-ContentType([string]$path) {
    switch ([System.IO.Path]::GetExtension($path).ToLowerInvariant()) {
        '.html' { return 'text/html; charset=utf-8' }
        '.css' { return 'text/css; charset=utf-8' }
        '.js' { return 'application/javascript; charset=utf-8' }
        '.mjs' { return 'application/javascript; charset=utf-8' }
        '.json' { return 'application/json; charset=utf-8' }
        '.svg' { return 'image/svg+xml' }
        '.png' { return 'image/png' }
        '.jpg' { return 'image/jpeg' }
        '.jpeg' { return 'image/jpeg' }
        '.webp' { return 'image/webp' }
        '.ico' { return 'image/x-icon' }
        '.woff2' { return 'font/woff2' }
        '.woff' { return 'font/woff' }
        '.ttf' { return 'font/ttf' }
        default { return 'application/octet-stream' }
    }
}

# ------------------------------------------------------------
#  Request parsing
# ------------------------------------------------------------

function Read-HttpRequest([byte[]]$requestBytes) {
    # The listener passes a complete request; parsing never waits on a socket.
    $stream = [System.IO.MemoryStream]::new($requestBytes, $false)
    $buffer = New-Object byte[] 8192
    $memory = New-Object System.IO.MemoryStream
    $headerEnd = -1
    $all = $null

    while ($headerEnd -lt 0) {
        $read = $stream.Read($buffer, 0, $buffer.Length)
        if ($read -le 0) { return $null }
        $memory.Write($buffer, 0, $read)
        if ($memory.Length -gt 65536) { return $null }
        $all = $memory.ToArray()
        for ($i = 0; $i -le $all.Length - 4; $i++) {
            if ($all[$i] -eq 13 -and $all[$i + 1] -eq 10 -and $all[$i + 2] -eq 13 -and $all[$i + 3] -eq 10) {
                $headerEnd = $i
                break
            }
        }
    }

    $headerLength = $headerEnd + 4
    $headerText = [System.Text.Encoding]::ASCII.GetString($all, 0, $headerEnd)
    $lines = $headerText -split "`r`n"
    if ($lines.Length -lt 1) { return $null }
    $requestLine = $lines[0] -split ' '
    if ($requestLine.Length -lt 3) { return $null }
    $method = $requestLine[0].ToUpperInvariant()
    $target = $requestLine[1]
    if ($method -notin @('GET', 'POST', 'PATCH', 'DELETE', 'PUT', 'HEAD')) { return $null }

    $headers = @{}
    for ($i = 1; $i -lt $lines.Length; $i++) {
        $line = $lines[$i]
        $colon = $line.IndexOf(':')
        if ($colon -le 0) { continue }
        $name = $line.Substring(0, $colon).Trim().ToLowerInvariant()
        $value = $line.Substring($colon + 1).Trim()
        $headers[$name] = $value
    }

    $pathAndQuery = $target
    if ($pathAndQuery -match '^https?://[^/]+(.*)$') { $pathAndQuery = $matches[1] }
    $queryIndex = $pathAndQuery.IndexOf('?')
    $rawPath = if ($queryIndex -ge 0) { $pathAndQuery.Substring(0, $queryIndex) } else { $pathAndQuery }
    $rawQuery = if ($queryIndex -ge 0) { $pathAndQuery.Substring($queryIndex + 1) } else { '' }
    try { $path = [System.Uri]::UnescapeDataString($rawPath) } catch { $path = $rawPath }
    if (-not $path.StartsWith('/')) { $path = '/' + $path }

    $query = @{}
    if ($rawQuery) {
        foreach ($pair in $rawQuery.Split('&')) {
            if ([string]::IsNullOrWhiteSpace($pair)) { continue }
            $parts = $pair.Split('=', 2)
            try {
                $name = [System.Uri]::UnescapeDataString($parts[0].Replace('+', ' '))
                $value = if ($parts.Length -gt 1) { [System.Uri]::UnescapeDataString($parts[1].Replace('+', ' ')) } else { '' }
                $query[$name] = $value
            } catch { }
        }
    }

    $contentLength = 0
    if ($headers.ContainsKey('content-length')) {
        [void][int]::TryParse($headers['content-length'], [ref]$contentLength)
    }
    if ($contentLength -gt 2097152) { throw '请求内容过大。' }
    $bodyBytes = New-Object byte[] $contentLength
    $already = $all.Length - $headerLength
    if ($already -gt $contentLength) { $already = $contentLength }
    if ($already -gt 0) { [Array]::Copy($all, $headerLength, $bodyBytes, 0, $already) }
    $remaining = $contentLength - $already
    $offset = $already
    while ($remaining -gt 0) {
        $read = $stream.Read($bodyBytes, $offset, $remaining)
        if ($read -le 0) { break }
        $offset += $read
        $remaining -= $read
    }

    return [ordered]@{
        Method    = $method
        Target    = $target
        Path      = $path
        Query     = $query
        Headers   = $headers
        BodyBytes = $bodyBytes
    }
}

function Get-RequestBody($request) {
    if ($null -eq $request.BodyBytes -or $request.BodyBytes.Length -eq 0) { return $null }
    $text = [System.Text.Encoding]::UTF8.GetString($request.BodyBytes)
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    try {
        return ConvertTo-Data (ConvertFrom-Json -InputObject $text)
    } catch {
        throw '请求数据不是合法的 JSON。'
    }
}

# ------------------------------------------------------------
#  Static files
# ------------------------------------------------------------

function Send-Static($client, [string]$path) {
    if ($path -eq '/' -or $path -eq '/index.html') {
        $indexPath = Join-Path $script:WebDir 'index.html'
        if (-not (Test-Path -LiteralPath $indexPath)) {
            Send-Error $client '前端文件缺失，请确认 Panel\web\index.html 存在。' 500
            return
        }
        $html = [System.IO.File]::ReadAllText($indexPath, [System.Text.Encoding]::UTF8)
        $html = $html.Replace('__PANEL_TOKEN__', $script:Token)
        $html = $html.Replace('__APP_VERSION__', $script:AppVersion)
        $html = $html.Replace('__PANEL_PORT__', [string](Get-Setting 'panelPort' 9666))
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($html)
        Send-Bytes $client 200 'text/html; charset=utf-8' $bytes @{
            'Content-Security-Policy' = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
        }
        return
    }

    if ($path -eq '/favicon.ico') {
        Send-Bytes $client 204 'image/x-icon' ([byte[]]@())
        return
    }

    $relative = $path.TrimStart('/')
    $relative = $relative -replace '/', [System.IO.Path]::DirectorySeparatorChar
    $webRoot = [System.IO.Path]::GetFullPath($script:WebDir)
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $webRoot $relative))
    $webRootPrefix = $webRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith($webRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        Send-Error $client '路径无效。' 403
        return
    }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        Send-Error $client '资源不存在。' 404
        return
    }
    try {
        $bytes = [System.IO.File]::ReadAllBytes($candidate)
        Send-Bytes $client 200 (Get-ContentType $candidate) $bytes
    } catch {
        Send-Error $client '读取资源失败。' 500
    }
}

# ------------------------------------------------------------
#  Settings / import / export
# ------------------------------------------------------------

function Update-Settings($body) {
    if ($null -eq $body -or $body -isnot [System.Collections.IDictionary]) { throw '设置数据格式不正确。' }

    if ($body.Contains('simulation')) {
        $next = To-Bool $body.simulation (To-Bool (Get-Setting 'simulation' $true) $true)
        $current = To-Bool (Get-Setting 'simulation' $true) $true
        if ($next -ne $current) {
            foreach ($tunnel in @(Get-Tunnels)) {
                $state = Get-TunnelState $tunnel.id
                if ($state.status -in @('online', 'connecting', 'closing')) {
                    throw '请先关闭所有隧道，再切换演示/真实模式。'
                }
            }
            Set-Setting 'simulation' $next
            $script:ProcessRecords = @{}
            Save-ProcessRecords
            Add-Log warn 'panel' ('运行模式切换为：' + $(if ($next) { '演示模式' } else { '真实 SSH 模式' }))
            Add-Activity -Kind 'warning' -Title '运行模式已切换' -Detail $(if ($next) { '演示模式 · 不会启动真实 SSH 进程' } else { '真实模式 · 将调用本机 ssh.exe' })
        }
    }

    if ($body.Contains('theme')) {
        $theme = [string]$body.theme
        if ($theme -in @('dark', 'light')) { Set-Setting 'theme' $theme }
    }
    if ($body.Contains('accent')) {
        $accent = [string]$body.accent
        if ($accent -in @('violet', 'ocean', 'emerald', 'amber', 'rose')) { Set-Setting 'accent' $accent }
    }
    if ($body.Contains('refreshMs')) {
        $ms = 0
        if ([int]::TryParse([string]$body.refreshMs, [ref]$ms) -and $ms -ge 700 -and $ms -le 15000) { Set-Setting 'refreshMs' $ms }
    }
    foreach ($flag in @('latencyProbe', 'autoReconnect', 'confirmDelete', 'autoOpenOnLaunch', 'strictHostKeyChecking', 'openBrowserOnStart')) {
        if ($body.Contains($flag)) { Set-Setting $flag (To-Bool $body[$flag] (To-Bool (Get-Setting $flag $true) $true)) }
    }
    if ($body.Contains('panelPort')) {
        $value = 0
        if ([int]::TryParse([string]$body.panelPort, [ref]$value) -and $value -ge 1024 -and $value -le 65535) {
            Set-Setting 'panelPort' $value
        }
    }
    if ($body.Contains('defaultUser')) {
        $user = ([string]$body.defaultUser).Trim()
        if ($user -match '^[A-Za-z0-9._\-]+$') { Set-Setting 'defaultUser' $user }
    }
    if ($body.Contains('defaultPort')) {
        $value = 0
        if ([int]::TryParse([string]$body.defaultPort, [ref]$value) -and $value -ge 1 -and $value -le 65535) { Set-Setting 'defaultPort' $value }
    }
    if ($body.Contains('defaultKeyPath')) {
        $keyPath = ([string]$body.defaultKeyPath).Trim()
        if ($keyPath -and $keyPath.Length -le 260) { Set-Setting 'defaultKeyPath' $keyPath }
    }
    if ($body.Contains('connectTimeout')) {
        $value = 0
        if ([int]::TryParse([string]$body.connectTimeout, [ref]$value) -and $value -ge 3 -and $value -le 120) { Set-Setting 'connectTimeout' $value }
    }
    if ($body.Contains('serverAliveInterval')) {
        $value = 0
        if ([int]::TryParse([string]$body.serverAliveInterval, [ref]$value) -and $value -ge 5 -and $value -le 300) { Set-Setting 'serverAliveInterval' $value }
    }
    if ($body.Contains('serverAliveCountMax')) {
        $value = 0
        if ([int]::TryParse([string]$body.serverAliveCountMax, [ref]$value) -and $value -ge 1 -and $value -le 10) { Set-Setting 'serverAliveCountMax' $value }
    }

    Save-Config
    Add-Log info 'panel' '面板设置已更新'
    return $script:Config.settings
}

function Stop-AllTunnels {
    $count = 0
    foreach ($tunnel in @(Get-Tunnels)) {
        $state = Get-TunnelState $tunnel.id
        if ($state.status -ne 'offline') {
            Stop-TunnelHard $tunnel.id
            $count++
        }
    }
    return $count
}

function Backup-PanelConfig {
    $directory = Join-Path $script:PanelDir 'backups'
    Ensure-Directory $directory
    $name = 'import-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N') + '.json'
    $path = Join-Path $directory $name
    Write-JsonFile $path $script:Config
    return $path
}

function Import-PanelConfig($data) {
    if ($null -eq $data -or $data -isnot [System.Collections.IDictionary]) { throw '导入文件格式不正确。' }
    if (-not $data.Contains('tunnels')) { throw '导入文件缺少隧道列表。' }
    $data = ConvertTo-Data $data
    $tunnels = As-Array $data.tunnels
    if ($tunnels.Count -gt 200) { throw '隧道数量超过上限（200）。' }
    $settings = Merge-Settings $(if ($data.Contains('settings')) { $data.settings } else { $script:Config.settings })
    $settings.simulation = $true
    $settings.autoOpenOnLaunch = $false
    $servers = As-Array $(if ($data.Contains('servers')) { $data.servers } else { @() })
    foreach ($server in $servers) {
        if ($server -is [System.Collections.IDictionary]) { $server['passwordless'] = $false }
    }
    foreach ($tunnel in $tunnels) {
        if ($tunnel -is [System.Collections.IDictionary]) { $tunnel['autoOpen'] = $false }
    }
    # A cross-device import must never activate another machine's real SSH or
    # enrollment preferences. Preserve the current configuration before edits.
    $backup = Backup-PanelConfig

    $stopped = Stop-AllTunnels
    $script:ProcessRecords = @{}
    Save-ProcessRecords

    $temp = Join-Path $env:TEMP ('tunnelstudio-import-' + [guid]::NewGuid().ToString('N') + '.json')
    $originalPath = $script:ConfigPath
    try {
        $payload = [ordered]@{
            version   = 2
            createdAt = To-Iso (NowUtc)
            settings  = $settings
            servers   = $servers
            tunnels   = $tunnels
        }
        Write-JsonFile $temp $payload
        $script:ConfigPath = $temp
        Load-Config
    } finally {
        $script:ConfigPath = $originalPath
        if (Test-Path -LiteralPath $temp) { try { Remove-Item -LiteralPath $temp -Force } catch { } }
    }
    $script:State = @{}
    Sync-RuntimeStates
    Save-Config
    Add-Log warn 'panel' "已导入配置：$(@(Get-Servers).Count) 个服务器 / $(@(Get-Tunnels).Count) 条隧道（已停止 $stopped 条运行中隧道）"
    Add-Activity -Kind 'warning' -Title '导入配置' -Detail "已载入 $(@(Get-Tunnels).Count) 条隧道映射"
    return [ordered]@{ servers = @(Get-Servers).Count; tunnels = @(Get-Tunnels).Count; backup = $backup }
}

function Reset-PanelConfig {
    $stopped = Stop-AllTunnels
    $script:ProcessRecords = @{}
    Save-ProcessRecords
    $port = [int](Get-Setting 'panelPort' 9666)
    $theme = [string](Get-Setting 'theme' 'dark')
    $accent = [string](Get-Setting 'accent' 'violet')
    $simulation = To-Bool (Get-Setting 'simulation' $true) $true
    $config = New-DefaultConfig
    $config.settings.panelPort = $port
    $config.settings.theme = $theme
    $config.settings.accent = $accent
    $config.settings.simulation = $simulation
    $script:Config = $config
    $script:State = @{}
    Save-Config
    Add-Log warn 'panel' '面板配置已重置为空。'
    Add-Activity -Kind 'warning' -Title '重置配置' -Detail "已清空服务器与隧道（已停止 $stopped 条运行中隧道）"
}

function Open-PanelFolder([string]$kind) {
    $path = switch ($kind) {
        'logs' { $script:LogDir }
        'web' { $script:WebDir }
        default { $script:PanelDir }
    }
    if (-not (Test-Path -LiteralPath $path)) { throw '目录不存在。' }
    Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $path + '"')
}

function Open-PanelUrl([string]$url) {
    if ([string]::IsNullOrWhiteSpace($url)) { throw '没有可打开的地址。' }
    if ($url -notmatch '^(?i)https?://') { throw '仅支持打开 HTTP(S) 地址。' }
    $url = Resolve-DshPanelUrl $url
    Start-Process $url
}

# ------------------------------------------------------------
#  API routing
# ------------------------------------------------------------

function Invoke-ApiRoute($request) {
    $method = $request.Method
    $path = $request.Path
    $query = $request.Query
    $bodyCache = $null
    $getBody = {
        if ($null -eq $bodyCache) { $bodyCache = Get-RequestBody $request }
        return $bodyCache
    }

    if ($method -eq 'GET' -and $path -eq '/api/health') { return $null }
    if ($path.StartsWith('/api/sync/')) {
        return Invoke-SyncRoute $method $path $(if ($method -eq 'GET') { @{} } else { & $getBody })
    }

    if ($method -eq 'GET' -and $path -eq '/api/bootstrap') {
        return Get-Bootstrap
    }
    if ($method -eq 'GET' -and $path -eq '/api/state') {
        return Get-StateSnapshot
    }
    if ($method -eq 'GET' -and $path -eq '/api/logs') {
        $source = if ($query.ContainsKey('source')) { [string]$query['source'] } else { 'all' }
        $since = 0L
        if ($query.ContainsKey('since')) { [void][long]::TryParse([string]$query['since'], [ref]$since) }
        $limit = 300
        if ($query.ContainsKey('limit')) { [void][int]::TryParse([string]$query['limit'], [ref]$limit) }
        if ($limit -lt 20) { $limit = 20 }
        if ($limit -gt 1000) { $limit = 1000 }
        return Get-LogSnapshot -source $source -since $since -limit $limit
    }
    if ($method -eq 'POST' -and $path -eq '/api/logs/clear') {
        Clear-Logs
        return [ordered]@{ ok = $true }
    }
    if ($method -eq 'POST' -and $path -eq '/api/activity/clear') {
        $script:ActivityBuffer.Clear()
        Add-Activity -Kind 'info' -Title '活动已清空' -Detail '新的操作会继续记录在这里'
        return [ordered]@{ ok = $true }
    }

    if ($method -eq 'GET' -and $path -eq '/api/tunnels') {
        return [ordered]@{ ok = $true; tunnels = @(Get-TunnelsSnapshot) }
    }
    if ($method -eq 'GET' -and $path -match '^/api/tunnels/([^/]+)$') {
        $id = $matches[1]
        $tunnel = @(Get-TunnelsSnapshot | Where-Object { $_.id -eq $id })
        if ($tunnel.Count -eq 0) { throw '隧道不存在或已被删除。' }
        return [ordered]@{ ok = $true; tunnel = $tunnel[0] }
    }
    if ($method -eq 'POST' -and $path -eq '/api/tunnels') {
        $body = & $getBody
        $tunnel = Add-Tunnel $body
        return [ordered]@{ ok = $true; tunnel = $tunnel }
    }
    if ($path -match '^/api/tunnels/([^/]+)$' -and $method -in @('PATCH', 'PUT')) {
        $body = & $getBody
        $tunnel = Update-Tunnel $matches[1] $body
        return [ordered]@{ ok = $true; tunnel = $tunnel }
    }
    if ($path -match '^/api/tunnels/([^/]+)$' -and $method -eq 'DELETE') {
        $tunnel = Remove-Tunnel $matches[1]
        return [ordered]@{ ok = $true; id = $tunnel.id }
    }
    if ($method -eq 'GET' -and $path -match '^/api/tunnels/([^/]+)/port$') {
        $tunnel = Get-Tunnel $matches[1]
        if (-not $tunnel) { throw '隧道不存在或已被删除。' }
        return [ordered]@{ ok = $true; port = [int]$tunnel.localPort; host = [string]$tunnel.localHost; diagnosis = (Get-TunnelPortInfo $tunnel) }
    }
    if ($method -eq 'POST' -and $path -match '^/api/tunnels/([^/]+)/(open|close|restart|probe)$') {
        $id = $matches[1]
        $action = $matches[2]
        $tunnel = Get-Tunnel $id
        if ($null -eq $tunnel) { throw '隧道不存在或已被删除。' }
        switch ($action) {
            'open' { Invoke-OpenTunnel $id | Out-Null }
            'close' { Invoke-CloseTunnel $id | Out-Null }
            'restart' { Invoke-RestartTunnel $id | Out-Null }
            'probe' {
                if ((Get-TunnelState $id).status -ne 'online') { throw '隧道未开启，无法探测延迟。' }
                Update-TunnelLatency $tunnel
                $state = Get-TunnelState $id
                return [ordered]@{ ok = $true; latency = $state.latency; error = $state.probeError; history = @($state.latencyHistory) }
            }
        }
        return [ordered]@{ ok = $true; id = $id; action = $action; state = Get-RuntimeSnapshot }
    }
    if ($method -eq 'POST' -and $path -eq '/api/batch') {
        $body = & $getBody
        if ($null -eq $body) { throw '缺少批量操作参数。' }
        $action = ([string]$body.action).ToLowerInvariant()
        if ($action -notin @('open', 'close', 'restart', 'delete')) { throw '不支持的批量操作。' }
        $ids = @(As-Array $body.ids)
        if ($ids.Count -eq 0) {
            $ids = @(Get-Tunnels | ForEach-Object { $_.id })
        }
        $results = @()
        foreach ($id in $ids) {
            try {
                switch ($action) {
                    'open' { Invoke-OpenTunnel ([string]$id) | Out-Null }
                    'close' { Invoke-CloseTunnel ([string]$id) | Out-Null }
                    'restart' { Invoke-RestartTunnel ([string]$id) | Out-Null }
                    'delete' { Remove-Tunnel ([string]$id) | Out-Null }
                }
                $results += [ordered]@{ id = $id; ok = $true }
            } catch {
                $results += [ordered]@{ id = $id; ok = $false; error = $_.Exception.Message }
            }
        }
        return [ordered]@{ ok = $true; results = $results }
    }
    if ($method -eq 'POST' -and $path -eq '/api/tunnels/order') {
        $body = & $getBody
        $ids = @(As-Array $body.ids)
        $ordered = New-Object System.Collections.ArrayList
        foreach ($id in $ids) {
            $tunnel = Get-Tunnel ([string]$id)
            if ($tunnel) { [void]$ordered.Add($tunnel) }
        }
        foreach ($tunnel in @(Get-Tunnels)) {
            if ($ids -notcontains $tunnel.id) { [void]$ordered.Add($tunnel) }
        }
        $script:Config.tunnels = $ordered.ToArray()
        Save-Config
        return [ordered]@{ ok = $true }
    }

    if ($method -eq 'GET' -and $path -eq '/api/servers') {
        return [ordered]@{ ok = $true; servers = @(Get-ServersSnapshot) }
    }
    if ($method -eq 'GET' -and $path -match '^/api/servers/([^/]+)$') {
        $id = $matches[1]
        $server = @(Get-ServersSnapshot | Where-Object { $_.id -eq $id })
        if ($server.Count -eq 0) { throw '服务器不存在或已被删除。' }
        return [ordered]@{ ok = $true; server = $server[0] }
    }
    if ($method -eq 'POST' -and $path -eq '/api/servers') {
        $body = & $getBody
        $server = Add-Server $body
        return [ordered]@{ ok = $true; server = $server }
    }
    if ($path -match '^/api/servers/([^/]+)$' -and $method -in @('PATCH', 'PUT')) {
        $body = & $getBody
        $server = Update-Server $matches[1] $body
        return [ordered]@{ ok = $true; server = $server }
    }
    if ($path -match '^/api/servers/([^/]+)$' -and $method -eq 'DELETE') {
        $server = Remove-Server $matches[1]
        return [ordered]@{ ok = $true; id = $server.id }
    }
    if ($path -match '^/api/servers/([^/]+)/test$' -and $method -eq 'POST') {
        $result = Test-ServerConnectivity $matches[1]
        return [ordered]@{ ok = $result.ok; ms = $result.ms; error = $result.error }
    }
    if ($path -match '^/api/servers/([^/]+)/command$' -and $method -eq 'POST') {
        $server = Get-Server $matches[1]
        if ($null -eq $server) { throw '服务器不存在或已被删除。' }
        return [ordered]@{ ok = $true; command = Get-SshCommandBundle -HostName $server.host -Port ([int]$server.port) -User $server.user -KeyPath $server.keyPath }
    }

    if ($method -eq 'GET' -and $path -eq '/api/settings') {
        return [ordered]@{ ok = $true; settings = $script:Config.settings; autostart = Get-AutostartInfo; applicationShortcut = Get-ApplicationShortcutInfo }
    }
    if ($path -eq '/api/application-shortcut' -and $method -eq 'GET') {
        return [ordered]@{ ok = $true; applicationShortcut = Get-ApplicationShortcutInfo }
    }
    if ($path -eq '/api/application-shortcut' -and $method -eq 'POST') {
        $body = & $getBody
        if ($null -eq $body -or $body -isnot [System.Collections.IDictionary] -or
            -not $body.Contains('enabled') -or $body.enabled -isnot [bool]) {
            throw '快捷图标参数必须包含 enabled 布尔值。'
        }
        $info = Set-ApplicationShortcut ([bool]$body.enabled)
        Add-Log info 'panel' $(if ($body.enabled) { '已安装 Windows 面板快捷图标' } else { '已移除当前项目的 Windows 面板快捷图标' })
        return [ordered]@{ ok = $true; applicationShortcut = $info }
    }
    if ($method -eq 'POST' -and $path -eq '/api/settings') {
        $body = & $getBody
        $settings = Update-Settings $body
        return [ordered]@{ ok = $true; settings = $settings; autostart = Get-AutostartInfo; applicationShortcut = Get-ApplicationShortcutInfo }
    }
    if ($method -eq 'POST' -and $path -eq '/api/startup') {
        $body = & $getBody
        $enabled = To-Bool $body.enabled $false
        $info = Set-Autostart $enabled
        return [ordered]@{ ok = $true; autostart = $info }
    }
    if ($method -eq 'POST' -and $path -eq '/api/passwordless') {
        $body = & $getBody
        $job = Start-PasswordlessJob $body
        return [ordered]@{ ok = $true; jobId = $job.id; job = (Get-PasswordlessJob $job.id) }
    }
    if ($method -eq 'GET' -and $path -eq '/api/passwordless') {
        $id = if ($query.ContainsKey('id')) { [string]$query['id'] } else { '' }
        return [ordered]@{ ok = $true; job = (Get-PasswordlessJob $id) }
    }
    if ($method -eq 'POST' -and $path -eq '/api/passwordless/command') {
        $body = & $getBody
        $hostName = if ($body -and $body.Contains('host')) { [string]$body.host } else { '' }
        $port = 22
        if ($body -and $body.Contains('port')) { [void][int]::TryParse([string]$body.port, [ref]$port) }
        $user = if ($body -and $body.Contains('user')) { [string]$body.user } else { [string](Get-Setting 'defaultUser' 'root') }
        $keyPath = if ($body -and $body.Contains('keyPath')) { [string]$body.keyPath } else { [string](Get-Setting 'defaultKeyPath' '~/.ssh/id_ed25519') }
        $alias = if ($body -and $body.Contains('alias')) { [string]$body.alias } else { '' }
        return [ordered]@{ ok = $true; command = Get-SshCommandBundle -HostName $hostName -Port $port -User $user -KeyPath $keyPath -Alias $alias }
    }

    if ($method -eq 'GET' -and $path -eq '/api/export') {
        $payload = [ordered]@{
            version  = 2
            exported = To-Iso (NowUtc)
            app      = $script:AppName
            versionApp = $script:AppVersion
            settings = $script:Config.settings
            servers  = @(Get-Servers)
            tunnels  = @(Get-Tunnels)
        }
        return [ordered]@{ __download = $true; data = $payload }
    }
    if ($method -eq 'POST' -and $path -eq '/api/import') {
        $body = & $getBody
        if ($null -eq $body -or $body -isnot [System.Collections.IDictionary]) { throw '导入数据格式不正确。' }
        $payload = if ($body.Contains('config')) { $body.config } else { $body }
        $info = Import-PanelConfig $payload
        return [ordered]@{ ok = $true; imported = $info }
    }
    if ($method -eq 'POST' -and $path -eq '/api/reset') {
        Reset-PanelConfig
        return [ordered]@{ ok = $true }
    }
    if ($method -eq 'POST' -and $path -eq '/api/open-folder') {
        $body = & $getBody
        $kind = if ($body -and $body.Contains('kind')) { [string]$body.kind } else { 'data' }
        Open-PanelFolder $kind
        return [ordered]@{ ok = $true }
    }
    if ($method -eq 'POST' -and $path -eq '/api/open-url') {
        $body = & $getBody
        Open-PanelUrl ([string]$body.url)
        return [ordered]@{ ok = $true }
    }
    if ($method -eq 'POST' -and $path -eq '/api/open-terminal') {
        $body = & $getBody
        $shellName = [string]$body.shell
        $arguments = @()
        switch ($shellName) {
            'powershell' {
                $terminalPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
                $arguments = @('-NoLogo', '-NoProfile', '-NoExit')
            }
            'cmd' { $terminalPath = Join-Path $env:WINDIR 'System32\cmd.exe' }
            default { throw '仅支持打开 PowerShell 或 CMD。' }
        }
        $startOptions = @{ FilePath = $terminalPath; WorkingDirectory = $script:RootDir; WindowStyle = 'Normal'; PassThru = $true }
        if ($arguments.Count -gt 0) { $startOptions.ArgumentList = $arguments }
        $terminalProcess = Start-Process @startOptions
        return [ordered]@{ ok = $true; shell = $shellName; pid = $terminalProcess.Id }
    }
    if ($method -eq 'POST' -and $path -eq '/api/shutdown') {
        Add-Log warn 'panel' '收到关闭面板请求。'
        Add-Activity -Kind 'warning' -Title '面板正在关闭' -Detail '后台 SSH 隧道不会被终止'
        $script:ShutdownRequested = $true
        return [ordered]@{ ok = $true; message = '面板正在关闭。后台隧道会继续运行。' }
    }

    throw '接口不存在。'
}

# ------------------------------------------------------------
#  Request handling
# ------------------------------------------------------------

function Test-Token($request) {
    if (-not $request.Headers.ContainsKey('x-panel-token')) { return $false }
    return ([string]$request.Headers['x-panel-token'] -ceq [string]$script:Token)
}

function Handle-Client($client, [byte[]]$requestBytes) {
    $request = $null
    try {
        $request = Read-HttpRequest $requestBytes
        if ($null -eq $request) { return }

        $hostHeader = if ($request.Headers.ContainsKey('host')) { [string]$request.Headers['host'] } else { '' }
        if ($hostHeader -and $hostHeader -notmatch '^(127\.0\.0\.1|localhost)(:\d+)?$') {
            Send-Error $client '仅允许通过 127.0.0.1 访问面板。' 403
            return
        }

        if ($request.Path -eq '/api/health') {
            Send-Json $client ([ordered]@{
                ok = $true; app = $script:AppName; version = $script:AppVersion; pid = $PID;
                port = [int]$listenPort; startedAt = (To-Iso $script:StartedAt);
                uptimeSec = [int]((NowUtc) - $script:StartedAt).TotalSeconds
            })
            return
        }

        if ($request.Path.StartsWith('/api/')) {
            if (-not (Test-Token $request)) {
                Send-Error $client '面板令牌无效，请刷新页面后重试。' 401
                return
            }
            $result = Invoke-ApiRoute $request
            if ($null -eq $result) {
                Send-Error $client '接口不存在。' 404
                return
            }
            if ($result -is [System.Collections.IDictionary] -and $result.Contains('__download')) {
                $json = ConvertTo-Json -InputObject $result['data'] -Depth 16
                $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
                Send-Bytes $client 200 'application/json; charset=utf-8' $bytes @{
                    'Content-Disposition' = 'attachment; filename="tunnel-studio-config.json"'
                }
                return
            }
            Send-Json $client $result
            return
        }

        if ($request.Method -ne 'GET' -and $request.Method -ne 'HEAD') {
            Send-Error $client '不支持的请求方法。' 405
            return
        }
        Send-Static $client $request.Path
    } catch {
        $message = $_.Exception.Message
        try { Add-Log error 'panel' "请求处理失败 [$($request.Method) $($request.Path)]：$message" } catch { }
        try { Send-Error $client $message 400 } catch { }
    }
}

# ------------------------------------------------------------
#  Main
# ------------------------------------------------------------

try {
    # Single-instance guard: never start a second panel against the same data.
    # This must run before Initialize-Core so a second instance can never
    # auto-open tunnels or touch state.
    if (Test-Path -LiteralPath $script:PidPath) {
        $existingInfo = $null
        try { $existingInfo = Read-JsonFile $script:PidPath } catch { }
        if ($existingInfo -and $existingInfo.pid -and [int]$existingInfo.pid -ne $PID) {
            $existingProcess = Get-Process -Id ([int]$existingInfo.pid) -ErrorAction SilentlyContinue
            if ($existingProcess) {
                $existingCommand = ''
                try {
                    $existingCim = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$existingInfo.pid)" -ErrorAction Stop
                    $existingCommand = [string]$existingCim.CommandLine
                } catch { }
                $expectedServerPath = [IO.Path]::GetFullPath((Join-Path $script:PanelDir 'Server.ps1'))
                $serverCommandPattern = '(?i)(?:^|\s|")' + [regex]::Escape($expectedServerPath) + '(?:"|\s|$)'
                if ($existingCommand -match $serverCommandPattern) {
                    Write-Host ''
                    Write-Host "  Tunnel Studio 已在运行（PID $($existingInfo.pid)，端口 $($existingInfo.port)）。" -ForegroundColor Yellow
                    Write-Host '  请直接打开面板地址，或先运行 Stop-Panel.cmd。' -ForegroundColor DarkGray
                    exit 3
                }
            }
            try { Remove-Item -LiteralPath $script:PidPath -Force } catch { }
        }
    }

    Initialize-Core

    $configuredPort = [int](Get-Setting 'panelPort' 9666)
    $listenPort = if ($Port -gt 0) { $Port } else { $configuredPort }
    if ($Port -gt 0 -and $Port -ne $configuredPort) {
        Set-Setting 'panelPort' $Port
        Save-Config
    }

    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $listenPort)
    try {
        $listener.Start()
    } catch {
        Write-Host ''
        Write-Host "  无法监听 127.0.0.1:$listenPort - $($_.Exception.Message)" -ForegroundColor Red
        Write-Host '  端口可能已被占用，请关闭占用程序或修改 Panel\config.json 中的 panelPort。' -ForegroundColor DarkGray
        exit 2
    }

    try {
        Write-JsonFile $script:PidPath ([ordered]@{
            pid = $PID; port = $listenPort; startedAt = (To-Iso $script:StartedAt); version = $script:AppVersion; path = $script:PanelDir
        }) -Compress
    } catch { }

    Write-Host ''
    Write-Host '  Tunnel Studio · SSH 隧道控制台' -ForegroundColor Cyan
    Write-Host "  http://127.0.0.1:$listenPort/" -ForegroundColor White
    Write-Host ('  ' + $(if (To-Bool (Get-Setting 'simulation' $true) $true) { '演示模式（不会启动真实 SSH 进程）' } else { '真实 SSH 模式' })) -ForegroundColor DarkGray
    Write-Host '  按 Ctrl+C 停止面板，后台隧道会继续运行。' -ForegroundColor DarkGray
    Write-Host ''

    $pendingClients = New-Object System.Collections.ArrayList
    $lastTick = [DateTime]::MinValue
    while (-not $script:ShutdownRequested) {
        try {
            if ($pendingClients.Count -eq 0) {
                [void]$listener.Server.Poll(160000, [System.Net.Sockets.SelectMode]::SelectRead)
            }
            Invoke-HttpListenerStep $listener $pendingClients {
                param($client, $bytes)
                Handle-Client $client $bytes
            } {
                param($client, $failure)
                Add-Log error 'panel' "请求接收失败：$($failure.Exception.Message)"
                try { Send-Error $client $failure.Exception.Message 400 } catch { }
            }
            if ($pendingClients.Count -gt 0) { Start-Sleep -Milliseconds 10 }
        } catch {
            Add-Log error 'panel' "网络循环异常：$($_.Exception.Message)"
            Start-Sleep -Milliseconds 200
        }

        if (((NowUtc) - $lastTick).TotalMilliseconds -ge 150) {
            try { Invoke-PanelTick } catch { Add-Log error 'panel' "状态循环异常：$($_.Exception.Message)" }
            try { Update-PasswordJobs } catch { Add-Log error 'panel' "免密任务异常：$($_.Exception.Message)" }
            $lastTick = NowUtc
        }
    }
} catch {
    Write-Host ''
    Write-Host "启动失败：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
    exit 1
} finally {
    foreach ($connection in @($pendingClients)) {
        if ($connection) { try { Close-HttpConnection $connection } catch { } }
    }
    try { if ($listener) { $listener.Stop() } } catch { }
    try {
        if (Test-Path -LiteralPath $script:PidPath) {
            $info = Read-JsonFile $script:PidPath
            if ($info -and [int]$info.pid -eq $PID) { Remove-Item -LiteralPath $script:PidPath -Force }
        }
    } catch { }
    try { Save-Config } catch { }
    try { Add-Log info 'panel' '面板服务已停止（后台隧道继续运行）。' } catch { }
}
