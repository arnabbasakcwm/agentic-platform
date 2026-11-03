"""Run exports: one agent's (or a whole run's) output as Word, PDF or CSV.

Every format renders from ONE export model (`ExportDoc`): the title, project, run id,
timestamp and, per agent, the answer as blocks (headings, paragraphs, lists, tables,
code) plus its structured citations. The answer is Markdown written by a model, so it is
parsed here into blocks rather than trusted as markup: nothing in it is executed or
emitted as raw HTML/XML, and CSV cells are protected against formula injection.

Platform-only (deploy.PLATFORM_ONLY_MODULES): a runtime never makes exports.
"""

from __future__ import annotations

import csv
import io
import json
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal

Format = Literal["docx", "pdf", "csv"]

MEDIA_TYPES: dict[str, str] = {
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "pdf": "application/pdf",
    "csv": "text/csv; charset=utf-8",
}


# ---------------------------------------------------------------------------- model
@dataclass
class Block:
    """One piece of an answer. `kind` decides which fields are used."""

    kind: Literal["heading", "paragraph", "list", "table", "code"]
    text: str = ""
    level: int = 1  # heading level
    items: list[str] = field(default_factory=list)  # list items
    ordered: bool = False
    rows: list[list[str]] = field(default_factory=list)  # table rows, header first
    lang: str = ""  # code fence language


@dataclass
class Source:
    """A citation: [n] Title — URL, or [n] Document name, p. X."""

    n: int
    kind: Literal["web", "document"]
    title: str
    url: str | None = None
    location: str | None = None  # "p. 3", "§ Pricing", "rows 2–9"

    def label(self) -> str:
        if self.kind == "web":
            return f"[{self.n}] {self.title}" + (f" — {self.url}" if self.url else "")
        return f"[{self.n}] {self.title}" + (f", {self.location}" if self.location else "")


@dataclass
class Section:
    """One agent's answer."""

    agent_id: str
    role: str
    blocks: list[Block]
    sources: list[Source]
    content: str  # the original Markdown, for tabular detection and the email body
    auto_appended: bool = False


@dataclass
class ExportDoc:
    title: str
    project_name: str
    project_id: str
    run_id: str
    created_at: datetime
    agent_label: str  # the agent's id, or "all" for a whole run
    sections: list[Section]


class ExportUnavailable(Exception):
    """The run has nothing to export (no finished output, or no such agent)."""

    def __init__(self, message: str, status: int = 409):
        self.status = status
        super().__init__(message)


def sources_from(output: dict[str, Any]) -> list[Source]:
    """Structured citations stored with an agent's output (see citations.py). Old outputs
    have none, which is fine: they export without a Sources section."""
    found: list[Source] = []
    for c in output.get("citations") or []:
        if not isinstance(c, dict) or not isinstance(c.get("n"), int):
            continue
        if c.get("kind") == "document":
            found.append(Source(c["n"], "document", str(c.get("document_name") or "Document"),
                                location=c.get("location") or None))
        else:
            found.append(Source(c["n"], "web", str(c.get("title") or c.get("url") or "Source"),
                                url=c.get("url") or None))
    return sorted(found, key=lambda s: s.n)


def build_export(project: Any, run: Any, agent_id: str | None = None) -> ExportDoc:
    """The export model for one agent's output, or for every finished agent of the run
    (in the order they finished) when `agent_id` is None."""
    outputs: dict[str, Any] = run.outputs or {}
    roles = {a.id: a.role for a in project.plan.agents}
    if agent_id is not None:
        if agent_id not in outputs:
            known = agent_id in roles
            raise ExportUnavailable(
                f"agent '{agent_id}' has no finished output in this run" if known
                else f"no agent '{agent_id}' in this run",
                status=409 if known else 404,
            )
        ids = [agent_id]
    else:
        ids = [i for i in outputs if isinstance(outputs[i], dict)]
        if not ids:
            raise ExportUnavailable("this run has no finished output to export yet")
    sections = []
    for i in ids:
        output = outputs[i] if isinstance(outputs[i], dict) else {"content": str(outputs[i])}
        content = str(output.get("content") or "")
        sources = sources_from(output)
        blocks = parse_markdown(content)
        if sources:
            # The structured Sources section replaces the one written in the text.
            blocks = strip_sources_section(blocks)
        sections.append(Section(
            agent_id=i, role=roles.get(i, ""), blocks=blocks, sources=sources, content=content,
            auto_appended=bool(output.get("citations_auto_appended")),
        ))
    name = getattr(project, "display_name", None) or getattr(project, "name", None) or "Project"
    label = agent_id or "all"
    created = run.started_at if isinstance(run.started_at, datetime) else datetime.now(timezone.utc)
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    title = f"{name} — {agent_id}" if agent_id else f"{name} — run output"
    return ExportDoc(title, name, project.id, run.id, created, label, sections)


