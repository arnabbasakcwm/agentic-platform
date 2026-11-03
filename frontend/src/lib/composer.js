// The New project composer: pure helpers for its Model, Team and Tools chips.
import { filterSections, modelName, modelVendor, scopeLabel } from "./models.js";

export const MIN_AGENTS = 1;
export const MAX_AGENTS = 10;
export const KNOWLEDGE_TOOL = "knowledge_search";
// The SQL tools come with data sources, never from the composer's settings.
const DATA_TOOLS = new Set(["sql_schema", "sql_query"]);
// Third-party tools that fetch data rather than search the web. Only splits the
// "sends queries out" tools into two groups: any other third-party tool, including new
// ones, lands under Web and research, and the side_effect flag alone decides that a
// tool is third-party.
const DATA_AND_FINANCE = new Set(["weather", "yahoo_finance_news", "wolfram_alpha"]);

/** Tools the user switches on and off here (not the SQL tools, not knowledge_search). */
export function toggleableTools(tools) {
  return (tools?.tools ?? []).filter(
    (t) => !DATA_TOOLS.has(t.name) && t.name !== KNOWLEDGE_TOOL,
  );
}

/**
 * The Tools popover's groups, from the registry's own metadata: private tools under
 * "Built in", third-party ones (side_effect) under "sends queries out" groups.
 * knowledge_search is listed (locked) when the registry has it.
 */
export function toolGroups(tools) {
  const all = (tools?.tools ?? []).filter((t) => !DATA_TOOLS.has(t.name));
  const groups = [
    {
      id: "builtin",
      title: "Built in",
      note: "runs privately",
      external: false,
      tools: all.filter((t) => !t.side_effect),
    },
    {
      id: "web",
      title: "Web and research",
      note: "sends queries out",
      external: true,
      tools: all.filter((t) => t.side_effect && !DATA_AND_FINANCE.has(t.name)),
    },
    {
      id: "data",
      title: "Data and finance",
      note: "sends queries out",
      external: true,
      tools: all.filter((t) => t.side_effect && DATA_AND_FINANCE.has(t.name)),
    },
  ];
  return groups.filter((g) => g.tools.length > 0);
}

/** How many tools the agents may use: the switched-on ones, plus knowledge_search with files. */
export function toolCount({ tools, hasFiles, noTools }) {
  if (noTools) return 0;
  return tools.length + (hasFiles ? 1 : 0);
}

const sameSet = (a, b) =>
  a.length === b.length && a.every((x) => b.includes(x));

/** Whether the chosen tools differ from the platform default (the chip's "changed" look). */
export function toolsChanged(chosen, defaults) {
  return !sameSet(chosen, defaults ?? []);
}

// ---------------------------------------------------------------- model
/** A model's secondary line: who makes it, and where a Bedrock profile runs. */
export function modelSub(o) {
  const vendor = o.group ? `${modelVendor(o)} on Bedrock` : modelVendor(o);
  const scope = scopeLabel(o);
  return scope ? `${vendor} · ${scope}` : vendor;
}

/** The only tags the data supports: "Default" on the platform default, "Local" on Ollama. */
export function modelTag(o) {
  if (o.default && !o.group) return "Default";
  if (o.provider === "ollama") return "Local";
  return null;
}

/**
 * The model list: Recommended (the platform default, then the recommended Bedrock
 * models) and More models (every other usable one). Models without an API key aren't
 * listed; only counted.
 */
export function modelGroups(providers, query = "") {
  const usable = providers.filter((p) => p.available !== false);
  const isRecommended = (p) => (p.default && !p.group) || (p.group && p.recommended);
  const recommended = [
    ...usable.filter((p) => p.default && !p.group),
    ...usable.filter((p) => p.group && p.recommended),
  ];
  const more = usable.filter((p) => !isRecommended(p));
  const sections = filterSections(
    [
      { id: "recommended", title: "Recommended", options: recommended },
      { id: "more", title: "More models", options: more },
    ],
    query,
  );
  return {
    sections,
    keyless: providers.filter((p) => p.available === false).length,
  };
}

/** The Model chip's value: the chosen model's name, or the platform default's. */
export function modelChipValue(value, providers) {
  if (!value) {
    const d = providers.find((p) => p.default && !p.group);
    return d ? modelName(d) : "Default";
  }
  const chosen = providers.find((p) => `${p.provider}/${p.model}` === value);
  return chosen ? modelName(chosen) : value.split("/").slice(1).join("/");
}

// ---------------------------------------------------------------- team size
export function teamLabel(agentCount) {
  return agentCount ? `up to ${agentCount}` : "Auto";
}

/** A typed team size: a whole number from 1 to 10, or a message saying what's wrong. */
export function parseTeamSize(text) {
  const t = String(text).trim();
  if (!/^\d+$/.test(t)) {
    return { error: `Enter a whole number from ${MIN_AGENTS} to ${MAX_AGENTS}.` };
  }
  const n = Number(t);
  if (n < MIN_AGENTS || n > MAX_AGENTS) {
    return { error: `Choose between ${MIN_AGENTS} and ${MAX_AGENTS} agents.` };
  }
  return { value: n };
}
