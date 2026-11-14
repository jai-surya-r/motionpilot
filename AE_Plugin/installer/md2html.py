"""Turn docs/GUIDE.md into a standalone, offline HTML page (no dependencies).

Supports the Markdown the guide uses: headings (with GitHub-style anchors), paragraphs,
bullet / numbered lists, tables, fenced code, inline code, bold, italic, links, rules.
Usage: python md2html.py GUIDE.md out.html
"""
import html
import re
import sys

CSS = """
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: radial-gradient(120% 60% at 50% 0%, #1d1d1d 0%, #111 60%, #0a0a0a 100%) fixed;
  color: #e6e6e6; font: 15px/1.65 "Segoe UI", system-ui, -apple-system, sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 48px 24px 96px; }
h1 { font-size: 34px; letter-spacing: -.5px; margin: 0 0 12px; color: #fff; }
h2 { font-size: 22px; margin: 48px 0 12px; padding-top: 12px; border-top: 1px solid #2c2c2c; color: #fff; }
h3 { font-size: 17px; margin: 28px 0 8px; color: #f2f2f2; }
p, li { color: #cfcfcf; }
a { color: #fff; text-decoration: underline; text-decoration-color: #666; text-underline-offset: 3px; }
a:hover { text-decoration-color: #fff; }
strong { color: #fff; }
code { font: 13px Consolas, "Cascadia Mono", monospace; background: #1f1f1f; border: 1px solid #2e2e2e;
  border-radius: 5px; padding: 1px 5px; color: #f0f0f0; }
pre { background: linear-gradient(180deg, #1b1b1b, #151515); border: 1px solid #2e2e2e; border-radius: 10px;
  padding: 14px 16px; overflow-x: auto; }
pre code { background: none; border: 0; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 12px 0 20px; font-size: 14px; }
th, td { text-align: left; vertical-align: top; padding: 8px 10px; border-bottom: 1px solid #2a2a2a; }
th { color: #fff; font-weight: 600; border-bottom: 1px solid #444; }
td:first-child { white-space: nowrap; color: #f2f2f2; }
hr { border: 0; border-top: 1px solid #2c2c2c; margin: 32px 0; }
ul, ol { padding-left: 22px; }
"""


def slug(text):
    t = re.sub(r"<[^>]+>", "", text).strip().lower()
    t = re.sub(r"[^\w\- ]", "", t)
    return t.replace(" ", "-")


def inline(t):
    codes = []
    t = re.sub(r"`([^`]+)`", lambda m: codes.append(m.group(1)) or "\x00%d\x00" % (len(codes) - 1), t)
    t = html.escape(t, quote=False)
    t = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', t)
    t = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", t)
    t = re.sub(r"(?<![\w*])\*([^*]+)\*(?![\w*])", r"<em>\1</em>", t)
    return re.sub(r"\x00(\d+)\x00", lambda m: "<code>" + html.escape(codes[int(m.group(1))], quote=False) + "</code>", t)


def convert(md):
    out, lines, i = [], md.splitlines(), 0
    title = "User Guide"
    while i < len(lines):
        ln = lines[i]
        if ln.startswith("```"):
            buf = []
            i += 1
            while i < len(lines) and not lines[i].startswith("```"):
                buf.append(lines[i])
                i += 1
            out.append("<pre><code>" + html.escape("\n".join(buf), quote=False) + "</code></pre>")
            i += 1
            continue
        m = re.match(r"^(#{1,6})\s+(.*)$", ln)
        if m:
            lvl, txt = len(m.group(1)), m.group(2)
            if lvl == 1:
                title = re.sub(r"[*`]", "", txt)
            out.append('<h%d id="%s">%s</h%d>' % (lvl, slug(txt), inline(txt), lvl))
            i += 1
            continue
        if re.match(r"^\s*---+\s*$", ln):
            out.append("<hr>")
            i += 1
            continue
        if ln.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            head, body = rows[0], [r for r in rows[1:] if not all(re.match(r"^:?-+:?$", c or "-") for c in r)]
            t = ["<table>"]
            if any(head):
                t.append("<tr>" + "".join("<th>%s</th>" % inline(c) for c in head) + "</tr>")
            for r in body:
                t.append("<tr>" + "".join("<td>%s</td>" % inline(c) for c in r) + "</tr>")
            out.append("".join(t) + "</table>")
            continue
        m = re.match(r"^(\s*)([-*]|\d+\.)\s+(.*)$", ln)
        if m:
            tag = "ol" if m.group(2)[0].isdigit() else "ul"
            items = []
            while i < len(lines):
                mm = re.match(r"^\s*([-*]|\d+\.)\s+(.*)$", lines[i])
                if mm:
                    items.append(mm.group(2))
                elif lines[i].startswith("   ") and items and lines[i].strip():
                    items[-1] += " " + lines[i].strip()
                else:
                    break
                i += 1
            out.append("<%s>%s</%s>" % (tag, "".join("<li>%s</li>" % inline(x) for x in items), tag))
            continue
        if not ln.strip():
            i += 1
            continue
        buf = []
        while i < len(lines) and lines[i].strip() and not re.match(r"^(#|```|\||\s*([-*]|\d+\.)\s|\s*---)", lines[i]):
            buf.append(lines[i].strip())
            i += 1
        out.append("<p>%s</p>" % inline(" ".join(buf)))
    return title, "\n".join(out)


def main():
    src, dst = sys.argv[1], sys.argv[2]
    title, body = convert(open(src, encoding="utf-8").read())
    page = ('<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1">'
            "<title>%s</title><style>%s</style></head><body><main>\n%s\n</main></body></html>\n") % (
        html.escape(title), CSS, body)
    open(dst, "w", encoding="utf-8").write(page)


if __name__ == "__main__":
    main()
