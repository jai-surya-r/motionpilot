# MotionPilot

A CEP panel that puts an AI motion designer inside Adobe After Effects. You type
a brief; Claude (through Claude Code) or a GPT model (through the Codex CLI)
works **live in your comp** over a local connector instead of guessing a script:

- **`get_state`** — read the real comp (layers, transforms, keyframes, easing,
  effects, text, Bin assets),
- **`run_script`** — build in small ExtendScript steps, one undo group each, with
  AE errors fed straight back for self-correction,
- **`render_frame`** — render preview frames (or one labelled proof sheet) and look at them,
- **Research when unsure** — when the model doesn't know how to achieve part of a brief or how a reference was
  made (often a recent trend from a new tutorial), it searches the web, reads the best tutorials or breakdowns
  (Claude Code's WebSearch / WebFetch, Codex's web search) and rebuilds the method natively,
- **`get_skill`** — load the `moves` library, the `flow` (transitions / pacing) kit,
  the design doctrine (`animation-principles`), the effects catalogue, a style
  pack (`ui-motion`, `kinetic-type`, `cutout-collage`, `flat-scene`,
  `data-editorial`) or a Stylize texture pack (`grain-print`, `soft-glow`,
  `depth-blur`, `hard-sticker`, `grain-gradient`) on demand,
- **Real 3D** — Advanced 3D renderer, extruded text and shapes, parametric meshes (26.3+), imported
  glTF / GLB / OBJ models, cameras with depth of field, lights with shadows, HDRI environment lights,
  materials (`get_skill("3d")`, `AE.mesh`, `AE.model3D`, `AE.camera3D`, `AE.envLight` …),
- **`ae_info`** — what this After Effects version can do (renderers, 3D features, newer APIs) and a search of
  every installed effect, third-party plug-ins included,
- **`inspect_properties`** — any layer's live property tree, so properties added in newer After Effects
  versions (through 2027) can be found and set without a panel update,
- **`generate_image`** — GPT Image 2 (through the Codex CLI) for pictorial assets
  shapes and text can't make; Ask mode approves each call.

The `AE.*` helper library (`jsx/aekit.jsx`) is preloaded in AE so scripts stay
short and no keyframe is left linear.

**Fully local.** No server, account, telemetry or update check. All prompts and
skills live in [`brain/bundle.json`](AE_Plugin/com.motionpilot/brain/bundle.json)
and are read from disk — edit it to change behaviour (it must stay valid JSON with
at least `v`, `pre` and `steps`); changes apply on the next panel reload.

## Requirements

