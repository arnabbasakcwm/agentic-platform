import { useEffect, useState } from "react";
import { CostChart } from "../components/CostChart.jsx";
import { Icon } from "../components/icons.jsx";
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
import { api } from "../lib/api.js";
import { fullDate, projectTitle, timeAgo } from "../lib/format.js";
import { paths } from "../lib/router.js";
import { formatBytes } from "../lib/datasources.js";
import {
  formatCost,
  formatCount,
  formatTokens,
  kindLabel,
  providerLabel,
} from "../lib/usage.js";

// Data queries are measured in bytes billed, not tokens.
const isData = (row) => (row.bytes_billed ?? 0) > 0;
const inputCell = (row) =>
  isData(row)
    ? `${formatBytes(row.bytes_billed)} billed`
    : formatCount(row.input_tokens);
const outputCell = (row) =>
  isData(row) ? "—" : formatCount(row.output_tokens);
import { useAction } from "../lib/useAction.js";

const RANGES = [7, 30, 90];

function Stat({ label, value, hint }) {
  return (
    <div className="kstat">
      <span className="kstat__value mono">{value}</span>
      <span className="kstat__label">{label}</span>
      {hint && <span className="kstat__hint">{hint}</span>}
    </div>
  );
}

// Nothing priced at all (cost 0 but unpriced tokens) reads as "price not set", not "$0.00".
const costCell = (row, currency) =>
  row.cost === null ||
  row.cost === undefined ||
  (row.cost === 0 && (row.unpriced_tokens > 0 || row.unpriced_bytes > 0)) ? (
    <span className="muted">Price not set</span>
  ) : (
    <>
      ~{formatCost(row.cost, currency)}
      {(row.unpriced_tokens > 0 || row.unpriced_bytes > 0) && (
        <span className="muted"> + unpriced</span>
      )}
    </>
  );

