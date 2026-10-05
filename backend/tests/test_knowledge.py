"""Knowledge base: extraction, chunking, search — offline."""

import io

import pytest

from agentic_platform import knowledge as kb
from agentic_platform.errors import KnowledgeError


# ---------------------------------------------------------------------------- fixtures
def make_pdf(pages: list[str]) -> bytes:
    """A minimal valid PDF with one line of Helvetica text per page."""
    objects: list[bytes] = []
    kids = " ".join(f"{4 + 2 * i} 0 R" for i in range(len(pages)))
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objects.append(f"<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>".encode())
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    for i, text in enumerate(pages):
        content_id = 5 + 2 * i
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {content_id} 0 R >>".encode()
        )
        escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        stream = f"BT /F1 12 Tf 72 720 Td ({escaped}) Tj ET".encode()
        objects.append(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(out.tell())
        out.write(f"{number} 0 obj\n".encode() + body + b"\nendobj\n")
    xref = out.tell()
    out.write(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    for offset in offsets:
        out.write(f"{offset:010d} 00000 n \n".encode())
    out.write(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return out.getvalue()


def make_docx() -> bytes:
    from docx import Document

    doc = Document()
    doc.add_paragraph("Company travel policy, 2026 edition.")
    doc.add_heading("Flights", level=1)
    doc.add_paragraph("Economy class is required for flights under 6 hours.")
    doc.add_heading("Hotels", level=1)
    doc.add_paragraph("The nightly hotel cap in Delhi is INR 9,000.")
    table = doc.add_table(rows=2, cols=2)
    table.rows[0].cells[0].text, table.rows[0].cells[1].text = "City", "Cap (INR)"
    table.rows[1].cells[0].text, table.rows[1].cells[1].text = "Mumbai", "10,000"
    out = io.BytesIO()
    doc.save(out)
    return out.getvalue()


# ---------------------------------------------------------------------------- extraction
def test_pdf_pages_keep_their_page_numbers():
    sections = kb.extract("guide.pdf", make_pdf(["Akasa Air flies mornings.", "IndiGo has six daily flights."]))
    assert [s.source for s in sections] == ["page 1", "page 2"]
    assert "IndiGo" in sections[1].text


def test_pdf_without_text_explains_scans_are_unsupported():
    with pytest.raises(KnowledgeError, match="OCR"):
        kb.extract("scan.pdf", make_pdf(["   "]))


def test_broken_pdf_is_a_clear_error():
    with pytest.raises(KnowledgeError):
        kb.extract("broken.pdf", b"%PDF-1.4 this is not really a pdf")


def test_docx_sections_follow_headings_and_tables_are_rows():
    sections = kb.extract("policy.docx", make_docx())
    sources = [s.source for s in sections]
    assert sources == ["start of document", 'section "Flights"', 'section "Hotels"', "table 1"]
    assert "INR 9,000" in sections[2].text
    assert "Mumbai | 10,000" in sections[3].text


def test_a_zip_bomb_docx_is_refused_before_parsing(monkeypatch):
    monkeypatch.setattr(kb, "MAX_DOCX_UNZIPPED_BYTES", 1000)
    with pytest.raises(KnowledgeError, match="expands"):
        kb.extract("big.docx", make_docx())


def test_markdown_sections_follow_headings():
    md = b"# Overview\nIntro text.\n\n## Fares\nCheapest is Akasa at INR 7,004.\n"
    sections = kb.extract("notes.md", md)
    assert [s.source for s in sections] == ['section "Overview"', 'section "Fares"']
    assert "7,004" in sections[1].text


def test_text_in_other_encodings_is_decoded():
    sections = kb.extract("notes.txt", "Café near the airport".encode("cp1252"))
    assert sections[0].text == "Café near the airport"


def test_csv_rows_read_as_labelled_values_with_row_numbers(monkeypatch):
    monkeypatch.setattr(kb, "CSV_ROWS_PER_SECTION", 2)
    data = b"airline,fare_inr\nAkasa,7004\nIndiGo,8249\nAir India,8528\n"
    sections = kb.extract("fares.csv", data)
    assert [s.source for s in sections] == ["rows 2–3", "rows 4–4"]
    assert sections[0].text.splitlines()[0] == "airline: Akasa; fare_inr: 7004"


def test_unsupported_and_empty_files_are_refused():
    with pytest.raises(KnowledgeError, match="supported file type"):
        kb.extract("slides.pptx", b"x")
    with pytest.raises(KnowledgeError, match="empty"):
        kb.extract("empty.txt", b"")
    with pytest.raises(KnowledgeError, match="no data rows"):
        kb.extract("header-only.csv", b"a,b\n")


# ---------------------------------------------------------------------------- chunking
def test_short_sections_share_a_passage_with_a_source_range():
    passages = kb.chunk([kb.Section("Page one text.", "page 1"), kb.Section("Page two text.", "page 2")])
    assert len(passages) == 1
    assert passages[0].source == "page 1 – page 2"


def test_long_text_splits_into_overlapping_passages_without_cutting_paragraphs():
    paragraphs = [f"Paragraph {i}. " + "word " * 120 for i in range(20)]  # ~620 chars each
    passages = kb.chunk([kb.Section("\n\n".join(paragraphs), "text")])
    assert len(passages) > 3
    assert all(len(p.text) <= kb.CHUNK_CHARS + kb.CHUNK_OVERLAP_CHARS + 10 for p in passages)
    # Consecutive passages overlap, so a fact on the boundary is in both.
    for a, b in zip(passages, passages[1:]):
        assert b.text[:200] in a.text
    # Every paragraph start survives intact somewhere.
    joined = "\n".join(p.text for p in passages)
    assert all(f"Paragraph {i}." in joined for i in range(20))


def test_a_paragraph_longer_than_a_passage_is_split_at_sentences():
    long_paragraph = " ".join(f"Sentence number {i} about fares." for i in range(300))
    passages = kb.chunk([kb.Section(long_paragraph, "page 3")])
    assert len(passages) > 1
    assert all(p.source == "page 3" for p in passages)
    assert all(p.text.rstrip().endswith(".") for p in passages[:-1])


# ---------------------------------------------------------------------------- indexing + search
TOPICS = ["flight", "hotel", "visa", "food"]


def _vector(text: str) -> list[float]:
    """Deterministic fake embedding: how often each topic word appears."""
    lower = text.lower()
    return [float(lower.count(t)) + 0.01 for t in TOPICS]


class FakeEmbedder:
    def __init__(self, fail_times: int = 0):
        self.calls = 0
        self.fail_times = fail_times

    def embed_documents(self, texts):
        self.calls += 1
        if self.calls <= self.fail_times:
            raise RuntimeError("429 rate limited")
        return [_vector(t) for t in texts]

    def embed_query(self, text):
        return _vector(text)


@pytest.fixture
def kstore():
    from agentic_platform.stores import InMemoryKnowledgeStore, KnowledgeDocument

    store = InMemoryKnowledgeStore()
    store.add_document(
        KnowledgeDocument(id="d1", tenant_id="u1", project_ids=["p1"], filename="guide.md", kind=".md", size_bytes=1)
    )
    return store


GUIDE = (
    b"# Flights\nThe cheapest flight to Goa is Akasa at INR 7,004. Flight times vary.\n\n"
    + b"filler text. " * 300
    + b"\n# Hotels\nThe hotel cap in Delhi is INR 9,000 per night for any hotel.\n"
)


def test_indexing_stores_cited_passages_and_search_finds_the_right_one(kstore):
    kb.index_document(kstore, "u1", "d1", GUIDE, FakeEmbedder(), chunk_budget=100)
    doc = kstore.get_document("u1", "d1")
    assert doc.status == "ready" and doc.chunk_count >= 2
    context = kb.store_context(kstore, "u1", "p1", FakeEmbedder())
    hits = context.search("which hotel is cheapest", k=1)
    assert hits[0].filename == "guide.md"
    assert 'section "Hotels"' in hits[0].source and "INR 9,000" in hits[0].text


def test_a_project_searches_only_its_attached_files(kstore):
    from agentic_platform.stores import KnowledgeDocument

    kstore.add_document(KnowledgeDocument(id="d2", tenant_id="u1", filename="other.md", kind=".md", size_bytes=1))
    kb.index_document(kstore, "u1", "d1", GUIDE, FakeEmbedder(), chunk_budget=100)
    kb.index_document(kstore, "u1", "d2", b"# Visa\nVisa on arrival for hotel guests.", FakeEmbedder(), chunk_budget=100)
    in_project = {h.filename for h in kb.store_context(kstore, "u1", "p1", FakeEmbedder()).search("visa hotel", k=5)}
    in_library = {h.filename for h in kb.store_context(kstore, "u1", None, FakeEmbedder()).search("visa hotel", k=5)}
    assert in_project == {"guide.md"}
    assert in_library == {"guide.md", "other.md"}
    assert kb.store_context(kstore, "u1", "p2", FakeEmbedder()).search("hotel") == []


def test_a_failed_extraction_is_recorded_not_raised(kstore):
    kb.index_document(kstore, "u1", "d1", b"", FakeEmbedder(), chunk_budget=100)
    doc = kstore.get_document("u1", "d1")
    assert doc.status == "failed" and "empty" in doc.error


def test_embedding_retries_then_reports_the_provider_error(kstore, monkeypatch):
    monkeypatch.setattr(kb, "_EMBED_BACKOFF_S", 0)
    kb.index_document(kstore, "u1", "d1", GUIDE, FakeEmbedder(fail_times=2), chunk_budget=100)
    assert kstore.get_document("u1", "d1").status == "ready"  # third attempt succeeded

    kb.index_document(kstore, "u1", "d1", GUIDE, FakeEmbedder(fail_times=99), chunk_budget=100)
    doc = kstore.get_document("u1", "d1")
    assert doc.status == "failed" and "429" in doc.error
    assert kstore.chunks_for_documents("u1", ["d1"]) == []  # no half-indexed passages left behind


def test_the_library_passage_limit_is_enforced(kstore):
    kb.index_document(kstore, "u1", "d1", GUIDE, FakeEmbedder(), chunk_budget=1)
    doc = kstore.get_document("u1", "d1")
    assert doc.status == "failed" and "limit" in doc.error


def test_documents_still_indexing_are_not_searched(kstore):
    kb.index_document(kstore, "u1", "d1", GUIDE, FakeEmbedder(), chunk_budget=100)
    kstore.update_document("u1", "d1", status="processing")
    assert kb.store_context(kstore, "u1", "p1", FakeEmbedder()).search("hotel") == []


def test_reembedding_replaces_vectors_and_keeps_text(kstore):
    kb.index_document(kstore, "u1", "d1", GUIDE, FakeEmbedder(), chunk_budget=100)
    before = kstore.chunks_for_documents("u1", ["d1"])

    class Doubled(FakeEmbedder):
        def embed_documents(self, texts):
            return [[2 * x for x in _vector(t)] for t in texts]

    kb.reembed_library(kstore, "u1", Doubled())
    after = kstore.chunks_for_documents("u1", ["d1"])
    assert [c.text for c in after] == [c.text for c in before]
    assert after[0].embedding == [2 * x for x in before[0].embedding]
    assert kstore.get_document("u1", "d1").status == "ready"


def test_search_ignores_vectors_of_another_size():
    from agentic_platform.stores import KnowledgeChunk

    chunks = [
        KnowledgeChunk(id="a", tenant_id="u", document_id="d", ordinal=0, text="old", source="x", embedding=[1.0, 0.0]),
        KnowledgeChunk(id="b", tenant_id="u", document_id="d", ordinal=1, text="new", source="y", embedding=[1.0, 0.0, 0.0]),
    ]
    hits = kb.search(chunks, {"d": "f.txt"}, [1.0, 0.0, 0.0], k=5)
    assert [h.text for h in hits] == ["new"]


def test_tool_output_is_fenced_and_cited():
    out = kb.format_hits("q", [kb.Hit("guide.pdf", "page 3", "Akasa is cheapest.", 0.9)])
    assert out.startswith(kb.EXCERPTS_OPEN) and out.endswith(kb.EXCERPTS_CLOSE)
    assert "[guide.pdf — page 3]\nAkasa is cheapest." in out
    assert "No passages" in kb.format_hits("q", [])
