// Server-Sent Events parsing for fetch-based streams. EventSource can't send a POST body
// or an Authorization header, so runs are streamed with fetch and parsed here.

/**
 * Split a text/event-stream buffer into complete events.
 * Returns [events, rest]: `rest` is an incomplete trailing event to prepend to the next
 * chunk. Each event is { event, data } with `data` parsed as JSON.
 */
export function parseSSE(buffer) {
  const blocks = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const rest = blocks.pop() ?? "";
  const events = [];
  for (const block of blocks) {
    let event = "message";
    const data = [];
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue; // blank or comment
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length > 0) events.push({ event, data: JSON.parse(data.join("\n")) });
  }
  return [events, rest];
}

/** Read a fetch Response body as SSE, calling onEvent for each event as it arrives. */
export async function readEventStream(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const [events, rest] = parseSSE(buffer);
    buffer = rest;
    events.forEach(onEvent);
  }
  const [events] = parseSSE(`${buffer}\n\n`);
  events.forEach(onEvent);
}
