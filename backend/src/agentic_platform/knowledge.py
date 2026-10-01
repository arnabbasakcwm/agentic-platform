"""Project knowledge bases: turn uploaded documents into searchable passages.

Pipeline: extract text from a file (PDF, Word, text/Markdown, CSV) → split it into
overlapping passages that remember where they came from (page, rows, section) → embed
them with the project's embedding model → store them. Agents reach the passages only
through the `knowledge_search` tool, scoped to their own project.

Original files are not kept: only the extracted passages are stored, which is all that
re-embedding needs. Parsing runs on the platform, never in a deployed runtime.
"""

from __future__ import annotations

import csv
import io
import re
import zipfile
from dataclasses import dataclass
from pathlib import PurePath

from .errors import KnowledgeError

# ---------------------------------------------------------------------------- limits
MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_FILES_PER_PROJECT = 50
MAX_CHUNKS_PER_PROJECT = 20_000
# Caps on what one file may expand to, so a small malicious file can't exhaust memory.
MAX_PDF_PAGES = 2_000
MAX_TEXT_CHARS = 5_000_000
MAX_DOCX_UNZIPPED_BYTES = 100 * 1024 * 1024

# Passage size: ~800 tokens at ~4 characters per token, overlapping by ~15%.
CHUNK_CHARS = 3_200
CHUNK_OVERLAP_CHARS = 480
CSV_ROWS_PER_SECTION = 50

ALLOWED_TYPES = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".csv": "text/csv",
}


@dataclass(frozen=True)
class Section:
    """A run of text from one place in a document, with a human-readable location."""

    text: str
    source: str


@dataclass(frozen=True)
class Passage:
    text: str
    source: str


def file_kind(filename: str) -> str:
    """The lower-case extension if the file type is accepted; raises otherwise."""
    ext = PurePath(filename).suffix.lower()
    if ext not in ALLOWED_TYPES:
        raise KnowledgeError(
            f"'{filename}' isn't a supported file type. Upload PDF, Word (.docx), "
            "text, Markdown or CSV files."
        )
    return ext


