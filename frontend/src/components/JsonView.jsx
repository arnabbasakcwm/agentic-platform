import { useState } from "react";
import { Icon } from "./icons.jsx";

// Tokens of pretty-printed JSON: strings (keys when followed by a colon), literals,
// numbers. Highlighting builds React spans — no HTML strings, no innerHTML.
const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

export function highlightJson(text) {
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const [whole, str, colon, literal] = match;
    let kind = "number";
    if (str !== undefined) kind = colon ? "key" : "string";
    else if (literal !== undefined) kind = "literal";
    parts.push(
      <span key={match.index} className={`json__${kind}`}>
        {kind === "key" ? str : whole}
      </span>,
    );
    if (kind === "key") parts.push(colon);
    last = match.index + whole.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function CopyButton({ text, label = "Copy" }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be refused (permissions, insecure context); nothing to do.
    }
  }

  return (
    <button type="button" className="btn btn--sm btn--ghost" onClick={copy} aria-label={label}>
      <Icon name={copied ? "check" : "copy"} size={13} />
      <span aria-live="polite">{copied ? "Copied" : label}</span>
    </button>
  );
}

export function JsonView({ value }) {
  const text = JSON.stringify(value, null, 2);
  return (
    <div className="json">
      <div className="json__bar">
        <CopyButton text={text} label="Copy JSON" />
      </div>
      <pre className="json__code" tabIndex={0} aria-label="Raw JSON">
        <code>{highlightJson(text)}</code>
      </pre>
    </div>
  );
}
