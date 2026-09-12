$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Root = Split-Path $PSScriptRoot -Parent
$Ollama = Join-Path $Root '.tools\ollama\v0.34.0\ollama.exe'
if (-not (Test-Path $Ollama)) {
    throw 'Ollama ZIP installation not found. See README.md for installation instructions.'
}
$Settings = @{
    OLLAMA_HOST = '127.0.0.1:11434'
    OLLAMA_NO_CLOUD = '1'
    OLLAMA_CONTEXT_LENGTH = '4096'
    OLLAMA_NUM_PARALLEL = '1'
    OLLAMA_MAX_LOADED_MODELS = '1'
}
$Original = @{}
foreach ($Name in $Settings.Keys) {
    $Original[$Name] = [Environment]::GetEnvironmentVariable($Name, 'Process')
    [Environment]::SetEnvironmentVariable($Name, $Settings[$Name], 'Process')
}
try {
    & $Ollama serve
    if ($LASTEXITCODE -ne 0) { throw "Ollama stopped with exit code $LASTEXITCODE." }
} finally {
    foreach ($Name in $Settings.Keys) {
        [Environment]::SetEnvironmentVariable($Name, $Original[$Name], 'Process')
    }
}