import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "../components/icons.jsx";
import { ItemCard } from "../components/ItemCard.jsx";
import { ItemsToolbar, matchesFilter } from "../components/ItemsToolbar.jsx";
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
import { useExpanded } from "../lib/expanded.js";
import { projectName } from "../lib/format.js";
import {
  AUTH_MODES,
  KEY_DEFAULT_HEADER,
  TOKEN_DEFAULTS,
  authHeaders,
  authOf,
  authSummary,
  defaultAuth,
  newWriteTools,
  presetFor,
  sampleArguments,
  serverStatus,
  sortTools,
} from "../lib/mcp.js";
import { useAction } from "../lib/useAction.js";
import { Steps } from "./DataSourcesPage.jsx";

/** Header name/value rows. Values are write-only: never shown again once saved. */
function HeaderRows({ rows, onChange, disabled, placeholder }) {
  function set(i, patch) {
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }
  return (
    <fieldset className="mcpheaders" disabled={disabled}>
      <legend className="field__label">Headers (optional)</legend>
      {rows.map((row, i) => (
        <div key={i} className="mcpheaders__row">
          <input
            type="text"
            value={row.name}
            onChange={(e) => set(i, { name: e.target.value })}
            placeholder="Header, e.g. Authorization"
            aria-label={`Header ${i + 1} name`}
            autoComplete="off"
            spellCheck={false}
          />
          <input
            type="password"
            value={row.value}
            onChange={(e) => set(i, { value: e.target.value })}
            placeholder={placeholder ?? "Value, e.g. Bearer …"}
            aria-label={`Header ${i + 1} value`}
            autoComplete="new-password"
            spellCheck={false}
          />
          <button
            type="button"
            className="iconbtn"
            aria-label={`Remove header ${i + 1}`}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
      <div>
        <Button
          size="sm"
          onClick={() => onChange([...rows, { name: "", value: "" }])}
        >
          <Icon name="plus" size={12} />
          Add header
        </Button>
      </div>
    </fieldset>
  );
}

const EMPTY_AUTH = {
  token: "",
  ...TOKEN_DEFAULTS,
  key: "",
  keyHeader: KEY_DEFAULT_HEADER,
  rows: [],
};

/**
 * How the platform signs in to the server: nothing, an access token, an API key header,
 * a key inside the URL, or custom headers. Every value is write-only: stored encrypted
 * and never shown again. `keeping` is set when replacing credentials, where an empty
 * token or key keeps the current one.
 */
function AuthChoice({
  mode,
  onMode,
  fields,
  onFields,
  disabled,
  keeping,
  tokenPlaceholder,
}) {
  const set = (patch) => onFields({ ...fields, ...patch });
  const prefix = fields.tokenPrefix.trim();
  const sentAs = `${fields.tokenHeader.trim() || TOKEN_DEFAULTS.tokenHeader}: ${prefix ? `${prefix} ` : ""}…`;
  return (
    <fieldset className="mcpauth" disabled={disabled}>
      <legend className="field__label">Authentication</legend>
      <div className="segmented mcpauth__modes">
        {AUTH_MODES.map((m) => (
          <label
            key={m.id}
            className={
              mode === m.id
                ? "segmented__item segmented__item--on"
                : "segmented__item"
            }
          >
            <input
              type="radio"
              name="mcp-auth"
              className="sr-only"
              value={m.id}
              checked={mode === m.id}
              onChange={() => onMode(m.id)}
            />
            <span>{m.label}</span>
          </label>
        ))}
      </div>

      {mode === "none" && (
        <p className="muted mcpauth__note">
          No credentials are sent. Use this for public servers.
        </p>
      )}

      {mode === "token" && (
        <div className="stack">
          <Field
            label={keeping ? "New access token" : "Access token"}
            hint={`${keeping ? "Leave empty to keep the current token. " : ""}Sent as ${sentAs} on every request. Stored encrypted; never shown again.`}
          >
            <input
              type="password"
              value={fields.token}
              onChange={(e) => set({ token: e.target.value })}
              placeholder={tokenPlaceholder ?? "Paste the token"}
              required={!keeping}
              autoComplete="new-password"
              spellCheck={false}
            />
          </Field>
          <details className="mcpauth__advanced">
            <summary>Header and prefix</summary>
            <div className="mcpauth__grid">
              <Field label="Header">
                <input
                  type="text"
                  value={fields.tokenHeader}
                  onChange={(e) => set({ tokenHeader: e.target.value })}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <Field
                label="Prefix"
                hint="Leave empty if the server takes the bare token."
              >
                <input
                  type="text"
                  value={fields.tokenPrefix}
                  onChange={(e) => set({ tokenPrefix: e.target.value })}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
            </div>
          </details>
        </div>
      )}

      {mode === "header" && (
        <div className="mcpauth__grid">
          <Field label="Header name">
            <input
              type="text"
              value={fields.keyHeader}
              onChange={(e) => set({ keyHeader: e.target.value })}
              required
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field
            label={keeping ? "New API key" : "API key"}
            hint={
              keeping
                ? "Leave empty to keep the current key."
                : "Stored encrypted; never shown again."
            }
          >
            <input
              type="password"
              value={fields.key}
              onChange={(e) => set({ key: e.target.value })}
              required={!keeping}
              autoComplete="new-password"
              spellCheck={false}
            />
          </Field>
        </div>
      )}

      {mode === "url" && (
        <p className="muted mcpauth__note">
          The key is part of the server URL. The whole URL is stored encrypted
          and only ever shown masked.
        </p>
      )}

      {mode === "custom" && (
        <HeaderRows
          rows={fields.rows}
          onChange={(rows) => set({ rows })}
          disabled={disabled}
        />
      )}
    </fieldset>
  );
}

function ConnectForm({ onConnected, onCancel }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState("none");
  // Once the user picks how to sign in, a recognised URL no longer changes it.
  const [modeChosen, setModeChosen] = useState(false);
  const [fields, setFields] = useState(EMPTY_AUTH);
  const connect = useAction();
  const preset = presetFor(url);

  function changeUrl(value) {
    setUrl(value);
    const next = presetFor(value);
    if (next && !name.trim()) setName(next.name);
    if (!modeChosen) setMode(defaultAuth(next));
  }

  async function submit(e) {
    e.preventDefault();
    const res = await connect.run(() =>
      api.createMcpServer({
        name: name.trim(),
        url: url.trim(),
        headers: authHeaders(mode, fields),
        auth: mode,
        ...(preset ? { preset: preset.id } : {}),
      }),
    );
    if (res) onConnected(res);
  }

  return (
    <form className="stack" onSubmit={submit}>
      <Field
        label="Server URL"
        hint="The server's Streamable HTTP endpoint (https). It's stored encrypted and never shown again, since some servers put their key in it."
      >
        <input
          type="url"
          value={url}
          onChange={(e) => changeUrl(e.target.value)}
          placeholder="https://…/mcp"
          required
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      {preset && (
        <Callout tone="info" title={preset.label}>
          {preset.help}
        </Callout>
      )}
      <Field
        label="Name"
        hint="How agents' tools from this server are labelled."
      >
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={100}
        />
      </Field>
      <AuthChoice
        mode={mode}
        onMode={(m) => {
          setMode(m);
          setModeChosen(true);
        }}
        fields={fields}
        onFields={setFields}
        disabled={connect.busy}
        tokenPlaceholder={preset?.tokenPlaceholder}
      />
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
      {connect.error && <ErrorCallout error={connect.error} hideDetails />}
    </form>
  );
}

/** Tick the tools agents may use. Approving a tool that may change data asks first. */
const TOOL_FILTER_FROM = 9; // the tool filter appears once a server has this many tools

function ToolApproval({ server, onSaved }) {
  const tools = useMemo(() => sortTools(server.tools), [server.tools]);
  const initial = useMemo(
    () => new Set(server.tools.filter((t) => t.usable).map((t) => t.name)),
    [server.tools],
  );
  const [picked, setPicked] = useState(initial);
  const [open, setOpen] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [filter, setFilter] = useState("");
  const shownTools = tools.filter((t) => matchesFilter(filter, t.name, t.description));
  const save = useAction();

  const dirty =
    picked.size !== initial.size ||
    [...picked].some((n) => !initial.has(n)) ||
    server.tools.some((t) => t.changed && picked.has(t.name));
  const writes = newWriteTools(server.tools, picked);

  function toggle(name, on) {
    setConfirming(false);
    setPicked((p) => {
      const next = new Set(p);
      on ? next.add(name) : next.delete(name);
      return next;
    });
  }

  async function submit() {
    if (writes.length > 0 && !confirming) {
      setConfirming(true);
      return;
    }
    const res = await save.run(() =>
      api.approveMcpTools(server.id, [...picked]),
    );
    setConfirming(false);
    if (res) onSaved(res.server);
  }

  if (tools.length === 0)
    return <p className="muted">This server offers no tools.</p>;

  return (
    <div className="stack">
      {tools.length >= TOOL_FILTER_FROM && (
        <label className="itemstoolbar__filter mcptools__filter">
          <Icon name="search" size={14} />
          <span className="sr-only">Filter tools</span>
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={`Filter ${tools.length} tools`}
          />
        </label>
      )}
      <ul className="mcptools" aria-label={`Tools of ${server.name}`}>
        {shownTools.length === 0 && (
          <li className="muted mcptools__none">No tools match “{filter}”.</li>
        )}
        {shownTools.map((t) => (
          <li
            key={t.name}
            className={
              open === t.name
                ? "mcptools__item mcptools__item--open"
                : "mcptools__item"
            }
          >
            <label className="mcptools__pick">
              <input
                type="checkbox"
                checked={picked.has(t.name)}
                onChange={(e) => toggle(t.name, e.target.checked)}
                disabled={save.busy}
              />
              <span className="mono mcptools__name">{t.name}</span>
            </label>
            <span className="mcptools__tags">
              {/* Approval shows in the checkbox (and the card's count); only a changed
                  tool needs a word. */}
              {t.changed && <Pill tone="warn">Changed — review</Pill>}
              {t.read_only_hint ? (
                <Pill>Reads only</Pill>
              ) : (
                <Pill tone="danger">May change data</Pill>
              )}
            </span>
            <button
              type="button"
              className="iconbtn mcptools__more"
              aria-expanded={open === t.name}
              aria-label={`${open === t.name ? "Hide" : "Show"} details of ${t.name}`}
              title={open === t.name ? "Hide details" : "Show details"}
              onClick={() => setOpen((o) => (o === t.name ? null : t.name))}
            >
              <Icon name="chevronDown" size={16} />
            </button>
            {t.description && (
              <p className="mcptools__desc muted">{t.description}</p>
            )}
            {open === t.name && (
              <pre className="codeblock mcptools__schema">
                {JSON.stringify(t.input_schema, null, 2)}
              </pre>
            )}
          </li>
        ))}
      </ul>
      <p className="muted dsection__hint">
        &quot;Reads only&quot; is the server&apos;s own claim (or a guess from
        the tool&apos;s name), not a guarantee. Approving pins the tool as it is
        now: if the server changes it, it&apos;s held back until you approve it
        again.
      </p>
      {confirming && (
        <Callout tone="warn" title="These tools may change data">
          <strong>{writes.map((t) => t.name).join(", ")}</strong> can change
          data in {server.name}. Agents that have them can call them on their
          own, without asking you. Approve anyway?
        </Callout>
      )}
      <div className="row">
        <Button
          variant="primary"
          onClick={submit}
          loading={save.busy}
          disabled={!dirty}
        >
          {confirming ? "Approve anyway" : "Save approvals"}
        </Button>
        {confirming && (
          <Button onClick={() => setConfirming(false)}>Cancel</Button>
        )}
      </div>
      <ErrorCallout error={save.error} />
    </div>
  );
}

function ProjectChecklist({ server, projects, onSaved }) {
  const save = useAction();
  const [pending, setPending] = useState(null);
  const ticked = pending ?? server.project_ids;

  async function toggle(projectId, on) {
    const next = on
      ? [...ticked, projectId]
      : ticked.filter((p) => p !== projectId);
    setPending(next);
    const res = await save.run(() => api.setMcpProjects(server.id, next));
    setPending(null);
    if (res) onSaved(res.server);
  }

  if (projects.length === 0)
    return (
      <p className="muted">
        Create a project first, then attach this server to it.
      </p>
    );
  return (
    <fieldset className="dprojects" disabled={pending !== null}>
      <legend className="sr-only">Projects that may use {server.name}</legend>
      {projects.map((p) => (
        <label key={p.project_id} className="dprojects__option">
          <input
            type="checkbox"
            checked={ticked.includes(p.project_id)}
            onChange={(e) => toggle(p.project_id, e.target.checked)}
          />
          <span>{projectName(p, 60)}</span>
        </label>
      ))}
      <ErrorCallout error={save.error} />
    </fieldset>
  );
}

/** Run one approved tool, exactly as an agent would. */
function TryTool({ server, onStatus }) {
  const usable = server.tools.filter((t) => t.usable);
  const [tool, setTool] = useState(usable[0]?.name ?? "");
  const chosen = usable.find((t) => t.name === tool);
  const [args, setArgs] = useState(() =>
    JSON.stringify(sampleArguments(chosen?.input_schema), null, 2),
  );
  const [output, setOutput] = useState(null);
  const [parseError, setParseError] = useState(null);
  const run = useAction();

  if (usable.length === 0)
    return (
      <p className="muted">
        Approve a tool on the Tools tab first, then try it here.
      </p>
    );

  function choose(name) {
    setTool(name);
    setOutput(null);
    const next = usable.find((t) => t.name === name);
    setArgs(JSON.stringify(sampleArguments(next?.input_schema), null, 2));
  }

  async function submit(e) {
    e.preventDefault();
    setOutput(null);
    let parsed;
    try {
      parsed = JSON.parse(args || "{}");
    } catch (err) {
      setParseError({ errorType: "Invalid JSON", message: err.message });
      return;
    }
    setParseError(null);
    const res = await run.run(() => api.testMcpTool(server.id, tool, parsed));
    if (res) setOutput(res.output);
    onStatus();
  }

  return (
    <form className="stack" onSubmit={submit}>
      <Field label="Tool">
        <select value={tool} onChange={(e) => choose(e.target.value)}>
          {usable.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label="Arguments (JSON)"
        hint="Runs for real on the server, with the same checks and limits as an agent's call."
      >
        <textarea
          className="mono"
          value={args}
          onChange={(e) => setArgs(e.target.value)}
          rows={4}
          spellCheck={false}
        />
      </Field>
      <div className="row">
        <Button type="submit" loading={run.busy}>
          <Icon name="play" size={13} />
          Run tool
        </Button>
      </div>
      <ErrorCallout error={parseError ?? run.error} />
      {output != null && <pre className="codeblock mcpoutput">{output}</pre>}
    </form>
  );
}

/** Replace the URL or credentials: after a token expires or a key is regenerated. */
function ReplaceSecret({ server, onSaved, onClose }) {
  const current = authOf(server);
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState(current);
  const [fields, setFields] = useState(() => ({
    ...EMPTY_AUTH,
    keyHeader:
      current === "header"
        ? (server.header_names[0] ?? KEY_DEFAULT_HEADER)
        : KEY_DEFAULT_HEADER,
    rows: server.header_names.map((name) => ({ name, value: "" })),
  }));
  const save = useAction();
  // Same kind as before: an empty token, key or header value keeps what's stored.
  const keeping = mode === current;

  async function submit(e) {
    e.preventDefault();
    const headers = authHeaders(mode, fields);
    const blank =
      (mode === "token" && !fields.token.trim()) ||
      (mode === "header" && !fields.key.trim()) ||
      (mode === "custom" &&
        fields.rows.length > 0 &&
        Object.keys(headers).length === 0);
    const body = {
      ...(url.trim() ? { url: url.trim() } : {}),
      ...(keeping && blank ? {} : { headers }),
      auth: mode,
    };
    const res = await save.run(() => api.replaceMcpSecret(server.id, body));
    if (res) onSaved(res.server);
  }

  return (
    <form className="stack mcpsecret" onSubmit={submit}>
      <Field
        label="New server URL"
        hint={`Now: ${server.display_url}. Leave empty to keep it.`}
      >
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…"
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <AuthChoice
        mode={mode}
        onMode={setMode}
        fields={fields}
        onFields={setFields}
        disabled={save.busy}
        keeping={keeping}
      />
      <div className="row">
        <Button type="submit" variant="primary" loading={save.busy}>
          Check and save
        </Button>
        <Button onClick={onClose} disabled={save.busy}>
          Cancel
        </Button>
      </div>
      {save.error?.details?.steps && <Steps steps={save.error.details.steps} />}
      {save.error && <ErrorCallout error={save.error} hideDetails />}
    </form>
  );
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function serverSummary(server) {
  const approved = server.tools.filter((t) => t.usable).length;
  return [
    plural(server.tools.length, "tool"),
    `${approved} approved`,
    plural(server.project_ids.length, "project"),
  ].join(" · ");
}

const needsAttention = (server) =>
  server.status !== "ok" || server.tools.some((t) => t.changed);

function ServerPanel({ server, projects, open, onToggle, onChanged, onDeleted }) {
  const [replacing, setReplacing] = useState(false);
  const [tab, setTab] = useState(
    server.status === "auth_failed" ? "credentials" : "tools",
  );
  const refresh = useAction();
  const remove = useAction();
  const status = serverStatus(server);
  const approved = server.tools.filter((t) => t.usable).length;
  const changed = server.tools.filter((t) => t.changed).length;

  async function doRefresh() {
    const res = await refresh.run(() => api.refreshMcpServer(server.id));
    if (res) onChanged(res.server);
    else onChanged(null);
  }

  async function deleteServer() {
    const res = await remove.run(() => api.deleteMcpServer(server.id));
    if (res) onDeleted(server.id);
    return Boolean(res);
  }

  const tabs = [
    { key: "tools", label: "Tools", count: `${approved}/${server.tools.length}` },
    { key: "projects", label: "Projects", count: server.project_ids.length },
    { key: "try", label: "Try a tool" },
    { key: "credentials", label: "Credentials" },
  ];

  return (
    <ItemCard
      id={server.id}
      title={server.name}
      summary={`${server.display_url} · ${serverSummary(server)}`}
      status={
        <span className="row">
          <Pill tone={status.tone} dot>
            {status.label}
          </Pill>
          {changed > 0 && <Pill tone="warn">{changed} changed</Pill>}
        </span>
      }
      actions={
        <>
          <button
            type="button"
            className={refresh.busy ? "iconbtn iconbtn--busy" : "iconbtn"}
            onClick={doRefresh}
            disabled={refresh.busy}
            aria-label="Refresh tools"
            title="Refresh tools"
          >
            <Icon name="refresh" size={16} />
          </button>
          <DeleteButton
            name={server.name}
            prompt="Remove this server?"
            onDelete={deleteServer}
          />
        </>
      }
      open={open}
      onToggle={onToggle}
      tabs={tabs}
      tab={tab}
      onTab={setTab}
      notice={
        <>
          {server.status !== "ok" && (
            <Callout
              tone={status.tone === "danger" ? "danger" : "warn"}
              title={status.label}
            >
              {server.status_message}{" "}
              {server.status === "auth_failed" &&
                "If the token expired or the key was regenerated, replace them on the Credentials tab."}
            </Callout>
          )}
          <ErrorCallout error={refresh.error} />
          <ErrorCallout error={remove.error} />
        </>
      }
    >
      {tab === "tools" && (
        <section aria-label={`Tools of ${server.name}`}>
          {/* Keyed by the saved approvals, so the ticks start from what's saved. */}
          <ToolApproval
            key={server.tools
              .map((t) => `${t.name}:${t.usable}:${t.changed}`)
              .join("|")}
            server={server}
            onSaved={onChanged}
          />
        </section>
      )}

      {tab === "projects" && (
        <section aria-label={`Projects using ${server.name}`}>
          <p className="muted dsection__hint">
            A project&apos;s agents can use the approved tools once it&apos;s
            ticked here and an agent is given the tool. Whatever agents pass to
            a tool is sent to {server.host}.
          </p>
          <ProjectChecklist
            server={server}
            projects={projects}
            onSaved={onChanged}
          />
        </section>
      )}

      {tab === "try" && (
        <TryTool
          key={approved}
          server={server}
          onStatus={() => onChanged(null)}
        />
      )}

      {tab === "credentials" && (
        <section aria-label={`Credentials of ${server.name}`} className="stack">
          <dl className="mcpcreds">
            <div>
              <dt>Address</dt>
              <dd className="mono">{server.display_url}</dd>
            </div>
            <div>
              <dt>Authentication</dt>
              <dd>{authSummary(server)}</dd>
            </div>
            {server.server_name && (
              <div>
                <dt>Server</dt>
                <dd>
                  {server.server_name}
                  {server.server_version && ` ${server.server_version}`}
                </dd>
              </div>
            )}
          </dl>
          {replacing ? (
            <ReplaceSecret
              server={server}
              onSaved={(s) => {
                setReplacing(false);
                onChanged(s);
              }}
              onClose={() => setReplacing(false)}
            />
          ) : (
            <div>
              <Button size="sm" onClick={() => setReplacing(true)}>
                <Icon name="edit" size={12} />
                Replace URL or headers
              </Button>
            </div>
          )}
        </section>
      )}
    </ItemCard>
  );
}

/** Remote MCP servers: which tools agents may call, and which projects may use them. */
export function McpServersPage() {
  const [body, setBody] = useState(null);
  const [adding, setAdding] = useState(false);
  const [connected, setConnected] = useState(null);
  const [filter, setFilter] = useState("");
  const load = useAction();
  const { run: runLoad } = load;

  const reload = useCallback(async () => {
    const res = await runLoad(() => api.mcpServers());
    if (res) setBody(res);
  }, [runLoad]);

  useEffect(() => {
    runLoad(() => api.mcpServers()).then((res) => res && setBody(res));
  }, [runLoad]);

  const projects = useMemo(() => body?.projects ?? [], [body]);
  const servers = useMemo(() => body?.servers ?? [], [body]);
  const expanded = useExpanded(
    "agentic-platform.mcp-servers-open",
    servers.map((s) => s.id),
    servers.filter(needsAttention).map((s) => s.id),
  );
  const shown = servers.filter((s) =>
    matchesFilter(filter, s.name, s.display_url, serverSummary(s)),
  );

  function replace(server) {
    if (server)
      setBody((b) => ({
        ...b,
        servers: b.servers.map((s) => (s.id === server.id ? server : s)),
      }));
    reload();
  }

  const showForm = body?.configured && (adding || servers.length === 0);
  const header = (
    <PageHeader
      title="MCP servers"
      subtitle="Give agents tools from remote MCP servers. Agents get only the tools you approve, in the projects you attach a server to."
      actions={
        body?.configured &&
        servers.length > 0 &&
        !adding && (
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Icon name="plus" size={13} />
            Connect a server
          </Button>
        )
      }
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
        <Callout tone="warn" title="This server can't store secrets yet">
          Set <code>PLATFORM_SECRET_KEY</code> in <code>backend/.env</code> to
          connect MCP servers — see <code>docs/mcp_setup.md</code>.
        </Callout>
      )}
      <div className="stack">
        {showForm && (
          <Panel title="Connect an MCP server">
            <ConnectForm
              onCancel={servers.length > 0 ? () => setAdding(false) : null}
              onConnected={(res) => {
                setConnected({
                  name: res.server.name,
                  tools: res.server.tools.length,
                  skipped: res.skipped ?? [],
                });
                setAdding(false);
                expanded.open(res.server.id);
                reload();
              }}
            />
          </Panel>
        )}
        {connected && (
          <Callout tone="success" title={`Connected ${connected.name}`}>
            {connected.tools} tool{connected.tools === 1 ? "" : "s"} found. None
            are approved yet: tick the ones agents may use.
            {connected.skipped.length > 0 && (
              <ul className="mcpskipped">
                {connected.skipped.map((s) => (
                  <li key={s}>Left out: {s}</li>
                ))}
              </ul>
            )}
          </Callout>
        )}
        <ItemsToolbar
          count={servers.length}
          noun="server"
          filter={filter}
          onFilter={setFilter}
          shown={shown.length}
          allOpen={expanded.openCount === servers.length}
          noneOpen={expanded.openCount === 0}
          onExpandAll={expanded.expandAll}
          onCollapseAll={expanded.collapseAll}
        />
        {servers.length > 0 && (
          <div className="itemlist">
            {shown.map((s) => (
              <ServerPanel
                key={s.id}
                server={s}
                projects={projects}
                open={expanded.isOpen(s.id)}
                onToggle={() => expanded.toggle(s.id)}
                onChanged={replace}
                onDeleted={() => {
                  setConnected(null);
                  reload();
                }}
              />
            ))}
            {shown.length === 0 && (
              <Empty title="No servers match">Clear the filter to see them all.</Empty>
            )}
          </div>
        )}
        {!body.configured && servers.length === 0 && (
          <Empty title="No MCP servers yet" />
        )}
      </div>
    </div>
  );
}
