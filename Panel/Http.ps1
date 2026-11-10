#requires -Version 5.1
# Buffer each connection independently. Browser preconnects and partial requests
# must not block other requests or the tunnel maintenance loop.

function New-HttpConnection($client) {
    $client.NoDelay = $true
    $client.SendTimeout = 2000
    return @{
        Client = $client
        Buffer = New-Object System.IO.MemoryStream
        Started = [Diagnostics.Stopwatch]::StartNew()
        HeaderLength = -1
        ExpectedLength = -1
    }
}

function Close-HttpConnection($connection) {
    $connection.Client.Close()
    $connection.Buffer.Dispose()
    $connection.Started.Stop()
}

function Receive-HttpConnection($connection, [int]$timeoutMs = 15000) {
    if ($connection.Started.ElapsedMilliseconds -ge $timeoutMs) { return 'Closed' }
    $client = $connection.Client
    $available = $client.Available
    if ($available -eq 0) {
        if ($client.Client.Poll(0, [Net.Sockets.SelectMode]::SelectRead)) { return 'Closed' }
        return 'Pending'
    }

    # Read only bytes already available, with a per-iteration budget for fairness.
    $chunk = New-Object byte[] ([Math]::Min($available, 65536))
    $read = $client.GetStream().Read($chunk, 0, $chunk.Length)
    if ($read -le 0) { return 'Closed' }
    $previousLength = [int]$connection.Buffer.Length
    $connection.Buffer.Write($chunk, 0, $read)
    $buffer = $connection.Buffer.GetBuffer()
    $length = [int]$connection.Buffer.Length

    if ($connection.HeaderLength -lt 0) {
        # Include the previous three bytes so a split CRLFCRLF is recognized.
        for ($i = [Math]::Max(0, $previousLength - 3); $i -le $length - 4; $i++) {
            if ($buffer[$i] -eq 13 -and $buffer[$i + 1] -eq 10 -and
                $buffer[$i + 2] -eq 13 -and $buffer[$i + 3] -eq 10) {
                $connection.HeaderLength = $i + 4
                break
            }
        }
        if ($connection.HeaderLength -gt 65536 -or
            ($connection.HeaderLength -lt 0 -and $length -ge 65536)) {
            throw '请求头过大。'
        }
        if ($connection.HeaderLength -lt 0) { return 'Pending' }

        $header = [Text.Encoding]::ASCII.GetString($buffer, 0, $connection.HeaderLength - 4)
        $contentLength = 0
        $hasLength = $false
        foreach ($line in ($header -split "`r`n" | Select-Object -Skip 1)) {
            $colon = $line.IndexOf(':')
            if ($colon -le 0) { continue }
            $name = $line.Substring(0, $colon).Trim().ToLowerInvariant()
            $value = $line.Substring($colon + 1).Trim()
            if ($name -eq 'transfer-encoding') { throw '不支持此请求传输编码。' }
            if ($name -ne 'content-length') { continue }
            if ($hasLength -or $value -notmatch '^\d+$' -or
                -not [int]::TryParse($value, [ref]$contentLength)) {
                throw '请求长度无效。'
            }
            if ($contentLength -gt 2097152) { throw '请求内容过大。' }
            $hasLength = $true
        }
        $connection.ExpectedLength = $connection.HeaderLength + $contentLength
    }
    if ($length -ge $connection.ExpectedLength) { return 'Ready' }
    return 'Pending'
}

function Invoke-HttpListenerStep($listener, [System.Collections.IList]$connections,
    [scriptblock]$handleRequest, [scriptblock]$handleError, [int]$timeoutMs = 15000) {
    # Bound both accepted clients and retained buffers; do not drain an endless
    # accept queue before servicing existing connections.
    for ($accepted = 0; $accepted -lt 16 -and $listener.Pending(); $accepted++) {
        $client = $listener.AcceptTcpClient()
        if ($connections.Count -ge 64) { $client.Close(); continue }
        [void]$connections.Add((New-HttpConnection $client))
    }
    foreach ($connection in @($connections)) {
        $done = $false
        try {
            $state = Receive-HttpConnection $connection $timeoutMs
            if ($state -eq 'Pending') { continue }
            $done = $true
            if ($state -eq 'Ready') {
                & $handleRequest $connection.Client $connection.Buffer.ToArray() | Out-Null
            }
        } catch {
            $done = $true
            if ($handleError) { & $handleError $connection.Client $_ | Out-Null }
        } finally {
            if ($done) {
                Close-HttpConnection $connection
                [void]$connections.Remove($connection)
            }
        }
    }
}
