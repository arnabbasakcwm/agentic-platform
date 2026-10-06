import { describe, expect, it } from "vitest";
import {
  filterSections,
  modelKey,
  modelSections,
  pickerLabel,
  scopeLabel,
} from "./models.js";

const OPTIONS = [
  {
    provider: "google_genai",
    model: "gemini-3.1-pro-preview",
    default: true,
    available: true,
  },
  { provider: "anthropic", model: "claude-sonnet-4-6", available: false },
  {
    provider: "bedrock",
    model: "in.anthropic.claude-haiku-4-5-20251001-v1:0",
    vendor: "Anthropic",
    name: "Claude Haiku 4.5",
    scope: "in",
    recommended: true,
    group: "Amazon Bedrock",
    available: true,
  },
  {
    provider: "bedrock",
    model: "mistral.mistral-large-3-675b-instruct",
    vendor: "Mistral AI",
    name: "Mistral Large 3",
    scope: null,
    recommended: false,
    group: "Amazon Bedrock",
    available: true,
  },
  {
    provider: "bedrock",
    model: "global.anthropic.claude-opus-4-6-v1",
    vendor: "Anthropic",
    name: "Claude Opus 4.6",
    scope: "global",
    recommended: false,
    group: "Amazon Bedrock",
    available: true,
  },
  {
    provider: "bedrock",
    model: "global.anthropic.claude-opus-4-5-20251101-v1:0",
    vendor: "Anthropic",
    name: "Claude Opus 4.5",
    scope: "global",
    recommended: false,
    group: "Amazon Bedrock",
    available: true,
  },
];

describe("modelSections", () => {
  it("puts platform models first, then recommended Bedrock models, then each vendor", () => {
    const sections = modelSections(OPTIONS);
    expect(sections.map((s) => s.title)).toEqual([
      "Platform models",
      "Amazon Bedrock · recommended",
      "Amazon Bedrock · Anthropic",
      "Amazon Bedrock · Mistral AI",
    ]);
    expect(sections[2].options.map((o) => o.name)).toEqual([
      "Claude Opus 4.5",
      "Claude Opus 4.6",
    ]);
    // Each model appears once: Haiku is under "recommended" only.
    const keys = sections.flatMap((s) => s.options.map(modelKey));
    expect(new Set(keys).size).toBe(OPTIONS.length);
  });

  it("filters on every word of the query, across name, vendor, id and region", () => {
    const sections = modelSections(OPTIONS);
    expect(
      filterSections(sections, "opus global").flatMap((s) =>
        s.options.map((o) => o.name),
      ),
    ).toEqual(["Claude Opus 4.5", "Claude Opus 4.6"]);
    expect(
      filterSections(sections, "india").flatMap((s) =>
        s.options.map((o) => o.name),
      ),
    ).toEqual(["Claude Haiku 4.5"]);
    expect(filterSections(sections, "gemini")[0].title).toBe("Platform models");
    expect(filterSections(sections, "nothing like this")).toEqual([]);
    expect(filterSections(sections, "  ")).toBe(sections);
  });
});

describe("labels", () => {
  it("names a model by its own name, vendor and where it runs", () => {
    expect(pickerLabel(OPTIONS[2])).toBe(
      "Claude Haiku 4.5 · Anthropic on Bedrock",
    );
    expect(pickerLabel(OPTIONS[0])).toBe(
      "gemini-3.1-pro-preview · Google Gemini",
    );
    expect(scopeLabel(OPTIONS[2])).toBe("India");
    expect(scopeLabel(OPTIONS[3])).toBeNull();
  });
});
