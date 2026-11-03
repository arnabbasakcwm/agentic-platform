"""Emailing a run's output: validation, limits, attachments from the export pipeline, the
rate limit, and failures that stay on the server — with the SMTP transport mocked, so no
real email is ever sent."""

import io
import logging
from email.message import EmailMessage

import pytest
from fastapi.testclient import TestClient

import agentic_platform.app as app_module
from agentic_platform import mailer
from agentic_platform.agent_schema import AgentPlan, AgentSpec, LLMConfig
from agentic_platform.stores import (
    InMemoryKnowledgeStore,
    InMemoryProjectStore,
    InMemoryUsageStore,
    InMemoryUserStore,
    RunRecord,
)

ANSWER = "## Fares\nIndiGo is cheapest [1].\n\n## Sources\n[1] IndiGo — https://goindigo.in"
CITATIONS = [{"n": 1, "kind": "web", "title": "IndiGo", "url": "https://goindigo.in"}]


@pytest.fixture
def sent(monkeypatch):
    """Configure SMTP by env and capture messages instead of sending them."""
    for key, value in {"SMTP_HOST": "smtp.example.com", "SMTP_PORT": "587", "SMTP_USER": "u",
                       "SMTP_PASS": "s3cret-pass", "MAIL_FROM": "Agentic <noreply@example.com>"}.items():
        monkeypatch.setenv(key, value)
    box: list[tuple[mailer.MailConfig, EmailMessage]] = []
    monkeypatch.setattr(mailer, "transport", lambda config, message: box.append((config, message)))
    mailer.limiter.reset()
    yield box
    mailer.limiter.reset()


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


def _run(api, h):
    pid = api.post("/projects", json={"brief": "Goa fares"}, headers=h).json()["project_id"]
    user_id = api.get("/auth/me", headers=h).json()["id"]
    app_module._runs.create(RunRecord(id="r1", tenant_id=user_id, project_id=pid, status="completed",
                                      outputs={"analyst": {"content": ANSWER, "citations": CITATIONS}}))
    return pid


def _body(**overrides):
    body = {"to": ["bob@example.com"], "subject": "Goa fares", "message": "See attached.",
            "formats": ["pdf"], "include_body": False}
    return {**body, **overrides}


def test_sends_with_every_chosen_attachment_and_the_body(api, sent):
    h = api.login("ada@example.com")
    pid = _run(api, h)
    r = api.post(f"/projects/{pid}/runs/r1/email", headers=h, json=_body(
        to=["bob@example.com", "carol@example.com"], cc=["dan@example.com"],
        formats=["docx", "pdf", "csv", "pdf"], include_body=True, agent_id="analyst"))
    assert r.status_code == 200, r.text
    assert r.json()["recipients"] == 3
    assert len(sent) == 1
    config, message = sent[0]
    assert config.host == "smtp.example.com" and config.port == 587
    assert message["To"] == "bob@example.com, carol@example.com" and message["Cc"] == "dan@example.com"
    assert message["Reply-To"] == "ada@example.com" and message["From"] == "Agentic <noreply@example.com>"
    parts = {p.get_filename(): p for p in message.iter_attachments()}
    assert sorted(n.rsplit(".", 1)[1] for n in parts) == ["csv", "docx", "pdf"]  # duplicates dropped
    pdf = next(p for n, p in parts.items() if n.endswith(".pdf"))
    assert pdf.get_content().startswith(b"%PDF-")
    from docx import Document

    docx = next(p for n, p in parts.items() if n.endswith(".docx"))
    assert any(par.text == "Sources" for par in Document(io.BytesIO(docx.get_content())).paragraphs)
    text = message.get_body(("plain",)).get_content()
    assert "See attached." in text and "IndiGo is cheapest [1]." in text and "https://goindigo.in" in text


def test_body_left_out_unless_asked(api, sent):
    h = api.login("ada@example.com")
    pid = _run(api, h)
    api.post(f"/projects/{pid}/runs/r1/email", headers=h, json=_body())
    text = sent[0][1].get_body(("plain",)).get_content()
    assert "IndiGo is cheapest" not in text


