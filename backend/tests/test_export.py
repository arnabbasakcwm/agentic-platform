"""Run exports: the shared export model, Markdown → blocks, tabular detection, CSV safety,
and the export endpoint (DOCX parsed back, PDF magic bytes, CSV parsed back) — offline."""

import csv
import io
from datetime import datetime, timezone
from types import SimpleNamespace as NS

import pytest
from fastapi.testclient import TestClient

import agentic_platform.app as app_module
from agentic_platform import export as ex
from agentic_platform.agent_schema import AgentPlan, AgentSpec, LLMConfig
from agentic_platform.stores import (
    InMemoryKnowledgeStore,
    InMemoryProjectStore,
    InMemoryUsageStore,
    InMemoryUserStore,
    RunRecord,
)

ANSWER = """# Cheapest fares
Fares in **₹** from [IndiGo](https://goindigo.in) [1].

- IndiGo: 7,004 [1]
- From the price list [2]

| Airline | Fare |
|---|---|
| IndiGo | 7004 |

## Sources
[1] IndiGo — https://goindigo.in
[2] fares.pdf, p. 3
"""
CITATIONS = [
    {"n": 1, "kind": "web", "source_id": "1", "title": "IndiGo", "url": "https://goindigo.in", "domain": "goindigo.in"},
    {"n": 2, "kind": "document", "source_id": "2", "document_name": "fares.pdf", "location": "p. 3"},
]


def _project(agents=("analyst",)):
    plan = NS(agents=[NS(id=a, role=f"{a} role") for a in agents])
    return NS(id="p1", display_name="Goa trip", plan=plan)


def _run(outputs):
    return NS(id="run0123456789", outputs=outputs, started_at=datetime(2026, 11, 3, 9, 30, tzinfo=timezone.utc))


# ------------------------------------------------------------------ model
def test_markdown_becomes_blocks():
    blocks = ex.parse_markdown(ANSWER)
    assert [b.kind for b in blocks] == ["heading", "paragraph", "list", "table", "heading", "paragraph"]
    assert blocks[2].items == ["IndiGo: 7,004 [1]", "From the price list [2]"]
    assert blocks[3].rows == [["Airline", "Fare"], ["IndiGo", "7004"]]
    code = ex.parse_markdown("```python\nprint(1)\n```")
    assert code[0].kind == "code" and code[0].text == "print(1)" and code[0].lang == "python"


def test_export_model_takes_structured_citations_and_drops_the_text_sources():
    doc = ex.build_export(_project(), _run({"analyst": {"content": ANSWER, "citations": CITATIONS}}), "analyst")
    sec = doc.sections[0]
    assert [s.label() for s in sec.sources] == ["[1] IndiGo — https://goindigo.in", "[2] fares.pdf, p. 3"]
    assert all(b.text != "Sources" for b in sec.blocks)  # rendered once, from the structured list
    assert doc.agent_label == "analyst" and doc.run_id == "run0123456789"


def test_old_outputs_without_citations_still_export():
    doc = ex.build_export(_project(), _run({"analyst": {"content": "Just text."}}), "analyst")
    assert doc.sections[0].sources == []
    for fmt in ("docx", "pdf", "csv"):
        assert ex.render(doc, fmt)


def test_whole_run_has_every_finished_agent_and_unknown_agents_are_refused():
    run = _run({"a": {"content": "A"}, "b": {"content": "B"}})
    doc = ex.build_export(_project(("a", "b", "c")), run)
    assert [s.agent_id for s in doc.sections] == ["a", "b"]
    with pytest.raises(ex.ExportUnavailable) as missing:
        ex.build_export(_project(("a", "b", "c")), run, "c")
    assert missing.value.status == 409
    with pytest.raises(ex.ExportUnavailable) as unknown:
        ex.build_export(_project(("a", "b", "c")), run, "zzz")
    assert unknown.value.status == 404
    with pytest.raises(ex.ExportUnavailable):
        ex.build_export(_project(), _run({}))