def filename(doc: ExportDoc, fmt: str) -> str:
    """<project>_<agent>_<runid-short>_<YYYYMMDD-HHmm>.<ext>, safe on every filesystem."""
    def slug(text: str, limit: int) -> str:
        cleaned = re.sub(r"[^A-Za-z0-9]+", "-", text).strip("-")
        return (cleaned[:limit].strip("-") or "x")
    stamp = doc.created_at.astimezone(timezone.utc).strftime("%Y%m%d-%H%M")
    return f"{slug(doc.project_name, 40)}_{slug(doc.agent_label, 40)}_{slug(doc.run_id, 8)}_{stamp}.{fmt}"


def render(doc: ExportDoc, fmt: Format) -> bytes:
    if fmt == "docx":
        return render_docx(doc)
    if fmt == "pdf":
        return render_pdf(doc)
    if fmt == "csv":
        return render_csv(doc)
    raise ValueError(f"unknown export format: {fmt}")


# ---------------------------------------------------------------------------- Markdown
_HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
_BULLET = re.compile(r"^\s*[-*+]\s+(.*)$")
_NUMBERED = re.compile(r"^\s*\d{1,3}[.)]\s+(.*)$")
_FENCE = re.compile(r"^\s*(```|~~~)\s*([\w+-]*)\s*$")
_TABLE_SEP = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")
_SOURCES_HEADING = re.compile(r"^\**\s*(sources|references|citations)\s*:?\s*\**\s*$", re.IGNORECASE)


def _split_row(line: str) -> list[str]:
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|") and not line.endswith("\\|"):
        line = line[:-1]
    cells, cur, i = [], "", 0
    while i < len(line):
        ch = line[i]
        if ch == "\\" and i + 1 < len(line) and line[i + 1] == "|":
            cur += "|"
            i += 2
            continue
        if ch == "|":
            cells.append(cur.strip())
            cur = ""
        else:
            cur += ch
        i += 1
    cells.append(cur.strip())
    return cells


