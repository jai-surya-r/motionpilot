/* MotionPilot tooltips: one styled tooltip for the whole panel, replacing the
 * browser's native title popup. Any element's `title` is moved to `data-tip-long`
 * on first hover, so the native popup never appears (titles that main.js sets
 * later are picked up the same way). A short `data-tip` label wins over the
 * long title. */
(function () {
  var tip = document.createElement("div");
  tip.id = "mpTip";
  document.body.appendChild(tip);
  var cur = null, timer = null;

  function take(el) {
    var t = el.getAttribute("title");
    if (t !== null) { el.setAttribute("data-tip-long", t); el.removeAttribute("title"); }
  }
  function textFor(el) { return el.getAttribute("data-tip") || el.getAttribute("data-tip-long") || ""; }
  function target(node) {
    while (node && node.nodeType === 1) {
      if (node.hasAttribute("title") || node.hasAttribute("data-tip") || node.hasAttribute("data-tip-long")) return node;
      node = node.parentNode;
    }
    return null;
  }
  function hide() {
    clearTimeout(timer);
    cur = null;
    tip.className = "";
  }
  function place(el, cls) {
    var r = el.getBoundingClientRect();
    var w = window.innerWidth, h = window.innerHeight;
    tip.style.left = "0px"; tip.style.top = "0px";
    tip.className = "measure" + cls;
    var tw = tip.offsetWidth, th = tip.offsetHeight;
    var left = Math.round(r.left + r.width / 2 - tw / 2);
    left = Math.max(6, Math.min(left, w - tw - 6));
    var top = r.bottom + 7;
    if (top + th > h - 6) top = Math.max(6, r.top - th - 7); // no room below: show above
    tip.style.left = left + "px";
    tip.style.top = Math.round(top) + "px";
    tip.className = "show" + cls;
  }
  document.addEventListener("mouseover", function (ev) {
    var el = target(ev.target);
    if (el) take(el);
    if (el === cur) return;
    hide();
    if (!el) return;
    var txt = textFor(el);
    if (!txt) return;
    cur = el;
    timer = setTimeout(function () {
      if (cur !== el || !document.body.contains(el)) return;
      take(el); // pick up a title set while hovering
      tip.textContent = textFor(el);
      place(el, el.getAttribute("data-tip") ? "" : " long");
    }, 350);
  }, true);
  document.addEventListener("mouseout", function (ev) {
    if (cur && (!ev.relatedTarget || !cur.contains(ev.relatedTarget))) hide();
  }, true);
  document.addEventListener("mousedown", hide, true);
  document.addEventListener("wheel", hide, true);
  document.addEventListener("keydown", hide, true);
  window.addEventListener("blur", hide);
})();
