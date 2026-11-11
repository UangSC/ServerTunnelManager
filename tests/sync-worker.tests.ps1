#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$OutputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = $OutputEncoding
$sourceRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $sourceRoot 'Panel/Core.ps1')
. (Join-Path $sourceRoot 'Panel/Sync.ps1')
$testRoot = Join-Path $PSScriptRoot ('run-worker-' + [guid]::NewGuid().ToString('N'))
try {
New-Item -ItemType Directory -Path (Join-Path $testRoot 'shared'),(Join-Path $testRoot 'Panel') -Force | Out-Null
Copy-Item (Join-Path $sourceRoot 'shared/sync.mjs') (Join-Path $testRoot 'shared/sync.mjs')
$script:RootDir = $testRoot
$script:PanelDir = Join-Path $testRoot 'Panel'
$script:ConfigPath = Join-Path $script:PanelDir 'config.json'
$script:RuntimePath = Join-Path $script:PanelDir 'runtime.json'
$script:LogDir = Join-Path $script:PanelDir 'logs'
$script:Config = New-DefaultConfig
$script:Config.settings.theme = 'light'
$script:Config.servers = @([ordered]@{id='srv-1';name='测试服务器';host='example.com';port=22;user='deploy';keyPath='local-key';passwordless=$true})
$script:Config.tunnels = @([ordered]@{id='t-1';name='测试面板';serverId='srv-1';localHost='127.0.0.1';localPort=29090;remoteHost='127.0.0.1';remotePort=9090;probe='auto';openUrl='http://127.0.0.1:29090/';autoOpen=$true;kind='dedicated';proxyAccount='测试账号';ispId='ISP-01';proxyExitIp='203.0.113.10';proxyRoute='vpn'})
function Stop-AllTunnels { return 0 }
function Assert-Sync($condition,$message) { if (-not $condition) { throw $message }; Write-Output "通过：$message" }
$settings = Invoke-SyncWorker 'settings'
Assert-Sync ($settings.settings.user -eq 'deploy') 'Windows worker 读取默认同步账号'
Save-Config
$stage = @'
import fs from 'node:fs';
import {SyncStore,makeBundle} from './shared/sync.mjs';
const config=JSON.parse(fs.readFileSync('./Panel/config.json','utf8').replace(/^\uFEFF/,''));
const bundle=makeBundle(config,[],false);bundle.servers[0].name='同步后的名称';bundle.tunnels[0].localPort=19090;
const store=new SyncStore(process.cwd(),{directory:'Panel/sync',restricted:false,transport:async()=>({bundle,revision:'v1'})});
console.log(JSON.stringify(await store.pull(config,false)));
'@
Push-Location $testRoot
try {
    $preview = ConvertFrom-Json ($stage | node --input-type=module)
    if ($LASTEXITCODE -ne 0) { throw '预览夹具生成失败' }
} finally { Pop-Location }
$rejected = $false
try { Apply-SyncPreview @{token=$preview.token} } catch { $rejected = $true }
Assert-Sync $rejected 'Windows 拒绝未确认的覆盖'
$result = Apply-SyncPreview @{token=$preview.token;confirm=$true}
Assert-Sync ($result.ok -and (Test-Path $result.backup)) 'Windows 确认覆盖并创建原配置备份'
Assert-Sync ($script:Config.servers[0].name -eq '同步后的名称') 'Windows 接收中文服务器名称'
Assert-Sync ($script:Config.servers[0].keyPath -eq 'local-key') 'Windows 保留本机密钥'
Assert-Sync ($script:Config.tunnels[0].localPort -eq 29090 -and $script:Config.tunnels[0].autoOpen) 'Windows 保留本机端口和启动偏好'
Assert-Sync ($script:Config.settings.theme -eq 'light') 'Windows 保留本机主题'
$rejected = $false
try { Apply-SyncPreview @{token=$preview.token;confirm=$true} } catch { $rejected = $true }
Assert-Sync $rejected 'Windows 已使用预览不能重复覆盖'

Assert-Sync ($script:Config.tunnels[0].kind -eq 'dedicated' -and $script:Config.tunnels[0].proxyAccount -eq '测试账号' -and $script:Config.tunnels[0].proxyExitIp -eq '203.0.113.10' -and $script:Config.tunnels[0].proxyRoute -eq 'vpn') 'Windows worker 保留专用隧道和中文账号'
} finally {
    $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
    $resolvedTestsDirectory = [IO.Path]::GetFullPath($PSScriptRoot) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedTestRoot.StartsWith($resolvedTestsDirectory, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $resolvedTestRoot) -notmatch '^run-worker-[0-9a-f]{32}$') {
        throw '测试清理路径超出允许范围。'
    }
    if (Test-Path -LiteralPath $resolvedTestRoot) { Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force }
}
