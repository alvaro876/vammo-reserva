# Converte docs/PREP-CALL-TEC-DATA.md num PDF bem formatado (reportlab).
# Suporta: h1/h2/h3, negrito/itálico inline, bullets, citações, tabelas, divisores.
import re, os
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table,
                                TableStyle, HRFlowable, KeepTogether)
from reportlab.lib.enums import TA_LEFT

import sys
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "docs", "PREP-CALL-TEC-DATA.md")
OUT = sys.argv[2] if len(sys.argv) > 2 else SRC.replace(".md", ".pdf")

INK = colors.HexColor("#16232E")
BLUE = colors.HexColor("#185FA5")
MUT = colors.HexColor("#5B6B7A")
LINE = colors.HexColor("#D8E0E8")
BGROW = colors.HexColor("#F2F6FA")

styles = getSampleStyleSheet()
st_h1 = ParagraphStyle("h1", parent=styles["Heading1"], fontName="Helvetica-Bold",
                       fontSize=17, leading=21, textColor=BLUE, spaceBefore=16, spaceAfter=8)
st_h2 = ParagraphStyle("h2", parent=styles["Heading2"], fontName="Helvetica-Bold",
                       fontSize=13.5, leading=17, textColor=INK, spaceBefore=12, spaceAfter=5)
st_h3 = ParagraphStyle("h3", parent=styles["Heading3"], fontName="Helvetica-Bold",
                       fontSize=11.5, leading=15, textColor=BLUE, spaceBefore=10, spaceAfter=4)
st_p = ParagraphStyle("p", parent=styles["Normal"], fontName="Helvetica",
                      fontSize=10, leading=14.5, textColor=INK, spaceAfter=6, alignment=TA_LEFT)
st_q = ParagraphStyle("q", parent=st_p, leftIndent=10, textColor=MUT,
                      borderPadding=4, spaceAfter=8)
st_li = ParagraphStyle("li", parent=st_p, leftIndent=14, bulletIndent=4, spaceAfter=3)
st_cell = ParagraphStyle("cell", parent=st_p, fontSize=9, leading=12, spaceAfter=0)
st_cellh = ParagraphStyle("cellh", parent=st_cell, fontName="Helvetica-Bold", textColor=colors.white)

EMOJI = re.compile(
    "[" "\U0001F300-\U0001FAFF" "\U00002600-\U000027BF" "\U0001F000-\U0001F02F"
    "\U00002190-\U000021FF" "\U00002B00-\U00002BFF" "️" "⃣" "]+", flags=re.UNICODE)

def inline(t):
    t = EMOJI.sub("", t)
    t = t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    t = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", t)
    t = re.sub(r"(?<!\w)\*(.+?)\*(?!\w)", r"<i>\1</i>", t)
    t = re.sub(r"`([^`]+)`", r"<font face='Courier' size='9'>\1</font>", t)
    t = re.sub(r"\[(.+?)\]\((.+?)\)", r"<u><font color='#185FA5'>\1</font></u>", t)
    return t.strip()

def table_flow(rows):
    ncols = max(len(r) for r in rows)
    data = []
    for i, r in enumerate(rows):
        r = r + [""] * (ncols - len(r))
        sty = st_cellh if i == 0 else st_cell
        data.append([Paragraph(inline(c), sty) for c in r])
    widths = [None] * ncols
    t = Table(data, colWidths=widths, hAlign="LEFT")
    tst = [("BACKGROUND", (0, 0), (-1, 0), BLUE),
           ("GRID", (0, 0), (-1, -1), 0.4, LINE),
           ("VALIGN", (0, 0), (-1, -1), "TOP"),
           ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
           ("TOPPADDING", (0, 0), (-1, -1), 3.5), ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5)]
    for i in range(1, len(data)):
        if i % 2 == 0:
            tst.append(("BACKGROUND", (0, i), (-1, i), BGROW))
    t.setStyle(TableStyle(tst))
    return t

with open(SRC, encoding="utf-8") as f:
    lines = f.read().split("\n")

story = []

i = 0
buf_table = []
while i < len(lines):
    ln = lines[i].rstrip()
    if ln.startswith("|"):
        cells = [c.strip() for c in ln.strip("|").split("|")]
        if not re.match(r"^\s*:?-{2,}", cells[0]):
            buf_table.append(cells)
        i += 1
        continue
    elif buf_table:
        story.append(table_flow(buf_table)); story.append(Spacer(1, 6)); buf_table = []
    if not ln.strip():
        i += 1; continue
    if ln.startswith("> "):
        story.append(Paragraph(inline(ln[2:]), st_q))
    elif ln.startswith("---"):
        story.append(HRFlowable(width="100%", thickness=0.7, color=LINE, spaceBefore=6, spaceAfter=8))
    elif ln.startswith("# "):
        story.append(Paragraph(inline(ln[2:]), st_h1))
    elif ln.startswith("## "):
        story.append(Paragraph(inline(ln[3:]), st_h2))
    elif ln.startswith("### "):
        story.append(Paragraph(inline(ln[4:]), st_h3))
    elif re.match(r"^\d+\.\s", ln):
        story.append(Paragraph(inline(ln), st_li))
    elif ln.startswith("- ") or ln.startswith("• "):
        story.append(Paragraph("•&nbsp;&nbsp;" + inline(ln[2:]), st_li))
    else:
        story.append(Paragraph(inline(ln), st_p))
    i += 1
if buf_table:
    story.append(table_flow(buf_table))

doc = SimpleDocTemplate(OUT, pagesize=A4,
                        leftMargin=18*mm, rightMargin=18*mm, topMargin=16*mm, bottomMargin=16*mm,
                        title="RIVERS — Prep call Tec & Data", author="Alvaro / RIVERS")

def rodape(canvas, doc_):
    canvas.saveState()
    canvas.setFont("Helvetica", 7.5)
    canvas.setFillColor(MUT)
    canvas.drawString(18*mm, 9*mm, "RIVERS · " + os.path.basename(SRC).replace(".md", ""))
    canvas.drawRightString(A4[0]-18*mm, 9*mm, f"pág. {doc_.page}")
    canvas.restoreState()

doc.build(story, onFirstPage=rodape, onLaterPages=rodape)
print("ok:", OUT, os.path.getsize(OUT), "bytes")
