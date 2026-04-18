# install.ps1 — ashlr-plugin Windows installer
#
# Usage:
#   irm https://raw.githubusercontent.com/ashlrai/ashlr-plugin/main/docs/install.ps1 | iex
#
# Or locally:
#   .\docs\install.ps1
#
# Requirements: Bun for Windows, Git for Windows

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$PluginRepo = "https://github.com/ashlrai/ashlr-plugin"
$PluginDir  = Join-Path $env:USERPROFILE ".claude\plugins\ashlr-plugin"

function Write-Step([string]$msg) {
    Write-Host "[ashlr] $msg" -ForegroundColor Cyan
}

function Write-Ok([string]$msg) {
    Write-Host "[ashlr] $msg" -ForegroundColor Green
}

function Write-Warn([string]$msg) {
    Write-Host "[ashlr] WARNING: $msg" -ForegroundColor Yellow
}

function Write-Fail([string]$msg) {
    Write-Host "[ashlr] ERROR: $msg" -ForegroundColor Red
    exit 1
}

# ---- Check prerequisites ----

Write-Step "Checking prerequisites..."

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Fail "Bun is not installed. Install it with: powershell -c `"irm bun.sh/install.ps1 | iex`""
}
Write-Ok "Bun $(bun --version) found"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Fail "Git is not installed. Download from https://git-scm.com/download/win"
}
Write-Ok "Git $(git --version) found"

# ---- Clone or update ----

Write-Step "Installing ashlr-plugin to $PluginDir ..."

$PluginsParent = Split-Path $PluginDir -Parent
if (-not (Test-Path $PluginsParent)) {
    New-Item -ItemType Directory -Path $PluginsParent -Force | Out-Null
}

if (Test-Path (Join-Path $PluginDir ".git")) {
    Write-Step "Found existing install — pulling latest..."
    git -C $PluginDir pull --ff-only
} else {
    if (Test-Path $PluginDir) {
        Remove-Item -Recurse -Force $PluginDir
    }
    git clone $PluginRepo $PluginDir
}

Write-Ok "Plugin cloned/updated."

# ---- Install dependencies ----

Write-Step "Running bun install..."
Push-Location $PluginDir
try {
    bun install --silent
    Write-Ok "Dependencies installed."
} finally {
    Pop-Location
}

# ---- Verify ----

Write-Step "Running typecheck..."
Push-Location $PluginDir
try {
    bun run typecheck
    Write-Ok "Typecheck passed."
} catch {
    Write-Warn "Typecheck reported issues. Run 'bun run typecheck' in $PluginDir for details."
} finally {
    Pop-Location
}

# ---- Next steps ----

Write-Host ""
Write-Ok "Installation complete."
Write-Host ""
Write-Host "Next steps:" -ForegroundColor White
Write-Host "  1. Register the plugin with Claude Code:" -ForegroundColor White
Write-Host "       claude plugin add $PluginDir" -ForegroundColor Gray
Write-Host "  2. Restart Claude Code." -ForegroundColor White
Write-Host "  3. See docs\install-windows.md for key file permissions and shell notes." -ForegroundColor White
Write-Host ""