- Windows 10 / 11 or macOS, After Effects 2019 or newer (built for 2024 – 2027)
- [Node.js](https://nodejs.org) (runs the connector `mcp/ae-mcp.js`)
- At least one engine:
  - [Claude Code](https://docs.anthropic.com/claude-code) — `npm install -g @anthropic-ai/claude-code`, run `claude` once to sign in
  - Codex CLI — `npm install -g @openai/codex`, then `codex login` (needed for the GPT models and `generate_image`)
- Optional: the Higgsfield CLI (`npm i -g @higgsfield/cli`, `higgsfield auth login`) for the ✦ Gen toggle (video / 3D / premium image models)

## Install

**Users:** download the latest release from the [Releases page](https://github.com/jai-surya-r/motionpilot/releases):

- `MotionPilot-Setup-<version>.exe` — installs the signed panel for your Windows user (no admin),
  checks Node.js, and offers to install and sign in to Claude Code / Codex / Higgsfield.
- `MotionPilot-<version>.zxp` — the signed extension package for ZXP installers. **On a Mac, use this** (with a ZXP
  installer app), then install Node.js and Claude Code / Codex yourself — the [User Guide](docs/GUIDE.md#2-installing) has the steps.

Then open **Window → Extensions → MotionPilot** in After Effects.
The **[User Guide](docs/GUIDE.md)** walks through everything from installation to troubleshooting.

**Developers:** link the source folder into After Effects (edits apply after a panel reload):

```powershell
powershell -ExecutionPolicy Bypass -File .\AE_Plugin\install.ps1
```

Build a signed release (ZXP + installer + offline guide) with
`AE_Plugin\installer\build.ps1` — see [`installer/README.md`](AE_Plugin/installer/README.md).

## Using it

1. Open a composition.
2. Pick a task type: **New / Edit / Stylize / Polish / Recreate / Other** — each ships its own step rail. ≡ inserts a fill-in template.
3. Type a prompt (**Enter** sends, **Shift+Enter** new line). Paste, drop or **+**-attach images, videos and documents as references. Videos are turned into timestamped contact sheets before the first model call.
4. Bottom-left pills:
   - **Model** — filled in from your installed CLIs and grouped by provider and family: **Claude** (Opus, Fable, Sonnet, Haiku — the
     two newest of each, from Claude Code's cached model catalog), then **ChatGPT** (the models your Codex account offers,
     `codex debug models`). The pill shows the engine's logo. Nothing to update by hand — new models appear once the CLI knows
     them. Before Claude Code has cached a catalog, the menu shows the `opus` / `sonnet` / `haiku` aliases.
   - **Effort** — only the levels the selected model supports (from the same catalogs).
   - **✦ Gen** — allow Higgsfield generations (always asks first).
   - **◫ Design** — HTML/CSS layout pass before AE layers (New tasks).
   - **Style** — attach a style pack to the next prompt only.
5. Bottom-right: **Ask** (approve every script and shell command) or **Auto** (scripts and shell commands run immediately; a
   built-in check still asks before risky commands — deleting files, installs, system/registry changes, credentials, uploads,
   downloaded code, git pushes — and before paid generations). ■ stops a run; ✓ Finish asks it to finish the current step and stop.
6. Short **New** briefs on smaller models go through a director pass first (Haiku, or Sonnet when references are attached); approve, annotate, skip or cancel the spec. Opus and Fable models at medium effort or above plan their own builds.
7. Top bar: Claude / OpenAI sign-in status, context meter, compact, undo last prompt, Handbook (hand-over note for the chat),
   chat history, storage (cache manager), accounts (switch between signed-in Claude Code / Codex config folders), new chat.
   Every icon shows its name on hover.

Every `run_script` is its own undo group (Ctrl+Z steps back through the run), and
the saved `.aep` is checkpointed on every send (3 kept) in
`Documents\MotionPilot\<project>\_checkpoints`.

## How it works

```
panel (HTML/JS, Node enabled)
  ├─ hosts a localhost HTTP bridge (random port, per-session token)
  ├─ writes %TEMP%\motionpilot\mcp-config.json pointing at mcp/ae-mcp.js
  ├─ loads jsx/bridge.jsx + jsx/aekit.jsx into AE
  ├─ builds the prompt from brain/bundle.json + task mode + toggles + refs
  └─ spawns  claude -p --output-format stream-json --mcp-config … --permission-prompt-tool mcp__ae__approve …
         or  codex exec --json -c mcp_servers.ae.… (GPT models)

model ── ae get_state / run_script / render_frame / get_skill / generate_image ──► panel bridge ──► After Effects
```

Ask mode gates every `run_script` in the panel for both engines. Any other tool
(Bash, Skill, …) goes through the `approve` gate.

## Files

```
AE_Plugin/
  install.ps1                dev install (junction + PlayerDebugMode)
  installer/                 Inno Setup installer script + build script
  com.motionpilot/
    CSXS/manifest.xml        CEP manifest (extension id com.motionpilot, AE 13+)
    .debug                   CEP remote-debug port (8093)
    index.html, css/, js/    panel UI and logic (js/main.js; js/icons.js = inline SVG icons)
    img/mark.svg             MotionPilot logo
    jsx/bridge.jsx           ExtendScript side of the bridge ($._motionPilot)
    jsx/aekit.jsx            AE.* helper library
    mcp/ae-mcp.js            stdio MCP connector the CLIs talk to
    brain/bundle.json        all prompts, rules and skills
docs/GUIDE.md                user guide
```

## Troubleshooting

- **Panel missing from Window → Extensions** — rerun `install.ps1`, fully restart AE.
- **"'claude' command not found"** — install Claude Code globally and restart AE (AE inherits PATH at launch).
- **Blank panel / debugging** — open `http://localhost:8093` while AE runs for the panel's DevTools.
- **"The AE connector … did not come up"** — Node.js not found or `mcp/ae-mcp.js` couldn't start; check `%TEMP%\motionpilot\mcp-config.json` and `last-run.log`.
- **"couldn't load its local brain file"** — `brain/bundle.json` is missing or invalid JSON.
- **GPT model / `generate_image` says Codex isn't ready** — run `codex --version` and `codex login status`; "usage limit" errors come from the ChatGPT plan.
- **`render_frame` fails** — needs AE 2020+ (Recreate needs AE 24+).
- Raw CLI output of the last run: `%TEMP%\motionpilot\last-run.log`.

## License

MIT — see [LICENSE](LICENSE).

The Claude and OpenAI marks used to label the engines come from [Simple Icons](https://simpleicons.org) (CC0);
they are trademarks of Anthropic and OpenAI. MotionPilot is an independent project, not affiliated with Adobe,
Anthropic or OpenAI.
