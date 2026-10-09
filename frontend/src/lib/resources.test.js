import { describe, expect, it } from "vitest";
import { resourceCounts, resourcesHint, resourcesReady } from "./resources.js";

describe("resources step summary", () => {
  it("says Optional when nothing is attached", () => {
    expect(resourcesHint({})).toBe("Optional");
    expect(resourcesReady({})).toBe(false);
  });

  it("counts documents, noting ones still indexing", () => {
    expect(resourcesHint({ knowledge: { documents: 1, ready: 1 } })).toBe(
      "1 doc",
    );
    expect(resourcesHint({ knowledge: { documents: 3, ready: 1 } })).toBe(
      "1/3 docs ready",
    );
  });

  it("joins all three", () => {
    const project = {
      knowledge: { documents: 2, ready: 2 },
      data_sources: { sources: 1, tables: 4 },
      mcp: { servers: 1, tools: [{ name: "mcp__z__a" }] },
    };
    expect(resourcesHint(project)).toBe("2 docs · 1 db · 1 MCP");
    expect(resourceCounts(project)).toEqual({
      documents: 2,
      databases: 1,
      tools: 1,
    });
    expect(resourcesReady(project)).toBe(true);
  });

  it("is ready only once agents could use something", () => {
    expect(resourcesReady({ mcp: { servers: 1, tools: [] } })).toBe(false);
    expect(resourcesReady({ data_sources: { sources: 1, tables: 0 } })).toBe(
      false,
    );
  });
});
