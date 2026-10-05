import { describe, expect, it } from "vitest";
import {
  batches,
  checkFiles,
  documentBadge,
  filterDocuments,
  formatBytes,
  isIndexing,
  knowledgeHint,
  knowledgeTotals,
  NO_PROJECT,
} from "./knowledge.js";

const LIMITS = {
  max_file_bytes: 1000,
  max_files: 3,
  file_types: [".csv", ".docx", ".md", ".pdf", ".txt"],
};
const file = (name, size = 10) => ({ name, size });

describe("checkFiles", () => {
  it("accepts supported files and explains each refusal", () => {
    const { accepted, problems } = checkFiles(
      [file("a.pdf"), file("b.pptx"), file("c.txt", 0), file("d.csv", 5000), file("E.MD")],
      LIMITS,
      [],
    );
    expect(accepted.map((f) => f.name)).toEqual(["a.pdf", "E.MD"]);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/b\.pptx: not a supported type/);
    expect(problems[1]).toMatch(/empty/);
    expect(problems[2]).toMatch(/larger than 1000 B/);
  });

  it("refuses names already in the knowledge base, ignoring case", () => {
    const { accepted, problems } = checkFiles([file("Policy.pdf"), file("new.pdf"), file("NEW.pdf")], LIMITS, ["policy.PDF"]);
    expect(accepted.map((f) => f.name)).toEqual(["new.pdf"]);
    expect(problems).toHaveLength(2);
  });

  it("keeps within the per-project file limit", () => {
    const { accepted, problems } = checkFiles([file("a.md"), file("b.md"), file("c.md")], LIMITS, ["x.md"]);
    expect(accepted).toHaveLength(2);
    expect(problems.at(-1)).toMatch(/Only 2 more files fit/);
  });
});

describe("knowledge helpers", () => {
  it("splits uploads into batches", () => {
    expect(batches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(20 * 1024 * 1024)).toBe("20 MB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });

  it("maps document status to the console's badges", () => {
    expect(documentBadge("processing")).toEqual({ badge: "running", label: "Indexing" });
    expect(documentBadge("ready")).toEqual({ badge: "completed", label: "Ready" });
    expect(isIndexing([{ status: "ready" }, { status: "queued" }])).toBe(true);
    expect(isIndexing([{ status: "ready" }, { status: "failed" }])).toBe(false);
  });

  it("summarises the knowledge base for the stepper", () => {
    expect(knowledgeHint(undefined)).toBe("Optional");
    expect(knowledgeHint({ documents: 0, ready: 0 })).toBe("Optional");
    expect(knowledgeHint({ documents: 3, ready: 1 })).toBe("1 of 3 ready");
    expect(knowledgeHint({ documents: 1, ready: 1 })).toBe("1 file");
  });
});

describe("workspace filters", () => {
  const docs = [
    { filename: "Policy.pdf", project_ids: ["p1", "p2"], status: "ready", chunk_count: 4 },
    { filename: "fares.csv", project_ids: ["p2"], status: "processing", chunk_count: 0 },
    { filename: "scan.pdf", project_ids: ["p1"], status: "failed", chunk_count: 0 },
    { filename: "notes.md", project_ids: [], status: "queued", chunk_count: 0 },
  ];
  const names = (list) => list.map((d) => d.filename);

  it("filters by name, project and status together", () => {
    expect(names(filterDocuments(docs, { query: "pdf" }))).toEqual(["Policy.pdf", "scan.pdf"]);
    expect(names(filterDocuments(docs, { query: " POLICY " }))).toEqual(["Policy.pdf"]);
    expect(names(filterDocuments(docs, { project: "p2" }))).toEqual(["Policy.pdf", "fares.csv"]);
    expect(names(filterDocuments(docs, { project: NO_PROJECT }))).toEqual(["notes.md"]);
    expect(names(filterDocuments(docs, { status: "indexing" }))).toEqual(["fares.csv", "notes.md"]);
    expect(names(filterDocuments(docs, { project: "p1", status: "failed" }))).toEqual(["scan.pdf"]);
    expect(filterDocuments(docs)).toHaveLength(4);
  });

  it("totals files by state", () => {
    expect(knowledgeTotals(docs)).toEqual({ files: 4, ready: 1, indexing: 2, failed: 1, passages: 4 });
  });
});
