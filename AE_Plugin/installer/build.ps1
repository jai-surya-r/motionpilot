# Builds a MotionPilot release:
#   dist\MotionPilot-<ver>.zxp            signed extension package (ZXPSignCmd, timestamped)
#   dist\MotionPilot-Setup-<ver>.exe      Inno Setup installer that installs the SIGNED files
#   dist\MotionPilot User Guide.html      offline copy of docs\GUIDE.md
#   dist\MotionPilot-<ver>-windows.zip    all of the above + LICENSE
#
# Run:  powershell -ExecutionPolicy Bypass -File AE_Plugin\installer\build.ps1
#
# Needs: Inno Setup 6 (installed per user via winget if missing), Python 3 (for the guide),
# and Adobe's ZXPSignCmd (downloaded from Adobe's official CEP-Resources repo if missing).
# The self-signed certificate and its password are created once and kept OUTSIDE the repo,
# in %USERPROFILE%\.motionpilot-signing (override with $env:MOTIONPILOT_SIGNING_DIR).
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$plugin = Split-Path $here -Parent
$repo = Split-Path $plugin -Parent
$src = Join-Path $plugin "com.motionpilot"
$manifest = Join-Path $src "CSXS\manifest.xml"
if (-not (Test-Path $manifest)) { throw "Panel source not found at $src" }
$version = ([xml](Get-Content $manifest -Raw)).ExtensionManifest.ExtensionBundleVersion
Write-Host "MotionPilot $version"

$dist = Join-Path $here "dist"
$work = Join-Path $here "build"
foreach ($d in @($dist, $work)) { if (Test-Path $d) { Remove-Item $d -Recurse -Force }; New-Item -ItemType Directory $d | Out-Null }

# ---- tools ----
$iscc = @("$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe") |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) {
  Write-Host "Inno Setup not found - installing for the current user via winget..."
  winget install -e --id JRSoftware.InnoSetup --scope user --silent --accept-package-agreements --accept-source-agreements | Out-Null
  $iscc = "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
  if (-not (Test-Path $iscc)) { throw "ISCC.exe still not found after install" }
}
$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) { $python = (Get-Command py -ErrorAction SilentlyContinue).Source }
if (-not $python) { throw "Python 3 is needed to build the user guide (https://python.org)" }

$signDir = if ($env:MOTIONPILOT_SIGNING_DIR) { $env:MOTIONPILOT_SIGNING_DIR } else { Join-Path $env:USERPROFILE ".motionpilot-signing" }
if (-not (Test-Path $signDir)) { New-Item -ItemType Directory $signDir | Out-Null }
$zxpSign = Join-Path $signDir "ZXPSignCmd.exe"
if (-not (Test-Path $zxpSign)) {
  Write-Host "Downloading ZXPSignCmd 4.1.103 (win64) from Adobe-CEP/CEP-Resources..."
  Invoke-WebRequest -UseBasicParsing -OutFile $zxpSign `
    "https://raw.githubusercontent.com/Adobe-CEP/CEP-Resources/master/ZXPSignCMD/4.1.103/win64/ZXPSignCmd.exe"
}
$cert = Join-Path $signDir "motionpilot.p12"
$passFile = Join-Path $signDir "motionpilot.pass"
if (-not (Test-Path $cert)) {
  $chars = [char[]]"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
  $pass = -join (1..24 | ForEach-Object { $chars | Get-Random })
  Set-Content -Path $passFile -Value $pass -NoNewline -Encoding ascii
  Write-Host "Creating the self-signed signing certificate (kept in $signDir)..."
  & $zxpSign -selfSignedCert US NA MotionPilot MotionPilot $pass $cert -validityDays 3650
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $cert)) { throw "ZXPSignCmd could not create the certificate" }
}
$pass = (Get-Content $passFile -Raw).Trim()

# ---- stage: exactly the files that ship (no .debug, no backups, no symlinks) ----
$stage = Join-Path $work "stage\com.motionpilot"
New-Item -ItemType Directory $stage -Force | Out-Null
Get-ChildItem $src -Force | Where-Object { $_.Name -ne ".debug" } | Copy-Item -Destination $stage -Recurse -Force
Get-ChildItem $stage -Recurse -Force | Where-Object { $_.Name -match '\.bak|\.log$|^\.DS_Store$|^Thumbs\.db$' } | Remove-Item -Force -Recurse
$links = Get-ChildItem $stage -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }
if ($links) { throw "Symlinks/junctions in the staged extension break ZXP signatures: $($links.FullName -join ', ')" }

# ---- sign + verify ----
$zxp = Join-Path $dist "MotionPilot-$version.zxp"
Write-Host "Signing..."
$tsa = @("http://timestamp.digicert.com", "http://timestamp.sectigo.com", "http://timestamp.globalsign.com/tsa/r6advanced1")
$signed = $false
foreach ($t in $tsa) {
  if (Test-Path $zxp) { Remove-Item $zxp -Force }
  & $zxpSign -sign $stage $zxp $cert $pass -tsa $t 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0 -and (Test-Path $zxp)) { $signed = $true; Write-Host "  signed, timestamped by $t"; break }
  Write-Host "  timestamp server $t unavailable to ZXPSignCmd (exit $LASTEXITCODE), trying the next one"
}
if (-not $signed) {
  # ZXPSignCmd 4.1.103 cannot use some modern TSAs (it crashes on DigiCert's). A timestamp only matters
  # once the certificate expires; the self-signed certificate is valid for 10 years.
  if (Test-Path $zxp) { Remove-Item $zxp -Force }
  & $zxpSign -sign $stage $zxp $cert $pass
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $zxp)) { throw "ZXPSignCmd -sign failed (exit $LASTEXITCODE)" }
  Write-Host "  signed without a timestamp (valid while the certificate is, until $((Get-Item $cert).CreationTime.AddDays(3650).ToString('yyyy-MM-dd')))"
}
& $zxpSign -verify $zxp -certinfo
if ($LASTEXITCODE -ne 0) { throw "Signature verification failed" }

# the installer ships the signed files exactly as they are inside the .zxp
$signedDir = Join-Path $work "signed\com.motionpilot"
$zipCopy = Join-Path $work "ext.zip"
Copy-Item $zxp $zipCopy
Expand-Archive $zipCopy -DestinationPath $signedDir -Force
if (-not (Test-Path (Join-Path $signedDir "META-INF\signatures.xml"))) { throw "signatures.xml missing from the signed package" }

# ---- guide ----
$guide = Join-Path $dist "MotionPilot User Guide.html"
& $python (Join-Path $here "md2html.py") (Join-Path $repo "docs\GUIDE.md") $guide
if ($LASTEXITCODE -ne 0) { throw "Guide conversion failed" }

# ---- installer ----
Write-Host "Compiling the installer..."
& $iscc /Q "/DAppVersion=$version" "/DSrcDir=$signedDir" "/DGuideFile=$guide" (Join-Path $here "setup.iss")
if ($LASTEXITCODE -ne 0) { throw "ISCC failed with exit code $LASTEXITCODE" }
$exe = Join-Path $dist "MotionPilot-Setup-$version.exe"

# ---- release zip ----
$zip = Join-Path $dist "MotionPilot-$version-windows.zip"
Compress-Archive -Path $exe, $zxp, $guide, (Join-Path $repo "LICENSE") -DestinationPath $zip
Remove-Item $work -Recurse -Force

Write-Host ""
Get-ChildItem $dist | ForEach-Object { Write-Host ("  {0,-42} {1,12:N0} bytes" -f $_.Name, $_.Length) }
