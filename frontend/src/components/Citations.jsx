import { ExternalLink, FileText, Globe } from "lucide-react";
import { useId } from "react";
import { citationLabel, safeHref } from "../lib/citations.js";
import { Pill } from "./ui.jsx";

/**
 * An inline [n]: a button that jumps to the source in the Sources panel, with a preview
 * (title, where it's from, the snippet) on hover and keyboard focus.
 */
export function CitationMarker({ citation, onCite }) {
  const tip = useId();
  const where = citation.kind === "document" ? citation.location : citation.domain;
  return (
    <span className="cite">
      <button
        type="button"
        className="cite__marker"
        aria-label={`Source ${citation.n}: ${citationLabel(citation)}`}
        aria-describedby={tip}
        onClick={() => onCite?.(citation.n)}
      >
        [{citation.n}]
      </button>
      <span className="cite__tip" role="tooltip" id={tip}>
        <span className="cite__tiptitle">{citationLabel(citation)}</span>
        {where && <span className="cite__tipwhere">{where}</span>}
        {citation.snippet && <span className="cite__tipsnippet">{citation.snippet}</span>}
      </span>
    </span>
  );
}

/**
 * The answer's sources, from the structured citations stored with it. Web sources open
 * in a new tab (rel="noopener noreferrer"); documents name the file and page (there is no
 * document viewer to open). A badge says when the platform added them because the answer
 * cited none.
 */
export function SourcesPanel({ agentId, citations, autoAppended }) {
  if (!citations?.length) return null;
  const headingId = `sources-${agentId}`;
  return (
    <section className="sources" aria-labelledby={headingId}>
      <header className="sources__head">
        <h4 className="sources__title" id={headingId}>
          Sources
        </h4>
        {autoAppended && (
          <span title="The answer cited none of its search results, so the platform listed every source the agent's searches returned.">
            <Pill tone="warn">Added by the platform</Pill>
          </span>
        )}
      </header>
      <ol className="sources__list">
        {citations.map((c) => {
          const href = c.kind === "web" ? safeHref(c.url) : null;
          return (
            <li key={c.n} id={`source-${agentId}-${c.n}`} className="sources__item" tabIndex={-1}>
              <span className="sources__n">[{c.n}]</span>
              {c.kind === "document" ? (
                <FileText size={14} aria-hidden="true" className="sources__icon" />
              ) : (
                <Globe size={14} aria-hidden="true" className="sources__icon" />
              )}
              <span className="sources__body">
                {href ? (
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    {citationLabel(c)}
                    <ExternalLink size={12} aria-hidden="true" />
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                ) : (
                  <span className="sources__name">{citationLabel(c)}</span>
                )}
                <span className="sources__meta">
                  {c.kind === "document" ? "Document" : (c.domain ?? c.url)}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Scroll to a source in an agent's panel and focus it (flashes via :focus). */
export function showSource(agentId, n) {
  const item = document.getElementById(`source-${agentId}-${n}`);
  if (!item) return;
  item.scrollIntoView({ block: "nearest", behavior: "smooth" });
  item.focus({ preventScroll: true });
}
