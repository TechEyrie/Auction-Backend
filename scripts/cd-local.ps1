# Local CD simulation for docker-compose.prod.yml
# Uses COMPOSE_PROJECT_NAME=araq-cd-sim and API 14000 / Mongo 27018 — not the dev stack on 4000.

$ErrorActionPreference = 'Stop'

$argLine = $args -join ' '
if ($argLine -match '(?i)restore|mongorestore|seed|bootstrap') {
  Write-Error 'Refusing: restore, mongorestore, seed, and bootstrap are not allowed.'
  exit 1
}
if ($argLine -match '(?i)down\b.*\B-v\b|\B-v\b.*down\b') {
  Write-Error 'Refusing: docker compose down -v is not allowed.'
  exit 1
}

$BackendRoot = Split-Path -Parent $PSScriptRoot
$SimRoot = Join-Path (Join-Path $BackendRoot '.cd-sim') 'araqandkahraman'
$MongoDir = Join-Path (Join-Path $SimRoot 'data') 'mongo'
$MediaDir = Join-Path (Join-Path $SimRoot 'data') 'media'
$EnvDir = Join-Path $SimRoot 'env'
foreach ($d in @($MongoDir, $MediaDir, $EnvDir)) {
  New-Item -ItemType Directory -Force -Path $d | Out-Null
}

$EnvDest = Join-Path $EnvDir 'backend.env'
$EnvSource = Join-Path $BackendRoot '.env'
if (Test-Path -LiteralPath $EnvSource) {
  Copy-Item -LiteralPath $EnvSource -Destination $EnvDest -Force
} elseif (-not (Test-Path -LiteralPath $EnvDest)) {
  Write-Error "Missing $EnvDest and no backend/.env to copy. Create one before running CD simulation."
  exit 1
}

$env:MONGO_DATA = $MongoDir
$env:MEDIA_DATA = $MediaDir
$env:ENV_FILE = $EnvDest
$env:API_BIND = '127.0.0.1:14000'
$env:MONGO_BIND = '127.0.0.1:27018'
$env:COMPOSE_PROJECT_NAME = 'araq-cd-sim'
# Local .env still uses the manual payment placeholder; production compose rejects it.
$env:APP_NODE_ENV = 'development'

Push-Location -LiteralPath $BackendRoot
try {
  docker compose -f docker-compose.prod.yml config | Out-Null
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  docker compose -f docker-compose.prod.yml up -d --build
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  $readyUrl = 'http://127.0.0.1:14000/readyz'
  $deadline = (Get-Date).AddMinutes(3)
  do {
    try {
      $resp = Invoke-WebRequest -Uri $readyUrl -UseBasicParsing -TimeoutSec 5
      if ($resp.StatusCode -eq 200) {
        Write-Host "readyz OK ($readyUrl)"
        exit 0
      }
    } catch {
      # not ready yet
    }
    if ((Get-Date) -ge $deadline) {
      Write-Error "Timed out waiting for $readyUrl"
      exit 1
    }
    Start-Sleep -Seconds 3
  } while ($true)
} finally {
  Pop-Location
}
