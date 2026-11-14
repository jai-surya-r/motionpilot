# Building a MotionPilot release

```powershell
powershell -ExecutionPolicy Bypass -File AE_Plugin\installer\build.ps1
```

Output in `AE_Plugin\installer\dist\`:

| File | What it is |
|---|---|
| `MotionPilot-<ver>.zxp` | The extension, signed with Adobe's ZXPSignCmd and timestamped. |
| `MotionPilot-Setup-<ver>.exe` | Per-user installer (no admin) that installs exactly the signed files. |
| `MotionPilot User Guide.html` | Offline copy of [`docs/GUIDE.md`](../../docs/GUIDE.md). |
| `MotionPilot-<ver>-windows.zip` | All of the above plus the LICENSE, for the GitHub release. |

The version comes from `ExtensionBundleVersion` in `com.motionpilot/CSXS/manifest.xml`.

## What the build does

1. **Stage** — copies `com.motionpilot` without `.debug`, backups or logs, and refuses to continue if it finds a symlink (symlinks break ZXP signatures).
2. **Sign** — signs the staged folder with ZXPSignCmd 4.1.103 using a self-signed certificate, timestamped (DigiCert, falling back to Sectigo / GlobalSign), then verifies the signature.
3. **Guide** — converts `docs/GUIDE.md` to a standalone HTML page (`md2html.py`, no dependencies).
4. **Installer** — compiles `setup.iss` with the signed files.
5. **Zip** — bundles the release.

Requirements: Inno Setup 6 (installed per user via winget if missing), Python 3, and internet access the first time (to download ZXPSignCmd from [Adobe-CEP/CEP-Resources](https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD)).

## Signing material

ZXPSignCmd, the certificate (`motionpilot.p12`) and its password are created once and kept in
`%USERPROFILE%\.motionpilot-signing` — never in the repository. Set `$env:MOTIONPILOT_SIGNING_DIR`
to use another folder. Keep that folder: releases signed with the same certificate can update each other.

A self-signed certificate is what Adobe's CEP tooling expects for extensions distributed outside
Adobe Exchange; After Effects verifies the package's integrity with it, so the panel loads without
Adobe's debug mode. The **Windows installer** itself is not Authenticode-signed (that needs a paid
code-signing certificate), so SmartScreen may show "Windows protected your PC" once — **More info → Run anyway**.

## What Setup does

1. Offers to close After Effects if it is running.
2. Options page: **Compatibility mode** (unticked) — sets Adobe's `PlayerDebugMode` for CSXS 9–13, only needed if a machine refuses the signature (Adobe's documented workaround for blank panels).
3. Checks each tool first. **Installed and signed in → its page is skipped** (the summary says "already installed and signed in"). Installed but signed out → its page only asks whether to sign in. Not installed → *Do you have Claude? / ChatGPT? / Higgsfield?* — on *Yes* it installs the CLI with `npm install -g …` and opens the sign-in window, without asking again.
4. Removes any previous install (or a developer junction — the link only, never its target) so no stale file breaks the signature, then installs to `%APPDATA%\Adobe\CEP\extensions\com.motionpilot`.
5. Checks Node.js and offers the download page if it is missing.
6. Installs the user guide to `%LOCALAPPDATA%\MotionPilot` with a Start-menu shortcut, and shows a summary.

The uninstaller lives in `%LOCALAPPDATA%\MotionPilot\uninstall` (not inside the extension folder, where any extra file would break the signature) and is registered in **Settings → Apps**.

Silent install: `MotionPilot-Setup-<ver>.exe /VERYSILENT /SUPPRESSMSGBOXES` (files only; Claude = yes, others = no, no sign-in windows). `/LOG="file"` writes a log.

## How the panel reacts to missing tools

| Tool | Not installed / signed out |
|---|---|
| Claude Code | Status dot hollow; sends are blocked until `claude auth login` (unless a Codex model is selected). |
| Codex (ChatGPT) | Codex models are absent from the Model menu; `generate_image` falls back to shapes/placeholders. |
| Higgsfield | The ✦ Gen pill is locked; Higgsfield commands are refused with a note to use web assets or vector shapes. |

Click a status dot after signing in to re-check.
