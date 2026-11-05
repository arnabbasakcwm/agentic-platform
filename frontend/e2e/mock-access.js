// The delegated-administration part of the scripted API: teams, roles, sharing, budgets, model
// limits and the audit log, with the same shapes (and the same 404s for what is out of scope)
// as the real one - but only as much logic as the console's checks need.
//
// Test hooks:  POST /__access_as {orgRole, teams: {A: "group_admin"|"member"|null, ...}}
//              POST /__reset (the main mock calls resetAccess()).

const OFFERED = [
  "google_genai/gemini-3.1-pro-preview",
  "openai/gpt-4o-mini",
  "bedrock/global.anthropic.claude-sonnet-4-6",
  "bedrock/openai.gpt-oss-120b-1:0",
];
const USD = 1_000_000;
const PROJECT_ID = "e2e0travel0project";

const people = [
  { id: "u1", email: "e2e@example.com" },
  { id: "u2", email: "ada@example.com" },
  { id: "u3", email: "bob@example.com" },
];

let state;
export function resetAccess() {
  state = {
    orgRole: "user",
    projectLevel: "owner",
    teams: [
      { id: "A", name: "Growth", created_at: "2026-10-01T00:00:00Z" },
      { id: "B", name: "Support", created_at: "2026-10-02T00:00:00Z" },
      { id: "default", name: "Default", created_at: "2026-10-01T00:00:00Z" },
    ],
    // team -> user -> role
    members: {
      A: { u1: "group_admin", u2: "member" },
      B: { u3: "member" },
      default: { u1: "member", u2: "member", u3: "member" },
    },
    budgets: [
      node("org", "org", null, 1000 * USD, 120 * USD),
      node("pool", "sub1", "org", 600 * USD, 0),
      node("team", "A", "pool:sub1", 400 * USD, 90 * USD),
      node("user", "u1", "team:A", 100 * USD, 85 * USD),
      node("user", "u2", "team:A", 50 * USD, 10 * USD),
    ],
    orgModels: { catalog: null, fallback_model: null, unpriced_overrides: [] },
    allowlists: [],
    grants: [],
    audit: [],
    shares: { tick: 0 },
  };
  state.budgets[1].updated_by = "root";
}

function node(scope, id, parent, amount, spent) {
  return {
    id: scope === "org" ? "org" : `${scope}:${id}`, scope_type: scope, scope_id: id, parent_id: parent, amount,
    remaining: amount - spent, spent, unallocated: amount, period: "monthly", period_start: "2026-11-01T00:00:00Z",
    hard_limit: true, thresholds: [80, 100], notified: [], updated_by: null, updated_at: "2026-11-01T00:00:00Z",
  };
}
resetAccess();

/** The access fields of the project body for the signed-in e2e user (default: the owner). */
export const projectAccess = () => ({
  access_level: state.projectLevel,
  can_manage: state.projectLevel === "owner",
  ...(state.projectRestricted ? { restricted: true, brief: "" } : {}),
});

const notFound = { error_type: "NotFound", message: "not found", details: null };
const myRole = (team) => state.members[team]?.u1 ?? null;
const isMaster = () => state.orgRole === "master";
const isSub = () => state.orgRole === "admin";
const adminsTeam = (team) => myRole(team) === "group_admin";
const node_ = (id) => state.budgets.find((b) => b.id === id);
const childrenOf = (id) => state.budgets.filter((b) => b.parent_id === id);

function teamBody(t) {
  return { id: t.id, name: t.name, created_at: t.created_at, members: Object.keys(state.members[t.id] ?? {}).length, my_role: myRole(t.id) };
}
function visibleTeams() {
  return isMaster() ? state.teams : state.teams.filter((t) => myRole(t.id));
}
function addAudit(action, target, team, before = null, after = null) {
  state.audit.unshift({ id: `a${state.audit.length}`, at: new Date(Date.UTC(2026, 10, 5, 12, 0, state.audit.length)).toISOString(), actor_id: "u1", action, target_type: "x", target_id: target, team_id: team, before, after, details: {} });
}
function usageFor(team) {
  const members = Object.entries(state.members[team.id] ?? {}).map(([uid, role]) => ({
    user_id: uid, email: people.find((p) => p.id === uid).email, role, calls: uid === "u1" ? 12 : 3, input_tokens: uid === "u1" ? 52000 : 9000,
    output_tokens: 4000, cost: uid === "u1" ? 0.31 : 0.06, unpriced_tokens: 0, last_active: "2026-11-04T10:00:00Z", runs: 2, deployed_runs: 0,
  }));
  const sum = (k) => members.reduce((n, m) => n + m[k], 0);
  return {
    team: { id: team.id, name: team.name }, members, currency: "USD", days: 30,
    totals: { calls: sum("calls"), input_tokens: sum("input_tokens"), output_tokens: sum("output_tokens"), cost: sum("cost"), unpriced_tokens: 0, runs: 4, deployed_runs: 0 },
    by_day: [], by_model: [], by_project: [], by_kind: [], recent_runs: [], deployments: [], sync_available: false,
  };
}

