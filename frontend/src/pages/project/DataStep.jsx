import { useCallback, useEffect, useState } from "react";
import { Icon } from "../../components/icons.jsx";
import {
  Button,
  Callout,
  Empty,
  ErrorCallout,
  LinkButton,
  Panel,
  Pill,
  Skeleton,
} from "../../components/ui.jsx";
import { api } from "../../lib/api.js";
import { DATA_ACCESS_REQUEST, tableName } from "../../lib/datasources.js";
import { paths } from "../../lib/router.js";
import { useAction } from "../../lib/useAction.js";
import { TestQuery } from "../DataSourcesPage.jsx";

function SourceTables({ source }) {
  if (source.tables.length === 0) {
    return (
      <p className="muted">
        No tables chosen yet — choose them on the Data sources page.
      </p>
    );
  }
  return (
    <ul className="dtables">
      {source.tables.map((t) => (
        <li key={t.id}>
          <span className="mono">{tableName(t.id)}</span>
          <span className="dtables__project mono">{t.id.split(".")[0]}</span>
          <Pill>{t.location}</Pill>
        </li>
      ))}
    </ul>
  );
}

/** Ask the plan assistant to give the agents that need data the SQL tools. */
function AccessPanel({ project, data, onRevised }) {
  const ask = useAction();
  const [reply, setReply] = useState(null);
  const tables = data.attached.reduce((n, s) => n + s.tables.length, 0);
  if (data.attached.length === 0 || tables === 0) return null;

  async function giveAccess() {
    const res = await ask.run(() =>
      api.reviseProject(project.project_id, DATA_ACCESS_REQUEST),
    );
    if (res) {
      setReply(res.reply?.content ?? null);
      onRevised(res.project);
    }
  }

  return (
    <Panel title="Agents with access">
      <div className="stack">
        {data.used_by.length > 0 ? (
          <p>
            {data.used_by.map((id) => (
              <span key={id} className="mono dagent">
                {id}
              </span>
            ))}{" "}
            can query the attached tables with <code>sql_query</code>.
          </p>
        ) : (
          <Callout tone="warn" title="No agent can query this data yet">
            Give the agents that need facts from it the <code>sql_schema</code>{" "}
            and <code>sql_query</code> tools.
          </Callout>
        )}
        <div className="row">
          <Button onClick={giveAccess} loading={ask.busy}>
            <Icon name="chat" size={13} />
            {data.used_by.length > 0
              ? "Review access with the assistant"
              : "Give agents access"}
          </Button>
          <LinkButton href={paths.project(project.project_id, "brief")}>
            Choose tools per agent
          </LinkButton>
        </div>
        {reply && <p className="muted">{reply}</p>}
        <ErrorCallout error={ask.error} />
      </div>
    </Panel>
  );
}

/** The Resources step's Databases tab: attach, detach, see who can query, test a query. */
export function DataStep({ project, onRevised, onDataChanged }) {
  const [data, setData] = useState(null);
  const load = useAction();
  const change = useAction();
  const { run: runLoad } = load;
  const pid = project.project_id;

  const loaded = useCallback(
    (body) => {
      setData(body);
      onDataChanged?.({
        sources: body.attached.length,
        tables: body.attached.reduce((n, s) => n + s.tables.length, 0),
      });
    },
    [onDataChanged],
  );

  const reload = useCallback(async () => {
    const body = await runLoad(() => api.projectDataSources(pid));
    if (body) loaded(body);
  }, [runLoad, pid, loaded]);

  // Re-read when the plan changes: which agents can query depends on it.
  useEffect(() => {
    runLoad(() => api.projectDataSources(pid)).then(
      (body) => body && loaded(body),
    );
  }, [runLoad, pid, loaded, project.plan_version]);

  async function attach(source) {
    if (await change.run(() => api.attachDataSource(pid, source.id)))
      await reload();
  }

  async function detach(source) {
    if (await change.run(() => api.detachDataSource(pid, source.id)))
      await reload();
  }

  if (!data) {
    return (
      <Panel>
        {load.error ? (
          <ErrorCallout error={load.error} />
        ) : (
          <Skeleton lines={4} />
        )}
      </Panel>
    );
  }

  // The Resources step provides the page, its tabs and the action bar.
  return (
    <div className="stack">
      <Panel
        title="Data for this project"
        subtitle="This project's agents query only the BigQuery sources attached here — read-only, and capped per query."
        actions={<LinkButton href={paths.data}>Manage data sources</LinkButton>}
      >
        <div className="stack">
          {!data.configured && (
            <Callout tone="warn" title="BigQuery isn't set up on this server">
              See <code>docs/bigquery_setup.md</code>.
            </Callout>
          )}
          {data.attached.length === 0 ? (
            <Empty title="No data sources attached">
              {data.available.length > 0
                ? "Attach one below so agents can query its tables."
                : "Connect BigQuery on the Data sources page first."}
            </Empty>
          ) : (
            data.attached.map((s) => (
              <section
                key={s.id}
                className="dsource"
                aria-label={`Attached: ${s.name}`}
              >
                <div className="dsource__head">
                  <Icon name="database" size={16} />
                  <strong>{s.name}</strong>
                  <span className="muted dsource__sub">
                    {s.billing_project}
                  </span>
                  <Button
                    size="sm"
                    onClick={() => detach(s)}
                    disabled={change.busy}
                    aria-label={`Detach ${s.name}`}
                  >
                    Detach
                  </Button>
                </div>
                <SourceTables source={s} />
                {s.tables.length > 0 && (
                  <TestQuery source={s} limits={data.limits} />
                )}
              </section>
            ))
          )}
          <p className="muted dsection__hint">
            Query results are sent to the model provider of the agents that
            query them. The data itself stays in BigQuery: every query runs
            there, and nothing is copied into the platform.
          </p>
          <ErrorCallout error={change.error} />
        </div>
      </Panel>

      {data.available.length > 0 && (
        <Panel title="Your other data sources">
          <ul className="dlist">
            {data.available.map((s) => (
              <li key={s.id}>
                <Icon name="database" size={15} />
                <span>
                  <strong>{s.name}</strong>{" "}
                  <span className="muted">
                    {s.tables.length} table{s.tables.length === 1 ? "" : "s"}
                  </span>
                </span>
                <Button
                  size="sm"
                  onClick={() => attach(s)}
                  disabled={change.busy}
                  aria-label={`Attach ${s.name}`}
                >
                  <Icon name="plus" size={12} />
                  Attach
                </Button>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <AccessPanel project={project} data={data} onRevised={onRevised} />
    </div>
  );
}
