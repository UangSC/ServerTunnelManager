#requires -Version 5.1
# Hermetic tests: temporary directories, fake WScript COM, mocked API traffic.
# Never start the server, read live config/key material, or create real links.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'Panel/Core.ps1')
. (Join-Path $root 'Panel/Shortcuts.ps1')
. (Join-Path $root 'Panel/ApiClient.ps1')
. (Join-Path $root 'Panel/Dsh.ps1')
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'Panel/Server.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
# Running this test under Windows PowerShell 5.1 also validates all production
# Windows entry points with the actual 5.1 parser, not only the mocked behavior.
foreach ($relative in @('Panel/Core.ps1', 'Panel/Server.ps1', 'Panel/Http.ps1', 'Panel/Shortcuts.ps1', 'Panel/ApiClient.ps1', 'Panel/Dsh.ps1', 'Panel/Extras.ps1', 'Panel/Ports.ps1', 'Panel/Sync.ps1', 'Start-Panel.ps1', 'Stop-Panel.ps1', 'ServerTunnelManager.ps1', 'bin/api.ps1', 'bin/shortcuts.ps1')) {
    $fileTokens = $null
    $fileErrors = $null
    [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $root $relative), [ref]$fileTokens, [ref]$fileErrors)
    if ($fileErrors.Count) { throw ($relative + ': ' + ($fileErrors | Out-String)) }
}
foreach ($name in @('Get-RequestBody', 'Merge-ResourceUpdateInput', 'Invoke-ApiRoute', 'Test-Token')) {
    $node = $ast.Find({ param($item) $item -is [Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq $name }, $true)
    if (-not $node) { throw ('缺少生产函数：' + $name) }
    . ([scriptblock]::Create($node.Extent.Text))
}
$script:passed = 0
function Assert-Windows([bool]$condition, [string]$message) {
    if (-not $condition) { throw ('断言失败：' + $message) }
    $script:passed++
}
function Assert-Rejected([scriptblock]$action, [string]$message) {
    $rejected = $false
    try { & $action | Out-Null } catch { $rejected = $true }
    Assert-Windows $rejected $message
}
$oldOS = $env:OS
$oldWinDir = $env:WINDIR
$temporary = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('tunnel-studio-windows-tests-' + [guid]::NewGuid().ToString('N'))))
$script:RootDir = Join-Path $temporary 'project with spaces'
$script:ConfigPath = Join-Path $temporary 'config.json'
$script:RuntimePath = Join-Path $temporary 'runtime.json'
$script:LogDir = Join-Path $temporary 'logs'
$script:fakeLinks = @{}
function Add-Log { param([string]$Level, [string]$Source, [string]$Text) }
function Save-Config { throw '此测试不允许持久化用户配置。' }
function Get-PanelShortcutLocations {
    return [ordered]@{ startMenu = (Join-Path $temporary 'programs/Tunnel Studio'); desktop = (Join-Path $temporary 'desktop') }
}
function New-PanelShortcutShell {
    $shell = New-Object PSObject
    $shell | Add-Member ScriptMethod CreateShortcut {
        param($path)
        if ($script:fakeLinks.ContainsKey($path)) { return $script:fakeLinks[$path] }
        $link = [pscustomobject]@{ Path = $path; TargetPath = ''; Arguments = ''; WorkingDirectory = ''; Description = ''; IconLocation = ''; WindowStyle = 0 }
        $link | Add-Member ScriptMethod Save { [IO.File]::WriteAllText($this.Path, 'fake shortcut'); $script:fakeLinks[$this.Path] = $this }
        return $link
    }
    return $shell
}
function Get-AutostartInfo { return [ordered]@{ supported = $true; enabled = $false } }
function Get-ServersSnapshot { return $script:Config.servers }
function Get-TunnelsSnapshot { return $script:Config.tunnels }
function Invoke-TestRoute([string]$method, [string]$path, [string]$body = '') {
    $bytes = [Text.Encoding]::UTF8.GetBytes($body)
    return Invoke-ApiRoute @{ Method = $method; Path = $path; Query = @{}; Headers = @{}; BodyBytes = $bytes }
}
try {
    New-Item -ItemType Directory -Path $script:RootDir -Force | Out-Null
    foreach ($action in @('Start', 'Stop')) { [IO.File]::WriteAllText((Join-Path $script:RootDir ($action + '-Panel.ps1')), '# test fixture only') }
    $env:OS = 'Windows_NT'
    $env:WINDIR = $temporary
    $default = New-DefaultConfig
    Assert-Windows ($default.servers.Count -eq 0 -and $default.tunnels.Count -eq 0) '新配置无服务器与隧道'
    Assert-Windows ($null -eq (Import-LegacyConfig)) '未明确迁移主机时不猜旧配置目标、不读旧配置'
    $initial = Get-ApplicationShortcutInfo
    Assert-Windows ($initial.supported -and -not $initial.enabled -and $initial.paths.Count -eq 4) '查询产生四个计划但不写快捷图标'
    $plan = @(Get-PanelShortcutSpecifications)
    Assert-Windows ($plan[0].arguments.Contains('"' + (Join-Path $script:RootDir 'Start-Panel.ps1') + '"')) '包含空格的脚本路径正确双引号引用'
    Assert-Windows ($plan[1].arguments.Contains('Stop-Panel.ps1') -and $plan[1].target.EndsWith('powershell.exe')) '停止图标调用 PowerShell 脚本、不需要 Node'
    $installed = Set-ApplicationShortcut $true
    Assert-Windows ($installed.enabled -and @($installed.paths | Where-Object { $_.enabled }).Count -eq 4) '安装当前用户的开始菜单/桌面启动停止图标'
    $installedAgain = Set-ApplicationShortcut $true
    Assert-Windows ($installedAgain.enabled -and $script:fakeLinks.Count -eq 4) '重复安装幂等'
    $removed = Set-ApplicationShortcut $false
    Assert-Windows (-not $removed.enabled -and @($plan | Where-Object { Test-Path -LiteralPath $_.path }).Count -eq 0) '移除只删除当前项目图标'
    [IO.File]::WriteAllText($plan[0].path, 'foreign shortcut')
    $script:fakeLinks[$plan[0].path].WorkingDirectory = (Join-Path $temporary 'another-project')
    Assert-Rejected { Set-ApplicationShortcut $true } '同名其他项目图标拒绝覆盖'
    Assert-Windows ([IO.File]::ReadAllText($plan[0].path) -eq 'foreign shortcut' -and -not (Test-Path -LiteralPath $plan[1].path)) '预检冲突时不部分安装'
    Set-ApplicationShortcut $false | Out-Null
    Assert-Windows (Test-Path -LiteralPath $plan[0].path) '移除保留其他项目同名图标'

    $script:Config = [ordered]@{
        settings = $default.settings
        servers = @([ordered]@{ id = 's-test'; name = 'fixture-server'; host = '192.0.2.15'; port = 2222; user = 'fixture'; keyPath = (Join-Path $temporary 'fixture-key'); note = 'original'; color = 'ocean'; passwordless = $false; createdAt = 'fixture-created' })
        tunnels = @([ordered]@{ id = 't-test'; serverId = 's-test'; name = 'fixture'; localHost = '127.0.0.1'; localPort = 28080; remoteHost = '127.0.0.1'; remotePort = 8080; probe = 'none'; openUrl = ''; group = 'original'; note = 'original'; autoOpen = $false; createdAt = 'fixture-created'; updatedAt = 'fixture-updated' })
    }
    Assert-Windows ((Invoke-TestRoute GET '/api/servers').servers.Count -eq 1) 'GET服务器列表'
    Assert-Windows ((Invoke-TestRoute GET '/api/servers/s-test').server.id -eq 's-test') 'GET单个服务器'
    Assert-Windows ((Invoke-TestRoute GET '/api/tunnels').tunnels.Count -eq 1) 'GET隧道列表'
    Assert-Windows ((Invoke-TestRoute GET '/api/tunnels/t-test').tunnel.id -eq 't-test') 'GET单个隧道'
    Assert-Rejected { Invoke-TestRoute GET '/api/servers/missing' } 'GET不存在服务器拒绝'
    Assert-Rejected { Invoke-TestRoute GET '/api/tunnels/missing' } 'GET不存在隧道拒绝'
    # Exercise the real Core validators/update functions with only persistence
    # mocked. These requests deliberately omit required connection fields.
    $script:saveCount = 0
    function Save-Config { $script:saveCount++ }
    $updatedServer = (Invoke-TestRoute PATCH '/api/servers/s-test' '{"note":"partial-note"}').server
    Assert-Windows ($updatedServer.note -eq 'partial-note' -and $updatedServer.host -eq '192.0.2.15' -and $updatedServer.port -eq 2222 -and $updatedServer.user -eq 'fixture' -and -not $updatedServer.passwordless) '服务器PATCH备注保留完整连接与认证字段'
    $putServer = (Invoke-TestRoute PUT '/api/servers/s-test' '{"name":"renamed-server"}').server
    Assert-Windows ($putServer.name -eq 'renamed-server' -and $putServer.note -eq 'partial-note' -and $putServer.id -eq 's-test' -and $putServer.createdAt -eq 'fixture-created') '服务器PUT局部更新保留ID与创建时间'
    $updatedTunnel = (Invoke-TestRoute PATCH '/api/tunnels/t-test' '{"group":"partial-group"}').tunnel
    Assert-Windows ($updatedTunnel.group -eq 'partial-group' -and $updatedTunnel.serverId -eq 's-test' -and $updatedTunnel.localPort -eq 28080 -and $updatedTunnel.remotePort -eq 8080 -and $updatedTunnel.probe -eq 'none' -and -not $updatedTunnel.autoOpen) '隧道PATCH分组保留服务器端口与自动开启偏好'
    $putTunnel = (Invoke-TestRoute PUT '/api/tunnels/t-test' '{"note":"partial-tunnel-note"}').tunnel
    Assert-Windows ($putTunnel.note -eq 'partial-tunnel-note' -and $putTunnel.group -eq 'partial-group' -and $putTunnel.id -eq 't-test') '隧道PUT局部更新保留其它字段'
    $created = (Invoke-TestRoute POST '/api/tunnels' '{"name":"added-fixture","serverId":"s-test","localPort":28081,"remotePort":8081,"probe":"none","autoOpen":false}').tunnel
    Assert-Windows ($created -is [System.Collections.IDictionary] -and [string]$created.id -match '^t-[a-f0-9]+$') '新增隧道API仅返回单个配置对象，不夹带运行状态'
    Invoke-TestRoute DELETE ('/api/tunnels/' + $created.id) | Out-Null
    Assert-Windows ($script:Config.tunnels.Count -eq 1) '新增隧道对象ID可直接用于后续API删除'
    $successfulSaves = $script:saveCount
    Assert-Rejected { Invoke-TestRoute PATCH '/api/servers/s-test' '{"host":""}' } '服务器PATCH显式无效地址仍由原校验拒绝'
    Assert-Rejected { Invoke-TestRoute PATCH '/api/tunnels/t-test' '{"localPort":0}' } '隧道PATCH显式无效端口仍由原校验拒绝'
    Assert-Rejected { Invoke-TestRoute PATCH '/api/servers/s-test' '[]' } 'PATCH不接受非对象JSON'
    Assert-Rejected { Invoke-TestRoute PUT '/api/tunnels/missing' '{"note":"ignored"}' } 'PUT不存在对象拒绝'
    Assert-Windows ($script:saveCount -eq $successfulSaves -and $script:Config.servers[0].host -eq '192.0.2.15' -and $script:Config.tunnels[0].localPort -eq 28080) '校验失败发生在持久化及修改原配置之前'
    $emptyBatch = Invoke-TestRoute POST '/api/batch' '{"action":"delete","ids":[]}'
    Assert-Windows ($emptyBatch.ok -and $emptyBatch.results.Count -eq 0 -and $script:Config.tunnels.Count -eq 1 -and $script:saveCount -eq $successfulSaves) '空ids批量删除是安全no-op且保留所有条目'
    Assert-Rejected { Invoke-TestRoute POST '/api/batch' '{"action":"delete"}' } '批量操作缺少ids拒绝而非回退全部'
    Assert-Rejected { Invoke-TestRoute POST '/api/batch' '{"action":"delete","ids":"t-test"}' } '批量操作字符串ids拒绝'
    Assert-Windows ($script:Config.tunnels.Count -eq 1) '无效批量选择不会修改配置'
    $demoOpened = Invoke-OpenTunnel 't-test'
    Assert-Windows ($demoOpened.status -eq 'connecting' -and $null -eq $demoOpened.pid) '演示开启不伪造真实SSH进程PID'
    $demoRestarted = Invoke-RestartTunnel 't-test'
    Assert-Windows ($demoRestarted.status -eq 'connecting' -and $null -eq $demoRestarted.pid) '演示重启不伪造真实SSH进程PID'
    Invoke-CloseTunnel 't-test' | Out-Null
    function Save-Config { throw '此测试不允许持久化用户配置。' }
    Assert-Windows ((Invoke-TestRoute GET '/api/settings').applicationShortcut.supported) 'GET设置包含系统快捷图标状态'
    Assert-Rejected { Invoke-TestRoute POST '/api/application-shortcut' '{"enabled":"false"}' } '快捷图标API不接受布尔字符串'
    Assert-Rejected { Invoke-TestRoute POST '/api/application-shortcut' '{}' } '快捷图标API拒绝缺少enabled'
    Assert-Windows ((Invoke-TestRoute GET '/api/application-shortcut').ok) '快捷图标GET路由'
    Assert-Windows (-not (Invoke-TestRoute POST '/api/application-shortcut' '{"enabled":false}').applicationShortcut.enabled) '快捷图标POST移除路由'
    Assert-Windows (Test-Path -LiteralPath $plan[0].path) 'API移除也保留其他项目快捷图标'
    Assert-Windows (-not $script:Config.settings.Contains('applicationShortcut')) '外部快捷图标状态不持久化至用户设置'
    $script:Config.servers[0]['user'] = 'deploy'
    $script:Config.servers[0]['port'] = 22
    $script:Config.tunnels = @([ordered]@{ id = 'dsh-generic-fixture'; serverId = 's-test'; remotePort = 3080; localPort = 19080; remoteHost = '127.0.0.1'; openUrl = 'http://127.0.0.1:19080/' })
    Assert-Windows ((Resolve-DshPanelUrl 'http://127.0.0.1:19081/') -eq 'http://127.0.0.1:19081/') 'DSH不猜测不匹配的本机端口'
    Assert-Rejected { Resolve-DshPanelUrl 'http://127.0.0.1:19080/' } 'DSH通用配置匹配但演示模式拒绝真实SSH'
    Assert-Windows ($script:Config.tunnels[0].openUrl -eq 'http://127.0.0.1:19080/') 'DSH刷新不改配置或持久化token'
    $legacyTokens = $null
    $legacyErrors = $null
    $legacyAst = [Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'ServerTunnelManager.ps1'), [ref]$legacyTokens, [ref]$legacyErrors)
    $legacyOpen = $legacyAst.Find({ param($item) $item -is [Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq 'Open-Tunnel' }, $true)
    . ([scriptblock]::Create($legacyOpen.Extent.Text))
    $destination = ''
    Assert-Rejected { Open-Tunnel $null } '旧CLI无显式目标时在状态/密钥读取和SSH启动前拒绝Open'

    $script:Token = 'AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPp'
    Assert-Windows (Test-Token @{ Headers = @{ 'x-panel-token' = $script:Token } }) 'API接受精确X-Panel-Token'
    Assert-Windows (-not (Test-Token @{ Headers = @{ 'x-panel-token' = $script:Token.ToLowerInvariant() } })) 'token值大小写敏感'
    Assert-Windows (-not (Test-Token @{ Headers = @{ authorization = ('Bearer ' + $script:Token) } })) 'Bearer不能替代现有认证头'
    $html = '<meta content="' + $script:Token + '" name="panel-token">'
    Assert-Windows ((Get-PanelApiToken $html) -ceq $script:Token) 'token初始化支持meta属性顺序变化'
    Assert-Rejected { Get-PanelApiToken '<meta name="panel-token" content="__PANEL_TOKEN__">' } '拒绝尚未注入的模板token'
    Assert-Rejected { Invoke-PanelApi $temporary 'https://example.invalid/api/state' } 'CLI拒绝外部URL'
    Assert-Rejected { Invoke-PanelApi $temporary '/api/../config.json' } 'CLI拒绝目录穿越'
    Assert-Rejected { Invoke-PanelHttpRequest ([uri]'http://example.invalid/') } 'HTTP辅助拒绝外部地址、不会发送token'

    # Exercise the complete client without network or live process lookup.
    $env:OS = 'TestOS'
    $script:traffic = New-Object System.Collections.ArrayList
    function Invoke-PanelHttpRequest([uri]$uri, [string]$method = 'GET', [string]$body = '', [string]$token = '') {
        [void]$script:traffic.Add(@{ path = $uri.AbsolutePath; token = $token; method = $method; body = $body })
        switch ($uri.AbsolutePath) {
            '/api/health' { return '{"app":"tunnel-studio","pid":123,"port":9666}' }
            '/' { return ('<meta name="panel-token" content="' + $script:Token + '">') }
            '/api/bootstrap' { return ('{"ok":true,"token":"' + $script:Token + '","settings":{}}') }
            default { throw 'unexpected mock request' }
        }
    }
    $output = Invoke-PanelApi $temporary '/api/bootstrap' GET '' 9666
    Assert-Windows ($script:traffic.Count -eq 3 -and -not $script:traffic[0].token -and -not $script:traffic[1].token -and $script:traffic[2].token -ceq $script:Token) '只在确认健康并读取首页后向API发送token'
    Assert-Windows (-not $output.Contains($script:Token)) 'CLI输出不泄露bootstrap令牌'
    if ($oldOS -eq 'Windows_NT') {
        # On Windows, also exercise real WScript COM, but only inside temporary
        # directories. No real Desktop/Start-menu links or processes are used.
        $env:OS = 'Windows_NT'
        $env:WINDIR = $oldWinDir
        $script:RootDir = Join-Path $temporary 'real COM project with spaces'
        New-Item -ItemType Directory -Path $script:RootDir -Force | Out-Null
        foreach ($action in @('Start', 'Stop')) { [IO.File]::WriteAllText((Join-Path $script:RootDir ($action + '-Panel.ps1')), '# do not execute this fixture') }
        function New-PanelShortcutShell { return New-Object -ComObject WScript.Shell }
        function Get-PanelShortcutLocations {
            return [ordered]@{ startMenu = (Join-Path $temporary 'com-programs/Tunnel Studio'); desktop = (Join-Path $temporary 'com-desktop') }
        }
        $realInfo = Set-ApplicationShortcut $true
        Assert-Windows ($realInfo.enabled -and $realInfo.paths.Count -eq 4) '真实WScript COM在临时目录创建四个图标'
        Assert-Windows ((Set-ApplicationShortcut $true).enabled) '真实COM安装幂等且正确识别带空格路径的归属'
        $realPaths = $realInfo.paths
        Assert-Windows (-not (Set-ApplicationShortcut $false).enabled) '真实COM移除快捷图标'
        Assert-Windows (@($realPaths | Where-Object { Test-Path -LiteralPath $_.path }).Count -eq 0) '真实COM移除后四个临时lnk均不存在'
    }
    Write-Output ('Windows 安全与快捷图标回归通过：' + $script:passed + ' 项。')
} finally {
    $env:OS = $oldOS
    $env:WINDIR = $oldWinDir
    # Verify the absolute target is the uniquely-created test directory before
    # removing it; never remove any user known-folder or project directory.
    $resolved = [IO.Path]::GetFullPath($temporary)
    $prefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if ($resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($resolved) -match '^tunnel-studio-windows-tests-[a-f0-9]{32}$' -and (Test-Path -LiteralPath $resolved)) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
