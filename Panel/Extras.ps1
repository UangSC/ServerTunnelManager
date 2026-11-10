#requires -Version 5.1
# ============================================================
#  Tunnel Studio - extras
#  Autostart, passwordless onboarding, server probing,
#  copy-ready PowerShell command generation.
# ============================================================

# ------------------------------------------------------------
#  Startup (HKCU Run)
# ------------------------------------------------------------

function Get-AutostartInfo {
    $supported = ($env:OS -eq 'Windows_NT')
    $expected = ''
    if ($supported) {
        $vbs = Join-Path $script:RootDir 'start-hidden.vbs'
        $expected = 'wscript.exe //B "' + $vbs + '"'
    }
    $command = $null
    if ($supported) {
        try {
            $value = (Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'ServerTunnelPanel' -ErrorAction Stop).ServerTunnelPanel
            if ($value) { $command = [string]$value }
        } catch { }
    }
    $enabled = [bool]$command
    if ($enabled -and $expected -and $command -ne $expected) {
        # Any existing value counts as enabled; the UI reports the exact command.
    }
    return [ordered]@{
        supported = $supported
        enabled   = $enabled
        command   = $command
        expected  = $expected
        script    = (Join-Path $script:RootDir 'Start-Panel.ps1')
        hint      = if ($supported) { '登录 Windows 后在后台启动面板，不弹出浏览器。' } else { '仅支持 Windows。' }
    }
}

function Set-Autostart([bool]$enabled) {
    if ($env:OS -ne 'Windows_NT') { throw '当前系统不支持开机自启。' }
    $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    if (-not (Test-Path -LiteralPath $runKey)) { New-Item -Path $runKey -Force | Out-Null }
    $info = Get-AutostartInfo
    if ($enabled) {
        $vbs = Join-Path $script:RootDir 'start-hidden.vbs'
        if (-not (Test-Path -LiteralPath $vbs)) { throw "找不到启动脚本：$vbs" }
        New-ItemProperty -Path $runKey -Name 'ServerTunnelPanel' -Value $info.expected -PropertyType String -Force | Out-Null
        Add-Log info 'panel' "已启用开机自启：$($info.expected)"
        Add-Activity -Kind 'success' -Title '已启用开机自启' -Detail '下次登录 Windows 时自动在后台启动面板'
    } else {
        Remove-ItemProperty -Path $runKey -Name 'ServerTunnelPanel' -ErrorAction SilentlyContinue
        Add-Log info 'panel' '已关闭开机自启'
        Add-Activity -Kind 'info' -Title '已关闭开机自启' -Detail '登录 Windows 时不再自动启动面板'
    }
    return Get-AutostartInfo
}

# ------------------------------------------------------------
#  Command generation
# ------------------------------------------------------------

