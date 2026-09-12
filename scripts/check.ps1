param([switch]$InstallBrowser, [switch]$Audit)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Root = Split-Path $PSScriptRoot -Parent
$Python = Join-Path $Root '.venv\Scripts\python.exe'
$Node = Join-Path $Root '.tools\node_modules\node\bin\node.exe'
$Npm = Join-Path $Root '.tools\node_modules\npm\bin\npm-cli.js'
if (-not (Test-Path $Python) -or -not (Test-Path $Node) -or -not (Test-Path $Npm)) {
    throw 'Run .\scripts\setup.ps1 before checking the project.'
}
function Invoke-Checked {
    param([string]$Executable, [string[]]$ArgumentList)
    & $Executable @ArgumentList
    if ($LASTEXITCODE -ne 0) { throw "Check failed: $Executable (exit $LASTEXITCODE)" }
}
$OriginalPath = $env:PATH
$env:PATH = (Split-Path $Node) + ';' + $env:PATH
Push-Location $Root
try {
    Invoke-Checked -Executable $Python -ArgumentList @('-m', 'pytest', 'tests', '-q')
    if ($Audit) { Invoke-Checked -Executable $Python -ArgumentList @('-m', 'pip_audit') }
    Push-Location (Join-Path $Root 'frontend')
    try {
        Invoke-Checked -Executable $Node -ArgumentList @($Npm, 'run', 'lint')
        Invoke-Checked -Executable $Node -ArgumentList @($Npm, 'run', 'build', '--', '--logLevel', 'error')
        if ($InstallBrowser) {
            Invoke-Checked -Executable $Node -ArgumentList @('node_modules\@playwright\test\cli.js', 'install', 'chromium')
        }
        Invoke-Checked -Executable $Node -ArgumentList @($Npm, 'run', 'test:e2e')
        if ($Audit) { Invoke-Checked -Executable $Node -ArgumentList @($Npm, 'audit') }
    } finally { Pop-Location }
} finally {
    Pop-Location
    $env:PATH = $OriginalPath
}