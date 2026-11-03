import { describe, expect, it } from "vitest";
import { citationLabel, citationMap, rehypeCitations, safeHref, splitSources } from "./citations.js";

describe("citations", () => {
  it("splits off the trailing Sources section", () => {
    expect(splitSources("Claim [1].\n\n## Sources\n[1] A — https://a")).toEqual({
      body: "Claim [1].",
      sources: "## Sources\n[1] A — https://a",
    });
    expect(splitSources("**Sources:**\n[1] x").body).toBe("");
    expect(splitSources("No sources here.")).toEqual({ body: "No sources here.", sources: "" });
  });

  it("maps well-formed citations by number and ignores the rest", () => {
    const map = citationMap([{ n: 1, kind: "web" }, { n: "2" }, null, { n: 3, kind: "document" }]);
    expect([...map.keys()]).toEqual([1, 3]);
    expect(citationMap(undefined).size).toBe(0);
  });

  it("only opens http(s) links", () => {
    expect(safeHref("https://example.com/a")).toBe("https://example.com/a");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref("not a url")).toBeNull();
  });

  it("labels web and document sources", () => {
    expect(citationLabel({ kind: "web", title: "IndiGo", url: "https://x" })).toBe("IndiGo");
    expect(citationLabel({ kind: "web", url: "https://x" })).toBe("https://x");
    expect(citationLabel({ kind: "document", document_name: "fares.pdf", location: "p. 3" })).toBe("fares.pdf, p. 3");
  });

  it("turns known markers in text into elements, leaving code, links and unknown numbers", () => {
    const tree = {
      type: "root",
      children: [
        { type: "element", tagName: "p", children: [{ type: "text", value: "A [1] and [9] and [2](https://x)." }] },
        { type: "element", tagName: "code", children: [{ type: "text", value: "arr[1]" }] },
      ],
    };
    rehypeCitations({ known: new Map([[1, {}], [2, {}]]) })(tree);
    const p = tree.children[0].children;
    expect(p.map((c) => (c.type === "text" ? c.value : `<${c.tagName} ${c.properties.n}>`))).toEqual([
      "A ",
      "<cite-marker 1>",
      " and [9] and [2](https://x).",
    ]);
    expect(tree.children[1].children[0].value).toBe("arr[1]");
  });
});
