import { Activity, Coins, UserCheck, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Callout,
  Empty,
  ErrorCallout,
  PageHeader,
  Panel,
  Pill,
  Skeleton,
} from "../components/ui.jsx";
import { SORTS, canChangeRole, roleBadge, visibleUsers } from "../lib/admin.js";
import { api } from "../lib/api.js";
import { fullDate, timeAgo } from "../lib/format.js";
import { formatCost, formatCount, formatTokens } from "../lib/usage.js";
import { paths } from "../lib/router.js";
import { useAction } from "../lib/useAction.js";
import { RANGES, Stat, costCell } from "./UsagePage.jsx";

/** Make admin / Remove admin, confirmed inline. Only the master admin sees it, and
 * never for the master's own role. */
export function RoleControl({ user, me, onChanged }) {
  const [confirming, setConfirming] = useState(false);
  const save = useAction();
  const makeAdmin = user.role !== "admin";

  async function apply() {
    const res = await save.run(() =>
      api.setUserRole(user.id, makeAdmin ? "admin" : "user"),
    );
    setConfirming(false);
    if (res) onChanged(res.user);
  }

  if (!canChangeRole(me, user)) return null;
  if (confirming) {
    return (
      <span
        className="admin__confirm"
        role="group"
        aria-label={`Confirm role change for ${user.email}`}
      >
        <span className="admin__confirm-text">
          {makeAdmin
            ? `Give ${user.email} admin access to every user's usage?`
            : `Remove ${user.email}'s admin access?`}
        </span>
        <Button
          size="sm"
          variant={makeAdmin ? "primary" : "danger"}
          onClick={apply}
          loading={save.busy}
        >
          {makeAdmin ? "Make admin" : "Remove admin"}
        </Button>
        <Button
          size="sm"
          onClick={() => setConfirming(false)}
          disabled={save.busy}
        >
          Cancel
        </Button>
        <ErrorCallout error={save.error} />
      </span>
    );
  }
  return (
    <Button
      size="sm"
      onClick={() => setConfirming(true)}
      aria-label={`${makeAdmin ? "Make admin" : "Remove admin"}: ${user.email}`}
    >
      {makeAdmin ? "Make admin" : "Remove admin"}
    </Button>
  );
}

/** Every user, with their tokens and estimated cost (admins only; usage, not content). */
export function AdminPage({ me }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("cost");
  const load = useAction();
  const { run: runLoad } = load;

  const reload = useCallback(
    () =>
      runLoad(() => api.adminUsers(days)).then((body) => body && setData(body)),
    [runLoad, days],
  );

  useEffect(() => {
    reload();
  }, [reload]);

  const users = useMemo(
    () => visibleUsers(data?.users ?? [], { query, key: sort }),
    [data, query, sort],
  );
  const currency = data?.currency ?? "USD";

  return (
    <div className="page">
      <PageHeader
        title="Admin"
        subtitle={`Everyone using the platform, with their tokens and estimated cost. Usage only: briefs, plans, runs and files stay private to each user.${me.role === "master" ? "" : " Only the master admin adds and removes admins."}`}
      />

      <div className="ufilters" role="group" aria-label="Admin filters">
        <div className="segmented" role="group" aria-label="Period">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              className={`segmented__item${days === r ? " segmented__item--on" : ""}`}
              aria-pressed={days === r}
              onClick={() => setDays(r)}
            >
              {r} days
            </button>
          ))}
        </div>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by email"
          aria-label="Filter users by email"
        />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          aria-label="Sort users by"
        >
          {Object.entries(SORTS).map(([key, s]) => (
            <option key={key} value={key}>
              Sort: {s.label}
            </option>
          ))}
        </select>
        {load.busy && data && <span className="muted">Updating…</span>}
      </div>

      {!data ? (
        <Panel>
          {load.error ? (
            <ErrorCallout error={load.error} />
          ) : (
            <Skeleton lines={5} />
          )}
        </Panel>
      ) : (
        <div className="stack">
          <div className="kstats" aria-label="Platform totals for the period">
            <Stat
              label="Users"
              tone="violet"
              icon={Users}
              value={formatCount(data.totals.users)}
              amount={data.totals.users}
              format={(v) => formatCount(Math.round(v))}
            />
            <Stat
              label="Active users"
              tone="teal"
              icon={UserCheck}
              value={formatCount(data.totals.active_users)}
              amount={data.totals.active_users}
              format={(v) => formatCount(Math.round(v))}
              hint={`in ${data.days} days`}
            />
            <Stat
              label="Tokens"
              tone="sky"
              icon={Activity}
              value={formatTokens(
                data.totals.input_tokens + data.totals.output_tokens,
              )}
              amount={data.totals.input_tokens + data.totals.output_tokens}
              format={(v) => formatTokens(Math.round(v))}
            />
            <Stat
              label="Estimated cost"
              tone="pink"
              icon={Coins}
              value={`~${formatCost(data.totals.cost, currency)}`}
              amount={data.totals.cost}
              format={(v) => `~${formatCost(v, currency)}`}
              hint={
                data.totals.unpriced_tokens > 0
                  ? `${currency} · some models unpriced`
                  : currency
              }
            />
          </div>

          <Panel
            title="Users"
            subtitle={`${users.length} of ${data.users.length}`}
            flush
          >
            {users.length === 0 ? (
              <div className="panel__body">
                <Empty title="No users match" />
              </div>
            ) : (
              <table className="table table--stack admin__table">
                <thead>
                  <tr>
                    <th>User</th>
                    <th className="table__num">Projects</th>
                    <th>Last active</th>
                    <th className="table__num">Calls</th>
                    <th className="table__num">Tokens in / out</th>
                    <th className="table__num">Est. cost</th>
                    <th>
                      <span className="sr-only">Role</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td>
                        <a
                          className="admin__email"
                          href={paths.adminUser(u.id)}
                          title={`Open ${u.email}'s usage`}
                        >
                          {u.email}
                        </a>
                        <span className="table__sub">
                          {roleBadge(u.role) && (
                            <Pill tone="accent">{roleBadge(u.role)}</Pill>
                          )}{" "}
                          joined {timeAgo(u.created_at)}
                          {u.id === me.id && " · you"}
                        </span>
                      </td>
                      <td className="table__num">{formatCount(u.projects)}</td>
                      <td title={u.last_active ? fullDate(u.last_active) : ""}>
                        {u.last_active ? (
                          timeAgo(u.last_active)
                        ) : (
                          <span className="muted">No activity</span>
                        )}
                      </td>
                      <td className="table__num">{formatCount(u.calls)}</td>
                      <td className="table__num">
                        {formatTokens(u.input_tokens)} /{" "}
                        {formatTokens(u.output_tokens)}
                      </td>
                      <td className="table__num">{costCell(u, currency)}</td>
                      <td className="admin__actions">
                        <RoleControl
                          user={u}
                          me={me}
                          onChanged={() => reload()}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
          <Callout tone="info" title="How cost is counted">
            The same way as each user&apos;s own Usage page: tokens reported by
            the model providers, priced from the platform&apos;s price table at
            the time of use. Models without a confirmed price show as unpriced,
            never guessed.
          </Callout>
        </div>
      )}
    </div>
  );
}
