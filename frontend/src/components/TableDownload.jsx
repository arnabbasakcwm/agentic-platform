import { Download } from "lucide-react";
import { saveBlob } from "../lib/download.js";
import { toCsv } from "../lib/tabular.js";

/**
 * "Download CSV" for any table the console shows: every row, in the order shown, made in
 * the browser (UTF-8 with BOM, quoted cells, formula-looking cells defused by `toCsv`).
 * One button for all three table renderers: answer tables, structured data, and the
 * Markdown tables inside a report.
 */
export function TableDownload({ header, rows, fileName, label = "Table" }) {
  return (
    <button
      type="button"
      className="btn btn--sm btn--ghost"
      aria-label={`Download ${label} as CSV`}
      title={fileName}
      onClick={() => saveBlob(new Blob([toCsv(header, rows)], { type: "text/csv;charset=utf-8" }), fileName)}
    >
      <Download size={13} aria-hidden="true" />
      Download CSV
    </button>
  );
}
