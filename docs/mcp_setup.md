# MCP servers: giving agents tools from remote servers

Agents can use tools from **remote MCP servers**: Zoho, GitHub, your own company servers,
or any server that speaks the [Model Context Protocol](https://modelcontextprotocol.io)
over HTTPS. You connect a server once, approve the tools agents may use, and attach the
server to the projects that need it.

What the platform enforces:
- **Remote servers only:** Streamable HTTP (and legacy SSE) over `https`. The platform
  never runs a program for a server.
- **Public addresses only:** private, local, link-local and cloud-metadata addresses are
  refused, and this is checked again before every request.
- **Only approved tools reach agents.** A new server's tools are all unapproved. If a
  server later changes an approved tool (its description or arguments), the tool is held
  back until you approve it again.
- **Attaching a server to a project is that project's opt-in.** Whatever its agents pass
  to a tool is sent to that server.
- **Secrets stay hidden.** The server URL and header values are encrypted at rest, never
  shown again, never logged, and never put in an error message. Some servers put their key
  in the URL, so every URL is treated as a secret.
- **Calls are bounded.** Each call has a 60 s timeout and its result is cut at 12,000
  characters. Results are fenced as data from the server, not instructions.

## 1. One-time server setup

Generate an encryption key and put it in `backend/.env`:

```bash
cd backend
uv run python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

```
PLATFORM_SECRET_KEY=<the printed key>
```

Keep this key safe and stable. If it's lost or changed, the stored servers can't be
decrypted, and you have to connect them again.

For local development against an MCP server on your own machine (`http://localhost…`),
also set `MCP_ALLOW_INSECURE_LOCAL=1`. Leave it unset everywhere else.

## 2. Connect a server

On the console's **MCP servers** page, enter the server's URL and a name, then choose how
the platform signs in under **Authentication**. The platform checks the address, signs in
and lists the tools. If that fails, it says which step failed.

| Authentication | Example | What to enter |
|---|---|---|
| **None** | public demo servers | the URL only |
| **Access token** | GitHub, most SaaS servers | the token, separate from the URL. It's sent as `Authorization: Bearer <token>`; "Header and prefix" changes either for servers that want something else |
| **API key header** | many in-house servers | the header name (default `X-API-Key`) and the key |
| **Key in URL** | Zoho MCP | the full URL; it is the credential |
| **Custom headers** | anything else | any header names and values |
| OAuth sign-in | Atlassian, Notion, Zoho's per-user mode | not supported yet (see below) |

Tokens, keys and header values are write-only: they're stored encrypted and never shown
again. To change one later, choose **Replace URL or headers** on the server's panel. It
opens with the same Authentication choice, and leaving the new token empty keeps the
current one.

### Example: Zoho MCP (key in the URL)
1. In the Zoho MCP console, create a server and add only the tools agents need.
2. Choose **Authorization via Connection** and authorize it as the Super Admin. Agents run
   unattended and can't complete the per-user ("on demand") sign-in.
3. Copy the server URL from **Connect** and paste it into the platform.
4. If you use **API Key Re-Generate** in Zoho, choose **Replace URL or headers** on the
   server's panel and paste the new URL. Approvals carry over for tools that didn't change.

### Example: GitHub (token in a header)
1. Create a fine-grained personal access token with read-only access to the repositories
   agents need.
2. Enter the URL `https://api.githubcopilot.com/mcp/`, choose **Access token**, and paste
   the token.

### Example: your own server (API key header)
Enter its URL, choose **API key header**, and enter the header it expects (e.g.
`X-API-Key`) and the key. A server that takes a bearer token is **Access token** instead.

### Servers that need OAuth
A server that asks for an OAuth sign-in is reported as **McpOAuthRequired**. If it offers
a token or API key, use that instead. Some servers answer a tool call with a sign-in link
rather than data; the platform reports that as **McpAuthorizationRequired** and never
passes the link to an agent.

## 3. Approve tools

Tick the tools agents may use and save. Each tool shows:
- **Reads only** or **May change data:** the server's own hint, or a guess from the tool's
  name. It's a suggestion, not a guarantee.
- **Changed — review:** the server changed the tool after you approved it.

Approving a tool that may change data asks you to confirm first. Use **Try a tool** to run
one approved tool for real, with the same checks as an agent's call.

## 4. Attach to projects

Tick projects on the server's panel, or use the project's **Resources** step (MCP tools tab). Then give agents
the tools on the **Brief** step (the chips read *Server · tool*), or ask the assistant.
You can also attach servers when creating a project ("Add MCP" in the new-project chat).
The planner is told the approved tools' names and descriptions, and nothing else.

Detaching a server, or withdrawing a tool's approval, stops it at once. Compiling a plan
that still uses the tool fails with **McpUnavailable**, and a run already in progress is
told the tool isn't available any more.

## 5. Deployments

A deployed project carries its servers' approved tool definitions in `mcp_servers.json`.
Each server's URL and headers are passed as an environment variable
(`MCP_SECRET_<SLUG>`), the same way provider keys are passed today. Anyone who can read
the runtime's configuration in the AWS account can see them. This is a known deviation;
the plan is to move them to Secrets Manager or AgentCore Identity.

The runtime uses public network mode, so servers must be reachable from the internet.
After approving or changing tools, redeploy for the deployment to pick up the change.

## Limits

- At most 200 tools per server. Tool descriptions are cut at 1,000 characters and argument
  schemas at 16 KB; anything larger is left out, and the connect result says which.
- Each call has a 60 s timeout (`MCP_CALL_TIMEOUT_S`), and its result is cut at 12,000
  characters (`MCP_MAX_RESULT_CHARS`).
- Tool calls are counted on the Usage page ("Tool calls (MCP servers)") but never priced:
  the platform doesn't know what a server charges.
