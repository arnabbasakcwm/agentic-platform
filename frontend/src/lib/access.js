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
  const digits = abs >= 100 ? 0 : abs >= 1 ? 2 : 4;
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
