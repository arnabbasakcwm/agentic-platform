import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "../components/icons.jsx";
import {
  Button,
  Callout,
  DeleteButton,
  Empty,
  ErrorCallout,
  Field,
  PageHeader,
  Panel,
  Pill,
  Skeleton,
} from "../components/ui.jsx";
import { api } from "../lib/api.js";
import { formatBytes, queryPreview, tableName } from "../lib/datasources.js";
import { projectTitle } from "../lib/format.js";
import { useAction } from "../lib/useAction.js";

/** Each step of a connection check, ticked or crossed. */
function Steps({ steps }) {
  if (!steps?.length) return null;
  return (
    <ul className="dsteps" aria-label="Connection check">
      {steps.map((s) => (
        <li key={s.step} className={s.ok ? "dsteps__ok" : "dsteps__fail"}>
          <Icon name={s.ok ? "check" : "close"} size={14} />
          <span>
            {s.step}
            {s.count != null &&
              ` — ${s.count} dataset${s.count === 1 ? "" : "s"}`}
            {s.error && <span className="dsteps__error">{s.error}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ConnectForm({ defaults, onConnected, onCancel }) {
  const [name, setName] = useState("BigQuery");
  const [billingProject, setBillingProject] = useState(
    defaults.billing_project ?? "",
  );
  const [serviceAccount, setServiceAccount] = useState(
    defaults.service_account ?? "",
  );
  const connect = useAction();

  async function submit(e) {
    e.preventDefault();
    const res = await connect.run(() =>
      api.createDataSource({
        name,
        billing_project: billingProject,
        service_account: serviceAccount,
      }),
    );
    if (res) onConnected(res);
  }

  return (
    <form className="stack" onSubmit={submit}>
      <Field label="Name">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={100}
        />
      </Field>
      <Field
        label="Google Cloud project"
        hint="Runs the queries and pays for them."
      >
        <input
          type="text"
          value={billingProject}
          onChange={(e) => setBillingProject(e.target.value)}
          required
        />
      </Field>
      <Field
        label="Service account"
        hint="The read-only account this platform acts as, through your AWS identity. No key file is needed."
      >
        <input
          type="text"
          value={serviceAccount}
          onChange={(e) => setServiceAccount(e.target.value)}
          required
        />
      </Field>
      <div className="row">
        <Button type="submit" variant="primary" loading={connect.busy}>
          Connect
        </Button>
        {onCancel && (
          <Button onClick={onCancel} disabled={connect.busy}>
            Cancel
          </Button>
        )}
      </div>
      {connect.error?.details?.steps && (
        <Steps steps={connect.error.details.steps} />
      )}
      {connect.error && (
        <ErrorCallout error={{ ...connect.error, details: null }} />
      )}
    </form>
  );
}

/** Choose the tables agents may query: browse the project's datasets, or name any table. */
function TablePicker({ source, onSaved, onClose }) {
  const [browse, setBrowse] = useState(null);
  const [chosen, setChosen] = useState(() => source.tables.map((t) => t.id));
  const [extra, setExtra] = useState("");
  const load = useAction();
  const save = useAction();
  const { run: runLoad } = load;

  useEffect(() => {
    runLoad(() => api.browseDataSource(source.id)).then(
      (body) => body && setBrowse(body),
    );
  }, [runLoad, source.id]);

  function toggle(id, on) {
    setChosen((c) => (on ? [...c, id] : c.filter((x) => x !== id)));
  }

  function addExtra(e) {
    e.preventDefault();
    const id = extra.trim().replace(/`/g, "");
    if (id && !chosen.includes(id)) setChosen((c) => [...c, id]);
    setExtra("");
  }

  async function submit() {
    const res = await save.run(() =>
      api.setDataSourceTables(source.id, chosen),
    );
    if (res) onSaved(res.source);
  }

  const browsed = new Set(
    (browse?.datasets ?? []).flatMap((d) =>
      d.tables.map((t) => `${browse.project}.${d.id}.${t}`),
    ),
  );
  const others = chosen.filter((id) => !browsed.has(id));

  return (
    <div className="stack dpicker">
      {load.busy && <Skeleton lines={3} />}
      <ErrorCallout error={load.error} />
      {browse && browse.datasets.length === 0 && (
        <p className="muted">
          The service account can&apos;t see any dataset in {browse.project}.
          Share one with it first.
        </p>
      )}
      {browse?.datasets.map((d) => (
        <fieldset key={d.id} className="dpicker__dataset">
          <legend>
            {browse.project}.{d.id}
          </legend>
          {d.tables.map((t) => {
            const id = `${browse.project}.${d.id}.${t}`;
            return (
              <label key={id} className="dpicker__table">
                <input
                  type="checkbox"
                  checked={chosen.includes(id)}
                  onChange={(e) => toggle(id, e.target.checked)}
                />
                <span className="mono">{t}</span>
              </label>
            );
          })}
        </fieldset>
      ))}
      {others.length > 0 && (
        <fieldset className="dpicker__dataset">
          <legend>Other tables</legend>
          {others.map((id) => (
            <label key={id} className="dpicker__table">
              <input
                type="checkbox"
                checked
                onChange={() => toggle(id, false)}
              />
              <span className="mono">{id}</span>
            </label>
          ))}
        </fieldset>
      )}
      <form className="row dpicker__add" onSubmit={addExtra}>
        <input
          type="text"
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          placeholder="Add any table by full name, e.g. bigquery-public-data.samples.shakespeare"
          aria-label="Add a table by full name"
        />
        <Button type="submit" disabled={!extra.trim()}>
          Add
        </Button>
      </form>
      <div className="row">
        <Button variant="primary" onClick={submit} loading={save.busy}>
          Save tables
        </Button>
        <Button onClick={onClose} disabled={save.busy}>
          Cancel
        </Button>
      </div>
      <ErrorCallout error={save.error} />
    </div>
  );
}

function ProjectChecklist({ source, projects, onSaved }) {
  const save = useAction();
  // The ticked projects while a change is being saved, so a click shows at once.
  const [pending, setPending] = useState(null);
  const ticked = pending ?? source.project_ids;

  async function toggle(projectId, on) {
    const next = on
      ? [...ticked, projectId]
      : ticked.filter((p) => p !== projectId);
    setPending(next);
    const res = await save.run(() =>
      api.setDataSourceProjects(source.id, next),
    );
    setPending(null);
    if (res) onSaved(res.source);
  }

  if (projects.length === 0)
    return (
      <p className="muted">
        Create a project first, then attach this source to it.
      </p>
    );
  return (
    <fieldset className="dprojects" disabled={pending !== null}>
      <legend className="sr-only">Projects that may query {source.name}</legend>
      {projects.map((p) => (
        <label key={p.project_id} className="dprojects__option">
          <input
            type="checkbox"
            checked={ticked.includes(p.project_id)}
            onChange={(e) => toggle(p.project_id, e.target.checked)}
          />
          <span>{projectTitle(p.brief, 60)}</span>
          {source.project_ids.includes(p.project_id) &&
            p.used_by.length === 0 && (
              <Pill tone="warn">No agent queries it yet</Pill>
            )}
        </label>
      ))}
      <ErrorCallout error={save.error} />
    </fieldset>
  );
}

function TestQuery({ source, limits }) {
  const [sql, setSql] = useState(() => queryPreview(source.tables[0]?.id));
  const [result, setResult] = useState(null);
  const query = useAction();

  async function submit(e) {
    e.preventDefault();
    setResult(null);
    const res = await query.run(() => api.queryDataSource(source.id, sql));
    if (res) setResult(res);
  }

  return (
    <form className="stack" onSubmit={submit}>
      <Field
        label="Test query"
        hint={`Same checks as agents' sql_query: one SELECT over the tables above, at most ${formatBytes(limits.max_bytes)} scanned, ${limits.max_rows} rows.`}
      >
        <textarea
          className="mono dquery__sql"
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          rows={4}
        />
      </Field>
      <div className="row">
        <Button type="submit" loading={query.busy} disabled={!sql.trim()}>
          <Icon name="play" size={13} />
          Run query
        </Button>
      </div>
      <ErrorCallout error={query.error} />
      {result && (
        <div className="dresult">
          <div className="dresult__meta muted">
            {result.rows.length} row{result.rows.length === 1 ? "" : "s"}
            {result.truncated ? " (more matched)" : ""} ·{" "}
            {formatBytes(result.bytes_processed)} scanned ·{" "}
            {formatBytes(result.bytes_billed)} billed
          </div>
          <div className="dresult__scroll">
            <table className="table dresult__table">
              <thead>
                <tr>
                  {result.columns.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((v, j) => (
                      <td key={j}>
                        {v === null ? (
                          <span className="muted">NULL</span>
                        ) : typeof v === "object" ? (
                          JSON.stringify(v)
                        ) : (
                          String(v)
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </form>
  );
}

function SourcePanel({ source, projects, limits, onChanged, onDeleted }) {
  const [picking, setPicking] = useState(source.tables.length === 0);
  const remove = useAction();

  async function deleteSource() {
    const res = await remove.run(() => api.deleteDataSource(source.id));
    if (res) onDeleted(source.id);
    return Boolean(res);
  }

  return (
    <Panel
      title={source.name}
      subtitle={`${source.billing_project} · ${source.service_account}`}
      actions={
        <DeleteButton
          name={source.name}
          prompt="Remove this source?"
          onDelete={deleteSource}
        />
      }
    >
      <div className="stack">
        <section aria-label={`Tables in ${source.name}`}>
          <h3 className="dsection">Tables agents may query</h3>
          {picking ? (
            <TablePicker
              source={source}
              onSaved={(s) => {
                onChanged(s);
                setPicking(false);
              }}
              onClose={() => setPicking(false)}
            />
          ) : (
            <div className="stack">
              {source.tables.length === 0 ? (
                <p className="muted">No tables yet.</p>
              ) : (
                <ul className="dtables">
                  {source.tables.map((t) => (
                    <li key={t.id}>
                      <span className="mono">{tableName(t.id)}</span>
                      <span className="dtables__project mono">
                        {t.id.split(".")[0]}
                      </span>
                      <Pill>{t.location}</Pill>
                    </li>
                  ))}
                </ul>
              )}
              <div>
                <Button onClick={() => setPicking(true)}>
                  <Icon name="edit" size={13} />
                  Choose tables
                </Button>
              </div>
            </div>
          )}
        </section>

        <section aria-label={`Projects using ${source.name}`}>
          <h3 className="dsection">Projects</h3>
          <p className="muted dsection__hint">
            A project&apos;s agents can query these tables once it&apos;s ticked
            here and an agent has the <code>sql_query</code> tool. Query results
            are sent to that agent&apos;s model provider.
          </p>
          <ProjectChecklist
            source={source}
            projects={projects}
            onSaved={onChanged}
          />
        </section>

        {source.tables.length > 0 && !picking && (
          <TestQuery source={source} limits={limits} />
        )}
        <ErrorCallout error={remove.error} />
      </div>
    </Panel>
  );
}

/** BigQuery connections: which tables agents may query, and which projects may use them. */
export function DataSourcesPage() {
  const [body, setBody] = useState(null);
  const [adding, setAdding] = useState(false);
  const [lastCheck, setLastCheck] = useState(null);
  const load = useAction();
  const { run: runLoad } = load;

  const reload = useCallback(async () => {
    const res = await runLoad(() => api.dataSources());
    if (res) setBody(res);
  }, [runLoad]);

  useEffect(() => {
    runLoad(() => api.dataSources()).then((res) => res && setBody(res));
  }, [runLoad]);

  const projects = useMemo(() => body?.projects ?? [], [body]);

  function replace(source) {
    setBody((b) => ({
      ...b,
      sources: b.sources.map((s) => (s.id === source.id ? source : s)),
    }));
    reload();
  }

  const header = (
    <PageHeader
      title="Data sources"
      subtitle="Let agents query your BigQuery tables with SQL they write. Read-only, limited to the tables you choose, and capped per query."
    />
  );

  if (!body) {
    return (
      <div className="page">
        {header}
        <Panel>
          {load.error ? (
            <ErrorCallout error={load.error} />
          ) : (
            <Skeleton lines={4} />
          )}
        </Panel>
      </div>
    );
  }

  return (
    <div className="page">
      {header}
      {!body.configured && (
        <Callout tone="warn" title="BigQuery isn't set up on this server">
          Set <code>GCP_WIF_AUDIENCE</code>, <code>GCP_SERVICE_ACCOUNT</code>{" "}
          and <code>BIGQUERY_PROJECT</code> in <code>backend/.env</code> — see{" "}
          <code>docs/bigquery_setup.md</code>.
        </Callout>
      )}
      <div className="stack">
        {lastCheck && (
          <Callout tone="success" title={`Connected ${lastCheck.name}`}>
            <Steps steps={lastCheck.steps} />
          </Callout>
        )}
        {body.sources.map((s) => (
          <SourcePanel
            key={s.id}
            source={s}
            projects={projects}
            limits={body.limits}
            onChanged={replace}
            onDeleted={() => {
              setLastCheck(null);
              reload();
            }}
          />
        ))}
        {body.configured &&
          (adding || body.sources.length === 0 ? (
            <Panel title="Connect BigQuery">
              <ConnectForm
                defaults={body.defaults}
                onCancel={
                  body.sources.length > 0 ? () => setAdding(false) : null
                }
                onConnected={(res) => {
                  setLastCheck({
                    name: res.source.name,
                    steps: res.check.steps,
                  });
                  setAdding(false);
                  reload();
                }}
              />
            </Panel>
          ) : (
            <div>
              <Button onClick={() => setAdding(true)}>
                <Icon name="plus" size={13} />
                Connect another source
              </Button>
            </div>
          ))}
        {!body.configured && body.sources.length === 0 && (
          <Empty title="No data sources yet" />
        )}
      </div>
    </div>
  );
}
