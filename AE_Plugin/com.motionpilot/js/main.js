/* MotionPilot — panel logic.
 *
 * Pipeline: prompt (+ optional image/video refs) -> OS shell (PowerShell on
 * Windows, login zsh/bash on macOS) -> `claude -p` or `codex exec`, with a
 * live MCP connector back into After Effects. The panel hosts a localhost
 * HTTP endpoint; mcp/ae-mcp.js (started by the CLI) forwards the model's
 * tool calls to it:
 *   get_state / run_script / render_frame / get_skill / generate_image /
 *   ae_info / inspect_properties
 * Ask mode gates every run_script behind the permission bar; Auto runs them
 * immediately. If the connector is unavailable, a single ```jsx script in the
 * reply still works as a fallback.
 *
 * There is no timeout on runs. The send button turns into a stop button while
 * a run is active, and every raw stream line is written to
 * %TEMP%\motionpilot\last-run.log for troubleshooting.
 */

(function () {
  "use strict";

  // Engines: Claude models -> `claude -p`; Codex (GPT) models ->
  // `codex exec --json` with the same ae MCP connector. The model list is
  // read from the installed CLIs at runtime (see "model catalog").
  // generate_image: GPT Image 2 (via codex) for pictorial assets.

  var csInterface = new CSInterface();

  var req = (typeof cep_node !== "undefined" && cep_node.require) ? cep_node.require : (typeof require !== "undefined" ? require : null);
  if (!req) {
    document.body.innerHTML = '<p style="padding:16px;color:#ededed">Node.js is disabled for this panel. Reinstall MotionPilot and restart After Effects.</p>';
    return;
  }

  var cp = req("child_process");
  var fs = req("fs");
  var path = req("path");
  var os = req("os");
  var Buffer = req("buffer").Buffer;
  var http = null;
  try { http = req("http"); } catch (e) { } // connector is optional; panel must never die for it

  var WORK_DIR = path.join(os.tmpdir(), "motionpilot");
  var REFS_DIR = path.join(WORK_DIR, "refs");
  var LOG_FILE = path.join(WORK_DIR, "last-run.log");

  var IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff"];
  var VIDEO_EXT = ["mp4", "mov", "avi", "mkv", "webm", "m4v", "mpg", "mpeg"];
  var DOC_EXT = ["pdf", "txt", "md", "csv", "json", "html", "rtf"]; // readable briefs/specs — Claude Reads them

  var MAX_AUTO_RETRIES = 2;
  var MAX_COPY_BYTES = 300 * 1024 * 1024;

  // ---------- OS shim ----------
  // One flag + a few helpers make the panel run identically on Windows and
  // macOS. Windows keeps its exact PowerShell pipeline; macOS gets a login
  // shell (so the user's PATH — homebrew/nvm node, npm global bin — is there).
  var IS_MAC = false;
  try { IS_MAC = os.platform() === "darwin"; } catch (e) { }
  var MAC_SHELL = "/bin/zsh";
  try { if (IS_MAC && !fs.existsSync(MAC_SHELL)) MAC_SHELL = "/bin/bash"; } catch (e) { }
  /* `zsh -l -c` reads ~/.zprofile but NOT ~/.zshrc — and nvm/npm/claude
   * installers put their PATH lines in .zshrc, so Terminal finds `claude`
   * while the panel doesn't. Prepend every install location that exists. */
  var MAC_PATHS = "";
  if (IS_MAC) {
    try {
      var mpHome = os.homedir();
      var mpDirs = [
        "/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin",
        path.join(mpHome, ".local", "bin"),
        path.join(mpHome, ".npm-global", "bin"),
        path.join(mpHome, ".claude", "local"),
        path.join(mpHome, ".volta", "bin"),
        path.join(mpHome, ".asdf", "shims")
      ];
      try {
        var mpNvm = path.join(mpHome, ".nvm", "versions", "node");
        var mpVs = fs.readdirSync(mpNvm).sort();
        if (mpVs.length) mpDirs.push(path.join(mpNvm, mpVs[mpVs.length - 1], "bin"));
      } catch (e2) { }
      var mpFound = [];
      for (var mpI = 0; mpI < mpDirs.length; mpI++) {
        try { if (fs.existsSync(mpDirs[mpI])) mpFound.push(mpDirs[mpI]); } catch (e3) { }
      }
      if (mpFound.length) MAC_PATHS = 'export PATH="' + mpFound.join(":") + ':$PATH"; ';
    } catch (e) { }
  }
  var SHELL_NAME = IS_MAC ? "the shell" : "PowerShell";
  function shQuote(p) { return "'" + String(p).replace(/'/g, "'\\''") + "'"; }
  function cliQuote(p) { return IS_MAC ? shQuote(p) : psQuote(p); }
  /* file:// URL that renders in the panel on both OSes
   * (C:/… needs three slashes; /Users/… must not get four). */
  function fileUrl(p) {
    p = String(p).replace(/\\/g, "/");
    if (p.charAt(0) === "/") p = p.slice(1);
    return "file:///" + p;
  }
  /* Spawn `<promptFile> | claude <flags>` through the OS shell. */
  function spawnClaude(promptFile, flagsJoined, cwd, withMcpEnv) {
    if (IS_MAC) {
      var cmd = MAC_PATHS +
        (withMcpEnv ? "export MCP_TOOL_TIMEOUT=600000 MCP_TIMEOUT=30000; " : "") +
        "cat " + shQuote(promptFile) + " | claude " + flagsJoined;
      return cp.spawn(MAC_SHELL, ["-l", "-c", cmd], { cwd: cwd, detached: true, env: acctEnv("claude") });
    }
    var psCommand =
      "$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
      (withMcpEnv ? "$env:MCP_TOOL_TIMEOUT = '600000'; $env:MCP_TIMEOUT = '30000'; " : "") +
      "Get-Content -LiteralPath " + psQuote(promptFile) + " -Raw | claude " + flagsJoined;
    return cp.spawn("powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psCommand],
      { cwd: cwd, windowsHide: true, env: acctEnv("claude") });
  }
  /* Kill a run and everything it spawned. Mac spawns are detached (their own
   * process group), so a negative-pid kill takes the whole tree. */
  function killRunTree(child) {
    var pid = child && child.pid;
    if (!pid) return;
    if (IS_MAC) {
      try { cp.exec("kill -9 -" + pid + " 2>/dev/null || kill -9 " + pid); } catch (e) { }
    } else {
      try { cp.exec("taskkill /PID " + pid + " /T /F"); } catch (e) { }
    }
  }

  /* Spawn the Codex CLI (GPT engine) with an ARGUMENT ARRAY. The -c config
   * overrides carry quotes, braces and paths with spaces, which PowerShell
   * mangles on the way to a native exe — so Windows spawns codex.exe
   * directly (Node quotes argv correctly) and the prompt is written to stdin.
   * Mac goes through the login shell so PATH is right, with "$@" forwarding. */
  function spawnCodex(args, cwd) {
    var child;
    if (IS_MAC) {
      child = cp.spawn(MAC_SHELL, ["-l", "-c", MAC_PATHS + 'exec codex "$@"', "codex"].concat(args),
        { cwd: cwd, detached: true, env: acctEnv("codex") });
    } else {
      child = cp.spawn(CODEX_BIN || "codex", CODEX_PRE.concat(args), { cwd: cwd, windowsHide: true, shell: !CODEX_BIN, env: acctEnv("codex") });
    }
    return child;
  }

  // ---------- accounts (several Claude / Codex logins) ----------
  // Each CLI keeps one login per config folder in the home folder:
  //   Claude Code → ~/.claude (default, profile in ~/.claude.json) or ~/.claude-<name> used as CLAUDE_CONFIG_DIR
  //   Codex       → ~/.codex (default) or ~/.codex-<name> used as CODEX_HOME (login in <folder>/auth.json)
  // An account is its folder path ("" = the CLI's default). Running with another account = setting that env
  // var for the spawn. CLI sessions belong to the account that made them (see syncAccount).
  var ACCT_ENV = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" };
  var ACCT_BASE = { claude: ".claude", codex: ".codex" };
  var PROVIDER_NAME = { claude: "Claude", codex: "ChatGPT (Codex)" };
  function readJsonFile(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; } }
  function acctTag(provider, folder) {
    if (!folder) return "default";
    return path.basename(folder).slice(ACCT_BASE[provider].length).replace(/^[-_. ]+/, "") || "default";
  }
  function jwtEmail(tok) {
    try {
      var p = String(tok).split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      return JSON.parse(Buffer.from(p, "base64").toString("utf8")).email || "";
    } catch (e) { return ""; }
  }
  /* Signed-in accounts for a provider, the default folder first: [{ folder, email, label }]. */
  function listAccounts(provider) {
    var home = os.homedir(), base = ACCT_BASE[provider], names = [], out = [];
    try {
      names = fs.readdirSync(home).filter(function (n) { return n.indexOf(base + "-") === 0 || n.indexOf(base + "_") === 0; }).sort();
    } catch (e) { }
    [base].concat(names).forEach(function (n) {
      var dir = path.join(home, n), isDef = n === base, email = "";
      try { if (!fs.statSync(dir).isDirectory()) return; } catch (e) { return; }
      if (provider === "claude") {
        var j = readJsonFile(isDef ? path.join(home, ".claude.json") : path.join(dir, ".claude.json"));
        if (!isDef && !j) return;
        email = ((j || {}).oauthAccount || {}).emailAddress || "";
        // macOS keeps the token in the Keychain, so a profile email is the sign-in test there.
        if (!email && !fs.existsSync(path.join(dir, ".credentials.json"))) return;
      } else {
        var a = readJsonFile(path.join(dir, "auth.json"));
        if (!a) return;
        email = jwtEmail((a.tokens || {}).id_token) || (a.OPENAI_API_KEY ? "API key" : "");
      }
      out.push({ folder: isDef ? "" : dir, email: email, label: acctTag(provider, isDef ? "" : dir) });
    });
    return out;
  }
  /* Folder of the account picked in the panel ("" = default). A folder that vanished falls back to default. */
  function selectedAccount(provider) {
    var f = "";
    try { f = localStorage.getItem("mp-account-" + provider) || ""; } catch (e) { }
    if (f) { try { if (!fs.statSync(f).isDirectory()) f = ""; } catch (e) { f = ""; } }
    return f;
  }
  function describeAccount(provider, folder) {
    folder = folder === undefined ? selectedAccount(provider) : folder;
    var all = listAccounts(provider);
    for (var i = 0; i < all.length; i++) {
      if (all[i].folder === folder) return all[i].email ? all[i].label + " · " + all[i].email : all[i].label;
    }
    return acctTag(provider, folder);
  }
  /* The environment a CLI spawn runs with: pointed at the selected account. */
  function acctEnv(provider) {
    var env = {};
    for (var k in process.env) env[k] = process.env[k];
    var f = selectedAccount(provider);
    if (f) env[ACCT_ENV[provider]] = f;
    else delete env[ACCT_ENV[provider]];
    return env;
  }
  /* Config folder of the selected Claude account (where its .credentials.json lives). */
  function claudeDir() {
    return selectedAccount("claude") || path.join(os.homedir(), ".claude");
  }

  // ---------- local brain + build info ----------
  // All prompt material (rails, rulebook, catalogs, skills) lives in
  // brain/bundle.json next to the panel and is read from disk.
  // Stamped into run logs and connector diagnostics so an error report
  // always says WHICH panel build produced it.
  var PANEL_BUILD = "20261114.1";
  var CLAUDE_VER = ""; // filled by the startup health probe, shown in diagnostics
  var CODEX_VER = "";  // Codex CLI version (GPT engine), same probe
  var CODEX_BIN = "";  // resolved codex executable (spawned directly — no shell quoting of -c overrides)
  var CODEX_PRE = [];  // leading args when CODEX_BIN is node running the npm package's launcher
  var BRAIN = null;
  // Local config folder (chat Handbooks live here).
  var CFG_DIR = IS_MAC
    ? path.join(os.homedir(), "Library", "Application Support", "motionpilot")
    : path.join(os.homedir(), "AppData", "Roaming", "motionpilot");

  /* Load brain/bundle.json once. cb(ok, why) — why is a user-facing message. */
  function fetchBrain(cb) {
    if (BRAIN) { cb(true); return; }
    try {
      var root = EXT_ROOT;
      if (!root) { try { root = csInterface.getSystemPath(SystemPath.EXTENSION); } catch (e0) { } }
      var b = JSON.parse(fs.readFileSync(path.join(root, "brain", "bundle.json"), "utf8"));
      if (b && b.v && b.pre && b.steps) { BRAIN = b; cb(true); return; }
      cb(false, "brain\\bundle.json is missing required keys — restore it from a good copy.");
    } catch (e) {
      cb(false, "Couldn't read brain\\bundle.json: " + e.message);
    }
  }
  function ensureBrain(cb) {
    if (BRAIN) { cb(true); return; }
    fetchBrain(cb);
  }
  // ---------- engines + model catalog ----------
  // Claude models run through `claude -p`; Codex models through `codex exec`.
  // Both get the SAME prompt, the same ae MCP tools and the same panel gates.
  // The Model menu is NOT hard-coded: it is read from the installed CLIs —
  //   Claude Code: the model catalog it caches in <config dir>/cache/model-catalog/*.json
  //   Codex:       `codex debug models` (falls back to <CODEX_HOME>/models_cache.json)
  // and shows the newest PER_FAMILY models of each family. Efforts and context
  // windows come from the same catalogs.
  var MODELS = {};        // id -> { id, name, engine: "claude"|"codex", family, efforts: [] | null, def, ctx, prio }
  var claudeModels = [];  // everything the Claude catalog lists
  var codexModels = [];   // everything Codex lists as visible
  var codexLoaded = false;
  var PER_FAMILY = 2;
  var CLAUDE_FAMILY_ORDER = ["opus", "fable", "sonnet", "haiku"];
  var DEFAULT_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
  var CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
  var ROOMY_FAMILIES = { opus: 1, fable: 1 };
  // Used only when Claude Code has not cached a catalog yet: the CLI resolves
  // these aliases to the newest model of each family itself.
  var CLAUDE_ALIASES = [
    { id: "opus", name: "Opus (latest)", engine: "claude", family: "opus", efforts: DEFAULT_EFFORTS, def: "", ctx: 0 },
    { id: "sonnet", name: "Sonnet (latest)", engine: "claude", family: "sonnet", efforts: DEFAULT_EFFORTS, def: "", ctx: 0 },
    { id: "haiku", name: "Haiku (latest)", engine: "claude", family: "haiku", efforts: DEFAULT_EFFORTS, def: "", ctx: 0 }
  ];
  var FAMILY_DESC = {
    fable: "Top capability — demanding briefs, long builds, tough recreations. Plans its own New builds at medium effort or above. Slowest, priciest.",
    opus: "Recommended default — strong on heavy scenes. Plans its own New builds at medium effort or above; Low keeps the guided rails.",
    sonnet: "Fast and capable — everyday builds, edits, polish.",
    haiku: "Fastest and cheapest — small tweaks and quick edits only."
  };
  var MODEL_DESCS = { "": "Whatever model your Claude Code CLI is set to." }; // filled per model by rebuildModelMenu()
  function familyLabel(m) {
    var f = String(m.family || "");
    if (m.engine === "codex") return f.toLowerCase() === "gpt" ? "GPT" : f.charAt(0).toUpperCase() + f.slice(1);
    return f.charAt(0).toUpperCase() + f.slice(1);
  }
  var VENDORS = {
    claude: { name: "Claude", via: "via Claude Code", icon: "claude" },
    codex: { name: "ChatGPT", via: "via Codex CLI · your ChatGPT plan", icon: "openai" }
  };
  var CODEX_FAMILY_DESC = "Runs the same After Effects tools; image assets via GPT Image 2.";

  function isGptModel(id) {
    var m = MODELS[id];
    if (m) return m.engine === "codex";
    return !!id && !/^claude-|^(opus|sonnet|haiku|fable)$/i.test(String(id));
  }
  function curEngine() { return isGptModel(modelEl.value) ? "codex" : "claude"; }
  function engineName() { return curEngine() === "codex" ? "GPT" : "Claude"; }
  function viewTool() { return curEngine() === "codex" ? "view_image" : "Read"; }
  function effortAllowed(v) {
    if (!v) return true;
    var m = MODELS[modelEl.value];
    if (m) return !!(m.efforts && m.efforts.indexOf(v) !== -1);
    return (curEngine() === "codex" ? CODEX_EFFORTS : DEFAULT_EFFORTS).indexOf(v) !== -1;
  }
  function familyOf(id) {
    if (MODELS[id]) return MODELS[id].family;
    var m = /^claude-([a-z]+)/.exec(String(id || ""));
    return m ? m[1] : String(id || "");
  }
  // Version numbers in an id, newest first when compared (date stamps like 20251001 are ignored).
  function verKey(id) {
    return (String(id).match(/\d+/g) || []).filter(function (n) { return n.length < 6; }).map(Number);
  }
  function cmpVerDesc(a, b) {
    var x = verKey(a), y = verKey(b);
    for (var i = 0; i < Math.max(x.length, y.length); i++) {
      var d = (y[i] || 0) - (x[i] || 0);
      if (d) return d;
    }
    return 0;
  }
  function verAtLeast(have, need) {
    var a = String(have || "").match(/\d+/g), b = String(need || "").match(/\d+/g);
    if (!a || !b) return true; // unknown CLI version: don't hide anything
    for (var i = 0; i < Math.max(a.length, b.length); i++) {
      var d = (Number(a[i]) || 0) - (Number(b[i]) || 0);
      if (d) return d > 0;
    }
    return true;
  }
  function currentClaudeOrg() {
    var sel = selectedAccount("claude");
    var cfg = readJsonFile(sel ? path.join(sel, ".claude.json") : path.join(os.homedir(), ".claude.json"));
    return (cfg && cfg.oauthAccount && cfg.oauthAccount.organizationUuid) || "";
  }
  function readClaudeCatalog() {
    var dir = path.join(claudeDir(), "cache", "model-catalog"), best = null, bestOrg = null, org = currentClaudeOrg();
    try {
      fs.readdirSync(dir).forEach(function (f) {
        if (!/\.json$/i.test(f)) return;
        var o = readJsonFile(path.join(dir, f));
        if (!(o && o.catalog && o.catalog.config && o.catalog.config.models && o.catalog.config.models.length)) return;
        if (!best || (o.fetchedAt || 0) > (best.fetchedAt || 0)) best = o;
        var mine = org && (o.organizationUuid === org || f.indexOf(org) === 0);
        if (mine && (!bestOrg || (o.fetchedAt || 0) > (bestOrg.fetchedAt || 0))) bestOrg = o;
      });
    } catch (e) { }
    best = bestOrg || best;
    var out = [];
    (best ? best.catalog.config.models : []).forEach(function (m) {
      if (!m || !m.id || !/^claude-/.test(m.id)) return;
      if (m.min_claude_code_version && CLAUDE_VER && !verAtLeast(CLAUDE_VER, m.min_claude_code_version)) return;
      var rt = m.runtime || {};
      var eff = rt.effort_levels || ((m.thinking && m.thinking.effort_options) ? m.thinking.effort_options.map(function (o) { return o.id; }) : null);
      out.push({
        id: m.id, name: m.name || m.id, engine: "claude",
        family: rt.family || familyOf(m.id),
        efforts: (eff && eff.length) ? eff : null, def: rt.default_effort || "", ctx: rt.max_input_tokens || 0
      });
    });
    return out;
  }
  function parseCodexModels(o) {
    var list = (o && o.models) || o, out = [];
    if (!list || !list.forEach) return out;
    list.forEach(function (m) {
      if (!m || !m.slug || (m.visibility && m.visibility !== "list")) return;
      // family = the model's name without its version: gpt-<version>-<name> -> "<name>", gpt-<version> -> "gpt"
      var fam = String(m.slug).replace(/^gpt-?/i, "").replace(/[\d.]+/g, " ").trim().split(/[\s-]+/).pop() || "gpt";
      var eff = (m.supported_reasoning_levels || []).map(function (r) { return r && (r.effort || r); })
        .filter(function (x) { return typeof x === "string"; });
      out.push({
        id: m.slug, name: m.display_name || m.slug, engine: "codex", family: fam,
        efforts: eff.length ? eff : null, def: m.default_reasoning_level || "",
        ctx: m.context_window || 0, prio: typeof m.priority === "number" ? m.priority : 99
      });
    });
    return out;
  }
  /* Codex catalog: the cached copy first (instant), then the live `codex debug models`. cb() after each. */
  function loadCodexModels(cb) {
    var home = selectedAccount("codex") || path.join(os.homedir(), ".codex");
    var cached = parseCodexModels(readJsonFile(path.join(home, "models_cache.json")));
    if (cached.length) { codexModels = cached; codexLoaded = true; cb(); }
    var out = "", child, finished = false;
    function done(ok) {
      if (finished) return;
      finished = true;
      var got = false;
      if (ok) {
        try {
          var js = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1); // a Mac login shell may print profile text around it
          var live = parseCodexModels(JSON.parse(js)); if (live.length) { codexModels = live; got = true; }
        } catch (e) { }
      }
      // A failed load with nothing cached is NOT "loaded": a saved GPT choice stays pending
      // and the next checkCodex() tries again.
      if (got || codexModels.length) codexLoaded = true;
      cb();
    }
    try { child = spawnCodex(["debug", "models"], WORK_DIR); } catch (e) { done(false); return; }
    var t = setTimeout(function () { killRunTree(child); done(false); }, 20000);
    child.stdout.on("data", function (d) { out += d.toString("utf8"); });
    child.on("error", function () { clearTimeout(t); done(false); });
    child.on("close", function (code) { clearTimeout(t); done(code === 0); });
  }
  /* Newest PER_FAMILY models of each family, families in a stable order. */
  function pickRecent(list, famOrder) {
    var by = {}, fams = [], out = [];
    list.forEach(function (m) {
      if (!by[m.family]) { by[m.family] = []; fams.push(m.family); }
      by[m.family].push(m);
    });
    function rank(f) { var i = famOrder ? famOrder.indexOf(f) : -1; return i < 0 ? 99 : i; }
    function bestPrio(f) { return Math.min.apply(null, by[f].map(function (m) { return m.prio || 0; })); }
    fams.sort(function (a, b) { return rank(a) - rank(b) || bestPrio(a) - bestPrio(b); });
    fams.forEach(function (f) {
      by[f].sort(function (a, b) { return cmpVerDesc(a.id, b.id) || (a.prio || 0) - (b.prio || 0); });
      out = out.concat(by[f].slice(0, PER_FAMILY));
    });
    return out;
  }
  /* Rebuild the Model <select> from the catalogs. A saved model that is no
   * longer listed moves to the newest model of the same family (or the CLI default). */
  var menuRebuildPending = false;
  function rebuildModelMenu() {
    if (typeof busy !== "undefined" && busy) { menuRebuildPending = true; return; } // never swap engines mid-run
    menuRebuildPending = false;
    claudeModels = readClaudeCatalog();
    var cl = claudeModels.length ? claudeModels : CLAUDE_ALIASES;
    MODELS = {};
    cl.concat(codexModels).forEach(function (m) { MODELS[m.id] = m; });
    var shown = pickRecent(cl, CLAUDE_FAMILY_ORDER).concat(pickRecent(codexModels, null));
    var want = localStorage.getItem("claude-ae-model") || "";
    var isShown = function (id) { return shown.some(function (m) { return m.id === id; }); };
    var keepPending = false;
    if (want && !isShown(want)) {
      var codexWant = isGptModel(want);
      if (codexWant && !codexLoaded) keepPending = true; // Codex list not in yet — keep the choice for now
      else {
        var fam = familyOf(want), sub = null;
        shown.forEach(function (m) { if (!sub && m.family === fam && (m.engine === "codex") === codexWant) sub = m; });
        want = sub ? sub.id : "";
      }
    }
    var prev = modelEl.value;
    modelEl.innerHTML = "";
    function addOpt(v, t, vendor, fam) {
      var o = document.createElement("option"); o.value = v; o.textContent = t;
      o.setAttribute("data-vendor", vendor); o.setAttribute("data-family", fam || "");
      modelEl.appendChild(o);
    }
    addOpt("", "Claude default", "claude", "");
    shown.forEach(function (m) {
      addOpt(m.id, m.name, m.engine, familyLabel(m));
      MODEL_DESCS[m.id] = "";
    });
    if (keepPending) addOpt(want, prettyModel(want), isGptModel(want) ? "codex" : "claude", "");
    modelEl.value = want;
    localStorage.setItem("claude-ae-model", want);
    // always fire change: refreshes the pill label (a pending id becomes its real name) and re-checks effort
    var ev; try { ev = new Event("change", { bubbles: true }); } catch (e) { ev = document.createEvent("Event"); ev.initEvent("change", true, true); }
    modelEl.dispatchEvent(ev);
    if (modelEl.value !== prev) { /* selection moved to a listed model */ }
  }
  // Image generation is driven by a Codex model that only relays the prompt to
  // the image tool: the user's override (localStorage "claude-ae-img-model"),
  // else the Codex catalog's top-priority model, else Codex's own default.
  function imgDriver() {
    var o = localStorage.getItem("claude-ae-img-model");
    if (o) return o;
    var best = null;
    codexModels.forEach(function (m) { if (!best || m.prio < best.prio) best = m; });
    return best ? best.id : "";
  }
  var IMG_EFFORT = { low: "low", medium: "medium", high: "xhigh" }; // image quality tier -> driver reasoning effort
  // Design room: Opus / Fable at medium effort or above (blank = the model's default) plan their
  // own builds — no Haiku/Sonnet director — and the taste recipes become optional reference.
  // Sonnet, Haiku, GPT and low effort keep the rails.
  function roomyRun() {
    var m = MODELS[modelEl.value];
    if (curEngine() === "codex" || !m || !ROOMY_FAMILIES[m.family]) return false;
    return effortEl.value !== "low";
  }
  // Brief fidelity: pull the phrases that carry numbers out of the user's brief (durations, counts, sizes)
  // so the builder gets them as an explicit checklist — no model call.
  var NUM_WORD = /^(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|sixty|single|double|triple|half|quarter)$/i;
  function briefNumbers(task) {
    var text = String(task || "").replace(/#[0-9a-f]{3,8}\b/gi, " ").replace(/Target comp:[^\n]*/i, " ");
    var clauses = text.split(/[.;:!?\n()]+|,\s+(?=[a-z])/i), out = [], seen = {};
    clauses.forEach(function (cl) {
      var w = cl.trim().split(/\s+/);
      for (var i = 0; i < w.length; i++) {
        var tok = w[i].replace(/[^0-9a-z×x.%-]/gi, "");
        if (!/\d/.test(tok) && !NUM_WORD.test(tok)) continue;
        var ph = (w.length <= 10 ? w : w.slice(Math.max(0, i - 3), i + 5)).join(" ").replace(/[,\s]+$/, "");
        var key = ph.toLowerCase();
        if (!seen[key] && ph.length > 1) { seen[key] = 1; out.push(ph.length > 90 ? ph.slice(0, 90) + "…" : ph); }
        if (w.length <= 10) break;
      }
    });
    return out.slice(0, 12);
  }
  function buildModel() { return modelEl.value; }
  function prettyModel(id) {
    if (!id) return "";
    if (MODELS[id]) return MODELS[id].name;
    var m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id);
    if (m) return m[1].charAt(0).toUpperCase() + m[1].slice(1) + " " + m[2] + (m[3] ? "." + m[3] : "");
    return id;
  }

  // ---------- state ----------
  var busy = false;
  var currentRun = null;   // { child, cancelled }
  var attachments = [];    // { path, name, isImage }
  var runRefs = [];        // refs of the run in flight (Codex attaches images with -i)
  var subRun = null;       // nested Codex run (generate_image tool) while a build run is active
  var history = [];        // { task, script, result }
  var refCounter = 0;
  var pendingCleanup = null; // silently clears the permission bar if superseded
  var tokensUsed = { input: 0, output: 0 };
  var replaying = false;   // true while re-rendering a loaded session (suppresses recording)
  var saveTimer = null;
  var sessionDirty = false; // real new activity only — merely opening a chat must not bump it in history
  var editsSincePrompt = 0; // undo groups created since the user's last message (for Revert)

  // ---------- dom ----------
  var chatEl = document.getElementById("chat");
  var emptyEl = document.getElementById("emptyState");
  var emptyTpl = emptyEl ? emptyEl.cloneNode(true) : null;
  function showEmpty() {
    if (emptyEl || !emptyTpl || chatEl.children.length) return;
    emptyEl = emptyTpl.cloneNode(true);
    chatEl.appendChild(emptyEl);
  }
  var inputEl = document.getElementById("input");
  var sendBtn = document.getElementById("sendBtn");
  var sendIcon = document.getElementById("sendIcon");
  var attachBtn = document.getElementById("attachBtn");
  var chipsEl = document.getElementById("chips");
  var modeEl = document.getElementById("mode");
  var modelEl = document.getElementById("model");
  var effortEl = document.getElementById("effort");
  var newChatBtn = document.getElementById("newChatBtn");
  var permBar = document.getElementById("permBar");
  var permText = document.getElementById("permText");
  var permPrimary = document.getElementById("permPrimary");
  var permDismiss = document.getElementById("permDismiss");
  var composerEl = document.getElementById("composer");
  var expandBtn = document.getElementById("expandBtn");
  var historyBtn = document.getElementById("historyBtn");
  var revertBtn = document.getElementById("revertBtn");
  var historyPanel = document.getElementById("historyPanel");
  var historyList = document.getElementById("historyList");
  var historyClose = document.getElementById("historyClose");
  var tokenInfo = document.getElementById("tokenInfo");
  var compactBtn = document.getElementById("compactBtn");
  var lightbox = document.getElementById("lightbox");
  var lbImg = document.getElementById("lbImg");
  var lbClose = document.getElementById("lbClose");

  var doneBtn = document.getElementById("doneBtn");
  var cacheBtn = document.getElementById("cacheBtn");
  var cachePanel = document.getElementById("cachePanel");
  var cacheList = document.getElementById("cacheList");
  var cacheClose = document.getElementById("cacheClose");
  var dirModal = document.getElementById("dirModal");
  var dirSpecEl = document.getElementById("dirSpec");
  var dirNotesEl = document.getElementById("dirNotes");
  var dirBuildBtn = document.getElementById("dirBuild");
  var dirSkipBtn = document.getElementById("dirSkip");
  var dirRewriteBtn = document.getElementById("dirRewrite");
  var dirCancelBtn = document.getElementById("dirCancel");

  // Task-type selector (New / Edit / Stylize / Other): picks which step rail
  // and skill block ship with the prompt, instead of sending everything always.
  var taskModesEl = document.getElementById("taskModes");
  var taskMode = localStorage.getItem("claude-ae-taskmode") || "other";

  // Per-mode input hints + fill-in templates. The live versions live in
  // brain/bundle.json; this is the fallback if the bundle has none.
  var TPL_FALLBACK = {
    "new": {
      ph: "Describe the animation — what it is, canvas, brand colors, motion feel, timing beats.\nTip: the ≡ button inserts a fill-in template.",
      t: "WHAT: [the animation in one line — e.g. logo intro for a tech reel]\nCANVAS: [size / fps / duration — e.g. 1920x1080, 30fps, 6s]\nBRAND: [hex colors · font · logo (imported in Bin? file path?)]\nELEMENTS: [every text line, shape, image that must appear]\nMOTION FEEL: [smooth corporate / bouncy / kinetic type / glitchy / minimal]\nBEATS: [what happens when — 0s: ..., 1.5s: ..., end: ...]"
    },
    edit: {
      ph: "Say which comp/layer, what to change, and what must stay untouched.\nTip: the ≡ button inserts a fill-in template.",
      t: "COMP / LAYER: [exact name(s)]\nCHANGE: [what is wrong or what you want instead]\nDON'T TOUCH: [what must stay exactly as it is]\nTIMING: [keep as-is / adjust how]"
    },
    style: {
      ph: "Name the comp, the look you want, palette hexes, and what to keep.\nTip: the ≡ button inserts a fill-in template.",
      t: "COMP: [name]\nTARGET LOOK: [reference or adjectives — e.g. grainy retro print, neon glow, clean flat]\nPALETTE: [hex codes, or \"keep current colors\"]\nKEEP: [layout / timing / text — what must not change]"
    },
    polish: {
      ph: "Say what feels off and the feel you want (snappy, overshoot, floaty…).\nTip: the ≡ button inserts a fill-in template.",
      t: "COMP: [name]\nWHAT FEELS OFF: [stiff / floaty / abrupt / mechanical / mistimed]\nWANTED FEEL: [e.g. snappy with slight overshoot, gentle and airy]\nSCOPE: [whole comp / only these layers: ...]"
    },
    recreate: {
      ph: "e.g. Recreate the animation in comp \"Reference\" into comp \"Animation\".\nTip: the ≡ button inserts a fill-in template.",
      t: "REFERENCE COMP: [name of the comp holding the animation to copy]\nTARGET COMP: [name of the comp to build it in]\nPRIORITY: [exact timing / exact positions / overall feel]\nSWAPS: [replace colors / logo / text with …, or \"none — copy as-is\"]"
    },
    def: {
      ph: "Describe a shot, a fix or a polish pass…\nTip: the template button inserts a fill-in brief.",
      t: "GOAL: [what you want done]\nWHERE: [comp / layers involved]\nMUST INCLUDE: [brand colors · fonts · logo · assets]\nCONSTRAINTS: [duration, what not to touch, style notes]"
    }
  };
  function getTpl(mode) {
    var src = (BRAIN && BRAIN.tpl) ? BRAIN.tpl : TPL_FALLBACK;
    return src[mode] || src.def || TPL_FALLBACK.def;
  }

  function syncTaskModes() {
    var btns = taskModesEl.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle("sel", btns[i].getAttribute("data-mode") === taskMode);
    }
    inputEl.placeholder = getTpl(taskMode).ph || "Describe a shot, a fix or a polish pass…";
    if (typeof TEXTURE_PACKS !== "undefined" && styleSel && TEXTURE_PACKS[styleSel.value] && taskMode !== "style") resetStyleSel();
  }
  taskModesEl.addEventListener("click", function (ev) {
    var b = ev.target;
    while (b && b !== taskModesEl && b.tagName !== "BUTTON") b = b.parentNode;
    if (!b || b === taskModesEl) return;
    taskMode = b.getAttribute("data-mode") || "other";
    localStorage.setItem("claude-ae-taskmode", taskMode);
    syncTaskModes();
  });

  syncTaskModes();

  // Template inserter: drops the fill-in skeleton for the current task type
  // into the box (appended if something is already typed).
  var tplBtn = document.getElementById("tplBtn");
  tplBtn.addEventListener("click", function () {
    var t = getTpl(taskMode).t;
    if (!t) return;
    inputEl.value = inputEl.value.trim() ? inputEl.value.replace(/\s*$/, "") + "\n\n" + t : t;
    autoGrow();
    inputEl.focus();
  });

  // AI-generation toggle: OFF (default) hard-blocks Higgsfield — the Skill
  // tool is withheld AND denied for the run, and the prompt says so. ON lets
  // Claude generate assets when the task needs them (still user-approved).
  var genBtn = document.getElementById("genBtn");
  var genOn = localStorage.getItem("claude-ae-gen") === "1";
  function syncGenBtn() {
    genBtn.classList.toggle("on", genOn);
    genBtn.classList.toggle("off", !genOn);
    genBtn.innerHTML = mpIcon("sparkle") + "<span>Higgs</span>"; // state shows as fill + tooltip
    genBtn.classList.toggle("disabled", !hfUsable());
    genBtn.title = !hfUsable() ? "Higgsfield disabled — the CLI is " + ((typeof hgCheck !== "undefined" && hgCheck.why === 42) ? "not signed in (run  higgsfield auth login)." : "not installed.") : genOn
      ? "Higgsfield is ON — Claude may use the Higgsfield CLI (video, 3D, premium image models; every generation asks first). GPT Image 2 assets are always available regardless. Click to turn off."
      : "Higgsfield is OFF. Image assets still come from GPT Image 2 (via Codex) whenever the design needs them. Click to also allow Higgsfield.";
  }
  genBtn.addEventListener("click", function () {
    if (!genOn && !hfUsable()) { addStatus(hgAdvice(hgCheck.why, false), "err"); return; }
    genOn = !genOn;
    genRun = genOn;
    localStorage.setItem("claude-ae-gen", genOn ? "1" : "0");
    syncGenBtn();
    if (genOn) checkHiggsfield(function (ok, why) { if (!ok) addStatus(hgAdvice(why, false), "err"); });
  });
  syncGenBtn();

  // Higgsfield availability gate. Gen ON is only honored when the CLI is
  // actually installed AND signed in — otherwise Claude silently fell back to
  // placeholders/free sources with no hint why ("Gen is on but nothing
  // generates"). Checked when Gen is toggled on and before every Gen run
  // (success cached 10 min, failure 15 s); a definitive failure downgrades
  // just that run to Gen OFF with a visible explanation. Slow or crashed
  // probes fail OPEN so a flaky network never blocks animating. The auth
  // probe uses the exit code only — all output is discarded inside the
  // shell, never read, never logged.
  var genRun = genOn; // what the CURRENT run actually gets (genOn ∧ Higgsfield usable)
  var hgCheck = { at: 0, ok: false, why: 0 }; // why: 41 = not installed, 42 = not signed in
  function hgAdvice(why, atSend) {
    return (atSend
      ? "⚠ Gen is ON but Higgsfield isn't ready — this message runs with generation OFF (free web assets/placeholders instead). "
      : "⚠ Gen is ON but Higgsfield isn't ready on this machine — sends will fall back to generation OFF until it's fixed. ") +
      (why === 42
        ? "Reason: not signed in (or the session expired). Fix: open " + (IS_MAC ? "Terminal" : "a terminal") + " and run:  higgsfield auth login"
        : "Reason: the Higgsfield CLI is not installed. Fix: re-run the MotionPilot installer (it sets Higgsfield up), then restart After Effects.");
  }
  function checkHiggsfield(cb) { // cb(ok, why)
    var now = Date.now();
    if (hgCheck.at && now - hgCheck.at < (hgCheck.ok ? 600000 : 15000)) { cb(hgCheck.ok, hgCheck.why); return; }
    var done = false;
    function finish(ok, why, binDir) {
      if (done) return;
      done = true;
      hgCheck = { at: Date.now(), ok: ok, why: why || 0 };
      try { if (!ok && genOn) { genOn = false; genRun = false; localStorage.setItem("claude-ae-gen", "0"); } syncGenBtn(); } catch (e) { }
      // A CLI living outside the panel's PATH list (custom npm prefix) would
      // vanish again inside the run's shell — teach the spawn PATH about it.
      if (ok && IS_MAC && binDir && binDir.charAt(0) === "/" && MAC_PATHS.indexOf(binDir + ":") === -1) {
        MAC_PATHS = MAC_PATHS
          ? MAC_PATHS.replace('PATH="', 'PATH="' + binDir + ":")
          : 'export PATH="' + binDir + ':$PATH"; ';
      }
      cb(ok, why || 0);
    }
    setTimeout(function () { finish(true, 0, ""); }, 10000); // fail open: never block a run on a slow probe
    try {
      if (IS_MAC) {
        var probe = MAC_PATHS +
          'HB="$(command -v higgsfield 2>/dev/null)"; ' +
          'if [ -z "$HB" ]; then P="$(npm config get prefix 2>/dev/null)"; [ -n "$P" ] && [ -x "$P/bin/higgsfield" ] && HB="$P/bin/higgsfield"; fi; ' +
          '[ -n "$HB" ] || exit 41; echo "${HB%/*}"; ' +
          '"$HB" auth token >/dev/null 2>&1 || exit 42';
        cp.execFile(MAC_SHELL, ["-l", "-c", probe], { timeout: 9000 }, function (err, stdout) {
          var dir = String(stdout || "").split(/\r?\n/)[0].trim();
          if (!err) { finish(true, 0, dir); return; }
          if (err.code === 41 || err.code === 42) finish(false, err.code, "");
          else finish(true, 0, dir); // crashed/killed probe ≠ missing CLI — fail open
        });
      } else {
        cp.exec("where higgsfield >NUL 2>&1", { timeout: 9000 }, function (e1) {
          if (e1) { finish(false, 41, ""); return; }
          cp.exec("higgsfield auth token >NUL 2>&1", { timeout: 9000 }, function (e2) {
            if (e2 && e2.code === 1) finish(false, 42, "");
            else finish(!e2, 0, ""); // killed/odd exit — fail open
          });
        });
      }
    } catch (e) { finish(true, 0, ""); }
  }
  // Design-first toggle: ON routes New builds (without a style pack) through
  // an HTML/CSS layout pass before any AE layers exist — the mock decides the
  // composition, then gets ported 1:1. The instruction text rides in the
  // bundle (BRAIN.design); old bundles without it make this toggle a no-op.
  var designBtn = document.getElementById("designBtn");
  var designOn = localStorage.getItem("claude-ae-design") === "1";
  function syncDesignBtn() {
    designBtn.classList.toggle("on", designOn);
    designBtn.classList.toggle("off", !designOn);
    designBtn.innerHTML = '<span class="glyph">&#9707;</span><span>Design</span>';
    designBtn.title = designOn
      ? "Design-first is ON — New builds get an HTML/CSS composition pass before any AE layers (modern layout, slightly longer runs). Click to turn off."
      : "Design-first is OFF — Claude lays out directly in AE. Click to route New builds through a modern-composition design pass first.";
  }
  designBtn.addEventListener("click", function () {
    designOn = !designOn;
    localStorage.setItem("claude-ae-design", designOn ? "1" : "0");
    syncDesignBtn();
  });
  syncDesignBtn();

  // Codex CLI availability (GPT models + GPT Image 2 assets): installed AND signed in.
  // Same caching/fail-open shape as the Higgsfield probe. why: 51 = not
  // installed, 52 = not signed in.
  var cxCheck = { at: 0, ok: false, why: 0 };
  // (called from pill syncs that run before the probe caches are declared — hence the typeof guards)
  function codexUsable() { return (typeof cxCheck === "undefined") || !cxCheck || !cxCheck.at || cxCheck.ok; }
  function hfUsable() { return (typeof hgCheck === "undefined") || !hgCheck || !hgCheck.at || hgCheck.ok; }
  /* Codex went away (not installed / signed out): drop any GPT selection
   * so it cannot be used. */
  function enforceCodexGate() {
    if (codexUsable()) return;
    if (isGptModel(modelEl.value)) {
      modelEl.value = "";
      localStorage.setItem("claude-ae-model", "");
      var ev; try { ev = new Event("change", { bubbles: true }); } catch (e) { ev = document.createEvent("Event"); ev.initEvent("change", true, true); }
      modelEl.dispatchEvent(ev);
      addStatus("⚠ GPT models are disabled: " + (cxCheck.why === 52 ? "the Codex CLI is not signed in (run  codex login  in a terminal, then click the Codex dot)." : "the Codex CLI is not installed."), "err");
    }
  }
  function codexAdvice(why, ctx) {
    var head = ctx === "model" ? "⚠ GPT models run through the Codex CLI"
        : ctx === "gen" ? "⚠ GPT Image 2 asset generation needs the Codex CLI"
          : "⚠ This run needs the Codex CLI";
    return head + (why === 52
      ? ", but it isn't signed in. Fix: open a terminal and run:  codex login   (ChatGPT account), then try again."
      : ", but it isn't installed (or not on PATH). Fix: install it (npm install -g @openai/codex, or the OpenAI installer), run 'codex login' once, then restart After Effects.");
  }
  function checkCodex(cb) { // cb(ok, why)
    var now = Date.now();
    if (cxCheck.at && now - cxCheck.at < (cxCheck.ok ? 600000 : 15000)) { cb(cxCheck.ok, cxCheck.why); return; }
    var done = false;
    function finish(ok, why) {
      if (done) return;
      done = true;
      var wasOk = cxCheck.ok && cxCheck.at;
      cxCheck = { at: Date.now(), ok: ok, why: why || 0 };
      updateCodexDot();
      try { enforceCodexGate(); } catch (e) { }
      if (ok && (!wasOk || !codexLoaded)) loadCodexModels(rebuildModelMenu);
      if (!ok && codexModels.length) { codexModels = []; rebuildModelMenu(); }
      cb(ok, why || 0);
    }
    setTimeout(function () { finish(true, 0); }, 12000); // fail open on a slow probe
    try {
      if (IS_MAC) {
        var probe = MAC_PATHS + 'command -v codex >/dev/null 2>&1 || exit 51; codex login status >/dev/null 2>&1 || exit 52';
        cp.execFile(MAC_SHELL, ["-l", "-c", probe], { timeout: 11000, env: acctEnv("codex") }, function (err) {
          if (!err) { finish(true, 0); return; }
          if (err.code === 51 || err.code === 52) finish(false, err.code);
          else finish(true, 0);
        });
      } else {
        cp.exec("where codex", { timeout: 9000, windowsHide: true }, function (e1, stdout) {
          if (e1) { finish(false, 51); return; }
          var lines = String(stdout || "").split(/\r?\n/), cmdShim = "";
          for (var i = 0; i < lines.length; i++) {
            var ln = lines[i].trim();
            if (/\.exe$/i.test(ln)) { CODEX_BIN = ln; CODEX_PRE = []; break; }
            if (/\.cmd$/i.test(ln) && !cmdShim) cmdShim = ln;
          }
          if (!CODEX_BIN && cmdShim) {
            // npm install: codex.cmd is a shim around node + the package launcher.
            // Spawning a .cmd needs a shell (and its quoting); run the launcher with node instead.
            var launcher = path.join(path.dirname(cmdShim), "node_modules", "@openai", "codex", "bin", "codex.js");
            try { if (fs.existsSync(launcher)) { CODEX_BIN = NODE_BIN || "node"; CODEX_PRE = [launcher]; } } catch (e3) { }
          }
          cp.exec("codex login status", { timeout: 9000, windowsHide: true, env: acctEnv("codex") }, function (e2) {
            if (e2 && e2.code === 1) finish(false, 52);
            else finish(!e2, 0);
          });
        });
      }
    } catch (e) { finish(true, 0); }
  }
  var codexDot = document.getElementById("codexDot");
  function updateCodexDot() {
    if (!codexDot) return;
    var st = !cxCheck.at ? "unknown" : cxCheck.ok ? "in" : "out";
    codexDot.className = "eng auth-" + st;
    codexDot.title = st === "in" ? "ChatGPT (Codex CLI): signed in" + (CODEX_VER ? " · " + CODEX_VER : "")
      : st === "out" ? (cxCheck.why === 52 ? "Codex (GPT): sign-in needed — run 'codex login' in a terminal, then click this dot"
        : "Codex CLI not found — install it to use the GPT models and GPT Image 2 assets; click to re-check")
        : "Codex (GPT) status unknown — click to check";
  }
  if (codexDot) codexDot.addEventListener("click", function () {
    cxCheck = { at: 0, ok: false, why: 0 };
    checkCodex(function (ok, why) {
      addStatus(ok ? "Codex (GPT) sign-in looks good." : codexAdvice(why, "model"), ok ? "log" : "err");
    });
  });

  /* Per-send resolution of what Gen the run really gets. */
  function gateGen(cb) {
    if (!genOn) { genRun = false; cb(); return; }
    checkHiggsfield(function (ok, why) {
      genRun = ok;
      if (!ok) addStatus(hgAdvice(why, true), "err");
      cb();
    });
  }

  // persisted settings
  modeEl.value = localStorage.getItem("claude-ae-mode") || "ask";
  modelEl.value = localStorage.getItem("claude-ae-model") || "";
  rebuildModelMenu(); // Claude catalog now; the Codex list follows once its CLI answers (checkCodex)
  effortEl.value = localStorage.getItem("claude-ae-effort") || "";
  if (!effortAllowed(effortEl.value)) { effortEl.value = ""; localStorage.setItem("claude-ae-effort", ""); }
  modeEl.addEventListener("change", function () { localStorage.setItem("claude-ae-mode", modeEl.value); });
  modelEl.addEventListener("change", function () {
    localStorage.setItem("claude-ae-model", modelEl.value);
    if (!effortAllowed(effortEl.value)) {
      effortEl.value = "";
      localStorage.setItem("claude-ae-effort", "");
      var e;
      try { e = new Event("change", { bubbles: true }); }
      catch (err) { e = document.createEvent("Event"); e.initEvent("change", true, true); }
      effortEl.dispatchEvent(e);
    }
    if (curEngine() === "codex") checkCodex(function (ok, why) { if (!ok) addStatus(codexAdvice(why, "model"), "err"); });
    syncDesignBtn();
  });
  syncDesignBtn(); // the persisted model is known only now
  effortEl.addEventListener("change", function () {
    localStorage.setItem("claude-ae-effort", effortEl.value);
    localStorage.removeItem("claude-ae-no-effort"); // re-probe CLI support on change
  });

  // ---------- custom dropdowns (model / effort / ask-auto) ----------
  // Native <select> popups can't be styled in CEP, so each becomes a pill
  // button + popup where every option carries a one-line "when to pick this".
  // The hidden native select stays the source of truth, so all .value reads
  // and change listeners above keep working untouched.
  var menuClosers = [];
  function closeMenus() { menuClosers.forEach(function (f) { f(); }); }
  document.addEventListener("click", closeMenus);

  function enhanceSelect(ddId, cfg) {
    var dd = document.getElementById(ddId);
    var sel = dd.querySelector("select");
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dd-btn" + (cfg.strong ? " strong" : "");
    var ic = null;
    if (cfg.icon || cfg.iconFor) {
      ic = document.createElement("span");
      ic.className = "dd-ic";
      ic.innerHTML = cfg.icon || "";
      btn.appendChild(ic);
    }
    var val = document.createElement("span"); val.className = "dd-val"; btn.appendChild(val);
    var ch = document.createElement("span"); ch.className = "dd-chev"; ch.innerHTML = window.mpIcon ? mpIcon("chev") : "&#9662;"; btn.appendChild(ch);
    var pop = document.createElement("div"); pop.className = "dd-pop hidden";
    pop.onclick = function (ev) { ev.stopPropagation(); };
    dd.appendChild(btn); dd.appendChild(pop);

    function syncVal() {
      var o = sel.options[sel.selectedIndex];
      val.textContent = o ? o.textContent : "";
      if (ic && cfg.iconFor) ic.innerHTML = cfg.iconFor(sel.value) || "";
    }
    sel.addEventListener("change", syncVal); // programmatic resets refresh the pill too
    function close() { pop.classList.add("hidden"); dd.classList.remove("open"); }
    menuClosers.push(close);

    function build() {
      pop.innerHTML = "";
      if (cfg.heading) {
        var hd = document.createElement("div");
        hd.className = "dd-head";
        hd.textContent = cfg.heading;
        pop.appendChild(hd);
      }
      var lastVendor = null, lastFam = null;
      for (var i = 0; i < sel.options.length; i++) {
        (function (o) {
          if (cfg.filter && !cfg.filter(o.value)) return; // e.g. GPT-only efforts while a Claude model is picked
          if (cfg.groups) {
            var vd = o.getAttribute("data-vendor") || "", fm = o.getAttribute("data-family") || "";
            if (vd !== lastVendor) { pop.appendChild(cfg.groups.vendor(vd)); lastVendor = vd; lastFam = null; }
            if (fm && fm !== lastFam) { pop.appendChild(cfg.groups.family(vd, fm)); }
            lastFam = fm;
          }
          var it = document.createElement("div");
          it.className = "dd-item" + (o.value === sel.value ? " sel" : "");
          var nm = document.createElement("div"); nm.className = "pi-name"; nm.textContent = o.textContent;
          it.appendChild(nm);
          var d = cfg.descs && cfg.descs[o.value];
          if (d) {
            var mt = document.createElement("div"); mt.className = "pi-meta"; mt.textContent = d;
            it.appendChild(mt);
          }
          it.onclick = function () {
            sel.value = o.value;
            var e;
            try { e = new Event("change", { bubbles: true }); }
            catch (err) { e = document.createEvent("Event"); e.initEvent("change", true, true); }
            sel.dispatchEvent(e);
            syncVal();
            close();
          };
          pop.appendChild(it);
        })(sel.options[i]);
      }
      if (cfg.afterBuild) cfg.afterBuild(pop, lastVendor);
    }
    /* The pills live in a horizontally scrolling strip, which would clip an
     * absolutely-positioned popup — so the popup is position:fixed and placed
     * from the pill's on-screen rect, clamped inside the panel. */
    function placePop() {
      var r = btn.getBoundingClientRect();
      pop.style.maxWidth = Math.max(160, window.innerWidth - 8) + "px";
      pop.style.bottom = (window.innerHeight - r.top + 8) + "px";
      pop.style.left = "";
      pop.style.right = "";
      if (dd.classList.contains("right")) {
        pop.style.right = Math.max(4, window.innerWidth - r.right) + "px";
      } else {
        pop.style.left = Math.max(4, Math.min(r.left, window.innerWidth - pop.offsetWidth - 4)) + "px";
      }
    }
    btn.onclick = function (ev) {
      ev.stopPropagation();
      var wasOpen = !pop.classList.contains("hidden");
      closeMenus();
      if (!wasOpen) { build(); pop.classList.remove("hidden"); dd.classList.add("open"); placePop(); }
    };
    syncVal();
  }

  /* Horizontal strips (task-mode pills, composer controls): the mouse wheel
   * scrolls them sideways, and scrolling closes any open popup so it can't
   * drift away from its pill. */
  function hstrip(el) {
    if (!el) return;
    el.addEventListener("wheel", function (ev) {
      if (el.scrollWidth <= el.clientWidth) return;
      if (Math.abs(ev.deltaY) <= Math.abs(ev.deltaX)) return;
      el.scrollLeft += ev.deltaY;
      ev.preventDefault();
    }, { passive: false });
    el.addEventListener("scroll", closeMenus);
  }
  hstrip(document.querySelector(".controls-left"));
  hstrip(document.getElementById("taskModes"));
  window.addEventListener("resize", closeMenus);

  function ddVendorRow(vd) {
    var v = VENDORS[vd] || { name: vd, via: "", icon: "" };
    var r = document.createElement("div"); r.className = "dd-vendor";
    r.innerHTML = '<span class="dv-ic">' + mpIcon(v.icon) + '</span><span class="dv-name"></span><span class="dv-via"></span>';
    r.querySelector(".dv-name").textContent = v.name;
    r.querySelector(".dv-via").textContent = v.via;
    return r;
  }
  enhanceSelect("modelDD", {
    iconFor: function (v) { return mpIcon(isGptModel(v) ? "openai" : "claude"); },
    strong: true,
    heading: "Model — who does the work",
    filter: function (v) { return codexUsable() || !isGptModel(v); }, // GPT models need a signed-in Codex CLI
    descs: MODEL_DESCS,
    groups: {
      vendor: ddVendorRow,
      family: function (vd, fm) {
        var r = document.createElement("div"); r.className = "dd-fam";
        var n = document.createElement("div"); n.className = "df-name"; n.textContent = fm; r.appendChild(n);
        var d = vd === "codex" ? CODEX_FAMILY_DESC : FAMILY_DESC[fm.toLowerCase()];
        if (d) { var m = document.createElement("div"); m.className = "df-desc"; m.textContent = d; r.appendChild(m); }
        return r;
      }
    },
    afterBuild: function (pop, lastVendor) {
      if (lastVendor === "codex") return;
      pop.appendChild(ddVendorRow("codex"));
      var it = document.createElement("div"); it.className = "dd-item dd-off";
      it.innerHTML = '<div class="pi-meta"></div>';
      it.firstChild.textContent = codexUsable() ? "No ChatGPT models listed yet — they appear once the Codex CLI answers."
        : "Install the Codex CLI and run  codex login  to add the ChatGPT models here (then click the OpenAI dot in the top bar).";
      pop.appendChild(it);
    }
  });
  enhanceSelect("effortDD", {
    icon: mpIcon("gauge"),
    heading: "Effort — how long it thinks",
    filter: effortAllowed,
    descs: {
      "": "The model's default effort (only the levels the selected model supports are listed).",
      "low": "Snappy and cheap — simple, well-defined edits.",
      "medium": "Balanced depth vs. speed — the everyday setting for builds.",
      "high": "Thinks hard — complex scenes, recreations, stubborn bugs.",
      "xhigh": "Long multi-step builds; noticeably more tokens than high.",
      "max": "No spending cap — one-off hardest briefs only; slow.",
      "ultra": "Longest thinking there is (some Codex models). Reserve for one-off hard briefs."
    }
  });
  enhanceSelect("modeDD", {
    iconFor: function (v) { return mpIcon(v === "auto" ? "bolt" : "shield"); },
    heading: "Permissions",
    descs: {
      "ask": "Approve every After Effects script and shell command before it runs. Safest.",
      "auto": "Scripts and shell commands run instantly. Anything risky — deleting files, installs, system or registry changes, credentials, uploads — and paid generations still ask first."
    }
  });

  // Editing-style dropdown: attaches a style pack from brain/bundle.json to the NEXT
  // prompt only, then resets to "Style" — each animation lives in its own
  // chat, so the pack ships with the first (building) prompt and later
  // prompts are edits/polish on the same piece. Not persisted on purpose.
  var styleSel = document.getElementById("styleSel");
  var TEXTURE_PACKS = { "grain-print": 1, "soft-glow": 1, "depth-blur": 1, "hard-sticker": 1, "grain-gradient": 1 };
  enhanceSelect("styleDD", {
    heading: "Style pack — applied to your next prompt, then resets",
    descs: {
      "": "No style pack — the design doctrine + moves library alone.",
      "ui-motion": "Product-component motion — one drawn UI object morphing through states, cards, chat, soft gradient grounds.",
      "kinetic-type": "One line on a void — scale jumps, word-append, crop-wipes, glyph swaps.",
      "cutout-collage": "Giant letter as scenery, hard-edge photo cut-outs, sticker chips, whip cuts.",
      "flat-scene": "One flat hero per colour field — colour-flood and object wipes, cropped objects.",
      "data-editorial": "One primitive many ways — hairline rules, numbers inside shapes, arcs and orbits.",
      "html-to-scene": "Rebuild an HTML file or a design image as editable AE layers. Experimental.",
      "grain-print": "Stylize: riso/paper grain, halftone shading, hard offset shadows.",
      "soft-glow": "Stylize: bloom on one bright object, feathered arcs, rim-lit card edges.",
      "depth-blur": "Stylize: gaussian on back layers keyed to depth, dim overlay on focus.",
      "hard-sticker": "Stylize: zero-shadow cut-outs, thick white rims, hard offset duplicates.",
      "grain-gradient": "Stylize: grain-dissolve edges on gradient slabs."
    },
    filter: function (v) { return !TEXTURE_PACKS[v] || taskMode === "style"; }
  });
  function resetStyleSel() {
    if (!styleSel.value) return;
    styleSel.value = "";
    var e;
    try { e = new Event("change", { bubbles: true }); }
    catch (err) { e = document.createEvent("Event"); e.initEvent("change", true, true); }
    styleSel.dispatchEvent(e);
  }

  function ensureDirs() {
    try {
      if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR);
      if (!fs.existsSync(REFS_DIR)) fs.mkdirSync(REFS_DIR);
    } catch (e) { }
  }
  ensureDirs();

  // ---------- session persistence ----------
  // Every chat is saved as a JSON transcript so users can reopen past
  // sessions from the history panel. Stored under the CEP user-data folder
  // (stable across reboots), not %TEMP%.
  var SESS_DIR = (function () {
    var base = "";
    try { base = csInterface.getSystemPath(SystemPath.USER_DATA); } catch (e) { }
    return base ? path.join(base, "com.motionpilot", "sessions") : path.join(WORK_DIR, "sessions");
  })();

  function ensureSessDir() {
    try {
      if (!fs.existsSync(SESS_DIR)) fs.mkdirSync(SESS_DIR, { recursive: true });
    } catch (e) { }
  }
  ensureSessDir();

  function newSessionObj() {
    return {
      id: "s" + Date.now(),
      title: "",
      claudeSid: "", // Claude CLI session id — lets every send in this chat resume the same conversation
      codexTid: "",  // Codex thread id — same idea for GPT runs (codex exec resume)
      accounts: {},  // { claude, codex }: account folder that created this chat's sessions ("" = default)
      switched: {},  // { claude|codex: true } after a session was dropped for an account switch — the next run catches up
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tokens: { input: 0, output: 0 },
      history: [],
      messages: []
    };
  }
  var session = newSessionObj();

  function sessionHasUserMsg() {
    for (var i = 0; i < session.messages.length; i++) {
      if (session.messages[i].type === "user") return true;
    }
    return false;
  }

  function saveSession() {
    if (!sessionHasUserMsg()) return; // don't persist chats the user never spoke in
    if (!sessionDirty) return;        // nothing new happened — keep updatedAt (and history order) untouched
    session.updatedAt = Date.now();
    session.history = history;
    session.tokens = tokensUsed;
    try {
      ensureSessDir();
      fs.writeFileSync(path.join(SESS_DIR, session.id + ".json"), JSON.stringify(session), "utf8");
      sessionDirty = false;
    } catch (e) { }
  }

  function saveSessionSoon() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveSession, 400);
  }

  function record(entry) {
    if (replaying) return;
    sessionDirty = true;
    session.messages.push(entry);
    if (!session.title && entry.type === "user") {
      session.title = entry.text.length > 60 ? entry.text.substring(0, 60) + "…" : entry.text;
    }
    saveSessionSoon();
  }

  // ---------- chat rendering ----------
  function hideEmpty() {
    if (emptyEl && emptyEl.parentNode) emptyEl.parentNode.removeChild(emptyEl);
    emptyEl = null;
  }

  function scrollDown() { chatEl.scrollTop = chatEl.scrollHeight; }

  /* Frame thumbnails finish loading AFTER their message was appended, growing
   * the page below the viewport — re-stick to the bottom, but only if the user
   * was already there (never yank them down while they're reading back). */
  function scrollDownIfNear() {
    if (chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 160) scrollDown();
  }

  function removeEl(el) { if (el && el.parentNode) el.parentNode.removeChild(el); }

  /* While Claude is working, live tickers stay pinned to the very bottom of
   * the conversation: anything appended mid-run is inserted above them.
   * A STACK, not a single pointer — a nested pipeline can run its own
   * ticker DURING the main run, and with one pointer its stop() used to
   * orphan the main spinner mid-chat (stuck "on top" forever). */
  var tickerStack = [];
  function appendToChat(el) {
    chatEl.appendChild(el);
    for (var ti = 0; ti < tickerStack.length; ti++) {
      if (tickerStack[ti] !== el) chatEl.appendChild(tickerStack[ti]);
    }
    scrollDown();
  }

  function addUserMsg(text, refs) {
    hideEmpty();
    var div = document.createElement("div");
    div.className = "msg user";
    div.textContent = text;
    if (refs && refs.length) {
      var wrap = document.createElement("div");
      wrap.className = "thumbs";
      refs.forEach(function (r) {
        if (r.isImage) {
          var img = document.createElement("img");
          img.src = fileUrl(r.path);
          img.onerror = function () { img.style.display = "none"; }; // ref file may be gone on reload
          wrap.appendChild(img);
        } else {
          var chip = document.createElement("div");
          chip.className = "filechip";
          chip.textContent = (r.isDoc ? "📄 " : "🎬 ") + r.name;
          wrap.appendChild(chip);
        }
      });
      div.appendChild(wrap);
    }
    appendToChat(div);
    record({ type: "user", text: text, refs: refs || [] });
    updateTokenInfo(); // the compact button + meter appear with the first message
  }

  function addClaudeMsg(text) {
    hideEmpty();
    var div = document.createElement("div");
    div.className = "msg claude";
    div.textContent = text;
    appendToChat(div);
    record({ type: "claude", text: text });
    return div;
  }

  function addStatus(text, kind) {
    hideEmpty();
    var div = document.createElement("div");
    div.className = "msg status" + (kind ? " " + kind : "");
    div.textContent = text;
    appendToChat(div);
    record({ type: "status", text: text, kind: kind || "" });
    return div;
  }

  /* Animated status line with a live elapsed-seconds counter. */
  function addTicker(label) {
    hideEmpty();
    var div = document.createElement("div");
    div.className = "msg status";
    div.innerHTML = '<span class="thinking"><i></i><i></i><i></i></span> <span class="tlabel"></span> <span class="tsecs" style="opacity:.6"></span>';
    var lab = div.querySelector(".tlabel");
    var secs = div.querySelector(".tsecs");
    lab.textContent = label;
    var start = Date.now();
    var iv = setInterval(function () {
      var s = Math.floor((Date.now() - start) / 1000);
      secs.textContent = s >= 60 ? Math.floor(s / 60) + "m " + (s % 60) + "s" : s + "s";
    }, 1000);
    chatEl.appendChild(div);
    tickerStack.push(div); // appendToChat keeps every live ticker at the bottom
    scrollDown();
    return {
      setLabel: function (t) { lab.textContent = t; },
      stop: function () {
        clearInterval(iv);
        var i = tickerStack.indexOf(div);
        if (i !== -1) tickerStack.splice(i, 1);
        removeEl(div);
        scrollDown();
      }
    };
  }

  function addScriptCard(code) {
    hideEmpty();
    var card = document.createElement("div");
    card.className = "script-card";

    var head = document.createElement("div");
    head.className = "card-head";
    head.innerHTML = "<span>ExtendScript</span>";
    var copyBtn = document.createElement("button");
    copyBtn.className = "btn-ghost";
    copyBtn.style.cssText = "border-radius:10px;padding:2px 10px;font-size:11px;cursor:pointer;background:transparent;color:inherit;";
    copyBtn.textContent = "Copy";
    copyBtn.onclick = function () {
      var ta = document.createElement("textarea");
      ta.value = code;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      copyBtn.textContent = "Copied";
      setTimeout(function () { copyBtn.textContent = "Copy"; }, 1200);
    };
    head.appendChild(copyBtn);
    card.appendChild(head);

    var pre = document.createElement("pre");
    pre.textContent = code;
    card.appendChild(pre);

    appendToChat(card);
    record({ type: "script", code: code });
    return card;
  }

  // ---------- permission bar ----------
  function showPermBar(text, primaryLabel, onPrimary, onDismiss, silentCleanup) {
    permText.textContent = text;
    permPrimary.textContent = primaryLabel;
    permPrimary.onclick = function () { hidePermBar(); onPrimary(); };
    permDismiss.onclick = function () { hidePermBar(); if (onDismiss) onDismiss(); };
    pendingCleanup = silentCleanup || null;
    permBar.classList.remove("hidden");
  }

  function hidePermBar() {
    permBar.classList.add("hidden");
    pendingCleanup = null;
  }

  /* A new message supersedes any pending approval. */
  function clearPending() {
    if (!permBar.classList.contains("hidden")) {
      var cleanup = pendingCleanup;
      hidePermBar();
      if (cleanup) cleanup();
    }
  }

  // ---------- busy state ----------
  /* Soft stop: "the result is good enough — wrap up". Instead of killing the
   * CLI mid-thought (that's ■), the flag rides out on the NEXT tool result:
   * tool calls are near-continuous during a build, so Claude hears it within
   * seconds, closes the in-flight step cleanly, and ends the run. */
  var doneSignal = false;
  function setBusy(on) {
    busy = on;
    if (!on && menuRebuildPending) setTimeout(rebuildModelMenu, 0);
    sendBtn.classList.toggle("busy", on);
    sendIcon.innerHTML = mpIcon(on ? "stop" : "send");
    sendBtn.title = on ? "Stop the run" : "Send (Enter)";
    doneSignal = false; // both edges: a new run starts clean, an ended run clears any unconsumed signal
    if (doneBtn) {
      doneBtn.classList.toggle("hidden", !on);
      doneBtn.disabled = false;
    }
  }

  function stopCurrent() {
    // ■ while the director's approval modal is open = cancel the send.
    if (dirModalCancel) {
      // a Rewrite-with-notes run may be in flight — kill it too
      if (currentRun && currentRun.child) { currentRun.cancelled = true; killRunTree(currentRun.child); }
      addStatus("⏹ Send cancelled.", "error");
      dirModalCancel(); // closes the modal and resolves the pass with null
      return;
    }
    if (subRun && subRun.child) { subRun.cancelled = true; killRunTree(subRun.child); subRun = null; }
    if (currentRun && currentRun.child) {
      currentRun.cancelled = true;
      killRunTree(currentRun.child);
      // Release any tool calls the dead CLI was waiting on (queued scripts,
      // a script parked on the permission bar) so the bridge doesn't wedge.
      clearPending();
      if (typeof flushToolQueue === "function") flushToolQueue("The user stopped this run.");
      addStatus("⏹ Stopped by user.", "error");
      setBusy(false);
    }
    // If no CLI child is running (e.g. AE is executing a script) there is
    // nothing safe to interrupt — evalScript is synchronous inside AE.
  }

  // ---------- attachments ----------
  function extOf(name) {
    var m = /\.([a-z0-9]+)$/i.exec(name || "");
    return m ? m[1].toLowerCase() : "";
  }
  function isImageExt(e) { return IMAGE_EXT.indexOf(e) !== -1; }
  function isMediaExt(e) { return IMAGE_EXT.indexOf(e) !== -1 || VIDEO_EXT.indexOf(e) !== -1; }
  function isDocExt(e) { return DOC_EXT.indexOf(e) !== -1; }

  function renderChips() {
    chipsEl.innerHTML = "";
    attachments.forEach(function (a, idx) {
      var chip = document.createElement("div");
      chip.className = "chip";
      if (a.isImage) {
        var img = document.createElement("img");
        img.src = fileUrl(a.path);
        img.onclick = function () { openLightbox(img.src); };
        chip.appendChild(img);
      } else {
        var ic = document.createElement("div");
        ic.className = "icon";
        ic.textContent = a.isDoc ? "📄" : "🎬";
        chip.appendChild(ic);
      }
      var name = document.createElement("span");
      name.className = "name";
      name.textContent = a.name;
      chip.appendChild(name);
      var rm = document.createElement("span");
      rm.className = "rm";
      rm.innerHTML = "&times;";
      rm.onclick = function () {
        attachments.splice(idx, 1);
        renderChips();
      };
      chip.appendChild(rm);
      chipsEl.appendChild(chip);
    });
  }

  function addAttachmentPath(p) {
    var name = path.basename(p);
    var e = extOf(name);
    if (!isMediaExt(e) && !isDocExt(e)) {
      addStatus("Skipped " + name + " — supported references: images, videos, and documents (" + DOC_EXT.join("/") + ").", "error");
      return;
    }
    attachments.push({ path: p, name: name, isImage: isImageExt(e), isDoc: isDocExt(e) });
    renderChips();
  }

  function saveBlobAsRef(blob, suggestedName) {
    ensureDirs();
    var e = extOf(suggestedName);
    if (!e) {
      e = (blob.type && blob.type.indexOf("image/") === 0) ? (blob.type.split("/")[1] || "png") : "bin";
      if (e === "jpeg") e = "jpg";
    }
    if (blob.size > MAX_COPY_BYTES) {
      addStatus("File too large to paste (" + Math.round(blob.size / 1048576) + " MB). Use the + button to attach it by path instead.", "error");
      return;
    }
    var fname = "ref-" + Date.now() + "-" + (++refCounter) + "." + e;
    var full = path.join(REFS_DIR, fname);
    var reader = new FileReader();
    reader.onload = function () {
      try {
        fs.writeFileSync(full, Buffer.from(new Uint8Array(reader.result)));
        addAttachmentPath(full);
      } catch (err) {
        addStatus("Could not save reference file: " + err.message, "error");
      }
    };
    reader.onerror = function () { addStatus("Could not read pasted file.", "error"); };
    reader.readAsArrayBuffer(blob);
  }

  function handleIncomingFile(file) {
    if (file.path) {
      addAttachmentPath(file.path);
    } else {
      var name = file.name || ("pasted." + ((file.type || "").split("/")[1] || "png"));
      var e = extOf(name);
      if (e && !isMediaExt(e) && !isDocExt(e)) {
        addStatus("Skipped " + name + " — supported references: images, videos, and documents (" + DOC_EXT.join("/") + ").", "error");
        return;
      }
      saveBlobAsRef(file, name);
    }
  }

  document.addEventListener("paste", function (ev) {
    var items = (ev.clipboardData && ev.clipboardData.items) || [];
    var grabbed = false;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.kind === "file") {
        var f = it.getAsFile();
        if (f) { handleIncomingFile(f); grabbed = true; }
      }
    }
    if (grabbed) ev.preventDefault();
  });

  var dragDepth = 0;
  document.addEventListener("dragenter", function (ev) {
    ev.preventDefault();
    dragDepth++;
    document.body.classList.add("dragging");
  });
  document.addEventListener("dragover", function (ev) { ev.preventDefault(); });
  document.addEventListener("dragleave", function (ev) {
    ev.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.classList.remove("dragging");
  });
  document.addEventListener("drop", function (ev) {
    ev.preventDefault();
    dragDepth = 0;
    document.body.classList.remove("dragging");
    var files = (ev.dataTransfer && ev.dataTransfer.files) || [];
    for (var i = 0; i < files.length; i++) handleIncomingFile(files[i]);
  });

  attachBtn.addEventListener("click", function () {
    try {
      var res = window.cep.fs.showOpenDialogEx(
        true, false, "Select image, video or document references", null,
        IMAGE_EXT.concat(VIDEO_EXT).concat(DOC_EXT)
      );
      if (res && res.data && res.data.length) {
        res.data.forEach(function (p) { addAttachmentPath(p); });
      }
    } catch (e) {
      addStatus("Could not open file dialog: " + e.message, "error");
    }
  });

  // ---------- AE bridge ----------
  function getCompContext(cb) {
    var jsx =
      '(function () {' +
      '  try {' +
      '    var c = app.project.activeItem;' +
      '    if (!(c && c instanceof CompItem)) return "NONE";' +
      '    var s = "Comp \\"" + c.name + "\\": " + c.width + "x" + c.height + ", " + c.duration.toFixed(2) + "s @ " + c.frameRate + "fps, playhead at " + c.time.toFixed(2) + "s. Layers (index: name):";' +
      '    var parts = [];' +
      '    var n = c.numLayers; if (n > 50) n = 50;' +
      '    for (var i = 1; i <= n; i++) {' +
      '      var L = c.layer(i);' +
      '      var tag = "";' +
      '      try { if (L.selected) tag = " [selected]"; } catch (e) {}' +
      '      parts.push(" " + i + ": " + L.name + tag);' +
      '    }' +
      '    if (c.numLayers > 50) parts.push(" …and " + (c.numLayers - 50) + " more layers");' +
      '    return s + parts.join(";");' +
      '  } catch (e) { return "NONE"; }' +
      '})()';
    csInterface.evalScript(jsx, function (res) {
      cb(res === CSInterface.EVAL_SCRIPT_ERROR ? "NONE" : res);
    });
  }

  function execInAE(code, cb) {
    var wrapped =
      '(function () {' +
      '  try {' +
      '    app.beginUndoGroup("Claude Edit");' +
      '    var __r = eval(' + JSON.stringify(code) + ');' +
      '    app.endUndoGroup();' +
      '    return "OK::" + String(__r);' +
      '  } catch (e) {' +
      '    try { app.endUndoGroup(); } catch (ignored) {}' +
      '    var line = "";' +
      '    try { if (e.line) line = " (line " + e.line + ")"; } catch (ignored2) {}' +
      '    return "ERR::" + e.toString() + line;' +
      '  }' +
      '})()';
    csInterface.evalScript(wrapped, function (res) {
      if (res === CSInterface.EVAL_SCRIPT_ERROR) {
        cb(false, "After Effects could not evaluate the script (EvalScript error).");
      } else if (res && res.indexOf("OK::") === 0) {
        editsSincePrompt++; // one undo group per executed script
        cb(true, res.substring(4));
      } else if (res && res.indexOf("ERR::") === 0) {
        editsSincePrompt++; // a failed script may still have partially changed the comp
        cb(false, res.substring(5));
      } else {
        cb(false, "Unexpected response from After Effects: " + res);
      }
    });
  }

  // ---------- AE connector (MCP bridge) ----------
  // mcp/ae-mcp.js is spawned by the Claude CLI and forwards tools/call
  // requests here over localhost HTTP. Calls are serialized: evalScript runs
  // on AE's UI thread, and Ask mode may hold a call open on the permission bar.
  var EXT_ROOT = "";
  try { EXT_ROOT = csInterface.getSystemPath(SystemPath.EXTENSION); } catch (e) { }
  var MCP_SERVER = EXT_ROOT ? path.join(EXT_ROOT, "mcp", "ae-mcp.js") : "";
  // On Mac the extension lives under "…/Application Support/…" — a path with
  // a space. The CLI reads the connector path from mcp-config.json, and some
  // CLI builds shell-join that command line, which breaks on the space (the
  // panel's own preflight spawn works, the CLI's doesn't). So on Mac the
  // connector runs from a copy in the space-free work dir. Windows keeps the
  // in-place path — proven working there.
  var MCP_SERVER_RUN = MCP_SERVER;
  if (IS_MAC && MCP_SERVER) {
    try {
      ensureDirs();
      var mcpCopy = path.join(WORK_DIR, "ae-mcp.js");
      fs.writeFileSync(mcpCopy, fs.readFileSync(MCP_SERVER));
      MCP_SERVER_RUN = mcpCopy;
    } catch (e) { }
  }
  var MCP_CONFIG = path.join(WORK_DIR, "mcp-config.json");
  var SETTINGS_FILE = path.join(WORK_DIR, "run-settings.json");
  var BRIDGE_TOKEN = (function () {
    try { return req("crypto").randomBytes(16).toString("hex"); }
    catch (e) { return "t" + Math.random().toString(36).slice(2) + Date.now().toString(36); }
  })();
  var bridgePort = 0;
  var toolsUsedThisRun = false;

  // Absolute path to the node binary for mcp-config.json. A bare "node" there
  // breaks whenever claude itself doesn't need node (native binary) but node
  // lives somewhere the CLI's PATH misses (volta/fnm/asdf, GUI-launched AE
  // with a stale environment) — the connector then silently fails to start.
  var NODE_BIN = "";
  var connectorOkFor = ""; // node path that already passed the connector preflight
  (function resolveNodeBin() {
    function apply(p) {
      p = String(p || "").split(/\r?\n/)[0].trim();
      if (!p) return;
      try { if (!fs.existsSync(p)) return; } catch (e) { return; }
      if (NODE_BIN !== p) connectorOkFor = "";
      NODE_BIN = p;
      if (bridgePort) writeMcpConfig();
    }
    try {
      var guesses;
      if (IS_MAC) {
        guesses = ["/usr/local/bin/node", "/opt/homebrew/bin/node", "/opt/local/bin/node",
          path.join(os.homedir(), ".volta", "bin", "node"),
          path.join(os.homedir(), ".asdf", "shims", "node")];
        try {
          var nbNvm = path.join(os.homedir(), ".nvm", "versions", "node");
          var nbVs = fs.readdirSync(nbNvm).sort();
          if (nbVs.length) guesses.unshift(path.join(nbNvm, nbVs[nbVs.length - 1], "bin", "node"));
        } catch (e) { }
      } else {
        guesses = [
          path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"),
          path.join(process.env.LOCALAPPDATA || "", "Programs", "nodejs", "node.exe")];
      }
      for (var nbI = 0; nbI < guesses.length; nbI++) {
        try { if (guesses[nbI] && fs.existsSync(guesses[nbI])) { NODE_BIN = guesses[nbI]; break; } } catch (e) { }
      }
    } catch (e) { }
    // The shell knows best — override the guess with whatever `node` really
    // resolves to for this user.
    try {
      if (IS_MAC) {
        cp.execFile(MAC_SHELL, ["-l", "-c", MAC_PATHS + "command -v node"], { timeout: 15000 },
          function (err, so) { if (!err) apply(so); });
      } else {
        cp.exec('powershell.exe -NoProfile -Command "(Get-Command node.exe -ErrorAction SilentlyContinue).Source"',
          { windowsHide: true, timeout: 15000 }, function (err, so) { if (!err) apply(so); });
      }
    } catch (e) { }
  })();

  /* Mac-only preflight: launch the connector the same way the CLI will
   * (login shell + MAC_PATHS, same node command) and make sure it answers an
   * MCP initialize. The CLI's own failure mode ("Available MCP tools: none")
   * says nothing about WHY — this produces the real reason (node missing,
   * wrong path, connector crash) before claude even starts. Success is cached
   * per node path; failures re-test on every run so a fixed install recovers. */
  function preflightConnector(cb) {
    if (!IS_MAC || !bridgePort) { cb(null); return; }
    var bin = NODE_BIN || "node";
    if (connectorOkFor === bin) { cb(null); return; }
    var done = false, out = "", serr = "", ch = null, timer = null;
    function finish(err) {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try { if (ch && ch.pid) ch.kill(); } catch (e) { }
      if (!err) connectorOkFor = bin;
      cb(err || null);
    }
    var cmd = MAC_PATHS +
      "AE_BRIDGE_PORT=" + bridgePort + " AE_BRIDGE_TOKEN=" + shQuote(BRIDGE_TOKEN) +
      " exec " + shQuote(bin) + " " + shQuote(MCP_SERVER_RUN);
    try {
      ch = cp.spawn(MAC_SHELL, ["-l", "-c", cmd], {});
    } catch (e) {
      finish("could not start the shell for the connector check: " + e.message);
      return;
    }
    timer = setTimeout(function () {
      finish("the connector did not answer within 10s (node command: " + bin + ")");
    }, 10000);
    ch.on("error", function (e) {
      finish("could not launch the connector: " + e.message + " (node command: " + bin + ")");
    });
    ch.stdout.on("data", function (d) {
      out += d.toString("utf8");
      if (out.indexOf("\n") !== -1) {
        finish(out.indexOf('"serverInfo"') !== -1 ? null :
          "the connector gave an unexpected reply: " + out.slice(0, 200));
      }
    });
    ch.stderr.on("data", function (d) { serr += d.toString("utf8"); });
    ch.on("close", function (code) {
      finish("the connector exited before answering (code " + code + ", node command: " + bin + ")" +
        (serr.trim() ? "\nIts error was: " + serr.trim().slice(0, 400) : ""));
    });
    try {
      ch.stdin.write(JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ae-panel-preflight", version: "1" } }
      }) + "\n");
    } catch (e) { }
  }

  var jsxLoaded = false;
  function ensureJsx(cb) {
    if (jsxLoaded) {
      // Another panel sharing After Effects' ExtendScript engine may have redefined the global AE.*
      // helpers since: verify our build stamp and reload if needed.
      csInterface.evalScript('($._motionPilot && typeof AE !== "undefined" && AE.__mp === "motionpilot") ? "ok" : "stale"', function (r) {
        if (r === "ok") { cb(true); return; }
        jsxLoaded = false;
        ensureJsx(cb);
      });
      return;
    }
    var src;
    try {
      src = fs.readFileSync(path.join(EXT_ROOT, "jsx", "bridge.jsx"), "utf8") + "\n" +
        fs.readFileSync(path.join(EXT_ROOT, "jsx", "aekit.jsx"), "utf8");
    } catch (e) { cb(false, "Could not read jsx helpers: " + e.message); return; }
    csInterface.evalScript(src, function (res) {
      jsxLoaded = (res === "loaded");
      cb(jsxLoaded, jsxLoaded ? null : "jsx helpers failed to load in After Effects: " + res);
    });
  }

  function writeMcpConfig() {
    try {
      ensureDirs();
      fs.writeFileSync(MCP_CONFIG, JSON.stringify({
        mcpServers: {
          ae: {
            command: NODE_BIN || "node",
            args: [MCP_SERVER_RUN],
            env: { AE_BRIDGE_PORT: String(bridgePort), AE_BRIDGE_TOKEN: BRIDGE_TOKEN }
          }
        }
      }, null, 2), "utf8");
    } catch (e) { }
  }

  // Hard permission gate, passed via --settings — rewritten before every run
  // because it depends on the generation toggle. Needed because installed
  // skills can declare "allowed-tools: Bash" in their frontmatter (the
  // Higgsfield skills do), which silently self-grants unrestricted Bash.
  // Deny/ask rules outrank ANY allow rule, so: installers & interpreters
  // are denied outright, every other shell command must pass the panel's
  // approval bar (the approve MCP tool) — in Auto mode too — and with the
  // generation toggle OFF the Skill tool itself is denied, so the Higgsfield
  // skills can't even be loaded.
  function writeRunSettings(allowSkill, extraDeny) {
    // Every shell command routes to the approve gate (ask: Bash); the gate runs it
    // straight away in Auto mode unless shellRisk() flags it, and asks in Ask mode.
    var deny = (extraDeny || []).slice();
    if (!genRun && !allowSkill) deny.push("Skill");
    try {
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
        permissions: { deny: deny, ask: ["Bash"] }
      }, null, 2), "utf8");
    } catch (e) { }
  }

  /* Auto mode safety net: why a shell command needs the user's OK, or "" when it
   * can just run. Reads every command in a chain (a && b; c | d), unwraps
   * cmd /c, powershell -Command, bash -c …, and scans inline interpreter code
   * and local script files. Conservative on purpose: a false alarm costs one click. */
  var RISK_CMD = {
    rm: "deletes files", rmdir: "deletes files", del: "deletes files", erase: "deletes files", rd: "deletes files",
    unlink: "deletes files", shred: "deletes files", trash: "deletes files",
    format: "formats a drive", diskpart: "edits disk partitions", mkfs: "formats a drive", fdisk: "edits disk partitions",
    dd: "writes raw disk data", bcdedit: "changes boot settings", vssadmin: "touches system backups", cipher: "wipes disk space",
    wmic: "changes system settings", sfc: "changes system files", dism: "changes system files",
    shutdown: "shuts down or restarts the computer", reboot: "restarts the computer", poweroff: "shuts down the computer",
    halt: "shuts down the computer", logoff: "signs you out",
    reg: "edits the Windows registry", regedit: "edits the Windows registry",
    schtasks: "creates scheduled tasks", sc: "changes Windows services", crontab: "creates scheduled tasks",
    launchctl: "changes system services", systemctl: "changes system services",
    net: "changes users, services or shares", netsh: "changes network or firewall settings",
    takeown: "changes file ownership", icacls: "changes file permissions", cacls: "changes file permissions",
    chown: "changes file ownership", chmod: "changes file permissions", attrib: "changes file attributes",
    sudo: "runs as administrator", runas: "runs as administrator", su: "runs as another user",
    taskkill: "closes running programs", tskill: "closes running programs", kill: "closes running programs",
    pkill: "closes running programs", killall: "closes running programs",
    msiexec: "installs software", setx: "permanently changes environment variables",
    npx: "downloads and runs a package", pnpx: "downloads and runs a package", bunx: "downloads and runs a package",
    ssh: "connects to another computer", scp: "copies files to another computer", sftp: "copies files to another computer",
    ftp: "copies files to another computer", rsync: "syncs files to another location",
    diskutil: "edits disks", csrutil: "changes macOS security settings", spctl: "changes macOS security settings",
    security: "reads or changes the macOS keychain", tmutil: "touches Time Machine backups", pmset: "changes power settings",
    dscl: "changes users", sysadminctl: "changes users", nvram: "changes firmware settings", srm: "deletes files",
    xattr: "removes macOS download protection", defaults: "changes app or system preferences", softwareupdate: "installs system updates",
    installer: "installs software", hdiutil: "mounts or edits disk images", mdutil: "changes Spotlight indexing"
  };
  var RISK_PM = /^(npm|pnpm|yarn|bun|pip|pip3|pipx|uv|conda|mamba|gem|cargo|go|brew|choco|winget|scoop|apt|apt-get|dnf|yum|pacman|port)$/;
  var RISK_PM_SUB = /^(i|in|install|add|ci|uninstall|un|remove|rm|update|upgrade|up|link|global|exec|dlx|x|run|tool)$/i;
  var RISK_INTERP = /^(python|python3|py|pythonw|node|deno|bun|ruby|perl|php|lua|rscript|osascript|wscript|cscript|mshta)$/;
  var RISK_WRAP = /^(cmd|powershell|pwsh|bash|sh|zsh|dash|wsl|start|call|exec|env|nohup|time|nice|xargs|command|builtin|timeout|caffeinate)$/;
  var RISK_CODE = /do shell script|tell application[^\n]*\b(quit|delete)\b|rmtree|unlink|rmSync|rmdirSync|\bremove\s*\(|os\.remove|os\.rmdir|shutil\.move|send2trash|os\.system|subprocess|child_process|execSync|spawnSync|\bexec\s*\(|winreg|ctypes|Remove-Item|requests\.(post|put)|urllib\.request\.urlopen\([^)]*data|fetch\([^)]*method\s*:\s*["'](POST|PUT)/i;
  var RISK_ANY = [
    [/\b(Remove-Item|Clear-Content|Clear-RecycleBin|Format-Volume|Clear-Disk|Initialize-Disk|Remove-Partition)\b|\bri\s+-/i, "deletes or wipes files"],
    [/\b(Stop-Process|Stop-Service|Restart-Service|Restart-Computer|Stop-Computer)\b/i, "stops programs or restarts the computer"],
    [/\b(Set-ItemProperty|New-ItemProperty|Remove-ItemProperty)\b|\b(HKLM|HKCU|HKCR|HKU):|HKEY_/i, "edits the Windows registry"],
    [/\b(Set-ExecutionPolicy|Set-Acl|Set-MpPreference|Add-MpPreference|New-Service|Set-Service|Register-ScheduledTask|New-LocalUser|Add-LocalGroupMember|Enable-PSRemoting|New-NetFirewallRule|Install-Module|Install-Package)\b/i, "changes system settings or installs software"],
    [/\b(Invoke-Expression|iex)\b|\s-e(nc|ncodedcommand)?\s+[A-Za-z0-9+\/=]{16,}|FromBase64String|\|\s*(sh|bash|zsh|iex|pwsh|powershell|python3?|node)\b/i, "runs downloaded or hidden code"],
    [/\b(curl|wget)\b[^|;&\n]*\s(-d|--data[\w-]*|-F|--form|-T|--upload-file|-X\s*(POST|PUT))\b|-Method\s+["']?(Post|Put|Patch)|\s-InFile\b|\bInvoke-RestMethod\b[^|;\n]*-Body\b/i, "uploads data to the internet"],
    [/(\.ssh[\\\/]|\.aws[\\\/]|\.gnupg|id_rsa|id_ed25519|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.credentials\.json|[\\\/]auth\.json|Login Data|Local State|[\\\/]Cookies\b|keychain|Get-Credential|ConvertFrom-SecureString|cmdkey|vaultcmd|\bprintenv\b|\benv:\s*$|Get-ChildItem\s+env:|\bdir\s+env:|\bset\s*$)/i, "reads keys, passwords or credentials"],
    [/([A-Za-z]:[\\\/]+(Windows|Program Files|Program Files \(x86\)|ProgramData)\b|%SystemRoot%|%windir%|%ProgramFiles%|\$env:(windir|SystemRoot|ProgramFiles)|(^|\s)\/(etc|usr|bin|sbin|boot|System|Library)\/)/i, "touches system folders"],
    [/\bgit\s+(push|reset\s+--hard|clean\s+-\w*f|checkout\s+--|branch\s+-D|filter-branch|rebase)\b/i, "rewrites or publishes git history"],
    [/:\(\)\s*\{|\bmv\b[^|;&\n]*\s(\/|~|[A-Za-z]:\\?)\s*$/i, "could damage the system"]
  ];
  function scanScriptFile(word, args) {
    for (var i = 0; i < args.length; i++) {
      var a = args[i].replace(/^["']|["']$/g, "");
      if (!a || a.charAt(0) === "-") continue;
      try {
        var p = path.isAbsolute(a) ? a : path.join(WORK_DIR, a);
        var st = fs.statSync(p);
        if (st.isFile() && st.size < 400000 && RISK_CODE.test(fs.readFileSync(p, "utf8"))) return "runs a script that deletes files, starts programs or uploads data";
      } catch (e) { }
      return "";
    }
    return "";
  }
  function shellRisk(cmd, depth) {
    cmd = String(cmd || "");
    depth = depth || 0;
    if (depth > 4) return "is too deeply nested to check";
    for (var r = 0; r < RISK_ANY.length; r++) if (RISK_ANY[r][0].test(cmd)) return RISK_ANY[r][1];
    // inline interpreter code is checked whole (its own ; and ( would split it below)
    if (/(^|[\s;&|("'])(python3?|py|pythonw|node|deno|bun|ruby|perl|php)(\.exe)?\s+(-\S+\s+)*-(c|e|p|-eval|-print)\b/i.test(cmd) && RISK_CODE.test(cmd))
      return "runs code that deletes files, starts programs or uploads data";
    var segs = cmd.split(/&&|\|\||[;&|\n`]|\$\(|\(|\)/);
    for (var s = 0; s < segs.length; s++) {
      var seg = segs[s].trim();
      if (!seg) continue;
      var toks = seg.match(/"[^"]*"|'[^']*'|\S+/g) || [];
      while (toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0])) toks.shift(); // FOO=bar cmd
      if (!toks.length) continue;
      var word = toks[0].replace(/^["'&.]+|["']$/g, "").split(/[\\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, "");
      var rest = toks.slice(1);
      if (RISK_CMD[word]) return RISK_CMD[word];
      if (RISK_WRAP.test(word)) {
        var inner = rest.filter(function (t, i) { return !(i < 3 && /^[-\/][A-Za-z]/.test(t)); }).join(" ").replace(/^["']|["']$/g, "");
        var why = shellRisk(inner, depth + 1);
        if (why) return why;
        continue;
      }
      if (RISK_PM.test(word)) {
        for (var k = 0; k < rest.length; k++) {
          if (/^-/.test(rest[k])) continue;
          if (RISK_PM_SUB.test(rest[k])) return "installs, removes or runs packages";
          break;
        }
      }
      if (RISK_INTERP.test(word)) {
        var code = rest.join(" ");
        if (/(^|\s)-(c|e|p|-eval|-print|command)\b/i.test(code)) { if (RISK_CODE.test(code)) return "runs code that deletes files, starts programs or uploads data"; }
        else { var sw = scanScriptFile(word, rest); if (sw) return sw; }
      }
    }
    return "";
  }

  var toolQueue = [];
  var toolActive = false;

  function pumpToolQueue() {
    if (toolActive || !toolQueue.length) return;
    toolActive = true;
    var call = toolQueue.shift();
    dispatchTool(call.name, call.args, function (ok, text) {
      toolActive = false;
      // "Good enough" soft stop: piggyback the user's signal on this tool
      // result. Never on approve — the CLI parses that result as pure
      // permission JSON and any extra text would break the gate.
      if (doneSignal && call.name !== "approve") {
        doneSignal = false;
        text = String(text == null ? "" : text) +
          "\n\n[USER SIGNAL — GOOD ENOUGH] The user just pressed the panel's \"✓ Enough\" button: " +
          "the current result already satisfies them. STOP pursuing the rest of your plan. " +
          "Finish ONLY the step already in flight so nothing is left half-applied, render at most ONE " +
          "verification frame if something might be visibly broken, then reply with a one-line summary and END the run. " +
          "Do not start new elements, polish passes, style work or extra renders.";
      }
      try { call.respond(ok, text); } catch (e) { }
      pumpToolQueue();
    });
  }

  function flushToolQueue(reason) {
    var pending = toolQueue;
    toolQueue = [];
    pending.forEach(function (c) { try { c.respond(false, reason); } catch (e) { } });
  }

  function addFramePreview(p, t) {
    hideEmpty();
    var div = document.createElement("div");
    div.className = "msg claude frame-prev";
    var img = document.createElement("img");
    var src = fileUrl(p);
    var cap = document.createElement("div");
    cap.className = "fp-cap";
    cap.textContent = (typeof t === "string" && /[a-z]/i.test(t)) ? t : "Frame @ " + t + "s";
    // AE may still be flushing the PNG when this renders live — retry with a
    // cache-buster so the thumb appears during the session, not just on reload.
    var tries = 0, maxTries = replaying ? 1 : 12;
    img.onerror = function () {
      if (++tries < maxTries) {
        setTimeout(function () { img.src = src + "?r=" + tries; }, 350);
      } else {
        removeEl(img);
        cap.textContent = "Frame @ " + t + "s (file no longer available)";
      }
    };
    img.onload = scrollDownIfNear; // late load grows the page — keep view pinned
    img.src = src;
    div.appendChild(img);
    div.appendChild(cap);
    appendToChat(div);
    record({ type: "frame", path: p, t: t });
  }

  /* Row of contact-sheet thumbnails after a Recreate pre-render. */
  function addSheetsMsg(dir, names) {
    hideEmpty();
    var div = document.createElement("div");
    div.className = "msg claude sheets";
    var cap = document.createElement("div");
    cap.className = "fp-cap";
    cap.textContent = "Reference contact sheets (" + names.length + ") — click to enlarge";
    var wrap = document.createElement("div");
    wrap.className = "thumbs";
    names.forEach(function (n) {
      var img = document.createElement("img");
      img.src = fileUrl(path.join(dir, n));
      img.onerror = function () { img.style.display = "none"; };
      wrap.appendChild(img);
    });
    div.appendChild(cap);
    div.appendChild(wrap);
    appendToChat(div);
    record({ type: "sheets", dir: dir, names: names });
  }

  function dispatchTool(name, args, done) {
    if (name === "get_state") {
      ensureJsx(function (ok, err) {
        if (!ok) { done(false, err); return; }
        addStatus("🔍 Reading composition state", "log");
        var idx = (args && typeof args.layer_index === "number") ? Math.floor(args.layer_index) : 0;
        var mode = (args && args.detail === "full") ? "full" : "summary";
        csInterface.evalScript('$._motionPilot.state(' + idx + ',"' + mode + '")', function (res) {
          if (res === CSInterface.EVAL_SCRIPT_ERROR) done(false, "After Effects could not read the comp state.");
          else done(true, res);
        });
      });

    } else if (name === "ae_info" || name === "inspect_properties") {
      ensureJsx(function (ok, err) {
        if (!ok) { done(false, err); return; }
        var call;
        if (name === "ae_info") {
          addStatus("🧩 Checking After Effects capabilities", "log");
          var q = (args && typeof args.effects === "string") ? args.effects : "";
          call = "$._motionPilot.caps()" + (q ? " + \"\\n\\n\" + $._motionPilot.effectsList(" + JSON.stringify(q === "*" ? "" : q) + ", 160)" : "");
        } else {
          var li = (args && typeof args.layer_index === "number") ? Math.floor(args.layer_index) : 0;
          var ln = (args && typeof args.layer_name === "string") ? args.layer_name : "";
          var dp = (args && typeof args.depth === "number") ? Math.max(1, Math.min(6, Math.floor(args.depth))) : 3;
          addStatus("🔎 Inspecting properties of layer " + (li || JSON.stringify(ln)) + (args && args.path ? " › " + args.path : ""), "log");
          call = "$._motionPilot.inspect(" + li + "," + JSON.stringify(ln) + "," + JSON.stringify((args && args.path) || "") + "," + dp + ")";
        }
        csInterface.evalScript(call, function (res) {
          if (res === CSInterface.EVAL_SCRIPT_ERROR) done(false, "After Effects could not answer " + name + ".");
          else done(true, res);
        });
      });

    } else if (name === "render_frame") {
      var tlist = (args && args.times && args.times.length) ? args.times.filter(function (x) { return typeof x === "number" && x >= 0; }).slice(0, 12) : [];
      if (tlist.length > 1) {
        ensureJsx(function (ok, err) {
          if (!ok) { done(false, err); return; }
          ensureDirs();
          addStatus("🖼 Rendering " + tlist.length + " frames → one proof sheet (" + tlist.join("s, ") + "s)", "log");
          var shots = [], bad = [];
          (function next(i) {
            if (i >= tlist.length) {
              if (!shots.length) { done(false, "Could not render any frame: " + bad.join("; ")); return; }
              proofSheet(shots, function (sheet) {
                var lines = shots.map(function (sh) { return "  t=" + sh.t + "s → " + sh.file; }).join("\n");
                if (sheet) addFramePreview(sheet, "Proof sheet · " + shots.length + " frames");
                done(true, (sheet ? "Proof sheet (" + shots.length + " frames, labelled by time, left→right, top→bottom): " + sheet + " — view THIS one image with the " + viewTool() + " tool.\n" : "Proof sheet could not be built — view the frames below.\n") +
                  "Full-size frames (open one only for a close look — small type, edges, a seam):\n" + lines + (bad.length ? "\nFailed: " + bad.join("; ") : ""));
              });
              return;
            }
            frameSeq++;
            var f = path.join(WORK_DIR, "frame-" + Date.now() + "-" + frameSeq + ".png");
            csInterface.evalScript('$._motionPilot.renderFrame(' + tlist[i] + ', "' + f.replace(/\\/g, "/") + '")', function (res) {
              if (res && res.indexOf("OK::") === 0) shots.push({ t: res.substring(4), file: f });
              else bad.push("t=" + tlist[i] + ": " + ((res && res.indexOf("ERR::") === 0) ? res.substring(5) : res));
              next(i + 1);
            });
          })(0);
        });
        return;
      }
      if (tlist.length === 1 && !(args && typeof args.time === "number")) args.time = tlist[0];
      ensureJsx(function (ok, err) {
        if (!ok) { done(false, err); return; }
        ensureDirs();
        var t = (args && typeof args.time === "number") ? args.time : -1;
        // seq suffix: batched render_frame calls can land in the same millisecond
        frameSeq++;
        var file = path.join(WORK_DIR, "frame-" + Date.now() + "-" + frameSeq + ".png");
        addStatus("🖼 Rendering preview frame" + (t >= 0 ? " at " + t + "s" : ""), "log");
        csInterface.evalScript('$._motionPilot.renderFrame(' + t + ', "' + file.replace(/\\/g, "/") + '")', function (res) {
          if (res && res.indexOf("OK::") === 0) {
            var shownT = res.substring(4);
            addFramePreview(file, shownT);
            done(true, "Frame at t=" + shownT + "s saved to " + file +
              " — view it with the " + viewTool() + " tool (rendered several frames? view them ALL in one parallel batch) and fix anything that looks wrong before finishing.");
          } else {
            done(false, (res && res.indexOf("ERR::") === 0) ? res.substring(5) : "Could not render the frame: " + res);
          }
        });
      });

    } else if (name === "run_script") {
      var script = args && args.script;
      if (!script || typeof script !== "string") { done(false, "run_script needs a 'script' string argument."); return; }
      var desc = (args && args.description) || "Run a script in After Effects";
      addScriptCard(script);
      var execNow = function () {
        ensureJsx(function () { // load helpers so scripts can use AE.* / $._motionPilot.ease()
          addStatus("⚙ " + desc, "log");
          execInAE(script, function (ok, result) {
            if (ok) {
              addStatus("✓ " + (result && result !== "undefined" ? result : "Done."), "ok");
              // Append a one-line comp digest so the model rarely needs get_state.
              csInterface.evalScript("$._motionPilot.digest()", function (dg) {
                var extra = (dg && dg !== CSInterface.EVAL_SCRIPT_ERROR) ? "\nState now: " + dg : "";
                done(true, "OK. Script returned: " + result + extra);
              });
            } else {
              addStatus("✗ AE error: " + result, "error");
              done(false, "After Effects threw an error: " + result + " — fix the script and call run_script again.");
            }
          });
        });
      };
      if (modeEl.value === "ask") {
        showPermBar(
          desc + " — run this script in After Effects?",
          "Run in AE",
          execNow,
          function () {
            addStatus("Script declined.", "log");
            done(false, "The user declined to run this script. Adjust your approach or ask them (in plain text) how to proceed; do not retry the identical script.");
          },
          function () {
            done(false, "This script was superseded — the run was stopped or a new message arrived.");
          }
        );
      } else {
        execNow();
      }

    } else if (name === "generate_image") {
      var giPrompt = (args && typeof args.prompt === "string") ? args.prompt.trim() : "";
      var giName = sanitizeName((args && args.name) || "asset").slice(0, 40) || "asset";
      var giAspect = (args && args.aspect) || "square";
      var giQ = (args && /^(low|medium|high)$/.test(String(args.quality || ""))) ? String(args.quality) : "medium";
      var giRefs = [];
      try { (args && args.refs || []).forEach(function (p) { if (typeof p === "string" && fs.existsSync(p)) giRefs.push(p); }); } catch (e) { }
      if (!giPrompt) { done(false, "generate_image needs a 'prompt' string."); return; }
      var giSize = giAspect === "landscape" ? "1536x1024" : giAspect === "portrait" ? "1024x1536" : "1024x1024";
      function giFallback(reason) {
        addStatus("⚠ GPT Image 2 unavailable — " + reason + ".", "err");
        done(false, "GPT Image 2 is unavailable: " + reason + ". Do not retry it." + (genRun ? " Use Higgsfield (higgsfield-generate skill) for this asset instead," : " Build a clean placeholder from shapes/solids/text (or use a Bin asset),") + " and tell the user in one line.");
      }
      var giRun = function () {
        checkCodex(function (ok, why) {
          if (!ok) { giFallback(why === 52 ? "the Codex CLI is not signed in" : "the Codex CLI is not installed"); return; }
          ensureCacheRoot();
          var giDir = path.join(CACHE_ROOT, "_gen");
          try { if (!fs.existsSync(giDir)) fs.mkdirSync(giDir); } catch (e) { }
          var giOut = path.join(giDir, giName + "-" + Date.now() + ".png");
          var giSince = Date.now() - 1000;
          var giShort = giPrompt.replace(/\s+/g, " ");
          if (giShort.length > 70) giShort = giShort.substring(0, 70) + "…";
          var giTicker = addTicker("GPT Image 2 (" + giQ + ") — generating \"" + giShort + "\"…");
          var giP = "$imagegen\n" +
            "Please make one image for me with your image tool, " + giSize + " pixels, " + giQ + " quality.\n\n" +
            (giRefs.length ? "The attached image is the reference. Keep its composition and elements; change only what the description asks for.\n\n" : "") +
            giPrompt + "\n\n" +
            "Save the PNG at " + giOut + " (copy it there if your tool wrote it elsewhere) and reply with only that path.";
          runCodexRaw(giP, { model: imgDriver(), effort: IMG_EFFORT[giQ] || "medium", withMcp: false, images: giRefs, cwd: giDir, nested: true, log: false },
            function (ev) { if (ev.kind === "usage") addTokenUsage(ev.usage); },
            function (err, res) {
              giTicker.stop();
              if (err === "CANCELLED") { done(false, "The generation was cancelled by the user."); return; }
              if (err === "CODEX_MISSING" || err === "CODEX_SIGNED_OUT") { giFallback(err === "CODEX_MISSING" ? "the Codex CLI is not installed" : "the Codex CLI is not signed in"); return; }
              if (err && /usage limit|rate limit/i.test(String(err))) { giFallback("the ChatGPT plan's Codex usage limit is reached — " + String(err).replace(/^⚠ Codex usage limit reached — /, "").split("\n")[0]); return; }
              if (err) {
                addStatus("✗ GPT Image 2 failed: " + String(err).split("\n")[0], "error");
                done(false, "GPT Image 2 failed: " + String(err).split("\n")[0] + ". Do not retry the same call; use a placeholder built from shapes/text or a Bin asset and tell the user.");
                return;
              }
              var giPath = locateFrame(giOut, res.allText || res.text, giDir, giSince);
              if (!giPath) { done(false, "GPT finished but no image file was produced. Do not retry; use a placeholder and tell the user."); return; }
              addFramePreview(giPath, "Generated asset: " + giName + " (GPT Image 2, " + giQ + ")");
              done(true, "Image saved to " + giPath + " — import it with AE.importAsset(" + JSON.stringify(giPath) + ",{place:true,fit:\"contain\"}). " +
                "If it was generated on a key-colour background, follow with AE.keyOut(layer,\"#00FF00\") (use the key colour you asked for), then render_frame once to check edges.");
            });
        });
      };
      if (modeEl.value === "ask") {
        showPermBar(
          "GPT Image 2 — \"" + (giPrompt.length > 140 ? giPrompt.substring(0, 140) + "…" : giPrompt) + "\" — generate?",
          "Generate",
          giRun,
          function () {
            addStatus("Declined: GPT Image 2 generation.", "log");
            done(false, "The user declined this image generation. Do not retry it; build a placeholder from shapes/text or ask them in plain text.");
          },
          function () { done(false, "This generation was superseded — the run was stopped or a new message arrived."); }
        );
      } else {
        giRun();
      }

    } else if (name === "get_skill") {
      var skName = (args && args.name) || "";
      var stylePacks = (BRAIN && BRAIN.skills) || {};
      if (skName === "effects") {
        addStatus("📚 Loaded skill pack: effects catalog", "log");
        done(true, fxCatalog());
      } else if (skName === "animation-principles") {
        addStatus("📚 Loaded skill pack: animation principles", "log");
        done(true, animPrinciples());
      } else if (stylePacks[skName] && SECTIONED[skName] && (args.section || lastRunRoom)) {
        var sk = skillSections(stylePacks[skName]), want = String(args.section || "").toLowerCase().trim();
        if (!want || !sk.list.length) {
          addStatus("📚 Skill index: " + skName, "log");
          done(true, sk.head + "\n\nSECTIONS (fetch with get_skill(\"" + skName + "\", section), or section \"all\"): " + sk.list.map(function (x) { return x.title; }).join(" · ") +
            (sk.pick ? "\n\n" + sk.pick.body : ""));
        } else if (want === "all") {
          addStatus("📚 Loaded skill pack: " + skName + " (all)", "log");
          done(true, stylePacks[skName]);
        } else {
          var hit = sk.list.filter(function (x) { return x.title.toLowerCase().indexOf(want) !== -1; });
          if (!hit.length) { done(false, "No section \"" + args.section + "\" in " + skName + ". Sections: " + sk.list.map(function (x) { return x.title; }).join(" · ")); return; }
          addStatus("📚 Loaded skill section: " + skName + " › " + hit.map(function (x) { return x.title; }).join(", "), "log");
          done(true, hit.map(function (x) { return x.body; }).join("\n\n"));
        }
      } else if (stylePacks[skName]) {
        addStatus("📚 Loaded skill pack: " + skName, "log");
        done(true, stylePacks[skName]);
      } else {
        var availPacks = ["effects", "animation-principles"];
        for (var pk in stylePacks) availPacks.push(pk);
        done(false, 'Unknown skill pack "' + skName + '". Available: "' + availPacks.join('", "') + '".');
      }


    } else if (name === "approve") {
      // Permission gate for Ask mode: the CLI calls this (via --permission-prompt-tool)
      // for any tool outside the allowlist — chiefly Bash higgsfield generations.
      // The reply must be the CLI's permission JSON, sent as a SUCCESSFUL tool result.
      var apToolName = (args && args.tool_name) || "a tool";
      var apInput = (args && typeof args.input === "object" && args.input) || {};
      var apCmd = "";
      try { apCmd = String(apInput.command || ""); } catch (e) { }
      var apPreview = "";
      try { apPreview = apCmd || String(apInput.skill || apInput.file_path || JSON.stringify(apInput)); } catch (e1) { }
      if (apPreview.length > 180) apPreview = apPreview.substring(0, 180) + "…";
      var isHF = /higgsfield|(^|[;&|]\s*)hf\s/i.test(apCmd);
      var apAllow = function () {
        addStatus("✔ Approved: " + (isHF ? "Higgsfield command" : apToolName), "log");
        done(true, JSON.stringify({ behavior: "allow", updatedInput: apInput }));
      };
      if (isHF && !hfUsable()) {
        addStatus("✗ Higgsfield command refused — the CLI is " + (hgCheck.why === 42 ? "not signed in." : "not installed."), "err");
        done(true, JSON.stringify({ behavior: "deny", message: "Higgsfield is not available on this machine (CLI " + (hgCheck.why === 42 ? "not signed in" : "not installed") + "). Do NOT retry Higgsfield. Source a free asset from the web or build the element from vector shapes/text instead." }));
        return;
      }
      var apText, apLabel;
      if (isHF) {
        // Higgsfield ALWAYS asks — Auto mode included — showing model + prompt,
        // so expensive models can be declined before any money is spent.
        var jm = apCmd.match(/(?:generate\s+create|workflow\s+run)\s+([A-Za-z0-9_.-]+)/i);
        var hfModel = jm ? jm[1] : "";
        var pm = apCmd.match(/--prompt[= ]+(?:\\?"((?:[^"\\]|\\.)*)\\?"|'([^']*)'|(\S+))/i);
        var hfPrompt = pm ? (pm[1] || pm[2] || pm[3]) : "";
        if (hfPrompt.length > 300) hfPrompt = hfPrompt.substring(0, 300) + "…";
        apText = "Higgsfield" + (hfModel ? " [" + hfModel + "]" : "") +
          (hfPrompt ? ' — "' + hfPrompt + '"' : " — " + apPreview) + " — send it?";
        apLabel = "Generate";
      } else {
        // Ask mode: every non-allowlisted tool asks. Auto mode: it just runs,
        // unless shellRisk() flags the command as risky — then it asks too.
        var apRisk = apCmd ? shellRisk(apCmd) : "";
        if (modeEl.value === "auto" && !apRisk) {
          addStatus("▸ Ran " + (apCmd ? "command: " + apPreview : apToolName), "log");
          done(true, JSON.stringify({ behavior: "allow", updatedInput: apInput }));
          return;
        }
        apText = (apRisk ? "⚠ This command " + apRisk + ". " : "") + "The model wants to run " +
          (apCmd ? "a command: " + apPreview : apToolName + (apPreview ? ": " + apPreview : "")) + " — allow?";
        apLabel = apRisk ? "Allow anyway" : "Allow";
      }
      showPermBar(
        apText,
        apLabel,
        function () { apAllow(); },
        function () {
          addStatus("Denied: " + (isHF ? "Higgsfield generation" : apToolName), "log");
          done(true, JSON.stringify({ behavior: "deny", message: "The user declined this " + (isHF ? "Higgsfield generation" : apToolName + " call") + ". " +
            (isHF ? "Do NOT retry Higgsfield for this asset: source a free asset from the web (WebSearch/WebFetch, download with a Bash curl the user approves) or build the element yourself as vector shape layers, then continue." : "Adjust your approach or ask them in plain text; do not retry the identical call.") }));
        },
        function () {
          done(true, JSON.stringify({ behavior: "deny", message: "Superseded — the run was stopped or a new message arrived." }));
        }
      );

    } else {
      done(false, "Unknown tool: " + name);
    }
  }

  // Start the connector defensively: any failure here just leaves
  // bridgePort at 0, which switches runs to the single-script fallback.
  try {
    if (!http || !MCP_SERVER) throw new Error(http ? "extension path unavailable" : "http module unavailable");
    var bridgeServer = http.createServer(function (rq, rs) {
      if (rq.method !== "POST" || rq.url !== "/call" || rq.headers["x-motionpilot-token"] !== BRIDGE_TOKEN) {
        rs.writeHead(403);
        rs.end();
        return;
      }
      var body = "";
      rq.on("data", function (d) {
        body += d;
        if (body.length > 4 * 1024 * 1024) rq.destroy();
      });
      rq.on("end", function () {
        var msg;
        try { msg = JSON.parse(body); } catch (e) { rs.writeHead(400); rs.end(); return; }
        rs.setTimeout(0); // Ask mode can hold this open for minutes
        toolsUsedThisRun = true;
        toolQueue.push({
          name: msg.name,
          args: msg.args || {},
          respond: function (ok, text) {
            try {
              rs.writeHead(200, { "Content-Type": "application/json" });
              rs.end(JSON.stringify({ ok: !!ok, text: String(text == null ? "" : text) }));
            } catch (e) { }
          }
        });
        pumpToolQueue();
      });
    });
    bridgeServer.on("error", function (e) {
      bridgePort = 0;
      addStatus("AE connector could not start (" + e.message + ") — falling back to single-script mode.", "error");
    });
    bridgeServer.listen(0, "127.0.0.1", function () {
      bridgePort = bridgeServer.address().port;
      writeMcpConfig();
    });
  } catch (e) {
    bridgePort = 0;
    addStatus("AE connector unavailable (" + e.message + ") — using single-script mode.", "error");
  }

  /* Video references (any task): import the file into the Bin, wrap it in a temp
   * comp, run the sampling pipeline on it (adaptive frames + motion map +
   * contact sheets), import the sheets into the Bin folder "Reference Sheets",
   * drop the temp comp. The model then works from the sheets — in the prompt
   * and in the Bin — exactly like Claude/ChatGPT "watch" a video. */
  function prepVideoRefs(refs, cb) {
    var vids = (refs || []).filter(function (r) { return !r.isImage && !r.isDoc && !r.isSheet && !r.sheetsDone; });
    if (!vids.length) { cb(); return; }
    var i = 0;
    function next() {
      if (i >= vids.length) { cb(); return; }
      var v = vids[i++];
      v.sheetsDone = true;
      var base = path.basename(v.path).replace(/\.[^.]+$/, "");
      var tmpComp = "_ref " + base.slice(0, 40);
      var ticker = addTicker("🎞 Reference video \"" + base + "\" — importing, sampling, building contact sheets…");
      ensureJsx(function (ok, jerr) {
        if (!ok) { ticker.stop(); addStatus("⚠ Could not prepare the reference video: " + (jerr || "bridge not loaded"), "err"); next(); return; }
        evalBridge("$._motionPilot.importRefVideo(" + JSON.stringify(v.path.replace(/\\/g, "/")) + "," + JSON.stringify(tmpComp) + ")", function (err, info) {
          if (err) { ticker.stop(); addStatus("⚠ Reference video import failed: " + err, "err"); next(); return; }
          var parts = String(info).split("|");
          var compName = parts[0] || tmpComp, itemName = parts[5] || base;
          runRecreatePipeline(compName, function (perr, rec) {
            function cleanup(done2) { evalBridge("$._motionPilot.removeComp(" + JSON.stringify(compName) + ")", function () { done2(); }); }
            if (perr) { ticker.stop(); addStatus("⚠ Contact sheets failed for \"" + base + "\": " + perr, "err"); cleanup(next); return; }
            var m = rec.motion || {};
            var sheets = (m.sheets || []).map(function (nm) { return path.join(rec.dir, nm); });
            if (!sheets.length) { ticker.stop(); addStatus("⚠ No contact sheets were produced for \"" + base + "\".", "err"); cleanup(next); return; }
            evalBridge("$._motionPilot.importSheets(" + JSON.stringify(sheets.map(function (p) { return p.replace(/\\/g, "/"); }).join("|")) + "," + JSON.stringify("REF " + base.slice(0, 30)) + ")", function (ierr, namesStr) {
              var binNames = (!ierr && namesStr) ? String(namesStr).split("|") : [];
              cleanup(function () {
                ticker.stop();
                v.sheetSource = true; // listed in the prompt as "turned into sheets", never as "cannot be viewed"
                sheets.forEach(function (sp, k) {
                  refs.push({ path: sp, name: path.basename(sp), isImage: true, isSheet: true, video: base, binName: binNames[k] || "", index: k + 1, count: sheets.length,
                    fps: rec.fps, w: rec.w, h: rec.h, dur: rec.dur, totalFrames: rec.totalFrames, motionFile: rec.motionFile, motion: k === 0 ? m : null });
                });
                addStatus("🎞 \"" + base + "\" → " + sheets.length + " contact sheet(s)" + (binNames.length ? " (Bin › Reference Sheets)" : "") + " · " + motionSummary(m), "ok");
                next();
              });
            });
          });
        });
      });
    }
    next();
  }

  // ---------- Recreate pipeline (renders reference videos into contact sheets) ----------
  // Pre-render the reference comp into Documents\MotionPilot\<project>\<comp>\
  // in two passes — pass 1 samples uniformly, pass 2 renders EVERY frame inside
  // the high-motion ranges pass 1 found — then a panel-side canvas pass builds
  // the motion map: pixel-change per frame (cuts / peaks / holds) PLUS the
  // changed-region center per frame (the position track — motion as numbers,
  // so the model fits easing curves instead of eyeballing 100+ images).
  // AE flushes PNGs asynchronously, so analysis never starts until every file
  // exists with a stable size, and any unreadable frame fails the run loudly
  // (a silent zero here once produced an empty motion map).
  var PASS1_MAX = 100;   // pass 1: uniform sampling budget
  var DENSE_MAX = 150;   // pass 2: extra every-frame renders inside high-motion ranges

  // One fixed, user-findable cache root; per-project subfolders inside it so a
  // single project's frames/checkpoints can be deleted without touching the rest.
  var CACHE_ROOT = (function () {
    var docs = "";
    try { docs = csInterface.getSystemPath(SystemPath.MY_DOCUMENTS); } catch (e) { }
    if (!docs) { try { docs = path.join(os.homedir(), "Documents"); } catch (e2) { } }
    return path.join(docs || WORK_DIR, "MotionPilot");
  })();

  function ensureCacheRoot() {
    try {
      if (!fs.existsSync(CACHE_ROOT)) fs.mkdirSync(CACHE_ROOT, { recursive: true });
      var rd = path.join(CACHE_ROOT, "README.txt");
      if (!fs.existsSync(rd)) {
        fs.writeFileSync(rd,
          "Working files for the MotionPilot panel.\r\n" +
          "One folder per project: rendered reference frames + motion.json (Recreate mode)\r\n" +
          "and _checkpoints (copies of your .aep taken before each prompt edits it).\r\n" +
          "Safe to delete — anything needed again is simply re-rendered.\r\n", "utf8");
      }
    } catch (e) { }
  }

  function sanitizeName(s) {
    return String(s).replace(/[^a-z0-9-_ ]/gi, "").replace(/\s+/g, "-").substring(0, 40) || "comp";
  }

  function shortId(s) { // stable suffix so same-named projects get separate folders
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36).substring(0, 5);
  }

  function projectCacheDir(aepFullPath, aepName) {
    var label = aepName ? sanitizeName(String(aepName).replace(/\.aep$/i, "")) : "unsaved-project";
    return path.join(CACHE_ROOT, label + "-" + shortId(aepFullPath || "unsaved"));
  }

  function framePath(dir, fn) {
    var s = "" + fn;
    while (s.length < 5) s = "0" + s;
    return path.join(dir, "f-" + s + ".png");
  }

  function evalBridge(call, cb) { // evalScript with the OK::/ERR:: convention
    csInterface.evalScript(call, function (res) {
      if (res === CSInterface.EVAL_SCRIPT_ERROR) cb("After Effects could not run the bridge call.");
      else if (res && res.indexOf("OK::") === 0) cb(null, res.substring(4));
      else if (res && res.indexOf("ERR::") === 0) cb(res.substring(5));
      else cb(null, res);
    });
  }

  /* Project-state first: list every comp in the project, so the typed names
   * are validated (and case-corrected) against reality before anything renders. */
  function fetchComps(cb) { // cb(list, errMsg) — errors are surfaced, never swallowed
    ensureJsx(function (ok, jerr) {
      if (!ok) { cb([], jerr || "The AE-side helpers failed to load."); return; }
      csInterface.evalScript('($._motionPilot && $._motionPilot.listComps) ? $._motionPilot.listComps() : "OLD"', function (res) {
        if (res === "OLD") {
          cb([], "After Effects is still running an older AE-side bridge — restart After Effects, then try again.");
          return;
        }
        if (res === CSInterface.EVAL_SCRIPT_ERROR) {
          cb([], "After Effects could not list the project comps (EvalScript error).");
          return;
        }
        var list = [];
        if (res && res !== "NONE") {
          res.split(";;").forEach(function (row) {
            var q = row.split("|");
            if (q.length >= 4) {
              var name = q[0];
              try { name = decodeURIComponent(q[0]); } catch (e) { }
              list.push({ name: name, size: q[1], dur: q[2], fps: q[3] });
            }
          });
        }
        cb(list, null);
      });
    });
  }

  function resolveCompName(comps, typed) {
    for (var i = 0; i < comps.length; i++) if (comps[i].name === typed) return { name: typed };
    var low = typed.toLowerCase(), ci = [];
    for (var j = 0; j < comps.length; j++) if (comps[j].name.toLowerCase() === low) ci.push(comps[j].name);
    if (ci.length === 1) return { name: ci[0], corrected: true };
    return null;
  }

  function runRecreatePipeline(refComp, cb) {
    ensureJsx(function (ok, jerr) {
      if (!ok) { cb(jerr || "Could not load the AE helpers."); return; }
      var probe = '($._motionPilot && $._motionPilot.projInfo) ? $._motionPilot.projInfo() : "ERR::OUTDATED"';
      evalBridge(probe, function (perr, pinfo) {
        if (perr) {
          cb(perr === "OUTDATED"
            ? "After Effects is still running an older AE-side bridge — fully restart After Effects, reopen the project and the panel, then try again."
            : perr);
          return;
        }
        var pi = String(pinfo).split("|");
        var aepName = pi[1] || "";
        var itemCount = pi[2] || "0";
        var compCount = parseInt(pi[3], 10) || 0;
        var aepFull = pi[4] || "";
        // Read the project state FIRST and show it — every failure after this
        // line can name exactly what AE sees.
        addStatus("📁 Project: " + (aepName || "(unsaved)") + " — " + itemCount + " items, " + compCount + " comps", "log");
        if (!compCount) {
          cb("After Effects reports 0 comps in the open project — is the right project open? Check the Project panel.");
          return;
        }
        fetchComps(function (comps, cerr) {
          if (cerr) { cb(cerr); return; }
          if (!comps.length) {
            cb("AE reports " + compCount + " comps but listing them returned nothing — restart After Effects and try again.");
            return;
          }
          var names = comps.map(function (c) { return c.name; });
          var shown = names.slice(0, 12).join(" · ") + (names.length > 12 ? " · …+" + (names.length - 12) + " more" : "");
          addStatus("📋 Project comps: " + shown, "log");
          var rr = resolveCompName(comps, refComp);
          if (!rr) {
            cb('No comp named "' + refComp + '" in this project. Comps found: ' + shown);
            return;
          }
          if (rr.corrected) addStatus('✎ Reference matched "' + rr.name + '" (case-corrected)', "log");
          refComp = rr.name;
          evalBridge("$._motionPilot.refInfo(" + JSON.stringify(refComp) + ")", function (err, infoStr) {
            if (err) { cb(err); return; }
            var p = infoStr.split("|");
            var totalFrames = parseInt(p[0], 10) || 1;
            var fps = parseFloat(p[1]) || 30;
            var dur = parseFloat(p[2]) || 0;
            var w = parseInt(p[3], 10) || 1920;
            var h = parseInt(p[4], 10) || 1080;
            var matches = parseInt(p[5], 10) || 1;
            // Show exactly what AE resolved, so a wrong/duplicate comp is
            // obvious immediately instead of surfacing as a cryptic timeout.
            addStatus('📐 Reference "' + refComp + '": ' + w + "x" + h + ", " + dur.toFixed(2) + "s @ " + fps +
              "fps → " + totalFrames + " frames" +
              (matches > 1 ? " · ⚠ " + matches + " comps share this name — using the first one found" : ""), "log");
            if (totalFrames < 8) {
              cb('Reference comp "' + refComp + '" is only ' + totalFrames + " frame(s) long (" + dur.toFixed(3) +
                "s @ " + fps + "fps) — that can't be an animation reference. The typed name matched " +
                (matches > 1 ? matches + " comps and the first one is this stub — rename them uniquely" : "this comp") +
                ", so check the Project panel: you may have a duplicate or wrong comp under that name (names are case-sensitive).");
              return;
            }
            var step = Math.max(1, Math.ceil(totalFrames / PASS1_MAX));
            var pass1 = [];
            for (var f = 0; f < totalFrames; f += step) pass1.push(f);
            if (pass1[pass1.length - 1] !== totalFrames - 1) pass1.push(totalFrames - 1);

            ensureCacheRoot();
            var dir = path.join(projectCacheDir(aepFull, aepName), sanitizeName(refComp));
            try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }
            catch (e) { cb("Could not create " + dir + ": " + e.message); return; }
            var motionFile = path.join(dir, "motion.json");
            var base = {
              dir: dir, refComp: refComp, fps: fps, dur: dur, w: w, h: h,
              totalFrames: totalFrames, step: step, frames: pass1, motionFile: motionFile
            };

            // Cache hit (same comp + length, every listed file intact) → skip everything.
            // Delete the comp's folder in Documents\MotionPilot to force a fresh pass.
            try {
              var old = JSON.parse(fs.readFileSync(motionFile, "utf8"));
              if (old && old.comp === refComp && old.totalFrames === totalFrames &&
                old.frames && old.frames.length) {
                var intact = old.frames.every(function (fn) { return fs.existsSync(framePath(dir, fn)); });
                if (intact) {
                  base.frames = old.frames;
                  base.motion = old;
                  addStatus("🎞 Reference cache reused — " + old.frames.length + " frames already in " + dir, "log");
                  var sheetsOk = old.sheets && old.sheets.length && old.sheets.every(function (nm) { return fs.existsSync(path.join(dir, nm)); });
                  if (sheetsOk) { cb(null, base); return; }
                  buildContactSheets(base, old.frames, function (e2, sheets) {
                    old.sheets = sheets || [];
                    try { fs.writeFileSync(motionFile, JSON.stringify(old), "utf8"); } catch (e) { }
                    if (old.sheets.length) addSheetsMsg(dir, old.sheets);
                    cb(null, base);
                  });
                  return;
                }
              }
            } catch (e) { }

            var ticker = addTicker('Pre-rendering "' + refComp + '"…');
            function fail(msg) { ticker.stop(); cb(msg); }

            function renderList(list, label, done) {
              var i = 0, CHUNK = 8;
              function nextChunk() {
                if (i >= list.length) { done(null); return; }
                var chunk = list.slice(i, i + CHUNK);
                evalBridge("$._motionPilot.renderRefFrames(" + JSON.stringify(refComp) + "," +
                  JSON.stringify(dir.replace(/\\/g, "/")) + "," + JSON.stringify(chunk.join(",")) + ")",
                  function (rerr) {
                    if (rerr) { done("Pre-render failed: " + rerr); return; }
                    i += CHUNK;
                    ticker.setLabel(label + "… " + Math.min(i, list.length) + "/" + list.length);
                    nextChunk();
                  });
              }
              nextChunk();
            }

            renderList(pass1, "Pass 1 — sampling", function (e1) {
              if (e1) { fail(e1); return; }
              waitForFrames(dir, pass1, ticker, function (e2) {
                if (e2) { fail(e2); return; }
                ticker.setLabel("Reading motion…");
                scanFrames(base, pass1, null, function (e3, r1) {
                  if (e3) { fail(e3); return; }
                  var dense = pickDenseFrames(pass1, r1.diffs, step);
                  function finish() {
                    waitForFrames(dir, base.frames, ticker, function (e5) {
                      if (e5) { fail(e5); return; }
                      ticker.setLabel("Building the motion map…");
                      finalizeAnalysis(base, function (e6, motion) {
                        ticker.stop();
                        if (e6) { cb(e6); return; }
                        base.motion = motion;
                        addStatus("🎞 Reference ready: " + base.frames.length + " frames (" + pass1.length +
                          " uniform + " + dense.length + " inside high-motion ranges) + " + ((motion.sheets || []).length) + " contact sheet(s) + motion map → " + dir, "ok");
                        if (motion.sheets && motion.sheets.length) addSheetsMsg(dir, motion.sheets);
                        cb(null, base);
                      });
                    });
                  }
                  if (dense.length) {
                    base.frames = mergeFrames(pass1, dense);
                    renderList(dense, "Pass 2 — high-motion frames", function (e4) {
                      if (e4) { fail(e4); return; }
                      finish();
                    });
                  } else {
                    finish();
                  }
                });
              });
            });
          });
        });
      });
    });
  }

  /* Analysis must not start before AE has flushed every PNG: wait until each
   * file exists and its size is unchanged across two polls. */
  function waitForFrames(dir, frames, ticker, cb) {
    var deadline = Date.now() + 45000;
    var last = {};
    function poll() {
      var notReady = 0, firstBad = "";
      for (var i = 0; i < frames.length; i++) {
        var fp = framePath(dir, frames[i]);
        var sz = -1;
        try { sz = fs.statSync(fp).size; } catch (e) { }
        if (sz <= 0 || last[fp] !== sz) {
          notReady++;
          if (!firstBad) firstBad = fp + (sz <= 0 ? " (missing)" : " (still writing)");
          last[fp] = sz;
        }
      }
      if (!notReady) { cb(null); return; }
      if (Date.now() > deadline) {
        cb("After Effects didn't produce " + notReady + " of " + frames.length +
          " reference frames — first problem: " + firstBad +
          ". The comp may not be rendering (check it plays in AE), or the drive is slow/synced (OneDrive). Send again to retry.");
        return;
      }
      if (ticker) ticker.setLabel("Waiting for AE to flush frames… " + (frames.length - notReady) + "/" + frames.length + " ready");
      setTimeout(poll, 300);
    }
    poll();
  }

  /* Pass-2 frame selection: every skipped frame inside the sampling gaps
   * where pass 1 saw real motion, biggest movers first, capped at DENSE_MAX. */
  function pickDenseFrames(pass1, diffs, step) {
    if (step <= 1) return []; // pass 1 already covered every frame
    var vals = diffs.slice(1).sort(function (a, b) { return a - b; });
    var median = vals.length ? vals[Math.floor(vals.length / 2)] : 0;
    var thr = Math.max(3, median * 2);
    var wins = [];
    for (var i = 1; i < diffs.length; i++) {
      if (diffs[i] >= thr) wins.push({ a: pass1[i - 1], b: pass1[i], d: diffs[i] });
    }
    wins.sort(function (x, y) { return y.d - x.d; });
    var have = {}, out = [];
    for (var j = 0; j < pass1.length; j++) have[pass1[j]] = 1;
    for (var k = 0; k < wins.length && out.length < DENSE_MAX; k++) {
      for (var f = wins[k].a + 1; f < wins[k].b && out.length < DENSE_MAX; f++) {
        if (!have[f]) { have[f] = 1; out.push(f); }
      }
    }
    return out.sort(function (a, b) { return a - b; });
  }

  function mergeFrames(a, b) {
    var all = a.concat(b);
    all.sort(function (x, y) { return x - y; });
    var out = [];
    for (var i = 0; i < all.length; i++) if (!i || all[i] !== all[i - 1]) out.push(all[i]);
    return out;
  }

  /* Sequentially load rendered frames (as data URLs — no canvas taint) and
   * diff consecutive frames. Besides the % change, each pair yields WHERE the
   * change happened: the centroid + bounding box of the changed pixels, scaled
   * to comp coordinates. Consecutive centroids trace the moving element's path
   * as numbers — the position track the model fits easing curves to, instead
   * of eyeballing positions out of 100+ images.
   * A frame that stays unreadable after retries FAILS the run loudly —
   * silently recording "no change" is what once produced a dead motion map. */
  function scanFrames(base, frames, drawCell, cb) {
    var DW = 160, DH = Math.max(8, Math.round(DW * base.h / base.w));
    var CH_THR = 30; // per-pixel |Δr|+|Δg|+|Δb| (of 765) that counts as "changed"
    var diffCanvas = document.createElement("canvas");
    diffCanvas.width = DW; diffCanvas.height = DH;
    var dctx = diffCanvas.getContext("2d");
    var prev = null;
    var diffs = []; // diffs[i] = % pixel change between frames[i-1] and frames[i]
    var track = []; // track[i] = [frame,x,y,w,h] changed-region center+size (comp px) or null
    var covs = [];  // covs[i] = fraction of pixels that changed (0..1) — near-1 everywhere ⇒ footage/global motion

    var idx = 0;
    function next() {
      if (idx >= frames.length) { cb(null, { diffs: diffs, track: track, covs: covs }); return; }
      var fp = framePath(base.dir, frames[idx]);
      var attempts = 0;
      function tryLoad() {
        var img = new Image();
        img.onload = function () {
          dctx.drawImage(img, 0, 0, DW, DH);
          var data = null;
          try { data = dctx.getImageData(0, 0, DW, DH).data; } catch (e) { }
          if (data && prev) {
            var sum = 0, cnt = 0, sx = 0, sy = 0, minX = DW, minY = DH, maxX = -1, maxY = -1;
            for (var k = 0, px = 0; k < data.length; k += 4, px++) {
              var d3 = Math.abs(data[k] - prev[k]) + Math.abs(data[k + 1] - prev[k + 1]) + Math.abs(data[k + 2] - prev[k + 2]);
              sum += d3;
              if (d3 > CH_THR) {
                var x = px % DW, y = (px / DW) | 0;
                cnt++; sx += x; sy += y;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
              }
            }
            var score = sum / ((data.length / 4) * 3) / 255 * 100;
            diffs.push(Math.round(score * 10) / 10);
            covs.push(cnt / (data.length / 4));
            if (cnt >= 4) {
              var sc = base.w / DW;
              track.push([frames[idx],
              Math.round(sx / cnt * sc), Math.round(sy / cnt * sc),
              Math.round((maxX - minX + 1) * sc), Math.round((maxY - minY + 1) * sc)]);
            } else {
              track.push(null);
            }
          } else {
            diffs.push(0);
            track.push(null);
            covs.push(0);
          }
          if (data) prev = data;
          if (drawCell) drawCell(img, idx);
          idx++;
          setTimeout(next, 0); // yield so the ticker keeps animating
        };
        img.onerror = function () {
          if (++attempts < 6) { setTimeout(tryLoad, 400); return; }
          cb("Reference frame " + path.basename(fp) + " never became readable — After Effects may not have finished (or failed) rendering it. Send again to retry; delete this comp's folder in Documents\\MotionPilot if it persists.");
        };
        var b64 = null;
        try { b64 = fs.readFileSync(fp).toString("base64"); } catch (e) { }
        if (!b64) { img.onerror(); return; }
        img.src = "data:image/png;base64," + b64;
      }
      tryLoad();
    }
    next();
  }

  /* Final pass over the merged frame list: cut/peak/hold detection + motion.json.
   * The frames themselves are served to the model as-is (no contact sheets). */
  /* Contact sheets: 24 timestamped cells per PNG (6x4, 320 px wide cells) so the
   * model reads the whole arc in a few images and can re-Read a sheet when it
   * forgets what a moment looked like, instead of rendering frames one by one. */
  /* Proof sheet for render_frame({times}): one image instead of N full frames (~1.8k tokens each),
   * so a multi-moment check costs one image; the full-size frames stay on disk for close looks. */
  function proofSheet(shots, cb) {
    var COLS = shots.length <= 4 ? 2 : 3, PAD = 6, TW = 640, loaded = [], k = 0;
    (function load() {
      if (k >= shots.length) { draw(); return; }
      var sh = shots[k++], img = new Image();
      img.onload = function () { loaded.push({ img: img, t: sh.t }); load(); };
      img.onerror = function () { load(); };
      try { img.src = "data:image/png;base64," + fs.readFileSync(sh.file).toString("base64"); } catch (e) { load(); }
    })();
    function draw() {
      if (!loaded.length) { cb(null); return; }
      var TH = Math.max(8, Math.round(TW * loaded[0].img.height / loaded[0].img.width)), rows = Math.ceil(loaded.length / COLS);
      var cv = document.createElement("canvas");
      cv.width = COLS * (TW + PAD) + PAD; cv.height = rows * (TH + PAD) + PAD;
      var cx = cv.getContext("2d");
      cx.fillStyle = "#202020"; cx.fillRect(0, 0, cv.width, cv.height);
      loaded.forEach(function (o, i) {
        var x = PAD + (i % COLS) * (TW + PAD), y = PAD + Math.floor(i / COLS) * (TH + PAD);
        cx.drawImage(o.img, x, y, TW, TH);
        var lbl = (i + 1) + " · " + o.t + "s";
        cx.font = "bold 18px sans-serif";
        var w = cx.measureText(lbl).width + 12;
        cx.fillStyle = "rgba(0,0,0,0.7)"; cx.fillRect(x, y, w, 24);
        cx.fillStyle = "#fff"; cx.fillText(lbl, x + 6, y + 18);
      });
      frameSeq++;
      var out = path.join(WORK_DIR, "proof-" + Date.now() + "-" + frameSeq + ".png");
      try { fs.writeFileSync(out, Buffer.from(cv.toDataURL("image/png").split(",")[1], "base64")); cb(out); } catch (e) { cb(null); }
    }
  }

  function buildContactSheets(base, frames, cb) {
    var COLS = 6, ROWS = 4, PER = COLS * ROWS, PAD = 4;
    var TW = 320, TH = Math.max(8, Math.round(TW * base.h / base.w));
    var names = [], i = 0, no = 0;
    function nextSheet() {
      if (i >= frames.length) { cb(null, names); return; }
      var chunk = frames.slice(i, i + PER); i += PER; no++;
      var rows = Math.ceil(chunk.length / COLS);
      var cv = document.createElement("canvas");
      cv.width = COLS * (TW + PAD) + PAD; cv.height = rows * (TH + PAD) + PAD;
      var cx = cv.getContext("2d");
      cx.fillStyle = "#202020"; cx.fillRect(0, 0, cv.width, cv.height);
      var k = 0;
      function cell() {
        if (k >= chunk.length) { save(); return; }
        var f = chunk[k], idx = k; k++;
        var b64 = "";
        try { b64 = fs.readFileSync(framePath(base.dir, f)).toString("base64"); } catch (e) { cell(); return; }
        var img = new Image();
        img.onload = function () {
          var x = PAD + (idx % COLS) * (TW + PAD), y = PAD + Math.floor(idx / COLS) * (TH + PAD);
          cx.drawImage(img, x, y, TW, TH);
          var lbl = "f" + f + "  " + (f / base.fps).toFixed(2) + "s";
          cx.font = "bold 15px sans-serif";
          var w = cx.measureText(lbl).width + 10;
          cx.fillStyle = "rgba(0,0,0,0.65)"; cx.fillRect(x, y, w, 20);
          cx.fillStyle = "#fff"; cx.fillText(lbl, x + 5, y + 15);
          cell();
        };
        img.onerror = function () { cell(); };
        img.src = "data:image/png;base64," + b64;
      }
      function save() {
        var name = "sheet-" + (no < 10 ? "0" : "") + no + ".png";
        try { fs.writeFileSync(path.join(base.dir, name), Buffer.from(cv.toDataURL("image/png").split(",")[1], "base64")); names.push(name); } catch (e) { }
        nextSheet();
      }
      cell();
    }
    nextSheet();
  }

  function finalizeAnalysis(base, cb) {
    var frames = base.frames;
    scanFrames(base, frames, null, function (err, r) {
      if (err) { cb(err); return; }
      var diffs = r.diffs;
      var sorted = diffs.slice(1).sort(function (a, b) { return a - b; });
      var median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
      var cutThr = Math.max(18, median * 4 + 6);
      var peakThr = Math.max(4, median * 2.2);
      var holdThr = Math.max(0.6, median * 0.35);
      var cuts = [], peakCand = [], holds = [];
      for (var i = 1; i < diffs.length; i++) {
        if (diffs[i] >= cutThr) cuts.push(frames[i]);
        else if (diffs[i] >= peakThr && diffs[i] >= (diffs[i - 1] || 0) && diffs[i] >= (diffs[i + 1] || 0)) {
          peakCand.push({ f: frames[i], d: diffs[i] });
        }
      }
      peakCand.sort(function (a, b) { return b.d - a.d; });
      var peaks = peakCand.slice(0, 12).map(function (o) { return o.f; }).sort(function (a, b) { return a - b; });
      var hs = -1;
      for (var j = 1; j < diffs.length; j++) {
        if (diffs[j] <= holdThr) { if (hs < 0) hs = j - 1; }
        else if (hs >= 0) {
          if (j - 1 - hs >= 2) holds.push([frames[hs], frames[j - 1]]);
          hs = -1;
        }
      }
      if (hs >= 0 && diffs.length - 1 - hs >= 2) holds.push([frames[hs], frames[diffs.length - 1]]);

      var track = [];
      (r.track || []).forEach(function (t) { if (t) track.push(t); });

      // Footage detection: if most MOVING frame pairs change a large share of the
      // canvas, this is video footage / camera motion / full-frame effects — the
      // changed-pixel centroid blends everything and the track is only a rough guide.
      var movingCovs = [];
      for (var mc = 1; mc < diffs.length; mc++) {
        if (diffs[mc] > holdThr) movingCovs.push((r.covs && r.covs[mc]) || 0);
      }
      movingCovs.sort(function (a, b) { return a - b; });
      var medCov = movingCovs.length ? movingCovs[Math.floor(movingCovs.length / 2)] : 0;
      var globalMotion = medCov > 0.35;

      var motion = {
        comp: base.refComp, width: base.w, height: base.h, fps: base.fps,
        durationSeconds: Math.round(base.dur * 100) / 100,
        totalFrames: base.totalFrames, sampledEvery: base.step,
        frames: frames, diffs: diffs, cuts: cuts, peaks: peaks, holds: holds,
        track: track, globalMotion: globalMotion,
        note: "diffs[i] = % pixel change between frames[i-1] and frames[i]. Sampling is ADAPTIVE: uniform every " + base.step + " frame(s) plus every frame inside high-motion ranges — the gaps in 'frames' show the true spacing. cuts = hard scene changes. peaks = strongest motion moments. holds = near-still frame ranges [start,end]. track = [frame,x,y,w,h]: center (x,y) and size (w,h), in comp pixels, of the region that CHANGED since the previous sampled frame — for a single mover, consecutive centers trace its path and the spacing between them IS the speed/easing; when several elements move at once the center blends them, so Read the actual frames in that range. globalMotion=true means most moving frame pairs change a large share of the canvas (video footage / camera moves / full-frame effects): the track is then only a rough guide — lean on the appearance frames, cuts and peaks instead."
      };
      motion.poses = pickAppearanceFrames(motion);
      buildContactSheets(base, frames, function (e2, sheets) {
        motion.sheets = sheets || [];
        try { fs.writeFileSync(base.motionFile, JSON.stringify(motion), "utf8"); } catch (e) { }
        cb(null, motion);
      });
    });
  }

  /* The short list of frames worth LOOKING at (appearance): first/last frame,
   * the middle of every hold, both sides of every cut, and the motion peaks.
   * Movement comes from the numeric track, not from reading every image. */
  function pickAppearanceFrames(m) {
    var want = {};
    var frames = m.frames;
    function nearest(f) { // snap to a frame that actually exists on disk
      var best = frames[0], dist = Infinity;
      for (var i = 0; i < frames.length; i++) {
        var d = Math.abs(frames[i] - f);
        if (d < dist) { dist = d; best = frames[i]; }
      }
      return best;
    }
    want[frames[0]] = 1;
    want[frames[frames.length - 1]] = 1;
    (m.holds || []).forEach(function (h) { want[nearest(Math.round((h[0] + h[1]) / 2))] = 1; });
    (m.cuts || []).forEach(function (c) {
      want[nearest(c)] = 1;
      var i = frames.indexOf(nearest(c));
      if (i > 0) want[frames[i - 1]] = 1; // last frame of the previous scene
    });
    (m.peaks || []).forEach(function (p) { want[nearest(p)] = 1; });
    var out = [];
    for (var k in want) out.push(parseInt(k, 10));
    out.sort(function (a, b) { return a - b; });
    return out.slice(0, 24);
  }

  // ---------- project checkpoint ----------
  // Before each prompt's edits, snapshot the .aep (its last-saved state) into
  // the project's cache folder, so one bad Auto-mode session is never fatal.
  // Keeps the 3 newest; fire-and-forget — a failed checkpoint never blocks a run.
  var checkpointAnnounced = false;
  var frameSeq = 0; // makes batched render_frame filenames unique within one ms
  function checkpointProject() {
    csInterface.evalScript(
      '(function(){try{var f=app.project.file;return f?f.fsName:"NONE"}catch(e){return "NONE"}})()',
      function (aep) {
        if (!aep || aep === "NONE" || aep === CSInterface.EVAL_SCRIPT_ERROR) return;
        try {
          var st = fs.statSync(aep);
          if (!st.isFile() || st.size > MAX_COPY_BYTES) return;
          ensureCacheRoot();
          var dir = path.join(projectCacheDir(aep, path.basename(aep)), "_checkpoints");
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          var d = new Date();
          function p2(n) { return (n < 10 ? "0" : "") + n; }
          var stamp = d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + "-" +
            p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
          fs.copyFileSync(aep, path.join(dir, path.basename(aep, ".aep") + "-" + stamp + ".aep"));
          var olds = fs.readdirSync(dir).filter(function (f) { return /\.aep$/i.test(f); }).sort();
          while (olds.length > 3) { try { fs.unlinkSync(path.join(dir, olds.shift())); } catch (e0) { } }
          if (!checkpointAnnounced) {
            checkpointAnnounced = true;
            addStatus("🛟 Project checkpoint saved (last-saved state) → " + dir, "log");
          }
        } catch (e) { }
      }
    );
  }

  // ---------- prompts ----------
  function truncate(s, n) {
    return s.length > n ? s.substring(0, n) + "\n/* …truncated… */" : s;
  }

  function scriptRules() {
    return [
      "Reply with AT MOST two short sentences describing what you will do, then the COMPLETE ExtendScript in a single fenced code block starting with ```jsx. Nothing after the code block.",
      "Hard rules for the code:",
      "- Line 1 must be exactly: var comp = app.project.activeItem;",
      '- Line 2 must be: if (!(comp && comp instanceof CompItem)) throw new Error("No active composition - open a comp in the timeline first.");',
      "- ExtendScript is ES3: no let/const, no arrow functions, no template literals, no JSON object, no Array.prototype.map/forEach/filter.",
      "- Do NOT call app.beginUndoGroup / app.endUndoGroup; the host wraps execution in an undo group already.",
      "- The AE.* helper library (cheat sheet above) is preloaded before your script runs — use it.",
      '- The last statement of the script must be a short plain string summarizing what was done (it becomes the status message), e.g. "Added bounce to layer 3".'
    ].join("\n");
  }

  function motionRules() { return BRAIN.rules; }

  function cheatSheet() { return BRAIN.cheat; }

  /* Full AE effects catalog — injected ONLY in Stylize mode so ordinary
   * prompts stay lean. matchNames are version-stable; property values are set
   * by display name via AE.fxSet, so no numbered-property guesswork. */
  function fxCatalog() { return BRAIN.fx; }
  // Long reference packs split on their "## " headings. Design-room runs get the index first;
  // guided runs get the whole pack unless they ask for a section.
  var SECTIONED = { moves: 1, flow: 1 };
  var lastRunRoom = false;
  function skillSections(text) {
    var parts = String(text).split(/\n(?=## )/), head = parts.shift(), list = [], pick = null;
    parts.forEach(function (p) {
      var title = p.slice(3, p.indexOf("\n") > 0 ? p.indexOf("\n") : p.length).trim();
      var o = { title: title, body: p };
      if (/^PICKING/i.test(title)) pick = o;
      list.push(o);
    });
    return { head: head, list: list, pick: pick };
  }

  /* Animation principles as concrete keyframe moves — the polish pass.
   * Ships inline in Stylize mode; other modes fetch it via ae get_skill. */
  function animPrinciples() { return BRAIN.principles; }

  /* Per-task-type step breakdowns — weaker models follow rails; the mode
   * buttons above the composer pick which rail ships with the prompt. */
  function modeSteps(mode) { return BRAIN.steps[mode] || BRAIN.steps.def; }

  /* Data block for Recreate mode: where the pre-rendered reference lives,
   * the motion-map summary, and the exact target-comp activation script. */
  function motionSummary(m) {
    var bits = [];
    bits.push(m.cuts && m.cuts.length ? "cuts (scene changes) at frames [" + m.cuts.join(", ") + "]" : "no hard cuts");
    if (m.peaks && m.peaks.length) bits.push("strongest motion at frames [" + m.peaks.join(", ") + "]");
    if (m.holds && m.holds.length) {
      bits.push("near-still holds at [" + m.holds.map(function (h) { return h[0] + "–" + h[1]; }).join(", ") + "]");
    }
    var ds = (m.diffs || []).slice(1);
    if (ds.length) {
      var avg = 0;
      ds.forEach(function (d) { avg += d; });
      bits.push("avg change " + (avg / ds.length).toFixed(1) + "%/sample");
    }
    return bits.join(" · ");
  }

  /* The static prompt preamble (identity, design thinking, style, tool notes).
   * skillHint is the only per-mode variation, appended to the get_skill line. */
  function promptPreamble(skillHint) { return BRAIN.pre.replace("{{SKILLHINT}}", skillHint || ""); }

  function buildPrompt(task, ctx, refs, styleId, spec) {
    var L = [];
    var room = roomyRun() && (taskMode === "new" || taskMode === "other") && BRAIN && BRAIN.room;
    lastRunRoom = !!room;
    var pre = promptPreamble(
      taskMode === "style" ? ' "effects" is already included below — don\'t fetch it again.' :
        taskMode === "polish" ? ' "animation-principles" is already included below — don\'t fetch it again.' : "");
    if (room) (BRAIN.room.pre || []).forEach(function (pr) { pre = pre.split(pr[0]).join(pr[1]); });
    L.push(pre);
    L.push("");
    L.push((room && BRAIN.room.steps && BRAIN.room.steps[taskMode]) || modeSteps(taskMode));
    L.push("");
    if ((taskMode === "new" || taskMode === "other") && BRAIN && BRAIN.fidelity) {
      var nums = briefNumbers(task);
      L.push(BRAIN.fidelity.replace("{{FOUND}}", nums.length ? nums.map(function (x) { return "- " + x; }).join("\n") : "- (none detected — still read the brief for counts and required items)"));
      L.push("");
      if (BRAIN.chapters) { L.push(BRAIN.chapters); L.push(""); }
    }
    if (curEngine() === "codex") {
      L.push("## Engine notes — you are running through the Codex CLI (not Claude Code)");
      L.push("- Wherever these instructions say to \"Read\" an image or a rendered frame, use your view_image tool with the absolute path. Documents (txt/md/csv/json/html) — read them with the shell; PDFs are not viewable here.");
      L.push("- The `ae` MCP tools are the ONLY way to touch After Effects. There is no Skill or Read tool; for RESEARCH WHEN UNSURE use your web search tool. Your shell runs in a sandbox rooted at " + WORK_DIR + " (network on); never install anything.");
      L.push("- Reference images are attached to this message AND listed with their on-disk paths below (use the paths for AE.importAsset).");
      L.push("- Work in the same incremental loop: run_script in small steps, render_frame at key moments, view the PNGs, fix, then finish with a one-line summary.");
      L.push("");
    }
    if (spec) {
      L.push("## Build spec (pre-decided by the director pass)");
      L.push("A director pass already made the open creative decisions for this brief. Execute this spec instead of re-deriving those decisions; deviate only where the live comp state or the user's own words contradict it, and note the deviation in one short line.");
      L.push(spec);
      L.push("");
    }
    if (designOn && taskMode === "new" && !styleId && BRAIN && BRAIN.design) {
      L.push(BRAIN.design);
      L.push("");
    }
    if (styleId) {
      L.push("## Editing style — " + styleId);
      L.push('The user picked the "' + styleId + '" pack from the panel for this task. ' +
        'BEFORE building or styling anything, call get_skill("' + styleId + '") and follow that pack — its frame grammar, assets, ' +
        "moves / stack, build order and don'ts override the generic defaults wherever they conflict. " +
        (TEXTURE_PACKS[styleId] ? "It is a TEXTURE pack: apply its STACK on the finished animation, then TUNE; layout, timing and content stay untouched." : "The whole piece must read as that style."));
      L.push("");
    }
    L.push("## Assets");
    L.push('- Assets the user imported into the project Bin are listed in get_state and every digest. Place one with AE.fromBin("name",{fit}) — it auto-scales from the item\'s pixel size, so do NOT Read the asset file first. After placing, render_frame once to actually see it, then style/animate.');
    // One line; the generate_image tool description carries the prompt / key-colour / import rules.
    if (codexUsable()) L.push("- Need a pictorial asset shapes and text can't make (illustration, character, product shot)? generate_image (GPT Image 2) — follow its tool description for the prompt, key colour and import. Never install or run local image tools." + (modeEl.value === "ask" ? " Each generation is shown to the user for approval first." : ""));
    else L.push("- No image generation this run (Codex / GPT Image 2 is not signed in): use Bin assets or build from shapes, solids and text; tell the user in one line if the design needed a picture.");
    if (genRun && curEngine() !== "codex") {
      L.push("- Higgsfield is ALSO enabled this run (✦ pill) for what GPT Image 2 can't do: video clips, 3D, or a premium image model the user explicitly asks for — via the Higgsfield CLI through Bash (the higgsfield-generate skill has the commands). EVERY shell command is shown to the user for approval — model and --prompt included — so write them clearly and never retry a declined call. Cheapest suitable model by default (nano_banana_2 / nano_banana_2_lite for flat elements); premium tiers only on explicit request.");
    } else if (genRun) {
      L.push("- Higgsfield is not available from this engine; use generate_image for images and tell the user if the design needs video/3D assets.");
    }
    L.push("");
    L.push(cheatSheet());
    L.push("");
    if ((taskMode === "style" || taskMode === "recreate") && BRAIN.cheatLook) { L.push(BRAIN.cheatLook); L.push(""); }
    if (taskMode === "style") {
      L.push(fxCatalog());
      L.push("");
    }
    if (taskMode === "polish") {
      L.push(animPrinciples());
      L.push("");
    }
    L.push(room && BRAIN.room.rules ? BRAIN.room.rules : motionRules());
    L.push("");
    L.push("## ExtendScript rules");
    L.push("- ES3 only: no let/const, no arrow functions, no template literals, no JSON object, no Array.prototype.map/forEach/filter/indexOf.");
    L.push("- Do NOT call app.beginUndoGroup/app.endUndoGroup — the host wraps every run_script call in an undo group.");
    L.push("- End every script with a short plain string as the last expression; that string is returned to you.");
    L.push("- AE.* helpers assume an active comp and throw if none — create one via app.project.items.addComp(...).openInViewer() if needed.");
    L.push("- Traps: a NEW text layer inherits the previous layer's character style and caps (AE.text resets it; raw addText does not — set the TextDocument explicitly) · a paragraph text box's Position is NOT its top-left: read boxTextPos and the anchor first · a shape group added later renders BEHIND the existing fill — add fills last or reorder · expressions use content(\"G\").content(1) not .property() (script syntax in an expression = error, and a script that ran does not prove its expressions evaluate; check expressionError) · deleting Time Remap's last key disables Time Remap — keep one key · render_frame/saveFrameToPng can skip a file with no error — check the PNG exists before Reading it.");
    L.push("");
    L.push("Fallback ONLY if the ae tools are unavailable (calls error out): reply with the complete script in one ```jsx fenced block instead, following these rules:");
    L.push(scriptRules());
    L.push("");
    if (ctx && ctx !== "NONE") {
      L.push("Quick snapshot of the active composition (use get_state for full detail):");
      L.push(ctx);
    } else {
      L.push("No composition appears to be active right now — check with get_state; create a comp if the task calls for it.");
    }
    var sheetRefs = (refs || []).filter(function (r) { return r.isSheet; });
    if (sheetRefs.length) {
      L.push("");
      L.push("## Reference video → contact sheets (this is how you watch the video)");
      var byVid = {};
      sheetRefs.forEach(function (r) { (byVid[r.video] = byVid[r.video] || []).push(r); });
      Object.keys(byVid).forEach(function (vn) {
        var list = byVid[vn], first = list[0], m = first.motion || {};
        L.push("Video \"" + vn + "\": " + first.w + "x" + first.h + " @ " + first.fps + "fps, " + (first.dur || 0).toFixed(2) + "s (" + first.totalFrames + " frames). The panel sampled it and tiled every sampled frame into " + list.length + " contact sheet(s) — 24 timestamped cells per sheet (label = frame number + seconds), 6 columns, read left→right, top→bottom, in time order:");
        list.forEach(function (r) { L.push("- " + r.path + (r.binName ? "   (also in the project Bin › Reference Sheets as \"" + r.binName + "\")" : "")); });
        L.push("Read ALL of these sheets ONCE, in one message of parallel Reads, before anything else. They are the reference. Whenever you forget what a moment looks like, re-Read the sheet that covers that time" + (first.binName ? ", or place the Bin item as a temporary GUIDE layer (AE.fromBin(name,{fit:1}), delete it before you finish)" : "") + ". Never render the video frame by frame and never ask for a reference comp — there is none.");
        L.push("Motion map (measured by the panel): " + motionSummary(m) + ". POSITION TRACK frame:(x,y) — centre of what changed since the previous sampled frame; the spacing between consecutive centres is the speed and how it bunches/spreads is the easing:");
        L.push((m.track && m.track.length) ? m.track.map(function (t) { return t[0] + ":(" + t[1] + "," + t[2] + ")"; }).join(" ") : "(no motion detected between sampled frames)");
        if (m.globalMotion) L.push("NOTE: the change is near-global (footage / camera moves / full-frame effects) — the track blends everything; lean on the sheets, cuts and peaks.");
        L.push("Everything above persists in " + first.motionFile + " (re-Read it after context loss).");
      });
    }
    if (refs && refs.length) {
      L.push("");
      L.push("## Reference images — Read each ONCE, then build");
      L.push(taskMode === "new"
        ? "Read EVERY reference image below with the Read tool ONE time before touching AE — even when the spec has a REFERENCE READ (that is the director's summary; you still need the picture for positions, sizes and hexes). A single still frame is the usual case: it IS the settled design — keep its layout, palette and hierarchy, pour the brief's content into it, and your job is to decide the MOTION (which element is the hero, what enters first, which named moves, what stays still). Several images = the design grammar to follow; copying their own text/objects wholesale is a failed result unless the brief asks."
        : taskMode === "style"
          ? "Read each reference image ONE time: it shows the FINISH to match (grain? paper? glow? hard shadows? blur depth?) — match the finish, not its layout or content."
          : taskMode === "polish"
            ? "Read each reference image ONE time: it shows the energy and posture of the motion wanted (how far things overshoot, how much empty holds) — tune the existing keys toward it, change nothing else."
            : "Read each reference image ONE time: it shows how the changed element should look — match it for that element only; everything else stays as it is.");
      L.push("One read in, one compare out: take positions/sizes as % of the comp, exact hexes, text, and the finish from that single read; build from your plan without re-Reading between steps; when done, render_frame and judge by the design check (one hero, empty enough, scale contrast, something cropped, depth) and by the reference for the elements it defines. Repeated image reads are the main token drain.");
      L.push("Video files were turned into the contact sheets above (they are also imported into the Bin folder \"Reference\" as footage if you need the clip itself). Documents (pdf/txt/md/…) CAN be read — Read each one ONCE and treat its content as part of the brief. If the task needs media imported into AE, import these exact absolute paths with app.project.importFile(new ImportOptions(File(path))):");
      refs.forEach(function (r) {
        L.push("- " + r.path + (r.isSheet ? " (contact sheet " + r.index + "/" + r.count + " of video \"" + r.video + "\" — see the section above)" : r.isImage ? (taskMode === "new" ? " (image — the reference frame: Read it once, it is the settled design)" : " (image — the user's reference; Read it once)") : r.isDoc ? " (document — Read it for its content)" : r.sheetSource ? " (video — already turned into the contact sheets above; also in the Bin)" : " (video)"));
      });
    }
    // Resumed chats already carry their full transcript inside the CLI
    // session — re-injecting it would double the context. Only out-of-band
    // panel events (Revert, Compact markers) still need to be told.
    var resuming = !!(session && (curEngine() === "codex" ? session.codexTid : session.claudeSid));
    // A fresh session after an account switch (or with a Handbook on file) catches up first.
    if (!resuming) {
      var hb = readHandbook();
      var switched = !!(session && session.switched && session.switched[curEngine()]);
      if (hb || switched) {
        var recap = chatTranscript(hb ? 3000 : 6000);
        L.push("");
        if (hb) {
          L.push("[MotionPilot] You are continuing this chat in a fresh session (the account or model changed). Its Handbook.md (" + handbookPath() + ") is below — read it first: it describes the project, what is built and how to continue. The After Effects project already contains that work; confirm the details with get_state before you change anything.");
          L.push("");
          L.push(hb);
          L.push("[End of handbook]");
        } else {
          L.push("[MotionPilot] You are continuing this chat in a fresh session (the account was switched) and the chat has no Handbook.md. Before you work, understand the project yourself: read the conversation below and inspect the comp with get_state (and a render_frame if useful).");
        }
        if (recap) { L.push(""); L.push("Recent conversation:"); L.push(recap); L.push("[End of conversation]"); }
      }
    }
    var hh = history.slice(-4);
    if (resuming) hh = hh.filter(function (h) { return h.task.charAt(0) === "["; });
    if (hh.length) {
      L.push("");
      L.push(resuming ? "Panel events since your last turn:" : "Earlier in this session (most recent last):");
      hh.forEach(function (h) {
        L.push("User asked: " + h.task);
        if (h.result) L.push("Outcome: " + h.result);
        if (h.script && !resuming) {
          L.push("Script you produced:");
          L.push(truncate(h.script, 1200));
        }
        L.push("---");
      });
    }
    L.push("");
    L.push("Task: " + task);
    return L.join("\n");
  }

  function buildFixPrompt(task, ctx, refs, badScript, aeError) {
    var L = [];
    L.push("The ExtendScript below threw an error when run inside Adobe After Effects. Produce a corrected FULL replacement script. No explanations.");
    L.push(cheatSheet());
    L.push("");
    L.push(scriptRules());
    L.push("");
    L.push("Original task: " + task);
    if (ctx && ctx !== "NONE") L.push("Composition state: " + ctx);
    if (refs && refs.length) {
      L.push("Reference files:");
      refs.forEach(function (r) { L.push("- " + r.path); });
    }
    L.push("");
    L.push("Failing script:");
    L.push(badScript);
    L.push("");
    L.push("After Effects error: " + aeError);
    return L.join("\n");
  }

  /* Split a chat reply into prose and fenced code blocks. */
  function splitCode(text) {
    var codes = [];
    var prose = text.replace(/```(?:jsx|javascript|js|extendscript)?[ \t]*\n?([\s\S]*?)```/g, function (m, c) {
      codes.push(c.trim());
      return "";
    }).trim();
    return { prose: prose, codes: codes };
  }

  function looksLikeScript(text) {
    return /(^|\n)\s*var comp\b/.test(text) || text.indexOf("app.project") !== -1;
  }

  // ---------- Claude CLI (streaming) ----------
  function psQuote(p) { return "'" + p.replace(/'/g, "''") + "'"; }

  /* opts (optional): { model, effort, tools, deny, allowSkill, resumeSid,
   * onSid, label, logFile } — overrides for one run. */
  function startClaude(promptText, includeEffort, onEvent, cb, opts) {
    opts = opts || {};
    var LOGF = opts.logFile || LOG_FILE;
    ensureDirs();
    var promptFile;
    try {
      promptFile = path.join(WORK_DIR, "prompt-" + Date.now() + ".txt");
      fs.writeFileSync(promptFile, promptText, "utf8");
      fs.writeFileSync(LOGF, "=== run " + new Date().toISOString() +
        " (build " + PANEL_BUILD + (opts.label ? ", stage: " + opts.label : "") + ", node: " + (NODE_BIN || "node from PATH") +
        (CLAUDE_VER ? ", claude: " + CLAUDE_VER : "") + ") ===\n", "utf8");
    } catch (e) {
      cb("Could not write prompt file: " + e.message);
      return;
    }

    var flags = ["-p", "--output-format", "stream-json", "--verbose"];
    // Mac only: CLI debug logging goes to stderr, which lands in the run log —
    // it explains a failed MCP connection when the connector can't start.
    if (IS_MAC) flags.push("--debug");
    if (bridgePort) {
      flags.push("--mcp-config", cliQuote(MCP_CONFIG), "--strict-mcp-config");
      // Skill lets the model load the user's global Higgsfield skills; the
      // higgsfield CLI itself runs through Bash, which is NEVER pre-approved:
      // every non-allowlisted tool routes through the approve MCP tool, and
      // the panel decides there (Higgsfield generations always ask the user,
      // even in Auto mode, showing the generation prompt).
      flags.push("--permission-prompt-tool", "mcp__ae__approve");
      // Skill (the gateway to the user's global Higgsfield skills) is only
      // offered while the panel's Gen toggle is ON.
      // Gen OFF still allows FREE web asset sourcing: WebSearch/WebFetch are
      // read-only; the actual curl download runs through Bash, which always
      // routes to the approve gate — the user sees and approves every command.
      var toolList = opts.tools || ((genRun ? "Read,Skill,WebSearch,WebFetch," : "Read,WebSearch,WebFetch,") +
          "mcp__ae__get_state,mcp__ae__run_script,mcp__ae__render_frame,mcp__ae__get_skill,mcp__ae__generate_image,mcp__ae__ae_info,mcp__ae__inspect_properties");
      flags.push("--allowedTools", cliQuote(toolList));
      // Only the built-in tools a build can use (MCP tools come from --mcp-config regardless);
      // keeps the fixed context per call small.
      var needSkill = genRun || !!opts.allowSkill || /(^|,)Skill(,|$)/.test(toolList);
      if (localStorage.getItem("claude-ae-no-tools-flag") !== "1") flags.push("--tools", cliQuote("Read,Bash,WebSearch,WebFetch,ToolSearch" + (needSkill ? ",Skill" : "")));
      // The user's installed-skills list only rides along when Skill is actually usable.
      if (!needSkill) flags.push("--disable-slash-commands");
      // Deny-installers + ask-for-all-Bash rules (+ deny Skill when Gen is
      // off); outranks skills' own "allowed-tools: Bash" self-grants. Skipped
      // only if this CLI version rejects --settings (detected and remembered
      // on first failure).
      if (localStorage.getItem("claude-ae-no-settings") !== "1") {
        writeRunSettings(!!opts.allowSkill, opts.deny || []);
        flags.push("--settings", cliQuote(SETTINGS_FILE));
      }
    } else {
      flags.push("--allowedTools", "Read");
    }
    var runModel = opts.model || buildModel();
    if (runModel) { flags.push("--model", runModel); }
    var runEffort = (opts.effort !== undefined) ? opts.effort : (includeEffort ? effortEl.value : "");
    if (includeEffort && runEffort) { flags.push("--effort", runEffort); }
    // Chat continuity: every send in a chat resumes the same CLI session, so
    // Claude genuinely remembers earlier messages instead of starting cold.
    // The id is captured from the run's init event and stored on the chat.
    var resumeSid = (opts.resumeSid !== undefined) ? opts.resumeSid : ((session && session.claudeSid) || "");
    if (resumeSid) { flags.push("--resume", cliQuote(resumeSid)); }

    // On Mac, prove the connector can actually start before handing it to the
    // CLI — the CLI's own failure is the useless "Available MCP tools: none".
    // On Windows (and with no bridge) this calls straight through unchanged.
    preflightConnector(function (pfErr) {
      if (pfErr) {
        try { fs.appendFileSync(LOGF, "[preflight] " + pfErr + "\n"); } catch (e) { }
        try { fs.unlinkSync(promptFile); } catch (e) { }
        cb("The AE connector (the panel's MCP server) failed its startup check, so Claude cannot control After Effects.\n" +
          "Reason: " + pfErr + "\n" +
          "Fix: install Node.js LTS from nodejs.org (or re-run the installer), then restart After Effects and try again.\n" +
          "(panel build " + PANEL_BUILD + ") Full log: " + LOG_FILE);
        return;
      }
      launchRun();
    });

    function launchRun() {
    var child;
    try {
      child = spawnClaude(promptFile, flags.join(" "), REFS_DIR, true);
    } catch (e) {
      cb("Could not start " + SHELL_NAME + ": " + e.message);
      return;
    }

    var run = { child: child, cancelled: false };
    currentRun = run;

    var stdoutBuf = "", stderrOut = "", rawText = "";
    var assistantText = [];
    var resultEv = null;
    var connectorFail = null;
    var sidSeen = ""; // CLI session id from this run's events (for --resume next send)
    // Context meter: only the chat's own session counts (stage runs with onSid have sessions of their own).
    var ownCtx = !opts.onSid, ctxModel = runModel || "";

    function connectorFailText() {
      var head = "The AE connector (the panel's MCP server) did not come up, so Claude cannot control After Effects.\n";
      var tail = "\n(panel build " + PANEL_BUILD + (CLAUDE_VER ? ", claude " + CLAUDE_VER : "") + ")";
      // When the panel's own preflight just launched this exact connector
      // successfully, the failure is on the Claude CLI's side of the spawn.
      if (connectorOkFor && connectorOkFor === (NODE_BIN || "node")) {
        return head +
          "The connector itself runs fine (node: " + connectorOkFor + ") — the Claude CLI failed to launch or connect to it.\n" +
          "Fix: update Claude Code — run 'claude update' in Terminal (or 'npm install -g @anthropic-ai/claude-code@latest' if installed via npm), then restart After Effects." + tail;
      }
      return head +
        "This usually means the 'node' command was not found. Node used: " +
        (NODE_BIN || "node (from PATH)") + ".\n" +
        "Fix: install Node.js LTS from nodejs.org (or re-run the installer), then restart After Effects and try again." + tail;
    }

    function logLine(line) {
      try { fs.appendFileSync(LOGF, line + "\n"); } catch (e) { }
    }

    function handleLine(line) {
      line = line.replace(/\r$/, "");
      if (!line.trim()) return;
      logLine(line);
      var ev;
      try { ev = JSON.parse(line); } catch (e) { rawText += line + "\n"; return; }

      if (ev.type === "system" && ev.subtype === "init") {
        if (ev.session_id) sidSeen = String(ev.session_id);
        if (ev.model) ctxModel = String(ev.model);
          onEvent({ kind: "phase", text: (opts.label || "Claude") + " is working… (" + (ev.model || "default model") + ")" });
        // The panel asked for the connector — if the CLI couldn't start it the
        // whole run is useless (and Ask mode's permission tool is gone too), so
        // stop now with a real diagnosis instead of a cryptic downstream error.
        if (bridgePort) {
          var aeUp = false, srvList = ev.mcp_servers || [];
          for (var si = 0; si < srvList.length; si++) {
            if (srvList[si] && srvList[si].name === "ae" && srvList[si].status === "connected") { aeUp = true; break; }
          }
          if (!aeUp) {
            connectorFail = connectorFailText();
            killRunTree(child);
          }
        }
      } else if (ev.type === "assistant" && ev.message && ev.message.content) {
        var mu = ev.message.usage;
        if (ownCtx && mu && !ev.parent_tool_use_id) {
          // one API call's full input = the session's context at that moment
          var used = (mu.input_tokens || 0) + (mu.cache_creation_input_tokens || 0) + (mu.cache_read_input_tokens || 0) + (mu.output_tokens || 0);
          if (used) setCtx({ used: used, window: ctxWindowGuess(ctxModel), model: ctxModel });
        }
        ev.message.content.forEach(function (block) {
          if (block.type === "text" && block.text) {
            assistantText.push(block.text);
            onEvent({ kind: "text", text: block.text });
          } else if (block.type === "thinking") {
            onEvent({ kind: "phase", text: "Claude is thinking…" });
          } else if (block.type === "tool_use") {
            var label = "🔧 " + block.name;
            if (block.name === "Read" && block.input && block.input.file_path) {
              label = "👁 Viewing " + path.basename(String(block.input.file_path));
            } else if (block.name === "Bash" && block.input && block.input.command) {
              var bcmd = String(block.input.command).replace(/\s+/g, " ");
              if (bcmd.length > 90) bcmd = bcmd.substring(0, 90) + "…";
              label = "🛠 " + bcmd;
            } else if (block.name === "Skill" && block.input && block.input.skill) {
              label = "📚 Skill: " + block.input.skill;
            } else if (block.name && block.name.indexOf("mcp__ae__") === 0) {
              label = null; // the bridge dispatch renders these with more detail
            }
            if (label) onEvent({ kind: "log", text: label });
          }
        });
      } else if (ev.type === "result") {
        resultEv = ev;
        if (ev.session_id) sidSeen = String(ev.session_id);
        // the CLI states the real window size per model
        var muAll = ev.modelUsage || {}, cw = 0;
        if (muAll[ctxModel] && muAll[ctxModel].contextWindow) cw = muAll[ctxModel].contextWindow;
        else for (var mk in muAll) { if (muAll[mk] && muAll[mk].contextWindow > cw) cw = muAll[mk].contextWindow; }
        if (ownCtx && cw && session && session.ctx && session.ctx.used) {
          if (MODELS[ctxModel]) MODELS[ctxModel].ctx = cw;
          setCtx({ used: session.ctx.used, window: cw, model: ctxModel });
        }
      }
    }

    child.stdout.on("data", function (d) {
      stdoutBuf += d.toString("utf8");
      var lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop();
      lines.forEach(handleLine);
    });
    child.stderr.on("data", function (d) {
      var s = d.toString("utf8");
      stderrOut += s;
      logLine("[stderr] " + s.trim());
    });

    child.on("error", function (e) {
      if (currentRun === run) currentRun = null;
      cb("Failed to run " + SHELL_NAME + ": " + e.message);
    });

    child.on("close", function (code) {
      if (currentRun === run) currentRun = null;
      if (stdoutBuf.trim()) handleLine(stdoutBuf);
      try { fs.unlinkSync(promptFile); } catch (e) { }

      // Catch-all: whatever path this CLI version used to report the missing
      // permission tool (stderr, exit 0, late print), never surface the
      // cryptic string itself — always show the real diagnosis.
      if (!connectorFail && bridgePort &&
        /permission-prompt-tool|Available MCP tools/i.test(stderrOut + "\n" + rawText)) {
        connectorFail = connectorFailText();
      }

      if (connectorFail) { cb(connectorFail + "\nFull log: " + LOG_FILE); return; }
      if (run.cancelled) { cb("CANCELLED"); return; }

      // Auth ground truth: the CLI itself reporting an authentication failure
      // beats the local credential check — server-side logouts and revoked
      // sessions leave a stale credentials file that still looks signed in.
      var ranOk = (code === 0 && resultEv && !resultEv.is_error);
      if (ranOk) {
        clearAuthLoss();
        // Remember the CLI session so the chat's next send resumes it.
        if (sidSeen && opts.onSid) opts.onSid(sidSeen);
        else if (sidSeen && session && session.claudeSid !== sidSeen) {
          session.claudeSid = sidSeen; ownSession("claude");
          sessionDirty = true;
          saveSessionSoon();
        }
      }
      else if (/invalid api key|please run \/login|oauth token (?:has )?expired|authentication[_ ]?error|oauth[^\n]{0,40}revoked/i.test(
        stderrOut + "\n" + rawText + "\n" + (resultEv ? String(resultEv.result || "") : ""))) {
        noteAuthLoss();
        cb("⚠ You've been signed out of Claude, so this run could not go through.\n" +
          "Fix: open a terminal, run 'claude', complete the sign-in it offers, then click the panel's status dot and try again.\nFull log: " + LOG_FILE);
        return;
      }

      if (code !== 0) {
        var msg = (stderrOut || rawText || "").trim() || ("Claude CLI exited with code " + code);
        if (/is not recognized|CommandNotFound/i.test(msg)) {
          msg = "The 'claude' command was not found. Install Claude Code (npm install -g @anthropic-ai/claude-code) and make sure it is on your PATH, then restart After Effects.";
        }
        // Some CLI versions hard-fail before the init event when the connector
        // is missing ("MCP tool mcp__ae__approve ... not found") — translate.
        if (/permission-prompt-tool|Available MCP tools/i.test(msg)) {
          msg = connectorFailText();
        }
        var unknownFlag = /unknown option|unknown argument|unrecognized option|unknown flag/i.test(msg);
        var effortProblem = includeEffort && unknownFlag && /--effort/.test(msg);
        var settingsProblem = unknownFlag && /--settings/.test(msg);
        // A stale/foreign session id (cleaned ~/.claude, other machine) must
        // never brick the chat — the caller drops the id and retries fresh.
        var resumeProblem = !!resumeSid &&
          /no conversation found|session.{0,25}not found|could not (?:be )?resum|unable to resume|--resume/i.test(msg);
        // Mac runs carry --debug, so raw stderr can be huge — show its tail
        // only (the full text is in the log). Pattern tests above ran on the
        // full string.
        if (IS_MAC && msg.length > 1500) msg = "…" + msg.slice(-1500);
        cb(msg + "\nFull log: " + LOG_FILE, null, effortProblem, settingsProblem, resumeProblem);
        return;
      }

      if (resultEv && resultEv.is_error) {
        var rmsg = String(resultEv.result || resultEv.subtype || "unknown");
        if (/permission-prompt-tool|Available MCP tools/i.test(rmsg)) rmsg = connectorFailText();
        cb("Claude reported an error: " + rmsg + "\nFull log: " + LOG_FILE);
        return;
      }

      var finalText = assistantText.join("\n").trim() || (resultEv && resultEv.result) || rawText.trim();
      if (!finalText) {
        cb("Claude returned an empty response.\nFull log: " + LOG_FILE);
        return;
      }
      if (resultEv && resultEv.usage) onEvent({ kind: "usage", usage: resultEv.usage });
      if (resultEv && typeof resultEv.duration_ms === "number") {
        var doneLine = "✅ Finished in " + Math.round(resultEv.duration_ms / 1000) + "s";
        if (resultEv.usage) {
          var u = resultEv.usage;
          var runTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) +
            (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
          if (runTok) doneLine += " · " + runTok.toLocaleString() + " tokens";
        }
        onEvent({ kind: "log", text: doneLine });
      }
      cb(null, finalText);
    });
    } // launchRun
  }

  // ---------- Codex CLI engine (GPT models) ----------
  /* Argument list for one `codex exec` run. Fresh runs pin the working dir;
   * resumes can't (the subcommand has no -C) but inherit it from the thread.
   * The ae connector is handed over as -c config overrides (no config file
   * is written into ~/.codex). Tool timeout is raised because Ask mode can
   * park a run_script on the permission bar for minutes. */
  function codexArgs(o) {
    var a = ["exec"];
    if (o.resumeTid) a.push("resume", o.resumeTid);
    else a.push("-C", o.cwd || WORK_DIR);
    a.push("-", "--json", "--skip-git-repo-check");
    if (o.model) a.push("-m", o.model);
    if (o.effort) a.push("-c", 'model_reasoning_effort="' + o.effort + '"');
    a.push("-c", 'approval_policy="never"');
    a.push("-c", 'sandbox_mode="workspace-write"');
    a.push("-c", "sandbox_workspace_write.network_access=true");
    if (o.withMcp && localStorage.getItem("claude-ae-no-codex-search") !== "1") a.push("-c", 'web_search="live"'); // research when unsure
    if (o.withMcp && bridgePort) {
      var nodeCmd = (NODE_BIN || "node").replace(/\\/g, "/");
      var mcpPath = String(MCP_SERVER_RUN).replace(/\\/g, "/");
      a.push("-c", 'mcp_servers.ae.command="' + nodeCmd + '"');
      a.push("-c", 'mcp_servers.ae.args=["' + mcpPath + '"]');
      a.push("-c", 'mcp_servers.ae.env={AE_BRIDGE_PORT="' + bridgePort + '",AE_BRIDGE_TOKEN="' + BRIDGE_TOKEN + '",AE_VIEW_TOOL="view_image"}');
      a.push("-c", "mcp_servers.ae.tool_timeout_sec=900");
      a.push("-c", "mcp_servers.ae.startup_timeout_sec=30");
    }
    (o.images || []).forEach(function (p) { a.push("-i", p); });
    if (o.lastFile) a.push("-o", o.lastFile);
    return a;
  }

  /* Run codex exec, stream its JSONL, hand back what the panel needs.
   * cb(err, { text, tid, usage, ms }) — err === "CANCELLED" when ■ was used. */
  function runCodexRaw(promptText, opts, onEvent, cb) {
    ensureDirs();
    var promptFile, lastFile;
    try {
      promptFile = path.join(WORK_DIR, "prompt-" + Date.now() + ".txt");
      lastFile = path.join(WORK_DIR, "codex-last-" + Date.now() + ".txt");
      fs.writeFileSync(promptFile, promptText, "utf8");
      if (opts.log !== false) {
        fs.writeFileSync(LOG_FILE, "=== run " + new Date().toISOString() +
          " (build " + PANEL_BUILD + ", engine: codex" + (CODEX_VER ? " " + CODEX_VER : "") +
          ", model: " + (opts.model || "default") + (opts.effort ? "/" + opts.effort : "") +
          ", node: " + (NODE_BIN || "node from PATH") + ") ===\n", "utf8");
      }
    } catch (e) { cb("Could not write prompt file: " + e.message); return; }
    opts.lastFile = lastFile;
    var args = codexArgs(opts);
    try { fs.appendFileSync(LOG_FILE, "[codex] " + args.join(" ") + "\n"); } catch (e) { }

    var child;
    try { child = spawnCodex(args, opts.cwd || WORK_DIR); }
    catch (e) { cb("Could not start the Codex CLI: " + e.message); return; }
    var run = { child: child, cancelled: false };
    if (opts.nested) subRun = run; else currentRun = run;
    var t0 = Date.now();
    var stdoutBuf = "", stderrOut = "", rawText = "";
    var texts = [], tid = "", errMsg = "", usage = null, sawTurn = false;

    function logLine(line) { try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (e) { } }
    function handleLine(line) {
      line = line.replace(/\r$/, "");
      if (!line.trim()) return;
      logLine(line);
      var ev;
      try { ev = JSON.parse(line); } catch (e) { rawText += line + "\n"; return; }
      var t = ev.type || "";
      if (t === "thread.started") {
        if (ev.thread_id) tid = String(ev.thread_id);
      } else if (t === "turn.started") {
        sawTurn = true;
        onEvent({ kind: "phase", text: "GPT is working… (" + prettyModel(opts.model) + ")" });
      } else if (t === "item.started" || t === "item.completed") {
        var it = ev.item || {}, ty = it.type || "";
        if (ty === "agent_message" && t === "item.completed" && it.text) {
          texts.push(String(it.text));
          onEvent({ kind: "text", text: String(it.text) });
        } else if (ty === "reasoning" && t === "item.started") {
          onEvent({ kind: "phase", text: "GPT is thinking…" });
        } else if (ty === "command_execution" && t === "item.started") {
          var c = String(it.command || "").replace(/\s+/g, " ");
          if (c.length > 90) c = c.substring(0, 90) + "…";
          onEvent({ kind: "log", text: "🛠 " + c });
        } else if (ty === "command_execution" && t === "item.completed" && it.exit_code) {
          onEvent({ kind: "log", text: "⚠ command exited with code " + it.exit_code });
        } else if (ty === "web_search" && t === "item.started") {
          onEvent({ kind: "log", text: "🌐 " + (it.query || "web search") });
        } else if (ty === "mcp_tool_call" && t === "item.completed" && it.status === "failed") {
          onEvent({ kind: "log", text: "⚠ ae tool call failed: " + (it.tool || "") + " " + ((it.error && it.error.message) || "") });
        } else if (ty === "error" && it.message) {
          errMsg = String(it.message);
        }
      } else if (t === "turn.completed") {
        if (ev.usage) {
          var u = ev.usage;
          usage = usage || { input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
          usage.input_tokens += Math.max(0, (u.input_tokens || 0) - (u.cached_input_tokens || 0));
          usage.cache_read_input_tokens += (u.cached_input_tokens || 0);
          usage.output_tokens += (u.output_tokens || 0);
        }
      } else if (t === "turn.failed") {
        errMsg = (ev.error && ev.error.message) || errMsg || "The Codex turn failed.";
      } else if (t === "error") {
        errMsg = ev.message || errMsg;
      }
    }
    child.stdout.on("data", function (d) {
      stdoutBuf += d.toString("utf8");
      var lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop();
      lines.forEach(handleLine);
    });
    child.stderr.on("data", function (d) {
      var x = d.toString("utf8");
      stderrOut += x;
      logLine("[stderr] " + x.trim());
    });
    child.on("error", function (e) {
      if (currentRun === run) currentRun = null;
      if (subRun === run) subRun = null;
      cb(/ENOENT/.test(String(e.message)) ? "CODEX_MISSING" : "Failed to start the Codex CLI: " + e.message);
    });
    try {
      child.stdin.on("error", function () { });
      child.stdin.write(promptText, "utf8");
      child.stdin.end();
    } catch (e) { }
    child.on("close", function (code) {
      if (currentRun === run) currentRun = null;
      if (subRun === run) subRun = null;
      if (stdoutBuf.trim()) handleLine(stdoutBuf);
      try { fs.unlinkSync(promptFile); } catch (e) { }
      var last = "";
      try { last = fs.readFileSync(lastFile, "utf8").trim(); fs.unlinkSync(lastFile); } catch (e) { }
      if (run.cancelled) { cb("CANCELLED"); return; }
      var all = errMsg + "\n" + stderrOut + "\n" + rawText;
      if (/is not recognized|CommandNotFound|ENOENT/i.test(stderrOut) && !sawTurn) { cb("CODEX_MISSING"); return; }
      if (/not logged in|login required|run codex login|unauthorized|401/i.test(all) && !sawTurn) {
        cxCheck = { at: Date.now(), ok: false, why: 52 }; updateCodexDot();
        cb("CODEX_SIGNED_OUT"); return;
      }
      if (/usage limit|rate limit/i.test(errMsg)) {
        cb("⚠ Codex usage limit reached — " + errMsg.replace(/\s+/g, " ").trim() +
          "\nCheck remaining usage at chatgpt.com/codex/settings/usage (or /status inside codex). Meanwhile switch the Model pill to a Claude model.");
        return;
      }
      if (opts.resumeTid && !sawTurn && /no (?:such )?(?:session|thread|conversation)|not found|could not (?:be )?resum|failed to (?:load|resume)|invalid.{0,20}(?:id|uuid)/i.test(all)) {
        cb("CODEX_RESUME_FAILED"); return;
      }
      if (code !== 0 || (errMsg && !texts.length)) {
        var m = (errMsg || stderrOut || rawText || "").trim() || ("The Codex CLI exited with code " + code);
        if (m.length > 1500) m = "…" + m.slice(-1500);
        cb(m + "\nFull log: " + LOG_FILE);
        return;
      }
      var finalText = (texts.length ? texts[texts.length - 1] : "") || last || rawText.trim();
      cb(null, { text: finalText, allText: texts.join("\n").trim() || last, tid: tid, usage: usage, ms: Date.now() - t0 });
    });
  }

  /* Full GPT build run — the Codex counterpart of startClaude. */
  function startCodex(promptText, includeEffort, onEvent, cb) {
    var resumeTid = (session && session.codexTid) || "";
    var images = [];
    (runRefs || []).forEach(function (r) { if (r.isImage) images.push(r.path); });
    runCodexRaw(promptText, {
      model: modelEl.value, effort: includeEffort ? (effortEl.value || "medium") : "", // Astra: medium unless the pill says otherwise (its default burns the session)
      resumeTid: resumeTid, withMcp: true, images: images, cwd: WORK_DIR
    }, onEvent, function (err, res) {
      if (err) {
        if (err === "CODEX_MISSING") { cb(codexAdvice(51, "model")); return; }
        if (err === "CODEX_SIGNED_OUT") { cb(codexAdvice(52, "model")); return; }
        if (err === "CODEX_RESUME_FAILED") { cb(err, null, false, false, true); return; }
        cb(err);
        return;
      }
      setCtx({ codex: true }); // Codex reports per-turn totals, not the context size
      if (res.tid && session && session.codexTid !== res.tid) {
        session.codexTid = res.tid; ownSession("codex");
        sessionDirty = true;
        saveSessionSoon();
      }
      if (res.usage) onEvent({ kind: "usage", usage: res.usage });
      var doneLine = "✅ Finished in " + Math.round(res.ms / 1000) + "s";
      if (res.usage) {
        var tot = res.usage.input_tokens + res.usage.cache_read_input_tokens + res.usage.output_tokens;
        if (tot) doneLine += " · " + tot.toLocaleString() + " tokens";
      }
      onEvent({ kind: "log", text: doneLine });
      if (!res.allText) { cb("GPT returned an empty response.\nFull log: " + LOG_FILE); return; }
      cb(null, res.allText);
    });
  }

  /* Engine dispatch + retry when this CLI version rejects an optional flag
   * (--effort, --settings) or a stale session can't be resumed. */
  function runClaude(promptText, onEvent, cb) {
    if (curEngine() === "codex") {
      var wantEffortCx = !!effortEl.value && effortAllowed(effortEl.value);
      startCodex(promptText, wantEffortCx, onEvent, function (err, finalText, ep, sp, resumeProblem) {
        if (err && err !== "CANCELLED" && resumeProblem) {
          if (session) session.codexTid = "";
          sessionDirty = true;
          onEvent({ kind: "log", text: "Couldn't resume this chat's earlier Codex thread — continuing fresh (the chat transcript above is unaffected)." });
          runClaude(promptText, onEvent, cb);
          return;
        }
        cb(err, finalText);
      });
      return;
    }
    var wantEffort = !!effortEl.value && effortAllowed(effortEl.value) && localStorage.getItem("claude-ae-no-effort") !== "1";
    startClaude(promptText, wantEffort, onEvent, function (err, finalText, effortProblem, settingsProblem, resumeProblem) {
      if (err && err !== "CANCELLED" && (effortProblem || settingsProblem || resumeProblem)) {
        if (effortProblem) {
          localStorage.setItem("claude-ae-no-effort", "1");
          onEvent({ kind: "log", text: "This Claude CLI version doesn't support --effort — retrying without it." });
        }
        if (settingsProblem) {
          localStorage.setItem("claude-ae-no-settings", "1");
          onEvent({ kind: "log", text: "This Claude CLI version doesn't support --settings — retrying without the hard tool gate (approval prompts still apply)." });
        }
        if (resumeProblem) {
          if (session) session.claudeSid = "";
          sessionDirty = true;
          onEvent({ kind: "log", text: "Couldn't resume this chat's earlier Claude session — continuing fresh (the chat transcript above is unaffected)." });
        }
        runClaude(promptText, onEvent, cb);
        return;
      }
      cb(err, finalText);
    });
  }

  /* One full "ask Claude" round: streams commentary/tool logs into the chat
   * and returns the extracted script (or null for a plain chat answer). */
  function askClaude(promptText, phaseLabel, cb) {
    setBusy(true);
    toolsUsedThisRun = false;
    var ticker = addTicker(phaseLabel);
    var lastScript = null;
    var shownText = false;

    runClaude(promptText, function (ev) {
      if (ev.kind === "phase") {
        ticker.setLabel(ev.text);
      } else if (ev.kind === "usage") {
        addTokenUsage(ev.usage);
      } else if (ev.kind === "log") {
        addStatus(ev.text, "log");
      } else if (ev.kind === "text") {
        var s = splitCode(ev.text);
        if (s.codes.length) lastScript = s.codes[s.codes.length - 1];
        if (s.prose) { addClaudeMsg(s.prose); shownText = true; }
      }
    }, function (err, finalText) {
      ticker.stop();
      if (err === "CANCELLED") { setBusy(false); cb("CANCELLED", null); return; }
      if (err) {
        addStatus("✗ " + err, "error");
        setBusy(false);
        cb(err, null);
        return;
      }
      if (toolsUsedThisRun) {
        // The model already did the work through the live AE connector; any code
        // fence in the reply is illustrative, not something to execute again.
        if (!shownText && finalText) addClaudeMsg(splitCode(finalText).prose || finalText);
        cb(null, null, { usedTools: true, finalText: finalText });
        return;
      }
      if (!lastScript && finalText && looksLikeScript(finalText)) {
        // Model skipped the fences and answered in raw code.
        var s = splitCode(finalText);
        lastScript = s.codes.length ? s.codes[s.codes.length - 1] : finalText.trim();
      }
      if (!lastScript && !shownText && finalText) {
        addClaudeMsg(splitCode(finalText).prose || finalText);
      }
      cb(null, lastScript);
    });
  }

  // ---------- token usage ----------
  // The CLI doesn't expose the account's session/rate limit, so the closest
  // honest signal is real token consumption, summed from each run's result.
  function fmtTokens(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1) + "k";
    return String(n);
  }

  // ---------- context window ----------
  // session.ctx = { used, window, model } — how full the chat's own CLI session is. "used" is the
  // size of the LAST API call of the last run (input + cache + output), which is what the next
  // resumed run starts from. The window comes from the CLI's result event (modelUsage.contextWindow);
  // until a run reports it, these defaults stand in.
  var CTX_DEFAULT = 200000;
  function ctxWindowGuess(model) {
    if (session && session.ctx && session.ctx.model === model && session.ctx.window) return session.ctx.window;
    return (MODELS[model] && MODELS[model].ctx) || CTX_DEFAULT;
  }
  function setCtx(o) {
    if (!session) return;
    session.ctx = o;
    sessionDirty = true;
    updateTokenInfo();
  }

  function updateTokenInfo() {
    var total = tokensUsed.input + tokensUsed.output;
    var hasChat = sessionHasUserMsg();
    var cx = session && session.ctx;
    compactBtn.classList.toggle("hidden", !hasChat);
    tokenInfo.classList.remove("warn", "full");
    compactBtn.classList.remove("urge");
    var life = "Lifetime tokens for this chat: " + fmtTokens(total) +
      " (input incl. cache " + tokensUsed.input.toLocaleString() + " · output " + tokensUsed.output.toLocaleString() + ")";
    if (cx && cx.codex) {
      tokenInfo.innerHTML = '<span class="ctx-txt">ctx —</span>';
      tokenInfo.title = "Context window: GPT (Codex) runs don't report their context size.\n" + life;
      return;
    }
    if (!cx || !cx.used) {
      if (!hasChat && !total) { tokenInfo.innerHTML = ""; tokenInfo.title = ""; return; }
      var known = !(session && (session.claudeSid || session.codexTid));
      tokenInfo.innerHTML = '<span class="ctx-txt">ctx ' + (known ? "0" : "?") + '</span><span class="ctx-bar"><i style="width:0%"></i></span>';
      tokenInfo.title = (known ? "Context window: fresh session — the next run starts from an empty context.\n"
        : "Context window: not measured yet for this chat — it shows after the next run.\n") + life;
      return;
    }
    var win = cx.window || CTX_DEFAULT, pct = Math.min(100, cx.used / win * 100);
    tokenInfo.innerHTML = '<span class="ctx-txt"></span><span class="ctx-bar"><i></i></span>';
    tokenInfo.querySelector(".ctx-txt").textContent = fmtTokens(cx.used) + " / " + fmtTokens(win);
    tokenInfo.querySelector(".ctx-bar i").style.width = pct.toFixed(1) + "%";
    if (pct >= 85) tokenInfo.classList.add("full");
    else if (pct >= 60) tokenInfo.classList.add("warn");
    if (pct >= 70) compactBtn.classList.add("urge");
    tokenInfo.title = "Context window: " + cx.used.toLocaleString() + " of " + win.toLocaleString() + " tokens (" + Math.round(pct) + "%)" +
      (cx.model ? " · " + prettyModel(cx.model) : "") +
      "\nEvery call re-sends this whole context; compact (🗜) to start a fresh session from a short brief.\n" + life;
  }

  // ---------- compact (summarize a long chat in place) ----------
  /* One cheap Haiku call, no tools: turns the whole transcript into a short
   * brief that becomes the session's only context entry. */
  function runQuickClaude(promptText, cb, extraFlags, model) {
    ensureDirs();
    var pf = path.join(WORK_DIR, "compact-" + Date.now() + ".txt");
    try { fs.writeFileSync(pf, promptText, "utf8"); } catch (e) { cb("Could not write prompt: " + e.message); return; }
    var child;
    try {
      child = spawnClaude(pf, "-p --model " + (model || "haiku") + (extraFlags ? " " + extraFlags : ""), WORK_DIR, false);
    } catch (e) { cb("Could not start " + SHELL_NAME + ": " + e.message); return; }
    var run = { child: child, cancelled: false };
    currentRun = run;
    var out = "", errOut = "";
    child.stdout.on("data", function (d) { out += d.toString("utf8"); });
    child.stderr.on("data", function (d) { errOut += d.toString("utf8"); });
    child.on("error", function (e) { if (currentRun === run) currentRun = null; cb(SHELL_NAME + " failed: " + e.message); });
    child.on("close", function (code) {
      if (currentRun === run) currentRun = null;
      try { fs.unlinkSync(pf); } catch (e) { }
      if (run.cancelled) { cb("CANCELLED"); return; }
      if (code !== 0 || !out.trim()) { cb((errOut || "Claude CLI exited with code " + code).trim()); return; }
      cb(null, out.trim());
    });
  }

  /* What the compacted chat carries forward, shown as a readable card. */
  function compactCard(summary, itemCount, tokensBefore) {
    var labels = { BUILT: "**Built so far:** ", PREFERENCES: "**Your preferences:** ", UNFINISHED: "**Unfinished / next:** ", FILES: "**Files & references:** " };
    var lines = String(summary).split(/\n+/).map(function (l) {
      var mm = l.match(/^\s*(BUILT|PREFERENCES|UNFINISHED|FILES)\s*:\s*(.*)$/i);
      return mm ? "- " + labels[mm[1].toUpperCase()] + mm[2] : (l.trim() ? "- " + l.trim() : "");
    }).filter(function (l) { return l; });
    return "**What's kept for the next run**\n" + lines.join("\n") +
      "\n\n**Dropped:** " + itemCount + " chat items — scripts, logs, rendered frames and the old CLI session. The next run starts a fresh session with only the lines above, and re-reads the live comp with get_state, so nothing built in After Effects is lost." +
      "\n**Lifetime tokens for this chat:** " + fmtTokens(tokensBefore) + " (the counter keeps the total).";
  }

  compactBtn.addEventListener("click", function () {
    if (busy) { addStatus("Wait for the current run to finish before compacting.", "log"); return; }
    var items = [];
    session.messages.forEach(function (m) {
      if (m.type === "user") items.push("User: " + m.text);
      else if (m.type === "claude") items.push("Claude: " + m.text);
      else if (m.type === "status" && m.kind === "ok") items.push("Result: " + m.text);
    });
    if (items.length < 4) { addStatus("This chat is too short to compact.", "log"); return; }
    var transcript = items.join("\n");
    if (transcript.length > 60000) transcript = "…(earlier trimmed)…\n" + transcript.slice(-60000);
    var itemCount = session.messages.length;
    var tokensBefore = tokensUsed.input + tokensUsed.output;
    setBusy(true);
    var ticker = addTicker("Compacting chat…");
    runQuickClaude(
      "Summarize this After Effects assistant chat so the assistant can continue seamlessly. Plain text, exactly these four labelled lines, each under 60 words:\nBUILT: what exists in the comp now (comp names, chapters/layers, timing, palette, fonts, style)\nPREFERENCES: what the user asked for or rejected, in their terms\nUNFINISHED: what is left or was promised next\nFILES: reference files, generated assets or comps mentioned by name\n\n" + transcript,
      function (err, summary) {
        ticker.stop();
        setBusy(false);
        if (err === "CANCELLED") return;
        if (err) { addStatus("✗ Compact failed: " + err, "error"); return; }
        history = [{ task: "[chat compacted — everything before this point is summarized in the outcome]", script: null, result: summary }];
        session.claudeSid = ""; // fresh CLI session — the brief above IS the context now
        session.codexTid = "";
        session.messages = [];
        session.ctx = null; // the next run starts an empty context
        sessionDirty = true;
        chatEl.innerHTML = "";
        tickerStack = [];
        var kept = compactCard(summary, itemCount, tokensBefore);
        addStatus("🗜 Chat compacted — " + itemCount + " items condensed. Kept for the next run (≈" + Math.round(summary.length / 3.7) + " tokens instead of the old transcript):", "ok");
        addClaudeMsg(kept);
        saveSession();
        updateTokenInfo();
      }
    );
  });

  function addTokenUsage(u) {
    var inTok = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    var outTok = (u.output_tokens || 0);
    tokensUsed.input += inTok;
    tokensUsed.output += outTok;
    sessionDirty = true;
    updateTokenInfo();
    saveSessionSoon();
  }

  // ---------- account switching ----------
  /* Remember which account created this chat's sessions for `provider`. */
  function ownSession(provider) {
    if (!session) return;
    session.accounts = session.accounts || {};
    session.accounts[provider] = selectedAccount(provider);
    if (session.switched) delete session.switched[provider];
  }

  /* A CLI session only resumes under the account that created it: drop it when another account is selected now. */
  function syncAccount(provider) {
    if (!session) return;
    var owner = (session.accounts || {})[provider];
    if (owner === undefined || owner === selectedAccount(provider)) return;
    var had = provider === "claude" ? session.claudeSid : session.codexTid;
    if (provider === "claude") { session.claudeSid = ""; }
    else { session.codexTid = ""; }
    session.ctx = null;
    updateTokenInfo();
    delete session.accounts[provider];
    sessionDirty = true;
    if (!had) return;
    session.switched = session.switched || {};
    session.switched[provider] = true;
    addStatus("This chat's " + PROVIDER_NAME[provider] + " session belongs to another account — the next prompt starts a fresh session that catches up from the " +
      (readHandbook() ? "Handbook" : "chat so far") + ".", "log");
  }

  function switchAccount(provider, folder) {
    if (busy) { addStatus("Stop the current run before switching accounts.", "log"); return; }
    try { localStorage.setItem("mp-account-" + provider, folder || ""); } catch (e) { }
    if (provider === "claude") { authKnownOut = false; updateAuthDot(); rebuildModelMenu(); }
    else { cxCheck = { at: 0, ok: false, why: 0 }; codexLoaded = false; checkCodex(function () { }); }
    addStatus("👤 " + PROVIDER_NAME[provider] + " account: " + describeAccount(provider, folder || ""), "log");
    if (sessionHasUserMsg()) syncAccount(provider);
    saveSessionSoon();
    syncAcctBtn();
  }

  /* Top-bar popup menu (same look as the composer pills), opened under its button. */
  function topMenu(btn, buildItems) {
    var pop = document.createElement("div");
    pop.className = "dd-pop hidden";
    pop.onclick = function (ev) { ev.stopPropagation(); };
    document.body.appendChild(pop);
    function close() { pop.classList.add("hidden"); }
    menuClosers.push(close);
    btn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      var wasOpen = !pop.classList.contains("hidden");
      closeMenus();
      if (wasOpen) return;
      pop.innerHTML = "";
      buildItems(function head(text) {
        var hd = document.createElement("div"); hd.className = "dd-head"; hd.textContent = text; pop.appendChild(hd);
      }, function item(name, meta, sel, onPick) {
        var it = document.createElement("div");
        it.className = "dd-item" + (sel ? " sel" : "") + (onPick ? "" : " dd-off");
        var nm = document.createElement("div"); nm.className = "pi-name"; nm.textContent = name; it.appendChild(nm);
        if (meta) { var mt = document.createElement("div"); mt.className = "pi-meta"; mt.textContent = meta; it.appendChild(mt); }
        if (onPick) it.onclick = function () { close(); onPick(); };
        pop.appendChild(it);
      });
      pop.classList.remove("hidden");
      var r = btn.getBoundingClientRect();
      pop.style.bottom = "";
      pop.style.top = (r.bottom + 6) + "px";
      pop.style.left = Math.max(4, Math.min(r.right - pop.offsetWidth, window.innerWidth - pop.offsetWidth - 4)) + "px";
    });
  }

  var acctBtn = document.getElementById("acctBtn");
  function syncAcctBtn() {
    if (!acctBtn) return;
    var c = selectedAccount("claude"), x = selectedAccount("codex");
    acctBtn.classList.toggle("alt", !!(c || x));
    acctBtn.title = "Accounts — switch between signed-in Claude / ChatGPT logins\nClaude: " + describeAccount("claude", c) +
      "\nChatGPT (Codex): " + describeAccount("codex", x);
  }
  if (acctBtn) {
    topMenu(acctBtn, function (head, item) {
      ["claude", "codex"].forEach(function (p) {
        head(PROVIDER_NAME[p] + " accounts");
        var cur = selectedAccount(p), found = listAccounts(p);
        if (!found.length) item("No signed-in account found", p === "claude" ? "Run 'claude' once to sign in" : "Run 'codex login' to sign in", false, null);
        found.forEach(function (a) {
          item(a.label + (a.folder === cur ? "  ✓" : ""), a.email || "(no email on file)", a.folder === cur,
            a.folder === cur ? null : function () { switchAccount(p, a.folder); });
        });
      });
    });
    syncAcctBtn();
  }

  // ---------- handbook (per-chat hand-over note) ----------
  var HANDBOOK_PROMPT =
    "[MotionPilot] The user pressed Handbook: write this chat's Handbook.md — a hand-over document that lets a fresh " +
    "session (another account or model, with no memory of this conversation) continue the After Effects work. " +
    "Do NOT call any tools. Reply with only the Markdown document, starting with `# Handbook`, under these headings:\n" +
    "## Project — what the user is making, the overall goal, format, style pack / look and references (file paths)\n" +
    "## Built so far — comps (names, size, fps, duration), chapters/beats with timings, key layer names, palette hexes, fonts, generated assets and their paths\n" +
    "## Decisions and preferences — what the user asked for or rejected, in their terms; settings to keep\n" +
    "## How to work on it — AE.* helpers, moves, expressions and techniques that worked; ExtendScript traps hit\n" +
    "## Open issues and next steps\n" +
    "Be specific (names, numbers) and complete, but leave out tool logs and code. At most ~700 words.";

  function handbookPath(s) {
    s = s || session;
    return s && s.id ? path.join(CFG_DIR, "handbooks", s.id, "Handbook.md") : "";
  }
  function readHandbook() {
    var p = handbookPath();
    if (!p) return "";
    try { return fs.readFileSync(p, "utf8").trim(); } catch (e) { return ""; }
  }
  /* The chat so far as plain text (newest kept when trimmed). */
  function chatTranscript(limit) {
    var items = [];
    (session.messages || []).forEach(function (m) {
      if (m.type === "user") items.push("User: " + m.text);
      else if (m.type === "claude") items.push("Assistant: " + m.text);
      else if (m.type === "status" && m.kind === "ok") items.push("Result: " + m.text);
    });
    var t = items.join("\n");
    if (limit && t.length > limit) t = "…(earlier trimmed)…\n" + t.slice(-limit);
    return t;
  }

  var handbookBtn = document.getElementById("handbookBtn");
  function syncHandbookBtn() {
    if (!handbookBtn) return;
    var has = !!readHandbook();
    handbookBtn.classList.toggle("hidden", !sessionHasUserMsg());
    handbookBtn.classList.toggle("has", has);
    handbookBtn.title = has ? "Handbook ✓ — this chat has a Handbook.md; a fresh session (after an account or model switch) reads it first. Click to update or open it."
      : "Handbook — have the model write this chat's Handbook.md (the project, what's built, next steps) so another account or model can take over";
  }
  function openPath(p) {
    try { cp.exec(IS_MAC ? "open " + shQuote(p) : 'start "" "' + p + '"', { windowsHide: true }); } catch (e) { }
  }

  function makeHandbook() {
    if (busy) { addStatus("Wait for the current run to finish.", "log"); return; }
    if (!sessionHasUserMsg()) { addStatus("Nothing to write a handbook about yet.", "log"); return; }
    var engine = curEngine();
    if (engine === "claude" && updateAuthDot() === "out") { addStatus("⚠ Claude sign-in needed for the selected account — run 'claude' to log in, then try again.", "err"); return; }
    if (engine === "codex" && !codexUsable()) { addStatus(codexAdvice(cxCheck.why, "model"), "err"); return; }
    syncAccount(engine);
    var old = readHandbook();
    var base = HANDBOOK_PROMPT + (old ? "\n\nThe current Handbook.md, to update (keep what is still true):\n\n" + old : "");
    function withTranscript() {
      var past = history.filter(function (h) { return h.task.charAt(0) === "[" && h.result; }).map(function (h) { return h.result; }).join("\n");
      return "The conversation so far:\n\n" + (past ? "Summary of the earlier part:\n" + past + "\n\n" : "") +
        chatTranscript(12000) + "\n\n[End of conversation]\n\n" + base;
    }
    setBusy(true);
    var ticker = addTicker("Writing the Handbook…");
    function done(err, text) {
      ticker.stop();
      setBusy(false);
      if (err === "CANCELLED") { addStatus("Handbook stopped — nothing was written.", "log"); return; }
      text = String(text || "").trim();
      var at = text.indexOf("# Handbook");
      if (at > 0) text = text.slice(at);
      text = text.replace(/^```(?:markdown|md)?\s*\n/, "").replace(/\n```\s*$/, "").trim();
      if (err || !text) { addStatus("✗ The model couldn't write the Handbook" + (err ? ": " + err : ".") + "\nLog: " + LOG_FILE, "error"); return; }
      var p = handbookPath();
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, text + "\n", "utf8");
      } catch (e) { addStatus("✗ Could not save the Handbook: " + e.message, "error"); return; }
      session.handbook = p;
      sessionDirty = true;
      saveSession();
      addStatus("📖 Handbook " + (old ? "updated" : "saved") + " — a fresh session (after an account or model switch) reads it first.\n" + p, "ok");
      syncHandbookBtn();
    }
    if (engine === "codex") {
      var go = function (resumeTid) {
        runCodexRaw(resumeTid ? base : withTranscript(), { model: modelEl.value, effort: "low", resumeTid: resumeTid, withMcp: false, cwd: WORK_DIR, log: false },
          function () { }, function (err, res) {
            if (err === "CODEX_RESUME_FAILED") { session.codexTid = ""; go(""); return; }
            if (err === "CODEX_SIGNED_OUT") err = codexAdvice(52, "model");
            done(err, res && (res.allText || res.text));
          });
      };
      go(session.codexTid || "");
      return;
    }
    var model = buildModel() || "opus";
    var sid = session.claudeSid || "";
    runQuickClaude(sid ? base : withTranscript(), function (err, out) {
      if (err && err !== "CANCELLED" && sid) {
        // The session couldn't be resumed (expired or another account's) — write it from the transcript instead.
        session.claudeSid = "";
        sessionDirty = true;
        runQuickClaude(withTranscript(), done, "", model);
        return;
      }
      done(err, out);
    }, sid ? "--resume " + cliQuote(sid) : "", model);
  }

  if (handbookBtn) {
    topMenu(handbookBtn, function (head, item) {
      var has = !!readHandbook();
      head("This chat's Handbook");
      item(has ? "Update Handbook.md" : "Create Handbook.md",
        "The current model writes the project, what's built and next steps (one low-effort call)", false, makeHandbook);
      if (has) item("Open Handbook.md", handbookPath(), false, function () { openPath(handbookPath()); });
    });
    syncHandbookBtn();
    setInterval(syncHandbookBtn, 3000); // cheap: one stat-sized read; follows new / loaded chats
  }

  // ---------- chat history panel ----------
  function listSessions() {
    var out = [];
    try {
      fs.readdirSync(SESS_DIR).forEach(function (f) {
        if (!/\.json$/.test(f)) return;
        try {
          var data = JSON.parse(fs.readFileSync(path.join(SESS_DIR, f), "utf8"));
          if (data && data.id && data.messages && data.messages.length) out.push(data);
        } catch (e) { }
      });
    } catch (e) { }
    out.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    return out;
  }

  function fmtDate(ts) {
    var d = new Date(ts);
    return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function openHistory() {
    historyList.innerHTML = "";
    var sessions = listSessions();
    if (!sessions.length) {
      var none = document.createElement("div");
      none.className = "hp-empty";
      none.textContent = "No saved chats yet. Chats are saved automatically once you send a message.";
      historyList.appendChild(none);
    }
    sessions.forEach(function (s) {
      var row = document.createElement("div");
      row.className = "hp-item" + (s.id === session.id ? " current" : "");
      var main = document.createElement("div");
      main.className = "hp-main";
      var t = document.createElement("div");
      t.className = "hp-title";
      t.textContent = s.title || "(untitled chat)";
      var d = document.createElement("div");
      d.className = "hp-date";
      d.textContent = fmtDate(s.updatedAt || s.createdAt) + " · " + s.messages.length + " items" +
        (s.id === session.id ? " · current" : "");
      main.appendChild(t);
      main.appendChild(d);
      main.onclick = function () { closeHistory(); loadSession(s); };
      row.appendChild(main);
      var ren = document.createElement("button");
      ren.className = "hp-ren";
      ren.innerHTML = "&#9998;";
      ren.title = "Rename this chat";
      ren.onclick = function (ev) {
        ev.stopPropagation();
        var inp = document.createElement("input");
        inp.className = "hp-rename";
        inp.value = s.title || "";
        inp.onclick = function (e2) { e2.stopPropagation(); };
        var closed = false;
        function commit(save) {
          if (closed) return;
          closed = true;
          var v = inp.value.trim();
          if (save && v && v !== s.title) {
            s.title = v;
            try {
              // Renaming must not reshuffle history, so updatedAt is untouched.
              if (s.id === session.id) {
                session.title = v;
                fs.writeFileSync(path.join(SESS_DIR, session.id + ".json"), JSON.stringify(session), "utf8");
              } else {
                fs.writeFileSync(path.join(SESS_DIR, s.id + ".json"), JSON.stringify(s), "utf8");
              }
            } catch (e) { }
          }
          t.textContent = s.title || "(untitled chat)";
        }
        inp.onblur = function () { commit(true); };
        inp.onkeydown = function (ke) {
          if (ke.key === "Enter") inp.blur();
          else if (ke.key === "Escape") commit(false);
        };
        t.textContent = "";
        t.appendChild(inp);
        inp.focus();
        inp.select();
      };
      row.appendChild(ren);
      var del = document.createElement("button");
      del.className = "hp-del";
      del.innerHTML = "&times;";
      del.title = "Delete this chat";
      del.onclick = function (ev) {
        ev.stopPropagation();
        try { fs.unlinkSync(path.join(SESS_DIR, s.id + ".json")); } catch (e) { }
        removeEl(row);
      };
      row.appendChild(del);
      historyList.appendChild(row);
    });
    historyPanel.classList.remove("hidden");
  }

  function closeHistory() { historyPanel.classList.add("hidden"); }

  historyBtn.addEventListener("click", function () {
    if (historyPanel.classList.contains("hidden")) openHistory();
    else closeHistory();
    cachePanel.classList.add("hidden");
  });
  historyClose.addEventListener("click", closeHistory);

  // ---------- cache manager ----------
  // Everything the panel writes to disk that is safe to throw away: preview
  // frames / prompts / logs in %TEMP%, copied reference files, and the
  // Recreate pre-render cache in Documents. Chat history, sign-in and the
  // config cache are never touched.
  function dirStats(dir, skipNames) {
    var out = { bytes: 0, files: 0 };
    function walk(d, top) {
      var names;
      try { names = fs.readdirSync(d); } catch (e) { return; }
      for (var i = 0; i < names.length; i++) {
        if (top && skipNames && skipNames.indexOf(names[i]) !== -1) continue;
        var fp = path.join(d, names[i]), st;
        try { st = fs.statSync(fp); } catch (e2) { continue; }
        if (st.isDirectory()) walk(fp, false);
        else { out.bytes += st.size; out.files++; }
      }
    }
    walk(dir, true);
    return out;
  }

  function fmtBytes(b) {
    if (b >= 1073741824) return (b / 1073741824).toFixed(2) + " GB";
    if (b >= 1048576) return (b / 1048576).toFixed(1) + " MB";
    if (b >= 1024) return Math.round(b / 1024) + " KB";
    return b + " B";
  }

  function clearDir(dir, skipNames) {
    var names;
    try { names = fs.readdirSync(dir); } catch (e) { return; }
    names.forEach(function (n) {
      if (skipNames && skipNames.indexOf(n) !== -1) return;
      var fp = path.join(dir, n), st;
      try { st = fs.statSync(fp); } catch (e2) { return; }
      try {
        if (st.isDirectory()) { clearDir(fp, null); fs.rmdirSync(fp); }
        else fs.unlinkSync(fp);
      } catch (e3) { } // a locked file just stays — never crash the panel over it
    });
  }

  function cacheCategories() {
    // sessions can live under WORK_DIR when the CEP user-data path is
    // unavailable — never count or delete chat history as "cache".
    return [
      { label: "Preview frames, prompts & logs", dir: WORK_DIR, skip: ["refs", "sessions"] },
      { label: "Reference file copies", dir: REFS_DIR, skip: null },
      { label: "Recreate render cache (Documents)", dir: CACHE_ROOT, skip: null }
    ];
  }

  function openCachePanel() {
    closeHistory();
    cacheList.innerHTML = "";
    var cats = cacheCategories();
    var total = 0, totalFiles = 0;
    cats.forEach(function (c) {
      var s = dirStats(c.dir, c.skip);
      total += s.bytes;
      totalFiles += s.files;
      var row = document.createElement("div");
      row.className = "ch-row";
      var name = document.createElement("div");
      name.className = "ch-name";
      name.textContent = c.label;
      var meta = document.createElement("div");
      meta.className = "ch-meta";
      meta.textContent = s.files + " file(s) · " + fmtBytes(s.bytes);
      row.appendChild(name);
      row.appendChild(meta);
      cacheList.appendChild(row);
    });
    var totRow = document.createElement("div");
    totRow.className = "ch-row ch-total";
    totRow.innerHTML = "<div class='ch-name'>Total</div>";
    var totMeta = document.createElement("div");
    totMeta.className = "ch-meta";
    totMeta.textContent = totalFiles + " file(s) · " + fmtBytes(total);
    totRow.appendChild(totMeta);
    cacheList.appendChild(totRow);

    var note = document.createElement("div");
    note.className = "ch-note";
    note.textContent = "Chat history and sign-in are never touched. After clearing: older chats' preview thumbnails may stop displaying, and Recreate references will re-render on next use.";
    cacheList.appendChild(note);

    var clearBtn = document.createElement("button");
    clearBtn.className = "ch-clear";
    clearBtn.textContent = totalFiles ? "🗑 Clear cache (" + fmtBytes(total) + ")" : "Nothing to clear";
    clearBtn.disabled = !totalFiles;
    clearBtn.onclick = function () {
      if (busy) { addStatus("Stop the current run before clearing the cache — its files may be in use.", "log"); return; }
      clearBtn.disabled = true;
      clearBtn.textContent = "Clearing…";
      setTimeout(function () { // let the label paint before the sync deletes
        cats.forEach(function (c) { clearDir(c.dir, c.skip); });
        ensureDirs();
        addStatus("🗑 Cache cleared — freed " + fmtBytes(total) + " (" + totalFiles + " files).", "ok");
        openCachePanel(); // re-render with fresh (near-zero) numbers
      }, 30);
    };
    cacheList.appendChild(clearBtn);

    cachePanel.classList.remove("hidden");
  }

  cacheBtn.addEventListener("click", function () {
    if (cachePanel.classList.contains("hidden")) openCachePanel();
    else cachePanel.classList.add("hidden");
  });
  cacheClose.addEventListener("click", function () { cachePanel.classList.add("hidden"); });

  // ---------- revert (undo the last prompt's edits) ----------
  revertBtn.addEventListener("click", function () {
    if (busy) { addStatus("Stop the current run before reverting.", "log"); return; }
    if (!editsSincePrompt) { addStatus("Nothing from the last prompt to undo.", "log"); return; }
    var n = editsSincePrompt;
    editsSincePrompt = 0;
    var jsx = '(function(){var k=0;try{for(var i=0;i<' + n + ';i++){app.executeCommand(16);k++;}}catch(e){}return String(k);})()';
    csInterface.evalScript(jsx, function (res) {
      addStatus("↩ Reverted " + res + " edit(s) from the last prompt (AE Edit ▸ Undo). If it went one step too far, press Ctrl+Shift+Z in AE.", "ok");
      history.push({ task: "[user clicked Revert — your previous changes were undone in AE; the comp is back to its earlier state]", script: null, result: "reverted" });
      sessionDirty = true;
      saveSessionSoon();
    });
  });

  function renderEntry(m) {
    if (m.type === "user") addUserMsg(m.text, m.refs);
    else if (m.type === "claude") addClaudeMsg(m.text);
    else if (m.type === "status") addStatus(m.text, m.kind);
    else if (m.type === "script") addScriptCard(m.code);
    else if (m.type === "frame") addFramePreview(m.path, m.t);
    else if (m.type === "sheets") addSheetsMsg(m.dir, m.names);
  }

  function loadSession(data) {
    if (busy) stopCurrent();
    hidePermBar();
    saveSession(); // keep whatever chat we're leaving
    session = data;
    history = data.history || [];
    tokensUsed = data.tokens || { input: 0, output: 0 };
    attachments = [];
    renderChips();
    chatEl.innerHTML = "";
    tickerStack = [];
    emptyEl = null;
    replaying = true;
    try { (data.messages || []).forEach(renderEntry); } catch (e) { }
    replaying = false;
    sessionDirty = false; // just opened — no new activity yet
    updateTokenInfo();
    scrollDown();
  }

  // ---------- image lightbox ----------
  function openLightbox(src) {
    lbImg.src = src;
    lightbox.classList.remove("hidden");
  }
  function closeLightbox() {
    lightbox.classList.add("hidden");
    lbImg.src = "";
  }
  lbClose.addEventListener("click", closeLightbox);
  lightbox.addEventListener("click", function (ev) { if (ev.target === lightbox) closeLightbox(); });
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" && !lightbox.classList.contains("hidden")) closeLightbox();
  });
  // Any image in the conversation (reference thumbs, rendered frames) enlarges on click.
  chatEl.addEventListener("click", function (ev) {
    var t = ev.target;
    if (t && t.tagName === "IMG" && t.src) openLightbox(t.src);
  });

  // ---------- run / permission flow ----------
  function markResult(script, result) {
    for (var i = history.length - 1; i >= 0; i--) {
      if (history[i].script === script) { history[i].result = result; break; }
    }
  }

  function executeScript(code, meta) {
    setBusy(true);
    var ticker = addTicker("Running in After Effects…");
    execInAE(code, function (ok, result) {
      ticker.stop();
      if (ok) {
        var summary = (result || "").replace(/^undefined$/, "Done.");
        addStatus("✓ " + (summary || "Done."), "ok");
        markResult(code, "success: " + summary);
        setBusy(false);
      } else {
        addStatus("✗ AE error: " + result, "error");
        markResult(code, "failed: " + result);
        if (modeEl.value === "auto" && meta.retries < MAX_AUTO_RETRIES) {
          attemptFix(code, result, meta);
        } else {
          setBusy(false);
          showPermBar(
            "The script failed. Ask Claude to fix it?",
            "Fix it",
            function () { attemptFix(code, result, { task: meta.task, ctx: meta.ctx, refs: meta.refs, retries: 0 }); },
            function () { addStatus("Okay — leaving it as is."); }
          );
        }
      }
    });
  }

  function gateAndRun(script, meta) {
    if (modeEl.value === "auto") {
      executeScript(script, meta);
    } else {
      setBusy(false);
      showPermBar(
        "Run this script in After Effects?",
        "Run in AE",
        function () { executeScript(script, meta); },
        function () {
          addStatus("Script discarded.");
          markResult(script, "discarded by user");
        },
        function () { markResult(script, "superseded by a new message"); }
      );
    }
  }

  function attemptFix(badScript, aeError, meta) {
    var label = "Asking Claude to fix it";
    if (modeEl.value === "auto") label += " (attempt " + (meta.retries + 1) + "/" + MAX_AUTO_RETRIES + ")";
    askClaude(buildFixPrompt(meta.task, meta.ctx, meta.refs, badScript, aeError), label + "…", function (err, script, fixMeta) {
      if (err) return;
      if (fixMeta && fixMeta.usedTools) {
        // Claude applied the fix directly through the live AE connector.
        markResult(badScript, "fixed via live AE tools");
        setBusy(false);
        return;
      }
      if (!script) {
        addStatus("✗ Claude didn't return a corrected script.", "error");
        setBusy(false);
        return;
      }
      history.push({ task: meta.task + " (fix after error: " + aeError + ")", script: script, result: null });
      addScriptCard(script);
      gateAndRun(script, { task: meta.task, ctx: meta.ctx, refs: meta.refs, retries: meta.retries + 1 });
    });
  }

  /* Director pass: for short New briefs, a fast cheap model first turns the
   * one-liner into a concrete build spec (concept, palette, layout, timeline
   * beats, implementation strategy). The spec is then shown to the USER in a
   * modal — exactly what will be injected into the main model — with a notes
   * box; they approve it, skip the director, or cancel the send. Skipped when
   * the user already spelled the process out (long brief), for task types
   * with their own machinery, and on bundles without the director prompt.
   * Fails OPEN: any error/timeout runs the send without a spec.
   * cb({spec, notes}) — spec "" = proceed plain; cb(null) = send cancelled. */
  var dirModalCancel = null; // set while the approval modal is open (■ closes it)
  /* onRewrite(notes, doneRewrite(newSpec)) — optional: re-runs the director
   * with the user's change requests and shows the new spec for approval. */
  function showDirectorModal(spec, cb, onRewrite) {
    dirSpecEl.textContent = spec;
    dirNotesEl.value = "";
    dirNotesEl.placeholder = onRewrite
      ? "Notes (optional): Build = they override the spec · Rewrite = the director redoes the spec around them…"
      : "Add your points (optional) — they override the spec above, or ride along if you skip it…";
    if (dirRewriteBtn) { dirRewriteBtn.classList.toggle("hidden", !onRewrite); dirRewriteBtn.disabled = false; }
    dirBuildBtn.disabled = dirSkipBtn.disabled = false;
    dirModal.classList.remove("hidden");
    var closed = false;
    function close(result) {
      if (closed) return;
      closed = true;
      dirModal.classList.add("hidden");
      dirModalCancel = null;
      cb(result);
    }
    dirModalCancel = function () { close(null); };
    dirBuildBtn.onclick = function () {
      var n = dirNotesEl.value.trim();
      var s = spec;
      if (n) s += "\n\nDIRECTOR OVERRIDES FROM THE USER (these outrank everything above):\n" + n;
      addStatus("🎬 Build spec approved" + (n ? " with your notes" : "") + ".", "log");
      close({ spec: s, notes: "" });
    };
    dirSkipBtn.onclick = function () {
      var n = dirNotesEl.value.trim();
      addStatus("Director spec skipped — building from your brief" + (n ? " plus your notes" : "") + ".", "log");
      close({ spec: "", notes: n });
    };
    dirCancelBtn.onclick = function () {
      addStatus("Send cancelled — the director spec was discarded.", "log");
      close(null);
    };
    if (dirRewriteBtn) dirRewriteBtn.onclick = function () {
      var n = dirNotesEl.value.trim();
      if (!n) { dirNotesEl.placeholder = "Type what to change (e.g. \"3 beats: input → results → repeat\"), then Rewrite…"; dirNotesEl.focus(); return; }
      if (!onRewrite) return;
      dirRewriteBtn.disabled = dirBuildBtn.disabled = dirSkipBtn.disabled = true;
      dirSpecEl.textContent = spec + "\n\n⟳ Rewriting the spec with your notes…";
      onRewrite(n, function (newSpec) {
        if (closed) return;
        dirRewriteBtn.disabled = dirBuildBtn.disabled = dirSkipBtn.disabled = false;
        if (newSpec) { spec = newSpec; dirSpecEl.textContent = newSpec; dirNotesEl.value = ""; addStatus("🎬 Spec rewritten with your notes — review it again.", "log"); }
        else { dirSpecEl.textContent = spec; addStatus("✗ The director could not rewrite the spec — the previous one is shown again.", "error"); }
      });
    };
    dirNotesEl.focus();
  }

  function directorPass(task, ctx, refs, cb) {
    if (!BRAIN || !BRAIN.director) { cb({ spec: "", notes: "" }); return; }
    // New builds only: Edit/Stylize/Polish/Recreate have their own machinery,
    // and "Other" doubles as plain chat — a spec there would turn a simple
    // question into an unwanted build.
    if (taskMode !== "new") { cb({ spec: "", notes: "" }); return; }
    if (roomyRun()) { addStatus("🧭 " + (prettyModel(modelEl.value) || "Opus") + " plans this build itself (no Haiku director for Opus / Fable at medium effort or above).", "log"); cb({ spec: "", notes: "" }); return; }
    var imgRefs = []; // images AND documents — both readable by the director via Read
    (refs || []).forEach(function (r) { if (r.isImage || r.isDoc) imgRefs.push(r.path); });
    // A detailed brief means the user directed it themselves — unless references are attached:
    // then the pass always runs, because its REFERENCE READ is the design study the build needs.
    if (!imgRefs.length && task.length > 700) { addStatus("Director skipped — the brief is detailed (" + task.length + " chars) and has no reference, so it goes straight to the builder. Attach a reference or shorten the brief to get the spec modal.", "log"); cb({ spec: "", notes: "" }); return; }
    var dirModel = imgRefs.length ? "sonnet" : null; // reading design from images needs more than Haiku
    var vidCount = (refs || []).length - imgRefs.length;
    var ticker = addTicker(imgRefs.length
        ? "Directing — studying your reference(s), then concept, layout, beats…"
        : "Directing — concept, layout, beats…");
    var done = false;
    // Viewing reference images takes the director extra round-trips.
    var t = setTimeout(function () { addStatus("⚠ Director timed out (" + (imgRefs.length ? 300 : 120) + " s) — building without a spec. Log: " + path.join(WORK_DIR, "director.log"), "err"); finish(""); }, imgRefs.length ? 300000 : 120000);
    function finish(spec) {
      if (done) return;
      done = true;
      clearTimeout(t);
      ticker.stop();
      if (spec === null) { cb(null); return; }
      if (!spec) { cb({ spec: "", notes: "" }); return; }
      showDirectorModal(spec, cb, function (notes, doneRewrite) {
        var t2 = addTicker("Directing — rewriting the spec with your notes…");
        try {
          runQuickClaude(p + "\n\nYOUR PREVIOUS SPEC:\n" + spec + "\n\nTHE USER REVIEWED IT AND ASKS FOR THESE CHANGES (they are law):\n" + notes +
            "\n\nRewrite the WHOLE spec applying the changes — keep every decision the user did not mention, same sections, same limits. Output ONLY the new spec.",
            function (err, out) {
              t2.stop();
              if (err === "CANCELLED") { doneRewrite(""); if (dirModalCancel) dirModalCancel(); return; }
              if (err || !out) { doneRewrite(""); return; }
              spec = out.length > 4000 ? out.slice(0, 4000) : out;
              doneRewrite(spec);
            }, imgRefs.length ? "--allowedTools Read" : "", dirModel);
        } catch (e) { t2.stop(); doneRewrite(""); }
      });
    }
    var p = BRAIN.director + "\n\n";
    var sheetCount = (refs || []).filter(function (r) { return r.isSheet; }).length;
    if (sheetCount) p += "Some of the attached images are CONTACT SHEETS of a reference VIDEO (24 timestamped cells each, 6 columns, in time order — frame number + seconds burned into each cell). Read them as the video: what enters when, what moves, what holds, where the cuts are. The TIMELINE must follow that order.\n\n";
    if (imgRefs.length) {
      p += "The user attached " + imgRefs.length + " reference file(s) (images/documents). View or read EACH ONE with the Read tool BEFORE writing the spec — " + ("start the spec with the REFERENCE READ section (the design knowledge in these files: framing, assets, hierarchy, implied motion, finish, taste) and then design the brief in THAT grammar; the spec's palette, layout and mood must be grounded in what the references actually show or say:") + "\n";
      imgRefs.forEach(function (fp) { p += "- " + fp + "\n"; });
      p += "\n";
    }
    if (vidCount > 0) {
      p += "The user also attached " + vidCount + " video reference(s) that cannot be viewed here — say in the spec that the builder should treat them as footage/reference.\n\n";
    }
    if (ctx && ctx !== "NONE") p += "Active composition snapshot:\n" + ctx + "\n\n";
    if (styleSel.value) {
      p += "The user attached the \"" + styleSel.value + "\" style pack — the spec must fit that style.\n\n";
    } else {
      p += "NO style pack is attached. Do NOT name, reference or emulate any of the plugin's style packs anywhere in the spec — design from the brief" + (imgRefs.length ? " and the REFERENCE READ" : "") + " alone.\n\n";
    }
    p += "Brief: " + task;
    try {
      runQuickClaude(p, function (err, out) {
        if (err === "CANCELLED") { finish(null); return; }
        try { fs.writeFileSync(path.join(WORK_DIR, "director.log"), "MODEL " + (dirModel || "haiku") + "\nERR " + (err || "") + "\nOUT\n" + (out || ""), "utf8"); } catch (e2) { }
        if (err || !out) { addStatus("⚠ Director (" + (dirModel ? "Sonnet" : "Haiku") + ") failed — building without a spec. " + String(err || "empty reply").split("\n")[0].slice(0, 220), "err"); finish(""); return; }
        finish(out.length > 4000 ? out.slice(0, 4000) : out);
      }, (imgRefs.length ? "--allowedTools Read" : "") + (dirModel ? " --effort medium" : ""), dirModel);
    } catch (e) { addStatus("⚠ Director could not start: " + e.message, "err"); finish(""); }
  }


  /* Where did the image land? The requested path first, then any existing
   * image path in the reply, then the newest image written since the run began. */
  function locateFrame(outPath, text, dir, since) {
    try { if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) return outPath; } catch (e) { }
    var m, re = /(?:[A-Za-z]:[\\\/]|\/)[^\s"'`<>|]+?\.(?:png|jpe?g|webp)/gi;
    while ((m = re.exec(String(text || "")))) {
      try { if (fs.existsSync(m[0]) && fs.statSync(m[0]).size > 0) return m[0]; } catch (e) { }
    }
    var best = "", bt = since;
    try {
      fs.readdirSync(dir).forEach(function (f) {
        if (!/\.(png|jpe?g|webp)$/i.test(f)) return;
        var p = path.join(dir, f), st = fs.statSync(p);
        if (st.mtimeMs >= bt && st.size > 0) { bt = st.mtimeMs; best = p; }
      });
    } catch (e) { }
    return best;
  }

  function handleSend() {
    if (busy) return; // ■ click handled by sendBtn listener; Enter does nothing while busy
    var text = inputEl.value.trim();
    if (!text) return;

    clearPending();
    editsSincePrompt = 0; // Revert now targets only this prompt's edits

    var refs = attachments.slice();
    attachments = [];
    renderChips();

    addUserMsg(text, refs);
    inputEl.value = "";
    autoGrow();

    checkpointProject(); // snapshot the .aep before Claude touches anything
    syncAccount("claude"); // sessions made under another account can't be resumed — drop them, the run catches up
    syncAccount("codex");

    if (curEngine() === "claude" && updateAuthDot() === "out") {
      addStatus("⚠ Claude sign-in needed — open a terminal, run 'claude auth login', then try again.", "err");
      return;
    }
    if (curEngine() === "codex" && !codexUsable()) {
      addStatus(codexAdvice(cxCheck.why, "model"), "err");
      enforceCodexGate();
      return;
    }

    setBusy(true);
    ensureBrain(function (brainOk, why) {
      if (!brainOk) {
        setBusy(false);
        addStatus("⚠ " + why, "err");
        return;
      }
      proceed();
    });

    function proceed() {
      if (curEngine() === "codex") {
        checkCodex(function (ok, why) {
          if (!ok) { setBusy(false); addStatus(codexAdvice(why, "model"), "err"); return; }
          proceed2();
        });
      } else proceed2();
    }
    function proceed2() {
      gateGen(function () {
      prepVideoRefs(refs, function () {
      getCompContext(function (ctx) {
      directorPass(text, ctx, refs, function (d) {
        if (d === null) { setBusy(false); return; } // cancelled (■ or the modal's Cancel)
        var taskText = text;
        if (d.notes) taskText += "\n\nAdditional notes from the user (treat as part of the brief): " + d.notes;
        var promptText = buildPrompt(taskText, ctx, refs, styleSel.value || "", d.spec);
        resetStyleSel(); // one-shot: the style pack ships with this send only
        runRefs = refs;
        launchBuild(promptText, "Starting " + engineName() + "…", taskText, ctx, refs);
      });
      });
      });
      });
    }
    function launchBuild(promptText, label, taskText, ctx, refs) {
        askClaude(promptText, label, function (err, script, meta) {
          if (err) return;
          if (meta && meta.usedTools) {
            // Work already happened live through the AE connector.
            var outcome = (meta.finalText || "").replace(/\s+/g, " ").trim();
            if (outcome.length > 300) outcome = outcome.substring(0, 300) + "…";
            history.push({ task: taskText, script: null, result: outcome || "done via live AE tools" });
            setBusy(false);
            return;
          }
          if (!script) { setBusy(false); return; } // conversational answer, already shown
          history.push({ task: taskText, script: script, result: null });
          addScriptCard(script);
          gateAndRun(script, { task: taskText, ctx: ctx, refs: refs, retries: 0 });
        });
    }
  }

  // ---------- input behaviour ----------
  var manualInputH = 0; // set while the user has drag-sized the textarea

  function autoGrow() {
    if (manualInputH) return; // user-chosen height wins until reset
    if (composerEl.classList.contains("expanded")) {
      inputEl.style.height = ""; // let the .expanded CSS height rule take over
      return;
    }
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 110) + "px";
  }
  inputEl.addEventListener("input", autoGrow);

  expandBtn.addEventListener("click", function () {
    manualInputH = 0;
    inputEl.style.maxHeight = "";
    var on = composerEl.classList.toggle("expanded");
    expandBtn.innerHTML = mpIcon(on ? "compact" : "expand");
    expandBtn.title = on ? "Compress typing area" : "Enlarge typing area";
    autoGrow();
    inputEl.focus();
  });

  // Drag the composer's top edge to resize the typing area freely.
  var dragHandle = document.getElementById("dragHandle");
  dragHandle.addEventListener("mousedown", function (ev) {
    ev.preventDefault();
    var startY = ev.clientY;
    var startH = inputEl.offsetHeight;
    if (composerEl.classList.contains("expanded")) {
      composerEl.classList.remove("expanded");
      expandBtn.innerHTML = mpIcon("expand");
      expandBtn.title = "Enlarge typing area";
    }
    function move(e) {
      var h = Math.max(38, Math.min(startH + (startY - e.clientY), Math.round(window.innerHeight * 0.7)));
      manualInputH = h;
      inputEl.style.height = h + "px";
      inputEl.style.maxHeight = h + "px";
    }
    function up() {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    }
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
  dragHandle.addEventListener("dblclick", function () { // back to auto-size
    manualInputH = 0;
    inputEl.style.maxHeight = "";
    autoGrow();
  });

  inputEl.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      handleSend();
    }
  });

  sendBtn.addEventListener("click", function () {
    if (busy) { stopCurrent(); return; }
    handleSend();
  });

  doneBtn.addEventListener("click", function () {
    if (!busy || doneSignal) return;
    doneSignal = true;
    doneBtn.disabled = true;
    addStatus("✋ Told the model the result is good enough — it will finish the current step and wrap up.", "log");
  });

  newChatBtn.addEventListener("click", function () {
    if (busy) stopCurrent();
    hidePermBar();
    closeHistory();
    saveSession(); // archive the old chat before clearing
    session = newSessionObj();
    history = [];
    tokensUsed = { input: 0, output: 0 };
    updateTokenInfo();
    attachments = [];
    renderChips();
    chatEl.innerHTML = "";
    tickerStack = [];
    emptyEl = null;
    showEmpty();
    inputEl.focus();
  });
  chatEl.addEventListener("click", function (ev) {
    var b = ev.target;
    while (b && b !== chatEl && !(b.classList && b.classList.contains("sugg"))) b = b.parentNode;
    if (!b || b === chatEl) return;
    var md = b.getAttribute("data-mode");
    if (md) { taskMode = md; localStorage.setItem("claude-ae-taskmode", taskMode); syncTaskModes(); }
    inputEl.value = b.getAttribute("data-prompt") || "";
    autoGrow();
    inputEl.focus();
  });

  // ---------- Claude sign-in indicator ----------
  // Token-free: reads the CLI's local credential file instead of pinging the
  // API, so checking costs nothing and can run on every launch and send.
  var authDot = document.getElementById("authDot");
  // macOS: the CLI keeps credentials in the Keychain, so the check is an
  // async `security` lookup — cached, refreshed at most every 30s. The sync
  // gate reads the cache; "unknown" never blocks a send.
  var macAuthState = "unknown";
  var macAuthKick = 0;
  // A run that failed with an auth error is ground truth the file/keychain
  // check can't see (server-side logout leaves stale local credentials). The
  // override sticks until the credentials file changes (re-login rewrites
  // it), a run succeeds, or the user clicks the dot after signing back in.
  var authKnownOut = false;
  var authLostCredStamp = "";
  function credStamp() {
    try {
      var st = fs.statSync(path.join(claudeDir(), ".credentials.json"));
      return String(st.mtimeMs) + ":" + String(st.size);
    } catch (e) { return "missing"; }
  }
  function noteAuthLoss() {
    authKnownOut = true;
    authLostCredStamp = credStamp();
    if (IS_MAC) macAuthState = "out";
    updateAuthDot();
  }
  function clearAuthLoss() {
    if (!authKnownOut) return;
    authKnownOut = false;
    if (IS_MAC) macAuthKick = 0; // let the keychain check run again
    updateAuthDot();
  }
  function refreshMacAuth() {
    try {
      // existence check only (no -w): reading metadata never triggers a
      // keychain permission prompt, unlike reading the secret itself.
      cp.exec('/usr/bin/security find-generic-password -s "Claude Code-credentials" >/dev/null 2>&1 || /usr/bin/security find-generic-password -s "Claude Code" >/dev/null 2>&1',
        { timeout: 8000 },
        function (err) {
          if (!err) macAuthState = "in";
          else {
            try {
              macAuthState = fs.existsSync(path.join(claudeDir(), ".credentials.json")) ? "in"
                : (fs.existsSync(claudeDir()) ? "out" : "unknown");
            } catch (e2) { macAuthState = "unknown"; }
          }
          updateAuthDot();
        });
    } catch (e) { }
  }
  function checkClaudeAuth() {
    if (authKnownOut) {
      // Credentials changed since the failure -> they re-logged in.
      if (credStamp() !== authLostCredStamp) authKnownOut = false;
      else return "out";
    }
    try { if (process.env.ANTHROPIC_API_KEY) return "in"; } catch (e) { }
    if (IS_MAC && selectedAccount("claude")) {
      // A non-default account's Keychain item has its own name; its profile email is the test.
      return describeAccount("claude").indexOf("@") >= 0 ? "in" : "unknown";
    }
    if (IS_MAC) {
      if (Date.now() - macAuthKick > 30000) { macAuthKick = Date.now(); setTimeout(refreshMacAuth, 0); }
      return macAuthState;
    }
    try {
      var credFile = path.join(claudeDir(), ".credentials.json");
      if (!fs.existsSync(credFile)) {
        // CLI folder present but no credentials -> definitely signed out.
        return fs.existsSync(claudeDir()) ? "out" : "unknown";
      }
      var o = JSON.parse(fs.readFileSync(credFile, "utf8"));
      var oa = o && (o.claudeAiOauth || o.oauth);
      if (oa && oa.accessToken) {
        // An expired access token with no refresh token means a fresh login
        // is needed; with one, the CLI renews silently — still signed in.
        if (oa.expiresAt && Date.now() > oa.expiresAt && !oa.refreshToken) return "out";
        return "in";
      }
      // No OAuth block: only a stored API key still counts as signed in.
      // (A leftover non-empty file after /logout must not count as signed in.)
      return (o && o.apiKey) ? "in" : "out";
    } catch (e2) { return "unknown"; }
  }
  function updateAuthDot() {
    var s = checkClaudeAuth();
    if (authDot) {
      authDot.className = "eng auth-" + s;
      authDot.title = s === "in" ? "Claude Code: signed in"
        : s === "out" ? "Claude sign-in needed — open a terminal, run 'claude' to log back in, then click this dot"
          : "Claude sign-in status unknown — click to re-check";
    }
    return s;
  }
  updateAuthDot();
  // The dot must not go stale mid-session: re-check every minute (cheap — a
  // local stat/read), and let a click force a fresh check after re-login.
  setInterval(updateAuthDot, 60000);
  if (authDot) authDot.addEventListener("click", function () {
    authKnownOut = false;
    if (IS_MAC) { macAuthKick = 0; macAuthState = "unknown"; }
    var s = updateAuthDot();
    addStatus(s === "in" ? "Claude sign-in looks good."
      : s === "out" ? "Still signed out — open a terminal, run 'claude' and complete the sign-in, then click the dot again."
        : "Sign-in status unknown — it will confirm itself on the next run.");
  });

  // ---------- startup health check ----------
  // Catch every "works on my machine" failure at panel load with a fix-it
  // banner, instead of a cryptic error on the first send.
  var healthBar = document.getElementById("healthBar");
  var healthText = document.getElementById("healthText");
  document.getElementById("healthClose").addEventListener("click", function () {
    healthBar.classList.add("hidden");
  });

  (function healthCheck() {
    var problems = [];
    var pending = 3;
    function finish() {
      if (--pending > 0) return;
      if (!problems.length) return; // healthy = silent
      healthText.textContent = problems.join("  •  ");
      healthBar.classList.remove("hidden");
    }

    // 1. Claude Code CLI — probed through the same shell (and PATH) real runs use.
    try {
      var onProbe = function (err, stdout) {
        if (err || !String(stdout || "").trim()) {
          problems.push("Claude Code CLI not found. Install it (npm install -g @anthropic-ai/claude-code), run 'claude' once in a terminal to log in, then restart After Effects.");
        } else {
          var cvm = /\d+\.\d+\.\d+/.exec(String(stdout));
          CLAUDE_VER = cvm ? cvm[0] : "";
        }
        finish();
      };
      if (IS_MAC) {
        cp.execFile(MAC_SHELL, ["-l", "-c", MAC_PATHS + "claude --version"], { timeout: 20000 }, onProbe);
      } else {
        cp.exec('powershell.exe -NoProfile -Command "claude --version"',
          { windowsHide: true, timeout: 20000 }, onProbe);
      }
    } catch (e) {
      problems.push("Could not probe the Claude CLI: " + e.message);
      finish();
    }

    // 1a. Claude sign-in: no login = no runs at all, so it belongs in the banner.
    try { if (updateAuthDot() === "out") problems.push("Claude is not signed in. Open a terminal, run 'claude auth login', then click the Claude dot."); } catch (e) { }
    // 1c. Higgsfield: probe once so the ✦ pill shows disabled when the CLI is missing/signed out.
    try { checkHiggsfield(function () { }); } catch (e) { }
    // 1b. Codex CLI (GPT engine) — optional: missing is a dot, not a banner.
    try {
      var onCodex = function (err, stdout) {
        if (!err && String(stdout || "").trim()) CODEX_VER = String(stdout).split(/\r?\n/)[0].trim();
        checkCodex(function () { finish(); });
      };
      if (IS_MAC) cp.execFile(MAC_SHELL, ["-l", "-c", MAC_PATHS + "codex --version"], { timeout: 20000 }, onCodex);
      else cp.exec("codex --version", { windowsHide: true, timeout: 20000 }, onCodex);
    } catch (e) { finish(); }

    // 2. AE-side helpers — loads jsx/bridge.jsx + aekit.jsx and verifies the
    // functions this panel version needs actually exist inside AE.
    ensureJsx(function (ok, jerr) {
      if (!ok) {
        problems.push(jerr || "The AE-side helpers failed to load — restart After Effects.");
        finish();
        return;
      }
      csInterface.evalScript('($._motionPilot && $._motionPilot.projInfo && $._motionPilot.renderRefFrames && $._motionPilot.importRefVideo) ? "OK" : "OLD"', function (res) {
        if (res !== "OK") {
          problems.push("After Effects is holding an outdated bridge — fully close and restart After Effects.");
        }
        finish();
      });
    });
  })();

  // Warm the brains from the local file next to the panel.
  (function brainWarmup() {
    fetchBrain(function (ok, why) {
      if (!ok) {
        healthText.textContent = "The panel couldn't load its local brain file (brain\\bundle.json). " + (why || "");
        healthBar.classList.remove("hidden");
        return;
      }
      syncTaskModes(); // brains may carry fresher input hints
    });
  })();

  autoGrow();
  inputEl.focus();
})();
