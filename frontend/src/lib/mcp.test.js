import { describe, expect, it } from "vitest";
import {
  authHeaders,
  authOf,
  authSummary,
  defaultAuth,
  headersFromRows,
  isMcpTool,
  newWriteTools,
  parseMcpName,
  presetFor,
  sampleArguments,
  sortTools,
  toolLabel,
} from "./mcp.js";

describe("MCP tool names", () => {
  it("parses exposed names and ignores everything else", () => {
    expect(parseMcpName("mcp__crm__search_records")).toEqual({
      slug: "crm",
      tool: "search_records",
    });
    expect(parseMcpName("mcp__crm__a__b")).toEqual({
      slug: "crm",
      tool: "a__b",
    });
    expect(parseMcpName("web_search")).toBeNull();
    expect(parseMcpName("mcp__crm__")).toBeNull();
    expect(parseMcpName("mcp____x")).toBeNull();
    expect(isMcpTool("mcp__crm__x")).toBe(true);
  });

  it("labels known tools by server, unknown ones by slug", () => {
    const known = [
      { name: "mcp__crm__search", server: "Zoho CRM", tool: "search" },
    ];
    expect(toolLabel("mcp__crm__search", known)).toBe("Zoho CRM · search");
    expect(toolLabel("mcp__gh__list_issues")).toBe("gh · list_issues");
    expect(toolLabel("calculator")).toBe("calculator");
  });
});

describe("presets", () => {
  it("match on the host only, and are optional", () => {
    expect(presetFor("https://acme-1.zohomcp.com/mcp/KEY/message").id).toBe(
      "zoho",
    );
    expect(presetFor("https://acme.zohomcp.eu/mcp/x").id).toBe("zoho");
    expect(presetFor("https://api.githubcopilot.com/mcp/").id).toBe("github");
    expect(presetFor("https://evil.com/zohomcp.com")).toBeNull();
    expect(presetFor("https://tools.example.com/mcp")).toBeNull();
    expect(presetFor("not a url")).toBeNull();
  });
});

describe("headers and tools", () => {
  it("turns header rows into an object, skipping blanks", () => {
    expect(
      headersFromRows([
        { name: " Authorization ", value: "Bearer x" },
        { name: "", value: "y" },
        { name: "X-Empty", value: "" },
      ]),
    ).toEqual({ Authorization: "Bearer x" });
  });

  it("lists changed tools first, then approved", () => {
    const tools = [
      { name: "b", approved: false },
      { name: "a", approved: true },
      { name: "c", approved: true, changed: true },
    ];
    expect(sortTools(tools).map((t) => t.name)).toEqual(["c", "a", "b"]);
  });

  it("finds newly approved tools that may change data", () => {
    const tools = [
      { name: "list", usable: false, read_only_hint: true },
      { name: "send", usable: false, read_only_hint: false },
      { name: "update", usable: true, read_only_hint: false },
    ];
    const picked = new Set(["list", "send", "update"]);
    expect(newWriteTools(tools, picked).map((t) => t.name)).toEqual(["send"]);
  });

  it("builds sample arguments from required fields", () => {
    const schema = {
      properties: {
        q: { type: "string" },
        n: { type: "integer" },
        all: { type: "boolean" },
        opt: { type: "string" },
      },
      required: ["q", "n", "all"],
    };
    expect(sampleArguments(schema)).toEqual({ q: "", n: 0, all: false });
    expect(sampleArguments(undefined)).toEqual({});
  });
});

describe("authentication", () => {
  it("sends an access token as a bearer header by default", () => {
    expect(authHeaders("token", { token: " abc " })).toEqual({
      Authorization: "Bearer abc",
    });
    expect(
      authHeaders("token", {
        token: "abc",
        tokenHeader: "X-Token",
        tokenPrefix: "",
      }),
    ).toEqual({ "X-Token": "abc" });
    expect(authHeaders("token", { token: "  " })).toEqual({});
  });

  it("sends an API key under its header", () => {
    expect(authHeaders("header", { key: "k1" })).toEqual({ "X-API-Key": "k1" });
    expect(authHeaders("header", { key: "k1", keyHeader: "Api-Key" })).toEqual({
      "Api-Key": "k1",
    });
    expect(authHeaders("header", { key: "" })).toEqual({});
  });

  it("sends nothing for none or a key in the URL, and custom rows as entered", () => {
    expect(authHeaders("none", { token: "x" })).toEqual({});
    expect(authHeaders("url", { key: "x" })).toEqual({});
    expect(
      authHeaders("custom", { rows: [{ name: "A", value: "1" }] }),
    ).toEqual({ A: "1" });
  });

  it("follows presets and remembers older servers", () => {
    expect(defaultAuth(presetFor("https://api.githubcopilot.com/mcp/"))).toBe(
      "token",
    );
    expect(
      defaultAuth(presetFor("https://a-1.zohomcp.com/mcp/k/message")),
    ).toBe("url");
    expect(defaultAuth(null)).toBe("none");
    expect(authOf({ header_names: ["X-API-Key"] })).toBe("custom");
    expect(authOf({ header_names: [] })).toBe("none");
    expect(
      authSummary({ auth: "token", header_names: ["Authorization"] }),
    ).toBe("Signs in with an access token");
  });
});
