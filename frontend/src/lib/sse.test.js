import { describe, expect, it } from "vitest";
import { parseSSE } from "./sse.js";

describe("parseSSE", () => {
  it("parses complete events and keeps an incomplete tail", () => {
    const [events, rest] = parseSSE(
      'event: node_started\ndata: {"node":"a","at":1}\n\nevent: node_completed\ndata: {"no',
    );
    expect(events).toEqual([{ event: "node_started", data: { node: "a", at: 1 } }]);
    expect(rest).toBe('event: node_completed\ndata: {"no');
  });

  it("handles CRLF line endings, comments and multi-line data", () => {
    const [events] = parseSSE(': keep-alive\r\n\r\nevent: x\r\ndata: {"a":\r\ndata: 1}\r\n\r\n');
    expect(events).toEqual([{ event: "x", data: { a: 1 } }]);
  });

  it("keeps line breaks inside JSON strings intact", () => {
    const content = "# Title\n\n- one\n- two";
    const [events] = parseSSE(`event: e\ndata: ${JSON.stringify({ content })}\n\n`);
    expect(events[0].data.content).toBe(content);
  });
});