def test_filename_follows_the_pattern_and_is_safe():
    doc = ex.build_export(NS(id="p", display_name="Goa / trip: “best”", plan=NS(agents=[])),
                          _run({"x": {"content": "y"}}), "x")
    assert ex.filename(doc, "pdf") == "Goa-trip-best_x_run01234_20261103-0930.pdf"


# ------------------------------------------------------------------ tabular detection
@pytest.mark.parametrize("text, rows", [
    ("a,b\n1,2\n3,4", [["a", "b"], ["1", "2"], ["3", "4"]]),
    ("a;b\n1;2\n3;4", [["a", "b"], ["1", "2"], ["3", "4"]]),
    ("a\tb\n1\t2\n3\t4", [["a", "b"], ["1", "2"], ["3", "4"]]),
    ('name,note\n"Smith, J","said ""hi""\nthen left"\nAl,ok',
     [["name", "note"], ["Smith, J", 'said "hi"\nthen left'], ["Al", "ok"]]),
    ('[{"a": 1, "b": "x"}, {"a": 2, "c": true}]', [["a", "b", "c"], ["1", "x", ""], ["2", "", "True"]]),
    ("| a | b |\n|---|---|\n| 1 | 2 |", [["a", "b"], ["1", "2"]]),
    ("```csv\na,b\n1,2\n```", [["a", "b"], ["1", "2"]]),
])
def test_tables_are_detected(text, rows):
    assert ex.detect_table(text) == rows


@pytest.mark.parametrize("text", [
    "Just a sentence, with a comma.",
    "One line only,a,b",
    "Hello, world\nFoo, bar",  # too short to tell from prose
    "This sentence, which goes on, is prose.\nSo is this one, written at length, by a model.\nA third, line.",
    "# Heading\nSome text, more text.\nAnother line without the same commas",
    "Intro\n\n| a | b |\n|---|---|\n| 1 | 2 |",  # a table inside prose isn't a tabular answer
    "",
])
def test_prose_is_not_a_table(text):
    assert ex.detect_table(text) is None


# ------------------------------------------------------------------ CSV safety
@pytest.mark.parametrize("value, expected", [
    ("=SUM(A1)", "'=SUM(A1)"), ("+1", "'+1"), ("-5", "'-5"), ("@cmd", "'@cmd"),
    ("\tx", "'\tx"), ("\rx", "'\rx"), ("safe", "safe"), ("a=b", "a=b"), (None, ""), (7, "7"),
])
def test_csv_cells_are_protected_from_formula_injection(value, expected):
    assert ex.safe_cell(value) == expected


def test_csv_of_prose_has_sections_bom_quoting_and_sources():
    doc = ex.build_export(_project(), _run({"analyst": {"content": ANSWER + '\nSaid "hi", =1+1', "citations": CITATIONS}}), "analyst")
    data = ex.render_csv(doc)
    assert data.startswith(b"\xef\xbb\xbf")
    rows = list(csv.reader(io.StringIO(data.decode("utf-8-sig"))))
    assert rows[0] == ["run_id", "agent", "timestamp", "section", "content", "sources"]
    assert rows[1][3] == "Cheapest fares"
    assert "[1] IndiGo — https://goindigo.in" in rows[1][5] and "[2] fares.pdf, p. 3" in rows[1][5]
    assert all(not cell.startswith(("=", "+", "-", "@")) for row in rows for cell in row)


def test_csv_of_a_table_is_that_table():
    doc = ex.build_export(_project(), _run({"analyst": {"content": "a,b\n=1,2\n3,4\n"}}), "analyst")
    rows = list(csv.reader(io.StringIO(ex.render_csv(doc).decode("utf-8-sig"))))
    assert rows == [["a", "b"], ["'=1", "2"], ["3", "4"]]


