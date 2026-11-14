# Installs the "MotionPilot" CEP extension (dev junction install).
# 1. Enables PlayerDebugMode so AE loads unsigned extensions.
# 2. Creates a junction from the Adobe CEP extensions folder to this repo,
#    so edits here take effect after an AE restart (no re-copying).
# Run:  powershell -ExecutionPolicy Bypass -File .\install.ps1

$ErrorActionPreference = 'Stop'

$src  = Join-Path $PSScriptRoot 'com.motionpilot'
$destRoot = Join-Path $env:APPDATA 'Adobe\CEP\extensions'
$dest = Join-Path $destRoot 'com.motionpilot'

if (-not (Test-Path (Join-Path $src 'CSXS\manifest.xml'))) {
    throw "Extension source not found at $src"
}

# PlayerDebugMode for every CSXS generation recent AE versions use
foreach ($v in 9..12) {
    $key = "HKCU:\SOFTWARE\Adobe\CSXS.$v"
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    Set-ItemProperty -Path $key -Name 'PlayerDebugMode' -Value '1' -Type String
    Write-Host "PlayerDebugMode=1  ->  CSXS.$v"
}

if (-not (Test-Path $destRoot)) {
    New-Item -ItemType Directory -Force -Path $destRoot | Out-Null
}

if (Test-Path $dest) {
    $existing = Get-Item $dest -Force
    if ($existing.LinkType -eq 'Junction') {
        # Remove-Item -Recurse on a junction can follow into the target; delete the link only.
        [System.IO.Directory]::Delete($dest, $false)
    } else {
        Remove-Item $dest -Recurse -Force -Confirm:$false
    }
}

New-Item -ItemType Junction -Path $dest -Target $src | Out-Null
Write-Host "Linked $dest"
Write-Host ""
Write-Host "Done. Restart After Effects, then open:  Window > Extensions > MotionPilot"
Write-Host "(The original Claude panel, if installed, keeps working side by side.)"

$claude = Get-Command claude -ErrorAction SilentlyContinue
if ($null -eq $claude) {
    Write-Warning "The 'claude' CLI was not found on PATH. The panel needs Claude Code installed:  npm install -g @anthropic-ai/claude-code"
} else {
    Write-Host "Claude CLI found: $($claude.Source)"
}