function ConvertTo-KeyExpression([string]$keyPath) {
    if ([string]::IsNullOrWhiteSpace($keyPath)) { $keyPath = '~/.ssh/id_ed25519' }
    if ($keyPath.StartsWith('~')) {
        $rest = $keyPath.Substring(1).TrimStart('\', '/')
        $rest = $rest -replace '/', '\'
        if ($rest) { return '"$env:USERPROFILE\' + $rest + '"' }
        return '"$env:USERPROFILE"'
    }
    return "'" + ($keyPath -replace "'", "''") + "'"
}

function Get-SafeAlias([string]$hostName) {
    $alias = 'ts-' + ($hostName -replace '[^A-Za-z0-9\.\-]', '-')
    $alias = $alias -replace '\.', '-'
    $alias = $alias.Trim('-')
    if ($alias.Length -gt 40) { $alias = $alias.Substring(0, 40) }
    if ([string]::IsNullOrWhiteSpace($alias) -or $alias -eq 'ts-') { $alias = 'tunnelstudio' }
    return $alias
}

function Get-SshCommandBundle {
    param(
        [string]$HostName = '',
        [int]$Port = 22,
        [string]$User = 'root',
        [string]$KeyPath = '~/.ssh/id_ed25519',
        [string]$Alias = ''
    )
    if ([string]::IsNullOrWhiteSpace($HostName)) {
        $servers = @(Get-Servers)
        if ($servers.Count -gt 0) {
            $HostName = [string]$servers[0].host
            $Port = [int]$servers[0].port
            $User = [string]$servers[0].user
            if ($servers[0].keyPath) { $KeyPath = [string]$servers[0].keyPath }
        } else {
            $HostName = 'YOUR_SERVER_IP'
        }
    }
    if ($Port -lt 1 -or $Port -gt 65535) { $Port = 22 }
    $HostName = ([string]$HostName) -replace '[^A-Za-z0-9._\-]', ''
    if ([string]::IsNullOrWhiteSpace($HostName)) { $HostName = 'YOUR_SERVER_IP' }
    $User = ([string]$User) -replace '[^A-Za-z0-9._\-]', ''
    if ([string]::IsNullOrWhiteSpace($User)) { $User = 'root' }
    if ([string]::IsNullOrWhiteSpace($KeyPath)) { $KeyPath = '~/.ssh/id_ed25519' }
    $Alias = ([string]$Alias) -replace '[^A-Za-z0-9._\-]', '-'
    $Alias = ($Alias -replace '-{2,}', '-').Trim('-')
    if ([string]::IsNullOrWhiteSpace($Alias)) { $Alias = Get-SafeAlias $HostName }
    $keyExpr = ConvertTo-KeyExpression $KeyPath
    $keyDisplay = $KeyPath -replace '\\', '/'
    $keyLeaf = Split-Path -Leaf $KeyPath
    if ([string]::IsNullOrWhiteSpace($keyLeaf)) { $keyLeaf = 'id_ed25519' }

    $onePass = @'
# Tunnel Studio · Windows 一键免密登录
# 目标：__USER__@__HOST__:__PORT__
$ErrorActionPreference = 'Stop'
$key = __KEYEXPR__
if (-not (Test-Path "$key.pub")) {
    # 提示设置口令时直接按 Enter 两次，表示空口令（免密）
    ssh-keygen -t ed25519 -C "$env:COMPUTERNAME-tunnelstudio" -f $key
}
$pub = (Get-Content -Raw "$key.pub").Trim()
if ([string]::IsNullOrWhiteSpace($pub)) { throw '公钥文件为空，无法继续。' }
ssh -p __PORT__ __USER__@__HOST__ "umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; grep -qxF '$pub' ~/.ssh/authorized_keys || echo '$pub' >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys"
ssh -p __PORT__ -o BatchMode=yes -o StrictHostKeyChecking=accept-new __USER__@__HOST__ "echo OK: __USER__@__HOST__ 免密登录已生效"
'@

    # 只保留远端写入动作，方便已经准备好公钥的用户直接复制执行。
    # 这条命令仍由 PowerShell 负责读取本机公钥，因此不会把公钥内容写死在页面或配置文件中。
    $single = @'
$key = __KEYEXPR__; $pub = (Get-Content -Raw "$key.pub").Trim(); if ([string]::IsNullOrWhiteSpace($pub)) { throw '公钥文件为空，无法继续。' }; ssh -p __PORT__ __USER__@__HOST__ "umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; grep -qxF '$pub' ~/.ssh/authorized_keys || echo '$pub' >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys"
'@

    $steps = @'
# Tunnel Studio · 分步配置免密登录
# 目标：__USER__@__HOST__:__PORT__

# ── 1. 生成本机密钥（已有密钥会自动跳过；口令按 Enter 两次）──
$key = __KEYEXPR__
if (-not (Test-Path "$key.pub")) {
    ssh-keygen -t ed25519 -C "$env:COMPUTERNAME-tunnelstudio" -f $key
}
Get-Content "$key.pub"

# ── 2. 上传公钥（此步会要求输入一次服务器密码）─────────────
$pub = (Get-Content -Raw "$key.pub").Trim()
if ([string]::IsNullOrWhiteSpace($pub)) { throw '公钥文件为空，无法继续。' }
ssh -p __PORT__ __USER__@__HOST__ "umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; grep -qxF '$pub' ~/.ssh/authorized_keys || echo '$pub' >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys"

# ── 3. 验证免密登录（应直接输出 OK，不再询问密码）─────────
ssh -p __PORT__ -o BatchMode=yes -o StrictHostKeyChecking=accept-new __USER__@__HOST__ "echo OK: 免密登录已生效"

# ── 可选：让 Windows ssh-agent 记住密钥 ────────────────────
# 在「管理员 PowerShell」中执行一次：
#   Set-Service ssh-agent -StartupType Automatic
#   Start-Service ssh-agent
# 然后执行：
#   ssh-add $key
'@

    $config = @'
# Tunnel Studio · SSH 快捷别名
# 将以下内容追加到 $env:USERPROFILE\.ssh\config
$configPath = "$env:USERPROFILE\.ssh\config"
$entry = @"
Host __ALIAS__
    HostName __HOST__
    User __USER__
    Port __PORT__
    IdentityFile __KEYPATH__
    ServerAliveInterval 30
    ServerAliveCountMax 3
"@
New-Item -ItemType Directory -Force (Split-Path $configPath) | Out-Null
if (-not (Select-String -Path $configPath -Pattern '^Host\s+__ALIAS__\s*$' -Quiet -ErrorAction SilentlyContinue)) {
    Add-Content -Path $configPath -Value $entry -Encoding utf8
}

# 之后可以直接：
#   ssh __ALIAS__
ssh __ALIAS__ "echo OK: 别名登录成功"
'@

    $replacements = @{
        '__HOST__'    = $HostName
        '__PORT__'    = [string]$Port
        '__USER__'    = $User
        '__KEYEXPR__' = $keyExpr
        '__KEYPATH__' = $keyDisplay
        '__ALIAS__'   = $Alias
    }
    foreach ($token in $replacements.Keys) {
        $onePass = $onePass.Replace($token, $replacements[$token])
        $single = $single.Replace($token, $replacements[$token])
        $steps = $steps.Replace($token, $replacements[$token])
        $config = $config.Replace($token, $replacements[$token])
    }

    $verify = 'ssh -p ' + $Port + ' -o BatchMode=yes -o StrictHostKeyChecking=accept-new ' + $User + '@' + $HostName + ' "echo OK"'

    return [ordered]@{
        target    = "$User@${HostName}:${Port}"
        host      = $HostName
        port      = $Port
        user      = $User
        keyPath   = $KeyPath
        alias     = $Alias
        onepass   = $onePass.Trim()
        single    = $single.Trim()
        steps     = $steps.Trim()
        sshconfig = $config.Trim()
        verify    = $verify
        keyLeaf   = $keyLeaf
    }
}

# ------------------------------------------------------------
#  Native process helper
# ------------------------------------------------------------

function Invoke-NativeProcess {
    param(
        [string]$FilePath,
        [string]$Arguments = '',
        [int]$TimeoutMs = 20000,
        [hashtable]$Environment = $null,
        [string[]]$ArgumentList = $null
    )
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    if ($ArgumentList) {
        # ArgumentList 只存在于 .NET Core/PowerShell 7；Windows PowerShell 5.1 回退到安全的 argv 引号规则。
        $argumentListProperty = $psi.PSObject.Properties['ArgumentList']
        if ($null -ne $argumentListProperty) {
            foreach ($argument in $ArgumentList) { [void]$psi.ArgumentList.Add([string]$argument) }
        } else {
            $quoted = foreach ($argument in $ArgumentList) {
                $value = [string]$argument
                if ($value -notmatch '[\s"]') { $value; continue }
                '"' + (($value -replace '(\\*)"', '$1$1\\"') -replace '(\\+)$', '$1$1') + '"'
            }
            $psi.Arguments = ($quoted -join ' ')
        }
    } else {
        $psi.Arguments = $Arguments
    }
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    if ($Environment) {
        foreach ($key in $Environment.Keys) {
            $psi.EnvironmentVariables[[string]$key] = [string]$Environment[$key]
        }
    }
    $process = $null
    try {
        $process = [System.Diagnostics.Process]::Start($psi)
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutMs)) {
            try { $process.Kill() } catch { }
            return [ordered]@{ exitCode = -1; stdout = ''; stderr = '操作超时'; timedOut = $true }
        }
        $process.WaitForExit()
        return [ordered]@{
            exitCode = $process.ExitCode
            stdout   = $stdoutTask.Result
            stderr   = $stderrTask.Result
            timedOut = $false
        }
    } catch {
        return [ordered]@{ exitCode = -1; stdout = ''; stderr = $_.Exception.Message; timedOut = $false }
    } finally {
        if ($process) { $process.Dispose() }
    }
}

