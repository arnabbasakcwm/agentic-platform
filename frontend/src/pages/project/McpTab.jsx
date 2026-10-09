import { useEffect, useState } from "react";
import { Icon } from "../../components/icons.jsx";
import {
  Button,
  Empty,
  ErrorCallout,
  LinkButton,
  Panel,
  Pill,
} from "../../components/ui.jsx";
import { api } from "../../lib/api.js";
import { paths } from "../../lib/router.js";
import { useAction } from "../../lib/useAction.js";

/** The Resources step's MCP tools tab: which servers are attached, and which approved
 * tools this project's agents may use. */
export function McpTab({ project, onRevised }) {
  const [body, setBody] = useState(null);
  const load = useAction();
  const change = useAction();
  const { run: runLoad } = load;
  const pid = project.project_id;

  useEffect(() => {
    runLoad(() => api.projectMcpServers(pid)).then(
      (res) => res && setBody(res),
    );
  }, [runLoad, pid, project.plan_version]);

  async function toggle(server, attach) {
    const done = await change.run(() =>
      attach
        ? api.attachMcpServer(pid, server.id)
        : api.detachMcpServer(pid, server.id),
    );
    if (!done) return;
    const [next, fresh] = await Promise.all([
      runLoad(() => api.projectMcpServers(pid)),
      api.getProject(pid).catch(() => null),
    ]);
    if (next) setBody(next);
    // The Brief editor offers the attached servers' tools: refresh the project.
    if (fresh) onRevised(fresh);
  }

  if (!body) return load.error ? <ErrorCallout error={load.error} /> : null;
  const attached = body.servers.filter((s) => s.attached);
  const others = body.servers.filter((s) => !s.attached);

  return (
    <Panel
      title="MCP servers"
      subtitle="Tools from remote servers. Agents get only the tools you approved on the MCP servers page."
      actions={<LinkButton href={paths.mcp}>Manage MCP servers</LinkButton>}
    >
      <div className="stack">
        {body.servers.length === 0 && (
          <Empty title="No MCP servers yet">
            Connect one on the MCP servers page, approve its tools, then attach
            it here.
          </Empty>
        )}
        {attached.map((s) => {
          const approved = s.tools.filter((t) => t.usable);
          return (
            <section
              key={s.id}
              className="dsource"
              aria-label={`Attached: ${s.name}`}
            >
              <div className="dsource__head">
                <Icon name="bolt" size={16} />
                <strong>{s.name}</strong>
                <span className="muted dsource__sub">{s.host}</span>
                <Button
                  size="sm"
                  onClick={() => toggle(s, false)}
                  disabled={change.busy}
                  aria-label={`Detach ${s.name}`}
                >
                  Detach
                </Button>
              </div>
              {approved.length === 0 ? (
                <p className="muted">
                  No tools approved yet.{" "}
                  <a href={paths.mcp}>Approve the ones agents may use</a>.
                </p>
              ) : (
                <ul className="dtables">
                  {approved.map((t) => (
                    <li key={t.name}>
                      <span className="mono">{t.name}</span>
                      {s.used_tools.includes(t.exposed_name) ? (
                        <Pill tone="success">In use</Pill>
                      ) : (
                        <Pill>Not given to an agent</Pill>
                      )}
                      {!t.read_only_hint && (
                        <Pill tone="danger">May change data</Pill>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
        {others.length > 0 && (
          <ul className="dlist" aria-label="Other MCP servers">
            {others.map((s) => (
              <li key={s.id}>
                <Icon name="bolt" size={15} />
                <span>
                  <strong>{s.name}</strong>{" "}
                  <span className="muted">
                    {s.tools.filter((t) => t.usable).length} approved tool
                    {s.tools.filter((t) => t.usable).length === 1 ? "" : "s"}
                  </span>
                </span>
                <Button
                  size="sm"
                  onClick={() => toggle(s, true)}
                  disabled={change.busy}
                  aria-label={`Attach ${s.name}`}
                >
                  <Icon name="plus" size={12} />
                  Attach
                </Button>
              </li>
            ))}
          </ul>
        )}
        {attached.length > 0 && (
          <p className="muted dsection__hint">
            Attaching is this project&apos;s opt-in: whatever its agents pass to
            these tools is sent to the server. Give tools to agents on the{" "}
            <a href={paths.project(pid, "brief")}>Brief</a> step.
          </p>
        )}
        <ErrorCallout error={change.error} />
      </div>
    </Panel>
  );
}