# ---------------------------------------------------------------------------- extraction
def _decode_text(data: bytes) -> str:
    for encoding in ("utf-8-sig", "cp1252"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1")


def _extract_pdf(data: bytes) -> list[Section]:
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted and not reader.decrypt(""):
            raise KnowledgeError("this PDF is password-protected; remove the password and upload it again")
        if len(reader.pages) > MAX_PDF_PAGES:
            raise KnowledgeError(f"this PDF has {len(reader.pages)} pages; the limit is {MAX_PDF_PAGES}")
        sections = []
        for number, page in enumerate(reader.pages, start=1):
            text = (page.extract_text() or "").strip()
            if text:
                sections.append(Section(text, f"page {number}"))
    except PdfReadError as e:
        raise KnowledgeError(f"this PDF couldn't be read: {e}") from None
    if not sections:
        raise KnowledgeError(
            "no text could be extracted from this PDF; scanned PDFs need OCR, which isn't supported"
        )
    return sections


def _extract_docx(data: bytes) -> list[Section]:
    # A .docx is a zip: check what it expands to before parsing it.
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            if sum(i.file_size for i in archive.infolist()) > MAX_DOCX_UNZIPPED_BYTES:
                raise KnowledgeError("this Word document expands to more than 100 MB and can't be read")
    except zipfile.BadZipFile:
        raise KnowledgeError("this file isn't a valid Word (.docx) document") from None

    from docx import Document

    document = Document(io.BytesIO(data))
    sections: list[Section] = []
    heading = "start of document"
    lines: list[str] = []

    def flush() -> None:
        text = "\n\n".join(line for line in lines if line.strip())
        if text:
            sections.append(Section(text, heading))
        lines.clear()

    for paragraph in document.paragraphs:
        text = paragraph.text.strip()
        if not text:
            continue
        if (paragraph.style.name or "").lower().startswith("heading"):
            flush()
            heading = f"section \"{text[:80]}\""
        lines.append(text)
    flush()
    for number, table in enumerate(document.tables, start=1):
        rows = [" | ".join(cell.text.strip() for cell in row.cells) for row in table.rows]
        text = "\n".join(r for r in rows if r.strip(" |"))
        if text:
            sections.append(Section(text, f"table {number}"))
    if not sections:
        raise KnowledgeError("this Word document has no text")
    return sections


_MD_HEADING = re.compile(r"^#{1,6}\s+(.+?)\s*#*\s*$")


def _extract_text(data: bytes, markdown: bool) -> list[Section]:
    text = _decode_text(data)
    if not text.strip():
        raise KnowledgeError("this file is empty")
    if not markdown:
        return [Section(text.strip(), "text")]
    sections: list[Section] = []
    heading = "start of document"
    lines: list[str] = []
    for line in text.splitlines():
        match = _MD_HEADING.match(line)
        if match:
            body = "\n".join(lines).strip()
            if body:
                sections.append(Section(body, heading))
            lines = []
            heading = f"section \"{match.group(1)[:80]}\""
        lines.append(line)
    body = "\n".join(lines).strip()
    if body:
        sections.append(Section(body, heading))
    return sections


def _extract_csv(data: bytes) -> list[Section]:
    text = _decode_text(data)
    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    rows = list(csv.reader(io.StringIO(text), dialect))
    rows = [r for r in rows if any(cell.strip() for cell in r)]
    if len(rows) < 2:
        raise KnowledgeError("this CSV has no data rows")
    header, body = rows[0], rows[1:]
    sections = []
    # Each row as "column: value" pairs, so a passage reads on its own; the header is
    # repeated in every block. Row numbers count the header as row 1, as a spreadsheet does.
    for start in range(0, len(body), CSV_ROWS_PER_SECTION):
        block = body[start : start + CSV_ROWS_PER_SECTION]
        lines = [
            "; ".join(f"{h.strip() or f'column {i + 1}'}: {v.strip()}" for i, (h, v) in enumerate(zip(header, row)))
            for row in block
        ]
        first, last = start + 2, start + 1 + len(block)
        sections.append(Section("\n".join(lines), f"rows {first}–{last}"))
    return sections


def extract(filename: str, data: bytes) -> list[Section]:
    """The text of a document, in sections that know where they came from."""
    kind = file_kind(filename)
    if not data:
        raise KnowledgeError("this file is empty")
    if kind == ".pdf":
        sections = _extract_pdf(data)
    elif kind == ".docx":
        sections = _extract_docx(data)
    elif kind == ".csv":
        sections = _extract_csv(data)
    else:
        sections = _extract_text(data, markdown=kind in (".md", ".markdown"))
    if sum(len(s.text) for s in sections) > MAX_TEXT_CHARS:
        raise KnowledgeError("this file contains more than 5 million characters of text")
    return sections


# ---------------------------------------------------------------------------- chunking
_PARAGRAPH = re.compile(r"\n\s*\n")
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")


def _pieces(text: str) -> list[str]:
    """Paragraphs, with any paragraph longer than a passage split at sentence ends (or,
    failing that, hard-wrapped)."""
    pieces: list[str] = []
    for paragraph in _PARAGRAPH.split(text):
        paragraph = paragraph.strip()
        if not paragraph:
            continue
        if len(paragraph) <= CHUNK_CHARS:
            pieces.append(paragraph)
            continue
        current = ""
        for sentence in _SENTENCE_END.split(paragraph):
            while len(sentence) > CHUNK_CHARS:  # no sentence breaks at all
                pieces.append(sentence[:CHUNK_CHARS])
                sentence = sentence[CHUNK_CHARS:]
            if current and len(current) + 1 + len(sentence) > CHUNK_CHARS:
                pieces.append(current)
                current = sentence
            else:
                current = f"{current} {sentence}".strip()
        if current:
            pieces.append(current)
    return pieces


def _overlap_tail(text: str) -> str:
    """The end of a passage to repeat at the start of the next, cut at a word boundary."""
    if len(text) <= CHUNK_OVERLAP_CHARS:
        return text
    tail = text[-CHUNK_OVERLAP_CHARS:]
    space = tail.find(" ")
    return tail[space + 1 :] if space != -1 else tail


def _source_range(first: str, last: str) -> str:
    return first if first == last else f"{first} – {last}"


def chunk(sections: list[Section]) -> list[Passage]:
    """Split sections into passages of about CHUNK_CHARS with ~15% overlap. Short
    neighbouring sections share a passage ("page 3 – page 4"); paragraphs are never cut
    unless a single one is longer than a passage."""
    passages: list[Passage] = []
    buffer: list[str] = []
    size = 0
    first: str | None = None
    last: str | None = None
    has_new_text = False  # buffer holds more than the overlap carried from the last passage

    def emit() -> str:
        text = "\n\n".join(buffer).strip()
        passages.append(Passage(text, _source_range(first, last)))
        return _overlap_tail(text)

    for section in sections:
        for piece in _pieces(section.text):
            if has_new_text and size + 2 + len(piece) > CHUNK_CHARS:
                tail = emit()
                buffer, size = [tail], len(tail)
                first = last  # the overlap comes from where the previous passage ended
                has_new_text = False
            if first is None:
                first = section.source
            buffer.append(piece)
            size += len(piece) + 2
            last = section.source
            has_new_text = True
    if has_new_text:
        emit()
    return passages
