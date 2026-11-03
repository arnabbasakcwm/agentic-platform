// Agent outputs that are really tables — CSV/TSV text, a JSON array of objects, or a
// Markdown table — detected and parsed here, so the Run tab can show them as tables.
// Pure functions (unit-tested in tabular.test.js); nothing here touches the DOM.

export const DELIMITERS = [",", ";", "\t", "|"];
const MAX_SAMPLE_ROWS = 10;

export class CsvError extends Error {}

/**
 * RFC 4180-style parsing: quoted fields may hold the delimiter, line breaks and doubled
 * quotes (""). Accepts \n, \r\n and \r line ends. Throws CsvError on an unterminated
 * quote or text after a closing quote. `limit` stops after that many rows.
 */
export function parseDelimited(text, delimiter = ",", limit = Infinity) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false; // inside "…"
  let wasQuoted = false; // the current field was quoted (only spaces may follow)
  let i = 0;
  const s = text ?? "";
  const pushField = () => {
    row.push(wasQuoted ? field : field.trim());
    field = "";
    wasQuoted = false;
  };
  const pushRow = () => {
    pushField();
    // Blank lines are skipped, not rows of one empty cell.
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field.trim() === "" && !wasQuoted) {
      quoted = true;
      wasQuoted = true;
      field = "";
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      pushRow();
      if (rows.length >= limit) return rows;
      i += ch === "\r" && s[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (wasQuoted) {
      if (ch === " " || ch === "\t") {
        i += 1;
        continue;
      }
      throw new CsvError(`unexpected text after a closing quote in row ${rows.length + 1}`);
    }
    field += ch;
    i += 1;
  }
  if (quoted) throw new CsvError(`a quoted field in row ${rows.length + 1} is never closed`);
  if (field !== "" || wasQuoted || row.length) pushRow();
  return rows;
}

const MARKDOWN_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const NUMBER = /^[-+]?[\p{Sc}]?\s?\d[\d,_\s]*(\.\d+)?\s?%?$|^[-+]?[\p{Sc}]?\s?\.\d+$/u;

export const isNumeric = (value) => NUMBER.test(String(value).trim());

/** "₹7,004", "1 234.5", "12%" → 7004, 1234.5, 12 (NaN when it isn't a number). */
export function numberOf(value) {
  const cleaned = String(value).replace(/[\p{Sc},_\s%]/gu, "");
  return cleaned === "" ? NaN : Number(cleaned);
}

/**
 * The delimiter a text uses, if it reads as CSV: every one of the first lines (quotes
 * respected) has the same number of fields, at least 2, over at least 2 rows, and the
 * first row looks like a header (no empty cells, not all numbers). Null otherwise.
 */
