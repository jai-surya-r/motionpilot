/* AE.* — general-purpose animation helper library for MotionPilot.
 *
 * Loaded by the panel right after bridge.jsx (idempotent, ES3). The goal is
 * token economy: one AE.* call replaces 20-40 lines of property scaffolding.
 * Conventions:
 *   - every creator returns the layer
 *   - layer arguments accept a Layer object OR its name string
 *   - colors accept "#rrggbb" / "#rgb" strings or [r,g,b] 0-1 arrays
 *   - options objects: every field optional with sensible motion-design defaults
 */
$.global.AE = (function () {

  function comp() {
    var c = app.project.activeItem;
    if (!(c && c instanceof CompItem)) throw new Error("No active composition.");
    return c;
  }

  function rgb(v) {
    if (v instanceof Array) return v;
    var s = String(v).replace("#", "");
    if (s.length === 3) s = s.charAt(0) + s.charAt(0) + s.charAt(1) + s.charAt(1) + s.charAt(2) + s.charAt(2);
    var n = parseInt(s, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  function find(name) {
    var c = comp();
    for (var i = 1; i <= c.numLayers; i++) if (c.layer(i).name === name) return c.layer(i);
    return null;
  }

  function L(x) {
    if (typeof x === "string") {
      var l = find(x);
      if (!l) throw new Error('No layer named "' + x + '"');
      return l;
    }
    return x;
  }

  function findProp(root, mn) {
    if (root.matchName === mn) return root;
    if (root.propertyType !== PropertyType.PROPERTY) {
      for (var i = 1; i <= root.numProperties; i++) {
        var r = null;
        try { r = findProp(root.property(i), mn); } catch (e) {}
        if (r) return r;
      }
    }
    return null;
  }

  function contents(x) { return L(x).property("ADBE Root Vectors Group"); }

  // ---------- create ----------
  function shapeBase(name) {
    var s = comp().layers.addShape();
    s.name = name || "Shape";
    return s;
  }

  function paint(g, o) {
    var gg = g.property("ADBE Vectors Group");
    if (o.stroke !== undefined && o.stroke !== null) {
      var st = gg.addProperty("ADBE Vector Graphic - Stroke");
      st.property("ADBE Vector Stroke Color").setValue(rgb(o.stroke));
      st.property("ADBE Vector Stroke Width").setValue(o.strokeWidth || 4);
      try { st.property("ADBE Vector Stroke Line Cap").setValue(2); } catch (e) {}
      try { st.property("ADBE Vector Stroke Line Join").setValue(2); } catch (e2) {}
    }
    // fill: explicit color → fill it; null → no fill; omitted → white unless stroke-only
    var wantFill = (o.fill !== null) && (o.fill !== undefined || o.stroke === undefined || o.stroke === null);
    if (wantFill) {
      var f = gg.addProperty("ADBE Vector Graphic - Fill");
      f.property("ADBE Vector Fill Color").setValue(rgb(o.fill !== undefined && o.fill !== null ? o.fill : "#FFFFFF"));
    }
  }

  function place(s, o) {
    if (o.pos) s.transform.position.setValue(o.pos);
    if (o.name) s.name = o.name;
  }

  function rect(o) {
    o = o || {};
    var s = shapeBase(o.name || "Rect");
    var g = contents(s).addProperty("ADBE Vector Group");
    g.name = "G";
    var r = g.property("ADBE Vectors Group").addProperty("ADBE Vector Shape - Rect");
    r.property("ADBE Vector Rect Size").setValue([o.w || 200, o.h || 200]);
    if (o.round) r.property("ADBE Vector Rect Roundness").setValue(o.round);
    paint(g, o);
    place(s, o);
    return s;
  }

  function ellipse(o) {
    o = o || {};
    var s = shapeBase(o.name || "Ellipse");
    var g = contents(s).addProperty("ADBE Vector Group");
    g.name = "G";
    var e = g.property("ADBE Vectors Group").addProperty("ADBE Vector Shape - Ellipse");
    e.property("ADBE Vector Ellipse Size").setValue([o.w || 200, o.h || o.w || 200]);
    paint(g, o);
    place(s, o);
    return s;
  }

  function pathLayer(verts, o) {
    o = o || {};
    var s = shapeBase(o.name || "Path");
    var g = contents(s).addProperty("ADBE Vector Group");
    g.name = "G";
    var sh = g.property("ADBE Vectors Group").addProperty("ADBE Vector Shape - Group");
    var p = new Shape();
    p.vertices = verts;
    p.closed = (o.closed !== false);
    if (o.inTangents) p.inTangents = o.inTangents;
    if (o.outTangents) p.outTangents = o.outTangents;
    sh.property("ADBE Vector Shape").setValue(p);
    if (o.fill === undefined) o.fill = null; // paths default to stroke-only
    if (o.stroke === undefined && o.fill === null) o.stroke = "#FFFFFF";
    paint(g, o);
    place(s, o);
    return s;
  }

  function line(p1, p2, o) {
    o = o || {};
    o.closed = false;
    if (o.fill === undefined) o.fill = null;
    if (o.stroke === undefined) o.stroke = "#FFFFFF";
    if (!o.name) o.name = "Line";
    if (!o.pos) o.pos = [0, 0]; // layer space == comp space, so p1/p2 are comp coords
    return pathLayer([p1, p2], o);
  }

  function text(str, o) {
    o = o || {};
    var c = comp();
    var tl = c.layers.addText(String(str));
    var st = tl.property("ADBE Text Properties").property("ADBE Text Document");
    var v = st.value;
    // New text layers inherit the last-used character style (caps, faux bold, tracking) — reset it
    try { v.fontCapsOption = FontCapsOption.FONT_NORMAL_CAPS; } catch (e) {}
    try { v.fauxBold = false; v.fauxItalic = false; v.allCaps = false; v.smallCaps = false; } catch (e) {}
    try { if (o.tracking === undefined) v.tracking = 0; } catch (e) {}
    v.fontSize = o.size || Math.round(c.height / 10);
    if (o.font) v.font = o.font;
    if (o.color) v.fillColor = rgb(o.color);
    if (o.tracking !== undefined) v.tracking = o.tracking;
    try { v.justification = ParagraphJustification.CENTER_JUSTIFY; } catch (e) {}
    st.setValue(v);
    tl.transform.position.setValue(o.pos || [c.width / 2, c.height / 2]);
    if (o.name) tl.name = o.name;
    return tl;
  }

  function solid(o) {
    o = o || {};
    var c = comp();
    var s = c.layers.addSolid(rgb(o.color || "#1B1B1D"), o.name || "Solid", o.w || c.width, o.h || c.height, 1);
    if (o.pos) s.transform.position.setValue(o.pos);
    return s;
  }

  function nullObj(name) {
    var n = comp().layers.addNull();
    if (name) n.name = name;
    return n;
  }

  // ---------- rig ----------
  /* Move the anchor to a spot on the layer's bounds and compensate position
   * so nothing jumps. Do this BEFORE animating scale/rotation. */
  function anchorTo(x, where) {
    var l = L(x), c = comp();
    var r = l.sourceRectAtTime(c.time, false);
    var w = String(where || "center").toLowerCase();
    var ax = r.left + r.width / 2, ay = r.top + r.height / 2;
    if (w.indexOf("top") !== -1) ay = r.top;
    if (w.indexOf("bottom") !== -1) ay = r.top + r.height;
    if (w.indexOf("left") !== -1) ax = r.left;
    if (w.indexOf("right") !== -1) ax = r.left + r.width;
    var oa = l.transform.anchorPoint.value;
    var sc = l.transform.scale.value;
    var p = l.transform.position.value;
    var dx = (ax - oa[0]) * sc[0] / 100, dy = (ay - oa[1]) * sc[1] / 100;
    var rot = 0;
    try { rot = l.threeDLayer ? 0 : l.transform.rotation.value; } catch (e) {}
    if (rot) {
      var rad = rot * Math.PI / 180, c0 = Math.cos(rad), s0 = Math.sin(rad);
      var rx = dx * c0 - dy * s0, ry = dx * s0 + dy * c0;
      dx = rx; dy = ry;
    }
    l.transform.anchorPoint.setValue(oa.length === 3 ? [ax, ay, oa[2]] : [ax, ay]);
    l.transform.position.setValue(p.length === 3 ? [p[0] + dx, p[1] + dy, p[2]] : [p[0] + dx, p[1] + dy]);
    return l;
  }
  function centerAnchor(x) { return anchorTo(x, "center"); }

  function parentTo(child, par) { var cl = L(child); cl.parent = L(par); return cl; }
  function center() { var c = comp(); return [c.width / 2, c.height / 2]; }

  // ---------- keys ----------
  /* Graph-shaped easing. A curve preset = [out-influence at a key, in-influence at the next key]:
   *   arrive  fast launch, long soft landing (entrances, landings, settles)
   *   leave   slow lift-off, fast departure (exits)
   *   whip    steep S, speed peaks mid-move (whip-pans, transitions, travel across the frame)
   *   swift   quick decisive UI snap with a clean stop
   *   soft    gentle symmetric (idle drift, slow pushes, loops)
   * Middle keys of a one-way move keep their speed (no dead stop); reversals (overshoot peaks) stop.
   * HOLD keys stay HOLD. A number instead of a preset = symmetric influence (legacy). */
  var CURVES = { arrive: [12, 88], leave: [88, 12], whip: [85, 85], swift: [40, 92], soft: [50, 50] };

  function numArr(v) {
    if (typeof v === "number") return [v];
    if (v && v.length !== undefined && typeof v[0] === "number") return v;
    return null;
  }

  function curve(prop, preset, o) {
    o = o || {};
    var n = prop.numKeys, k, d, HOLD = KeyframeInterpolationType.HOLD, BEZ = KeyframeInterpolationType.BEZIER;
    if (n < 1) return prop;
    if (preset === "linear" || preset === 0) {
      for (k = 1; k <= n; k++) { try { prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR); } catch (e0) {} }
      return prop;
    }
    var c = preset ? CURVES[preset] : null;
    if (preset && !c) throw new Error("curve preset must be arrive|leave|whip|swift|soft|linear");
    var outI = o.out || (c ? c[0] : 66), inI = o["in"] || (c ? c[1] : outI);
    var spatial = false, pvt = null, dims = 1;
    try { spatial = prop.isSpatial; pvt = prop.propertyValueType; } catch (e1) {}
    if (!spatial && pvt === PropertyValueType.ThreeD) dims = 3;
    else if (!spatial && pvt === PropertyValueType.TwoD) dims = 2;
    var smooth = spatial || pvt === PropertyValueType.OneD || pvt === PropertyValueType.TwoD || pvt === PropertyValueType.ThreeD;
    for (k = 1; k <= n; k++) {
      var ins = [], outs = [];
      var v0 = null, v1 = null, v2 = null, dt = 0;
      if (smooth && k > 1 && k < n) {
        v0 = numArr(prop.keyValue(k - 1)); v1 = numArr(prop.keyValue(k)); v2 = numArr(prop.keyValue(k + 1));
        dt = prop.keyTime(k + 1) - prop.keyTime(k - 1);
      }
      if (spatial) {
        var sp = 0;
        if (v0 && v1 && v2 && dt > 0) {
          var dot = 0, dist = 0;
          for (d = 0; d < v1.length; d++) { dot += (v1[d] - v0[d]) * (v2[d] - v1[d]); dist += (v2[d] - v0[d]) * (v2[d] - v0[d]); }
          if (dot > 0) sp = Math.sqrt(dist) / dt;
        }
        ins.push(sp ? new KeyframeEase(sp, 33) : new KeyframeEase(0, inI));
        outs.push(sp ? new KeyframeEase(sp, 33) : new KeyframeEase(0, outI));
      } else {
        for (d = 0; d < dims; d++) {
          var s = 0;
          if (v0 && v1 && v2 && dt > 0 && v1.length > d) {
            if ((v1[d] - v0[d]) * (v2[d] - v1[d]) > 0) s = (v2[d] - v0[d]) / dt;
          }
          ins.push(s ? new KeyframeEase(s, 33) : new KeyframeEase(0, inI));
          outs.push(s ? new KeyframeEase(s, 33) : new KeyframeEase(0, outI));
        }
      }
      try {
        var hold = prop.keyOutInterpolationType(k) === HOLD;
        prop.setInterpolationTypeAtKey(k, BEZ, hold ? HOLD : BEZ);
        prop.setTemporalEaseAtKey(k, ins, outs);
      } catch (e2) {}
    }
    return prop;
  }

  /* AE.ease(prop,"arrive") re-shapes existing keys in place; AE.ease(prop,72) = legacy symmetric influence. */
  function ease(prop, outInf, inInf) {
    if (typeof outInf === "string") return curve(prop, outInf);
    return curve(prop, null, { out: outInf || 66, "in": inInf || outInf || 66 });
  }

  function keys(prop, times, values, inf) {
    for (var i = 0; i < times.length; i++) prop.setValueAtTime(times[i], values[i]);
    if (inf === 0 || inf === "linear") curve(prop, "linear");
    else if (typeof inf === "string") curve(prop, inf);
    else if (inf) curve(prop, null, { out: inf, "in": inf });
    return prop;
  }

  function expr(prop, code) { prop.expression = code; return prop; }

  function pathProp(x) {
    var g = findProp(contents(x), "ADBE Vector Shape - Group");
    return g ? g.property("ADBE Vector Shape") : null;
  }

  function pathKeys(prop, times, vertsPerTime, o) {
    o = o || {};
    for (var i = 0; i < times.length; i++) {
      var p = new Shape();
      p.vertices = vertsPerTime[i];
      p.closed = (o.closed !== false);
      if (o.inTangents) p.inTangents = o.inTangents[i];
      if (o.outTangents) p.outTangents = o.outTangents[i];
      prop.setValueAtTime(times[i], p);
    }
    if (o.inf) ease(prop, o.inf);
    return prop;
  }

  // ---------- motion ----------
  function sameDims(sample, n) {
    var a = [];
    for (var i = 0; i < sample.length; i++) a.push(n);
    return a;
  }

  function fadeIn(x, t, dur) {
    var l = L(x);
    keys(l.transform.opacity, [t, t + (dur || 0.4)], [0, 100], "arrive");
    return l;
  }

  function fadeOut(x, t, dur) {
    var l = L(x);
    keys(l.transform.opacity, [t, t + (dur || 0.4)], [l.transform.opacity.valueAtTime(t, false), 0], "leave");
    return l;
  }

  function pop(x, t, o) {
    o = o || {};
    var l = centerAnchor(x);
    var dur = o.dur || 0.55, over = o.over || 106;
    var sv = l.transform.scale.value;
    keys(l.transform.scale,
      [t, t + dur * 0.7, t + dur],
      [sameDims(sv, 0), sameDims(sv, over), sameDims(sv, 100)], o.ease || "arrive");
    return l;
  }

  function slideIn(x, t, o) {
    o = o || {};
    var l = L(x);
    var dur = o.dur || 0.6, dist = o.dist || 120, from = o.from || "left";
    var p = l.transform.position.value;
    var dx = 0, dy = 0;
    if (from === "left") dx = -dist;
    else if (from === "right") dx = dist;
    else if (from === "top" || from === "up") dy = -dist;
    else dy = dist;
    var start = p.length === 3 ? [p[0] + dx, p[1] + dy, p[2]] : [p[0] + dx, p[1] + dy];
    keys(l.transform.position, [t, t + dur], [start, p], o.ease || "arrive");
    keys(l.transform.opacity, [t, t + dur * 0.6], [0, 100], "arrive");
    return l;
  }

  function staggerIn(layers, t0, step, mode) {
    step = (step === undefined || step === null) ? 0.08 : step;
    mode = String(mode || "pop");
    for (var i = 0; i < layers.length; i++) {
      var t = t0 + i * step;
      if (mode === "fade") fadeIn(layers[i], t);
      else if (mode.indexOf("slide") === 0) slideIn(layers[i], t, { from: mode.split(":")[1] || "bottom" });
      else pop(layers[i], t);
    }
    return layers.length;
  }

  /* Physics settle after the last keyframe (inertial bounce). */
  function bounce(prop, o) {
    o = o || {};
    var amp = o.amp || 0.05, freq = o.freq || 3, decay = o.decay || 7;
    prop.expression =
      "var n=numKeys;" +
      "if(n>0&&time>key(n).time){var t=time-key(n).time;var v=velocityAtTime(key(n).time-0.001);" +
      "value+v*" + amp + "*Math.sin(" + freq + "*t*2*Math.PI)/Math.exp(" + decay + "*t);}else{value;}";
    return prop;
  }

  function idleWiggle(prop, freq, amp) {
    prop.expression = "wiggle(" + (freq || 2) + "," + (amp || 3) + ")";
    return prop;
  }

  /* Travel along a path layer made with AE.path()/AE.line() between t0 and t1. */
  function alongPath(x, pathX, t0, t1, orient) {
    var l = L(x), pl = L(pathX);
    var base = 'var pl=thisComp.layer("' + pl.name + '");' +
      'var pp=pl.content("G").content("Path 1").path;' +
      'var pr=linear(time,' + t0 + ',' + t1 + ',0,1);';
    l.transform.position.expression = base + 'pl.toComp(pp.pointOnPath(pr));';
    if (orient) {
      l.transform.rotation.expression = base +
        'var tg=pp.tangentOnPath(pr);radiansToDegrees(Math.atan2(tg[1],tg[0]));';
    }
    return l;
  }

  // ---------- stylize (shape operators) ----------
  function trim(x) { return contents(x).addProperty("ADBE Vector Filter - Trim"); }

  function drawOn(x, t, dur) {
    var tr = trim(x);
    var end = tr.property("ADBE Vector Trim End");
    end.setValue(0);
    keys(end, [t, t + (dur || 0.8)], [0, 100], 74);
    return tr;
  }

  function wipeOff(x, t, dur) {
    var tr = trim(x);
    keys(tr.property("ADBE Vector Trim Start"), [t, t + (dur || 0.6)], [0, 100], 74);
    return tr;
  }

  function dash(x, dashLen, gapLen, speed) {
    var l = L(x);
    var st = findProp(contents(l), "ADBE Vector Graphic - Stroke");
    if (!st) throw new Error("Layer has no stroke to dash.");
    var ds = st.property("ADBE Vector Stroke Dashes");
    ds.addProperty("ADBE Vector Stroke Dash 1").setValue(dashLen === undefined ? 12 : dashLen);
    try { ds.addProperty("ADBE Vector Stroke Gap 1").setValue(gapLen === undefined ? 12 : gapLen); } catch (e) {}
    if (speed) {
      var off = ds.addProperty("ADBE Vector Stroke Offset");
      off.expression = "time*" + (-speed);
    }
    return l;
  }

  function repeater(x, copies, o) {
    o = o || {};
    copies = copies || 6;
    var rp = contents(x).addProperty("ADBE Vector Filter - Repeater");
    rp.property("ADBE Vector Repeater Copies").setValue(copies);
    var tr = rp.property("ADBE Vector Repeater Transform");
    if (o.offset) {
      tr.property("ADBE Vector Repeater Position").setValue(o.offset);
      if (o.rotation !== undefined) tr.property("ADBE Vector Repeater Rotation").setValue(o.rotation);
    } else { // radial by default: shapes fan around the layer anchor
      tr.property("ADBE Vector Repeater Position").setValue([0, 0]);
      tr.property("ADBE Vector Repeater Rotation").setValue(o.rotation !== undefined ? o.rotation : 360 / copies);
    }
    if (o.endOpacity !== undefined) {
      try { tr.property("ADBE Vector Repeater Opacity 2").setValue(o.endOpacity); } catch (e) {}
    }
    return rp;
  }

  function wigglePath(x, size, detail, freq) {
    var w = contents(x).addProperty("ADBE Vector Filter - Roughen");
    w.property("ADBE Vector Roughen Size").setValue(size === undefined ? 4 : size);
    w.property("ADBE Vector Roughen Detail").setValue(detail === undefined ? 3 : detail);
    try { w.property("ADBE Vector Temporal Freq").setValue(freq === undefined ? 8 : freq); } catch (e) {}
    return w;
  }

  function zigzag(x, size, ridges) {
    var z = contents(x).addProperty("ADBE Vector Filter - Zigzag");
    z.property("ADBE Vector Zigzag Size").setValue(size === undefined ? 10 : size);
    try { z.property("ADBE Vector Zigzag Detail").setValue(ridges === undefined ? 6 : ridges); } catch (e) {}
    return z;
  }

  function roundCorners(x, radius) {
    var rc = contents(x).addProperty("ADBE Vector Filter - RC");
    rc.property("ADBE Vector RoundCorner Radius").setValue(radius === undefined ? 12 : radius);
    return rc;
  }

  function offsetPath(x, amount) {
    var op = contents(x).addProperty("ADBE Vector Filter - Offset");
    op.property("ADBE Vector Offset Amount").setValue(amount || 10);
    return op;
  }

  /* Tapered stroke ends (AE 2020+). Percent 0-100. Returns null if unsupported. */
  function taper(x, startPct, endPct) {
    try {
      var st = findProp(contents(x), "ADBE Vector Graphic - Stroke");
      if (!st) return null;
      var tp = null;
      for (var i = 1; i <= st.numProperties; i++) {
        var ch = st.property(i);
        if (ch && ch.name && String(ch.name).toLowerCase() === "taper") { tp = ch; break; }
      }
      if (!tp) return null;
      for (var j = 1; j <= tp.numProperties; j++) {
        var p2 = tp.property(j), nm = String(p2.name).toLowerCase();
        if (nm === "start length" && startPct !== undefined) p2.setValue(startPct);
        if (nm === "end length" && endPct !== undefined) p2.setValue(endPct);
      }
      return tp;
    } catch (e) { return null; }
  }

  /* Classic radial line-burst accent (logo pops, click emphasis). */
  function burst(o) {
    o = o || {};
    var c = comp();
    var t = o.t || 0;
    var pos = o.pos || [c.width / 2, c.height / 2];
    var count = o.count || 8;
    var radius = o.radius || 60;
    var len = o.len || 50;
    var l = line([0, -radius], [0, -(radius + len)], {
      stroke: o.color || "#FFFFFF",
      strokeWidth: o.strokeWidth || 8,
      name: o.name || "Burst"
    });
    l.transform.position.setValue(pos);
    taper(l, 0, 100);
    var tr = trim(l);
    keys(tr.property("ADBE Vector Trim End"), [t, t + 0.3], [0, 100], 80);
    keys(tr.property("ADBE Vector Trim Start"), [t + 0.08, t + 0.42], [0, 100], 80);
    repeater(l, count);
    l.inPoint = t;
    l.outPoint = t + 0.6;
    return l;
  }

  // ---------- text & effects ----------
  function typeOn(x, t, dur) {
    var l = L(x);
    var an = l.property("ADBE Text Properties").property("ADBE Text Animators").addProperty("ADBE Text Animator");
    an.name = "TypeOn";
    an.property("ADBE Text Animator Properties").addProperty("ADBE Text Opacity").setValue(0);
    var sel = an.property("ADBE Text Selectors").addProperty("ADBE Text Selector");
    try { sel.property("ADBE Text Range Advanced").property("ADBE Text Selector Smoothness").setValue(0); } catch (e) {}
    keys(sel.property("ADBE Text Percent Start"), [t, t + (dur || 1)], [0, 100]);
    return l;
  }

  function effects(x) { return L(x).property("ADBE Effect Parade"); }

  /* Generic effect access — with fxSet/fxProp this makes the whole AE effects
   * catalog one-liner scriptable: var f = AE.fx(l, "ADBE Wave Warp"); AE.fxSet(f, "Wave Height", 30); */
  function fx(x, matchName) { return effects(x).addProperty(matchName); }

  /* Comp-sized adjustment layer — the right home for comp-wide looks. */
  function adjust(name) {
    var c = comp();
    var s = c.layers.addSolid([1, 1, 1], name || "Adjust", c.width, c.height, 1);
    s.adjustmentLayer = true;
    return s;
  }

  function gradient(x, c1, c2, o) {
    o = o || {};
    var fx = effects(x).addProperty("ADBE Ramp");
    fx.property("ADBE Ramp-0002").setValue(rgb(c1 || "#FFFFFF"));
    fx.property("ADBE Ramp-0004").setValue(rgb(c2 || "#000000"));
    if (o.from) fx.property("ADBE Ramp-0001").setValue(o.from);
    if (o.to) fx.property("ADBE Ramp-0003").setValue(o.to);
    if (o.radial) fx.property("ADBE Ramp-0005").setValue(2);
    return fx;
  }

  function shadow(x, o) {
    o = o || {};
    var fx = effects(x).addProperty("ADBE Drop Shadow");
    fx.property("ADBE Drop Shadow-0002").setValue(((o.opacity !== undefined ? o.opacity : 35) / 100) * 255);
    if (o.direction !== undefined) fx.property("ADBE Drop Shadow-0003").setValue(o.direction);
    fx.property("ADBE Drop Shadow-0004").setValue(o.distance !== undefined ? o.distance : 10);
    fx.property("ADBE Drop Shadow-0005").setValue(o.softness !== undefined ? o.softness : 20);
    return fx;
  }

  function glow(x, o) {
    o = o || {};
    var fx = effects(x).addProperty("ADBE Glo2");
    try { if (o.radius !== undefined) fx.property("ADBE Glo2-0003").setValue(o.radius); } catch (e) {}
    try { if (o.intensity !== undefined) fx.property("ADBE Glo2-0004").setValue(o.intensity); } catch (e2) {}
    return fx;
  }

  function blur(x, amount) {
    var fx = effects(x).addProperty("ADBE Gaussian Blur 2");
    fx.property("ADBE Gaussian Blur 2-0001").setValue(amount || 12);
    return fx;
  }

  // ---------- scene building (complex work from scratch) ----------
  /* Precompose layers into a group; returns the new precomp LAYER. */
  function precomp(layers, name) {
    var c = comp(), ids = [];
    for (var i = 0; i < layers.length; i++) ids.push(L(layers[i]).index);
    var item = c.layers.precompose(ids, name || "Group", true);
    for (var j = 1; j <= c.numLayers; j++) {
      if (c.layer(j).source === item) return c.layer(j);
    }
    return null;
  }

  /* Null rig: parents the given layers to a new null and returns it. */
  function rig(layers, name) {
    var c = comp();
    var n = c.layers.addNull();
    n.name = name || "RIG";
    n.transform.position.setValue([c.width / 2, c.height / 2]);
    for (var i = 0; i < layers.length; i++) {
      try { L(layers[i]).parent = n; } catch (e) {}
    }
    return n;
  }

  /* Camera-style global move: parents every unparented layer to a "CAM" null
   * and keys a slow push/pan/rotate. The cheapest premium multiplier —
   * AE.cam() alone gives the default 100→106 push over the whole comp. */
  function cam(o) {
    o = o || {};
    var c = comp();
    var targets = [];
    if (o.layers) {
      for (var i = 0; i < o.layers.length; i++) targets.push(L(o.layers[i]));
    } else {
      for (var j = 1; j <= c.numLayers; j++) {
        var lj = c.layer(j);
        if (!lj.parent) targets.push(lj);
      }
    }
    var n = rig(targets, o.name || "CAM");
    var t = o.t || [0, c.duration];
    var zoom = o.zoom || [100, 106];
    var ci = o.inf || "soft";
    keys(n.transform.scale, t, [[zoom[0], zoom[0]], [zoom[1], zoom[1]]], ci);
    if (o.pan) {
      var p0 = n.transform.position.value;
      keys(n.transform.position, t, [p0, [p0[0] - o.pan[0], p0[1] - o.pan[1]]], ci);
    }
    if (o.rotate) keys(n.transform.rotation, t, o.rotate, ci);
    return n;
  }

  /* Parallax rig: pairs = [[layer, depth 0-1], ...] (0 = far/static, 1 = near/
   * full movement). Returns a driver null — animate ITS position and every
   * paired layer follows at its own depth. */
  function parallax(pairs, name) {
    var c = comp();
    var drv = c.layers.addNull();
    drv.name = name || "PARALLAX";
    drv.transform.position.setValue([c.width / 2, c.height / 2]);
    // Depth slider (0 = flat approved layout, 100 = full parallax) scales every plane's offset
    var depth = null;
    try { depth = control(drv, "slider", "Depth"); depth.setValue(100); } catch (e) { depth = null; }
    var dScale = depth ? '*(thisComp.layer("' + drv.name + '").effect("Depth")(1).value/100)' : '';
    for (var i = 0; i < pairs.length; i++) {
      var l = L(pairs[i][0]), k = pairs[i][1];
      l.transform.position.expression =
        'var p=thisComp.layer("' + drv.name + '").transform.position;' +
        'value+[(p[0]-' + (c.width / 2) + ')*' + k + dScale + ',(p[1]-' + (c.height / 2) + ')*' + k + dScale + '];';
    }
    return drv;
  }

  /* loopOut wrapper: AE.loop(prop) cycles its keyframes forever. */
  function loop(prop, type) {
    prop.expression = 'loopOut("' + (type || "cycle") + '")';
    return prop;
  }

  // ---------- texture & look ----------
  /* Effects like Fractal Noise expose flat numbered matchNames that shift
   * between AE versions, so look properties up by display name (guarded —
   * returns null on non-English AE, callers skip silently). */
  function fxProp(fx, want) {
    want = String(want).toLowerCase();
    function walk(g) {
      for (var i = 1; i <= g.numProperties; i++) {
        var p;
        try { p = g.property(i); } catch (e) { continue; }
        if (!p) continue;
        if (p.name && String(p.name).toLowerCase() === want) return p;
        if (p.propertyType !== PropertyType.PROPERTY) {
          var r = walk(p);
          if (r) return r;
        }
      }
      return null;
    }
    return walk(fx);
  }

  function fxSet(fx, nm, v) {
    if (v === undefined) return;
    var p = fxProp(fx, nm);
    if (p) try { p.setValue(v); } catch (e) {}
  }

  /* Film-grain shimmer via the Noise effect (regenerates every frame). */
  function grain(x, amount) {
    var fx = effects(x).addProperty("ADBE Noise");
    fx.property("ADBE Noise-0001").setValue(amount === undefined ? 8 : amount);
    try { fx.property("ADBE Noise-0002").setValue(0); } catch (e) {} // monochrome
    return fx;
  }

  /* Fractal Noise on a layer. speed = evolution revolutions/sec (living texture). */
  function fractal(x, o) {
    o = o || {};
    var fx = effects(x).addProperty("ADBE Fractal Noise");
    fxSet(fx, "contrast", o.contrast);
    fxSet(fx, "brightness", o.brightness);
    fxSet(fx, "scale", o.scale);
    fxSet(fx, "complexity", o.complexity);
    if (o.speed) {
      var ev = fxProp(fx, "evolution");
      if (ev) try { ev.expression = "time*" + Math.round(o.speed * 360); } catch (e) {}
    }
    return fx;
  }

  /* Full-comp texture overlay: gray solid + noise, blended over everything.
   * styles: "paper" (soft multiply), "grunge" (harsh overlay), "film" (animated grain). */
  function texture(o) {
    o = o || {};
    var c = comp();
    var st = o.style || "paper";
    var s = solid({ color: "#808080", name: o.name || ("Texture " + st) });
    if (st === "film") {
      grain(s, o.amount === undefined ? 30 : o.amount);
      s.blendingMode = BlendingMode.OVERLAY;
    } else if (st === "grunge") {
      fractal(s, { contrast: 250, brightness: -25, scale: o.scale || 180, complexity: 4, speed: o.speed });
      s.blendingMode = BlendingMode.OVERLAY;
    } else { // paper
      fractal(s, { contrast: 25, brightness: 0, scale: o.scale || 350, complexity: 6, speed: o.speed });
      s.blendingMode = BlendingMode.MULTIPLY;
    }
    s.transform.opacity.setValue(o.opacity === undefined ? (st === "film" ? 40 : 22) : o.opacity);
    s.moveToBeginning();
    return s;
  }

  /* Turbulent Displace — warped organic edges. speed animates evolution. */
  function turbulence(x, amount, size, speed) {
    var fx = effects(x).addProperty("ADBE Turbulent Displace");
    fxSet(fx, "amount", amount === undefined ? 15 : amount);
    fxSet(fx, "size", size === undefined ? 40 : size);
    if (speed) {
      var ev = fxProp(fx, "evolution");
      if (ev) try { ev.expression = "time*" + Math.round(speed * 360); } catch (e) {}
    }
    return fx;
  }

  function posterize(x, levels) {
    var fx = effects(x).addProperty("ADBE Posterize");
    fxSet(fx, "level", levels || 6);
    return fx;
  }

  function tint(x, dark, light, amount) {
    var fx = effects(x).addProperty("ADBE Tint");
    try { fx.property("ADBE Tint-0001").setValue(rgb(dark || "#000000")); } catch (e) { fxSet(fx, "map black to", rgb(dark || "#000000")); }
    try { fx.property("ADBE Tint-0002").setValue(rgb(light || "#FFFFFF")); } catch (e1) { fxSet(fx, "map white to", rgb(light || "#FFFFFF")); }
    try { fx.property("ADBE Tint-0003").setValue(amount === undefined ? 100 : amount); } catch (e2) { fxSet(fx, "amount to tint", amount === undefined ? 100 : amount); }
    return fx;
  }

  /* Darkened-corner vignette: black solid with an inverted feathered ellipse mask. */
  function vignette(o) {
    o = o || {};
    var c = comp();
    var s = solid({ color: o.color || "#000000", name: o.name || "Vignette" });
    var m = s.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
    var w = c.width, h = c.height;
    var ix = w * (o.inset === undefined ? 0.06 : o.inset);
    var iy = h * (o.inset === undefined ? 0.06 : o.inset);
    var rx = (w / 2 - ix), ry = (h / 2 - iy), k = 0.5523;
    var p = new Shape();
    p.vertices = [[w / 2, iy], [w - ix, h / 2], [w / 2, h - iy], [ix, h / 2]];
    p.inTangents = [[-rx * k, 0], [0, -ry * k], [rx * k, 0], [0, ry * k]];
    p.outTangents = [[rx * k, 0], [0, ry * k], [-rx * k, 0], [0, -ry * k]];
    p.closed = true;
    m.property("ADBE Mask Shape").setValue(p);
    m.inverted = true;
    var f = o.feather === undefined ? Math.min(w, h) * 0.3 : o.feather;
    m.property("ADBE Mask Feather").setValue([f, f]);
    s.transform.opacity.setValue(o.opacity === undefined ? 35 : o.opacity);
    s.moveToBeginning();
    return s;
  }

  // ---------- project-bin assets ----------
  /* Add a project-panel item (footage the user imported, or a precomp) to the
   * active comp by name — exact match first, then case-insensitive substring.
   * Auto-scales from the item's pixel size (no file reading needed):
   * default = shrink to fit the comp if larger; fit:0.5 = half the comp. */
  function fromBin(name, o) {
    o = o || {};
    var c = comp();
    var it = null, sub = null, low = String(name).toLowerCase();
    // app.project.item(i), not items.item(i) — ItemCollection.item() is not
    // callable in every AE version ("its.item is undefined").
    var n = app.project.items.length;
    for (var i = 1; i <= n; i++) {
      var x = app.project.item(i);
      if (x === c || x instanceof FolderItem) continue;
      if (!(x instanceof FootageItem || x instanceof CompItem)) continue;
      if (x.name === name) { it = x; break; }
      if (!sub && String(x.name).toLowerCase().indexOf(low) !== -1) sub = x;
    }
    if (!it) it = sub;
    if (!it) throw new Error('No project item matching "' + name + '" — check the bin names in get_state.');
    return placeItem(it, o);
  }

  function placeItem(it, o) {
    o = o || {};
    var c = comp();
    var l = c.layers.add(it);
    try {
      var w = it.width, h = it.height;
      if (w && h) {
        var sc;
        if (o.fit === undefined) sc = (w > c.width || h > c.height) ? Math.min(c.width / w, c.height / h) : 1;
        else sc = Math.min(c.width / w, c.height / h) * o.fit;
        l.transform.scale.setValue([sc * 100, sc * 100]);
      }
    } catch (e) {}
    try { l.transform.position.setValue(o.pos || [c.width / 2, c.height / 2]); } catch (e1) {}
    if (o.name) l.name = o.name;
    return l;
  }

  /* Chroma-key a solid generation background off a layer: Keylight when
   * installed (best edges), else Linear Color Key; then a light choke and
   * spill cleanup. color = the key background's color ("#00FF00" default). */
  function keyOut(x, color, o) {
    o = o || {};
    var l = L(x);
    var kc = rgb(color || "#00FF00");
    var f;
    try {
      f = effects(l).addProperty("Keylight 906");
      fxSet(f, "screen colour", kc);
      if (o.gain !== undefined) fxSet(f, "screen gain", o.gain);
    } catch (e) {
      f = effects(l).addProperty("ADBE Linear Color Key");
      fxSet(f, "key color", kc);
      fxSet(f, "matching tolerance", o.tolerance === undefined ? 18 : o.tolerance);
      fxSet(f, "matching softness", o.softness === undefined ? 8 : o.softness);
    }
    try {
      var ch = effects(l).addProperty("ADBE Simple Choker");
      fxSet(ch, "choke matte", o.choke === undefined ? 1 : o.choke);
    } catch (e1) {}
    try { effects(l).addProperty("ADBE SpillSuppression"); } catch (e2) {} // Advanced Spill Suppressor, auto mode
    return l;
  }

  /* Import a file into the project. If the .aep is saved, the file is first
   * COPIED into an "AI Assets" folder beside it, so generated assets travel
   * with the user's project instead of dying in %TEMP%. place:true (or fit/
   * pos) also adds it to the comp with fromBin's auto-scaling and returns the
   * layer; otherwise returns the FootageItem. */
  function importAsset(p, o) {
    o = o || {};
    var f = new File(p);
    if (!f.exists) throw new Error("File not found: " + p);
    try {
      if (app.project.file) {
        var dir = new Folder(app.project.file.parent.fsName + "/AI Assets");
        if (!dir.exists) dir.create();
        var dest = new File(dir.fsName + "/" + f.name);
        if (!dest.exists) f.copy(dest.fsName);
        if (dest.exists) f = dest;
      }
    } catch (e) {}
    var item = app.project.importFile(new ImportOptions(f));
    if (o.place || o.fit !== undefined || o.pos) return placeItem(item, o);
    return item;
  }

  // ---------- structure / edit ----------
  function trimLayer(x, inT, outT) {
    var l = L(x);
    if (inT !== undefined && inT !== null) l.inPoint = inT;
    if (outT !== undefined && outT !== null) l.outPoint = outT;
    return l;
  }

  function splitLayer(x, t) {
    var l = L(x);
    var d = l.duplicate(); // lands directly above the original
    l.outPoint = t;
    d.inPoint = t;
    return d;
  }

  function reorder(x, where) {
    var l = L(x);
    if (where === "top") l.moveToBeginning();
    else if (where === "bottom") l.moveToEnd();
    else if (typeof where === "number") {
      var c = comp();
      var idx = Math.max(1, Math.min(c.numLayers, where));
      var target = c.layer(idx);
      if (target !== l) { if (l.index > idx) l.moveBefore(target); else l.moveAfter(target); }
    } else l.moveBefore(L(where));
    return l;
  }

  function workArea(t0, t1) {
    var c = comp();
    c.workAreaStart = t0;
    c.workAreaDuration = Math.max(1 / c.frameRate, t1 - t0);
    return c;
  }

  function dupComp(newName, srcName) {
    var c = null;
    if (srcName) {
      for (var i = 1; i <= app.project.numItems; i++) {
        var it = app.project.items[i];
        if (it instanceof CompItem && it.name === srcName) { c = it; break; }
      }
      if (!c) throw new Error('No comp named "' + srcName + '"');
    } else c = comp();
    var d = c.duplicate();
    if (newName) d.name = newName;
    d.openInViewer();
    return d;
  }

  function removeFx(x, nm) {
    var ep = effects(x), n = 0;
    for (var i = ep.numProperties; i >= 1; i--) {
      var f = ep.property(i);
      if (f.name === nm || f.matchName === nm) { f.remove(); n++; }
    }
    return n;
  }

  function marker(t, comment, o) {
    o = o || {};
    var mv = new MarkerValue(comment || "");
    if (o.dur) mv.duration = o.dur;
    if (o.protect) { try { mv.protectedRegion = true; } catch (e) {} }
    var prop = o.layer ? L(o.layer).property("ADBE Marker") : comp().markerProperty;
    prop.setValueAtTime(t, mv);
    return prop;
  }

  // ---------- masks & text-on-path ----------
  function mask(x, verts, o) {
    o = o || {};
    var l = L(x);
    var m = l.property("ADBE Mask Parade").addProperty("ADBE Mask Atom");
    if (o.name) m.name = o.name;
    var sh = new Shape();
    sh.vertices = verts;
    if (o.inTangents) sh.inTangents = o.inTangents;
    if (o.outTangents) sh.outTangents = o.outTangents;
    sh.closed = o.closed !== false;
    m.property("ADBE Mask Shape").setValue(sh);
    var modes = { add: MaskMode.ADD, subtract: MaskMode.SUBTRACT, intersect: MaskMode.INTERSECT, none: MaskMode.NONE };
    if (o.mode && modes[o.mode] !== undefined) m.maskMode = modes[o.mode];
    if (o.inverted) m.inverted = true;
    if (o.feather !== undefined) m.property("ADBE Mask Feather").setValue([o.feather, o.feather]);
    if (o.opacity !== undefined) m.property("ADBE Mask Opacity").setValue(o.opacity);
    if (o.expansion !== undefined) m.property("ADBE Mask Offset").setValue(o.expansion);
    return m;
  }

  function textOnPath(x, verts, o) {
    o = o || {};
    var l = (x && x.property) ? L(x) : text(String(x), o);
    // mode "none" so the path guides the text without clipping the layer
    mask(l, verts, { closed: o.closed === true, mode: "none", name: "text path" });
    var idx = l.property("ADBE Mask Parade").numProperties;
    l.property("ADBE Text Properties").property("ADBE Text Path Options").property("ADBE Text Path").setValue(idx);
    return l;
  }

  function textPathMargin(x) {
    return L(x).property("ADBE Text Properties").property("ADBE Text Path Options").property("ADBE Text First Margin");
  }

  function styleText(x, o) {
    o = o || {};
    var l = L(x);
    var st = l.property("ADBE Text Properties").property("ADBE Text Document");
    var d = st.value;
    if (o.text !== undefined) d.text = String(o.text);
    if (o.size) d.fontSize = o.size;
    if (o.font) d.font = o.font;
    if (o.color) { d.applyFill = true; d.fillColor = rgb(o.color); }
    if (o.tracking !== undefined) d.tracking = o.tracking;
    if (o.leading) { d.autoLeading = false; d.leading = o.leading; }
    if (o.justify) {
      var j = { left: ParagraphJustification.LEFT_JUSTIFY, center: ParagraphJustification.CENTER_JUSTIFY, right: ParagraphJustification.RIGHT_JUSTIFY }[o.justify];
      if (j) d.justification = j;
    }
    st.setValue(d);
    return l;
  }

  // ---------- rig plumbing ----------
  function control(x, kind, name) {
    var mn = {
      slider: "ADBE Slider Control", checkbox: "ADBE Checkbox Control",
      color: "ADBE Color Control", point: "ADBE Point Control",
      angle: "ADBE Angle Control", layer: "ADBE Layer Control"
    }[String(kind).toLowerCase()];
    if (!mn) throw new Error("control kind must be slider|checkbox|color|point|angle|layer");
    var f = fx(x, mn);
    if (name) f.name = name;
    return f.property(1);
  }

  function link(target, source, mult) {
    var chain = [], cur = source;
    while (cur.propertyDepth > 0) {
      chain.unshift('property("' + cur.matchName + '")');
      cur = cur.parentProperty;
    }
    var code = 'thisComp.layer("' + cur.name.replace(/"/g, '\\"') + '").' + chain.join(".");
    if (mult !== undefined && mult !== 1) code += " * " + mult;
    target.expression = code;
    return target;
  }

  // ---------- shape morphs, text and layout helpers ----------
  /* Key a Rounded Rect / Ellipse SIZE (never Scale) so corner radius holds through a morph. */
  function sizeKeys(x, times, sizes, inf) {
    var l = L(x);
    var r = findProp(contents(l), "ADBE Vector Shape - Rect");
    var p = r ? r.property("ADBE Vector Rect Size") : null;
    if (!p) { var e = findProp(contents(l), "ADBE Vector Shape - Ellipse"); p = e ? e.property("ADBE Vector Ellipse Size") : null; }
    if (!p) throw new Error("sizeKeys: layer has no Rect/Ellipse shape");
    for (var i = 0; i < times.length; i++) p.setValueAtTime(times[i], sizes[i]);
    if (inf) ease(p, inf);
    return p;
  }

  /* Slider-driven number on a text layer: from -> to between t0 and t1 (prefix/suffix/decimals). */
  function countUp(x, t0, t1, from, to, o) {
    o = o || {};
    var l = L(x);
    var sl = control(l, "slider", "count");
    keys(sl, [t0, t1], [from, to], o.inf || "arrive");
    var dec = o.decimals || 0;
    var pre = String(o.prefix || "").replace(/"/g, '\\"'), suf = String(o.suffix || "").replace(/"/g, '\\"');
    var code = "var v=effect(\"count\")(1).value;" +
      (o.commas === false ? "var s=v.toFixed(" + dec + ");" : "var s=v.toFixed(" + dec + ");var a=s.split('.');a[0]=a[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g,',');s=a.join('.');") +
      "\"" + pre + "\"+s+\"" + suf + "\"";
    l.property("ADBE Text Properties").property("ADBE Text Document").expression = code;
    return l;
  }

  /* Offset each layer's existing keys/in-point by index*step (a stagger in one call). */
  function stagger(layers, step, o) {
    o = o || {};
    step = (step === undefined || step === null) ? 0.1 : step;
    for (var i = 0; i < layers.length; i++) {
      var l = L(layers[i]);
      l.startTime = l.startTime + i * step + (o.from || 0);
    }
    return layers.length;
  }

  /* A cursor arrow shape layer (white fill, dark stroke) at pos; click(l,t) adds the 2-frame press dip. */
  function cursor(o) {
    o = o || {};
    var sz = o.size || 28;
    var v = [[0, 0], [0, sz], [sz * 0.28, sz * 0.78], [sz * 0.5, sz * 1.2], [sz * 0.66, sz * 1.12], [sz * 0.44, sz * 0.72], [sz * 0.78, sz * 0.72]];
    var l = pathLayer(v, { closed: true, fill: o.fill || "#ffffff", stroke: o.stroke || "#111111", strokeWidth: o.strokeWidth || 2, pos: o.pos, name: o.name || "cursor" });
    try { l.transform.anchorPoint.setValue([0, 0]); } catch (e) {}
    l.motionBlur = true;
    return l;
  }
  function click(x, t) {
    var l = L(x), f = 1 / comp().frameRate;
    keys(l.transform.scale, [t, t + 2 * f, t + 4 * f], [[100, 100], [86, 86], [100, 100]], "swift");
    return l;
  }

  /* Clip `content` to `shape` (alpha/luma track matte); shape is moved directly above content. */
  function matte(content, shape, kind) {
    var c = L(content), m = L(shape);
    try { m.moveBefore(c); } catch (e) {}
    var luma = String(kind || "alpha").toLowerCase() === "luma";
    try { c.setTrackMatte(m, luma ? TrackMatteType.LUMA : TrackMatteType.ALPHA); }
    catch (e) { c.trackMatteType = luma ? TrackMatteType.LUMA : TrackMatteType.ALPHA; }
    return c;
  }

  /* Text animator with a Range Selector: per-word or per-character stagger of one property.
   * prop: "opacity"|"position"|"scale"|"tracking"|"blur"; o: {unit:"word"|"char", from, to, t, dur, inf, name} */
  function textAnim(x, prop, o) {
    o = o || {};
    var l = L(x), c = comp();
    var mn = { opacity: "ADBE Text Opacity", position: "ADBE Text Position 3D", scale: "ADBE Text Scale 3D", tracking: "ADBE Text Tracking Amount", blur: "ADBE Text Blur" }[String(prop).toLowerCase()];
    if (!mn) throw new Error("textAnim prop must be opacity|position|scale|tracking|blur");
    var anims = l.property("ADBE Text Properties").property("ADBE Text Animators");
    var an = anims.addProperty("ADBE Text Animator");
    an.name = o.name || ("anim " + prop);
    var sel = an.property("ADBE Text Selectors").addProperty("ADBE Text Selector");
    var adv = sel.property("ADBE Text Range Advanced");
    try { adv.property("ADBE Text Range Type2").setValue(o.unit === "word" ? 2 : 1); } catch (e) {} // 1 chars, 2 words
    try { adv.property("ADBE Text Selector Shape").setValue(o.shape || 2); } catch (e) {} // 2 = ramp up
    var from = (o.from !== undefined) ? o.from : (prop === "opacity" ? 0 : prop === "scale" ? [0, 0, 100] : prop === "position" ? [0, 40, 0] : prop === "blur" ? [20, 20] : 60);
    var p = an.property("ADBE Text Animator Properties").addProperty(mn);
    p.setValue(from);
    var t0 = o.t || 0, dur = o.dur || 0.6;
    keys(sel.property("ADBE Text Percent Start"), [t0, t0 + dur], [0, 100], o.inf || "arrive");
    try { sel.property("ADBE Text Percent End").setValue(100); } catch (e) {}
    return an;
  }

  // ---------- graphs, seams, fast-paced kit, templates ----------
  /* One line per key: time, value, in/out speed/influence, LINEAR/HOLD flags — read a graph without the UI. */
  function graph(prop) {
    var out = [];
    for (var k = 1; k <= prop.numKeys; k++) {
      var s = "k" + k + " " + prop.keyTime(k).toFixed(2) + "s";
      try {
        var v = numArr(prop.keyValue(k));
        if (v) { var vs = []; for (var i = 0; i < v.length; i++) vs.push(Math.round(v[i] * 10) / 10); s += " v=" + vs.join(","); }
      } catch (e) {}
      try {
        var ie = prop.keyInTemporalEase(k)[0], oe = prop.keyOutTemporalEase(k)[0];
        s += " in " + Math.round(ie.speed) + "/" + Math.round(ie.influence) + " out " + Math.round(oe.speed) + "/" + Math.round(oe.influence);
      } catch (e2) {}
      try {
        var ti = prop.keyOutInterpolationType(k);
        if (ti === KeyframeInterpolationType.LINEAR) s += " LINEAR"; else if (ti === KeyframeInterpolationType.HOLD) s += " HOLD";
      } catch (e3) {}
      out.push(s);
    }
    return out.join("\n");
  }

  /* Audit every animated numeric property (all layers, or the given ones): dead stops inside one-way
   * moves and linear segments. Returns text; no render needed. */
  function graphCheck(layers) {
    var c = comp(), list = [], issues = [], i;
    if (layers) { for (i = 0; i < layers.length; i++) list.push(L(layers[i])); }
    else { for (i = 1; i <= c.numLayers; i++) list.push(c.layer(i)); }
    var LIN = KeyframeInterpolationType.LINEAR, BEZ = KeyframeInterpolationType.BEZIER;
    function check(l, p) {
      var pvt, sp = false;
      try { pvt = p.propertyValueType; sp = p.isSpatial; } catch (e) { return; }
      if (!(sp || pvt === PropertyValueType.OneD || pvt === PropertyValueType.TwoD || pvt === PropertyValueType.ThreeD)) return;
      var nm = l.name + " > " + p.name, n = p.numKeys, lin = 0, k, d;
      for (k = 1; k < n; k++) { try { if (p.keyOutInterpolationType(k) === LIN && p.keyInInterpolationType(k + 1) === LIN) lin++; } catch (e1) {} }
      if (lin) issues.push(nm + ": " + lin + " linear segment(s) — right only for typing/scroll/dash/orbit/time-remap");
      for (k = 2; k < n; k++) {
        try {
          var a = numArr(p.keyValue(k - 1)), b = numArr(p.keyValue(k)), cc = numArr(p.keyValue(k + 1));
          if (!a || !b || !cc || p.keyOutInterpolationType(k) !== BEZ) continue;
          var through = false, dot = 0;
          for (d = 0; d < b.length; d++) { var m = (b[d] - a[d]) * (cc[d] - b[d]); dot += m; if (!sp && m > 0) through = true; }
          if (sp) through = dot > 0;
          if (!through) continue;
          var ie = p.keyInTemporalEase(k), oe = p.keyOutTemporalEase(k), stopped = true;
          for (d = 0; d < ie.length; d++) if (Math.abs(ie[d].speed) > 0.001 || Math.abs(oe[d].speed) > 0.001) stopped = false;
          if (stopped) issues.push(nm + " k" + k + " @" + p.keyTime(k).toFixed(2) + "s: dead stop inside a one-way move — AE.ease(prop,\"<preset>\") carries speed through");
        } catch (e2) {}
      }
    }
    function walk(l, g) {
      for (var q = 1; q <= g.numProperties; q++) {
        var p = null;
        try { p = g.property(q); } catch (e) {}
        if (!p) continue;
        try {
          if (p.propertyType === PropertyType.PROPERTY) { if (p.numKeys >= 2) check(l, p); }
          else walk(l, p);
        } catch (e2) {}
      }
    }
    for (i = 0; i < list.length; i++) walk(list[i], list[i]);
    return issues.length ? issues.slice(0, 40).join("\n") + (issues.length > 40 ? "\n… " + (issues.length - 40) + " more" : "") : "graphs clean (" + list.length + " layers)";
  }

  /* Flash-cut: a warm-white bloom that peaks just before the cut at t and hides it (frames total, peak %). */
  function flash(t, o) {
    o = o || {};
    var c = comp(), fd = c.frameDuration, D = (o.frames || 10) * fd;
    var s = solid({ color: o.color || "#fff8eb", name: o.name || "FLASH" });
    keys(s.transform.opacity, [t - D * 0.5, t - D * 0.1, t + D * 0.5], [0, o.peak || 85, 0], "swift");
    try { s.inPoint = Math.max(0, t - D * 0.5 - fd); s.outPoint = Math.min(c.duration, t + D * 0.5 + fd); } catch (e) {}
    try { s.moveToBeginning(); } catch (e2) {}
    return s;
  }

  /* Impact shake: one SHAKE null parents the scene; each impact is a marker on it; the offset decays
   * exponentially. Sliders Amplitude (px) / Decay (f) / Frequency (Hz) retune every impact at once. */
  function shake(times, o) {
    o = o || {};
    var c = comp(), n = find(o.name || "SHAKE"), i;
    if (!n) {
      var targets = [];
      for (i = 1; i <= c.numLayers; i++) { var li = c.layer(i); if (!li.parent) targets.push(li); }
      n = rig(targets, o.name || "SHAKE");
      control(n, "slider", "Amplitude").setValue(o.amp || 14);
      control(n, "slider", "Decay (f)").setValue(o.decay || 4);
      control(n, "slider", "Frequency").setValue(o.freq || 14);
      n.transform.position.expression =
        'var a=effect("Amplitude")(1),d=Math.max(1,effect("Decay (f)")(1))*thisComp.frameDuration,f=effect("Frequency")(1),x=0,y=0;' +
        'for(var i=1;i<=marker.numKeys;i++){var t=time-marker.key(i).time;if(t>=0&&t<d*8){var k=a*Math.exp(-t/d);' +
        'x+=k*Math.sin(t*f*6.2832+i*1.7);y+=k*Math.cos(t*f*5.3+i*2.9);}}' +
        'value.length>2?[value[0]+x,value[1]+y,value[2]]:[value[0]+x,value[1]+y];';
    }
    times = times || [];
    for (i = 0; i < times.length; i++) marker(times[i], "impact", { layer: n });
    return n;
  }

  /* Smear multiples: crisp, countable ghosts of a fast move (copies sample the original gap frames back);
   * ghost opacity is gated by speed (min..full px/frame) so slow moves show none. Turns motion blur off on it. */
  function smear(x, o) {
    o = o || {};
    var l = L(x), fd = comp().frameDuration, cnt = o.copies || 4, gap = (o.gap || 2) * fd;
    var ops = o.opacities || [45, 30, 18, 9], lo = o.min || 25, hi = o.full || 60, made = [];
    var ref = 'thisComp.layer("' + l.name.replace(/"/g, '\\"') + '")';
    for (var k = 1; k <= cnt; k++) {
      var dup = l.duplicate(), off = (k * gap).toFixed(4), tr = dup.transform;
      dup.name = l.name + " smear " + k;
      try { tr.position.expression = ref + ".transform.position.valueAtTime(time-" + off + ")"; }
      catch (e) {
        try { tr.property("ADBE Position_0").expression = ref + ".transform.xPosition.valueAtTime(time-" + off + ")"; } catch (e1) {}
        try { tr.property("ADBE Position_1").expression = ref + ".transform.yPosition.valueAtTime(time-" + off + ")"; } catch (e2) {}
      }
      try { tr.scale.expression = ref + ".transform.scale.valueAtTime(time-" + off + ")"; } catch (e3) {}
      try { tr.rotation.expression = ref + ".transform.rotation.valueAtTime(time-" + off + ")"; } catch (e4) {}
      try { tr.anchorPoint.expression = ref + ".transform.anchorPoint.valueAtTime(time-" + off + ")"; } catch (e5) {}
      tr.opacity.expression = "var L=" + ref + ",v=length(L.transform.position.velocityAtTime(time-" + off + "))*thisComp.frameDuration;" +
        "linear(v," + lo + "," + hi + ",0," + (ops[k - 1] || 8) + ")*L.transform.opacity.value/100;";
      dup.motionBlur = false;
      try { dup.moveAfter(k === 1 ? l : made[made.length - 1]); } catch (e6) {}
      made.push(dup);
    }
    l.motionBlur = false;
    return made;
  }

  /* Speed ramp / freeze via Time Remap on a precomp or footage layer. pts = [[compTime, sourceTime], ...].
   * Equal source times = a freeze (clean stop, no drift). Speed is continuous elsewhere (blend = influence). */
  function ramp(x, pts, o) {
    o = o || {};
    var l = L(x), i, k;
    if (!l.canSetTimeRemapEnabled) throw new Error("ramp: layer must be a precomp or footage layer");
    l.timeRemapEnabled = true;
    var tr = l.property("ADBE Time Remapping");
    for (i = 0; i < pts.length; i++) tr.setValueAtTime(pts[i][0], pts[i][1]);
    for (k = tr.numKeys; k >= 1 && tr.numKeys > 1; k--) { // never delete the last key (disables Time Remap)
      var tk = tr.keyTime(k), ours = false;
      for (i = 0; i < pts.length; i++) if (Math.abs(pts[i][0] - tk) < 0.0005) ours = true;
      if (!ours) tr.removeKey(k);
    }
    var n = tr.numKeys, BEZ = KeyframeInterpolationType.BEZIER;
    for (k = 1; k <= n; k++) {
      var sIn = k > 1 ? (tr.keyValue(k) - tr.keyValue(k - 1)) / (tr.keyTime(k) - tr.keyTime(k - 1)) : null;
      var sOut = k < n ? (tr.keyValue(k + 1) - tr.keyValue(k)) / (tr.keyTime(k + 1) - tr.keyTime(k)) : null;
      if (sIn === null) sIn = sOut;
      if (sOut === null) sOut = sIn;
      var sp = (Math.abs(sIn) < 0.0001 || Math.abs(sOut) < 0.0001) ? 0 : (sIn + sOut) / 2;
      var inf = sp ? (o.blend || 33) : 8;
      try { tr.setInterpolationTypeAtKey(k, BEZ, BEZ); tr.setTemporalEaseAtKey(k, [new KeyframeEase(sp, inf)], [new KeyframeEase(sp, inf)]); } catch (e) {}
    }
    var last = pts[pts.length - 1][0];
    try { if (l.outPoint < last) l.outPoint = last; } catch (e2) {}
    l.motionBlur = true;
    return tr;
  }

  /* Beat grid: returns every beat time for the comp; comp markers on each bar (o.every beats) or on all beats. */
  function beats(bpm, o) {
    o = o || {};
    var c = comp(), b = 60 / (bpm || 120), t0 = o.offset || 0, every = o.every || 4, out = [];
    for (var i = 0; t0 + i * b < c.duration - 0.001; i++) {
      var t = t0 + i * b;
      out.push(Math.round(t * 1000) / 1000);
      if (o.mark !== false && (o.all || i % every === 0)) marker(t, i % every === 0 ? "bar " + (i / every + 1) : "b" + i);
    }
    return out;
  }

  /* Iris match-cut: sceneLayer is revealed by a circle growing from center (the SAME centre as the
   * round element in both scenes) until it covers the frame. Returns the circle (the matte). */
  function iris(scene, o) {
    o = o || {};
    var c = comp(), ctr = o.center || center(), t = o.t || 0, dur = o.dur || 1.5, r0 = o.from || 22, far = 0;
    var corners = [[0, 0], [c.width, 0], [0, c.height], [c.width, c.height]];
    for (var i = 0; i < 4; i++) { var dx = corners[i][0] - ctr[0], dy = corners[i][1] - ctr[1]; far = Math.max(far, Math.sqrt(dx * dx + dy * dy)); }
    var m = ellipse({ w: r0 * 2, h: r0 * 2, fill: "#ffffff", pos: ctr, name: o.name || "IRIS" });
    sizeKeys(m, [t, t + dur], [[r0 * 2, r0 * 2], [far * 2 + 8, far * 2 + 8]], o.ease || "whip");
    matte(scene, m, "alpha");
    return m;
  }

  /* Essential Graphics: expose a property (a CTRL slider/colour/checkbox, a Source Text) under a label. */
  function expose(prop, label, o) {
    o = o || {};
    var c = o.comp || comp();
    if (o.template) { try { c.motionGraphicsTemplateName = o.template; } catch (e) {} }
    try { if (prop.canAddToMotionGraphicsTemplate && !prop.canAddToMotionGraphicsTemplate(c)) return false; } catch (e1) {}
    try { return prop.addToMotionGraphicsTemplateAs(c, label || prop.name); }
    catch (e2) { try { return prop.addToMotionGraphicsTemplate(c); } catch (e3) { return false; } }
  }


  // ---------- 3D (Advanced 3D renderer, cameras, lights, meshes, models, materials) ----------
  // ES3 only. Properties are found by matchName first, then by display name, so the helpers
  // keep working when After Effects renames or adds properties between versions.
  function aeVer() { var v = parseFloat(app.version); return isNaN(v) ? 0 : v; }
  function lc(s) { return String(s).toLowerCase(); }
  function inList(arr, s) { for (var i = 0; i < arr.length; i++) if (arr[i] === s) return true; return false; }
  function findNamed(root, wants) {
    try {
      if (root.propertyType === PropertyType.PROPERTY) return inList(wants, lc(root.name)) ? root : null;
      for (var i = 1; i <= root.numProperties; i++) {
        var p = root.property(i);
        if (p.propertyType === PropertyType.PROPERTY && inList(wants, lc(p.name))) return p;
      }
      for (var j = 1; j <= root.numProperties; j++) {
        var r = findNamed(root.property(j), wants);
        if (r) return r;
      }
    } catch (e) {}
    return null;
  }
  function findAny(root, keys) {
    if (!(keys instanceof Array)) keys = [keys];
    for (var k = 0; k < keys.length; k++) { var r = findProp(root, keys[k]); if (r) return r; }
    var wants = [];
    for (var w = 0; w < keys.length; w++) wants.push(lc(keys[w]));
    return findNamed(root, wants);
  }
  /* Set one property anywhere under a layer by matchName or display name. Returns true/false. */
  function setProp(x, keys, value) {
    var p = findAny(L(x), keys);
    if (!p) return false;
    try { p.setValue(typeof value === "string" && /^#/.test(value) ? rgb(value) : value); return true; } catch (e) { return false; }
  }
  function setMany(l, map, table, report) {
    for (var k in map) {
      if (!map.hasOwnProperty(k) || map[k] === undefined || map[k] === null) continue;
      var keys = table[k] || [k];
      report.push(k + (setProp(l, keys, map[k]) ? "" : " (not found)"));
    }
  }

  /* Switch the active comp to a real 3D renderer: "advanced" (default — Advanced 3D, AE 24+),
   * "cinema4d", "classic". Returns the renderer name that is now active. */
  function renderer3D(which) {
    var c = comp(), list = c.renderers, want = lc(which || "advanced"), pick = "";
    var pats = want === "classic" ? [/standard|classic/i] : want === "cinema4d" ? [/ernst|cinema/i] : [/advanced/i, /ernst|cinema/i];
    for (var p = 0; p < pats.length && !pick; p++)
      for (var i = 0; i < list.length; i++) if (pats[p].test(list[i])) { pick = list[i]; break; }
    if (!pick) for (var j = 0; j < list.length; j++) if (lc(list[j]) === want) pick = list[j];
    if (!pick) throw new Error("No matching 3D renderer. Available: " + list.join(", "));
    c.renderer = pick;
    return pick;
  }

  var CAM = {
    zoom: ["ADBE Camera Zoom", "Zoom"], dof: ["ADBE Camera Depth of Field", "Depth of Field"],
    focus: ["ADBE Camera Focus Distance", "Focus Distance"], aperture: ["ADBE Camera Aperture", "Aperture"],
    blur: ["ADBE Camera Blur Level", "Blur Level"], focusArea: ["Focus Area Width", "FocusAreaWidth"],
    nearFarBlur: ["Near Far Blur Multiplier", "NearFarBlurMultiplier", "Near/Far Blur Multiplier"]
  };
  /* Real 3D camera. o: {name, position:[x,y,z], target:[x,y,z], zoom, dof:true, focus, aperture, blur,
   * focusArea, nearFarBlur, oneNode:true}. Returns the camera layer. */
  function camera3D(o) {
    o = o || {};
    var c = comp(), cam = c.layers.addCamera(o.name || "Camera", [c.width / 2, c.height / 2]);
    if (o.oneNode) try { cam.autoOrient = AutoOrientType.NO_AUTO_ORIENT; } catch (e) {}
    if (o.position) cam.transform.position.setValue(o.position);
    if (o.target && !o.oneNode) cam.transform.pointOfInterest.setValue(o.target);
    var r = [], opts = {};
    for (var k in CAM) if (CAM.hasOwnProperty(k) && o[k] !== undefined) opts[k] = (k === "dof") ? (o[k] ? 1 : 0) : o[k];
    setMany(cam, opts, CAM, r);
    return cam;
  }

  var LIGHT = {
    intensity: ["ADBE Light Intensity", "Intensity"], color: ["ADBE Light Color", "Color"],
    cone: ["ADBE Light Cone Angle", "Cone Angle"], feather: ["ADBE Light Cone Feather 2", "Cone Feather"],
    shadows: ["ADBE Light Casts Shadows", "ADBE Casts Shadows", "Casts Shadows"],
    shadowDarkness: ["ADBE Light Shadow Darkness", "Shadow Darkness"],
    shadowDiffusion: ["ADBE Light Shadow Diffusion", "Shadow Diffusion"],
    falloff: ["ADBE Light Falloff Type", "Falloff"], radius: ["ADBE Light Falloff Start", "Radius"],
    falloffDistance: ["ADBE Light Falloff Distance", "Falloff Distance"]
  };
  /* type: "point" | "spot" | "parallel" | "ambient" | "environment".
   * o: {name, position, target, intensity (%), color "#hex", cone, feather, shadows:true,
   *     shadowDarkness, shadowDiffusion, source (environment: layer or name)}. */
  function light3D(type, o) {
    o = o || {};
    var c = comp(), t = String(type || "point").toUpperCase();
    if (t === "ENVIRONMENT" && (typeof LightType.ENVIRONMENT === "undefined"))
      throw new Error("Environment lights need After Effects 24.3+ with the Advanced 3D renderer.");
    if (LightType[t] === undefined) throw new Error("Unknown light type " + type + " (point, spot, parallel, ambient, environment).");
    var l = c.layers.addLight(o.name || (t.charAt(0) + t.substring(1).toLowerCase() + " Light"), [c.width / 2, c.height / 2]);
    l.lightType = LightType[t];
    if (o.position) try { l.transform.position.setValue(o.position); } catch (e) {}
    if (o.target) try { l.transform.pointOfInterest.setValue(o.target); } catch (e2) {}
    if (t === "ENVIRONMENT" && o.source) l.lightSource = L(o.source);
    var opts = {}, r = [];
    for (var k in LIGHT) if (LIGHT.hasOwnProperty(k) && o[k] !== undefined) opts[k] = (k === "shadows") ? (o[k] ? 1 : 0) : o[k];
    setMany(l, opts, LIGHT, r);
    return l;
  }
  /* Image-based lighting from any 2D layer / precomp / HDRI in the comp (25.2+; 24.3: HDR/EXR only).
   * The source layer is usually hidden (its pixels light the scene). */
  function envLight(source, o) {
    o = o || {};
    o.source = source;
    renderer3D("advanced");
    var l = light3D("environment", o);
    if (o.hideSource !== false) try { L(source).enabled = false; } catch (e) {}
    return l;
  }

  var MESH_SIZE = ["width", "height", "depth", "radius", "sides", "sliceCaps", "sliceStart", "sliceEnd", "smoothingAngle",
    "ringRadius", "pipeRadius", "ringSides", "pipeSides", "caps", "topRadius", "bottomRadius", "segments", "heightSegments"];
  /* Native parametric 3D mesh (AE 26.3+): type "cube" | "sphere" | "cylinder" | "cone" | "torus" | "plane".
   * o: {name, position:[x,y,z], size:{width,height,depth,radius,…}, bevel:{radius,sides,…}, material:{…}}. */
  function mesh(type, o) {
    o = o || {};
    if (typeof ParametricMeshType === "undefined")
      throw new Error("Parametric meshes need After Effects 26.3+. Use AE.make3D(shapeOrText,{depth}) for extruded geometry instead.");
    var t = String(type || "cube").toUpperCase();
    if (ParametricMeshType[t] === undefined) throw new Error("Unknown mesh type " + type + " (cube, sphere, cylinder, cone, torus, plane).");
    renderer3D("advanced");
    var c = comp(), l = c.layers.addParametricMesh(o.name || (t.charAt(0) + t.substring(1).toLowerCase()), ParametricMeshType[t]);
    if (o.position) try { l.transform.position.setValue(o.position); } catch (e) {}
    function apply(attr, vals) {
      if (!vals) return;
      try {
        var cur = l[attr];
        for (var k in vals) if (vals.hasOwnProperty(k)) cur[k] = vals[k];
        l[attr] = cur;
      } catch (e2) { throw new Error("Could not set " + attr + ": " + e2.toString() + " (valid keys include " + MESH_SIZE.join(", ") + ")"); }
    }
    apply("parametricMeshOptions", o.size);
    apply("parametricBevelOptions", o.bevel);
    if (o.material) material(l, o.material);
    return l;
  }

  /* Import a 3D model (glTF / GLB / OBJ, AE 24.4+) and place it in the active comp. o: {name, position, scale, place:false} */
  function model3D(file, o) {
    o = o || {};
    if (typeof ThreeDModelLayer === "undefined") throw new Error("3D model import needs After Effects 24.4+ (Advanced 3D).");
    var f = new File(file);
    if (!f.exists) throw new Error("No such file: " + file);
    renderer3D("advanced");
    var it = app.project.importFile(new ImportOptions(f));
    if (o.place === false) return it;
    var l = comp().layers.add(it);
    if (o.name) l.name = o.name;
    if (o.position) try { l.transform.position.setValue(o.position); } catch (e) {}
    if (o.scale !== undefined) try { var s = o.scale; l.transform.scale.setValue(s instanceof Array ? s : [s, s, s]); } catch (e2) {}
    return l;
  }

  var MAT = {
    castsShadows: ["ADBE Casts Shadows", "Casts Shadows"], acceptsShadows: ["ADBE Accept Shadows", "Accepts Shadows"],
    acceptsLights: ["ADBE Accept Lights", "Accepts Lights"], ambient: ["ADBE Ambient Coefficient", "Ambient"],
    diffuse: ["ADBE Diffuse Coefficient", "Diffuse"], specular: ["ADBE Specular Coefficient", "Specular Intensity"],
    shininess: ["ADBE Shininess Coefficient", "Specular Shininess"], metal: ["ADBE Metal Coefficient", "Metal"],
    reflection: ["ADBE Reflection Coefficient", "Reflection Intensity"], glossiness: ["ADBE Glossiness Coefficient", "Reflection Sharpness"],
    lightTransmission: ["ADBE Light Transmission", "Light Transmission"], transparency: ["ADBE Transparency Coefficient", "Transparency"],
    refraction: ["ADBE Index of Refraction", "Index of Refraction"]
  };
  /* Material Options on a 3D layer. o: {castsShadows:true|false|"only", acceptsShadows, acceptsLights,
   * ambient, diffuse, specular, shininess, metal, reflection, glossiness, transparency, …} plus any other
   * property by name (e.g. a 27.0 material control you found with inspect_properties).
   * Returns a short report of what was set / not found. */
  function material(x, o) {
    var l = L(x), r = [], map = {};
    try { if (!l.threeDLayer) l.threeDLayer = true; } catch (e) {}
    for (var k in o) {
      if (!o.hasOwnProperty(k)) continue;
      var v = o[k];
      if (k === "castsShadows") v = (v === "only") ? 3 : (v ? 2 : 1);
      else if (k === "acceptsShadows" || k === "acceptsLights") v = v ? 2 : 1;
      map[k] = v;
    }
    setMany(l, map, MAT, r);
    return "material: " + r.join(", ");
  }

  var GEO = {
    depth: ["ADBE Extrsn Depth", "Extrusion Depth"], bevel: ["ADBE Bevel Styles", "Bevel Style"],
    bevelDepth: ["ADBE Bevel Depth", "Bevel Depth"], holeBevel: ["ADBE Hole Bevel Depth", "Hole Bevel Depth"],
    curvature: ["ADBE Plane Curvature", "Curvature"], segments: ["ADBE Plane Subdivision", "Segments"]
  };
  var BEVEL = { none: 1, angular: 2, concave: 3, convex: 4 };
  /* Make a layer 3D. For text/shape layers o.depth extrudes it (switches to Advanced 3D):
   * o: {depth, bevel:"angular"|"concave"|"convex", bevelDepth, holeBevel, material:{…}}. */
  function make3D(x, o) {
    o = o || {};
    var l = L(x);
    l.threeDLayer = true;
    var r = [];
    if (o.depth !== undefined || o.bevel || o.bevelDepth !== undefined) {
      renderer3D("advanced");
      var map = { depth: o.depth, bevelDepth: o.bevelDepth, holeBevel: o.holeBevel, curvature: o.curvature, segments: o.segments };
      if (o.bevel) map.bevel = BEVEL[lc(o.bevel)] || o.bevel;
      setMany(l, map, GEO, r);
    }
    if (o.material) material(l, o.material);
    return l;
  }

  /* Orbit / turntable: a 3D null at the target carries the camera. Returns {cam, rig}.
   * o: {target:[x,y,z], distance, t0, t1, degrees (default 360), axis "y"|"x", curve, tilt, zoom, dof…}. */
  function orbit(o) {
    o = o || {};
    var c = comp(), tgt = o.target || [c.width / 2, c.height / 2, 0], dist = o.distance || 1500;
    var rig = c.layers.addNull(); rig.name = o.name ? o.name + " Rig" : "Orbit Rig"; rig.threeDLayer = true;
    rig.transform.position.setValue(tgt);
    var cam = camera3D({ name: o.name || "Orbit Camera", position: [tgt[0], tgt[1], tgt[2] - dist], target: tgt,
      zoom: o.zoom, dof: o.dof, focus: o.focus || dist, aperture: o.aperture, blur: o.blur });
    cam.parent = rig;
    if (o.tilt) rig.transform.xRotation.setValue(o.tilt);
    var axis = lc(o.axis || "y") === "x" ? rig.transform.xRotation : rig.transform.yRotation;
    var t0 = o.t0 === undefined ? 0 : o.t0, t1 = o.t1 === undefined ? c.duration : o.t1;
    keys(axis, [t0, t1], [0, o.degrees === undefined ? 360 : o.degrees]);
    try { curve(axis, o.curve || "soft"); } catch (e) {}
    return { cam: cam, rig: rig };
  }

  function caps() { return $._motionPilot.caps(); }
  function props(x, path, depth) { var l = L(x); return $._motionPilot.inspect(l.index, "", path || "", depth || 3); }
  function effectsList(q) { return $._motionPilot.effectsList(q || "", 120); }

  return {
    renderer3D: renderer3D, camera3D: camera3D, light3D: light3D, envLight: envLight, mesh: mesh,
    model3D: model3D, material: material, make3D: make3D, orbit: orbit, setProp: setProp,
    caps: caps, props: props, effectsList: effectsList, aeVer: aeVer,
    curve: curve, graph: graph, graphCheck: graphCheck, flash: flash, shake: shake, smear: smear,
    ramp: ramp, beats: beats, iris: iris, expose: expose,
    rect: rect, ellipse: ellipse, path: pathLayer, line: line, text: text,
    solid: solid, nullObj: nullObj,
    find: find, centerAnchor: centerAnchor, anchorTo: anchorTo, parentTo: parentTo,
    center: center, hexRgb: rgb,
    keys: keys, ease: ease, expr: expr, pathProp: pathProp, pathKeys: pathKeys,
    fadeIn: fadeIn, fadeOut: fadeOut, pop: pop, slideIn: slideIn, staggerIn: staggerIn,
    bounce: bounce, idleWiggle: idleWiggle, alongPath: alongPath,
    trim: trim, drawOn: drawOn, wipeOff: wipeOff, dash: dash, repeater: repeater,
    wigglePath: wigglePath, zigzag: zigzag, roundCorners: roundCorners,
    offsetPath: offsetPath, taper: taper, burst: burst,
    typeOn: typeOn, gradient: gradient, shadow: shadow, glow: glow, blur: blur,
    grain: grain, fractal: fractal, texture: texture, turbulence: turbulence,
    posterize: posterize, tint: tint, vignette: vignette, fromBin: fromBin,
    importAsset: importAsset, keyOut: keyOut,
    fx: fx, fxProp: fxProp, fxSet: fxSet, adjust: adjust,
    precomp: precomp, rig: rig, cam: cam, parallax: parallax, loop: loop,
    trimLayer: trimLayer, splitLayer: splitLayer, reorder: reorder,
    workArea: workArea, dupComp: dupComp, removeFx: removeFx, marker: marker,
    mask: mask, textOnPath: textOnPath, textPathMargin: textPathMargin,
    styleText: styleText, control: control, link: link,
    sizeKeys: sizeKeys, countUp: countUp, stagger: stagger, cursor: cursor, click: click,
    matte: matte, textAnim: textAnim
  };
})();
$.global.AE.__mp = "motionpilot"; // build stamp checked by the panel
"loaded"
