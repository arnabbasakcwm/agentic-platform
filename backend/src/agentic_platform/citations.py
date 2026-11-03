"""Mandatory source citations for answers built on web_search and knowledge_search.

1. **Numbered sources.** During one agent attempt every source those tools return is
   recorded in a `CitationLog` and numbered [1], [2], … in the order the agent first sees
   it (the same page or passage keeps its number). The tools show the model those
   numbers (tools.py), with each source's metadata.
2. **Shared rule.** `CITATION_RULES` is added to every agent's system prompt (graph_builder),
   so current and future agents follow it.
3. **Validator.** After the agent's answer: if it used sources and cites none, it is asked
   once to add them; if it still doesn't, the platform appends a Sources section built
   from the log and flags `citations_auto_appended`. Markers that don't map to a real
   source are stripped (listed in `citations_invalid`). The Sources section is always
   rebuilt from the log, so it can only list sources the tools really returned.
4. **Stored** with the output as structured data: `citations` (one dict per cited source).

`REQUIRE_CITATIONS` (env, default true) turns 2–4 on. It's read when a run starts, so a
deployed runtime follows its own environment.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.parse import urlparse

CITATION_RULES = """\
PLATFORM RULE — CITE YOUR SOURCES
Results from the web_search and knowledge_search tools come numbered [1], [2], … with
their title and URL (web) or document name and page/section (documents).
- Put the number of the source next to every claim you take from such a result, e.g.
  "Fares start at ₹7,004 [2]." Several sources: "[1][3]".
- End the answer with a "Sources" section listing each number you cited, one per line:
  "[n] Title — URL" for web pages, "[n] Document name, p. X" for documents.
- Cite only sources the tools returned to you in this task, by the number they came with.
  Never invent a source, a URL or a number.
- If the searches found nothing relevant, say so plainly instead of citing.
- If you used no search tool, don't add a Sources section."""


def require_citations() -> bool:
    return os.environ.get("REQUIRE_CITATIONS", "true").strip().lower() not in ("0", "false", "no", "off")


@dataclass
class CitationLog:
    """The sources one agent attempt's search tools returned, numbered from 1."""

    sources: list[dict[str, Any]] = field(default_factory=list)
    _index: dict[tuple[str, ...], int] = field(default_factory=dict)

    def _add(self, key: tuple[str, ...], entry: dict[str, Any]) -> int:
        if key in self._index:
            return self._index[key]
        n = len(self.sources) + 1
        entry = {"n": n, "source_id": str(n), **entry}
        self.sources.append(entry)
        self._index[key] = n
        return n

    def add_web(self, url: str, title: str, snippet: str = "") -> int:
        domain = urlparse(url).netloc
        return self._add(("web", url), {
            "kind": "web", "url": url, "title": (title or domain or url).strip(), "domain": domain,
            "retrieved_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "snippet": _short(snippet),
        })

    def add_document(self, document_id: str | None, document_name: str, location: str,
                     chunk_id: str | None, snippet: str = "") -> int:
        key = ("doc", chunk_id or f"{document_id or document_name}:{location}:{snippet[:80]}")
        return self._add(key, {
            "kind": "document", "document_id": document_id, "document_name": document_name,
            "location": location_label(location), "chunk_id": chunk_id, "snippet": _short(snippet),
        })

    def get(self, n: int) -> dict[str, Any] | None:
        return self.sources[n - 1] if 1 <= n <= len(self.sources) else None


def _short(text: str, limit: int = 300) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def location_label(source: str) -> str:
    """"page 4" → "p. 4"; "pages 3–5" → "pp. 3–5"; anything else unchanged."""
    s = (source or "").strip()
    m = re.match(r"^pages?\s+(.+)$", s, re.IGNORECASE)
    if m:
        return ("pp. " if s.lower().startswith("pages") else "p. ") + m.group(1)
    return s


def source_line(s: dict[str, Any]) -> str:
    if s.get("kind") == "web":
        return f"[{s['n']}] {s.get('title') or s.get('url')} — {s.get('url')}"
    loc = s.get("location")
    return f"[{s['n']}] {s.get('document_name') or 'Document'}" + (f", {loc}" if loc else "")


# [3] — but not a Markdown link's text ([3](https://…)) or a footnote definition [^3].
MARKER = re.compile(r"\[(\d{1,3})\](?!\()")
_SOURCES_HEADING = re.compile(
    r"^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*|__)?(?:Sources|References|Citations):?(?:\*\*|__)?[ \t]*:?[ \t]*$",
    re.IGNORECASE | re.MULTILINE,
)


def split_sources(content: str) -> tuple[str, str]:
    """(body, the trailing Sources section or "")."""
    matches = list(_SOURCES_HEADING.finditer(content or ""))
    if not matches:
        return content or "", ""
    cut = matches[-1].start()
    return content[:cut].rstrip(), content[cut:]


def markers(text: str) -> list[int]:
    return [int(m) for m in MARKER.findall(text or "")]


@dataclass
class CitationResult:
    content: str
    citations: list[dict[str, Any]]
    auto_appended: bool = False
    invalid: list[int] = field(default_factory=list)
    reprompted: bool = False

    def meta(self) -> dict[str, Any]:
        return {
            "citations": self.citations,
            "citations_auto_appended": self.auto_appended,
            **({"citations_invalid": self.invalid} if self.invalid else {}),
        }


def enforce(content: str, log: CitationLog, reask: Callable[[str], str | None]) -> CitationResult:
    """Make an answer that used search results cite them (see the module docstring).
    `reask(instruction)` asks the agent once more and returns its new content, or None."""
    body, _ = split_sources(content)
    valid = [n for n in markers(body) if log.get(n)]
    reprompted = False
    if not valid:
        reprompted = True
        listing = "\n".join(source_line(s) for s in log.sources)
        retry = reask(
            "Your answer uses search results but cites none of them. Rewrite it with the "
            "source number next to each claim taken from a result, e.g. [1], and end it with "
            "a \"Sources\" section listing the numbers you cited. Use only these sources:\n" + listing
        )
        if retry:
            retry_body, _ = split_sources(retry)
            if any(log.get(n) for n in markers(retry_body)):
                content, body = retry, retry_body
    invalid = sorted({n for n in markers(body) if not log.get(n)})
    if invalid:
        bad = set(invalid)
        body = MARKER.sub(lambda m: "" if int(m.group(1)) in bad else m.group(0), body)
        body = re.sub(r"[ \t]+([.,;:!?])", r"\1", body)  # "claim [9]." → "claim."
    cited = sorted(set(n for n in markers(body) if log.get(n)))
    auto = not cited
    chosen = [log.get(n) for n in (range(1, len(log.sources) + 1) if auto else cited)]
    section = "## Sources\n" + "\n".join(source_line(s) for s in chosen)
    return CitationResult(
        content=f"{body.rstrip()}\n\n{section}",
        citations=[dict(s) for s in chosen],
        auto_appended=auto,
        invalid=invalid,
        reprompted=reprompted,
    )
