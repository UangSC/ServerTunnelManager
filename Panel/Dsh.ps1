#requires -Version 5.1
# Refresh a configured DSH tunnel's process-level login link on demand.
# Match the requested local URL to one configured tunnel; never assume a
# personal tunnel id, SSH host or account, and never persist the login token.
function Resolve-DshPanelUrl([string]$url) {
    $candidate = $null
    if (-not [uri]::TryCreate($url, [UriKind]::Absolute, [ref]$candidate)) { return $url }
    if ($candidate.Scheme -ne 'http' -or $candidate.Host -ne '127.0.0.1' -or $candidate.AbsolutePath -ne '/') { return $url }
    $matchesForUrl = @(Get-Tunnels | Where-Object {
        [int]$_.remotePort -eq 3080 -and [int]$_.localPort -eq $candidate.Port -and
        [string]$_.remoteHost -in @('', '127.0.0.1', 'localhost')
    })
    if ($matchesForUrl.Count -eq 0) { return $url }
    if ($matchesForUrl.Count -ne 1) { throw '多个 DSH 隧道匹配此地址，无法安全选择登录入口。' }
    $tunnel = $matchesForUrl[0]
    $server = Get-Server $tunnel.serverId
    if ($null -eq $server) { throw 'DSH 隧道缺少有效的服务器配置。' }
    if ([string]$server.host -notmatch '^[A-Za-z0-9.:\-]+$' -or
        [string]$server.user -notmatch '^[A-Za-z0-9._\-]+$' -or -not (Test-PortValue $server.port)) {
        throw 'DSH 服务器 SSH 连接配置无效。'
    }
    if (To-Bool (Get-Setting 'simulation' $false) $false) { throw '演示模式不能获取 DSH 登录链接。' }

    $key = Resolve-KeyPath $server.keyPath
    $arguments = @('-T', '-p', [string]$server.port, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=10')
    if ($key) { $arguments += @('-i', $key) }
    $arguments += @("$($server.user)@$($server.host)", "sudo -n journalctl -u deepseek-bot.service -g '^dsh web:' -n 1 --no-pager -o cat")
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = Get-SshPath
    # Windows PowerShell 5.1 也支持此路径；此处参数仅来自已校验的本机配置与固定命令。
    $info.Arguments = ($arguments | ForEach-Object { '"' + ([string]$_).Replace('"', '\"') + '"' }) -join ' '
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    try {
        [void]$process.Start()
        $outputTask = $process.StandardOutput.ReadToEndAsync()
        $errorTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(15000)) {
            $process.Kill()
            throw '读取 DSH 登录链接超时，请检查该服务器的 SSH 连接。'
        }
        $output = $outputTask.GetAwaiter().GetResult()
        [void]$errorTask.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw '无法读取 DSH 登录链接，请检查专用账号的 SSH 和 sudo 权限。' }
    } finally { $process.Dispose() }
    $found = [regex]::Matches($output, 'dsh web: (http://127\.0\.0\.1:3080/\?token=[A-Za-z0-9_-]+)')
    if ($found.Count -eq 0) { throw '未找到 DSH 当前登录链接，请检查 deepseek-bot 服务状态。' }
    $builder = [UriBuilder]::new($found[$found.Count - 1].Groups[1].Value)
    $builder.Port = [int]$tunnel.localPort
    $freshUrl = $builder.Uri.AbsoluteUri
    # 验证令牌确实属于当前进程；失败时不打开旧链接。
    Add-Type -AssemblyName System.Net.Http -ErrorAction Stop
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $handler.UseCookies = $false
    $client = [System.Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(5)
    try {
        $response = $client.GetAsync($freshUrl).GetAwaiter().GetResult()
        try {
            if ([int]$response.StatusCode -ne 303) { throw 'DSH 登录链接验证失败，请稍后重试。' }
        } finally { $response.Dispose() }
    } finally { $client.Dispose(); $handler.Dispose() }
    return $freshUrl
}