# ------------------------------------------------------------
#  Server connectivity check
# ------------------------------------------------------------

function Test-ServerConnectivity([string]$id) {
    $server = Get-Server $id
    if ($null -eq $server) { throw '服务器不存在或已被删除。' }
    $simulation = To-Bool (Get-Setting 'simulation' $true) $true
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    if ($simulation) {
        Start-Sleep -Milliseconds (Get-Random -Minimum 220 -Maximum 620)
        $watch.Stop()
        $ms = [int]$watch.ElapsedMilliseconds + (Get-Random -Minimum 8 -Maximum 28)
        $ok = $true
        $errorText = ''
    } else {
        $client = New-Object System.Net.Sockets.TcpClient
        try {
            $pending = $client.ConnectAsync([string]$server.host, [int]$server.port)
            if (-not $pending.Wait(2500)) {
                $ok = $false
                $errorText = '连接超时'
            } elseif ($client.Connected) {
                $ok = $true
                $errorText = ''
            } else {
                $ok = $false
                $errorText = '无法建立连接'
            }
        } catch {
            $ok = $false
            $errorText = $_.Exception.Message
        } finally {
            $watch.Stop()
            $client.Dispose()
        }
        $ms = [int]$watch.ElapsedMilliseconds
    }
    $server.lastCheck = To-Iso (NowUtc)
    $server.lastLatency = if ($ok) { $ms } else { $null }
    Save-Config
    if ($ok) {
        Add-Log success 'panel' "服务器「$($server.name)」连接正常 · $ms ms"
        Add-Activity -Kind 'success' -Title '服务器可达' -Detail "$($server.name) · $ms ms"
    } else {
        Add-Log error 'panel' "服务器「$($server.name)」连接失败：$errorText"
        Add-Activity -Kind 'error' -Title '服务器不可达' -Detail "$($server.name) · $errorText"
    }
    return [ordered]@{ ok = $ok; ms = $ms; error = $errorText; server = $server }
}

