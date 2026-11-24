# Windows entry for the dev setup. The work is in scripts/setup.mjs.
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js is required. Install it, then run: node scripts/setup.mjs"
}
node (Join-Path $PSScriptRoot "setup.mjs")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
