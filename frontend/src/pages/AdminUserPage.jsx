import { useCallback, useEffect, useState } from "react";
import {
  ErrorCallout,
  PageHeader,
  Panel,
  Pill,
  Skeleton,
} from "../components/ui.jsx";
import { api } from "../lib/api.js";
import { fullDate, projectTitle, timeAgo } from "../lib/format.js";
import { paths } from "../lib/router.js";
import { formatCount } from "../lib/usage.js";
import { roleBadge } from "../lib/admin.js";
import { useAction } from "../lib/useAction.js";
import { RoleControl } from "./AdminPage.jsx";
import { RANGES, UsageDashboard } from "./UsagePage.jsx";

/**
 * One user's full usage, as their own Usage page shows it (admins only): totals, cost
 * per day, by model, activity and project, and recent runs with each agent's tokens.
 * Usage only: project names are labels, never links, and no project content is shown.
 */
export function AdminUserPage({ userId, me }) {
  const [days, setDays] = useState(30);
  const [projectId, setProjectId] = useState("");
  const [data, setData] = useState(null);
  const [pricing, setPricing] = useState(null);
  const load = useAction();
  const { run: runLoad } = load;

  const reload = useCallback(
    () =>
      runLoad(() =>
        api.adminUserUsage(userId, days, projectId || undefined),
      ).then((body) => body && setData(body)),
    [runLoad, userId, days, projectId],
  );

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    api
      .usagePricing()
      .then(setPricing)
      .catch(() => {});
  }, []);

  const user = data?.user;
  const back = (
    <a className="btn btn--sm" href={paths.admin}>
      Back to all users
    </a>
  );

  if (!data) {
    return (
      <div className="page">
        <PageHeader title="User usage" actions={back} />
        <Panel>
          {load.error ? (
            <ErrorCallout error={load.error} />
          ) : (
            <Skeleton lines={5} />
          )}
        </Panel>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title={<h1 className="pagehead__title admin__title">{user.email}</h1>}
        subtitle="Everything this user's projects used, counted exactly as their own Usage page counts it. Usage only: briefs, plans, runs and files stay private."
        meta={
          <span className="admin__meta">
            {roleBadge(user.role) && (
              <Pill tone="accent">{roleBadge(user.role)}</Pill>
            )}
            <span title={fullDate(user.created_at)}>
              Joined {timeAgo(user.created_at)}
            </span>
            <span>
              {formatCount(user.projects)}{" "}
              {user.projects === 1 ? "project" : "projects"}
            </span>
            {user.id === me.id && <span>You</span>}
            <RoleControl
              user={user}
              me={me}
              onChanged={() => reload()}
            />
          </span>
        }
        actions={back}
      />

      <div className="ufilters" role="group" aria-label="Usage filters">
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
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          aria-label="Filter by project"
        >
          <option value="">All projects</option>
          {data.projects.map((p) => (
            <option key={p.project_id} value={p.project_id}>
              {projectTitle(p.name, 50)}
            </option>
          ))}
        </select>
        {load.busy && <span className="muted">Updating…</span>}
      </div>

      <ErrorCallout error={load.error} />
      <UsageDashboard
        data={data}
        days={days}
        pricing={pricing}
        showProjects={!projectId}
        linkProjects={false}
      />

      <p className="unotes muted">
        Costs are estimates from list prices, recorded at the time of use.
        Deployed runs called straight through AWS appear here once they&apos;ve
        been read from the runtime&apos;s logs (a sync starts when this user
        opens their own Usage page).
      </p>
    </div>
  );
}
