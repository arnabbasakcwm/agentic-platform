// A project has no name of its own; its brief's first line stands in for one.
export function projectTitle(brief, max = 72) {
  const firstLine = (brief ?? "").trim().split("\n")[0].trim();
  if (!firstLine) return "Untitled project";
  return firstLine.length > max ? `${firstLine.slice(0, max - 1).trimEnd()}…` : firstLine;
}

const UNITS = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

export function timeAgo(iso) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "just now";
  for (const [unit, size] of UNITS) {
    if (seconds >= size) {
      const n = Math.floor(seconds / size);
      return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}

export function fullDate(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

/** 850 → "850 ms", 4_200 → "4.2 s", 12_300 → "12 s", 84_000 → "1m 24s". */
export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

// A money field names its currency in its key (the agents are told to: price_inr,
// fare_usd). The amount is shown in that currency only — never converted.
const CURRENCY_SUFFIX = /(?:^|_)(inr|usd|eur|gbp|aed|sgd|jpy|aud|cad|chf|cny)$/i;
const LOCALE_FOR_CURRENCY = { INR: "en-IN" };

export function currencyOf(key) {
  const match = CURRENCY_SUFFIX.exec(String(key));
  return match ? match[1].toUpperCase() : null;
}

export function formatNumber(value, locale = "en-IN") {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
}

/** Format a value from structured agent data, using its key for context. */
export function formatValue(key, value) {
  if (typeof value === "number") {
    const currency = currencyOf(key);
    if (currency) {
      return new Intl.NumberFormat(LOCALE_FOR_CURRENCY[currency] ?? "en-US", {
        style: "currency",
        currency,
        // Whole amounts without .00 (fares, prices); fractional amounts keep their cents.
        minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
        maximumFractionDigits: 2,
      }).format(value);
    }
    return formatNumber(value);
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

/** "cheapest_one_way_price_inr" → "Cheapest one way price (INR)". */
export function humanizeKey(key) {
  const currency = currencyOf(key);
  const base = String(key).replace(CURRENCY_SUFFIX, "");
  const words = base.split(/[_\-\s]+|(?<=[a-z])(?=[A-Z])/).filter(Boolean).join(" ").toLowerCase();
  const label = words.charAt(0).toUpperCase() + words.slice(1);
  return currency ? `${label} (${currency})` : label;
}
