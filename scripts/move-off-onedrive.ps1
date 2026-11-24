# Moves Agent Buddy out of OneDrive to avoid Electron unpack corruption.
# Default destination: C:\dev\agent-buddy
# Usage (from the project root, in PowerShell):
#   .\scripts\move-off-onedrive.ps1
#   .\scripts\move-off-onedrive.ps1 -Dest "D:\code\agent-buddy"

param(
  [string]$Dest = "C:\dev\agent-buddy"
)

$ErrorActionPreference = "Stop"
$src = Resolve-Path (Join-Path $PSScriptRoot "..")

if ($src.Path -eq (Resolve-Path $Dest -ErrorAction SilentlyContinue)) {
  Write-Host "Already at $Dest"
  exit 0
}

Write-Host "Source: $src"
Write-Host "Dest:   $Dest"
Write-Host "Close Agent Buddy / Electron / Cursor terminals using this folder first."
$confirm = Read-Host "Type YES to copy (then you can delete the OneDrive copy)"
if ($confirm -ne "YES") {
  Write-Host "Aborted."
  exit 1
}

New-Item -ItemType Directory -Force -Path (Split-Path $Dest) | Out-Null
if (Test-Path $Dest) {
  Write-Host "Destination already exists. Aborting to avoid overwrite."
  exit 1
}

# Prefer robocopy so OneDrive locks are less painful; exclude heavy/generated trees we can rebuild.
robocopy $src $Dest /E /XD node_modules dist .git /NFL /NDL /NJH /NJS
if ($LASTEXITCODE -ge 8) { throw "robocopy failed with code $LASTEXITCODE" }

# Copy .git separately if present (keeps history).
if (Test-Path (Join-Path $src ".git")) {
  robocopy (Join-Path $src ".git") (Join-Path $Dest ".git") /E /NFL /NDL /NJH /NJS
}

Write-Host ""
Write-Host "Copied. Next:"
Write-Host "  cd `"$Dest`""
Write-Host "  npm install"
Write-Host "  npm start"
Write-Host "Then open the new folder in Cursor and (optional) remove the OneDrive copy."
