import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
const components = {
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  // A ```csv block in an answer shows as a table (with Raw and Copy), like a CSV answer.
  pre: ({ node, ...props }) => {
    const fenced = fencedTable(node);
    if (!fenced) return <pre {...props} />;
    const table = detectTable(fenced.text, fenced.lang === "tsv" ? "text/tab-separated-values" : "text/csv");
    if (!table || table.error) return <RawFallback raw={fenced.text} reason={table?.error} />;
    return (
      <TableBoundary raw={fenced.text}>
        <DataTable table={table} raw={fenced.text} label="Table" />
      </TableBoundary>
    );
  },
  // Wide tables scroll inside their own box instead of widening the page.
  table: ({ node, ...props }) => (
    <div className="md__table" tabIndex={0} role="region" aria-label="Table">
      <table {...props} />
    </div>
  ),
};

export function Markdown({ children }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
        {children ?? ""}
      </ReactMarkdown>
    </div>
  );
}
