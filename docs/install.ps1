# install.ps1 — ashlr-plugin Windows installer
#
# Usage:
#   irm https://raw.githubusercontent.com/ashlrai/ashlr-plugin/main/docs/install.ps1 | iex
#
# Or locally:
#   .\docs\install.ps1
#
# Requirements: Bun for Windows, Git for Windows
# Supports: Windows PowerShell 5.1+, PowerShell 7+

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$PluginRepo = "https://github.com/ashlrai/ashlr-plugin"

# Target path mirrors the macOS/Linux marketplace cache structure:
#   ~/.claude/plugins/cache/ashlr-marketplace/ashlr/<version>/
# Version is resolved from package.json after clone; we use a temp dir first,
# then move into the versioned slot.
$CacheBase = Join-Path $env:USERPROFILE ".claude\plugins\cache\ashlr-marketplace\ashlr"

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

# Bun — offer auto-install if missing
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Host "[ashlr] Bun is required but not found." -ForegroundColor Yellow
    $answer = Read-Host "[ashlr] Install Bun now? (Y/n)"
    if ($answer -eq "" -or $answer -match "^[Yy]") {
        Write-Step "Running Bun installer..."
        try {
            powershell -NoProfile -Command "irm bun.sh/install.ps1 | iex"
        } catch {
            Write-Fail "Bun installer failed: $_"
        }
        # Refresh PATH for the current session
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "User") + ";" + `
                    [System.Environment]::GetEnvironmentVariable("PATH", "Machine")
        if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
            Write-Fail "Bun was installed but is not on PATH yet. Open a new terminal and re-run this script."
        }
        Write-Ok "Bun installed successfully."
    } else {
        Write-Fail "Bun is not installed. Install it with: powershell -c `"irm bun.sh/install.ps1 | iex`""
    }
}
Write-Ok "Bun $(bun --version) found"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Fail "Git is not installed. Download from https://git-scm.com/download/win"
}
Write-Ok "Git $(git --version) found"

# ---- Ensure cache base exists ----

if (-not (Test-Path $CacheBase)) {
    New-Item -ItemType Directory -Path $CacheBase -Force | Out-Null
}

# ---- Clone to a stable 'current' working dir, then read version ----
# We clone into a fixed 'current' subdirectory under CacheBase, read the
# version from package.json, then move it to the versioned slot.

$WorkDir = Join-Path $CacheBase "current"

if (Test-Path (Join-Path $WorkDir ".git")) {
    Write-Step "Found existing clone — updating..."
    git -C $WorkDir fetch --quiet origin main
    git -C $WorkDir reset --quiet --hard origin/main
} else {
    if (Test-Path $WorkDir) {
        Remove-Item -Recurse -Force $WorkDir
    }
    Write-Step "Cloning plugin..."
    git clone --quiet $PluginRepo $WorkDir
}

Write-Ok "Plugin source ready."

# Read version from package.json
$pkgJson = Get-Content (Join-Path $WorkDir "package.json") -Raw | ConvertFrom-Json
$Version = $pkgJson.version
if (-not $Version) {
    Write-Warn "Could not read version from package.json; defaulting to 'latest'."
    $Version = "latest"
}

# ---- Move/copy into versioned slot ----

$VersionDir = Join-Path $CacheBase $Version

if (Test-Path $VersionDir) {
    # Already exists — remove and replace so update is idempotent
    Remove-Item -Recurse -Force $VersionDir
}

Write-Step "Installing to $VersionDir ..."
# Use robocopy for a reliable move on Windows 5.1 (Move-Item can fail across drives)
$null = robocopy $WorkDir $VersionDir /E /NFL /NDL /NJH /NJS /NC /NS /NP
Remove-Item -Recurse -Force $WorkDir

$PluginDir = $VersionDir
Write-Ok "Plugin at: $PluginDir"

# ---- Prune stale sibling versioned directories ----
# Keep only the newest semver dir; remove the rest.

$semverPattern = '^\d+\.\d+\.\d+$'
$siblingDirs = Get-ChildItem -Path $CacheBase -Directory |
    Where-Object { $_.Name -match $semverPattern } |
    Sort-Object { [Version]$_.Name }

if ($siblingDirs.Count -gt 1) {
    $latest = $siblingDirs[-1].Name
    foreach ($dir in $siblingDirs) {
        if ($dir.Name -ne $latest) {
            Write-Warn "Removing stale cache version: $($dir.Name)"
            Remove-Item -Recurse -Force $dir.FullName
        }
    }
    Write-Ok "Kept only latest cache version: $latest"
}

# ---- Install dependencies ----

Write-Step "Running bun install..."
Push-Location $PluginDir
try {
    bun install --silent
    Write-Ok "Dependencies installed."
} finally {
    Pop-Location
}

# ---- Next steps ----

Write-Host ""
Write-Ok "Installation complete."
Write-Host ""
Write-Host "Next steps — inside Claude Code:" -ForegroundColor White
Write-Host ""
Write-Host "  /plugin marketplace add ashlrai/ashlr-plugin" -ForegroundColor Gray
Write-Host "  /plugin install ashlr@ashlr-marketplace" -ForegroundColor Gray
Write-Host ""
Write-Host "Then restart Claude Code." -ForegroundColor White
Write-Host ""
Write-Ok "Start here (after restart):"
Write-Host "  /ashlr:ashlr-tour   -- 2-minute guided tour of every tool, hook, and command" -ForegroundColor Gray
Write-Host ""
Write-Host "Landing page: https://plugin.ashlr.ai/" -ForegroundColor Cyan
Write-Host "Source:       https://github.com/ashlrai/ashlr-plugin" -ForegroundColor Cyan
