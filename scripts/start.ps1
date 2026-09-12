param([int]$Port = 8765)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Root = Split-Path $PSScriptRoot -Parent
$Python = Join-Path $Root '.venv\Scripts\python.exe'
if (-not (Test-Path $Python)) {
    throw 'Python environment not found. Run .\scripts\setup.ps1 first.'
}
Push-Location $Root
try {
    & $Python -m backend --port $Port
    if ($LASTEXITCODE -ne 0) {
        throw "Server stopped with exit code $LASTEXITCODE."
    }
} finally {
    Pop-Location
}