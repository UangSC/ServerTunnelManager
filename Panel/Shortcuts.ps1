#requires -Version 7.0
# Current-user application integration. No Node, elevation, config writes or
# launch actions are required to inspect/install/remove these shortcuts.

function New-PanelShortcutShell {
    return New-Object -ComObject WScript.Shell
}

function Close-PanelShortcutObject($value) {
    if ($null -ne $value -and [Runtime.InteropServices.Marshal]::IsComObject($value)) {
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($value)
    }
}

function Get-PanelShortcutLocations {
    $programs = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)
    $desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
    if (-not $programs -or -not $desktop) { throw '无法找到当前用户的开始菜单或桌面目录。' }
    return [ordered]@{
        startMenu = (Join-Path $programs 'Tunnel Studio')
        desktop = $desktop
    }
}

function Get-PanelShortcutSpecifications {
    $locations = Get-PanelShortcutLocations
    $root = [IO.Path]::GetFullPath($script:RootDir)
    $powerShell = Join-Path $PSHOME 'pwsh.exe'
    foreach ($location in $locations.Keys) {
        foreach ($action in @('Start', 'Stop')) {
            $scriptPath = Join-Path $root ($action + '-Panel.ps1')
            $arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $scriptPath + '"'
            if ($action -eq 'Start') { $arguments += ' -Quiet' }
            [ordered]@{
                location = $location
                action = $action.ToLowerInvariant()
                path = [IO.Path]::GetFullPath((Join-Path $locations[$location] ('Tunnel Studio - ' + $action + '.lnk')))
                directory = [IO.Path]::GetFullPath($locations[$location])
                target = $powerShell
                arguments = $arguments
                workingDirectory = $root
                script = $scriptPath
                icon = if ($action -eq 'Start') { $powerShell + ',0' } else { (Join-Path $env:WINDIR 'System32\shell32.dll') + ',28' }
                description = if ($action -eq 'Start') { '启动 Tunnel Studio 面板' } else { '停止 Tunnel Studio 面板（保留后台 SSH 隧道）' }
            }
        }
    }
}

function Test-PanelShortcutOwned($shell, $specification) {
    if (-not (Test-Path -LiteralPath $specification.path -PathType Leaf)) { return $false }
    $item = Get-Item -LiteralPath $specification.path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
    $shortcut = $null
    try {
        $shortcut = $shell.CreateShortcut($specification.path)
        return (([string]$shortcut.TargetPath -ieq [string]$specification.target -or
            [string]$shortcut.TargetPath -ieq (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe')) -and
            [string]$shortcut.Arguments -ceq [string]$specification.arguments -and
            [string]$shortcut.WorkingDirectory -ieq [string]$specification.workingDirectory)
    } catch { return $false }
    finally { Close-PanelShortcutObject $shortcut }
}

function Get-ApplicationShortcutInfo {
    $info = [ordered]@{
        supported = ($env:OS -eq 'Windows_NT')
        enabled = $false
        path = ''
        paths = @()
        message = '仅支持 Windows 当前用户的开始菜单和桌面快捷图标。'
    }
    if (-not $info.supported) { return $info }
    $shell = $null
    try {
        $specifications = @(Get-PanelShortcutSpecifications)
        $info.path = $specifications[0].directory
        $shell = New-PanelShortcutShell
        $installed = 0
        $paths = @()
        foreach ($specification in $specifications) {
            $owned = Test-PanelShortcutOwned $shell $specification
            if ($owned) { $installed++ }
            $paths += [ordered]@{ location = $specification.location; action = $specification.action; path = $specification.path; enabled = $owned }
        }
        $info.paths = $paths
        $info.enabled = ($installed -eq $specifications.Count)
        $info.message = if ($info.enabled) { '已安装开始菜单与桌面的启动、停止面板图标；停止面板不会关闭后台 SSH 隧道。' }
            elseif ($installed -gt 0) { '部分快捷图标已安装；启用可补齐当前项目的启动、停止图标。' }
            else { '安装到当前用户开始菜单与桌面，无需管理员权限；不影响开机自启。' }
    } catch {
        $info.message = '无法检查快捷图标：' + $_.Exception.Message
    } finally { Close-PanelShortcutObject $shell }
    return $info
}

function Set-ApplicationShortcut([bool]$enabled) {
    if ($env:OS -ne 'Windows_NT') { throw '当前系统不支持 Windows 快捷图标。' }
    $specifications = @(Get-PanelShortcutSpecifications)
    $shell = New-PanelShortcutShell
    try {
        # Preflight every destination before modifying any shortcut. Never
        # overwrite or delete a same-named link belonging to a different copy.
        foreach ($specification in $specifications) {
            if ($enabled -and -not (Test-Path -LiteralPath $specification.script -PathType Leaf)) {
                throw ('找不到面板脚本：' + $specification.script)
            }
            if (Test-Path -LiteralPath $specification.path) {
                if (-not (Test-PanelShortcutOwned $shell $specification)) {
                    if ($enabled) { throw ('同名快捷图标不属于当前项目，请先手动确认：' + $specification.path) }
                }
            }
        }
        foreach ($specification in $specifications) {
            if ($enabled) {
                if (-not (Test-Path -LiteralPath $specification.directory -PathType Container)) {
                    New-Item -ItemType Directory -Path $specification.directory -Force | Out-Null
                }
                $shortcut = $null
                try {
                    $shortcut = $shell.CreateShortcut($specification.path)
                    $shortcut.TargetPath = $specification.target
                    $shortcut.Arguments = $specification.arguments
                    $shortcut.WorkingDirectory = $specification.workingDirectory
                    $shortcut.Description = $specification.description
                    $shortcut.IconLocation = $specification.icon
                    $shortcut.WindowStyle = 7
                    $shortcut.Save()
                } finally { Close-PanelShortcutObject $shortcut }
            } elseif (Test-PanelShortcutOwned $shell $specification) {
                # specification.path is an absolute, fixed-name path from the
                # known-folder plan, and ownership was checked immediately above.
                Remove-Item -LiteralPath $specification.path -Force -ErrorAction Stop
            }
        }
    } finally { Close-PanelShortcutObject $shell }
    return Get-ApplicationShortcutInfo
}
