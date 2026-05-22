# Tunnex Windows installer
# Usage: irm https://tunnex.biz/install.ps1 | iex
#
# Downloads the latest Tunnex installer (.exe) from Cloudflare R2 and runs it.

#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ReleasesUrl = 'https://pub-d098ab4c32934fd196eb5acec30a1f42.r2.dev/releases'
$LatestYmlUrl = "$ReleasesUrl/latest.yml"

function Write-Info  { param($msg) Write-Host "==> $msg" -ForegroundColor Blue }
function Write-Ok    { param($msg) Write-Host "  v $msg" -ForegroundColor Green }
function Write-Fail  { param($msg) Write-Error "Error: $msg" }

# ── fetch latest version ──────────────────────────────────────────────────────

Write-Info 'Checking for latest Tunnex release...'

try {
    $yml = (Invoke-WebRequest -Uri $LatestYmlUrl -UseBasicParsing).Content
} catch {
    Write-Fail "Could not fetch release info from $LatestYmlUrl"
}

if ($yml -notmatch 'version:\s*(\S+)') {
    Write-Fail 'Could not parse version from latest.yml'
}
$version = $Matches[1]

Write-Info "Installing Tunnex $version..."

# ── download installer ────────────────────────────────────────────────────────

$exeName = "Tunnex-$version-win-x64.exe"
$exeUrl  = "$ReleasesUrl/$exeName"
$tmpPath = Join-Path $env:TEMP $exeName

Write-Info "Downloading $exeName..."

try {
    $wc = New-Object System.Net.WebClient
    $wc.DownloadFile($exeUrl, $tmpPath)
} catch {
    Write-Fail "Download failed: $exeUrl`n$_"
}

Write-Ok "Downloaded $exeName"

# ── run installer ─────────────────────────────────────────────────────────────

Write-Info 'Running installer...'
Write-Host '  (The Windows SmartScreen warning may appear — click "More info" then "Run anyway".)' -ForegroundColor DarkGray

Start-Process -FilePath $tmpPath -Wait

Remove-Item $tmpPath -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Tunnex $version installed successfully!" -ForegroundColor Green
Write-Host 'Launch it from the Start menu or your desktop shortcut.'
