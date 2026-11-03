// Thin client over the platform API. Every failure is normalised into an ApiError
// carrying the backend's typed error shape ({error_type, message, details}), so the UI
// can show what actually went wrong instead of a generic "request failed".

import { readEventStream } from "./sse.js";

const BASE = import.meta.env.VITE_API_BASE ?? "/api";

// The API's absolute URL, for snippets shown to users.
export const API_URL = new URL(BASE, window.location.origin).href.replace(
  /\/$/,
  "",
);

export class ApiError extends Error {
  constructor({ status, errorType, message, details }) {
    super(message);
    this.status = status;
    this.errorType = errorType;
    this.details = details;
  }
}

// The access token lives in sessionStorage: it survives a page refresh but not the tab
// being closed, and is never shared with other tabs. Storage can be unavailable (private
// mode, blocked site data), in which case the session simply lasts until a refresh.
const TOKEN_KEY = "agentic-platform.token";

function readStoredToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

let token = readStoredToken();
let onSessionExpired = () => {};

export const session = {
  hasToken: () => Boolean(token),
  set(next) {
    token = next;
    try {
      if (next) sessionStorage.setItem(TOKEN_KEY, next);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      // In-memory token still works for this page load.
    }
  },
  clear() {
    session.set(null);
  },
  // Called when the API rejects a token this client was relying on.
  onExpired(handler) {
    onSessionExpired = handler;
  },
};

// `form` (a FormData, for file uploads) is sent as multipart; the browser sets its
// Content-Type with the boundary.
async function send(path, { method = "GET", body, form, signal } = {}) {
  const sentToken = token;
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (sentToken) headers.Authorization = `Bearer ${sentToken}`;

  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: form ?? (body ? JSON.stringify(body) : undefined),
      signal,
    });
  } catch (cause) {
    if (cause?.name === "AbortError") throw cause;
    throw new ApiError({
      status: 0,
      errorType: "NetworkError",
      message: "Could not reach the API. Is the server running on port 8000?",
      details: String(cause),
    });
  }

  // A 401 on a request that carried a token means the token expired or was revoked.
  // (A 401 without one is just a failed sign-in attempt.)
  if (response.status === 401 && sentToken && sentToken === token) {
    session.clear();
    onSessionExpired();
  }
  return response;
}

async function failure(response) {
  const payload = await response.json().catch(() => null);
  return new ApiError({
    status: response.status,
    errorType: payload?.error_type ?? "HttpError",
    message:
      payload?.message ?? `Request failed with status ${response.status}`,
    details: payload?.details ?? null,
  });
}

/** A file from the API: its bytes and the name the server gave it (Content-Disposition). */
async function download(path) {
  const response = await send(path);
  if (!response.ok) throw await failure(response);
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  const plain = /filename="([^"]+)"/i.exec(disposition);
  const filename = encoded
    ? decodeURIComponent(encoded[1])
    : (plain?.[1] ?? "export");
  return { blob: await response.blob(), filename };
}

async function request(path, options) {
  const response = await send(path, options);
  if (!response.ok) throw await failure(response);
  return response.json().catch(() => null);
}

/** POST and read the response as Server-Sent Events, calling onEvent for each. */
async function stream(path, body, onEvent, signal) {
  const response = await send(path, { method: "POST", body, signal });
  if (!response.ok) throw await failure(response);
  await readEventStream(response, onEvent);
}

async function follow(path, onEvent, signal) {
  const response = await send(path, { signal });
  if (!response.ok) throw await failure(response);
  await readEventStream(response, onEvent);
}

function filesForm(files) {
  const form = new FormData();
  for (const file of files) form.append("files", file, file.name);
  return form;
}

