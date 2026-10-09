// Pure helpers for MCP servers: tool names, presets, header rows and tool groups.

const PREFIX = "mcp__";

/** "mcp__crm__search_records" -> { slug: "crm", tool: "search_records" }, else null. */
export function parseMcpName(name) {
  if (typeof name !== "string" || !name.startsWith(PREFIX)) return null;
  const rest = name.slice(PREFIX.length);
  const at = rest.indexOf("__");
  if (at <= 0 || at === rest.length - 2) return null;
  return { slug: rest.slice(0, at), tool: rest.slice(at + 2) };
}

export const isMcpTool = (name) => parseMcpName(name) !== null;

/**
 * How a tool name reads in the console: an MCP tool as "Server · tool" (from the
 * project's MCP tools when known), anything else unchanged.
 */
export function toolLabel(name, mcpTools = []) {
  const known = mcpTools.find((t) => t.name === name);
  if (known) return `${known.server} · ${known.tool}`;
  const parsed = parseMcpName(name);
  return parsed ? `${parsed.slug} · ${parsed.tool}` : name;
}

/**
 * Optional help per well-known server. Presets are display only: they never change what
 * the platform checks, and no host is required. Matching is on the URL's host.
 */
export const MCP_PRESETS = [
  {
    id: "zoho",
    label: "Zoho MCP",
    host: /(^|\.)zohomcp\.[a-z.]+$/i,
    name: "Zoho",
    auth: "url",
    help: "Paste the URL from the Connect tab of your server in the Zoho MCP console; it contains the server's key. Choose Authorization via Connection there, so agents don't need to sign in.",
  },
  {
    id: "github",
    label: "GitHub",
    host: /(^|\.)githubcopilot\.com$/i,
    name: "GitHub",
    auth: "token",
    tokenPlaceholder: "github_pat_…",
    help: "Use a fine-grained personal access token with read-only access to the repositories agents need.",
  },
];

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** The preset whose host matches the URL, if any. */
export function presetFor(url) {
  const host = hostOf(url?.trim() ?? "");
  return host ? (MCP_PRESETS.find((p) => p.host.test(host)) ?? null) : null;
}

/** Header rows ([{name, value}]) as the object the API takes, skipping empty rows. */
export function headersFromRows(rows) {
  const out = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (name && row.value !== "") out[name] = row.value;
  }
  return out;
}

/** A server's tools in the order the console lists them: changed first, then
 * approved, then the rest, each alphabetically. */
export function sortTools(tools) {
  const rank = (t) => (t.changed ? 0 : t.approved ? 1 : 2);
  return [...tools].sort(
    (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name),
  );
}

/** Tools approved now that weren't before and may change data: they need a confirm. */
export function newWriteTools(tools, approved) {
  const was = new Set(tools.filter((t) => t.usable).map((t) => t.name));
  return tools.filter(
    (t) => approved.has(t.name) && !was.has(t.name) && !t.read_only_hint,
  );
}

/** A starting argument object for trying a tool: its required fields, empty. */
export function sampleArguments(schema) {
  const props = schema?.properties ?? {};
  const out = {};
  for (const key of schema?.required ?? []) {
    const type = props[key]?.type;
    out[key] =
      type === "integer" || type === "number"
        ? 0
        : type === "boolean"
          ? false
          : type === "array"
            ? []
            : type === "object"
              ? {}
              : "";
  }
  return out;
}

/** The status line for a server. */
export function serverStatus(server) {
  if (server.status === "auth_failed")
    return {
      tone: "danger",
      label: "Sign-in failed",
    };
  if (server.status === "unreachable")
    return { tone: "warn", label: "Unreachable" };
  return { tone: "success", label: "Connected" };
}

// ---- how a server is signed in to
/** The Authentication choices in the connect form, in display order. */
export const AUTH_MODES = [
  { id: "none", label: "None" },
  { id: "token", label: "Access token" },
  { id: "header", label: "API key header" },
  { id: "url", label: "Key in URL" },
  { id: "custom", label: "Custom headers" },
];

export const TOKEN_DEFAULTS = {
  tokenHeader: "Authorization",
  tokenPrefix: "Bearer",
};
export const KEY_DEFAULT_HEADER = "X-API-Key";

/**
 * The headers the API takes for a choice: an access token becomes
 * "Authorization: Bearer <token>" (header and prefix adjustable), an API key goes under
 * its header, custom rows go as entered; none and key-in-URL send no headers. An empty
 * token or key sends nothing.
 */
export function authHeaders(mode, fields = {}) {
  if (mode === "token") {
    const token = (fields.token ?? "").trim();
    if (!token) return {};
    const header =
      (fields.tokenHeader ?? TOKEN_DEFAULTS.tokenHeader).trim() ||
      TOKEN_DEFAULTS.tokenHeader;
    const prefix = (fields.tokenPrefix ?? TOKEN_DEFAULTS.tokenPrefix).trim();
    return { [header]: prefix ? `${prefix} ${token}` : token };
  }
  if (mode === "header") {
    const key = (fields.key ?? "").trim();
    if (!key) return {};
    const header =
      (fields.keyHeader ?? KEY_DEFAULT_HEADER).trim() || KEY_DEFAULT_HEADER;
    return { [header]: key };
  }
  if (mode === "custom") return headersFromRows(fields.rows ?? []);
  return {};
}

/** The choice a preset suggests (the user can always change it). */
export function defaultAuth(preset) {
  return AUTH_MODES.some((m) => m.id === preset?.auth) ? preset.auth : "none";
}

/** How a saved server signs in, for older servers saved before the choice was kept. */
export function authOf(server) {
  if (server?.auth) return server.auth;
  return server?.header_names?.length ? "custom" : "none";
}

/** One line for a server's panel. */
export function authSummary(server) {
  const names = server.header_names ?? [];
  switch (authOf(server)) {
    case "token":
      return "Signs in with an access token";
    case "header":
      return `Signs in with an API key${names[0] ? ` (${names[0]})` : ""}`;
    case "url":
      return "The key is part of the URL";
    case "custom":
      return names.length ? `Headers: ${names.join(", ")}` : "No headers";
    default:
      return "No sign-in";
  }
}
