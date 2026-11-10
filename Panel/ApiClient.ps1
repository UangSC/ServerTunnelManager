#requires -Version 5.1
# Loopback-only API client primitives shared by the Windows no-Node CLI.
# Tokens are obtained from the running panel HTML and remain in memory only.

function Get-PanelApiToken([string]$html) {
    foreach ($meta in [regex]::Matches($html, '(?is)<meta\b[^>]*>')) {
        if ($meta.Value -notmatch '(?i)\bname\s*=\s*["'']panel-token["'']') { continue }
        $match = [regex]::Match($meta.Value, '(?i)\bcontent\s*=\s*["'']([A-Za-z0-9_-]{32})["'']')
        if ($match.Success) { return $match.Groups[1].Value }
    }
    throw '首页缺少有效的 panel-token；请确认面板已启动。'
}

function Invoke-PanelHttpRequest([uri]$uri, [string]$method = 'GET', [string]$body = '', [string]$token = '') {
    if ($uri.Scheme -ne 'http' -or $uri.Host -ne '127.0.0.1' -or $uri.UserInfo -or $uri.Fragment) {
        throw 'API 客户端仅允许 HTTP 127.0.0.1 地址。'
    }
    $request = [Net.HttpWebRequest]::Create($uri)
    $request.Method = $method
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.KeepAlive = $false
    $request.Timeout = 15000
    $request.ReadWriteTimeout = 15000
    if ($token) { $request.Headers.Add('X-Panel-Token', $token) }
    if ($body) {
        $bytes = [Text.Encoding]::UTF8.GetBytes($body)
        $request.ContentType = 'application/json; charset=utf-8'
        $request.ContentLength = $bytes.Length
        $stream = $request.GetRequestStream()
        try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
    }
    $response = $null
    try {
        try { $response = $request.GetResponse() }
        catch [Net.WebException] {
            if (-not $_.Exception.Response) { throw '无法连接当前面板，请先启动面板或确认端口。' }
            $response = $_.Exception.Response
        }
        $reader = [IO.StreamReader]::new($response.GetResponseStream(), [Text.Encoding]::UTF8)
        try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
        $status = [int]$response.StatusCode
        if ($status -lt 200 -or $status -ge 300) {
            $message = 'HTTP ' + $status
            try { $errorData = ConvertFrom-Json -InputObject $text; if ($errorData.error) { $message += ': ' + [string]$errorData.error } } catch { }
            throw $message
        }
        return $text
    } finally { if ($response) { $response.Dispose() } }
}

function Get-PanelApiPort([string]$root, [int]$port = 0) {
    if ($port -gt 0) { return $port }
    # Prefer the running listener's recorded port over a setting that may have
    # changed without restarting the panel. Read no other configuration fields.
    foreach ($name in @('panel.pid.json', 'config.json')) {
        $path = Join-Path (Join-Path $root 'Panel') $name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        try {
            $value = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($path, [Text.Encoding]::UTF8))
            $candidate = if ($name -eq 'panel.pid.json') { $value.port } else { $value.settings.panelPort }
            $parsed = 0
            if ([int]::TryParse([string]$candidate, [ref]$parsed) -and $parsed -ge 1024 -and $parsed -le 65535) { return $parsed }
        } catch { }
    }
    return 9666
}

function Invoke-PanelApi([string]$root, [string]$path, [string]$method = 'GET', [string]$body = '', [int]$port = 0) {
    if ($path -notmatch '^/api/[A-Za-z0-9/._?%&=+~\-]*$' -or $path.Contains('..')) {
        throw 'Path 必须是 /api/ 开头的本地 API 路径，不接受 URL、控制字符或目录穿越。'
    }
    if ($method -notin @('GET', 'POST', 'PATCH', 'PUT', 'DELETE')) { throw '不支持的 HTTP 方法。' }
    if ($body) { try { ConvertFrom-Json -InputObject $body | Out-Null } catch { throw 'Body 必须为合法 JSON。' } }
    $listenPort = Get-PanelApiPort $root $port
    if ($listenPort -lt 1024 -or $listenPort -gt 65535) { throw '面板端口必须为 1024-65535。' }
    $base = 'http://127.0.0.1:' + $listenPort
    $health = ConvertFrom-Json -InputObject (Invoke-PanelHttpRequest ([uri]($base + '/api/health')))
    if ($health.app -ne 'tunnel-studio' -or -not $health.pid -or [int]$health.port -ne $listenPort) {
        throw '目标不是预期的 Tunnel Studio 面板。'
    }
    # Do not use another checkout's listener or send its token to an unrelated
    # local service merely because it claims the same app name.
    if ($env:OS -eq 'Windows_NT') {
        $process = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$health.pid) -ErrorAction Stop
        $server = [IO.Path]::GetFullPath((Join-Path (Join-Path $root 'Panel') 'Server.ps1'))
        $pattern = '(?i)(?:^|\s|")' + [regex]::Escape($server) + '(?:"|\s|$)'
        if (-not $process -or [string]$process.CommandLine -notmatch $pattern) { throw '监听进程不属于当前项目。' }
    }
    $token = Get-PanelApiToken (Invoke-PanelHttpRequest ([uri]($base + '/')))
    try {
        $text = Invoke-PanelHttpRequest ([uri]($base + $path)) $method $body $token
        # bootstrap is the sole existing response containing the browser token;
        # redact it from command output rather than printing an auth secret.
        $result = ConvertFrom-Json -InputObject $text
        if ($null -ne $result.PSObject.Properties['token']) { $result.PSObject.Properties.Remove('token') }
        return ConvertTo-Json -InputObject $result -Depth 32 -Compress
    } finally { $token = $null }
}