export const api = {
  health: () => request("/health"),
  tools: () => request("/tools"),
  providers: () => request("/providers"),

  register: ({ email, password }) =>
    request("/auth/register", { method: "POST", body: { email, password } }),
  login: ({ email, password }) =>
    request("/auth/login", { method: "POST", body: { email, password } }),
  me: () => request("/auth/me"),

  // One turn of the new-project conversation: a reply, clarifying questions and the
  // brief so far. Creates nothing.
  briefChat: ({ messages, documentIds, datasourceIds, mcpServerIds }) =>
    request("/brief/chat", {
      method: "POST",
      body: {
        messages,
        ...(documentIds?.length ? { document_ids: documentIds } : {}),
        ...(datasourceIds?.length ? { datasource_ids: datasourceIds } : {}),
        ...(mcpServerIds?.length ? { mcp_server_ids: mcpServerIds } : {}),
      },
    }),

  createProject: ({
    brief,
    agentCount,
    availableTools,
    availableLlms,
    documentIds,
    datasourceIds,
    mcpServerIds,
    name,
    intake,
  }) =>
    request("/projects", {
      method: "POST",
      body: {
        brief,
        ...(name?.trim() ? { name: name.trim() } : {}),
        // Omitted = the planner chooses the team size.
        ...(agentCount ? { agent_count: agentCount } : {}),
        ...(availableTools ? { available_tools: availableTools } : {}),
        ...(availableLlms ? { available_llms: availableLlms } : {}),
        // Library files to attach; the planner is told about them.
        ...(documentIds?.length ? { document_ids: documentIds } : {}),
        // Data sources to attach; the planner is told their table names.
        ...(datasourceIds?.length ? { datasource_ids: datasourceIds } : {}),
        // MCP servers to attach; the planner is told their approved tools.
        ...(mcpServerIds?.length ? { mcp_server_ids: mcpServerIds } : {}),
        // The conversation that led to this brief, kept on the project.
        ...(intake?.length ? { intake } : {}),
      },
    }),
  // Change agents' model and tools: [{ id, provider, model, tools }]. Makes a new plan version.
  updateAgents: (id, agents) =>
    request(`/projects/${id}/agents`, { method: "PUT", body: { agents } }),

  listProjects: () => request("/projects"),
  getProject: (id) => request(`/projects/${id}`),
  // Rename; an empty name goes back to the brief's first line.
  renameProject: (id, name) =>
    request(`/projects/${id}`, { method: "PATCH", body: { name } }),
  // Deletes the project with its plan, conversation and knowledge-base files.
  deleteProject: (id) => request(`/projects/${id}`, { method: "DELETE" }),
  updatePlan: (id, plan) =>
    request(`/projects/${id}/plan`, { method: "PATCH", body: plan }),
  getDeployment: (id) => request(`/projects/${id}/deployment`),
  deploy: (id) => request(`/projects/${id}/deploy`, { method: "POST" }),
  invokeDeployment: (id, input) =>
    request(`/projects/${id}/deployment/invoke`, {
      method: "POST",
      body: { input },
    }),
  removeDeployment: (id) =>
    request(`/projects/${id}/deployment`, { method: "DELETE" }),
  // ---- usage: models, tokens and estimated cost.
  // ---- admin (admins only; anyone else gets 404)
  adminUsers: (days = 30) => request(`/admin/users?days=${days}`),
  adminUserUsage: (userId, days = 30, projectId) =>
    request(
      `/admin/users/${encodeURIComponent(userId)}/usage?days=${days}${projectId ? `&project_id=${encodeURIComponent(projectId)}` : ""}`,
    ),
  setUserRole: (userId, role) =>
    request(`/admin/users/${encodeURIComponent(userId)}/role`, {
      method: "PUT",
      body: { role },
    }),
  usage: (days = 30, projectId) =>
    request(
      `/usage?days=${days}${projectId ? `&project_id=${encodeURIComponent(projectId)}` : ""}`,
    ),
  usagePricing: () => request("/usage/pricing"),
  // Read deployed runtimes' usage logs now (counts runs invoked straight through AWS).
  syncUsage: () => request("/usage/sync", { method: "POST" }),
  // ---- knowledge library: files belong to the user, attached to any number of projects.
  knowledgeOverview: () => request("/knowledge"),
  uploadToLibrary: (files) =>
    request("/knowledge/documents", { method: "POST", form: filesForm(files) }),
  deleteFromLibrary: (documentId) =>
    request(`/knowledge/documents/${documentId}`, { method: "DELETE" }),
  setAttachments: (documentId, projectIds) =>
    request(`/knowledge/documents/${documentId}/projects`, {
      method: "PUT",
      body: { project_ids: projectIds },
    }),
  // The model new uploads use; files already in the library keep theirs.
  setLibraryEmbedding: ({ provider, model }) =>
    request("/knowledge/embedding", {
      method: "PUT",
      body: { provider, model },
    }),
  // Re-index one file with another model (in the background).
  setDocumentEmbedding: (documentId, { provider, model }) =>
    request(`/knowledge/documents/${documentId}/embedding`, {
      method: "PUT",
      body: { provider, model },
    }),
  // Whether a model can call tools (checked once, server-side, the first time).
  checkModel: (provider, model) =>
    request("/models/check", { method: "POST", body: { provider, model } }),
  // ---- data sources (BigQuery)
  dataSources: () => request("/datasources"),
  createDataSource: (body) => request("/datasources", { method: "POST", body }),
  browseDataSource: (id) => request(`/datasources/${id}/browse`),
  setDataSourceTables: (id, tables) =>
    request(`/datasources/${id}/tables`, { method: "PUT", body: { tables } }),
  setDataSourceProjects: (id, projectIds) =>
    request(`/datasources/${id}/projects`, {
      method: "PUT",
      body: { project_ids: projectIds },
    }),
  queryDataSource: (id, sql) =>
    request(`/datasources/${id}/query`, { method: "POST", body: { sql } }),
  projectDataSources: (id) => request(`/projects/${id}/datasources`),
  attachDataSource: (id, sourceId) =>
    request(`/projects/${id}/datasources/${sourceId}`, { method: "POST" }),
  detachDataSource: (id, sourceId) =>
    request(`/projects/${id}/datasources/${sourceId}`, { method: "DELETE" }),
  deleteDataSource: (id) => request(`/datasources/${id}`, { method: "DELETE" }),
  // ---- MCP servers (remote tools agents may call)
  mcpServers: () => request("/mcp"),
  createMcpServer: (body) => request("/mcp", { method: "POST", body }),
  refreshMcpServer: (id) => request(`/mcp/${id}/refresh`, { method: "POST" }),
  approveMcpTools: (id, approved) =>
    request(`/mcp/${id}/tools`, { method: "PUT", body: { approved } }),
  replaceMcpSecret: (id, body) =>
    request(`/mcp/${id}/secret`, { method: "PUT", body }),
  renameMcpServer: (id, name) =>
    request(`/mcp/${id}`, { method: "PATCH", body: { name } }),
  setMcpProjects: (id, projectIds) =>
    request(`/mcp/${id}/projects`, {
      method: "PUT",
      body: { project_ids: projectIds },
    }),
  testMcpTool: (id, tool, args) =>
    request(`/mcp/${id}/test`, {
      method: "POST",
      body: { tool, arguments: args },
    }),
  deleteMcpServer: (id) => request(`/mcp/${id}`, { method: "DELETE" }),
  projectMcpServers: (id) => request(`/projects/${id}/mcp`),
  attachMcpServer: (id, serverId) =>
    request(`/projects/${id}/mcp/${serverId}`, { method: "POST" }),
  detachMcpServer: (id, serverId) =>
    request(`/projects/${id}/mcp/${serverId}`, { method: "DELETE" }),
  // ---- one project's view: the files attached to it.
  getKnowledge: (id) => request(`/projects/${id}/knowledge`),
  // Adds the files to the library and attaches them to the project.
  uploadDocuments: (id, files) =>
    request(`/projects/${id}/knowledge/documents`, {
      method: "POST",
      form: filesForm(files),
    }),
  attachDocument: (id, documentId) =>
    request(`/projects/${id}/knowledge/documents/${documentId}`, {
      method: "POST",
    }),
  // Detaches only: the file stays in the library.
  detachDocument: (id, documentId) =>
    request(`/projects/${id}/knowledge/documents/${documentId}`, {
      method: "DELETE",
    }),
  searchKnowledge: (id, query, k = 5) =>
    request(`/projects/${id}/knowledge/search`, {
      method: "POST",
      body: { query, k },
    }),
  // The Assistant's chips limit one change; untouched chips send only the message.
  reviseProject: (id, message, { model, agentCount, tools } = {}) =>
    request(`/projects/${id}/revise`, {
      method: "POST",
      body: {
        message,
        ...(model ? { model } : {}),
        ...(agentCount ? { agent_count: agentCount } : {}),
        ...(tools ? { tools } : {}),
      },
    }),
  compile: (id) => request(`/projects/${id}/compile`, { method: "POST" }),
  // A run's output (one agent's, or every finished agent's) as docx | pdf | csv.
  exportRun: (id, runId, format, agentId) =>
    download(
      `/projects/${id}/runs/${runId}/export?format=${format}` +
        (agentId ? `&agent_id=${encodeURIComponent(agentId)}` : ""),
    ),
  run: (id, input) =>
    request(`/projects/${id}/run`, { method: "POST", body: { input } }),
  // Same input as run(); onEvent receives { event, data } as each agent progresses.
  // ---- saved runs: started in the background on the server, kept (last 10 per kind).
  startRun: (id, { input, mode = "graph", agentId = null }) =>
    request(`/projects/${id}/runs`, {
      method: "POST",
      body: { input, mode, ...(agentId ? { agent_id: agentId } : {}) },
    }),
  listRuns: (id, kind = "local") =>
    request(`/projects/${id}/runs?kind=${kind}`),
  getRun: (id, runId) => request(`/projects/${id}/runs/${runId}`),
  // Ends a running local run within seconds (it is saved as failed with RunStopped).
  stopRun: (id, runId) =>
    request(`/projects/${id}/runs/${runId}/stop`, { method: "POST" }),
  // Replays a saved run's events from `after`, then follows it live until it ends.
  followRun: (id, runId, after, onEvent, signal) =>
    follow(
      `/projects/${id}/runs/${runId}/stream?after=${after}`,
      onEvent,
      signal,
    ),
  startDeployedRun: (id, input) =>
    request(`/projects/${id}/deployment/runs`, {
      method: "POST",
      body: { input },
    }),
  runStream: (id, input, onEvent, signal) =>
    stream(`/projects/${id}/run/stream`, { input }, onEvent, signal),
  invokeAgent: (id, agentId, input, upstreamOutputs = {}) =>
    request(`/projects/${id}/agents/${agentId}/invoke`, {
      method: "POST",
      body: { input, upstream_outputs: upstreamOutputs },
    }),
};