# ------------------------------------------------------------------ endpoint
@pytest.fixture
def api(monkeypatch):
    plan = AgentPlan(
        agents=[AgentSpec(id="analyst", role="r", system_prompt="p",
                          llm=LLMConfig(provider="google_genai", model="gemini-3.1-pro-preview"))],
        orchestration_pattern="sequential",
    )
    monkeypatch.setattr(app_module, "plan_project", lambda **kw: plan)
    for name, store in [("_store", InMemoryProjectStore()), ("_users", InMemoryUserStore()),
                        ("_knowledge", InMemoryKnowledgeStore()), ("_usage", InMemoryUsageStore())]:
        monkeypatch.setattr(app_module, name, store)
    client = TestClient(app_module.app)

    def login(email):
        token = client.post("/auth/register", json={"email": email, "password": "a-long-password"}).json()["access_token"]
        return {"Authorization": f"Bearer {token}"}

    client.login = login
    return client


def _saved_run(api, h, content=ANSWER, citations=CITATIONS):
    pid = api.post("/projects", json={"brief": "Goa fares"}, headers=h).json()["project_id"]
    user_id = api.get("/auth/me", headers=h).json()["id"]
    app_module._runs.create(RunRecord(
        id="r1", tenant_id=user_id, project_id=pid, status="completed",
        outputs={"analyst": {"content": content, "data": {}, "citations": citations}},
    ))
    return pid


def test_docx_export_is_a_real_word_file_with_links(api):
    from docx import Document

    h = api.login("ada@example.com")
    pid = _saved_run(api, h)
    r = api.get(f"/projects/{pid}/runs/r1/export?format=docx&agent_id=analyst", headers=h)
    assert r.status_code == 200
    assert r.headers["content-type"] == ex.MEDIA_TYPES["docx"]
    assert r.headers["content-disposition"].startswith('attachment; filename="Goa-fares_analyst_r1_')
    assert r.headers["content-disposition"].split(";")[1].strip().endswith('.docx"')
    d = Document(io.BytesIO(r.content))
    styles = [(p.style.name, p.text) for p in d.paragraphs]
    assert ("Heading 1", "Cheapest fares") in styles
    assert any(s == "List Bullet" for s, _ in styles)
    assert ("Heading 1", "Sources") in styles
    assert d.tables and d.tables[0].cell(1, 0).text == "IndiGo"
    links = [rel.target_ref for rel in d.part.rels.values() if rel.reltype.endswith("/hyperlink")]
    assert "https://goindigo.in" in links


def test_pdf_export_is_a_pdf(api):
    h = api.login("ada@example.com")
    pid = _saved_run(api, h)
    r = api.get(f"/projects/{pid}/runs/r1/export?format=pdf", headers=h)
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/pdf"
    assert r.content.startswith(b"%PDF-")
    assert b"/URI (https://goindigo.in)" in r.content  # the source is a clickable link
    from pypdf import PdfReader

    text = PdfReader(io.BytesIO(r.content)).pages[0].extract_text()
    assert "Sources" in text and "Page 1 of 1" in text


def test_csv_export_parses_back(api):
    h = api.login("ada@example.com")
    pid = _saved_run(api, h)
    r = api.get(f"/projects/{pid}/runs/r1/export?format=csv&agent_id=analyst", headers=h)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")
    rows = list(csv.reader(io.StringIO(r.content.decode("utf-8-sig"))))
    assert rows[0][0] == "run_id" and rows[1][0] == "r1"


def test_export_needs_sign_in_and_hides_other_users_runs(api):
    h = api.login("ada@example.com")
    pid = _saved_run(api, h)
    assert api.get(f"/projects/{pid}/runs/r1/export?format=pdf").status_code == 401
    other = api.login("eve@example.com")
    r = api.get(f"/projects/{pid}/runs/r1/export?format=pdf", headers=other)
    # Someone else's project is a 404, never a 403 (it doesn't reveal that it exists).
    assert r.status_code == 404


def test_export_rejects_bad_input(api):
    h = api.login("ada@example.com")
    pid = _saved_run(api, h)
    assert api.get(f"/projects/{pid}/runs/r1/export?format=xlsx", headers=h).status_code == 422
    assert api.get(f"/projects/{pid}/runs/nope/export?format=pdf", headers=h).status_code == 404
    r = api.get(f"/projects/{pid}/runs/r1/export?format=pdf&agent_id=ghost", headers=h)
    assert r.status_code == 404 and r.json()["error_type"] == "ExportUnavailable"
