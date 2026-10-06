// Pure helpers for the Data sources page.

/** Bytes as KB / MB / GB (decimal, as BigQuery reports them). */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1000) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n;
  let unit = -1;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** "project.dataset.table" -> "dataset.table". */
export function tableName(id) {
  const parts = id.split(".");
  return parts.length >= 3 ? parts.slice(1).join(".") : id;
}

/** A first query to try on a table. */
export function queryPreview(tableId) {
  return tableId ? `SELECT *\nFROM \`${tableId}\`\nLIMIT 10` : "";
}

// What the "give agents access" button asks the plan assistant for.
export const DATA_ACCESS_REQUEST =
  "Give the agents that need facts from the attached BigQuery tables the sql_schema and " +
  "sql_query tools, and tell them to call sql_schema first, aggregate in SQL, and report " +
  "numbers exactly as the query returns them.";

/** The Data step's hint in the project stepper. */
export function dataHint(summary) {
  if (!summary || summary.sources === 0) return "Optional";
  const n = summary.tables;
  return `${n} table${n === 1 ? "" : "s"}`;
}
