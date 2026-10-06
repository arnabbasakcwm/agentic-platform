import { describe, expect, it } from "vitest";
import {
  dataHint,
  formatBytes,
  queryPreview,
  tableName,
} from "./datasources.js";

describe("data source helpers", () => {
  it("formats bytes the way BigQuery counts them", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(11_534_336)).toBe("11.5 MB");
    expect(formatBytes(1_000_000_000)).toBe("1.0 GB");
    expect(formatBytes(230_000_000)).toBe("230 MB");
  });

  it("shortens table ids and suggests a first query", () => {
    expect(tableName("agenticdb-510807.mydata.trips")).toBe("mydata.trips");
    expect(queryPreview("p.d.t")).toBe("SELECT *\nFROM `p.d.t`\nLIMIT 10");
    expect(queryPreview(undefined)).toBe("");
  });

  it("summarises a project's data for the stepper", () => {
    expect(dataHint(null)).toBe("Optional");
    expect(dataHint({ sources: 0, tables: 0 })).toBe("Optional");
    expect(dataHint({ sources: 1, tables: 1 })).toBe("1 table");
    expect(dataHint({ sources: 2, tables: 3 })).toBe("3 tables");
  });
});
