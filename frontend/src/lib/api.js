// Thin client over the platform API. Every failure is normalised into an ApiError
// carrying the backend's typed error shape ({error_type, message, details}), so the UI
// can show what actually went wrong instead of a generic "request failed".

const BASE = import.meta.env.VITE_API_BASE ?? "/api";

// The API's absolute URL, for snippets shown to users.
export const API_URL = new URL(BASE, window.location.origin).href.replace(/\/$/, "");

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

async function request(path, { method = "GET", body } = {}) {
  const sentToken = token;
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (sentToken) headers.Authorization = `Bearer ${sentToken}`;

  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (cause) {
    throw new ApiError({
      status: 0,
      errorType: "NetworkError",
      message: "Could not reach the API. Is the server running on port 8000?",
      details: String(cause),
    });
  }

  const payload = await response.json().catch(() => null);

  // A 401 on a request that carried a token means the token expired or was revoked.
  // (A 401 without one is just a failed sign-in attempt.)
  if (response.status === 401 && sentToken && sentToken === token) {
    session.clear();
    onSessionExpired();
  }

  if (!response.ok) {
    throw new ApiError({
      status: response.status,
      errorType: payload?.error_type ?? "HttpError",
      message: payload?.message ?? `Request failed with status ${response.status}`,
      details: payload?.details ?? null,
    });
  }
  return payload;
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

  createProject: ({ brief, agentCount, availableTools, availableLlms }) =>
    request("/projects", {
      method: "POST",
      body: {
        brief,
        // Omitted = the planner chooses the team size.
        ...(agentCount ? { agent_count: agentCount } : {}),
        ...(availableTools ? { available_tools: availableTools } : {}),
        ...(availableLlms ? { available_llms: availableLlms } : {}),
      },
    }),

  listProjects: () => request("/projects"),
  getProject: (id) => request(`/projects/${id}`),
  updatePlan: (id, plan) => request(`/projects/${id}/plan`, { method: "PATCH", body: plan }),
  getDeployment: (id) => request(`/projects/${id}/deployment`),
  deploy: (id) => request(`/projects/${id}/deploy`, { method: "POST" }),
  invokeDeployment: (id, input) =>
    request(`/projects/${id}/deployment/invoke`, { method: "POST", body: { input } }),
  removeDeployment: (id) => request(`/projects/${id}/deployment`, { method: "DELETE" }),
  reviseProject: (id, message) =>
    request(`/projects/${id}/revise`, { method: "POST", body: { message } }),
  compile: (id) => request(`/projects/${id}/compile`, { method: "POST" }),
  run: (id, input) => request(`/projects/${id}/run`, { method: "POST", body: { input } }),
  invokeAgent: (id, agentId, input, upstreamOutputs = {}) =>
    request(`/projects/${id}/agents/${agentId}/invoke`, {
      method: "POST",
      body: { input, upstream_outputs: upstreamOutputs },
    }),
};
