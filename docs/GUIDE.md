# MotionPilot — User Guide

MotionPilot is a panel for Adobe After Effects that lets an AI model build and animate
your compositions for you. You describe what you want in plain words; the model reads
your real comp, writes small ExtendScript steps, runs them in After Effects, renders
frames to check its own work, and fixes what it sees — all while you watch.

It runs on the AI tools you already have:

- **Claude** through the Claude Code CLI (Claude Pro / Max / Team, or an Anthropic API account), and/or
- **ChatGPT** through the Codex CLI (ChatGPT Plus / Pro / Team) — also used for image generation.

Everything happens on your computer. MotionPilot has no server, no account and no telemetry;
the only network traffic is what the Claude / Codex / Higgsfield tools themselves send.

---

## Contents

1. [Requirements](#1-requirements)
2. [Installing](#2-installing)
3. [First launch](#3-first-launch)
4. [The panel at a glance](#4-the-panel-at-a-glance)
5. [Task types](#5-task-types)
6. [Writing a good brief](#6-writing-a-good-brief)
7. [References: images, videos, documents](#7-references-images-videos-documents)
8. [The director's build spec](#8-the-directors-build-spec)
9. [Models and effort](#9-models-and-effort)
10. [Ask vs Auto, stopping, undo](#10-ask-vs-auto-stopping-undo)
11. [3D scenes and new After Effects features](#11-3d-scenes-and-new-after-effects-features)
12. [Images and generated assets](#12-images-and-generated-assets)
13. [Chats, history, Handbook and Compact](#13-chats-history-handbook-and-compact)
14. [Accounts](#14-accounts)
15. [Where files are stored](#15-where-files-are-stored)
16. [Troubleshooting](#16-troubleshooting)
17. [Uninstalling](#17-uninstalling)
18. [FAQ](#18-faq)

---

## 1. Requirements

| | |
|---|---|
| **After Effects** | 2019 (16.0) or newer — built for After Effects 2024 – 2027. Frame checking needs 2020+, the Recreate task needs 2024 (24.0)+. |
| **Operating system** | Windows 10 / 11 (64-bit) or macOS (Intel or Apple silicon). |
| **Node.js** | LTS version from [nodejs.org](https://nodejs.org). The panel's After Effects connector runs on it, and the AI tools install through `npm`. |
| **At least one AI tool** | Claude Code (`npm install -g @anthropic-ai/claude-code`) and/or the Codex CLI (`npm install -g @openai/codex`). |
| **Optional** | Higgsfield CLI (`npm install -g @higgsfield/cli`) for video, 3D and premium image models. |

On Windows the installer checks all of this for you and offers to install and sign in to each
tool. On a Mac you install the tools yourself (see *Option B* below).

## 2. Installing

### Option A — Setup (Windows, recommended)

1. Download **`MotionPilot-Setup-<version>.exe`** from the release.
2. Run it. No administrator rights are needed — it installs for your Windows user only.
   Windows may show *"Windows protected your PC"* because the installer is not code-signed
   by a commercial certificate: click **More info → Run anyway**.
3. If After Effects is open, Setup offers to close it.
4. Setup checks Claude Code, Codex (ChatGPT) and Higgsfield. Anything already installed **and**
   signed in is left alone — no questions. For the rest it asks **Do you have Claude? / ChatGPT? /
   Higgsfield?** (or, if a tool is installed but signed out, just whether to sign in). On *Yes* it
   installs the tool and opens a sign-in window (a browser tab opens; sign in there, then close the
   console window).
5. The last page shows a summary of every tool's state.

Start After Effects and open **Window → Extensions → MotionPilot**.

### Option B — ZXP package (macOS, or Windows without Setup)

The release also contains **`MotionPilot-<version>.zxp`**, the signed extension package. It works
on both macOS and Windows.

1. Quit After Effects.
2. Install the `.zxp` with a ZXP installer app, for example *ZXP/UXP Installer* (aescripts) or
   Anastasiy's Extension Manager.
3. Install [Node.js](https://nodejs.org) (LTS). On a Mac the `.pkg` installer or Homebrew
   (`brew install node`) both work.
4. In Terminal, install and sign in to at least one AI tool:
   ```bash
   npm install -g @anthropic-ai/claude-code && claude      # Claude
   npm install -g @openai/codex && codex login             # ChatGPT models
   ```
5. Start After Effects and open **Window → Extensions → MotionPilot**.

On a Mac the panel finds `node`, `claude` and `codex` through your login shell, so tools installed
with Homebrew, nvm, Volta or a custom npm prefix are picked up — just make sure they work in a new
Terminal window first.

### Option C — From source (developers)

Windows:

```powershell
git clone https://github.com/jai-surya-r/motionpilot.git
cd motionpilot
powershell -ExecutionPolicy Bypass -File .\AE_Plugin\install.ps1
```

This links the source folder into After Effects (edits apply after a panel reload) and turns on
Adobe's debug mode so the unsigned source loads.

macOS:

```bash
git clone https://github.com/jai-surya-r/motionpilot.git
mkdir -p ~/Library/Application\ Support/Adobe/CEP/extensions
ln -s "$PWD/motionpilot/AE_Plugin/com.motionpilot" ~/Library/Application\ Support/Adobe/CEP/extensions/com.motionpilot
for v in 9 10 11 12 13; do defaults write com.adobe.CSXS.$v PlayerDebugMode 1; done
```

## 3. First launch

When the panel opens it checks its tools. The top bar shows the two engines — the **Claude** logo
(Claude Code) and the **OpenAI** logo (ChatGPT through the Codex CLI) — each with a small status dot:

| Dot | Meaning |
|---|---|
| ● filled, bright logo | Signed in and ready |
| ○ hollow ring, dim logo | Not signed in or not installed — click the logo to re-check after fixing |
| grey | Not checked yet |

If something is missing, a bar at the top explains exactly what to run. You need at least one of
the two signed in to send a prompt.

An empty chat shows a few example briefs (*Kinetic title reveal*, *3D logo orbit*, *Polish my
easing*, *Recreate a reference*). Click one to drop it into the text box with the matching task
type selected, then edit it before sending.

## 4. The panel at a glance

**Top bar (left to right).** Hover any icon for its name.

| Control | What it does |
|---|---|
| Engine logos | Claude and ChatGPT sign-in status (§3). Click to re-check. |
| Context meter (`297k / 1M`) | How full the current chat's model memory is. Gets brighter and bold as it fills. |
| Compact (arrows pointing in) | Appears when a chat gets long: summarises it into a short brief and continues in a fresh session (see §13). |
| Undo last prompt (curved arrow) | Undoes everything the last prompt changed in After Effects. |
| Handbook (open book) | Writes a hand-over note for this chat (see §13). |
| Chat history (clock) | Your past chats — open, rename or delete. |
| Storage (disk) | Shows how much disk the panel's temp files use and clears them. |
| Accounts (two people) | Switch between signed-in Claude / ChatGPT accounts (see §14). |
| New chat (white pencil button) | Starts a fresh conversation. |

**Above the text box:** the task types (New, Edit, Stylize, Polish, Recreate, Other — §5).

**The text box:** type your brief. **Enter** sends, **Shift+Enter** starts a new line.
Paste, drag-and-drop or use **+** to attach references. The expand button (top-right of the box)
enlarges it; you can also drag its top edge.

**Bottom-left pills**

| Pill | What it does |
|---|---|
| **Model** | Which AI does the work (§9). Its icon shows the engine: the Claude logo or the OpenAI logo. |
| **Effort** (gauge) | How long the model thinks (§9). |
| **✦ Higgs** | Allows Higgsfield generations for this chat (§12). |
| **◫ Design** | For New tasks: the model first lays the frame out as an HTML/CSS design, then rebuilds it as After Effects layers. Good for layout-heavy pieces. |
| **Style** | Attaches one style pack to your *next* prompt only (UI Motion, Kinetic Type, Cutout Collage, Flat Scene, Data Editorial; in Stylize also the texture packs). |
| **Template** (grid icon) | Inserts a fill-in template for the selected task type. |

**Bottom-right:** **Ask / Auto** (§10, shield or lightning icon) and the round white **send** button,
which turns dark with a spinning ring and a **■ Stop** square while a run is active. A **✓ Finish**
button appears while busy: press it when the result is good enough — the model finishes its current
step, does one last check and stops.

## 5. Task types

Pick the type before you send; each one gives the model a different step-by-step plan.

| Task | Use it for | Example |
|---|---|---|
| **New** | Building something from scratch in the active (or a new) comp. | *"15-second product intro for a note-taking app, 1080×1920, dark background, three feature beats, logo end card."* |
| **Edit** | Changing existing layers — timing, layout, text, colours. | *"Make the headline enter 0.3 s later and slide in from the left instead of fading."* |
| **Stylize** | Adding a finish: grain, glow, print texture, depth blur, stickers. Layout and timing stay untouched. | *"Give the whole comp a soft risograph grain."* |
| **Polish** | Improving the motion quality of what is there: easing, overlap, follow-through, holds. | *"The cards feel robotic — polish the motion."* |
| **Recreate** | Rebuilding a reference video as editable layers. Attach the video. | *"Recreate this clip with our brand colours."* |
| **Other** | Questions and anything else; it can also just chat. | *"Why does my expression on layer 4 error?"* |

## 6. Writing a good brief

- **Say the numbers.** Duration, size, frame rate, how many items, exact text. The panel pulls
  every number out of your brief into a checklist the model must tick off at the end.
- **Name the parts.** "Title, three icons, a CTA button, logo end card" beats "a nice intro".
- **Describe the feel, not the keyframes.** "Snappy and confident, lots of empty space" is enough.
- **One change at a time** for Edit and Polish works better than a long list.
- Use the **template** button for a fill-in brief if you are unsure what to include.
- **New trends and unfamiliar looks are fine.** Whenever the model is unsure how to achieve
  something — a technique, transition, rig, a recent trend, or how your reference was made — it can
  research it on the web first: it describes what it sees in searchable words, tries a few
  searches, reads the most relevant tutorials or breakdowns, then rebuilds the method with native
  After Effects tools and tells you what it researched. It skips this for things it already knows.

## 7. References: images, videos, documents

Attach files with **+**, paste them, or drag them onto the panel.

- **Images** — in a New task a single still is treated as the design to build towards; in other
  tasks it shows the look you want for the changed part.
- **Videos** — before the model starts, the panel imports the video into the Bin (folder
  *Reference*), samples it, and makes timestamped contact sheets (24 frames each, imported into
  *Reference Sheets*). The model "watches" the video through these sheets plus a measured motion
  track, so timing and easing come out close to the original.
- **Documents** (txt, md, csv, json, html, pdf) — read for their content, e.g. a script or copy deck.

Click any thumbnail in the chat to see it full size.

## 8. The director's build spec

For short **New** briefs on the faster models, a *director* step runs first and shows you a
**build spec**: concept, layout, palette, beats and timing. You can:

- **Build this** — go ahead with the spec,
- add notes and **Rewrite** — the director revises it (repeat as often as you like),
- **Skip director** — build from your brief alone,
- **Cancel** — nothing is built.

Opus and Fable at medium effort or above plan their own builds and skip this step. A long,
detailed brief without references also goes straight to the builder.

## 9. Models and effort

The **Model** menu fills itself from the tools installed on your computer — you never have to
update it. It is grouped by provider and family: **Claude** first (Opus, Fable, Sonnet, Haiku — the
two newest models of each), then **ChatGPT** (the models your ChatGPT account offers through Codex,
grouped by family). If Codex isn't signed in, the ChatGPT section says how to add it. When Anthropic
or OpenAI release a new model, it appears as soon as your Claude Code / Codex CLI knows about it.

| Family | Best for |
|---|---|
| **Fable** | The hardest briefs and long builds. Slowest and most expensive. |
| **Opus** | Recommended default — heavy scenes, recreations. |
| **Sonnet** | Everyday builds, edits and polish; fast. |
| **Haiku** | Small tweaks and quick edits; fastest and cheapest. |
| **GPT (Codex)** | Same tools and workflow on your ChatGPT plan. |

**Effort** controls how long the model thinks. The menu only lists the levels the selected
model supports. Leave it blank for the model's default; use *Low* for small edits and
*High* or above for complex scenes and stubborn bugs. Higher effort uses your plan's limits faster.

## 10. Ask vs Auto, stopping, undo

- **Ask** — every script and shell command is shown in a bar at the bottom; nothing runs until you
  click **Run in AE** / **Allow**. Safest while you learn the panel.
- **Auto** — scripts and ordinary shell commands (downloading a reference image, converting a
  video, listing files) run immediately and are logged in the chat. A command still stops and asks,
  marked **⚠**, when it looks risky: deleting files, installing or removing software, changing
  system settings, the registry, services or permissions, closing programs, reading passwords or
  keys, uploading data, running downloaded code, or pushing to git. Paid generations always ask.
  (GPT models run their shell inside Codex's sandbox, limited to the panel's work folder.)
- **■ Stop** ends the run at once. **✓ Finish** asks the model to wrap up gracefully.
- Every script is **one undo step**: press **Ctrl+Z** in After Effects to step back through what
  the model did, or use **↶ Revert** to undo the whole last prompt.
- Before every send, the saved project (`.aep`) is copied to
  `Documents\MotionPilot\<project>\_checkpoints` (the last three are kept).

## 11. 3D scenes and new After Effects features

MotionPilot builds **real 3D** when your brief or reference calls for it — extruded logos and type,
products that turn, camera moves through space — using After Effects' **Advanced 3D** renderer.
Flat motion-design pieces stay 2D. Just describe the shot: *"Extrude our logo, metallic, slow 40° orbit
with shallow depth of field, soft studio lighting."*

What the model can use depends on your After Effects version; it checks this itself before any 3D work:

| Feature | After Effects |
|---|---|
| 3D layers, cameras with depth of field, point / spot / parallel / ambient lights with shadows, extruded text and shapes, bevels, materials (metal, reflection, specular…) | 2024+ (Advanced 3D) |
| Environment (image-based) lights from an HDRI | 24.3+ |
| Imported 3D models (glTF / GLB / OBJ) | 24.4+ |
| Any layer or precomp as an environment light source | 25.2+ |
| Variable-font axes, readable dropdown values | 26.0+ |
| Native parametric meshes — cube, sphere, cylinder, cone, torus, plane, with bevels; camera focus area | 26.3+ |
| Layer render-stage inputs, new guides API | 26.5+ |
| Layer and Substance (.sbsar) materials on 3D text, shapes and meshes | 27.0 (2027) |

**Newer than the panel?** The model can read any layer's full live property list (names, values,
dropdown choices) and set what it finds, so properties added in later After Effects versions are usable
without waiting for a MotionPilot update. For 2027's layer / Substance materials Adobe has not published a
scripting interface yet; the model tries the live properties and, if they are not scriptable, tells you
which material to pick by hand.

It can also search **every installed effect**, including third-party plug-ins and new built-in effects
such as 2027's Contour Paint, and use them by their exact internal name.

Tips: 3D renders are slower, so ask for single checks while building; keep one key light with shadows
plus one soft fill; ask for "25–45°" turns rather than full spins for product shots.

## 12. Images and generated assets

- When a design needs a picture that shapes and text can't make (an illustration, a product shot),
  the model can generate it with **GPT Image 2** through your Codex CLI. In Ask mode you approve
  each generation. The image is imported into an *AI Assets* folder next to your project.
- With **✦ Gen** on, the model may also use **Higgsfield** for video clips, 3D or premium image
  models. Every Higgsfield generation is shown with its model and prompt and always asks first —
  even in Auto mode — so you never spend credits by surprise.
- Without Codex or Higgsfield, the model builds elements from shapes and text, or uses assets you
  already imported into the Bin.

## 13. Chats, history, Handbook and Compact

- Each chat remembers its conversation; sending again continues where you left off.
- **History** lists past chats; reopening one continues it.
- **📖 Handbook** writes a short hand-over note for the chat: what is built (comps, layer names,
  timings, palette), your preferences and the next steps. Any fresh session of that chat reads it
  first, so switching model or account doesn't lose the thread.
- **🗜 Compact** summarises the chat so far and continues in a fresh session — use it when the
  context meter gets bright. It shows a card of what was kept.

## 14. Accounts

If you have more than one Claude Code or Codex login, **👥 Accounts** lists them and switches
between them. The button highlights while a non-default account is in use. Each account's chats
continue through its Handbook after a switch.

## 15. Where files are stored

| What | Where |
|---|---|
| The panel | `%APPDATA%\Adobe\CEP\extensions\com.motionpilot` |
| Chat sessions | the panel's CEP data folder (`…\com.motionpilot\sessions`) |
| Handbooks | `%APPDATA%\motionpilot\handbooks` |
| Temporary work files, run log | `%TEMP%\motionpilot` (`last-run.log` is the raw log of the last run) |
| Render cache, checkpoints, generated images | `Documents\MotionPilot` |

Use the **Cache** button to see and clear the temporary files.

## 16. Troubleshooting

| Problem | Fix |
|---|---|
| **MotionPilot is not in Window → Extensions** | Fully quit and restart After Effects. If it is still missing, run Setup again. |
| **The panel opens but is blank** | Run Setup again and tick **Compatibility mode** on the options page, then restart After Effects. |
| **"'claude' command not found" / Claude logo dim** | Install Claude Code (`npm install -g @anthropic-ai/claude-code`), run `claude` once in a terminal to sign in, then restart After Effects (it reads PATH at launch). |
| **OpenAI logo dim / ChatGPT models missing** | Run `codex login` in a terminal, then click the OpenAI logo. "Usage limit" messages come from your ChatGPT plan and reset over time. |
| **"The AE connector … did not come up"** | Node.js is missing or not on PATH. Install Node.js LTS and restart After Effects. |
| **Frame checks fail** | Rendering frames needs After Effects 2020 or newer; the model still works without them. |
| **Something else went wrong** | Open `%TEMP%\motionpilot\last-run.log` — it contains the full output of the last run. Include it when you report an issue on GitHub. |

## 17. Uninstalling

**Settings → Apps → Installed apps → MotionPilot → Uninstall.** This removes the panel and its
user-guide shortcut (the optional compatibility setting is left in place, since other panels may use it). Your chats, Handbooks and the render cache stay; delete
`%APPDATA%\motionpilot` and `Documents\MotionPilot` to remove them too.

**macOS:** remove the extension in your ZXP installer app (or delete
`~/Library/Application Support/Adobe/CEP/extensions/com.motionpilot`). Your chats and cache live in
`~/Library/Application Support/motionpilot` and `~/Documents/MotionPilot`.

## 18. FAQ

**Is it free?** MotionPilot is free and open source (MIT). The AI usage counts against your own
Claude / ChatGPT / Higgsfield plans.

**Does my project leave my computer?** MotionPilot sends nothing anywhere. The model receives
your prompt, the comp description it reads, rendered preview frames and your references — through
the Claude Code / Codex tools, under their own privacy terms.

**Can it break my project?** Every step is undoable, the project is checkpointed before every
send, and in Ask mode nothing runs without your click.

**Which After Effects versions are supported?** 2019 and newer, through After Effects 2027. Newer versions get
the most features (frame checks from 2020, Recreate and Advanced 3D from 2024, parametric meshes from 26.3 — see §11).
