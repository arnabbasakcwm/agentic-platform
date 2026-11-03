import { describe, expect, it } from "vitest";
import {
  modelChipValue,
  modelGroups,
  modelTag,
  parseTeamSize,
  teamLabel,
  toggleableTools,
  toolCount,
  toolGroups,
  toolsChanged,
} from "./composer.js";

const TOOLS = {
  tools: [
    { name: "knowledge_search", side_effect: false },
    { name: "sql_schema", side_effect: false },
    { name: "sql_query", side_effect: false },
    { name: "lookup", side_effect: false },
    { name: "calculator", side_effect: false },
    { name: "web_search", side_effect: true },
    { name: "weather", side_effect: true },
    { name: "brand_new_api", side_effect: true },
  ],
  default: ["lookup", "calculator"],
};

describe("tools", () => {
  it("groups by the registry's side_effect flag; new third-party tools land in a sends-out group", () => {
    const groups = toolGroups(TOOLS);
    expect(groups.map((g) => [g.id, g.tools.map((t) => t.name)])).toEqual([
      ["builtin", ["knowledge_search", "lookup", "calculator"]],
      ["web", ["web_search", "brand_new_api"]],
      ["data", ["weather"]],
    ]);
    expect(groups.filter((g) => g.external).map((g) => g.note)).toEqual(["sends queries out", "sends queries out"]);
  });

  it("never offers knowledge_search or the SQL tools as switches", () => {
    expect(toggleableTools(TOOLS).map((t) => t.name)).toEqual([
      "lookup", "calculator", "web_search", "weather", "brand_new_api",
    ]);
  });

  it("counts knowledge_search only with files, and nothing for a model that can't call tools", () => {
    expect(toolCount({ tools: ["lookup", "calculator"], hasFiles: false })).toBe(2);
    expect(toolCount({ tools: ["lookup", "calculator"], hasFiles: true })).toBe(3);
    expect(toolCount({ tools: ["lookup"], hasFiles: true, noTools: true })).toBe(0);
  });

  it("knows when the tools differ from the default, in any order", () => {
    expect(toolsChanged(["calculator", "lookup"], TOOLS.default)).toBe(false);
    expect(toolsChanged(["lookup"], TOOLS.default)).toBe(true);
  });
});

const PROVIDERS = [
  { provider: "google_genai", model: "gemini", name: "Gemini 3.1 Pro", default: true, available: true },
  { provider: "openai", model: "gpt-4o-mini", default: false, available: true },
  { provider: "anthropic", model: "claude", default: false, available: false },
  { provider: "ollama", model: "llama3.1", default: false, available: true },
  { provider: "bedrock", model: "b.rec", name: "Claude Haiku 4.5", vendor: "Anthropic", group: "Amazon Bedrock", recommended: true, available: true },
  { provider: "bedrock", model: "b.other", name: "Mistral Large 3", vendor: "Mistral AI", group: "Amazon Bedrock", recommended: false, available: true },
];

describe("models", () => {
  it("puts the default and recommended Bedrock models first, and only counts keyless ones", () => {
    const { sections, keyless } = modelGroups(PROVIDERS);
    expect(sections.map((s) => [s.title, s.options.map((o) => o.model)])).toEqual([
      ["Recommended", ["gemini", "b.rec"]],
      ["More models", ["gpt-4o-mini", "llama3.1", "b.other"]],
    ]);
    expect(keyless).toBe(1);
  });

  it("filters by every word typed", () => {
    const { sections } = modelGroups(PROVIDERS, "mistral");
    expect(sections.flatMap((s) => s.options.map((o) => o.model))).toEqual(["b.other"]);
  });

  it("tags only the default and local models", () => {
    expect(PROVIDERS.map(modelTag)).toEqual(["Default", null, null, "Local", null, null]);
  });

  it("names the chip's model, the default when none is chosen", () => {
    expect(modelChipValue("", PROVIDERS)).toBe("Gemini 3.1 Pro");
    expect(modelChipValue("bedrock/b.rec", PROVIDERS)).toBe("Claude Haiku 4.5");
    expect(modelChipValue("groq/gone", PROVIDERS)).toBe("gone");
  });
});

describe("team size", () => {
  it("labels Auto or an upper limit", () => {
    expect(teamLabel(null)).toBe("Auto");
    expect(teamLabel(4)).toBe("up to 4");
  });

  it("accepts whole numbers from 1 to 10 only", () => {
    expect(parseTeamSize("4")).toEqual({ value: 4 });
    expect(parseTeamSize(" 10 ")).toEqual({ value: 10 });
    expect(parseTeamSize("0").error).toMatch(/between 1 and 10/);
    expect(parseTeamSize("11").error).toMatch(/between 1 and 10/);
    expect(parseTeamSize("2.5").error).toMatch(/whole number/);
    expect(parseTeamSize("").error).toMatch(/whole number/);
  });
});
