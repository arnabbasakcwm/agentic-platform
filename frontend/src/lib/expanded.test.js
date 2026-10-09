import { afterEach, describe, expect, it, vi } from "vitest";
import { initialExpanded, readStored } from "./expanded.js";

describe("which library items start expanded", () => {
  it("restores what was stored, dropping items that no longer exist", () => {
    expect(initialExpanded(["b", "gone"], ["a", "b", "c"], ["a"])).toEqual(["b"]);
  });

  it("keeps everything collapsed when that's what was stored", () => {
    expect(initialExpanded([], ["a", "b"], ["a"])).toEqual([]);
  });

  it("opens a lone item on a first visit", () => {
    expect(initialExpanded(null, ["a"], [])).toEqual(["a"]);
  });

  it("opens only items needing attention when there are several", () => {
    expect(initialExpanded(null, ["a", "b", "c"], ["c"])).toEqual(["c"]);
    expect(initialExpanded(null, ["a", "b"], [])).toEqual([]);
  });
});

describe("reading the stored state", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("treats blocked, empty or malformed storage as nothing stored", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); } });
    expect(readStored("k")).toBeNull();
    vi.stubGlobal("localStorage", { getItem: () => null });
    expect(readStored("k")).toBeNull();
    vi.stubGlobal("localStorage", { getItem: () => "{not json" });
    expect(readStored("k")).toBeNull();
    vi.stubGlobal("localStorage", { getItem: () => '{"a": 1}' });
    expect(readStored("k")).toBeNull();
  });

  it("reads a stored list of ids", () => {
    vi.stubGlobal("localStorage", { getItem: () => '["a", 2, "b"]' });
    expect(readStored("k")).toEqual(["a", "b"]);
  });
});