def parse_markdown(text: str) -> list[Block]:
    """GitHub-flavored Markdown → blocks. Unknown constructs become paragraphs, so no
    text is ever dropped."""
    lines = (text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    blocks: list[Block] = []
    para: list[str] = []
    i = 0

    def flush() -> None:
        if para:
            blocks.append(Block("paragraph", text=" ".join(p.strip() for p in para)))
            para.clear()

    while i < len(lines):
        line = lines[i]
        fence = _FENCE.match(line)
        if fence:
            flush()
            marker, lang = fence.group(1), fence.group(2)
            body = []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith(marker):
                body.append(lines[i])
                i += 1
            blocks.append(Block("code", text="\n".join(body), lang=lang.lower()))
            i += 1
            continue
        if not line.strip():
            flush()
            i += 1
            continue
        heading = _HEADING.match(line)
        if heading:
            flush()
            blocks.append(Block("heading", text=heading.group(2), level=len(heading.group(1))))
            i += 1
            continue
        if "|" in line and i + 1 < len(lines) and _TABLE_SEP.match(lines[i + 1]):
            flush()
            rows = [_split_row(line)]
            i += 2
            while i < len(lines) and "|" in lines[i] and lines[i].strip():
                rows.append(_split_row(lines[i]))
                i += 1
            width = len(rows[0])
            rows = [(r + [""] * width)[:width] for r in rows]
            blocks.append(Block("table", rows=rows))
            continue
        bullet, numbered = _BULLET.match(line), _NUMBERED.match(line)
        if bullet or numbered:
            flush()
            ordered = bool(numbered) and not bullet
            pattern = _NUMBERED if ordered else _BULLET
            items = []
            while i < len(lines):
                m = pattern.match(lines[i])
                if m:
                    items.append(m.group(1).strip())
                elif lines[i].startswith(("  ", "\t")) and lines[i].strip() and items:
                    items[-1] += " " + lines[i].strip()  # a wrapped item
                else:
                    break
                i += 1
            blocks.append(Block("list", items=items, ordered=ordered))
            continue
        para.append(line)
        i += 1
    flush()
    return blocks


def strip_sources_section(blocks: list[Block]) -> list[Block]:
    """Drop a trailing "Sources" section (heading or bold line, and what follows it)."""
    for idx in range(len(blocks) - 1, -1, -1):
        b = blocks[idx]
        if b.kind in ("heading", "paragraph") and _SOURCES_HEADING.match(b.text.strip()):
            return blocks[:idx]
    return blocks


# Inline Markdown: **bold**, *italic* / _italic_, `code`, [text](url).
_INLINE = re.compile(
    r"(\*\*(?P<b>.+?)\*\*)|(`(?P<c>[^`]+)`)|(\[(?P<lt>[^\]]+)\]\((?P<lu>[^)\s]+)\))"
    r"|((?<![\w*])\*(?P<i>[^*\s][^*]*?)\*(?![\w*]))|((?<![\w_])_(?P<i2>[^_\s][^_]*?)_(?![\w_]))"
)


@dataclass
class Run:
    text: str
    bold: bool = False
    italic: bool = False
    code: bool = False
    href: str | None = None


def parse_inline(text: str) -> list[Run]:
    runs: list[Run] = []
    pos = 0
    for m in _INLINE.finditer(text):
        if m.start() > pos:
            runs.append(Run(text[pos:m.start()]))
        if m.group("b") is not None:
            runs.append(Run(m.group("b"), bold=True))
        elif m.group("c") is not None:
            runs.append(Run(m.group("c"), code=True))
        elif m.group("lt") is not None:
            url = m.group("lu")
            runs.append(Run(m.group("lt"), href=url if _safe_url(url) else None))
        else:
            runs.append(Run(m.group("i") or m.group("i2"), italic=True))
        pos = m.end()
    if pos < len(text):
        runs.append(Run(text[pos:]))
    return runs


def plain(text: str) -> str:
    """Inline Markdown → plain text (CSV cells, email bodies)."""
    return "".join(r.text + (f" ({r.href})" if r.href and r.href != r.text else "") for r in parse_inline(text))


def _safe_url(url: str) -> bool:
    return url.lower().startswith(("http://", "https://", "mailto:"))


# ---------------------------------------------------------------------------- tabular
_DELIMITERS = [",", ";", "\t", "|"]


def detect_table(content: str) -> list[list[str]] | None:
    """The output as a table, if it is one: a JSON array of objects, CSV/TSV text (a
    consistent delimiter count across the first lines), or a Markdown answer whose only
    block is a table. None otherwise."""
    text = (content or "").strip()
    if not text:
        return None
    if text.startswith("```"):
        blocks = parse_markdown(text)
        if len(blocks) == 1 and blocks[0].kind == "code":
            text = blocks[0].text.strip()
    if text.startswith("["):
        try:
            data = json.loads(text)
        except ValueError:
            data = None
        if isinstance(data, list) and data and all(isinstance(r, dict) for r in data):
            header: list[str] = []
            for r in data:
                header += [k for k in r if k not in header]
            return [header] + [[_cell_text(r.get(k)) for k in header] for r in data]
    rows = detect_csv(text)
    if rows:
        return rows
    blocks = parse_markdown(text)
    tables = [b for b in blocks if b.kind == "table"]
    others = [b for b in blocks if b.kind != "table"]
    if len(tables) == 1 and not others:
        return [[plain(c) for c in r] for r in tables[0].rows]
    return None


def detect_csv(text: str) -> list[list[str]] | None:
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if len(lines) < 2:
        return None
    sample = lines[:10]
    for delim in _DELIMITERS:
        try:
            rows = list(csv.reader(io.StringIO("\n".join(sample)), delimiter=delim))
        except csv.Error:
            continue
        widths = {len(r) for r in rows}
        if len(widths) == 1 and next(iter(widths)) >= 2:
            # A Markdown table also has consistent pipes; leave it to the Markdown path.
            if delim == "|" and any(_TABLE_SEP.match(ln) for ln in sample):
                return None
            try:
                return [r for r in csv.reader(io.StringIO(text), delimiter=delim) if any(c.strip() for c in r)]
            except csv.Error:
                return None
    return None


def _cell_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


# ---------------------------------------------------------------------------- CSV
_FORMULA_START = ("=", "+", "-", "@", "\t", "\r")


def safe_cell(value: Any) -> str:
    """A CSV cell that spreadsheet apps won't run as a formula."""
    text = _cell_text(value)
    return "'" + text if text.startswith(_FORMULA_START) else text


def _block_text(b: Block) -> str:
    if b.kind == "list":
        return "\n".join(
            (f"{n}. " if b.ordered else "- ") + plain(item) for n, item in enumerate(b.items, 1)
        )
    if b.kind == "table":
        return "\n".join(" | ".join(plain(c) for c in r) for r in b.rows)
    if b.kind == "code":
        return b.text
    return plain(b.text)


_MARKER = re.compile(r"\[(\d{1,3})\]")


def render_csv(doc: ExportDoc) -> bytes:
    """UTF-8 with BOM. A tabular single-agent output exports as its own table (sources,
    if any, after a blank row); anything else as one row per section:
    run_id, agent, timestamp, section, content, sources."""
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\r\n")
    stamp = doc.created_at.astimezone(timezone.utc).isoformat()
    table = detect_table(doc.sections[0].content) if len(doc.sections) == 1 else None
    if table:
        for row in table:
            writer.writerow([safe_cell(c) for c in row])
        if doc.sections[0].sources:
            writer.writerow([])
            writer.writerow(["Sources"])
            for s in doc.sections[0].sources:
                writer.writerow([safe_cell(s.label())])
    else:
        writer.writerow(["run_id", "agent", "timestamp", "section", "content", "sources"])
        for sec in doc.sections:
            by_n = {s.n: s for s in sec.sources}
            for title, blocks in _sections_of(sec.blocks):
                content = "\n\n".join(_block_text(b) for b in blocks)
                cited = sorted({int(n) for n in _MARKER.findall(content) if int(n) in by_n})
                # A section that cites nothing still lists the agent's sources when the
                # platform appended them (the answer had no inline markers).
                if not cited and sec.auto_appended:
                    cited = sorted(by_n)
                sources = "; ".join(by_n[n].label() for n in cited)
                writer.writerow([safe_cell(c) for c in (doc.run_id, sec.agent_id, stamp, title, content, sources)])
    return ("\ufeff" + out.getvalue()).encode("utf-8")


def _sections_of(blocks: list[Block]) -> list[tuple[str, list[Block]]]:
    """Split blocks at headings: [(heading, blocks under it)]; text before the first
    heading is "Introduction" (or "Answer" when there's no heading at all)."""
    if not blocks:
        return [("Answer", [])]
    groups: list[tuple[str, list[Block]]] = []
    title = "Introduction" if any(b.kind == "heading" for b in blocks) else "Answer"
    current: list[Block] = []
    for b in blocks:
        if b.kind == "heading":
            if current:
                groups.append((title, current))
            title, current = plain(b.text), []
        else:
            current.append(b)
    if current or not groups:
        groups.append((title, current))
    return groups


# ---------------------------------------------------------------------------- DOCX
def render_docx(doc: ExportDoc) -> bytes:
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Pt, RGBColor

    d = Document()
    d.core_properties.title = doc.title
    d.add_heading(doc.title, level=0)
    meta = d.add_paragraph()
    meta.add_run(_meta_line(doc)).italic = True

    for sec in doc.sections:
        if len(doc.sections) > 1:
            d.add_heading(sec.agent_id + (f" — {sec.role}" if sec.role else ""), level=1)
        base = 2 if len(doc.sections) > 1 else 1
        for b in sec.blocks:
            if b.kind == "heading":
                d.add_heading(plain(b.text), level=min(base + b.level - 1, 9))
            elif b.kind == "paragraph":
                _docx_runs(d.add_paragraph(), b.text)
            elif b.kind == "list":
                style = "List Number" if b.ordered else "List Bullet"
                for item in b.items:
                    _docx_runs(d.add_paragraph(style=style), item)
            elif b.kind == "table":
                table = d.add_table(rows=len(b.rows), cols=len(b.rows[0]))
                table.style = "Table Grid"
                for r, row in enumerate(b.rows):
                    for c, cell in enumerate(row):
                        para = table.cell(r, c).paragraphs[0]
                        _docx_runs(para, cell, bold=(r == 0))
                d.add_paragraph()
            elif b.kind == "code":
                para = d.add_paragraph()
                run = para.add_run(b.text)
                run.font.name = "Consolas"
                run.font.size = Pt(9)
        if sec.sources:
            d.add_heading("Sources", level=base)
            if sec.auto_appended:
                note = d.add_paragraph()
                r = note.add_run("Added by the platform: the answer cited none of its search results.")
                r.italic = True
                r.font.color.rgb = RGBColor(0x5B, 0x6B, 0x82)
            for s in sec.sources:
                para = d.add_paragraph()
                if s.kind == "web" and s.url and _safe_url(s.url):
                    para.add_run(f"[{s.n}] {s.title} — ")
                    _docx_hyperlink(para, s.url, s.url)
                else:
                    para.add_run(s.label())
    footer = d.sections[0].footer.paragraphs[0]
    footer.text = f"{doc.project_name} · run {doc.run_id[:8]}"
    footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


def _docx_runs(paragraph: Any, text: str, bold: bool = False) -> None:
    from docx.shared import Pt

    for r in parse_inline(text):
        if r.href:
            _docx_hyperlink(paragraph, r.text, r.href)
            continue
        run = paragraph.add_run(r.text)
        run.bold = bold or r.bold
        run.italic = r.italic
        if r.code:
            run.font.name = "Consolas"
            run.font.size = Pt(9.5)


def _docx_hyperlink(paragraph: Any, text: str, url: str) -> None:
    """A real, clickable hyperlink (python-docx has no API for one)."""
    from docx.opc.constants import RELATIONSHIP_TYPE
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn

    rel_id = paragraph.part.relate_to(url, RELATIONSHIP_TYPE.HYPERLINK, is_external=True)
    link = OxmlElement("w:hyperlink")
    link.set(qn("r:id"), rel_id)
    run = OxmlElement("w:r")
    props = OxmlElement("w:rPr")
    style = OxmlElement("w:rStyle")
    style.set(qn("w:val"), "Hyperlink")
    props.append(style)
    color = OxmlElement("w:color")
    color.set(qn("w:val"), "6D28D9")
    props.append(color)
    underline = OxmlElement("w:u")
    underline.set(qn("w:val"), "single")
    props.append(underline)
    run.append(props)
    t = OxmlElement("w:t")
    t.text = text
    t.set(qn("xml:space"), "preserve")
    run.append(t)
    link.append(run)
    paragraph._p.append(link)


def _meta_line(doc: ExportDoc) -> str:
    when = doc.created_at.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    agent = "all agents" if doc.agent_label == "all" else f"agent {doc.agent_label}"
    return f"Project {doc.project_name} · {agent} · run {doc.run_id} · {when}"


# ---------------------------------------------------------------------------- PDF
# A TrueType font with wide Unicode coverage, so any language (and ₹, €, “quotes”) prints.
# PDF_FONT_PATH overrides; otherwise the first that exists. The API image installs DejaVu.
_FONT_CANDIDATES = [
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
     "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"),
    ("C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/consola.ttf"),
    ("/Library/Fonts/Arial Unicode.ttf", "/Library/Fonts/Arial Unicode.ttf", "/System/Library/Fonts/Menlo.ttc"),
]
_FONTS: tuple[str, str, str] | None = None