export function detectDelimiter(text) {
  const lines = (text ?? "").split(/\r\n|\n|\r/).filter((l) => l.trim());
  // A header and at least two rows; prose with a comma per line is not a table.
  if (lines.length < 3) return null;
  // Markdown (headings, lists, quotes) is never CSV.
  if (/^\s*(#{1,6}\s|[-*+]\s|>\s|\d+\.\s)/.test(lines[0])) return null;
  // A Markdown table also has a steady pipe count; it's handled as Markdown.
  if (lines.slice(0, 3).some((l) => MARKDOWN_SEPARATOR.test(l))) return null;
  let best = null;
  for (const delimiter of DELIMITERS) {
    let sample;
    try {
      sample = parseDelimited(text, delimiter, MAX_SAMPLE_ROWS);
    } catch {
      continue;
    }
    if (sample.length < 2) continue;
    const widths = new Set(sample.map((r) => r.length));
    if (widths.size !== 1) continue;
    const width = sample[0].length;
    if (width < 2) continue;
    if (!looksLikeHeader(sample[0])) continue;
    // Cells of a table are short; sentences split at commas are not.
    const lengths = sample
      .flat()
      .map((c) => c.length)
      .sort((a, b) => a - b);
    if (lengths[Math.floor(lengths.length / 2)] > 40 || lengths.at(-1) > 400) continue;
    if (!best || width > best.width) best = { delimiter, width };
  }
  return best?.delimiter ?? null;
}

// A header is short labels: none empty, not all numbers, each a few words at most.
function looksLikeHeader(cells) {
  return (
    cells.every((c) => c.trim() !== "" && c.length <= 40 && c.trim().split(/\s+/).length <= 4) &&
    !cells.every((c) => isNumeric(c))
  );
}

function cellText(value) {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function stripFence(text) {
  const m = /^```[ \t]*([\w-]*)[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(text);
  return m ? { lang: m[1].toLowerCase(), body: m[2] } : null;
}

function splitMarkdownRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "";
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "|";
      i += 1;
    } else if (s[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += s[i];
    }
  }
  cells.push(cur.trim());
  return cells;
}

/** A whole answer that is exactly one Markdown table (header, separator, rows). */
export function parseMarkdownTable(text) {
  const lines = (text ?? "").trim().split(/\r?\n/);
  if (lines.length < 2 || !lines[0].includes("|") || !MARKDOWN_SEPARATOR.test(lines[1])) return null;
  if (!lines.slice(2).every((l) => l.includes("|"))) return null;
  const header = splitMarkdownRow(lines[0]);
  const rows = lines.slice(2).map((l) => {
    const cells = splitMarkdownRow(l);
    return header.map((_, i) => cells[i] ?? "");
  });
  return { header, rows };
}

/**
 * An output as a table, or null. `{ kind: "csv" | "json" | "markdown", header, rows,
 * delimiter? }`. `contentType` (e.g. "text/csv") forces CSV parsing; then a parse error
 * is returned as `{ kind: "csv", error }` so the caller can fall back to the raw text.
 */
export function detectTable(content, contentType) {
  let text = (content ?? "").trim();
  if (!text) return null;
  const fenced = stripFence(text);
  let forced = /csv|tab-separated|tsv/i.test(contentType ?? "");
  if (fenced) {
    if (!["csv", "tsv", "json", ""].includes(fenced.lang)) return null;
    text = fenced.body.trim();
    forced = forced || fenced.lang === "csv" || fenced.lang === "tsv";
  }
  if (text.startsWith("[")) {
    try {
      const data = JSON.parse(text);
      if (Array.isArray(data) && data.length && data.every((r) => r && typeof r === "object" && !Array.isArray(r))) {
        const header = [];
        for (const r of data) for (const k of Object.keys(r)) if (!header.includes(k)) header.push(k);
        return { kind: "json", header, rows: data.map((r) => header.map((k) => cellText(r[k]))) };
      }
    } catch {
      // not JSON: carry on
    }
  }
  const markdown = parseMarkdownTable(text);
  if (markdown) return { kind: "markdown", ...markdown };
  const tsv = fenced?.lang === "tsv" || /tab-separated|tsv/i.test(contentType ?? "");
  const delimiter = detectDelimiter(text) ?? (forced ? (tsv ? "\t" : ",") : null);
  if (!delimiter) return null;
  try {
    const all = parseDelimited(text, delimiter);
    if (all.length < 2) throw new CsvError("only one row");
    const [header, ...rows] = all;
    const width = header.length;
    return { kind: "csv", delimiter, header, rows: rows.map((r) => Array.from({ length: Math.max(width, r.length) }, (_, i) => r[i] ?? "")) };
  } catch (error) {
    return { kind: "csv", error: error.message };
  }
}

/** Which columns are numeric: every non-empty cell is a number (and at least one is). */
export function numericColumns(header, rows) {
  return header.map((_, i) => {
    const cells = rows.map((r) => r[i] ?? "").filter((c) => String(c).trim() !== "");
    return cells.length > 0 && cells.every(isNumeric);
  });
}

/** Rows sorted by one column; numbers by value, text in natural order, empties last. */
export function sortRows(rows, column, direction, numeric) {
  const dir = direction === "desc" ? -1 : 1;
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const x = a.row[column] ?? "";
      const y = b.row[column] ?? "";
      const xe = String(x).trim() === "";
      const ye = String(y).trim() === "";
      if (xe || ye) return xe === ye ? a.index - b.index : xe ? 1 : -1;
      const c = numeric ? numberOf(x) - numberOf(y) : collator.compare(String(x), String(y));
      return c === 0 ? a.index - b.index : c * dir;
    })
    .map((x) => x.row);
}