# ------------------------------------------------------------
#  Passwordless onboarding jobs
# ------------------------------------------------------------

function New-PasswordSteps {
    return @(
        [ordered]@{ id = 'key'; title = '检查本机密钥'; detail = ''; status = 'pending' },
        [ordered]@{ id = 'generate'; title = '生成 ed25519 密钥'; detail = ''; status = 'pending' },
        [ordered]@{ id = 'install'; title = '写入服务器 authorized_keys'; detail = ''; status = 'pending' },
        [ordered]@{ id = 'verify'; title = '验证免密登录'; detail = ''; status = 'pending' },
        [ordered]@{ id = 'save'; title = '保存服务器配置'; detail = ''; status = 'pending' }
    )
}

function Start-PasswordlessJob($body) {
    if ($null -eq $body) { $body = @{} }
    $hostName = ([string]$body.host).Trim()
    if ([string]::IsNullOrWhiteSpace($hostName)) { throw '请输入服务器地址。' }
    if ($hostName -notmatch '^[A-Za-z0-9\.\-_:]+$') { throw '服务器地址格式不正确。' }
    $port = 22
    if (-not [int]::TryParse([string]$body.port, [ref]$port) -or $port -lt 1 -or $port -gt 65535) { throw 'SSH 端口必须为 1 - 65535 的整数。' }
    $user = ([string]$body.user).Trim()
    if ([string]::IsNullOrWhiteSpace($user)) { $user = [string](Get-Setting 'defaultUser' 'root') }
    if ($user -notmatch '^[A-Za-z0-9._\-]+$') { throw '用户名格式不正确。' }
    $keyPath = ([string]$body.keyPath).Trim()
    if ([string]::IsNullOrWhiteSpace($keyPath)) { $keyPath = [string](Get-Setting 'defaultKeyPath' '~/.ssh/id_ed25519') }
    $alias = ([string]$body.alias).Trim()
    if ([string]::IsNullOrWhiteSpace($alias)) { $alias = Get-SafeAlias $hostName }
    $simulation = To-Bool (Get-Setting 'simulation' $true) $true
    $password = [string]$body.password
    if (-not $simulation -and [string]::IsNullOrEmpty($password)) {
        throw '真实模式下需要输入一次服务器密码，或改用「仅生成命令」。'
    }

    $jobId = New-Id 'pw-' 10
    $job = [ordered]@{
        id          = $jobId
        createdAt   = To-Iso (NowUtc)
        status      = 'running'
        simulation  = $simulation
        host        = $hostName
        port        = $port
        user        = $user
        keyPath     = $keyPath
        alias       = $alias
        saveServer  = To-Bool $body.saveServer $true
        serverName  = ([string]$body.serverName).Trim()
        serverId    = ([string]$body.serverId).Trim()
        generateKey = To-Bool $body.generateKey $true
        steps       = New-PasswordSteps
        message     = ''
        error       = ''
        command     = Get-SshCommandBundle -HostName $hostName -Port $port -User $user -KeyPath $keyPath -Alias $alias
        nextAt      = (NowUtc).AddMilliseconds(300)
        finishedAt  = $null
    }
    $script:PasswordJobs[$jobId] = $job
    if (-not $simulation) { $script:PasswordSecrets[$jobId] = $password }
    Add-Log info 'panel' "开始免密配置：$user@${hostName}:${port}（$(if ($simulation) { '演示' } else { '真实' })）"
    return $job
}

