# Axiom AI — Windows launcher
#
# Convenience wrapper around `docker compose up --build` that checks the
# prerequisites first and explains what to do when one is missing.

$ErrorActionPreference = "Stop"

function Test-Command($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

# --- Docker ---
if (-not (Test-Command "docker")) {
    Write-Host "Docker is not installed or not on PATH." -ForegroundColor Red
    Write-Host "Install Docker Desktop: https://www.docker.com/products/docker-desktop/"
    exit 1
}

docker info *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Docker is installed but the daemon isn't running." -ForegroundColor Red
    Write-Host "Start Docker Desktop, wait for it to report 'Engine running', then re-run this script."
    exit 1
}

# --- LLM backend ---
# Groq takes precedence when a key is present; otherwise Ollama must be up.
$groqKey = $env:GROQ_API_KEY
if (-not $groqKey -and (Test-Path ".env")) {
    $match = Select-String -Path ".env" -Pattern '^\s*GROQ_API_KEY\s*=\s*(.+)$' -ErrorAction SilentlyContinue
    if ($match) { $groqKey = $match.Matches[0].Groups[1].Value.Trim() }
}

if ($groqKey) {
    Write-Host "LLM backend: Groq (GROQ_API_KEY is set)." -ForegroundColor Green
}
else {
    if (Get-Process ollama -ErrorAction SilentlyContinue) {
        Write-Host "LLM backend: Ollama (running)." -ForegroundColor Green
    }
    else {
        Write-Host "Ollama does not appear to be running." -ForegroundColor Yellow
        Write-Host "  Install it from https://ollama.ai/ then run:  ollama pull llama3"
        Write-Host "  (Or set GROQ_API_KEY in .env to use hosted Llama 3 instead.)"
        Write-Host "Continuing anyway - the UI will start, but answers will fail until a backend is up."
    }
}

Write-Host ""
Write-Host "Starting Axiom AI..." -ForegroundColor Cyan
Write-Host "First boot downloads the embedding model (~1.3GB) and may take several minutes." -ForegroundColor DarkGray
Write-Host "UI will be available at http://localhost:3000" -ForegroundColor Cyan
Write-Host ""

docker compose up --build
exit $LASTEXITCODE
