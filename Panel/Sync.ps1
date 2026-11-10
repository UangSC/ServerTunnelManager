#requires -Version 7.0
# Windows 面板与 macOS/Linux 共用同步格式、SSH 传输和预览校验。
function Invoke-SyncWorker([string]$action, $body = @{}) {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { throw '配置同步需要已有 Node.js 22 或更高版本，请检查 Node.js 路径。' }
    $worker = Join-Path $script:RootDir 'shared/sync.mjs'
    $payload = [ordered]@{ root = $script:RootDir; action = $action; body = $body; config = $script:Config; logs = @($script:LogBuffer.ToArray()) }
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $node.Source
    $start.ArgumentList.Add($worker)
    $start.ArgumentList.Add('--worker')
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = $script:Utf8NoBom
    $start.StandardErrorEncoding = $script:Utf8NoBom
    $start.StandardInputEncoding = $script:Utf8NoBom
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $start
    try {
        [void]$process.Start()
        $outputTask = $process.StandardOutput.ReadToEndAsync()
        $errorTask = $process.StandardError.ReadToEndAsync()
        $process.StandardInput.Write((ConvertTo-Json -InputObject $payload -Depth 30 -Compress))
        $process.StandardInput.Close()
        if (-not $process.WaitForExit(30000)) { $process.Kill(); throw '同步请求超时。' }
        $output = $outputTask.GetAwaiter().GetResult()
        $errorText = $errorTask.GetAwaiter().GetResult()
        if (-not $output) { throw ('同步组件未返回结果：' + $errorText) }
        $result = ConvertTo-Data (ConvertFrom-Json -InputObject $output)
        if (-not $result.ok) { throw $result.error }
        return $result
    } finally { $process.Dispose() }
}

function Apply-SyncPreview($body) {
    if ($body.confirm -isnot [bool] -or $body.confirm -ne $true) { throw '覆盖当前配置前需要确认。' }
    $merged = Invoke-SyncWorker 'prepare' $body
    $folder = Join-Path $script:PanelDir 'sync'
    $backup = Join-Path $folder ('backup-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N') + '.json')
    Write-JsonFile $backup ([ordered]@{config = $script:Config; logs = @($script:LogBuffer.ToArray())})
    $stopped = Stop-AllTunnels
    $previous = ConvertTo-Data (ConvertFrom-Json (ConvertTo-Json -InputObject $script:Config -Depth 30))
    try {
        $script:Config.servers = @($merged.servers)
        $script:Config.tunnels = @($merged.tunnels)
        Save-Config
    } catch { $script:Config = $previous; throw }
    $script:State = @{}
    $script:ProcessRecords = @{}
    Save-ProcessRecords
    Sync-RuntimeStates
    $null = Invoke-SyncWorker 'consume'
    if ($merged.includeLogs) {
        Write-JsonFile (Join-Path $folder 'imported-logs.json') @($merged.logs)
        foreach ($entry in $merged.logs) {
            $script:LogCounter++
            $entry['id'] = $script:LogCounter
            $entry['tunnelId'] = if ($entry.source -eq 'panel') { '' } else { $entry.source }
            Add-RingItem $script:LogBuffer $entry 2400
        }
    }
    Add-Activity -Kind 'success' -Title '服务器与面板列表已同步' -Detail "已停止 $stopped 条隧道；覆盖前备份：$backup"
    return [ordered]@{ok = $true; backup = $backup; servers = @($merged.servers).Count; tunnels = @($merged.tunnels).Count; includeLogs = $merged.includeLogs}
}

function Invoke-SyncRoute([string]$method, [string]$path, $body) {
    switch ($method + ' ' + $path) {
        'GET /api/sync/settings' { return Invoke-SyncWorker 'settings' }
        'POST /api/sync/settings' { return Invoke-SyncWorker 'save-settings' $body }
        'POST /api/sync/pull-preview' { return Invoke-SyncWorker 'pull' $body }
        'POST /api/sync/pull-apply' { return Apply-SyncPreview $body }
        'POST /api/sync/publish-preview' { return Invoke-SyncWorker 'publish-preview' $body }
        'POST /api/sync/publish-apply' { return Invoke-SyncWorker 'publish' $body }
        default { throw '同步接口或请求方法无效。' }
    }
}