function Get-PasswordlessJob([string]$id) {
    if (-not $script:PasswordJobs.ContainsKey($id)) { throw '配置任务不存在或已过期。' }
    $job = $script:PasswordJobs[$id]
    $copy = [ordered]@{}
    foreach ($key in $job.Keys) {
        if ($key -eq 'steps') {
            $steps = @()
            foreach ($step in $job.steps) { $steps += [ordered]@{ id = $step.id; title = $step.title; detail = $step.detail; status = $step.status } }
            $copy['steps'] = $steps
        } else {
            $copy[$key] = $job[$key]
        }
    }
    return $copy
}

function Complete-PasswordJob($job, [string]$status, [string]$message) {
    $job.status = $status
    $job.message = $message
    $job.finishedAt = To-Iso (NowUtc)
    if ($script:PasswordSecrets.ContainsKey($job.id)) { $script:PasswordSecrets.Remove($job.id) }
    if ($status -eq 'success') {
        Add-Log success 'panel' "免密配置完成：$($job.user)@$($job.host):$($job.port)"
        Add-Activity -Kind 'success' -Title '免密配置完成' -Detail "$($job.user)@$($job.host):$($job.port)"
    } elseif ($status -eq 'manual') {
        Add-Log warn 'panel' "免密配置需要手动完成：$($job.user)@$($job.host):$($job.port)"
        Add-Activity -Kind 'warning' -Title '需要手动配置' -Detail "$($job.user)@$($job.host):$($job.port) · 自动安装未完成"
    } else {
        Add-Log error 'panel' "免密配置失败：$message"
        Add-Activity -Kind 'error' -Title '免密配置失败' -Detail $message
    }
}

