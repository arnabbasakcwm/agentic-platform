// Citations in agent answers: [n] markers that point at the structured sources stored
// with the output (`output.citations`, see backend citations.py).

// [3] — not a Markdown link's text ([3](…)), matching the backend's MARKER.
export const MARKER = /\[(\d{1,3})\](?!\()/g;
const SOURCES_HEADING = /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*|__)?(?:Sources|References|Citations):?(?:\*\*|__)?[ \t]*:?[ \t]*$/gim;

/** { body, sources }: the answer without its trailing "Sources" section (shown as a panel). */
export function splitSources(content) {
  const text = content ?? "";
  let last = null;
  for (const m of text.matchAll(SOURCES_HEADING)) last = m;
  if (!last) return { body: text, sources: "" };
  return { body: text.slice(0, last.index).trimEnd(), sources: text.slice(last.index) };
}

/** The output's citations by number (only well-formed ones; old outputs have none). */
export function citationMap(citations) {
  const map = new Map();
  for (const c of citations ?? []) {
    if (c && Number.isInteger(c.n)) map.set(c.n, c);
  }
  return map;
}

/** Only http(s) links open; anything else (javascript:, data:) is shown as text. */
export function safeHref(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

export function citationLabel(c) {
  if (c.kind === "document") {
    return `${c.document_name ?? "Document"}${c.location ? `, ${c.location}` : ""}`;
  }
  return c.title || c.domain || c.url || "Source";
}

const SKIP = new Set(["code", "pre", "a", "button"]);

/**
 * A rehype plugin: [n] markers in text (not in code, links or buttons) become
 * <cite-marker n="…"> elements, which Markdown renders as clickable markers. Markers
 * with no matching source are left as text.
 */
export function rehypeCitations({ known }) {
  return (tree) => {
    const walk = (node) => {
      if (!node.children) return;
      const next = [];
      for (const child of node.children) {
        if (child.type === "element" && SKIP.has(child.tagName)) {
          next.push(child);
          continue;
        }
        if (child.type === "text" && MARKER.test(child.value)) {
          MARKER.lastIndex = 0;
          let at = 0;
          for (const m of child.value.matchAll(MARKER)) {
            const n = Number(m[1]);
            if (!known.has(n)) continue;
            if (m.index > at) next.push({ type: "text", value: child.value.slice(at, m.index) });
            next.push({ type: "element", tagName: "cite-marker", properties: { n: String(n) }, children: [] });
            at = m.index + m[0].length;
          }
          if (at < child.value.length) next.push({ type: "text", value: child.value.slice(at) });
          continue;
        }
        MARKER.lastIndex = 0;
        walk(child);
        next.push(child);
      }
      node.children = next;
    };
    walk(tree);
  };
}