def _pdf_fonts() -> tuple[str, str, str]:
    """(regular, bold, mono) font names registered with reportlab; Helvetica/Courier
    (Latin-1 only) when no TrueType font is found."""
    global _FONTS
    if _FONTS is not None:
        return _FONTS
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    candidates = list(_FONT_CANDIDATES)
    custom = os.environ.get("PDF_FONT_PATH")
    if custom:
        candidates.insert(0, (custom, os.environ.get("PDF_FONT_BOLD_PATH", custom),
                              os.environ.get("PDF_FONT_MONO_PATH", custom)))
    for regular, bold, mono in candidates:
        if os.path.exists(regular):
            try:
                pdfmetrics.registerFont(TTFont("ExportSans", regular))
                pdfmetrics.registerFont(TTFont("ExportSans-Bold", bold if os.path.exists(bold) else regular))
                mono_ok = os.path.exists(mono) and not mono.endswith(".ttc")
                pdfmetrics.registerFont(TTFont("ExportMono", mono if mono_ok else regular))
                from reportlab.lib.fonts import addMapping

                addMapping("ExportSans", 0, 0, "ExportSans")
                addMapping("ExportSans", 1, 0, "ExportSans-Bold")
                addMapping("ExportSans", 0, 1, "ExportSans")
                addMapping("ExportSans", 1, 1, "ExportSans-Bold")
                _FONTS = ("ExportSans", "ExportSans-Bold", "ExportMono")
                return _FONTS
            except Exception:  # noqa: BLE001 — a broken font file: try the next
                continue
    _FONTS = ("Helvetica", "Helvetica-Bold", "Courier")
    return _FONTS


