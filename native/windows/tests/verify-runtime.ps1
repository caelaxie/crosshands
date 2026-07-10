$ErrorActionPreference = "Stop"
$runtime = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\runtime.ps1"))
$source = [System.IO.File]::ReadAllText($runtime)

$required = @(
    '[Console]::In.ReadLine()',
    '$PSModuleAutoLoadingPreference = "None"',
    'Import-Module -LiteralPath $securityModule',
    'OpenInputDesktop',
    'SetProcessDpiAwarenessContext',
    'Assert-CrossHandsProcessIdentity $process $Operation.expectedIdentity',
    'Get-AuthenticodeSignature',
    '[System.Security.Cryptography.SHA256]::Create()'
)
foreach ($needle in $required) {
    if (-not $source.Contains($needle)) { throw "Missing Windows runtime invariant: $needle" }
}
if ($source.Contains('$OperationPath')) { throw 'Operation file transport must not return' }

$tokens = $null
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($runtime, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw ($errors | Out-String) }
Write-Output "CrossHands Windows runtime static verification passed."
