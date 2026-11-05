import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Empty,
  ErrorCallout,
  Field,
  PageHeader,
  Panel,
  Pill,
  Skeleton,
} from "../components/ui.jsx";
import { teamRoleLabel } from "../lib/access.js";
import { api } from "../lib/api.js";
import { paths } from "../lib/router.js";
import { useAction } from "../lib/useAction.js";

/** The teams you belong to (the Super Admin sees every team) and, for the Super Admin, a way to make one. */
export function TeamsPage({ me, onChanged }) {
  const [teams, setTeams] = useState(null);
  const [name, setName] = useState("");
  const load = useAction();
  const create = useAction();
  const { run: runLoad } = load;
  const isMaster = me.role === "master";

  const reload = useCallback(
    () => runLoad(() => api.teams()).then((r) => r && setTeams(r.teams)),
    [runLoad],
  );
  useEffect(() => {
    reload();
  }, [reload]);

  async function submit(e) {
    e.preventDefault();
    const made = await create.run(() => api.createTeam(name.trim()));
    if (made) {
      setName("");
      reload();
      onChanged?.();
    }
  }

  return (
    <div className="page access">
      <PageHeader
        title="Teams"
        subtitle={
          isMaster
            ? "Every team. Teams share projects, budgets and model limits; each has group admins who manage it."
            : "The teams you belong to. Group admins manage their team's members, budget and models."
        }
      />
      <div className="stack">
        {isMaster && (
          <Panel title="New team">
            <form className="access__row" onSubmit={submit} aria-label="New team">
              <Field label="Team name">
                <input
                  value={name}
                  maxLength={100}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Growth"
                  required
                />
              </Field>
              <Button
                type="submit"
                variant="primary"
                loading={create.busy}
                disabled={!name.trim()}
              >
                Create team
              </Button>
            </form>
            <ErrorCallout error={create.error} />
          </Panel>
        )}

        {!teams ? (
          <Panel>
            {load.error ? <ErrorCallout error={load.error} /> : <Skeleton lines={3} />}
          </Panel>
        ) : teams.length === 0 ? (
          <Panel>
            <Empty title="You aren't in a team yet">
              An administrator adds people to teams.
            </Empty>
          </Panel>
        ) : (
          <Panel title="Your teams" subtitle={`${teams.length}`} flush>
            <table className="table table--stack">
              <thead>
                <tr>
                  <th>Team</th>
                  <th>Your role</th>
                  <th className="table__num">Members</th>
                </tr>
              </thead>
              <tbody>
                {teams.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <a href={paths.team(t.id)}>{t.name}</a>
                    </td>
                    <td>
                      {t.my_role ? (
                        <Pill tone={t.my_role === "group_admin" ? "accent" : undefined}>
                          {teamRoleLabel(t.my_role)}
                        </Pill>
                      ) : (
                        <span className="muted">Not a member</span>
                      )}
                    </td>
                    <td className="table__num">{t.members}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
      </div>
    </div>
  );
}