function Save-PasswordServer($job) {
    $existing = $null
    if ($job.serverId) { $existing = Get-Server $job.serverId }
    if (-not $existing) {
        foreach ($server in @(Get-Servers)) {
            if ($server.host -ieq $job.host -and [int]$server.port -eq [int]$job.port -and $server.user -ieq $job.user) { $existing = $server; break }
        }
    }
    if ($existing) {
        $existing.keyPath = $job.keyPath
        $existing.passwordless = $true
        $existing.lastCheck = To-Iso (NowUtc)
        Save-Config
        return $existing.id
    }
    $name = if ($job.serverName) { $job.serverName } else { $job.host }
    $server = Add-Server([ordered]@{
        name         = $name
        host         = $job.host
        port         = $job.port
        user         = $job.user
        keyPath      = $job.keyPath
        note         = '由免密向导创建'
        color        = 'violet'
        passwordless = $true
    })
    return $server.id
}

function Invoke-PasswordStep($job, $step) {
    $simulation = [bool]$job.simulation
    $now = NowUtc
    switch ($step.id) {
        'key' {
            if ($simulation) {
                $exists = Test-Path -LiteralPath (Resolve-KeyPath $job.keyPath)
                $step.detail = if ($exists) { '已找到本机私钥（演示模式不读取内容）' } else { '本机尚未找到密钥，下一步将生成（演示）' }
                $step.status = 'done'
            } else {
                $key = Resolve-KeyPath $job.keyPath
                $privateExists = Test-Path -LiteralPath $key
                $publicExists = Test-Path -LiteralPath ($key + '.pub')
                if ($privateExists -and $publicExists) {
                    $step.detail = "已找到密钥：$key"
                    $step.status = 'done'
                } elseif ($privateExists -and -not $publicExists) {
                    $step.detail = "私钥存在但缺少公钥文件：$key.pub"
                    $step.status = 'error'
                    Complete-PasswordJob $job 'failed' $step.detail
                    return $false
                } else {
                    $step.detail = '未找到密钥，等待生成'
                    $step.status = 'done'
                }
            }
        }
        'generate' {
            $key = Resolve-KeyPath $job.keyPath
            $privateExists = Test-Path -LiteralPath $key
            $publicExists = Test-Path -LiteralPath ($key + '.pub')
            if ($privateExists -and $publicExists) {
                $step.detail = '密钥已存在，安全跳过，不会覆盖'
                $step.status = 'skipped'
                return $true
            }
            if (-not $job.generateKey) {
                $step.detail = '已关闭自动生成，且本机没有可用密钥'
                $step.status = 'error'
                Complete-PasswordJob $job 'failed' '未生成密钥，请手动生成后重试。'
                return $false
            }
            if ($simulation) {
                $step.detail = '已生成 ed25519 密钥（演示，未写入磁盘）'
                $step.status = 'done'
                return $true
            }
            $keygen = Get-Command ssh-keygen.exe -ErrorAction SilentlyContinue
            if (-not $keygen) {
                $step.detail = '未找到 ssh-keygen.exe'
                $step.status = 'error'
                Complete-PasswordJob $job 'failed' $step.detail
                return $false
            }
            Ensure-Directory (Split-Path -Parent $key)
            $arguments = '-t ed25519 -f "' + $key + '" -N "" -C "tunnelstudio@' + $env:COMPUTERNAME + '"'
            $result = Invoke-NativeProcess -FilePath $keygen.Source -Arguments $arguments -TimeoutMs 20000
            if ($result.exitCode -ne 0) {
                $step.detail = ($result.stderr + ' ' + $result.stdout).Trim()
                if (-not $step.detail) { $step.detail = 'ssh-keygen 执行失败' }
                $step.status = 'error'
                Complete-PasswordJob $job 'failed' '生成 SSH 密钥失败。'
                return $false
            }
            $step.detail = "已生成密钥：$key"
            $step.status = 'done'
        }
        'install' {
            $key = Resolve-KeyPath $job.keyPath
            $publicKeyPath = $key + '.pub'
            if ($simulation) {
                $step.detail = '公钥已追加到 ~/.ssh/authorized_keys（演示）'
                $step.status = 'done'
                return $true
            }
            if (-not (Test-Path -LiteralPath $publicKeyPath)) {
                $step.detail = "找不到公钥：$publicKeyPath"
                $step.status = 'error'
                Complete-PasswordJob $job 'failed' $step.detail
                return $false
            }
            if (-not $script:PasswordSecrets.ContainsKey($job.id)) {
                $step.detail = '缺少密码，无法自动安装'
                $step.status = 'warning'
                Complete-PasswordJob $job 'manual' '自动安装未完成，请复制下方命令手动执行。'
                return $false
            }
            $ssh = Get-SshPath
            if (-not $ssh) {
                $step.detail = '未找到 ssh.exe'
                $step.status = 'warning'
                Complete-PasswordJob $job 'manual' '未找到 ssh.exe，请安装 OpenSSH 客户端后手动执行命令。'
                return $false
            }
            $publicKey = (Get-Content -LiteralPath $publicKeyPath -Raw -ErrorAction Stop).Trim()
            if ([string]::IsNullOrWhiteSpace($publicKey)) {
                $step.detail = '公钥文件为空'
                $step.status = 'error'
                Complete-PasswordJob $job 'failed' $step.detail
                return $false
            }
            $askpass = Join-Path $env:TEMP ('tunnelstudio-askpass-' + [guid]::NewGuid().ToString('N') + '.cmd')
            $askpassContent = "@echo off`r`npowershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command `"[Console]::Out.Write(`$env:TUNNELSTUDIO_PASSWORD)`"`r`n"
            try {
                [System.IO.File]::WriteAllText($askpass, $askpassContent, [System.Text.Encoding]::ASCII)
                # 用 base64 把公钥作为数据传给远端，避免公钥注释中的特殊字符破坏 shell 引号。
                $publicKeyBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($publicKey))
                $remoteCommand = 'umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; pub=$(printf ''%s'' ''' + $publicKeyBase64 + ''' | base64 -d); grep -qxF "$pub" ~/.ssh/authorized_keys || printf ''%s\n'' "$pub" >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys'
                $argumentList = @('-p', [string]$job.port, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no', '-o', 'NumberOfPasswordPrompts=1', '-o', 'ConnectTimeout=12', ($job.user + '@' + $job.host), $remoteCommand)
                $environment = @{
                    'SSH_ASKPASS'          = $askpass
                    'SSH_ASKPASS_REQUIRE'  = 'force'
                    'DISPLAY'              = ':0'
                    'TUNNELSTUDIO_PASSWORD' = [string]$script:PasswordSecrets[$job.id]
                }
                $result = Invoke-NativeProcess -FilePath $ssh -ArgumentList $argumentList -TimeoutMs 25000 -Environment $environment
                if ($result.exitCode -ne 0) {
                    $detail = ($result.stderr + ' ' + $result.stdout).Trim()
                    if ([string]::IsNullOrWhiteSpace($detail)) { $detail = 'SSH 密码认证未成功' }
                    if ($detail.Length -gt 500) { $detail = $detail.Substring(0, 500) }
                    $step.detail = $detail
                    $step.status = 'warning'
                    Complete-PasswordJob $job 'manual' '自动安装未完成（服务器可能禁用了密码登录）。请复制下方 PowerShell 命令手动执行。'
                    return $false
                }
                $step.detail = '公钥已写入服务器 authorized_keys'
                $step.status = 'done'
            } catch {
                $step.detail = $_.Exception.Message
                $step.status = 'warning'
                Complete-PasswordJob $job 'manual' '自动安装失败，请复制下方命令手动执行。'
                return $false
            } finally {
                if (Test-Path -LiteralPath $askpass) { try { Remove-Item -LiteralPath $askpass -Force } catch { } }
            }
        }
        'verify' {
            if ($simulation) {
                $step.detail = 'ssh -o BatchMode=yes 验证通过（演示）'
                $step.status = 'done'
                return $true
            }
            $ssh = Get-SshPath
            if (-not $ssh) {
                $step.detail = '未找到 ssh.exe'
                $step.status = 'warning'
                Complete-PasswordJob $job 'manual' '未找到 ssh.exe，请手动验证。'
                return $false
            }
            $argumentList = @('-p', [string]$job.port, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=8', ($job.user + '@' + $job.host), 'echo TUNNELSTUDIO_OK')
            $result = Invoke-NativeProcess -FilePath $ssh -ArgumentList $argumentList -TimeoutMs 15000
            if ($result.exitCode -eq 0 -and ([string]$result.stdout).Contains('TUNNELSTUDIO_OK')) {
                $step.detail = '免密登录验证通过'
                $step.status = 'done'
                return $true
            }
            $detail = ($result.stderr + ' ' + $result.stdout).Trim()
            if ($detail.Length -gt 500) { $detail = $detail.Substring(0, 500) }
            $step.detail = if ($detail) { $detail } else { 'BatchMode 验证失败' }
            $step.status = 'error'
            Complete-PasswordJob $job 'failed' '公钥安装后仍无法免密登录，请检查服务器 sshd 配置。'
            return $false
        }
        'save' {
            if (-not $job.saveServer) {
                $step.detail = '未勾选保存，仅生成了命令'
                $step.status = 'skipped'
                return $true
            }
            try {
                $serverId = Save-PasswordServer $job
                $job.serverId = $serverId
                $step.detail = if ($simulation) { '已保存服务器配置（演示）' } else { '已保存服务器配置' }
                $step.status = 'done'
                return $true
            } catch {
                $step.detail = $_.Exception.Message
                $step.status = 'error'
                Complete-PasswordJob $job 'failed' $step.detail
                return $false
            }
        }
    }
    return $true
}

function Update-PasswordJobs {
    if ($script:PasswordJobs.Count -eq 0) { return }
    $now = NowUtc
    foreach ($id in @($script:PasswordJobs.Keys)) {
        $job = $script:PasswordJobs[$id]
        if ($job.status -ne 'running') { continue }
        if ($now -lt [DateTime]$job.nextAt) { continue }
        $step = $null
        foreach ($candidate in $job.steps) {
            if ($candidate.status -in @('pending', 'running')) { $step = $candidate; break }
        }
        if ($null -eq $step) {
            Complete-PasswordJob $job 'success' '免密登录配置完成，服务器已加入列表。'
            continue
        }
        $step.status = 'running'
        $ok = $true
        try {
            $ok = Invoke-PasswordStep $job $step
        } catch {
            $step.status = 'error'
            $step.detail = $_.Exception.Message
            Complete-PasswordJob $job 'failed' $_.Exception.Message
            $ok = $false
        }
        if (-not $ok) { continue }
        if ($job.status -ne 'running') { continue }
        $job.nextAt = $now.AddMilliseconds((Get-Random -Minimum 520 -Maximum 900))
        if ($job.steps | Where-Object { $_.status -in @('pending', 'running') }) { continue }
        $simulationNote = if ($job.simulation) { '（演示模式，未连接服务器）' } else { '' }
        Complete-PasswordJob $job 'success' ('免密登录配置完成' + $simulationNote)
    }

    foreach ($id in @($script:PasswordJobs.Keys)) {
        $job = $script:PasswordJobs[$id]
        if ($job.finishedAt) {
            try {
                if (((NowUtc) - [DateTime]::Parse($job.finishedAt)).TotalMinutes -gt 20) {
                    $script:PasswordJobs.Remove($id)
                }
            } catch { }
        }
    }
}
