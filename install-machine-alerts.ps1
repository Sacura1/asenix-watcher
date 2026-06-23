$ErrorActionPreference = "Stop"

$server = $env:ASENIX_WATCHER_SERVER
$token = $env:ASENIX_WATCHER_TOKEN
$installDir = if ($env:ASENIX_WATCHER_DIR) { $env:ASENIX_WATCHER_DIR } else { Join-Path $env:USERPROFILE ".asenix-watcher" }
$repoUrl = if ($env:ASENIX_WATCHER_REPO) { $env:ASENIX_WATCHER_REPO } else { "https://github.com/sacura1/asenix-watcher.git" }
$nodeRpcUrl = if ($env:ASENIX_NODE_RPC_URL) { $env:ASENIX_NODE_RPC_URL } else { "http://127.0.0.1:8545" }
$processNames = if ($env:ASENIX_NODE_PROCESS_NAMES) { $env:ASENIX_NODE_PROCESS_NAMES } else { "asentum-validator,node" }

if (-not $server -or -not $token) {
  throw "ASENIX_WATCHER_SERVER and ASENIX_WATCHER_TOKEN are required."
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 20+ is required before enabling Machine alerts."
}

New-Item -ItemType Directory -Force -Path $installDir | Out-Null

if (-not (Test-Path (Join-Path $installDir ".git"))) {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "git is required for this installer."
  }
  git clone $repoUrl $installDir
} else {
  git -C $installDir pull --ff-only
}

@"
ASENIX_WATCHER_SERVER=$server
ASENIX_WATCHER_TOKEN=$token
ASENIX_NODE_RPC_URL=$nodeRpcUrl
ASENIX_NODE_PROCESS_NAMES=$processNames
ASENIX_SYSTEMD_SERVICES=
ASENIX_DISK_PATHS=
"@ | Set-Content -Path (Join-Path $installDir ".env") -Encoding UTF8

Write-Host "Machine alerts installed at $installDir"
Write-Host "Starting Machine alerts. Keep this terminal open for now."
Set-Location $installDir
node .\src\agent.mjs
