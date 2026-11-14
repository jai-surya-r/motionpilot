#!/usr/bin/env node
/* Stdio MCP server for the MotionPilot panel.
 *
 * The panel (CEP, Node-enabled) hosts a localhost HTTP endpoint that can run
 * ExtendScript inside After Effects. This process is started by Claude Code
 * or the Codex CLI and forwards tools/call requests to that endpoint, so the
 * model can inspect the comp, run scripts, and render preview frames while
 * it works.
 *
 * Dependency-free: newline-delimited JSON-RPC 2.0 over stdio.
 */
"use strict";

var http = require("http");

var PORT = parseInt(process.env.AE_BRIDGE_PORT || "", 10);
var TOKEN = process.env.AE_BRIDGE_TOKEN || "";
// The panel can drive this server from Claude Code (images are viewed with
// the Read tool) or from the Codex CLI (view_image). Tool descriptions name
// whichever viewer the current engine has.
var VIEW_TOOL = process.env.AE_VIEW_TOOL || "Read";

var TOOLS = [
  {
    name: "get_state",
    description:
      "Read the LIVE state of the active After Effects composition. Default detail 'summary': comp settings + " +
      "one line per layer (type, in/out, text) with keyframe times per animated property, plus the project-Bin " +
      "asset list (place assets with AE.fromBin — no file reading needed). detail 'full' adds " +
      "transform values, effects and expression bodies. Pass layer_index for a deep keyframe/easing dump of one layer. " +
      "run_script already returns a comp digest — only call this when you need more than the digest shows.",
    inputSchema: {
      type: "object",
      properties: {
        layer_index: {
          type: "integer",
          description: "Optional 1-based layer index for a deep dump of that layer's keyframes, easing and expressions."
        },
        detail: {
          type: "string",
          enum: ["summary", "full"],
          description: "summary (default) = names + keyframe times only; full = transforms, effects, expressions too."
        }
      },
      additionalProperties: false
    }
  },
  {
    name: "run_script",
    description:
      "Execute ExtendScript (ES3 JSX) inside After Effects. Returns the script's last expression PLUS a one-line " +
      "comp digest (layer list) so you usually don't need get_state afterwards. The AE.* helper library from your " +
      "prompt is preloaded — always prefer it over raw property scaffolding. The host wraps the call in a try/catch " +
      "and an undo group; end every script with a short status string. On error, fix and call again. " +
      "Prefer several small focused scripts over one giant one.",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "The ExtendScript source to run." },
        description: {
          type: "string",
          description: "One short sentence describing what this script does (shown to the user)."
        }
      },
      required: ["script"],
      additionalProperties: false
    }
  },
  {
    name: "render_frame",
    description:
      "Render the active composition and return PNG path(s) — then view with the " + VIEW_TOOL + " tool; this is how you SEE your work. " +
      "One moment: {time} → one full-size frame. Several moments: ONE call with {times:[…]} → ONE proof sheet " +
      "(all frames tiled, each labelled with its time) plus the path of every full-size frame; view the sheet, and open a " +
      "full-size frame only when something needs a close look. Re-render after fixes; skip frames that show nothing new.",
    inputSchema: {
      type: "object",
      properties: {
        time: { type: "number", description: "One composition time in seconds (full-size frame). Defaults to the current playhead." },
        times: { type: "array", items: { type: "number" }, maxItems: 12, description: "Several times in seconds (2-12) → one proof sheet + the full-size frame paths." }
      },
      additionalProperties: false
    }
  },
  {
    name: "ae_info",
    description:
      "What THIS After Effects can do: version, the active comp's renderer and the available renderers, which 3D " +
      "features exist (Advanced 3D, imported 3D models, environment lights, parametric meshes, camera focus area, " +
      "layer materials) and which newer scripting APIs are present. Call it once before any 3D work or before " +
      "relying on a recent feature. Pass effects to search the installed effects (third-party plug-ins included) " +
      "and get their exact matchNames for AE.fx(layer, matchName).",
    inputSchema: {
      type: "object",
      properties: {
        effects: { type: "string", description: "Optional text to search installed effects by name, matchName or category, e.g. 'blur', 'depth', 'Contour'. Use '*' to list all." }
      },
      additionalProperties: false
    }
  },
  {
    name: "inspect_properties",
    description:
      "Live property tree of one layer: matchName | name | current value, dropdown items, keyframe count, " +
      "expressions. Use it to discover and then set ANY property — 3D Geometry / Material Options, light and " +
      "camera options, effect controls, text animators, and properties added in After Effects versions newer " +
      "than these instructions (e.g. 27.0 layer/Substance materials). Set what you find with " +
      "AE.setProp(layer, [matchName, name], value) in run_script.",
    inputSchema: {
      type: "object",
      properties: {
        layer_index: { type: "number", description: "1-based layer index in the active comp." },
        layer_name: { type: "string", description: "Exact layer name (instead of layer_index)." },
        path: { type: "string", description: "Optional sub-path of group names or matchNames separated by '>', e.g. 'Material Options' or 'ADBE Effect Parade>Gaussian Blur'." },
        depth: { type: "number", description: "How many group levels to expand (default 3, max 6)." }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_skill",
    description:
      "Fetch a reference pack on demand: 'moves', 'flow', 'animation-principles', 'effects', '3d', 'editable-rig', " +
      "'html-to-scene', 'recreate-evidence', or the style pack named in an '## Editing style' block. Long packs " +
      "return an index of sections first — call again with section (a heading from the index, or 'all').",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          enum: ["effects", "animation-principles", "3d", "moves", "ui-motion", "kinetic-type", "cutout-collage",
            "flat-scene", "data-editorial", "grain-print", "soft-glow", "depth-blur", "hard-sticker", "grain-gradient",
            "html-to-scene", "recreate-evidence", "editable-rig", "flow"],
          description: "Which skill pack to fetch."
        },
        section: { type: "string", description: "Optional: one section heading from the pack's index (e.g. 'ENTER', '4 SEAMS'), or 'all'." }
      },
      required: ["name"],
      additionalProperties: false
    }
  },
  {
    name: "generate_image",
    description:
      "Generate ONE image with GPT Image 2 (via the Codex CLI on this machine) and get back its PNG path. " +
      "Use it for any asset the design needs that can't be built from shapes/text: illustrations, characters, " +
      "textures, backgrounds, icon sets, product shots. Write a COMPLETE prompt: subject, style, palette hexes, " +
      "lighting, composition, exact text to render (if any). Subject-only assets (logo, character, prop that sits " +
      "over the design) must be requested 'on a solid uniform pure [key color] background, evenly lit, hard clean " +
      "edges, no shadows, no reflections, no spill' (green #00FF00 default; magenta #FF00FF if the subject has green; " +
      "blue #0000FF if both) and keyed out after import with AE.keyOut. One call per asset; no unprompted variants. " +
      "Import the result with AE.importAsset(path,{place:true,fit}). If the tool reports Codex unavailable, build a " +
      "clean placeholder from shapes/solids/text instead and tell the user.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Full generation prompt (subject, style, palette, key-colour background rule if subject-only, exact text)." },
        name: { type: "string", description: "Short file-safe name for the asset, e.g. 'hero-rocket' or 'paper-texture'." },
        aspect: { type: "string", enum: ["square", "landscape", "portrait"], description: "Overall shape of the image (1K class: 1024x1024 / 1536x1024 / 1024x1536). Default square." },
        quality: { type: "string", enum: ["low", "medium", "high"], description: "Image quality tier. low = quick draft (simple flat designs), medium = default for finished assets, high = detailed illustrations." },
        refs: { type: "array", items: { type: "string" }, description: "Optional absolute paths of reference images (palette/style guides) to attach." }
      },
      required: ["prompt", "name"],
      additionalProperties: false
    }
  },
  {
    name: "approve",
    description:
      "Internal permission gate used by the host panel (--permission-prompt-tool). Never call this tool yourself.",
    inputSchema: {
      type: "object",
      properties: {
        tool_name: { type: "string" },
        input: { type: "object" },
        tool_use_id: { type: "string" }
      },
      additionalProperties: true
    }
  }
];

