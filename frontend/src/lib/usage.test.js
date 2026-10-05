import { describe, expect, it } from "vitest";
import { formatCost, formatTokens, kindLabel, niceScale, shortDate, usageLine } from "./usage.js";

describe("usage formatting", () => {
  it("formats estimated costs with sensible precision", () => {
    expect(formatCost(12.4)).toBe("$12.40");
    expect(formatCost(0.32)).toBe("$0.32");
    expect(formatCost(0.009416)).toBe("$0.0094");
    expect(formatCost(0.00001)).toBe("<$0.0001");
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(null)).toBe("—");
  });

  it("compacts token counts", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_340)).toBe("12.3K");
    expect(formatTokens(4_500_000)).toBe("4.5M");
  });

  it("summarises a run in one line", () => {
    expect(usageLine({ input_tokens: 10_000, output_tokens: 2_340, cost: 0.04, currency: "USD", unpriced_models: [] })).toBe(
      "12.3K tokens · ~$0.04",
    );
    expect(usageLine({ input_tokens: 5, output_tokens: 0, cost: 0, unpriced_models: ["groq/llama"] })).toBe(
      "5 tokens · price not set",
    );
    expect(usageLine({ input_tokens: 0, output_tokens: 0 })).toBeNull();
    expect(usageLine(null)).toBeNull();
  });

  it("names kinds of work", () => {
    expect(kindLabel("embedding_query")).toBe("Knowledge searches");
    expect(kindLabel("something_new")).toBe("something_new");
  });
});

describe("chart helpers", () => {
  it("picks clean axis ticks", () => {
    expect(niceScale(0.37)).toEqual({ max: 0.4, ticks: [0, 0.1, 0.2, 0.3, 0.4] });
    expect(niceScale(9)).toEqual({ max: 10, ticks: [0, 2.5, 5, 7.5, 10] });
    expect(niceScale(0)).toEqual({ max: 1, ticks: [0, 1] });
  });

  it("labels days without shifting time zones", () => {
    expect(shortDate("2026-10-05")).toBe("Oct 5");
  });
});
