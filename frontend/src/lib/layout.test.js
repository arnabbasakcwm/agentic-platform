import { describe, expect, it } from "vitest";
import { ASSISTANT_WIDTH, clampWidth } from "./layout.js";

describe("assistant width", () => {
  it("keeps the width between the minimum and the maximum", () => {
    expect(clampWidth(100, 2000)).toBe(ASSISTANT_WIDTH.min);
    expect(clampWidth(5000, 2000)).toBe(ASSISTANT_WIDTH.max);
    expect(clampWidth(512.4, 2000)).toBe(512);
  });

  it("always leaves the page its room", () => {
    // 1000px workspace: the page keeps 360, so the assistant gets at most 640.
    expect(clampWidth(800, 1000)).toBe(640);
    // Too narrow for both: the assistant still gets its minimum.
    expect(clampWidth(800, 500)).toBe(ASSISTANT_WIDTH.min);
  });

  it("lets an overlay panel use almost the whole width", () => {
    expect(clampWidth(700, 760, { overlay: true })).toBe(700);
    expect(clampWidth(900, 760, { overlay: true })).toBe(712);
  });

  it("falls back to the default for a missing or broken value", () => {
    expect(clampWidth(undefined, 2000)).toBe(ASSISTANT_WIDTH.default);
    expect(clampWidth(Number.NaN, 2000)).toBe(ASSISTANT_WIDTH.default);
  });
});
