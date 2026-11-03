import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { rehypeCitations } from "../lib/citations.js";
import { CitationMarker } from "./Citations.jsx";
import { detectTable } from "../lib/tabular.js";
import { DataTable, RawFallback, TableBoundary } from "./DataTable.jsx";

/** The text of a ```csv / ```tsv block, if `node` (a <pre>) is one. */
function fencedTable(node) {
  const code = node?.children?.[0];
  const classes = code?.properties?.className ?? [];
  const lang = classes.find((c) => /^language-(csv|tsv)$/.test(c));
  if (!lang) return null;
  const text = (code.children ?? []).map((c) => c.value ?? "").join("");
  return { lang: lang.slice("language-".length), text };
}

// Agent output is model-written text: render it as GitHub-flavored Markdown, never as
// HTML. `skipHtml` drops any raw HTML in the text, and react-markdown's default URL
// handling neutralises javascript: links — nothing here uses dangerouslySetInnerHTML.
// The lines where ```csv / ```tsv blocks start, to number the tables of one answer.
const TABLE_FENCE = /^\s*(```|~~~)\s*(csv|tsv)\b/i;

function tableFenceLines(text) {
  return (text ?? "")
    .split(/\r?\n/)
    .map((line, i) => (TABLE_FENCE.test(line) ? i + 1 : null))
    .filter((n) => n !== null);
}

/**
 * A ```csv block in an answer shows as a table (with Raw, Copy and Download CSV), like
 * a CSV answer. `fileBase` names the download; several tables in one answer are -1, -2…
 */
function tableBlock(fileBase, fenceLines) {
  return function Pre({ node, ...props }) {
    const fenced = fencedTable(node);
    if (!fenced) return <pre {...props} />;
    const table = detectTable(fenced.text, fenced.lang === "tsv" ? "text/tab-separated-values" : "text/csv");
    if (!table || table.error) return <RawFallback raw={fenced.text} reason={table?.error} />;
    const index = fenceLines.indexOf(node?.position?.start?.line) + 1;
    const suffix = fenceLines.length > 1 && index > 0 ? `-${index}` : "";
    const label = fenceLines.length > 1 && index > 0 ? `Table ${index}` : "Table";
    return (
      <TableBoundary raw={fenced.text}>
        <DataTable table={table} raw={fenced.text} label={label} fileName={`${fileBase}_table${suffix}.csv`} />
      </TableBoundary>
    );
  };
}

const components = {
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  // Wide tables scroll inside their own box instead of widening the page.
  table: ({ node, ...props }) => (
    <div className="md__table" tabIndex={0} role="region" aria-label="Table">
      <table {...props} />
    </div>
  ),
};

/**
 * `citations` (a Map of n → citation, optional): [n] markers that match one become
 * clickable markers with a preview; `onCite(n)` is called when one is pressed.
 * `fileBase` names CSV downloads of the answer's tables.
 */
export function Markdown({ children, citations, onCite, fileBase = "output" }) {
  const cited = citations?.size > 0;
  const rehypePlugins = useMemo(
    () => (cited ? [[rehypeCitations, { known: citations }]] : []),
    [cited, citations],
  );
  const fenceLines = useMemo(() => tableFenceLines(children), [children]);
  const parts = useMemo(
    () => ({
      ...components,
      pre: tableBlock(fileBase, fenceLines),
      ...(cited
        ? {
            "cite-marker": ({ n }) => {
              const citation = citations.get(Number(n));
              return citation ? <CitationMarker citation={citation} onCite={onCite} /> : `[${n}]`;
            },
          }
        : {}),
    }),
    [cited, citations, onCite, fileBase, fenceLines],
  );
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={parts}
        skipHtml
      >
        {children ?? ""}
      </ReactMarkdown>
    </div>
  );
}
