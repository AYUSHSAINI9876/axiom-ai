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

        # llama3 needs roughly 4GB of free memory to load. Saying so now beats
        # a failed answer later, which is the point at which it looks broken.
        $os = Get-CimInstance Win32_OperatingSystem
        $freeGB = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
        if ($freeGB -lt 4.5) {
            Write-Host "  Only ${freeGB}GB of RAM is free; llama3 needs about 4GB to load." -ForegroundColor Yellow
            Write-Host "  Either close some apps, or use a smaller model:" -ForegroundColor Yellow
            Write-Host "      ollama pull llama3.2:3b   then set  LLM_MODEL=llama3.2:3b  in .env"
            Write-Host "  Or set GROQ_API_KEY in .env to offload generation entirely."
        }
    }
    else {
        Write-Host "Ollama does not appear to be running." -ForegroundColor Yellow
        Write-Host "  Install it from https://ollama.ai/ then run:  ollama pull llama3"
        Write-Host "  (Or set GROQ_API_KEY in .env to use hosted Llama 3 instead.)"
        Write-Host "Continuing anyway - the UI will start, but answers will fail until a backend is up."
    }
}

# --- Auth signing key ---
# Without JWT_SECRET the gateway mints a random one per start, which silently
# signs everyone out on every restart. Generating one into .env here makes local
# sessions survive `docker compose restart`, and keeps the secret out of git.
if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host "Created .env from .env.example." -ForegroundColor DarkGray
}

$envText = Get-Content ".env" -Raw
if ($envText -match '(?m)^\s*JWT_SECRET\s*=\s*$') {
    # RNGCryptoServiceProvider rather than RandomNumberGenerator::Fill: this
    # script runs under Windows PowerShell 5.1 on .NET Framework, where Fill()
    # (a .NET Core addition) does not exist.
    $bytes = New-Object byte[] 32
    $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }

    # Base64 can contain '+' and '/', which are fine in a .env value, but the
    # replacement string is regex-expanded, so '$' sequences would be eaten.
    $secret = [Convert]::ToBase64String($bytes)
    $envText = [System.Text.RegularExpressions.Regex]::Replace(
        $envText, '(?m)^\s*JWT_SECRET\s*=\s*$', "JWT_SECRET=$secret".Replace('$', '$$'))

    # WriteAllText with an explicit BOM-less encoder: Set-Content -Encoding utf8
    # emits a BOM on PowerShell 5.1, and a BOM on the first line of .env trips
    # up docker compose's parser.
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText((Join-Path $PWD ".env"), $envText, $utf8NoBom)
    Write-Host "Generated a JWT_SECRET in .env so sessions survive restarts." -ForegroundColor Green
}

Write-Host ""
Write-Host "Starting Axiom AI..." -ForegroundColor Cyan
Write-Host "First boot builds the images and downloads a ~130MB embedding model." -ForegroundColor DarkGray
Write-Host "UI will be available at http://localhost:3000" -ForegroundColor Cyan
Write-Host ""

docker compose up --build
exit $LASTEXITCODE
