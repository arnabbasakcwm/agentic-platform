import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { rehypeCitations } from "../lib/citations.js";
import { CitationMarker } from "./Citations.jsx";
import { detectTable } from "../lib/tabular.js";
import { DataTable, RawFallback, TableBoundary } from "./DataTable.jsx";
import { TableDownload } from "./TableDownload.jsx";

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
// The lines where the answer's tables start (a ```csv / ```tsv block, or the header row of
// a Markdown table), in order: they number the tables of one answer for download names.
const TABLE_FENCE = /^\s*(```|~~~)\s*(csv|tsv)\b/i;
const FENCE = /^\s*(```|~~~)/;
const PIPE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function tableLines(text) {
  const lines = (text ?? "").split(/\r?\n/);
  const starts = [];
  let inCode = false;
  lines.forEach((line, i) => {
    if (FENCE.test(line)) {
      if (!inCode && TABLE_FENCE.test(line)) starts.push(i + 1);
      inCode = !inCode;
      return;
    }
    // A header row, then a separator row like |---|:--:|, makes a Markdown table.
    const next = lines[i + 1] ?? "";
    if (!inCode && line.includes("|") && next.includes("-") && PIPE_SEPARATOR.test(next) && next.includes("|"))
      starts.push(i + 1);
  });
  return starts;
}

// The text of a hast node (what a cell shows, without its formatting).
const hastText = (n) => (n.type === "text" ? n.value : (n.children ?? []).map(hastText).join(""));

/** A rendered Markdown table's header and rows, read from its syntax tree. */
function tableFromHast(node) {
  const rows = [];
  const walk = (n) => {
    if (n.tagName === "tr") {
      rows.push((n.children ?? []).filter((c) => c.tagName === "th" || c.tagName === "td").map((c) => hastText(c).trim()));
    } else (n.children ?? []).forEach(walk);
  };
  walk(node);
  return rows.length ? { header: rows[0], rows: rows.slice(1) } : null;
}

/**
 * A ```csv block in an answer shows as a table (with Raw, Copy and Download CSV), like
 * a CSV answer. `fileBase` names the download; several tables in one answer are -1, -2…
 */
function tableBlock(fileBase, lines) {
  return function Pre({ node, ...props }) {
    const fenced = fencedTable(node);
    if (!fenced) return <pre {...props} />;
    const table = detectTable(fenced.text, fenced.lang === "tsv" ? "text/tab-separated-values" : "text/csv");
    if (!table || table.error) return <RawFallback raw={fenced.text} reason={table?.error} />;
    const index = lines.indexOf(node?.position?.start?.line) + 1;
    const suffix = lines.length > 1 && index > 0 ? `-${index}` : "";
    const label = lines.length > 1 && index > 0 ? `Table ${index}` : "Table";
    return (
      <TableBoundary raw={fenced.text}>
        <DataTable table={table} raw={fenced.text} label={label} fileName={`${fileBase}_table${suffix}.csv`} />
      </TableBoundary>
    );
  };
}

/**
 * A Markdown table in a report: wide ones scroll inside their own box instead of widening
 * the page, and every one can be downloaded as its own CSV, like the other tables.
 */
function pipeTable(fileBase, lines) {
  return function Table({ node, ...props }) {
    const data = tableFromHast(node);
    const index = lines.indexOf(node?.position?.start?.line) + 1;
    const many = lines.length > 1 && index > 0;
    return (
      <div className="md__tablewrap">
        {data && (
          <div className="tablebar">
            <TableDownload
              header={data.header}
              rows={data.rows}
              fileName={`${fileBase}_table${many ? `-${index}` : ""}.csv`}
              label={many ? `Table ${index}` : "Table"}
            />
          </div>
        )}
        <div className="md__table" tabIndex={0} role="region" aria-label="Table">
          <table {...props} />
        </div>
      </div>
    );
  };
}

const components = {
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
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
  const lines = useMemo(() => tableLines(children), [children]);
  // Its own memo: a new `pre` type would remount every table (losing sort, page and
  // Raw/Table) whenever an unrelated prop such as `onCite` changes identity.
  const pre = useMemo(() => tableBlock(fileBase, lines), [fileBase, lines]);
  const table = useMemo(() => pipeTable(fileBase, lines), [fileBase, lines]);
  const parts = useMemo(
    () => ({
      ...components,
      pre,
      table,
      ...(cited
        ? {
            "cite-marker": ({ n }) => {
              const citation = citations.get(Number(n));
              return citation ? <CitationMarker citation={citation} onCite={onCite} /> : `[${n}]`;
            },
          }
        : {}),
    }),
    [cited, citations, onCite, pre, table],
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
