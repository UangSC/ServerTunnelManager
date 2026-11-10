#requires -Version 5.1
<#
No-Node Windows API automation. Examples:
  .\bin\api.ps1 -Path /api/settings
  .\bin\api.ps1 -Method POST -Path /api/application-shortcut -Body '{"enabled":true}'
Body can also be supplied over stdin with -BodyStdin (useful for JSON quoting).
Does not start the panel, initialize user config, or write/cache tokens.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Path,
    [ValidateSet('GET', 'POST', 'PATCH', 'PUT', 'DELETE')][string]$Method = 'GET',
    [string]$Body = '',
    [switch]$BodyStdin,
    [ValidateRange(0, 65535)][int]$Port = 0
)
$ErrorActionPreference = 'Stop'
try {
    $consoleUtf8 = New-Object Text.UTF8Encoding($false)
    [Console]::OutputEncoding = $consoleUtf8
    [Console]::InputEncoding = $consoleUtf8
    $OutputEncoding = $consoleUtf8
} catch { }
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path (Join-Path $root 'Panel') 'ApiClient.ps1')
try {
    if ($BodyStdin) {
        if ($Body) { throw 'Body 和 BodyStdin 不能同时使用。' }
        $Body = [Console]::In.ReadToEnd()
    }
    Invoke-PanelApi $root $Path $Method $Body $Port
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
