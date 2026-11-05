import { useCallback, useEffect, useRef, useState } from "react";
import { LEVELS, LEVEL_HELP, LEVEL_LABELS } from "../lib/access.js";
import { api } from "../lib/api.js";
import { useAction } from "../lib/useAction.js";
import { Icon } from "./icons.jsx";
import { Button, Callout, ErrorCallout, Field, Skeleton } from "./ui.jsx";

const WHOLE = "*";

/** Who a grant is for, in words. People outside the sharer's teams are shown without their address. */
function granteeLabel(grant, targets) {
  if (grant.grantee_type === "team") {
    const team = targets.teams.find((t) => t.id === grant.grantee_id);
    return team ? `${team.name} (team)` : "A team you aren't in";
  }
  const person = targets.users.find((u) => u.id === grant.grantee_id);
  return person ? person.email : "Someone outside your teams";
}

function GrantRow({ grant, targets, agents, busy, onLevel, onRevoke }) {
  const [asking, setAsking] = useState(false);
  const label = granteeLabel(grant, targets);
  const what = grant.agent_id === WHOLE ? "Whole project" : (agents.find((a) => a.id === grant.agent_id)?.id ?? grant.agent_id);
  return (
    <tr>
      <td>{label}</td>
      <td>{what}</td>
      <td>
        <select
          value={grant.level}
          disabled={busy}
          aria-label={`Access level for ${label}, ${what}`}
          onChange={(e) => onLevel(grant, e.target.value)}
        >
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {LEVEL_LABELS[l]}
            </option>
          ))}
        </select>
      </td>
      <td className="access__actions">
        {asking ? (
          <span className="access__confirm" role="group" aria-label={`Confirm: stop sharing with ${label}`}>
            <Button size="sm" variant="danger" onClick={() => onRevoke(grant)} disabled={busy}>
              Stop sharing
            </Button>
            <Button size="sm" onClick={() => setAsking(false)} disabled={busy}>
              Keep
            </Button>
          </span>
        ) : (
          <Button size="sm" onClick={() => setAsking(true)} aria-label={`Stop sharing with ${label} (${what})`}>
            Remove
          </Button>
        )}
      </td>
    </tr>
  );
}

/**
 * Share a project, or one of its agents, with a person or a team at a level. Sharing never copies
 * anything; taking a share away applies at once, even to a run in progress. What you are offered is
 * only the people and teams the API says are in your scope, and the API checks every request again.
 */
export function ShareDialog({ project, open, onClose }) {
  const ref = useRef(null);
  const [grants, setGrants] = useState(null);
  const [targets, setTargets] = useState({ teams: [], users: [] });
  const [who, setWho] = useState("");
  const [what, setWhat] = useState(WHOLE);
  const [level, setLevel] = useState("use");
  const load = useAction();
  const save = useAction();
  const { run: runLoad } = load;
  const projectId = project.project_id;
  const agents = project.plan.agents;

  const reload = useCallback(
    () =>
      runLoad(() => Promise.all([api.grants(projectId), api.shareTargets(projectId)])).then((r) => {
        if (!r) return;
        setGrants(r[0].grants);
        setTargets(r[1]);
      }),
    [runLoad, projectId],
  );

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      reload();
    }
    if (!open && dialog.open) dialog.close();
  }, [open, reload]);

  async function share(e) {
    e.preventDefault();
    const split = who.indexOf(":");
    const granteeType = who.slice(0, split);
    const granteeId = who.slice(split + 1);
    const done = await save.run(() => api.share(projectId, { agentId: what, granteeType, granteeId, level }));
    if (done) {
      setWho("");
      reload();
    }
  }
  const changeLevel = (grant, next) =>
    save
      .run(() =>
        api.share(projectId, {
          agentId: grant.agent_id,
          granteeType: grant.grantee_type,
          granteeId: grant.grantee_id,
          level: next,
        }),
      )
      .then(() => reload());
  const revoke = (grant) => save.run(() => api.revokeGrant(projectId, grant.id)).then(() => reload());

  return (
    <dialog
      ref={ref}
      className="sharedialog"
      aria-labelledby="sharedialog-title"
      onClose={onClose}
      onCancel={onClose}
    >
      <header className="sharedialog__head">
        <h2 id="sharedialog-title" className="sharedialog__title">
          Share this project
        </h2>
        <button type="button" className="iconbtn" onClick={onClose} aria-label="Close">
          <Icon name="close" />
        </button>
      </header>
      <div className="sharedialog__body">
        <Callout tone="info">
          Sharing gives access; nothing is copied. People you share with run it with their own model
          permissions and their own budget, and see only their own runs.
        </Callout>

        <form className="access__row" onSubmit={share} aria-label="New share">
          <Field label="Share with">
            <select value={who} onChange={(e) => setWho(e.target.value)} required>
              <option value="">Choose a person or team…</option>
              {targets.teams.length > 0 && (
                <optgroup label="Teams">
                  {targets.teams.map((t) => (
                    <option key={t.id} value={`team:${t.id}`}>
                      {t.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {targets.users.length > 0 && (
                <optgroup label="People">
                  {targets.users.map((u) => (
                    <option key={u.id} value={`user:${u.id}`}>
                      {u.email}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </Field>
          <Field label="What">
            <select value={what} onChange={(e) => setWhat(e.target.value)}>
              <option value={WHOLE}>Whole project</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  Agent: {a.id}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Level" hint={LEVEL_HELP[level]}>
            <select value={level} onChange={(e) => setLevel(e.target.value)}>
              {LEVELS.map((l) => (
                <option key={l} value={l}>
                  {LEVEL_LABELS[l]}
                </option>
              ))}
            </select>
          </Field>
          <Button type="submit" variant="primary" loading={save.busy} disabled={!who}>
            Share
          </Button>
        </form>
        <ErrorCallout error={save.error} />

        <h3 className="sharedialog__sub">Who has access</h3>
        {!grants ? (
          load.error ? <ErrorCallout error={load.error} /> : <Skeleton lines={2} />
        ) : grants.length === 0 ? (
          <p className="muted">Only you (and administrators of this project&apos;s team).</p>
        ) : (
          <table className="table table--stack">
            <thead>
              <tr>
                <th>Who</th>
                <th>What</th>
                <th>Level</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {grants.map((g) => (
                <GrantRow
                  key={g.id}
                  grant={g}
                  targets={targets}
                  agents={agents}
                  busy={save.busy}
                  onLevel={changeLevel}
                  onRevoke={revoke}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </dialog>
  );
}