@pytest.mark.parametrize("change, fragment", [
    ({"to": []}, "to"),
    ({"to": ["not-an-email"]}, "to"),
    ({"cc": ["bad@"]}, "cc"),
    ({"to": [f"u{i}@example.com" for i in range(6)], "cc": [f"c{i}@example.com" for i in range(5)]}, "at most 10"),
    ({"to": [f"u{i}@example.com" for i in range(11)]}, "to"),
    ({"formats": []}, "formats"),
    ({"formats": ["xlsx"]}, "formats"),
    ({"subject": ""}, "subject"),
    ({"subject": "Hi\r\nBcc: evil@example.com"}, "single line"),
])
def test_invalid_requests_are_rejected_clearly(api, sent, change, fragment):
    h = api.login("ada@example.com")
    pid = _run(api, h)
    r = api.post(f"/projects/{pid}/runs/r1/email", headers=h, json=_body(**change))
    assert r.status_code == 422
    assert fragment in r.text
    assert sent == []


def test_attachments_over_20_mb_are_refused(api, sent, monkeypatch):
    h = api.login("ada@example.com")
    pid = _run(api, h)
    monkeypatch.setattr(app_module.export_mod, "render", lambda doc, fmt: b"x" * (11 * 1024 * 1024))
    r = api.post(f"/projects/{pid}/runs/r1/email", headers=h, json=_body(formats=["pdf", "docx"]))
    assert r.status_code == 413 and r.json()["error_type"] == "AttachmentsTooLarge"
    assert sent == []


def test_rate_limited_per_user(api, sent, monkeypatch):
    monkeypatch.setattr(mailer, "limiter", mailer.RateLimiter(2, 3600))
    h = api.login("ada@example.com")
    pid = _run(api, h)
    for _ in range(2):
        assert api.post(f"/projects/{pid}/runs/r1/email", headers=h, json=_body()).status_code == 200
    r = api.post(f"/projects/{pid}/runs/r1/email", headers=h, json=_body())
    assert r.status_code == 429 and r.json()["error_type"] == "RateLimited"
    # Another user has their own allowance.
    other = api.login("eve@example.com")
    other_pid = _run(api, other)
    assert api.post(f"/projects/{other_pid}/runs/r1/email", headers=other, json=_body()).status_code == 200


def test_a_sending_failure_is_logged_not_leaked(api, sent, monkeypatch, caplog):
    def boom(config, message):
        raise ConnectionRefusedError(f"smtp.example.com refused login for {config.user}:{config.password}")

    monkeypatch.setattr(mailer, "transport", boom)
    h = api.login("ada@example.com")
    pid = _run(api, h)
    with caplog.at_level(logging.ERROR):
        r = api.post(f"/projects/{pid}/runs/r1/email", headers=h, json=_body())
    assert r.status_code == 502
    assert r.json() == {"error_type": "MailSendFailed", "message": "the email couldn't be sent; try again later",
                        "details": None}
    assert "s3cret-pass" not in r.text and "smtp.example.com" not in r.text
    assert any("email of run r1" in rec.getMessage() for rec in caplog.records)


def test_not_configured_is_a_503(api, monkeypatch):
    monkeypatch.delenv("SMTP_HOST", raising=False)
    h = api.login("ada@example.com")
    pid = _run(api, h)
    r = api.post(f"/projects/{pid}/runs/r1/email", headers=h, json=_body())
    assert r.status_code == 503 and r.json()["error_type"] == "MailNotConfigured"


def test_needs_sign_in_and_hides_other_users_runs(api, sent):
    h = api.login("ada@example.com")
    pid = _run(api, h)
    assert api.post(f"/projects/{pid}/runs/r1/email", json=_body()).status_code == 401
    other = api.login("eve@example.com")
    assert api.post(f"/projects/{pid}/runs/r1/email", headers=other, json=_body()).status_code == 404
    assert sent == []


def test_rate_limiter_window():
    limiter = mailer.RateLimiter(2, 60)
    assert limiter.allow("u", now=0) and limiter.allow("u", now=1)
    assert not limiter.allow("u", now=30)
    assert limiter.allow("u", now=61)


def test_mail_config_from_env(monkeypatch):
    monkeypatch.delenv("SMTP_HOST", raising=False)
    assert mailer.mail_config() is None
    monkeypatch.setenv("SMTP_HOST", "smtp.example.com")
    monkeypatch.setenv("MAIL_FROM", "noreply@example.com")
    monkeypatch.setenv("SMTP_SECURITY", "ssl")
    monkeypatch.delenv("SMTP_PORT", raising=False)
    config = mailer.mail_config()
    assert config.port == 465 and config.security == "ssl"
