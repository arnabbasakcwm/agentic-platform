// Pure helpers for the Admin page: sorting and filtering the users table.

export const SORTS = {
  cost: { label: "Estimated cost", value: (u) => u.cost ?? 0 },
  tokens: {
    label: "Tokens",
    value: (u) => (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
  },
  active: {
    label: "Last active",
    value: (u) => (u.last_active ? new Date(u.last_active).getTime() : 0),
  },
  joined: {
    label: "Joined",
    value: (u) => (u.created_at ? new Date(u.created_at).getTime() : 0),
  },
};

/** Users matching `query` (by email, case-insensitive), sorted by `key`, highest first;
 * ties fall back to email so the order is stable. */
export function visibleUsers(users, { query = "", key = "cost" } = {}) {
  const q = query.trim().toLowerCase();
  const sort = SORTS[key] ?? SORTS.cost;
  return users
    .filter((u) => !q || u.email.toLowerCase().includes(q))
    .sort(
      (a, b) => sort.value(b) - sort.value(a) || a.email.localeCompare(b.email),
    );
}

/** Whether a role opens the admin area: admins and the one master admin. */
export const isAdminRole = (role) => role === "admin" || role === "master";

/** Whether `me` may change `user`'s role: only the master, and never the master's own
 * (the API enforces both). */
export const canChangeRole = (me, user) =>
  me?.role === "master" && user.role !== "master";

/** The badge for a role, or null for a plain user. */
export const roleBadge = (role) =>
  role === "master" ? "Master admin" : role === "admin" ? "Admin" : null;
