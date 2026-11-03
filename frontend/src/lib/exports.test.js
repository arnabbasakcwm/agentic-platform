import { describe, expect, it } from "vitest";
import { fileBase } from "./exports.js";

describe("fileBase", () => {
  it("names a run's files like the server's exports", () => {
    expect(fileBase({ projectName: "RBI Compliance Tracker", agentId: "report_formatter", runId: "ea423ecfbe104125" }))
      .toBe("RBI-Compliance-Tracker_report-formatter_ea423ecf");
  });

  it("copes with odd or missing parts", () => {
    expect(fileBase({ projectName: "Goa / trip: “best”", agentId: "a" })).toBe("Goa-trip-best_a");
    expect(fileBase({})).toBe("project_output");
  });
});
