/* Host-side helpers for the MotionPilot bridge.
 *
 * Loaded once by the panel via evalScript. Everything lives under
 * $._motionPilot so reloading is idempotent. All functions return strings:
 * plain text reports, or "OK::…" / "ERR::…" for actions.
 */
$._motionPilot = (function () {

  function num(v) { return Math.round(v * 1000) / 1000; }


  function fmt(v) {
    if (v instanceof Array) {
      var o = [];
      for (var i = 0; i < v.length; i++) o.push(fmt(v[i]));
      return "[" + o.join(",") + "]";
    }
    if (typeof v === "number") return "" + num(v);
    var s = String(v).replace(/\s+/g, " ");
    if (s.length > 80) s = s.substring(0, 80) + "…";
    return '"' + s + '"';
  }

  function layerType(L) {
    try {
      if (L instanceof TextLayer) return "text";
      if (L instanceof ShapeLayer) return "shape";
      if (L instanceof CameraLayer) return "camera";
      if (L instanceof LightLayer) return "light" + lightKind(L);
      if (typeof ParametricMeshLayer !== "undefined" && L instanceof ParametricMeshLayer) return "mesh" + meshKind(L);
      if (typeof ThreeDModelLayer !== "undefined" && L instanceof ThreeDModelLayer) return "3d model";
      if (L.nullLayer) return "null";
      if (L.adjustmentLayer) return "adjustment";
      if (L.source instanceof CompItem) return "precomp";
      if (L.source && L.source.mainSource instanceof SolidSource) return "solid";
      return "footage";
    } catch (e) { return "layer"; }
  }

  function lightKind(L) {
    try {
      var t = L.lightType;
      if (t === LightType.PARALLEL) return ":parallel";
      if (t === LightType.SPOT) return ":spot";
      if (t === LightType.POINT) return ":point";
      if (t === LightType.AMBIENT) return ":ambient";
      if (typeof LightType.ENVIRONMENT !== "undefined" && t === LightType.ENVIRONMENT) return ":environment";
    } catch (e) { }
    return "";
  }
  function meshKind(L) {
    try {
      var t = L.parametricMeshType, names = ["SPHERE", "PLANE", "CYLINDER", "CONE", "TORUS", "CUBE"];
      for (var i = 0; i < names.length; i++) if (t === ParametricMeshType[names[i]]) return ":" + names[i].toLowerCase();
    } catch (e) { }
    return "";
  }

  // ---------- capabilities (what THIS After Effects can do from script) ----------
  function aeVer() { var v = parseFloat(app.version); return isNaN(v) ? 0 : v; }
  function caps() {
    var v = aeVer(), out = [];
    out.push("After Effects " + app.version + (app.buildNumber ? " (build " + app.buildNumber + ")" : "") + " · scripting version " + v);
    var c = app.project.activeItem;
    if (c && c instanceof CompItem) {
      try { out.push('Active comp renderer: "' + c.renderer + '" · available: ' + c.renderers.join(", ")); } catch (e) { }
    }
    function f(ok, label, how) { out.push((ok ? "  [yes] " : "  [no]  ") + label + (ok ? (how ? " — " + how : "") : "")); }
    out.push("3D features:");
    f(true, "3D layers, cameras, point/spot/parallel/ambient lights, extruded text & shapes (Advanced 3D / Cinema 4D renderer)", "AE.make3D, AE.camera3D, AE.light3D, AE.renderer3D");
    f(typeof ThreeDModelLayer !== "undefined", "Imported 3D models (glTF/GLB/OBJ) as ThreeDModelLayer (24.4+)", "AE.model3D(path,{...})");
    f(typeof LightType !== "undefined" && typeof LightType.ENVIRONMENT !== "undefined", "Environment (image-based) lights (24.3+)" + (v >= 25.2 ? "; any 2D layer/precomp as light source (25.2+)" : "; HDR/EXR footage as source"), "AE.envLight(sourceLayer,{...})");
    f(typeof ParametricMeshType !== "undefined", "Parametric meshes: cube, sphere, cylinder, cone, torus, plane with bevels (26.3+)", "AE.mesh(type,{...})");
    f(v >= 26.3, "Advanced 3D camera focus area + near/far blur multiplier (26.3+)", "AE.camera3D({focusArea, nearFarBlur})");
    f(v >= 27, "Layers / Substance (.sbsar) as materials on 3D objects (27.0+) — no documented scripting API yet", "discover with inspect_properties / AE.props(layer), set with AE.setProp");
    out.push("Other recent APIs:");
    f(v >= 26.0, "Variable-font axes on text animators, dropdown item text (Property.propertyParameters / valueText) (26.0+)", "");
    f(v >= 26.5, "Layer-parameter render stage (Property.setLayerInputStage / setInputLayerAndStage) and GuideOptions guides (26.5+)", "");
    f(v >= 24.3, "Per-character / paragraph text styling (TextDocument.characterRange) (24.3+)", "");
    f(v >= 24.6, "Paragraph box auto-fit, vertical alignment, overflow (TextDocument.box*) (24.6+)", "");
    out.push("Anything newer than this list: call inspect_properties on a layer to see its live property tree (matchNames, values, dropdown items) and set what you find with AE.setProp.");
    return out.join("\n");
  }

  /* Installed effects (app.effects), optionally filtered by a case-insensitive text match
   * on display name, matchName or category. */
  function effectsList(query, max) {
    var list = [], n = 0, q = String(query || "").toLowerCase();
    max = max || 120;
    try {
      var all = app.effects;
      for (var i = 0; i < all.length; i++) {
        var fx = all[i], hay = (fx.displayName + " " + fx.matchName + " " + fx.category).toLowerCase();
        if (q && hay.indexOf(q) < 0) continue;
        n++;
        if (list.length < max) list.push('"' + fx.matchName + '" ' + fx.displayName + (fx.category ? " [" + fx.category + "]" : ""));
      }
    } catch (e) { return "Could not read the installed effects list: " + e.toString(); }
    if (!n) return q ? 'No installed effect matches "' + query + '".' : "No effects reported.";
    return n + " installed effect(s)" + (q ? ' matching "' + query + '"' : "") + " (matchName, then display name):\n" + list.join("\n") +
      (n > list.length ? "\n…+" + (n - list.length) + " more — narrow the query" : "");
  }

  /* Live property tree of one layer, from an optional sub-path ("Material Options" or
   * "ADBE Root Vectors Group>Group 1"), so the model can discover and set ANY property,
   * including ones added in After Effects versions newer than this panel. */
  function propChild(g, key) {
    var k = String(key).toLowerCase();
    try { var p = g.property(key); if (p) return p; } catch (e) { }
    for (var i = 1; i <= g.numProperties; i++) {
      var c = g.property(i);
      if (String(c.matchName).toLowerCase() === k || String(c.name).toLowerCase() === k) return c;
    }
    return null;
  }
  function inspect(layerIndex, layerName, subPath, depth) {
    var c = app.project.activeItem;
    if (!(c && c instanceof CompItem)) return "NO ACTIVE COMP.";
    var L = null;
    if (layerIndex >= 1 && layerIndex <= c.numLayers) L = c.layer(layerIndex);
    if (!L && layerName) { for (var i = 1; i <= c.numLayers; i++) if (c.layer(i).name === layerName) { L = c.layer(i); break; } }
    if (!L) return "No such layer (give layer_index 1-" + c.numLayers + " or an exact layer_name).";
    var root = L, label = L.name;
    if (subPath) {
      var parts = String(subPath).split(">");
      for (var p = 0; p < parts.length; p++) {
        var next = propChild(root, parts[p].replace(/^\s+|\s+$/g, ""));
        if (!next) return 'No property "' + parts[p] + '" under "' + label + '". Inspect the parent without a path to see what exists.';
        root = next; label += " > " + next.name;
      }
    }
    depth = depth || 3;
    var out = ['Properties of layer ' + L.index + ' "' + label + '" [' + layerType(L) + (L.threeDLayer ? ", 3D" : "") + '] — matchName | name | value / info:'], max = 450;
    function walk(g, lvl, ind) {
      for (var i = 1; i <= g.numProperties && out.length < max; i++) {
        var pr; try { pr = g.property(i); } catch (e) { continue; }
        var line = ind + pr.matchName + " | " + pr.name;
        if (pr.propertyType === PropertyType.PROPERTY) {
          try { if (pr.propertyValueType !== PropertyValueType.NO_VALUE && pr.propertyValueType !== PropertyValueType.CUSTOM_VALUE) line += " = " + fmt(pr.value); } catch (e1) { }
          try { if (pr.isDropdownEffect) { var it = pr.propertyParameters; if (it) line += "  menu{" + it.join("|") + "}"; } } catch (e2) { }
          try { if (pr.numKeys) line += "  keys=" + pr.numKeys; } catch (e3) { }
          try { if (pr.expressionEnabled) line += "  (expr)"; } catch (e4) { }
          try { if (!pr.canVaryOverTime) line += "  static"; } catch (e5) { }
          out.push(line);
        } else {
          var n = 0; try { n = pr.numProperties; } catch (e6) { }
          out.push(line + "  {" + n + "}");
          if (lvl < depth && n) walk(pr, lvl + 1, ind + "  ");
        }
      }
    }
    try {
      if (root.propertyType === PropertyType.PROPERTY) out.push("  " + root.matchName + " | " + root.name + " = " + fmt(root.value));
      else walk(root, 1, "  ");
    } catch (e) { out.push("  (could not read: " + e.toString() + ")"); }
    if (out.length >= max) out.push("…truncated — pass a sub-path to look deeper into one group.");
    return out.join("\n");
  }

  function interpName(t) {
    if (t === KeyframeInterpolationType.LINEAR) return "lin";
    if (t === KeyframeInterpolationType.BEZIER) return "bez";
    return "hold";
  }

  /* Recursively report animated / expression-driven properties.
   * mode "count" → one line per property ("Position: 3 keys").
   * mode "times" → property name + keyframe times only (summary state).
   * mode "deep"  → per-key time, value, interpolation and out-ease influence. */
  function walkProps(prop, pathName, out, mode) {
    var deep = (mode === true || mode === "deep");
    if (prop.propertyType === PropertyType.PROPERTY) {
      var hasExpr = false;
      try { hasExpr = prop.canSetExpression && prop.expressionEnabled; } catch (e) { }
      if (prop.numKeys < 1 && !hasExpr) return;

      var line = "  " + pathName + ":";
      if (hasExpr) {
        if (mode === "times") {
          line += " (expr)";
        } else {
          var ex = String(prop.expression).replace(/\s+/g, " ");
          if (ex.length > 140) ex = ex.substring(0, 140) + "…";
          line += ' expression="' + ex + '"';
        }
      }
      if (prop.numKeys > 0) {
        if (mode === "times") {
          var tn = prop.numKeys > 12 ? 12 : prop.numKeys;
          var ts = [];
          for (var q = 1; q <= tn; q++) ts.push(num(prop.keyTime(q)));
          line += " keys@" + ts.join(",");
          if (prop.numKeys > tn) line += ",…+" + (prop.numKeys - tn);
        } else if (!deep) {
          line += " " + prop.numKeys + " keys";
        } else {
          var n = prop.numKeys > 24 ? 24 : prop.numKeys;
          var ks = [];
          for (var k = 1; k <= n; k++) {
            var piece = "t" + prop.keyTime(k).toFixed(2);
            try { piece += "=" + fmt(prop.keyValue(k)); } catch (e1) { piece += "=?"; }
            try {
              var ii = prop.keyInInterpolationType(k);
              var oi = prop.keyOutInterpolationType(k);
              var ease = interpName(ii) + "/" + interpName(oi);
              if (oi === KeyframeInterpolationType.BEZIER) {
                var oe = prop.keyOutTemporalEase(k);
                ease += " inf" + Math.round(oe[0].influence);
              }
              piece += "(" + ease + ")";
            } catch (e2) { }
            ks.push(piece);
          }
          line += " " + ks.join(" ");
          if (prop.numKeys > n) line += " …+" + (prop.numKeys - n) + " more";
        }
      }
      out.push(line);
    } else {
      for (var i = 1; i <= prop.numProperties; i++) {
        var child;
        try { child = prop.property(i); } catch (e3) { continue; }
        if (!child) continue;
        var nm = pathName ? pathName + " > " + child.name : child.name;
        try { walkProps(child, nm, out, mode); } catch (e4) { }
      }
    }
  }

  function transformSummary(L) {
    var t = [];
    try { t.push("pos=" + fmt(L.transform.position.value)); } catch (e) { }
    try { t.push("anchor=" + fmt(L.transform.anchorPoint.value)); } catch (e) { }
    try { t.push("scale=" + fmt(L.transform.scale.value)); } catch (e) { }
    try {
      var r = L.threeDLayer ? L.transform.zRotation.value : L.transform.rotation.value;
      t.push("rot=" + num(r));
    } catch (e) { }
    try { t.push("op=" + num(L.transform.opacity.value)); } catch (e) { }
    return t.join(" ");
  }

  function effectNames(L) {
    var names = [];
    try {
      var fx = L.property("ADBE Effect Parade");
      if (fx) for (var i = 1; i <= fx.numProperties; i++) names.push(fx.property(i).name);
    } catch (e) { }
    return names;
  }

  /* Project-panel items the model can place with AE.fromBin(name) — footage
   * and precomps, skipping solids and the comp itself. */
  function binItems(activeComp, max) {
    var lines = [], total = 0;
    try {
      // NB: access items via app.project.item(i) — ItemCollection.item() is
      // not callable in every AE version and fails as "its.item is undefined".
      var n = app.project.items.length;
      for (var i = 1; i <= n; i++) {
        var it = app.project.item(i);
        if (it === activeComp || it instanceof FolderItem) continue;
        if (!(it instanceof FootageItem || it instanceof CompItem)) continue;
        try { if (it.mainSource && it.mainSource instanceof SolidSource) continue; } catch (e) { }
        total++;
        if (lines.length >= max) continue;
        var bits = '"' + it.name + '"';
        try { if (it.width) bits += " " + it.width + "x" + it.height; } catch (e1) { }
        try { if (it.duration) bits += " " + it.duration.toFixed(1) + "s"; } catch (e2) { }
        bits += it instanceof CompItem ? " (precomp)" : "";
        lines.push(bits);
      }
    } catch (e3) { }
    return { lines: lines, total: total };
  }

  function rendererTag(c) {
    try { return c.renderer ? '  renderer="' + c.renderer + '"' : ""; } catch (e) { return ""; }
  }

  /* mode "summary" (default) → comp settings + per-layer one-liners with
   * keyframe times. mode "full" → adds transform values, effects, expression
   * bodies. layerIndex → deep keyframe/easing dump for that one layer. */
  function state(layerIndex, mode) {
    var full = (mode === "full");
    var c = app.project.activeItem;
    if (!(c && c instanceof CompItem)) {
      return "NO ACTIVE COMP. Ask the user to open a composition in the timeline, or create one with run_script (app.project.items.addComp).";
    }
    var out = [];
    out.push('COMP "' + c.name + '"  ' + c.width + "x" + c.height +
      "  " + c.duration.toFixed(2) + "s @ " + c.frameRate + "fps" +
      "  bg=" + fmt(c.bgColor) + "  playhead=" + c.time.toFixed(2) + "s" +
      "  motionBlur=" + (c.motionBlur ? "on" : "off") +
      "  layers=" + c.numLayers + rendererTag(c));

    var max = c.numLayers > 60 ? 60 : c.numLayers;
    for (var i = 1; i <= max; i++) {
      var L = c.layer(i);
      var bits = [];
      bits.push(i + ': "' + L.name + '" [' + layerType(L) + ']');
      try { if (L.threeDLayer && !(L instanceof CameraLayer) && !(L instanceof LightLayer)) bits.push("3D"); } catch (e) { }
      try { if (L.selected) bits.push("SELECTED"); } catch (e) { }
      try { if (!L.enabled) bits.push("hidden"); } catch (e) { }
      try { bits.push("in=" + L.inPoint.toFixed(2) + " out=" + L.outPoint.toFixed(2)); } catch (e) { }
      if (full) bits.push(transformSummary(L));
      try { if (L.parent) bits.push("parent=" + L.parent.index); } catch (e) { }
      try { if (full && L.motionBlur) bits.push("mb"); } catch (e) { }
      try { if (L instanceof TextLayer) bits.push("text=" + fmt(L.property("Source Text").value.text)); } catch (e) { }
      if (full) {
        var fx = effectNames(L);
        if (fx.length) bits.push("fx[" + fx.join(", ") + "]");
      }

      var anim = [];
      try { walkProps(L, "", anim, full ? "count" : "times"); } catch (e) { }
      out.push(bits.join("  "));
      for (var a = 0; a < anim.length && a < 30; a++) out.push("  " + anim[a]);
    }
    if (c.numLayers > max) out.push("…and " + (c.numLayers - max) + " more layers");

    var bin = binItems(c, 20);
    if (bin.total) {
      out.push('BIN (project items — place with AE.fromBin("name", {fit})): ' + bin.lines.join(" · ") +
        (bin.total > bin.lines.length ? " …+" + (bin.total - bin.lines.length) + " more" : ""));
    }

    if (layerIndex && layerIndex >= 1 && layerIndex <= c.numLayers) {
      var DL = c.layer(layerIndex);
      out.push("");
      out.push('DETAIL for layer ' + layerIndex + ' "' + DL.name + '" (keyframes with interpolation in/out and out-ease influence):');
      var deep = [];
      try { walkProps(DL, "", deep, "deep"); } catch (e) { }
      if (!deep.length) deep.push("  (no keyframes or expressions on this layer)");
      for (var d = 0; d < deep.length && d < 120; d++) out.push(deep[d]);
    }

    var txt = out.join("\n");
    if (txt.length > 30000) txt = txt.substring(0, 30000) + "\n…truncated…";
    return txt;
  }

  /* One-line comp snapshot appended to every run_script result so the model
   * rarely needs a follow-up get_state. */
  function digest() {
    try {
      var c = app.project.activeItem;
      if (!(c && c instanceof CompItem)) return "no active comp";
      var names = [];
      var n = c.numLayers > 14 ? 14 : c.numLayers;
      for (var i = 1; i <= n; i++) names.push(i + ':"' + c.layer(i).name + '"');
      var bin = binItems(c, 6);
      return 'comp "' + c.name + '" ' + c.width + "x" + c.height + " " + c.duration.toFixed(2) + "s, " +
        c.numLayers + " layers: " + names.join(" ") + (c.numLayers > n ? " …" : "") +
        (bin.total ? " | bin: " + bin.lines.join(" ") + (bin.total > bin.lines.length ? " …" : "") : "");
    } catch (e) { return ""; }
  }

  /* Convert every keyframe of a property to bezier ease. Spatial-aware.
   * outInf/inInf = influence 0.1-100 (66 ≈ smooth "easy ease", 80+ = snappy).
   * Returns the number of keys eased. Scripts call $._motionPilot.ease(prop, 66). */
  function ease(prop, outInf, inInf) {
    if (!outInf) outInf = 66;
    if (!inInf) inInf = outInf;
    var dims = 1;
    try {
      if (!prop.isSpatial) {
        if (prop.propertyValueType === PropertyValueType.ThreeD) dims = 3;
        else if (prop.propertyValueType === PropertyValueType.TwoD) dims = 2;
      }
    } catch (e) { }
    function eases(inf) {
      var a = [], e = new KeyframeEase(0, inf);
      for (var j = 0; j < dims; j++) a.push(e);
      return a;
    }
    var n = 0;
    for (var k = 1; k <= prop.numKeys; k++) {
      try {
        prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
        prop.setTemporalEaseAtKey(k, eases(inInf), eases(outInf));
        n++;
      } catch (e1) { }
    }
    return n;
  }

  function renderFrame(time, filePath) {
    var c = app.project.activeItem;
    if (!(c && c instanceof CompItem)) return "ERR::No active composition.";
    try {
      var t = (typeof time === "number" && time >= 0) ? time : c.time;
      if (t > c.duration) t = c.duration;
      if (typeof c.saveFrameToPng !== "function") {
        return "ERR::saveFrameToPng is not available in this version of After Effects.";
      }
      c.saveFrameToPng(t, new File(filePath));
      return "OK::" + t.toFixed(3);
    } catch (e) {
      return "ERR::" + e.toString();
    }
  }

  /* ----- Recreate-mode helpers (called by the panel's prep_reference pipeline) ----- */

  function pad5(n) {
    var s = "" + n;
    while (s.length < 5) s = "0" + s;
    return s;
  }

  function findComp(name) {
    var n = app.project.items.length;
    for (var i = 1; i <= n; i++) {
      var it = app.project.item(i);
      if (it instanceof CompItem && it.name === name) return it;
    }
    return null;
  }

  function listComps() {
    var out = [];
    try {
      var n = app.project.items.length;
      for (var i = 1; i <= n; i++) {
        var it = app.project.item(i);
        if (!(it instanceof CompItem)) continue;
        out.push(encodeURIComponent(it.name) + "|" + it.width + "x" + it.height + "|" +
          it.duration.toFixed(2) + "|" + it.frameRate);
      }
    } catch (e) { }
    return out.length ? out.join(";;") : "NONE";
  }

  /* Project probe printed BEFORE anything else runs, so every later failure
   * can name exactly what AE sees. dir|aepName|itemCount|compCount|aepFullPath */
  function projInfo() {
    try {
      var f = app.project.file;
      var dir = "UNSAVED", nm = "", full = "";
      if (f) {
        nm = f.name;
        try { nm = decodeURIComponent(nm); } catch (e0) { }
        try { dir = f.parent.fsName; } catch (e1) { dir = "UNSAVED"; }
        try { full = f.fsName; } catch (e2) { }
      }
      var items = app.project.items.length, comps = 0;
      for (var i = 1; i <= items; i++) {
        if (app.project.item(i) instanceof CompItem) comps++;
      }
      return "OK::" + dir + "|" + nm + "|" + items + "|" + comps + "|" + full;
    } catch (e) {
      return "ERR::" + e.toString();
    }
  }

  /* Resolve + measure the reference comp. frames|fps|dur|w|h|matches */
  function refInfo(name) {
    try {
      var matches = 0, c = null;
      var n = app.project.items.length;
      for (var i = 1; i <= n; i++) {
        var it = app.project.item(i);
        if (it instanceof CompItem && it.name === name) {
          matches++;
          if (!c) c = it;
        }
      }
      if (!c) return 'ERR::No comp named "' + name + '" (names are case-sensitive).';
      if (typeof c.saveFrameToPng !== "function") {
        return "ERR::saveFrameToPng is not available in this version of After Effects — Recreate needs AE 24.0 or newer.";
      }
      var frames = Math.max(1, Math.round(c.duration * c.frameRate));
      return "OK::" + frames + "|" + c.frameRate + "|" + c.duration + "|" + c.width + "|" + c.height + "|" + matches;
    } catch (e) {
      return "ERR::" + e.toString();
    }
  }

  /* Render a CSV list of frame numbers of a comp to folder/f-XXXXX.png.
   * openInViewer first — some AE builds render un-opened comps unreliably. */
  function renderRefFrames(name, folder, csv) {
    try {
      var c = findComp(name);
      if (!c) return 'ERR::Comp "' + name + '" disappeared mid-render.';
      if (typeof c.saveFrameToPng !== "function") return "ERR::saveFrameToPng unavailable.";
      try { c.openInViewer(); } catch (e0) { }
      var nums = String(csv).split(",");
      var half = 0.5 / c.frameRate;
      for (var i = 0; i < nums.length; i++) {
        var fn = parseInt(nums[i], 10);
        if (isNaN(fn)) continue;
        var t = fn / c.frameRate;
        if (t > c.duration - half) t = Math.max(0, c.duration - half);
        c.saveFrameToPng(t, new File(folder + "/f-" + pad5(fn) + ".png"));
      }
      return "OK::done";
    } catch (e) {
      return "ERR::" + e.toString();
    }
  }

  function folderNamed(name) {
    for (var i = 1; i <= app.project.items.length; i++) {
      var it = app.project.item(i);
      if (it instanceof FolderItem && it.name === name) return it;
    }
    return app.project.items.addFolder(name);
  }
  /* Import a reference video into the Bin (folder 'Reference') and wrap it in a
   * temp comp so the Recreate pipeline can sample it. Returns comp|w|h|fps|dur|item. */
  function importRefVideo(filePath, compName) {
    try {
      var f = new File(filePath);
      if (!f.exists) return 'ERR::Video file not found: ' + filePath;
      var io = new ImportOptions(f);
      if (io.canImportAs(ImportAsType.FOOTAGE)) io.importAs = ImportAsType.FOOTAGE;
      var item = app.project.importFile(io);
      item.parentFolder = folderNamed('Reference');
      var fps = item.frameRate || 30, dur = item.duration || 1;
      var w = item.width || 1920, h = item.height || 1080;
      var c = app.project.items.addComp(compName, w, h, 1, dur, fps);
      c.parentFolder = folderNamed('Reference');
      c.layers.add(item);
      return 'OK::' + c.name + '|' + w + '|' + h + '|' + fps + '|' + dur + '|' + item.name;
    } catch (e) { return 'ERR::' + e.toString(); }
  }
  /* Import contact-sheet PNGs into the Bin folder 'Reference Sheets'. csv = paths joined by '|'. */
  function importSheets(csv, prefix) {
    try {
      var paths = String(csv).split('|'), names = [];
      var fld = folderNamed('Reference Sheets');
      for (var i = 0; i < paths.length; i++) {
        if (!paths[i]) continue;
        var f = new File(paths[i]);
        if (!f.exists) continue;
        var it = app.project.importFile(new ImportOptions(f));
        it.parentFolder = fld;
        it.name = prefix + ' sheet ' + (i + 1 < 10 ? '0' : '') + (i + 1);
        names.push(it.name);
      }
      return 'OK::' + names.join('|');
    } catch (e) { return 'ERR::' + e.toString(); }
  }
  function removeComp(name) {
    try { var c = findComp(name); if (c) c.remove(); return 'OK::removed'; }
    catch (e) { return 'ERR::' + e.toString(); }
  }
  return {
    state: state, renderFrame: renderFrame, ease: ease, digest: digest,
    caps: caps, effectsList: effectsList, inspect: inspect, aeVer: aeVer, propChild: propChild,
    importRefVideo: importRefVideo, importSheets: importSheets, removeComp: removeComp,
    listComps: listComps, projInfo: projInfo, refInfo: refInfo,
    renderRefFrames: renderRefFrames
  };
})();
"loaded"
