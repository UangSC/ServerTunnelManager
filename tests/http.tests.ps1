#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'Panel/Http.ps1')

# Load the production parser without starting the panel or touching its data.
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'Panel/Server.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$parser = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Read-HttpRequest' }, $true)
. ([scriptblock]::Create($parser.Extent.Text))

$script:passed = 0
$script:requests = New-Object System.Collections.ArrayList
$script:failures = New-Object System.Collections.ArrayList
$clients = New-Object System.Collections.ArrayList
$pending = New-Object System.Collections.ArrayList
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
function Assert-Http([bool]$condition, [string]$message) {
    if (-not $condition) { throw "断言失败：$message" }
    $script:passed++
    Write-Output "通过：$message"
}
function Connect-TestClient {
    $client = [Net.Sockets.TcpClient]::new()
    $client.Connect('127.0.0.1', $listener.LocalEndpoint.Port)
    [void]$clients.Add($client)
    return $client
}
function Send-TestBytes($client, [string]$text) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($text)
    $client.GetStream().Write($bytes, 0, $bytes.Length)
}
function Pump-TestServer([int]$timeoutMs = 15000) {
    Invoke-HttpListenerStep $listener $pending {
        param($client, $bytes)
        [void]$script:requests.Add((Read-HttpRequest $bytes))
        $reply = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 200 OK`r`nContent-Length: 2`r`nConnection: close`r`n`r`nOK")
        $client.GetStream().Write($reply, 0, $reply.Length)
    } {
        param($client, $failure)
        [void]$script:failures.Add($failure.Exception.Message)
    } $timeoutMs
}
function Wait-TestCondition([scriptblock]$condition) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while (-not (& $condition) -and $timer.ElapsedMilliseconds -lt 1500) {
        Pump-TestServer
        Start-Sleep -Milliseconds 5
    }
    if (-not (& $condition)) { throw '测试等待超时。' }
}

try {
    # Deterministically inject arrival between Available=0 and Poll readiness.
    # A readable socket is not EOF if bytes became available in the meantime.
    $script:racingBytes = [Text.Encoding]::ASCII.GetBytes("GET /race HTTP/1.1`r`nHost: localhost`r`n`r`n")
    $racingSocket = New-Object PSObject
    $racingSocket | Add-Member ScriptMethod Poll {
        param($timeout, $mode)
        $script:racingClient.Available = $script:racingBytes.Length
        return $true
    }
    $script:racingClient = [pscustomobject]@{
        Available = 0; NoDelay = $false; SendTimeout = 0; Client = $racingSocket
        Stream = [IO.MemoryStream]::new($script:racingBytes)
    }
    $script:racingClient | Add-Member ScriptMethod GetStream { return $this.Stream }
    $script:racingClient | Add-Member ScriptMethod Close { $this.Stream.Dispose() }
    $racingConnection = New-HttpConnection $script:racingClient
    try {
        Assert-Http ((Receive-HttpConnection $racingConnection) -eq 'Ready') 'Available与Poll之间到达的数据不会被误判为断开'
        Assert-Http ((Read-HttpRequest $racingConnection.Buffer.ToArray()).Path -eq '/race') '竞态到达的请求保留完整内容'
    } finally { Close-HttpConnection $racingConnection }
    $listener.Start()
    $idle = Connect-TestClient
    $partial = Connect-TestClient
    Send-TestBytes $partial "GET /partial HTTP/1.1`r`nHost: localhost`r"
    $active = Connect-TestClient
    Send-TestBytes $active "GET /api/health HTTP/1.1`r`nHost: localhost`r`n`r`n"
    $timer = [Diagnostics.Stopwatch]::StartNew()
    Wait-TestCondition { $active.Available -gt 0 }
    $reply = New-Object byte[] $active.Available
    [void]$active.GetStream().Read($reply, 0, $reply.Length)
    Assert-Http ([Text.Encoding]::ASCII.GetString($reply).StartsWith('HTTP/1.1 200 OK') -and $timer.ElapsedMilliseconds -lt 1500) '空闲连接和半截请求头不会阻塞正常 HTTP 响应'
    Assert-Http ($requests.Count -eq 1 -and $requests[0].Path -eq '/api/health') '只处理完整请求'

    Send-TestBytes $partial "`n`r`n"
    Wait-TestCondition { $requests.Count -eq 2 }
    Assert-Http ($requests[1].Path -eq '/partial') '跨数据包的请求头结束标记正常解析'

    $bodyClient = Connect-TestClient
    $body = '{"name":"中文测试"}'
    $bodySize = [Text.Encoding]::UTF8.GetByteCount($body)
    Send-TestBytes $bodyClient "POST /api/example?q=a%20b HTTP/1.1`r`nHost: localhost`r`nContent-Length: $bodySize`r`n`r`n{"
    Pump-TestServer
    Assert-Http ($requests.Count -eq 2) '请求体尚未收齐时不提交'
    $parallel = Connect-TestClient
    Send-TestBytes $parallel "GET /assets/app.js HTTP/1.1`r`nHost: localhost`r`n`r`n"
    Wait-TestCondition { $requests.Count -eq 3 }
    Assert-Http ($requests[2].Path -eq '/assets/app.js') '半截请求体不会阻塞页面资源'
    Send-TestBytes $bodyClient $body.Substring(1)
    Wait-TestCondition { $requests.Count -eq 4 }
    Assert-Http ([Text.Encoding]::UTF8.GetString($requests[3].BodyBytes) -ceq $body) '分段 UTF-8 请求体完整保留'
    Assert-Http ($requests[3].Query.q -eq 'a b') '查询参数解析保持兼容'

    $truncated = Connect-TestClient
    Send-TestBytes $truncated "POST /incomplete HTTP/1.1`r`nContent-Length: 10`r`n`r`nabc"
    Pump-TestServer
    $truncated.Close()
    Pump-TestServer
    Assert-Http ($requests.Count -eq 4) '中途断开的请求体不会作为完整请求执行'

    foreach ($header in @('Content-Length: -1', 'Content-Length: invalid', 'Content-Length: 2097153', "Content-Length: 1`r`nContent-Length: 2", 'Transfer-Encoding: chunked')) {
        $before = $failures.Count
        $bad = Connect-TestClient
        Send-TestBytes $bad "POST /bad HTTP/1.1`r`n${header}`r`n`r`n"
        Wait-TestCondition { $failures.Count -gt $before }
    }
    Assert-Http ($failures.Count -eq 5 -and $requests.Count -eq 4) '拒绝无效、超限或有歧义的请求长度'
    $largeHeader = Connect-TestClient
    Send-TestBytes $largeHeader ('GET / HTTP/1.1' + "`r`nX-Large: " + ('x' * 65536))
    Wait-TestCondition { $failures.Count -eq 6 }
    Assert-Http ($requests.Count -eq 4) '超大请求头被限制且不影响其他连接'

    Pump-TestServer 0
    Assert-Http ($pending.Count -eq 0) '过期空闲连接释放缓冲和套接字'
    $last = Connect-TestClient
    Send-TestBytes $last "GET /final HTTP/1.1`r`nHost: localhost`r`n`r`n"
    Wait-TestCondition { $requests.Count -eq 5 }
    Assert-Http ($requests[4].Path -eq '/final') '异常连接清理后继续接受正常请求'
    Write-Output "HTTP 回归测试通过：$script:passed 项。"
} finally {
    foreach ($connection in @($pending)) { Close-HttpConnection $connection }
    foreach ($client in $clients) { $client.Dispose() }
    $listener.Stop()
}
