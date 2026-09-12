$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-Checked {
    param([string]$Executable, [string[]]$ArgumentList)
    & $Executable @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed: $Executable (exit $LASTEXITCODE)"
    }
}

$Root = Split-Path $PSScriptRoot -Parent
Push-Location $Root
try {
    Write-Host 'Development setup downloads packages from PyPI and npm. It does NOT download LLM models.'
    $Python = Join-Path $Root '.venv\Scripts\python.exe'
    if (-not (Test-Path $Python)) {
        Invoke-Checked -Executable 'python' -ArgumentList @('-m', 'venv', '.venv')
    }
    Invoke-Checked -Executable $Python -ArgumentList @('-m', 'pip', 'install', '-r', 'requirements-lock.txt')
    $Tools = Join-Path $Root '.tools'
    $ToolNode = Join-Path $Tools 'node_modules\node\bin\node.exe'
    $ToolNpm = Join-Path $Tools 'node_modules\npm\bin\npm-cli.js'
    if (-not (Test-Path $ToolNode) -or -not (Test-Path $ToolNpm)) {
        Invoke-Checked -Executable 'npm.cmd' -ArgumentList @('--prefix', $Tools, 'install', '--save-exact', 'node@22.23.2', 'npm@11.4.1')
    }
    $OriginalPath = $env:PATH
    $env:PATH = (Split-Path $ToolNode) + ';' + $env:PATH
    Push-Location (Join-Path $Root 'frontend')
    try {
        Invoke-Checked -Executable $ToolNode -ArgumentList @($ToolNpm, 'ci')
        Invoke-Checked -Executable $ToolNode -ArgumentList @($ToolNpm, 'run', 'build', '--', '--logLevel', 'error')
    } finally {
        Pop-Location
        $env:PATH = $OriginalPath
    }
    Write-Host 'Setup complete. Run .\scripts\start.ps1 from the repository root.'
} finally {
    Pop-Location
}