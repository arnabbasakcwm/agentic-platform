import { describe, expect, it } from "vitest";
import {
  CsvError,
  detectDelimiter,
  detectTable,
  isNumeric,
  numberOf,
  numericColumns,
  parseDelimited,
  parseMarkdownTable,
  sortRows,
} from "./tabular.js";

describe("parseDelimited", () => {
  it("reads plain rows and skips blank lines", () => {
    expect(parseDelimited("a,b\n1,2\n\n3,4\n")).toEqual([["a", "b"], ["1", "2"], ["3", "4"]]);
  });

  it("handles quotes, embedded delimiters, line breaks and doubled quotes", () => {
    const text = 'name,note\n"Smith, J","said ""hi""\nthen left"\r\n"",x';
    expect(parseDelimited(text)).toEqual([
      ["name", "note"],
      ["Smith, J", 'said "hi"\nthen left'],
      ["", "x"],
    ]);
  });

  it("supports ; tab and | delimiters and \\r line ends", () => {
    expect(parseDelimited("a;b\r1;2", ";")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseDelimited("a\tb\n1\t2", "\t")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseDelimited("a|b\n1|2", "|")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("keeps empty fields and trims unquoted ones", () => {
    expect(parseDelimited("a, b ,c\n1,,3")).toEqual([["a", "b", "c"], ["1", "", "3"]]);
  });

  it("refuses broken quoting", () => {
    expect(() => parseDelimited('a,b\n"open,2')).toThrow(CsvError);
    expect(() => parseDelimited('a,b\n"x"y,2')).toThrow(CsvError);
  });

  it("stops at a row limit", () => {
    expect(parseDelimited("a,b\n1,2\n3,4", ",", 2)).toHaveLength(2);
  });
});

describe("detectDelimiter", () => {
  it.each([
    ["a,b,c\n1,2,3\n4,5,6", ","],
    ["a;b\n1;2\n3;4", ";"],
    ["a\tb\n1\t2\n3\t4", "\t"],
    ["a|b\n1|2\n3|4", "|"],
    ['name,city\n"Doe, J",Pune\nAl,Goa', ","],
  ])("finds the delimiter of %j", (text, delimiter) => {
    expect(detectDelimiter(text)).toBe(delimiter);
  });

  it.each([
    ["one line,only"],
    ["Hello, world\nFoo, bar"], // too short to tell from prose
    ["a,b\n1,2,3\n4"], // inconsistent
    ["1,2\n3,4\n5,6"], // no header row
    ["# Title\nx,y\n1,2"], // Markdown
    ["- item one, two\n- item three, four\n- item five, six"],
    [
      "This sentence, which goes on for quite a while, is prose.\nSo is this one, written at length, by a model.\nAnd a third line, also long enough, to look like prose.",
    ],
    ["| a | b |\n|---|---|\n| 1 | 2 |"], // a Markdown table is handled separately
  ])("says %j is not CSV", (text) => {
    expect(detectDelimiter(text)).toBeNull();
  });
});

describe("detectTable", () => {
  it("reads CSV, JSON arrays, Markdown tables and fenced csv", () => {
    expect(detectTable("a,b\n1,2\n3,4")).toMatchObject({ kind: "csv", header: ["a", "b"], rows: [["1", "2"], ["3", "4"]] });
    expect(detectTable('[{"a":1,"b":"x"},{"a":2,"c":true}]')).toEqual({
      kind: "json",
      header: ["a", "b", "c"],
      rows: [["1", "x", ""], ["2", "", "true"]],
    });
    expect(detectTable("| a | b |\n|:--|--:|\n| 1 | x \\| y |")).toEqual({
      kind: "markdown",
      header: ["a", "b"],
      rows: [["1", "x | y"]],
    });
    expect(detectTable("```csv\na,b\n1,2\n```")).toMatchObject({ kind: "csv", header: ["a", "b"] });
  });

  it("returns null for prose and other code", () => {
    expect(detectTable("Just an answer.")).toBeNull();
    expect(detectTable("```python\na,b\n1,2\n```")).toBeNull();
    expect(detectTable("Intro\n\n| a | b |\n|---|---|\n| 1 | 2 |")).toBeNull();
    expect(detectTable("")).toBeNull();
    expect(detectTable("[1, 2, 3]")).toBeNull();
  });

  it("reports a parse error when the type says CSV but the text is broken", () => {
    expect(detectTable('a,b\n"broken', "text/csv")).toEqual({ kind: "csv", error: expect.stringMatching(/never closed/) });
  });

  it("pads short rows to the header", () => {
    expect(detectTable("a,b,c\n1,2,3\n4,5,6", "text/csv").rows[0]).toHaveLength(3);
  });
});

describe("numbers and sorting", () => {
  it("knows numbers, with currency, separators and percent", () => {
    for (const n of ["7004", "-5", "7,004", "₹7,004", "$1.5", "12%", ".5", "1 234"]) expect(isNumeric(n)).toBe(true);
    for (const t of ["abc", "7a", "", "1-2", "v1.2"]) expect(isNumeric(t)).toBe(false);
    expect(numberOf("₹7,004")).toBe(7004);
    expect(numberOf("12%")).toBe(12);
  });

  it("finds numeric columns, ignoring empty cells", () => {
    expect(numericColumns(["a", "b", "c"], [["x", "1", ""], ["y", "", ""]])).toEqual([false, true, false]);
  });

  it("sorts numbers by value, text naturally, empties last, stably", () => {
    const rows = [["b", "10"], ["a", "9"], ["", "1"], ["c", ""], ["a2", "100"]];
    expect(sortRows(rows, 1, "asc", true).map((r) => r[1])).toEqual(["1", "9", "10", "100", ""]);
    expect(sortRows(rows, 1, "desc", true).map((r) => r[1])).toEqual(["100", "10", "9", "1", ""]);
    expect(sortRows(rows, 0, "asc", false).map((r) => r[0])).toEqual(["a", "a2", "b", "c", ""]);
  });
});

describe("parseMarkdownTable", () => {
  it("needs a separator row", () => {
    expect(parseMarkdownTable("| a | b |\n| 1 | 2 |")).toBeNull();
  });
});
