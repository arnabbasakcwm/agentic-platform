import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { Component, useId, useMemo, useState } from "react";
import { numericColumns, sortRows } from "../lib/tabular.js";
import { CopyButton } from "./JsonView.jsx";

export const PAGE_SIZE = 100;

/**
 * A table answer (CSV, JSON array or Markdown table): sticky header, zebra rows,
 * horizontal scroll, numbers right-aligned, empty cells as "—", click-to-sort columns,
 * pages of 100 rows, a Table / Raw switch and Copy. Cells are text: React escapes
 * them, nothing here renders HTML.
 */
export function DataTable({ table, raw, label = "Table" }) {
  const [view, setView] = useState("table");
  const [sort, setSort] = useState(null); // { column, direction }
  const [page, setPage] = useState(0);
  const id = useId();
  const numeric = useMemo(() => numericColumns(table.header, table.rows), [table]);
  const rows = useMemo(
    () => (sort ? sortRows(table.rows, sort.column, sort.direction, numeric[sort.column]) : table.rows),
    [table, sort, numeric],
  );
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const at = Math.min(page, pages - 1);
  const shown = rows.slice(at * PAGE_SIZE, (at + 1) * PAGE_SIZE);
  const count = `${rows.length} row${rows.length === 1 ? "" : "s"}`;

  function sortBy(column) {
    setPage(0);
    setSort((s) =>
      s?.column !== column
        ? { column, direction: "asc" }
        : s.direction === "asc"
          ? { column, direction: "desc" }
          : null,
    );
  }

  return (
    <div className="datatable">
      <div className="datatable__bar">
        <div className="segmented segmented--sm" role="group" aria-label={`${label}: view`}>
          {["table", "raw"].map((v) => (
            <button
              key={v}
              type="button"
              className={`segmented__item${view === v ? " segmented__item--on" : ""}`}
              aria-pressed={view === v}
              onClick={() => setView(v)}
            >
              {v === "table" ? "Table" : "Raw"}
            </button>
          ))}
        </div>
        <span className="datatable__count">
          {count}
          {pages > 1 && view === "table" && ` · rows ${at * PAGE_SIZE + 1}–${at * PAGE_SIZE + shown.length}`}
        </span>
        <CopyButton text={raw} label="Copy" />
      </div>
      {view === "raw" ? (
        <pre className="datatable__raw" tabIndex={0} aria-label={`${label}, raw text`}>
          {raw}
        </pre>
      ) : (
        <>
          <div className="datatable__scroll" tabIndex={0} role="region" aria-labelledby={`${id}-caption`}>
            <table className="datatable__table">
              <caption id={`${id}-caption`} className="sr-only">
                {label}, {count}
              </caption>
              <thead>
                <tr>
                  {table.header.map((h, i) => {
                    const sorted = sort?.column === i ? sort.direction : null;
                    const SortIcon = sorted === "asc" ? ArrowUp : sorted === "desc" ? ArrowDown : ArrowUpDown;
                    return (
                      <th
                        key={i}
                        scope="col"
                        className={numeric[i] ? "datatable__num" : undefined}
                        aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"}
                      >
                        <button type="button" className="datatable__sort" onClick={() => sortBy(i)}>
                          {h === "" ? "—" : h}
                          <SortIcon size={12} aria-hidden="true" />
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {shown.map((row, r) => (
                  <tr key={at * PAGE_SIZE + r}>
                    {table.header.map((_, c) => {
                      const value = row[c] ?? "";
                      const empty = String(value).trim() === "";
                      return (
                        <td key={c} className={numeric[c] ? "datatable__num" : undefined}>
                          {empty ? (
                            <span className="datatable__empty">
                              <span aria-hidden="true">—</span>
                              <span className="sr-only">empty</span>
                            </span>
                          ) : (
                            value
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <nav className="datatable__pages" aria-label={`${label} pages`}>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setPage(at - 1)} disabled={at === 0}>
                Previous
              </button>
              <span aria-live="polite">
                Page {at + 1} of {pages}
              </span>
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                onClick={() => setPage(at + 1)}
                disabled={at >= pages - 1}
              >
                Next
              </button>
            </nav>
          )}
        </>
      )}
    </div>
  );
}

/** The raw text with a notice: a table that couldn't be read never breaks the tab. */
export function RawFallback({ raw, reason }) {
  return (
    <div className="datatable datatable--fallback">
      <p className="datatable__notice" role="note">
        This looks like a table but couldn&apos;t be read as one{reason ? ` (${reason})` : ""}; showing the raw
        text.
      </p>
      <pre className="datatable__raw" tabIndex={0}>
        {raw}
      </pre>
    </div>
  );
}

/** Catches a render error in a table and shows the raw text instead. */
export class TableBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.warn("Table view failed; showing the raw text:", error);
  }

  render() {
    if (this.state.failed) return <RawFallback raw={this.props.raw} reason="display error" />;
    return this.props.children;
  }
}
