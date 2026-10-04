# Run with powershell.exe (5.1) and pwsh. Never executes the voice anchor.
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$file = Join-Path $repo 'scripts/voice/ancora-wsl-asterisk.ps1'
$tokens = $null
$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$parseErrors) | Out-Null
if ($parseErrors.Count -gt 0) {
    $parseErrors | ForEach-Object { Write-Output ("Line {0}: {1}" -f $_.Extent.StartLineNumber, $_.Message) }
    exit 1
}
# ASCII makes the BOM-less file independent of the Windows ANSI code page.
if ([System.IO.File]::ReadAllBytes($file) | Where-Object { $_ -gt 127 }) {
    Write-Output 'Anchor must remain ASCII for Windows PowerShell 5.1 compatibility.'
    exit 1
}
Write-Output ("PASS: anchor parses on PowerShell {0}; no service executed." -f $PSVersionTable.PSVersion)