function mayAllocateFrom(parent) {
  if (isMaster()) return true;
  if (isSub()) return parent.id === "pool:sub1" || ancestors(parent).some((a) => a.id === "pool:sub1");
  return parent.scope_type === "team" && adminsTeam(parent.scope_id);
}
function ancestors(n) {
  const out = [];
  for (let cur = n; cur?.parent_id; ) {
    cur = node_(cur.parent_id);
    if (cur) out.push(cur);
  }
  return out;
}
function maySee(n) {
  if (isMaster() || n.id === "user:u1") return true;
  if (mayAllocateFrom(n)) return true;
  const parent = n.parent_id ? node_(n.parent_id) : null;
  return Boolean(parent && mayAllocateFrom(parent));
}

export async function handleAccess({ req, res, path, readBody, send, orgRole, setOrgRole }) {
  state.orgRole = orgRole ?? state.orgRole;
  const method = req.method;
  const q = new URL(req.url, "http://x").searchParams;
  const fail = (status, error_type, message) => send(res, status, { error_type, message, details: null });

  if (path === "/__access_as" && method === "POST") {
    const body = await readBody(req);
    state.orgRole = body.orgRole ?? "user";
    if (body.projectLevel) state.projectLevel = body.projectLevel;
    state.projectRestricted = Boolean(body.restricted);
    setOrgRole(state.orgRole);
    for (const [team, role] of Object.entries(body.teams ?? {})) {
      state.members[team] ??= {};
      if (role) state.members[team].u1 = role;
      else delete state.members[team].u1;
    }
    return send(res, 200, { ok: true, role: state.orgRole });
  }
  if (path === "/__access_state") return send(res, 200, { audit: state.audit, grants: state.grants, budgets: state.budgets, orgModels: state.orgModels, allowlists: state.allowlists, members: state.members });

  // ---- teams
  if (path === "/teams" && method === "GET") return send(res, 200, { teams: visibleTeams().map(teamBody) });
  if (path === "/teams" && method === "POST") {
    if (!isMaster()) return send(res, 404, notFound);
    const { name } = await readBody(req);
    const team = { id: `t${state.teams.length + 1}`, name, created_at: "2026-11-05T00:00:00Z" };
    state.teams.push(team);
    state.members[team.id] = {};
    addAudit("team.created", team.id, team.id, null, { name });
    return send(res, 201, { team: teamBody(team) });
  }
  const t = path.match(/^\/teams\/([^/]+)(?:\/(.*))?$/);
  if (t) {
    const [, id, rest] = t;
    const team = state.teams.find((x) => x.id === id);
    const visible = team && (isMaster() || myRole(id));
    if (!visible) return send(res, 404, notFound);
    const manage = isMaster() || adminsTeam(id);
    if (!rest && method === "GET") return send(res, 200, { team: teamBody(team) });
    if (!rest && method === "PATCH") {
      if (!manage) return send(res, 404, notFound);
      const { name } = await readBody(req);
      addAudit("team.renamed", id, id, { name: team.name }, { name });
      team.name = name;
      return send(res, 200, { team: teamBody(team) });
    }
    if (!rest && method === "DELETE") {
      if (!isMaster()) return send(res, 404, notFound);
      if (id === "default") return fail(409, "TeamProtected", "the Default team can be renamed but not deleted");
      state.teams = state.teams.filter((x) => x.id !== id);
      delete state.members[id];
      addAudit("team.deleted", id, id, { name: team.name });
      return send(res, 200, { deleted: id, projects_made_personal: 0 });
    }
    if (rest === "members" && method === "GET") {
      if (!manage) return send(res, 404, notFound);
      const members = Object.entries(state.members[id]).map(([uid, role]) => ({ user_id: uid, email: people.find((p) => p.id === uid).email, role, added_at: "2026-10-01T00:00:00Z" }));
      return send(res, 200, { members });
    }
    const m = rest?.match(/^members\/([^/]+)$/);
    if (m && method === "PUT") {
      if (!isMaster()) return send(res, 404, notFound);
      state.members[id][m[1]] ??= "member";
      addAudit("team.member_added", m[1], id, null, { role: "member" });
      return send(res, 200, { membership: { team_id: id, user_id: m[1], role: state.members[id][m[1]] } });
    }
    if (m && method === "DELETE") {
      if (!manage || !state.members[id][m[1]]) return send(res, 404, notFound);
      if (state.members[id][m[1]] === "group_admin" && !isMaster() && m[1] !== "u1") return send(res, 404, notFound);
      addAudit("team.member_removed", m[1], id, { role: state.members[id][m[1]] });
      delete state.members[id][m[1]];
      return send(res, 200, { removed: m[1] });
    }
    const a = rest?.match(/^admins\/([^/]+)$/);
    if (a && method === "PUT") {
      if (!manage) return send(res, 404, notFound);
      if (!state.members[id][a[1]]) return fail(409, "NotATeamMember", "that person is not a member of this team; add them to the team first");
      state.members[id][a[1]] = "group_admin";
      addAudit("team.group_admin_granted", a[1], id, { role: "member" }, { role: "group_admin" });
      return send(res, 200, { membership: { team_id: id, user_id: a[1], role: "group_admin" } });
    }
    if (a && method === "DELETE") {
      if (!(isMaster() || a[1] === "u1")) return send(res, 404, notFound);
      state.members[id][a[1]] = "member";
      addAudit("team.group_admin_revoked", a[1], id, { role: "group_admin" }, { role: "member" });
      return send(res, 200, { membership: { team_id: id, user_id: a[1], role: "member" } });
    }
    if (rest === "usage" && method === "GET") {
      if (!manage) return send(res, 404, notFound);
      return send(res, 200, usageFor(team));
    }
    if (rest === "models" && method === "GET") {
      if (!manage) return send(res, 404, notFound);
      const list = (type, sid) => state.allowlists.find((l) => l.scope_type === type && l.scope_id === sid);
      return send(res, 200, {
        offered: OFFERED, org: { ...state.orgModels, updated_by: null, updated_at: null }, team: list("team", id) ?? null,
        members: state.allowlists.filter((l) => l.scope_type === "member" && l.scope_id.startsWith(`${id}:`)),
      });
    }
    if (rest === "models" && (method === "PUT" || method === "DELETE")) {
      if (!isMaster()) return send(res, 404, notFound);
      state.allowlists = state.allowlists.filter((l) => !(l.scope_type === "team" && l.scope_id === id));
      if (method === "PUT") {
        const { models } = await readBody(req);
        state.allowlists.push({ scope_type: "team", scope_id: id, models, set_by: "u1", updated_at: "2026-11-05T00:00:00Z" });
        addAudit("model.allowlist_set", `team:${id}`, id, null, { models });
        return send(res, 200, { allowlist: state.allowlists.at(-1) });
      }
      return send(res, 200, { cleared: true });
    }
    const mm = rest?.match(/^members\/([^/]+)\/models$/);
    if (mm && (method === "PUT" || method === "DELETE")) {
      if (!manage || !state.members[id][mm[1]]) return send(res, 404, notFound);
      const sid = `${id}:${mm[1]}`;
      state.allowlists = state.allowlists.filter((l) => !(l.scope_type === "member" && l.scope_id === sid));
      if (method === "PUT") {
        const { models } = await readBody(req);
        const teamList = state.allowlists.find((l) => l.scope_type === "team" && l.scope_id === id);
        const mine = teamList?.models ?? OFFERED;
        const allowed = (ref) => mine.some((p) => p === ref || (p.endsWith("/*") && ref.startsWith(p.slice(0, -1))));
        const over = models.filter((ref) => OFFERED.filter((o) => o === ref || (ref.endsWith("/*") && o.startsWith(ref.slice(0, -1)))).some((o) => !allowed(o)));
        if (over.length) return fail(403, "ModelAboveYourOwn", `you cannot grant models you may not use yourself: ${over.join(", ")}`);
        state.allowlists.push({ scope_type: "member", scope_id: sid, models, set_by: "u1", updated_at: "2026-11-05T00:00:00Z" });
        addAudit("model.allowlist_set", `member:${sid}`, id, null, { models });
        return send(res, 200, { allowlist: state.allowlists.at(-1) });
      }
      return send(res, 200, { cleared: true });
    }
    return send(res, 404, notFound);
  }

  // ---- audit
  if (path === "/audit" && method === "GET") {
    const mine = state.teams.filter((x) => adminsTeam(x.id)).map((x) => x.id);
    if (!(isMaster() || isSub()) && mine.length === 0) return send(res, 404, notFound);
    const team = q.get("team_id");
    let rows = state.audit;
    if (!(isMaster() || isSub())) {
      if (team && !mine.includes(team)) return send(res, 404, notFound);
      rows = rows.filter((e) => (team ? e.team_id === team : mine.includes(e.team_id)));
    } else if (team) rows = rows.filter((e) => e.team_id === team);
    return send(res, 200, { entries: rows.slice(0, Number(q.get("limit") ?? 100)) });
  }

  // ---- budgets
  if (path === "/budgets" && method === "GET") return send(res, 200, { budgets: state.budgets.filter(maySee) });
  if (path === "/me/budget") {
    const chain = ["user:u1", ...(q.get("project_id") ? ["team:A"] : [])].map(node_).filter(Boolean);
    return send(res, 200, {
      chain: chain.map((n) => ({ id: n.id, scope_type: n.scope_type, amount: n.amount, remaining: n.remaining, percent_used: Math.round((100 * n.spent) / n.amount), thresholds_reached: n.spent * 100 >= 80 * n.amount ? [80] : [], period: n.period, hard_limit: n.hard_limit })),
      tightest_remaining: Math.min(...["user:u1", "team:A", "pool:sub1", "org"].map(node_).filter((n) => n.hard_limit).map((n) => n.remaining)),
    });
  }
  const b = path.match(/^\/budgets\/([^/]+)\/([^/]+)$/);
  if (b && method === "PUT") {
    const [, scope, sid] = b;
    const body = await readBody(req);
    const id = scope === "org" ? "org" : `${scope}:${sid}`;
    const existing = node_(id);
    const parentId = existing ? existing.parent_id : body.parent ?? (isSub() ? "pool:sub1" : scope === "pool" ? "org" : null);
    if (scope === "org") return isMaster() ? send(res, 200, { budget: existing }) : send(res, 404, notFound);
    const parent = parentId ? node_(parentId) : null;
    if (!parent) return fail(parentId ? 422 : 422, parentId ? "BudgetParentMissing" : "BudgetParentRequired", "say which budget to allocate from (parent)");
    if (!mayAllocateFrom(parent)) return send(res, 404, notFound);
    if (!Number.isInteger(body.amount) || body.amount < 0) return fail(422, "ValidationError", "amount must be a whole number of micro-USD");
    const delta = body.amount - (existing?.amount ?? 0);
    const handedOn = existing ? childrenOf(id).reduce((n, c) => n + c.amount, 0) : 0;
    const parentFree = parent.amount - childrenOf(parent.id).reduce((n, c) => n + c.amount, 0);
    if (delta > parentFree) return fail(409, "BudgetExceedsParent", `the parent has only ${parentFree} left to allocate`);
    if (existing && (body.amount < existing.spent || body.amount < handedOn)) return fail(409, "BudgetBelowUsed", "the budget cannot go below what is spent or handed on");
    if (existing) {
      Object.assign(existing, { amount: body.amount, remaining: body.amount - existing.spent, ...(body.hard_limit === undefined ? {} : { hard_limit: body.hard_limit }), ...(body.thresholds ? { thresholds: body.thresholds } : {}), ...(body.period ? { period: body.period } : {}) });
      addAudit("budget.changed", id, scope === "team" ? sid : null, null, { amount: body.amount });
      return send(res, 200, { budget: { ...existing, percent_used: 0 } });
    }
    const made = node(scope, sid, parentId, body.amount, 0);
    Object.assign(made, { hard_limit: body.hard_limit ?? true, thresholds: body.thresholds ?? [80, 100], period: body.period ?? "monthly" });
    state.budgets.push(made);
    addAudit("budget.created", id, scope === "team" ? sid : null, null, { amount: body.amount, parent: parentId });
    return send(res, 200, { budget: made });
  }
  if (b && method === "DELETE") {
    const id = `${b[1]}:${b[2]}`;
    const n = node_(id);
    const parent = n?.parent_id ? node_(n.parent_id) : null;
    if (!n || !parent || !mayAllocateFrom(parent)) return send(res, 404, notFound);
    if (childrenOf(id).length) return fail(409, "BudgetHasChildren", "remove the budgets allocated from this one first");
    state.budgets = state.budgets.filter((x) => x.id !== id);
    addAudit("budget.deleted", id, null, { amount: n.amount });
    return send(res, 200, { deleted: id });
  }

  // ---- model privileges
  if (path === "/admin/models" && method === "GET") {
    if (!(isMaster() || isSub())) return send(res, 404, notFound);
    return send(res, 200, { offered: OFFERED, org: { ...state.orgModels, updated_by: null, updated_at: null }, allowlists: state.allowlists });
  }
  if (path === "/admin/models/org" && method === "PUT") {
    if (!(isMaster() || isSub())) return send(res, 404, notFound);
    if (!isMaster()) return fail(403, "MasterAdminRequired", "only the master admin can add or remove admins");
    const body = await readBody(req);
    const bad = [...(body.catalog ?? []), ...(body.unpriced_overrides ?? [])].find((r) => !OFFERED.some((o) => o === r || (r.endsWith("/*") && o.startsWith(r.slice(0, -1)))));
    if (bad) return fail(422, "UnknownModel", `the platform does not offer: ${bad}`);
    state.orgModels = { catalog: body.catalog ?? null, fallback_model: body.fallback_model ?? null, unpriced_overrides: body.unpriced_overrides ?? [] };
    addAudit("model.org_updated", "org", null, null, state.orgModels);
    return send(res, 200, { org: { ...state.orgModels, updated_by: "u1", updated_at: "2026-11-05T00:00:00Z" } });
  }
  if (path === "/me/models" && method === "GET") {
    const teamList = q.get("project_id") ? state.allowlists.find((l) => l.scope_type === "team" && l.scope_id === "A") : null;
    const member = q.get("project_id") ? state.allowlists.find((l) => l.scope_type === "member" && l.scope_id === "A:u1") : null;
    const cover = (list, k) => list.models.some((p) => p === k || (p.endsWith("/*") && k.startsWith(p.slice(0, -1))));
    return send(res, 200, {
      models: OFFERED.map((k) => {
        let by = null;
        if (state.orgModels.catalog && !cover({ models: state.orgModels.catalog }, k)) by = "org";
        else if (teamList && !cover(teamList, k)) by = "team";
        else if (member && !cover(member, k)) by = "member";
        return { model: k, allowed: by === null, blocked_by: by };
      }),
      fallback_model: state.orgModels.fallback_model,
    });
  }

  // ---- sharing
  const g = path.match(/^\/projects\/([^/]+)\/(grants|share-targets)(?:\/(.+))?$/);
  if (g && g[1] === PROJECT_ID) {
    if (g[2] === "share-targets") {
      return send(res, 200, {
        teams: state.teams.filter((x) => myRole(x.id)).map((x) => ({ id: x.id, name: x.name })),
        users: people.filter((p) => p.id !== "u1").map((p) => ({ id: p.id, email: p.email })),
      });
    }
    if (!g[3] && method === "GET") return send(res, 200, { grants: state.grants });
    if (!g[3] && method === "PUT") {
      const body = await readBody(req);
      if (body.grantee_type === "user" && !people.some((p) => p.id === body.grantee_id)) return send(res, 404, notFound);
      const id = `${PROJECT_ID}:${body.agent_id}:${body.grantee_type}:${body.grantee_id}`;
      const prev = state.grants.find((x) => x.id === id);
      const grant = { id, project_id: PROJECT_ID, agent_id: body.agent_id, grantee_type: body.grantee_type, grantee_id: body.grantee_id, level: body.level, granted_by: "u1", granted_at: "2026-11-05T00:00:00Z" };
      state.grants = [...state.grants.filter((x) => x.id !== id), grant];
      if (!prev || prev.level !== body.level) addAudit("agent.shared", id, "A", prev ? { level: prev.level } : null, { level: body.level });
      return send(res, 200, { grant });
    }
    if (g[3] && method === "DELETE") {
      const id = decodeURIComponent(g[3]);
      if (!state.grants.some((x) => x.id === id)) return send(res, 404, notFound);
      state.grants = state.grants.filter((x) => x.id !== id);
      addAudit("agent.share_revoked", id, "A");
      return send(res, 200, { revoked: id });
    }
  }
  return false;
}
