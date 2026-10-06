// Model menus: how /providers entries are named, grouped and searched. Pure helpers for
// components/ModelPicker.jsx.
import { providerLabel } from "./usage.js";

// Inference-profile scopes (where Bedrock may serve a request) -> a short tag.
const SCOPES = {
  in: "India",
  apac: "Asia Pacific",
  global: "Global",
  us: "US",
  eu: "Europe",
  jp: "Japan",
  au: "Australia",
  ca: "Canada",
};

export const modelKey = (o) => `${o.provider}/${o.model}`;

/** The model's own name: the catalog's clean name, else the id. */
export function modelName(o) {
  return o.name ?? o.model;
}

/** Who makes it: the vendor for Bedrock models, else the provider. */
export function modelVendor(o) {
  return o.vendor ?? providerLabel(o.provider);
}

/** Where a Bedrock inference profile may run ("Global", "India"), or null. */
export function scopeLabel(o) {
  return o.scope ? (SCOPES[o.scope] ?? o.scope) : null;
}

/** One line naming a model, e.g. "Claude Haiku 4.5 · Anthropic on Bedrock". */
export function pickerLabel(o) {
  const vendor = modelVendor(o);
  return o.group
    ? `${modelName(o)} · ${vendor} on Bedrock`
    : `${modelName(o)} · ${vendor}`;
}

/**
 * Sections for the menu: the platform's own models first, then the Bedrock models the
 * account can use, recommended ones first and the rest by vendor. Each model appears once.
 */
export function modelSections(options) {
  const sections = [];
  const plain = options.filter((o) => !o.group);
  if (plain.length)
    sections.push({ id: "platform", title: "Platform models", options: plain });
  const grouped = options.filter((o) => o.group);
  const recommended = grouped.filter((o) => o.recommended);
  if (recommended.length) {
    sections.push({
      id: "recommended",
      title: "Amazon Bedrock · recommended",
      options: recommended,
    });
  }
  const vendors = new Map();
  for (const o of grouped.filter((x) => !x.recommended)) {
    const vendor = modelVendor(o);
    if (!vendors.has(vendor)) vendors.set(vendor, []);
    vendors.get(vendor).push(o);
  }
  for (const vendor of [...vendors.keys()].sort((a, b) => a.localeCompare(b))) {
    const list = vendors
      .get(vendor)
      .sort((a, b) =>
        modelName(a).localeCompare(modelName(b), undefined, { numeric: true }),
      );
    sections.push({
      id: `vendor-${vendor}`,
      title: `Amazon Bedrock · ${vendor}`,
      options: list,
    });
  }
  return sections;
}

/** Sections keeping only models matching every word of the query (name, vendor, id, region). */
export function filterSections(sections, query) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return sections;
  return sections
    .map((s) => ({
      ...s,
      options: s.options.filter((o) => {
        const text = [
          modelName(o),
          modelVendor(o),
          o.model,
          scopeLabel(o) ?? "",
          o.group ?? "",
        ]
          .join(" ")
          .toLowerCase();
        return words.every((w) => text.includes(w));
      }),
    }))
    .filter((s) => s.options.length > 0);
}

// ---- tool calling. Every agent with tools, and a supervisor (it routes by tool
// calling), needs a model that can call tools; the server measures which can (`tool_calling`:
// true, false, or null when not checked yet).
export function cannotCallTools(option) {
  return option?.tool_calling === false;
}

/** Whether an agent's job needs tool calling: it has tools, or it routes the team. */
export function needsToolCalling({ tools = [], isRouter = false }) {
  return tools.length > 0 || isRouter;
}

/** A model the agent can't use: it can't call tools and the agent needs it to. */
export function toolsBlocked(option, job) {
  return cannotCallTools(option) && needsToolCalling(job);
}

/** Only Bedrock models vary; they're checked once (server-side) when first chosen. */
export function needsCheck(option) {
  return option?.provider === "bedrock" && option.tool_calling == null;
}

/** Options with verdicts learned on this page applied. */
export function withVerdicts(options, verdicts) {
  return options.map((o) => {
    const verdict = verdicts[modelKey(o)];
    return verdict === undefined ? o : { ...o, tool_calling: verdict };
  });
}
