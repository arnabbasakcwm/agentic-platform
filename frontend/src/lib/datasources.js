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