def _xml(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _pdf_inline(text: str, mono: str) -> str:
    """Inline Markdown → reportlab's paragraph markup, every piece of text escaped."""
    out = []
    for r in parse_inline(text):
        piece = _xml(r.text)
        if r.code:
            piece = f'<font face="{mono}">{piece}</font>'
        if r.bold:
            piece = f"<b>{piece}</b>"
        if r.italic:
            piece = f"<i>{piece}</i>"
        if r.href:
            piece = f'<a href="{_xml(r.href)}" color="#6D28D9"><u>{piece}</u></a>'
        out.append(piece)
    return "".join(out)


def render_pdf(doc: ExportDoc) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_LEFT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.pdfgen import canvas as rl_canvas
    from reportlab.platypus import (
        ListFlowable, ListItem, Paragraph, Preformatted, SimpleDocTemplate, Spacer, Table, TableStyle,
    )

    regular, bold, mono = _pdf_fonts()
    base = getSampleStyleSheet()
    body = ParagraphStyle("body", parent=base["BodyText"], fontName=regular, fontSize=10, leading=14,
                          alignment=TA_LEFT, spaceAfter=6)
    small = ParagraphStyle("small", parent=body, fontSize=8.5, leading=11, textColor=colors.HexColor("#5B6B82"))
    cell = ParagraphStyle("cell", parent=body, fontSize=8.5, leading=11, spaceAfter=0)
    head_cell = ParagraphStyle("headcell", parent=cell, fontName=bold)
    code = ParagraphStyle("code", parent=body, fontName=mono, fontSize=8, leading=10,
                          backColor=colors.HexColor("#F1F3F9"), borderPadding=4)
    headings = {
        lvl: ParagraphStyle(f"h{lvl}", parent=body, fontName=bold, fontSize=size, leading=size * 1.3,
                            spaceBefore=8, spaceAfter=4, textColor=colors.HexColor("#0F172A"))
        for lvl, size in {0: 18, 1: 15, 2: 13, 3: 11.5, 4: 10.5}.items()
    }

    def heading(text: str, level: int) -> Paragraph:
        return Paragraph(_pdf_inline(text, mono), headings[min(max(level, 0), 4)])

    left, right = 18 * mm, 18 * mm
    width = A4[0] - left - right
    story: list[Any] = [heading(doc.title, 0), Paragraph(_xml(_meta_line(doc)), small), Spacer(1, 6)]
    for sec in doc.sections:
        offset = 1 if len(doc.sections) > 1 else 0
        if offset:
            story.append(heading(sec.agent_id + (f" — {sec.role}" if sec.role else ""), 1))
        for b in sec.blocks:
            if b.kind == "heading":
                story.append(heading(b.text, b.level + offset))
            elif b.kind == "paragraph":
                story.append(Paragraph(_pdf_inline(b.text, mono), body))
            elif b.kind == "list":
                items = [ListItem(Paragraph(_pdf_inline(t, mono), body), leftIndent=12) for t in b.items]
                kind = {"bulletType": "1"} if b.ordered else {"bulletType": "bullet", "start": "•"}
                story.append(ListFlowable(items, leftIndent=14, bulletFontName=regular,
                                          bulletFontSize=9, **kind))
            elif b.kind == "table":
                cols = len(b.rows[0])
                data = [[Paragraph(_pdf_inline(c, mono), head_cell if r == 0 else cell) for c in row]
                        for r, row in enumerate(b.rows)]
                table = Table(data, colWidths=[width / cols] * cols, repeatRows=1)
                table.setStyle(TableStyle([
                    ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#CBD2E1")),
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F1F3F9")),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#FAFBFD")]),
                ]))
                story += [table, Spacer(1, 6)]
            elif b.kind == "code":
                story.append(Preformatted(b.text, code, maxLineLength=110))
        if sec.sources:
            story.append(heading("Sources", 1 + offset))
            if sec.auto_appended:
                story.append(Paragraph("Added by the platform: the answer cited none of its search results.", small))
            for s in sec.sources:
                if s.kind == "web" and s.url and _safe_url(s.url):
                    text = (f"[{s.n}] {_xml(s.title)} — "
                            f'<a href="{_xml(s.url)}" color="#6D28D9"><u>{_xml(s.url)}</u></a>')
                else:
                    text = _xml(s.label())
                story.append(Paragraph(text, body))

    header_text = f"{doc.project_name} · {'all agents' if doc.agent_label == 'all' else doc.agent_label}" \
                  f" · {doc.created_at.astimezone(timezone.utc).strftime('%Y-%m-%d')}"

    class NumberedCanvas(rl_canvas.Canvas):
        """Two passes, so every page can say "Page n of N"."""

        def __init__(self, *args: Any, **kwargs: Any):
            super().__init__(*args, **kwargs)
            self._pages: list[dict[str, Any]] = []

        def showPage(self) -> None:  # noqa: N802 — reportlab's name
            self._pages.append(dict(self.__dict__))
            self._startPage()

        def save(self) -> None:
            total = len(self._pages)
            for state in self._pages:
                self.__dict__.update(state)
                self.setFont(regular, 8)
                self.setFillColor(colors.HexColor("#5B6B82"))
                self.drawString(left, A4[1] - 12 * mm, header_text[:110])
                self.drawRightString(A4[0] - right, 10 * mm, f"Page {self._pageNumber} of {total}")
                super().showPage()
            super().save()

    buf = io.BytesIO()
    SimpleDocTemplate(buf, pagesize=A4, leftMargin=left, rightMargin=right, topMargin=20 * mm,
                      bottomMargin=18 * mm, title=doc.title, author="Agentic Platform").build(
        story, canvasmaker=NumberedCanvas)
    return buf.getvalue()


# ---------------------------------------------------------------------------- email body
def as_text(doc: ExportDoc) -> str:
    """The output as plain text for an email body, with its sources."""
    parts = []
    for sec in doc.sections:
        if len(doc.sections) > 1:
            parts.append(f"== {sec.agent_id} ==")
        parts.append(sec.content.strip())
        if sec.sources and not _has_sources_text(sec.content):
            parts.append("Sources\n" + "\n".join(s.label() for s in sec.sources))
    return "\n\n".join(p for p in parts if p)


def _has_sources_text(content: str) -> bool:
    return any(_SOURCES_HEADING.match(ln.strip().lstrip("#").strip()) for ln in content.splitlines())
