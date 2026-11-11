#requires -Version 7.0
# 全部浏览器文件位于临时目录，绝不启动或写入真实 Edge。
$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $sourceRoot 'Panel/Core.ps1')
. (Join-Path $sourceRoot 'Panel/Edge.ps1')
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('tunnel-edge-tests-' + [guid]::NewGuid().ToString('N'))
$script:PanelDir = Join-Path $temporary 'Panel'
$script:Config = @{ settings=@{simulation=$true}; tunnels=@(
    @{id='t-one';name='出口一';kind='dedicated';localHost='127.0.0.1';localPort=18001;proxyExitIp='203.0.113.1'},
    @{id='t-two';name='出口二';kind='dedicated';localHost='127.0.0.1';localPort=18002;proxyExitIp='203.0.113.2'}
) }
$script:passed = 0
function Assert-EdgeTest($value, $message) {
    if (-not $value) { throw "断言失败：$message" }
    $script:passed++
}
function Assert-EdgeRejected([scriptblock]$action, $pattern) {
    $caught = $false
    try { & $action | Out-Null } catch { if ($_.Exception.Message -notmatch $pattern) { throw }; $caught = $true }
    Assert-EdgeTest $caught "应拒绝：$pattern"
}
try {
    Ensure-Directory $script:PanelDir
    $dataRoot = Get-EdgeUserDataPath
    Assert-EdgeTest ($dataRoot.StartsWith($temporary)) '演示目录隔离'
    $statePath = Join-Path $dataRoot 'Local State'
    Write-EdgeJson $statePath @{profile=@{info_cache=@{'Profile 9'=@{name='已有出口'};'Profile 10'=@{name='外部代理'}}}; untouched=@{value='保留'}}
    Write-EdgeJson (Get-EdgePreferencesPath 'Profile 9') @{proxy=@{mode='fixed_servers';server='http://127.0.0.1:18001'}; profile=@{name='已有出口'}; keep=@{cookies='fixture'}}
    Write-EdgeJson (Get-EdgePreferencesPath 'Profile 10') @{proxy=@{mode='fixed_servers';server='http://192.0.2.1:18002'}}
    $records = @(Get-EdgeProfiles)
    Assert-EdgeTest ($records.Count -eq 1 -and $records[0].profileDirectory -eq 'Profile 9') '首次接管只匹配本机代理'
    $id = $records[0].id
    Assert-EdgeTest (@(Import-EdgeProfiles).Count -eq 1) '重复扫描不重复导入'
    $prefsPath = Get-EdgePreferencesPath 'Profile 9'
    $before = [IO.File]::ReadAllText($prefsPath)
    function Test-EdgeRunning { return $true }
    Update-EdgeProfile $id @{name='修改后'} | Out-Null
    Assert-EdgeTest ((Get-EdgeProfile $id).name -eq '修改后') '运行中修改可持久保存'
    Assert-EdgeRejected { Apply-EdgeProfile $id } '关闭所有 Edge'
    Assert-EdgeTest ([IO.File]::ReadAllText($prefsPath) -ceq $before) '运行中应用不写浏览器'
    function Test-EdgeRunning { return $false }
    $deep = @{leaf='深层数据'}
    for ($i=0;$i -lt 24;$i++) { $deep = @{nested=$deep} }
    $prefs = Read-EdgeJson $prefsPath
    $prefs.deep = $deep
    Write-EdgeJson $prefsPath $prefs
    Apply-EdgeProfile $id | Out-Null
    $applied = Read-EdgeJson $prefsPath
    $leaf = $applied.deep
    for ($i=0;$i -lt 24;$i++) { $leaf = $leaf.nested }
    Assert-EdgeTest ($leaf.leaf -eq '深层数据' -and $applied.keep.cookies -eq 'fixture') '应用保留深层和无关配置'
    Assert-EdgeTest ($applied.profile.name -eq '修改后' -and $applied.proxy.server -eq 'http://127.0.0.1:18001') '名称和代理写入Preferences'
    Assert-EdgeTest ((Read-EdgeJson $statePath).profile.info_cache['Profile 9'].name -eq '修改后') 'Local State名称同步'
    Assert-EdgeTest (-not (@(Get-EdgeProfiles)[0]).pending) '应用状态与真实文件一致'
    Assert-EdgeTest (@(Get-ChildItem (Join-Path $script:PanelDir 'backups') -Recurse -Filter Preferences).Count -eq 1) '保存原文件备份'
    $script:Config.tunnels[0].localPort=18101
    function Test-EdgeRunning { return $true }
    Sync-EdgeProfilesForTunnel $script:Config.tunnels[0]
    Assert-EdgeTest ((@(Get-EdgeProfiles)[0]).pending) '运行中端口变化保留待应用状态'
    function Test-EdgeRunning { return $false }
    Sync-EdgeProfilesForTunnel $script:Config.tunnels[0]
    Assert-EdgeTest ((Read-EdgeJson $prefsPath).proxy.server -eq 'http://127.0.0.1:18101') '关闭后端口自动同步'
    $before = [IO.File]::ReadAllText($prefsPath)
    Update-EdgeProfile $id @{enabled=$false} | Out-Null
    Assert-EdgeRejected { Apply-EdgeProfile $id } '已停用'
    Assert-EdgeTest ([IO.File]::ReadAllText($prefsPath) -ceq $before) '停用保留原代理'
    Update-EdgeProfile $id @{enabled=$true;tunnelId=''} | Out-Null
    Assert-EdgeRejected { Apply-EdgeProfile $id } '未绑定'
    Remove-EdgeProfile $id | Out-Null
    Assert-EdgeTest (@(Get-EdgeProfiles).Count -eq 0) '删除后不会在刷新时重新接管'
    Assert-EdgeTest ([IO.File]::ReadAllText($prefsPath) -ceq $before) '移除记录不删浏览器数据'
    Ensure-Directory (Join-Path $dataRoot 'Profile 1')
    $created = Add-EdgeProfile @{tunnelId='t-two'}
    Assert-EdgeTest ($created.name -eq '203.0.113.2' -and $created.profileDirectory -eq 'Profile 2') '默认出口名称且跳过未注册磁盘目录'
    Assert-EdgeRejected { Add-EdgeProfile @{tunnelId='t-two'} } '已经绑定'
    Assert-EdgeRejected { Update-EdgeProfile $created.id @{enabled='false'} } '布尔值'
    Assert-EdgeRejected { Update-EdgeProfile $created.id @{profileDirectory='../foreign'} } '不支持'
    Assert-EdgeRejected { Get-EdgePreferencesPath '../foreign' } '目录无效'
    Assert-EdgeRejected { Open-EdgeProfile $created.id } '演示模式'
    Apply-EdgeProfile $created.id | Out-Null
    Assert-EdgeTest (-not (@(Get-EdgeProfiles)[0]).pending) '新Profile成功创建并应用'
    $newPrefs = Get-EdgePreferencesPath $created.profileDirectory
    $oldPrefs = [IO.File]::ReadAllText($newPrefs)
    $oldState = [IO.File]::ReadAllText($statePath)
    Update-EdgeProfile $created.id @{name='失败应回滚'} | Out-Null
    $originalWriter = ${function:Write-EdgeJson}
    $script:failWrites = 0
    function Write-EdgeJson($path,$value) {
        $script:failWrites++
        if ($script:failWrites -eq 2) { throw '模拟第二个文件写入失败' }
        & $originalWriter $path $value
    }
    Assert-EdgeRejected { Apply-EdgeProfile $created.id } '模拟第二个文件'
    ${function:Write-EdgeJson} = $originalWriter
    Assert-EdgeTest ([IO.File]::ReadAllText($newPrefs) -ceq $oldPrefs -and [IO.File]::ReadAllText($statePath) -ceq $oldState) '多文件写入失败恢复原文件'
    Write-Host "Edge 隔离测试通过：$script:passed 项。"
} finally {
    $resolved = [IO.Path]::GetFullPath($temporary)
    $prefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
    if ($resolved.StartsWith($prefix) -and [IO.Path]::GetFileName($resolved) -match '^tunnel-edge-tests-[a-f0-9]{32}$') { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
