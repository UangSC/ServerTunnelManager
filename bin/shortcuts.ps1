#requires -Version 5.1
# Offline shortcut CLI: no panel launch, Node, SSH, or user config writes.
[CmdletBinding()]
param([ValidateSet('status', 'install', 'remove')][string]$Action = 'status')
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false) } catch { }
$script:RootDir = Split-Path -Parent $PSScriptRoot
. (Join-Path (Join-Path $script:RootDir 'Panel') 'Shortcuts.ps1')
try {
    $info = switch ($Action) {
        'install' { Set-ApplicationShortcut $true }
        'remove' { Set-ApplicationShortcut $false }
        default { Get-ApplicationShortcutInfo }
    }
    ConvertTo-Json -InputObject ([ordered]@{ ok = $true; applicationShortcut = $info }) -Depth 8 -Compress
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
