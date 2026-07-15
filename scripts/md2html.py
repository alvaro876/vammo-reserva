# Converte um .md do projeto em HTML estilizado (mesmo design dos relatórios),
# pronto pra publicar como artifact. Uso: python md2html.py entrada.md saida.html
import re, sys, html

SRC = sys.argv[1]
OUT = sys.argv[2]

def inline(t):
    t = html.escape(t, quote=False)
    t = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", t)
    t = re.sub(r"(?<![\w*])\*([^*]+?)\*(?![\w*])", r"<i>\1</i>", t)
    t = re.sub(r"`([^`]+)`", r"<code>\1</code>", t)
    t = re.sub(r"\[(.+?)\]\((.+?)\)", r'<a href="\2">\1</a>', t)
    t = re.sub(r"(?<![\"'>])(https?://[^\s<)]+)", r'<a href="\1">\1</a>', t)
    return t

with open(SRC, encoding="utf-8") as f:
    lines = f.read().split("\n")

body, table, in_code, lista = [], [], False, False

def flush_table():
    global table
    if not table: return
    h = ["<div style='overflow-x:auto'><table>"]
    for i, row in enumerate(table):
        tag = "th" if i == 0 else "td"
        h.append("<tr>" + "".join(f"<{tag}>{inline(c)}</{tag}>" for c in row) + "</tr>")
    h.append("</table></div>")
    body.append("\n".join(h)); table = []

def flush_list():
    global lista
    if lista: body.append("</ul>"); lista = False

for ln in lines:
    s = ln.rstrip()
    if s.startswith("```"):
        in_code = not in_code
        body.append("<pre>" if in_code else "</pre>")
        continue
    if in_code:
        body.append(html.escape(s)); continue
    if s.startswith("|"):
        cells = [c.strip() for c in s.strip("|").split("|")]
        if not re.match(r"^\s*:?-{2,}", cells[0]): table.append(cells)
        continue
    flush_table()
    if not s.strip(): flush_list(); continue
    if s.startswith("- ") or s.startswith("• "):
        if not lista: body.append("<ul>"); lista = True
        body.append(f"<li>{inline(s[2:])}</li>"); continue
    flush_list()
    if s.startswith("> "): body.append(f"<blockquote>{inline(s[2:])}</blockquote>")
    elif s.startswith("### "): body.append(f"<h3>{inline(s[4:])}</h3>")
    elif s.startswith("## "): body.append(f"<h2>{inline(s[3:])}</h2>")
    elif s.startswith("# "): body.append(f"<h1>{inline(s[2:])}</h1>")
    elif s.startswith("---"): body.append("<hr>")
    elif re.match(r"^\d+\.\s", s): body.append(f"<p class='num'>{inline(s)}</p>")
    else: body.append(f"<p>{inline(s)}</p>")
flush_table(); flush_list()

titulo = next((l[2:] for l in lines if l.startswith("# ")), "RIVERS")

CSS = """
:root{--ink:#16232E;--paper:#F6F8FA;--card:#fff;--line:#E3E9EF;--muted:#5B6B7A;--blue:#185FA5;}
*{box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,sans-serif;color:var(--ink);background:var(--paper);margin:0;font-variant-numeric:tabular-nums;line-height:1.6}
.wrap{max-width:880px;margin:0 auto;padding:36px 22px 70px}
h1{font-size:25px;color:var(--blue);letter-spacing:-.015em;margin:26px 0 8px}
h2{font-size:18px;margin:28px 0 8px;letter-spacing:-.01em;border-bottom:2px solid var(--line);padding-bottom:6px}
h3{font-size:14.5px;color:var(--blue);margin:20px 0 6px}
p{font-size:14px;margin:8px 0;max-width:76ch}
p.num{margin:4px 0}
blockquote{border-left:3px solid var(--blue);margin:10px 0;padding:8px 14px;background:#EFF5FB;color:#1C3A57;font-size:13.5px;border-radius:0 8px 8px 0}
ul{margin:6px 0;padding-left:22px}
li{font-size:14px;margin:4px 0;max-width:74ch}
code{background:#EDF1F5;border-radius:4px;padding:1px 5px;font-size:12.5px;font-family:Consolas,monospace}
pre{background:#0F2438;color:#DCE8F2;border-radius:10px;padding:14px 16px;font-size:12.5px;overflow-x:auto;font-family:Consolas,monospace;line-height:1.5}
table{width:100%;border-collapse:collapse;font-size:13px;margin:10px 0}
th{background:var(--blue);color:#fff;text-align:left;padding:7px 10px;font-size:11.5px;text-transform:uppercase;letter-spacing:.05em}
td{padding:7px 10px;border-bottom:1px solid #F0F3F6;vertical-align:top}
tr:nth-child(even) td{background:#F7FAFC}
hr{border:none;border-top:1px solid var(--line);margin:22px 0}
a{color:var(--blue)}
@media(prefers-color-scheme:dark){
 :root{--ink:#E2E8F0;--paper:#0F1720;--card:#16202B;--line:#243140;--muted:#8DA0B0}
 blockquote{background:#152537;color:#B9D2E8}
 code{background:#1D2937;color:#C9DCEF}
 tr:nth-child(even) td{background:#141E29}
 td{border-color:#1D2937}
}
:root[data-theme="dark"]{--ink:#E2E8F0;--paper:#0F1720;--card:#16202B;--line:#243140;--muted:#8DA0B0}
:root[data-theme="light"]{--ink:#16232E;--paper:#F6F8FA;--card:#fff;--line:#E3E9EF;--muted:#5B6B7A}
"""

with open(OUT, "w", encoding="utf-8") as f:
    f.write(f"<title>{html.escape(titulo)}</title>\n<style>{CSS}</style>\n<div class='wrap'>\n")
    f.write("\n".join(body))
    f.write("\n</div>")
print("ok:", OUT)