if (!PORT) {
  process.stderr.write("ae-mcp: AE_BRIDGE_PORT is not set; is the MotionPilot panel open in After Effects?\n");
}

var buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", function (chunk) {
  buf += chunk;
  var i;
  while ((i = buf.indexOf("\n")) !== -1) {
    var line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) handle(line);
  }
});
process.stdin.on("end", function () { process.exit(0); });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function handle(line) {
  var msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  var id = msg.id, method = msg.method, params = msg.params || {};

  if (method === "initialize") {
    send({
      jsonrpc: "2.0", id: id,
      result: {
        protocolVersion: params.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "motionpilot", version: "1.1.0" }
      }
    });
  } else if (method === "ping") {
    send({ jsonrpc: "2.0", id: id, result: {} });
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id: id, result: { tools: TOOLS } });
  } else if (method === "tools/call") {
    callPanel(params.name, params.arguments || {}, function (err, text, isError) {
      var body = err
        ? { content: [{ type: "text", text: "AE bridge error: " + err }], isError: true }
        : { content: [{ type: "text", text: text }], isError: !!isError };
      send({ jsonrpc: "2.0", id: id, result: body });
    });
  } else if (id !== undefined && id !== null && String(method).indexOf("notifications/") !== 0) {
    send({ jsonrpc: "2.0", id: id, error: { code: -32601, message: "Method not found: " + method } });
  }
  // notifications (initialized, cancelled, ...) need no reply
}

function callPanel(name, args, cb) {
  if (!PORT) { cb("the MotionPilot panel did not pass its bridge port (AE_BRIDGE_PORT); reopen the panel in After Effects."); return; }
  var body = JSON.stringify({ name: name, args: args });
  var reqOpts = {
    host: "127.0.0.1",
    port: PORT,
    path: "/call",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      "X-MotionPilot-Token": TOKEN
    }
  };
  var rq = http.request(reqOpts, function (res) {
    var data = "";
    res.setEncoding("utf8");
    res.on("data", function (d) { data += d; });
    res.on("end", function () {
      try {
        var r = JSON.parse(data);
        cb(null, String(r.text || ""), !r.ok);
      } catch (e) {
        cb("bad response from the panel: " + e.message);
      }
    });
  });
  // No client-side timeout: Ask mode can legitimately wait minutes for the
  // user to approve a script. The CLI's MCP_TOOL_TIMEOUT governs the ceiling.
  rq.on("error", function (e) {
    cb("cannot reach the After Effects panel (" + e.message + "). Is the MotionPilot panel open in After Effects?");
  });
  rq.end(body);
}
