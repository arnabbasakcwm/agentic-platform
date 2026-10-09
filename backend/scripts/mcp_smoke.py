"""Live check against real MCP servers: connect, list tools, and (only when you name one)
call a tool — through the same client, URL guard and limits agents use.

Servers come from MCP_SMOKE_SERVERS in backend/.env (or the environment), a JSON list:

    MCP_SMOKE_SERVERS=[
      {"name": "DeepWiki", "url": "https://mcp.deepwiki.com/mcp"},
      {"name": "GitHub", "url": "https://api.githubcopilot.com/mcp/",
       "headers": {"Authorization": "Bearer github_pat_..."}},
      {"name": "Zoho", "url": "https://<server>-<org>.zohomcp.com/mcp/<key>/message",
       "tool": "<a read-only tool>", "arguments": {}}
    ]

A tool is called only when an entry names one: calls run for real, so name read-only
tools. URLs and header values are never printed (URLs are shown masked).

    uv run python scripts/mcp_smoke.py
"""

from __future__ import annotations

import json
import os
import sys

from dotenv import load_dotenv

load_dotenv()

from agentic_platform import mcp_client as mc  # noqa: E402
from agentic_platform.errors import McpError  # noqa: E402


def main() -> int:
    raw = os.environ.get("MCP_SMOKE_SERVERS")
    if not raw:
        print("Set MCP_SMOKE_SERVERS (see this script's docstring).")
        return 2
    servers = json.loads(raw)
    failures = 0
    for entry in servers:
        name = entry.get("name") or mc.host_of(entry["url"])
        conn = mc.McpConnection(
            url=entry["url"], headers=entry.get("headers") or {}, transport=entry.get("transport", "http"), name=name
        )
        print(f"\n== {name}  ({mc.display_url(entry['url'])})")
        try:
            listing = mc.list_tools(conn)
        except McpError as e:
            print(f"   FAILED to connect: {e.error_type}: {e}")
            failures += 1
            continue
        print(f"   server: {listing.server_name} {listing.server_version}  ·  {len(listing.tools)} tools")
        for tool in listing.tools[:15]:
            hint = "reads only" if tool.looks_read_only() else "may change data"
            print(f"   - {tool.name}  [{hint}]  {tool.description[:80]!r}")
        for note in listing.skipped:
            print(f"   left out: {note}")
        if entry.get("tool"):
            try:
                result = mc.call_tool(conn, entry["tool"], entry.get("arguments") or {})
            except McpError as e:
                print(f"   FAILED to call {entry['tool']}: {e.error_type}: {e}")
                failures += 1
                continue
            print(f"   {entry['tool']} -> {'tool error' if result.is_error else 'ok'}:")
            print("   " + mc.format_output(name, result, max_chars=600).replace("\n", "\n   "))
    print(f"\n{len(servers) - failures}/{len(servers)} servers OK")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
