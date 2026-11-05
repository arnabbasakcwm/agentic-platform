import { useCallback, useEffect, useState } from "react";
import { Empty, ErrorCallout, Panel, Skeleton } from "../ui.jsx";
import { api } from "../../lib/api.js";
import { fullDate, timeAgo } from "../../lib/format.js";
import { formatCount, formatTokens } from "../../lib/usage.js";
import { useAction } from "../../lib/useAction.js";
import { RANGES, UsageDashboard, costCell } from "../../pages/UsagePage.jsx";
import { teamRoleLabel } from "../../lib/access.js";

// What the audit log's action names say, in words.
const ACTIONS = {
  "team.created": "Team created",
  "team.renamed": "Team renamed",
  "team.deleted": "Team deleted",
  "team.member_added": "Member added",
  "team.member_removed": "Member removed",
  "team.group_admin_granted": "Made group admin",
  "team.group_admin_revoked": "Group admin role removed",
  "agent.shared": "Project shared",
  "agent.share_revoked": "Share removed",
  "budget.created": "Budget created",
  "budget.changed": "Budget changed",
  "budget.deleted": "Budget removed",
  "budget.threshold": "Budget threshold reached",
  "budget.blocked": "Run stopped: budget used up",
  "model.allowlist_set": "Model limit set",
  "model.allowlist_cleared": "Model limit removed",
  "model.blocked": "Run stopped: model not allowed",
  "model.fallback": "Fallback model used",
  "model.fallback_set": "Fallback model set",
  "model.fallback_cleared": "Fallback model removed",
  "model.org_updated": "Organisation models changed",
  "user.role_changed": "Role changed",
};

export const actionLabel = (action) => ACTIONS[action] ?? action;

/** A short, safe summary of an entry's before/after values (ids and small values only). */
function summary(e) {
  const pick = (v) =>
    v ? Object.entries(v).map(([k, x]) => `${k}: ${Array.isArray(x) ? x.join(", ") : x}`).join("; ") : "";
  const before = pick(e.before);
  const after = pick(e.after);
  if (before && after) return `${before} → ${after}`;
  return after || before || e.target_id;
}

/** The team's usage (only what its shared projects used) and the audit log of changes to it. */
export function ActivityTab({ team }) {
  const [days, setDays] = useState(30);
  const [usage, setUsage] = useState(null);
  const [entries, setEntries] = useState(null);
  const [tab, setTab] = useState("models");
  const loadUsage = useAction();
  const loadAudit = useAction();
  const { run: runUsage } = loadUsage;
  const { run: runAudit } = loadAudit;

  const reload = useCallback(() => {
    runUsage(() => api.teamUsage(team.id, days)).then((r) => r && setUsage(r));
    runAudit(() => api.audit({ teamId: team.id, limit: 50 })).then((r) => r && setEntries(r.entries));
  }, [runUsage, runAudit, team.id, days]);
  useEffect(() => {
    reload();
  }, [reload]);

  const currency = usage?.currency ?? "USD";
  return (
    <div className="stack">
      <div className="ufilters" role="group" aria-label="Activity filters">
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
      </div>

      {!usage ? (
        <Panel>{loadUsage.error ? <ErrorCallout error={loadUsage.error} /> : <Skeleton lines={4} />}</Panel>
      ) : (
        <>
          <Panel
            title="Who used it"
            subtitle="Only what the team's shared projects used. Personal projects and owner-only projects aren't counted."
            flush
          >
            <table className="table table--stack">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Role</th>
                  <th className="table__num">Calls</th>
                  <th className="table__num">Tokens in / out</th>
                  <th className="table__num">Est. cost</th>
                  <th>Last active</th>
                </tr>
              </thead>
              <tbody>
                {usage.members.map((m) => (
                  <tr key={m.user_id}>
                    <td>{m.email}</td>
                    <td>{teamRoleLabel(m.role)}</td>
                    <td className="table__num">{formatCount(m.calls)}</td>
                    <td className="table__num">
                      {formatTokens(m.input_tokens)} / {formatTokens(m.output_tokens)}
                    </td>
                    <td className="table__num">{costCell(m, currency)}</td>
                    <td>{m.last_active ? timeAgo(m.last_active) : <span className="muted">No activity</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
          <UsageDashboard
            data={usage}
            days={days}
            pricing={null}
            showProjects
            linkProjects={false}
            tab={tab}
            onTabChange={setTab}
            resetKey={`${team.id}-${days}`}
          />
        </>
      )}

      <Panel title="Recent changes" subtitle="Who changed what for this team" flush>
        {!entries ? (
          <div className="panel__body">
            {loadAudit.error ? <ErrorCallout error={loadAudit.error} /> : <Skeleton lines={3} />}
          </div>
        ) : entries.length === 0 ? (
          <div className="panel__body">
            <Empty title="Nothing recorded yet" />
          </div>
        ) : (
          <table className="table table--stack">
            <thead>
              <tr>
                <th>When</th>
                <th>What happened</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td title={fullDate(e.at)}>{timeAgo(e.at)}</td>
                  <td>{actionLabel(e.action)}</td>
                  <td>
                    <span className="mono">{summary(e)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
