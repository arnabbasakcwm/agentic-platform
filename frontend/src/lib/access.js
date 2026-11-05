// Delegated administration, as the console shows it. Everything here is presentation: the API
// enforces every rule again, and a control hidden here is never the only protection.

// A team role is per team; it is not the org-level role (master / admin / user).
const TEAM_ROLE_LABELS = { group_admin: "Group admin", member: "Member" };
export const teamRoleLabel = (role) => TEAM_ROLE_LABELS[role] ?? role;

// What a person may do with a shared project or agent. Each level includes the ones before it.
export const LEVELS = ["view", "use", "edit", "manage"];
export const LEVEL_LABELS = {
  view: "View",
  use: "Use",
  edit: "Edit",
  manage: "Manage",
};
export const LEVEL_HELP = {
  view: "Can see the plan, not run it",
  use: "Can run it, and sees only their own runs",
  edit: "Can also compile it and change the plan",
  manage: "Can also share it with others",
};
export const levelRank = (level) => LEVELS.indexOf(level) + 1;

// Money is whole micro-USD (1 USD = 1,000,000) from the API; floats never carry it.
export function formatMicro(micro, currency = "USD") {
  if (micro === null || micro === undefined) return "—";
  const usd = micro / 1_000_000;
  const abs = Math.abs(usd);
  // Whole dollars show without cents; otherwise cents, or four places below a dollar. Never rounded away.
  const digits = micro % 1_000_000 === 0 && abs >= 1 ? 0 : abs >= 1 ? 2 : 4;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(usd);
}

/** "12.5" -> 12500000. Null for anything that is not a plain amount of at most 6 decimals. */
export function parseDollars(text) {
  const match = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(String(text).trim());
  if (!match) return null;
  const [, whole, fraction = ""] = match;
  return Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0"));
}

/** Micro-USD as an editable amount ("12.5"). */
export function microToDollars(micro) {
  const whole = Math.trunc(micro / 1_000_000);
  const fraction = String(Math.abs(micro) % 1_000_000)
    .padStart(6, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/** How full a budget is, for its bar: a tone and a width capped at 100%. */
export function meter(node) {
  const percent = node.amount
    ? (100 * (node.amount - node.remaining)) / node.amount
    : node.remaining < 0
      ? 100
      : 0;
  const tone = percent >= 100 ? "danger" : percent >= 80 ? "warn" : "ok";
  return { percent: Math.round(percent * 10) / 10, width: Math.min(100, Math.max(0, percent)), tone };
}

/** Who may reach what in the UI. The server decides; this only avoids offering what will be refused. */
export const canManageProject = (project) =>
  Boolean(project?.can_manage) || project?.access_level === "owner";
export const canRunProject = (project) =>
  ["use", "edit", "manage", "owner"].includes(project?.access_level) ||
  Boolean(project?.can_manage);
export const canEditProject = (project) =>
  ["edit", "manage", "owner"].includes(project?.access_level) ||
  Boolean(project?.can_manage);
export const canShareProject = (project) =>
  ["manage", "owner"].includes(project?.access_level) ||
  Boolean(project?.can_manage);

// The typed errors a run can end with, in words a person can act on.
const RUN_ERRORS = {
  BUDGET_EXCEEDED: {
    title: "Stopped: budget used up",
    body: "A budget limit was reached, so the run stopped before spending more. Agents that had finished kept their answers.",
  },
  MODEL_NOT_PERMITTED: {
    title: "Stopped: model not allowed for you",
    body: "An agent in this project uses a model you aren't permitted to use. Ask an admin for access, or for a fallback model.",
  },
  AccessRevokedError: {
    title: "Stopped: your access was removed",
    body: "Someone removed your access to this project while it was running.",
  },
  AccessRevoked: {
    title: "Stopped: your access was removed",
    body: "Someone removed your access to this project while it was running.",
  },
};

/** { title, body } for a run that ended with one of the access errors, else null. */
export function accessErrorInfo(errorType, message) {
  const known = RUN_ERRORS[errorType];
  if (!known) return null;
  return { ...known, detail: message || null };
}

/** The scope named in a BUDGET_EXCEEDED error ("user:…", "team:…", "pool:…", "org"), in words. */
export function budgetScopeLabel(scope) {
  if (!scope) return "A budget";
  if (scope === "org") return "The organisation's budget";
  const kind = scope.split(":")[0];
  return (
    { user: "Your own budget", team: "Your team's budget", pool: "Your administrator's pool" }[kind] ??
    "A budget"
  );
}

// ---------------------------------------------------------------------------------- budgets
// Which kind of budget may sit under which (the API enforces the same).
export const CHILD_KINDS = {
  org: ["pool", "team", "user"],
  pool: ["team", "user"],
  team: ["user"],
  user: [],
};

/** The visible budgets in tree order, each with its depth (a node whose parent isn't visible is a root). */
export function budgetTree(nodes) {
  const ids = new Set(nodes.map((n) => n.id));
  const kids = new Map();
  for (const n of nodes) {
    const key = n.parent_id && ids.has(n.parent_id) ? n.parent_id : null;
    kids.set(key, [...(kids.get(key) ?? []), n]);
  }
  const out = [];
  const walk = (parent, depth) => {
    for (const n of (kids.get(parent) ?? []).sort((a, b) => a.id.localeCompare(b.id))) {
      out.push({ ...n, depth });
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** The budgets this person may allocate FROM: you can only hand out what you hold. */
export function allocatableParents(nodes, me, teams = []) {
  if (me.role === "master") return nodes.filter((n) => n.scope_type !== "user");
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const below = (n, ancestor) => {
    for (let cur = n, hops = 0; cur && hops < 8; hops += 1) {
      if (cur.id === ancestor) return true;
      cur = cur.parent_id ? byId.get(cur.parent_id) : null;
    }
    return false;
  };
  if (me.role === "admin") {
    return nodes.filter((n) => n.scope_type !== "user" && below(n, `pool:${me.id}`));
  }
  const administered = new Set(teams.filter((t) => t.my_role === "group_admin").map((t) => `team:${t.id}`));
  return nodes.filter((n) => administered.has(n.id));
}

/** A budget in words: the team's or person's name when known, else a short id. */
export function budgetLabel(node, { teams = [], users = [] } = {}) {
  if (node.scope_type === "org") return "Organisation";
  if (node.scope_type === "team") return teams.find((t) => t.id === node.scope_id)?.name ?? `Team ${node.scope_id}`;
  const who = users.find((u) => u.id === node.scope_id)?.email ?? `${node.scope_id.slice(0, 6)}…`;
  return node.scope_type === "pool" ? `${who} (pool)` : who;
}
