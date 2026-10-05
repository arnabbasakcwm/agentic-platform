// Pure helpers for showing model usage: tokens, estimated cost, activity names, and the
// geometry of the cost-per-day chart.

/** "$0.32", "$12.40", "<$0.0001"; cost is an estimate, so a leading "~" is added by callers. */
export function formatCost(value, currency = "USD") {
  if (value === null || value === undefined) return "—";
  if (value === 0) return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(0);
  if (value > 0 && value < 0.0001) return `<${formatCost(0.0001, currency)}`;
  const digits = value >= 1 ? 2 : value >= 0.01 ? 3 : 4;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: Math.min(2, digits),
    maximumFractionDigits: digits,
  }).format(value);
}

/** 950, "12.3K", "4.5M" — compact for tiles; exact counts go in tables (formatCount). */
export function formatTokens(value) {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function formatCount(value) {
  return new Intl.NumberFormat("en-US").format(value ?? 0);
}

const KINDS = {
  run: "Agent runs",
  deployed_run: "Deployed runs",
  planner: "Planning",
  assistant: "Plan assistant",
  embedding_index: "Indexing files",
  embedding_query: "Knowledge searches",
};

export function kindLabel(kind) {
  return KINDS[kind] ?? kind;
}

const PROVIDERS = {
  google_genai: "Google Gemini",
  openai: "OpenAI",
  anthropic: "Anthropic",
  groq: "Groq",
  moonshot: "Moonshot",
  ollama: "Ollama",
};

export function providerLabel(provider) {
  return PROVIDERS[provider] ?? provider;
}

/** One line for a run's usage: "12.3K tokens · ~$0.04" (or "· price not set"). */
export function usageLine(usage) {
  if (!usage) return null;
  const tokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
  if (tokens === 0) return null;
  const unpriced = usage.unpriced_models?.length > 0;
  const cost = unpriced && !usage.cost ? "price not set" : `~${formatCost(usage.cost, usage.currency)}`;
  return `${formatTokens(tokens)} tokens · ${cost}${unpriced && usage.cost ? " + unpriced models" : ""}`;
}

/** A clean axis maximum and ticks for values up to `max`: 0, step, 2·step, … */
export function niceScale(max, tickCount = 4) {
  if (!(max > 0)) return { max: 1, ticks: [0, 1] };
  const rough = max / tickCount;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough);
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return { max: top, ticks };
}

/** "Oct 5" from "2026-10-05" (read as a calendar date, not converted between zones). */
export function shortDate(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
