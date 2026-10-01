import { describe, expect, it } from "vitest";
import { highlightJson } from "./JsonView.jsx";

describe("highlightJson", () => {
  it("wraps keys, strings, numbers and literals in spans without losing any text", () => {
    const text = JSON.stringify({ name: "IndiGo", fare_inr: 4500, direct: true, note: null }, null, 2);
    const parts = highlightJson(text);
    const flat = parts.map((p) => (typeof p === "string" ? p : p.props.children)).join("");
    expect(flat).toBe(text);
    const kinds = parts.filter((p) => typeof p !== "string").map((p) => p.props.className);
    expect(kinds).toEqual(
      expect.arrayContaining(["json__key", "json__string", "json__number", "json__literal"]),
    );
  });
});