function ModelsTable({ rows, currency }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Model</th>
          <th className="table__num">Calls</th>
          <th className="table__num">Input</th>
          <th className="table__num">Output</th>
          <th className="table__num">Est. cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((m) => (
          <tr key={`${m.provider}/${m.model}`}>
            <td>
              <span className="table__title mono">{m.model}</span>
              <span className="table__sub">
                {providerLabel(m.provider)}
                {m.estimated && " · tokens estimated"}
              </span>
            </td>
            <td className="table__num">{formatCount(m.calls)}</td>
            <td className="table__num">{inputCell(m)}</td>
            <td className="table__num">{outputCell(m)}</td>
            <td className="table__num">
              {m.priced ? (
                costCell(m, currency)
              ) : (
                <Pill tone="warn">Price not set</Pill>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function KindsTable({ rows, currency }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Activity</th>
          <th className="table__num">Calls</th>
          <th className="table__num">Tokens</th>
          <th className="table__num">Est. cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((k) => (
          <tr key={k.kind}>
            <td>{kindLabel(k.kind)}</td>
            <td className="table__num">{formatCount(k.calls)}</td>
            <td className="table__num">
              {isData(k)
                ? `${formatBytes(k.bytes_billed)} billed`
                : formatCount(k.input_tokens + k.output_tokens)}
            </td>
            <td className="table__num">{costCell(k, currency)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ProjectsTable({ rows, currency }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Project</th>
          <th className="table__num">Runs</th>
          <th className="table__num">Tokens</th>
          <th className="table__num">Est. cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <tr key={p.project_id ?? "none"}>
            <td>
              {p.exists ? (
                <a
                  className="table__title"
                  href={paths.project(p.project_id, "run")}
                >
                  {projectTitle(p.name, 60)}
                </a>
              ) : (
                <span className="muted">{p.name}</span>
              )}
            </td>
            <td className="table__num">{formatCount(p.runs)}</td>
            <td className="table__num">
              {formatCount(p.input_tokens + p.output_tokens)}
            </td>
            <td className="table__num">{costCell(p, currency)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RunRow({ run, currency }) {
  const [open, setOpen] = useState(false);
  const detailId = `run-${run.run_id}`;
  return (
    <li className="urun">
      <button
        type="button"
        className="urun__head"
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen((o) => !o)}
      >
        <span
          className={`urun__chevron${open ? " urun__chevron--open" : ""}`}
          aria-hidden="true"
        >
          <Icon name="chevronRight" size={14} />
        </span>
        <span className="urun__main">
          <span className="urun__project">{projectTitle(run.project, 56)}</span>
          <span className="urun__when" title={fullDate(run.at)}>
            {timeAgo(run.at)}
          </span>
        </span>
        {run.deployed ? (
          <Pill tone="accent">
            {run.via === "direct" ? "AgentCore · direct" : "AgentCore"}
          </Pill>
        ) : (
          <Pill>Local</Pill>
        )}
        <span className="urun__tokens mono">
          {formatTokens(run.input_tokens + run.output_tokens)} tokens
        </span>
        <span className="urun__cost mono">{costCell(run, currency)}</span>
      </button>
      {open && (
        <div id={detailId} className="urun__detail">
          <table className="table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Model</th>
                <th className="table__num">Calls</th>
                <th className="table__num">Input</th>
                <th className="table__num">Output</th>
                <th className="table__num">Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {run.agents.map((a, i) => (
                <tr key={i}>
                  <td className="mono">
                    {a.agent_id ?? "—"}
                    {a.kind === "embedding_query" && (
                      <span className="table__sub">knowledge search</span>
                    )}
                    {a.kind === "bigquery_query" && (
                      <span className="table__sub">data query</span>
                    )}
                  </td>
                  <td>
                    <span className="mono">{a.model}</span>
                    <span className="table__sub">
                      {providerLabel(a.provider)}
                      {a.estimated && " · estimated"}
                    </span>
                  </td>
                  <td className="table__num">{formatCount(a.calls)}</td>
                  <td className="table__num">{inputCell(a)}</td>
                  <td className="table__num">{outputCell(a)}</td>
                  <td className="table__num">{costCell(a, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </li>
  );
}

/**
 * Deployed runs invoked straight through AWS are counted from the runtimes' logs: show how
 * far each deployment has been read, warn about ones that can't report, and sync on demand.
 */
function DeployedSync({ deployments, available, onSynced }) {
  const sync = useAction();
  if (!deployments?.length) return null;
  const notReporting = deployments.filter((d) => !d.reports_usage);
  const failed = deployments.filter((d) => d.last_sync?.status === "failed");
  const synced = deployments
    .map((d) => d.synced_until)
    .filter(Boolean)
    .sort();
  const oldest = synced[0];

  async function syncNow() {
    const res = await sync.run(() => api.syncUsage());
    if (res) onSynced();
  }

  return (
    <div className="usync">
      <div className="usync__row">
        <span className="muted">
          Direct AWS calls to deployed flows are read from their logs —{" "}
          {oldest ? (
            <span title={fullDate(oldest)}>synced {timeAgo(oldest)}</span>
          ) : (
            "not synced yet"
          )}
          .
        </span>
        <Button
          size="sm"
          onClick={syncNow}
          loading={sync.busy}
          disabled={!available}
        >
          Sync now
        </Button>
      </div>
      {!available && (
        <Callout tone="warn" title="Can't read deployed usage">
          This server has no AWS credentials, so direct AWS calls to your
          deployments can&apos;t be counted.
        </Callout>
      )}
      {notReporting.length > 0 && (
        <Callout tone="warn" title="Redeploy to count direct AWS calls">
          {notReporting.map((d) => projectTitle(d.name, 50)).join(", ")}{" "}
          {notReporting.length === 1 ? "was" : "were"} deployed before runtimes
          reported their usage. Runs made through this platform are counted;
          calls straight through AWS aren&apos;t until you redeploy.
        </Callout>
      )}
      {failed.map((d) => (
        <Callout
          key={d.project_id}
          tone="danger"
          title={`Couldn't read usage for ${projectTitle(d.name, 40)}`}
        >
          {d.last_sync.detail}
        </Callout>
      ))}
      <ErrorCallout error={sync.error} />
    </div>
  );
}

/** Models, tokens and estimated cost of everything the user ran. */
export function UsagePage({ projects }) {
  const [days, setDays] = useState(30);
  const [projectId, setProjectId] = useState("");
  const [data, setData] = useState(null);
  const [pricing, setPricing] = useState(null);
  const [reload, setReload] = useState(0);
  const load = useAction();
  const { run: runLoad } = load;

  useEffect(() => {
    runLoad(() => api.usage(days, projectId || undefined)).then(
      (body) => body && setData(body),
    );
  }, [days, projectId, runLoad, reload]);

  useEffect(() => {
    api
      .usagePricing()
      .then(setPricing)
      .catch(() => {});
  }, []);

  const currency = data?.currency ?? "USD";
  const totals = data?.totals;

  return (
    <div className="page">
      <PageHeader
        title="Usage"
        subtitle="Which models your projects used, how many tokens, and what they cost — agent runs (local and on AgentCore), planning, the plan assistant, and knowledge indexing and searches."
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
          {(projects ?? []).map((p) => (
            <option key={p.project_id} value={p.project_id}>
              {projectTitle(p.brief, 50)}
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
        <>
          <ErrorCallout error={load.error} />
          <DeployedSync
            deployments={data.deployments}
            available={data.sync_available !== false}
            onSynced={() => setReload((n) => n + 1)}
          />
          <div className="kstats" aria-label="Totals for the period">
            <Stat
              label="Estimated cost"
              value={`~${formatCost(totals.cost, currency)}`}
              hint={currency}
            />
            <Stat
              label="Input tokens"
              value={formatTokens(totals.input_tokens)}
            />
            <Stat
              label="Output tokens"
              value={formatTokens(totals.output_tokens)}
            />
            <Stat label="Runs" value={formatCount(totals.runs)} />
            <Stat label="Model calls" value={formatCount(totals.calls)} />
            {isData(totals) && (
              <Stat
                label="BigQuery billed"
                value={formatBytes(totals.bytes_billed)}
                hint="price not set"
              />
            )}
          </div>

          {totals.calls === 0 ? (
            <Panel>
              <Empty title="No usage in this period">
                Plan a project, run it, or add knowledge files — every model
                call is counted here.
              </Empty>
            </Panel>
          ) : (
            <div className="stack">
              {(totals.unpriced_tokens > 0 ||
                pricing?.unpriced?.length > 0) && (
                <Callout tone="warn" title="Some models have no price yet">
                  {formatCount(totals.unpriced_tokens)} tokens in this period
                  aren&apos;t included in the cost
                  {pricing?.unpriced?.length > 0 && (
                    <>
                      {" "}
                      (
                      <span className="mono">
                        {pricing.unpriced.join(", ")}
                      </span>
                      )
                    </>
                  )}
                  . Add their prices to{" "}
                  <code>{pricing?.file ?? "backend/pricing.json"}</code> and
                  restart the API.
                </Callout>
              )}

              <Panel
                title="Estimated cost per day"
                subtitle={`Last ${days} days`}
              >
                <CostChart days={data.by_day} currency={currency} />
              </Panel>

              <Panel title="By model" flush>
                <ModelsTable rows={data.by_model} currency={currency} />
              </Panel>

              <Panel title="By activity" flush>
                <KindsTable rows={data.by_kind} currency={currency} />
              </Panel>

              {!projectId && (
                <Panel title="By project" flush>
                  <ProjectsTable rows={data.by_project} currency={currency} />
                </Panel>
              )}

              <Panel
                title="Recent runs"
                subtitle={
                  data.recent_runs.length
                    ? "Open a run to see each agent's model and tokens."
                    : undefined
                }
                flush
              >
                {data.recent_runs.length === 0 ? (
                  <div className="panel__body">
                    <Empty>No runs in this period.</Empty>
                  </div>
                ) : (
                  <ul className="urun-list">
                    {data.recent_runs.map((run) => (
                      <RunRow key={run.run_id} run={run} currency={currency} />
                    ))}
                  </ul>
                )}
              </Panel>
            </div>
          )}

          <p className="unotes muted">
            Costs are estimates from list prices in{" "}
            <code>backend/pricing.json</code> (with each price&apos;s source and
            date), recorded at the time of use. Token counts are what the
            provider reported; embedding tokens are estimated (~4 characters per
            token). Gemini&apos;s thinking tokens count as output. Deployed runs
            called straight through AWS are counted from the runtime&apos;s logs
            after a sync (runtimes deployed before this was added need a
            redeploy).
          </p>
        </>
      )}
    </div>
  );
}
