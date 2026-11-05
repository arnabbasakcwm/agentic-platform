import { useCallback, useEffect, useState } from "react";
import { ModelChecklist } from "../ModelChecklist.jsx";
import { Callout, ErrorCallout, Panel, Skeleton } from "../ui.jsx";
import { modelLabel, summarizeLimit } from "../../lib/access.js";
import { api } from "../../lib/api.js";
import { useAction } from "../../lib/useAction.js";

const covers = (patterns, ref) => patterns.some((p) => p === ref || (p.endsWith("/*") && ref.startsWith(p.slice(0, -1))));

/**
 * Which models the team's work may use: the team's own limit (the Super Admin sets it), and each
 * member's limit inside the team (the Super Admin or a group admin). A limit can only narrow what the
 * level above allows, and you can only hand out models you may use yourself.
 */
export function ModelsTab({ team, members, isMaster }) {
  const [data, setData] = useState(null);
  const load = useAction();
  const { run: runLoad } = load;
  const reload = useCallback(() => runLoad(() => api.teamModels(team.id)).then((r) => r && setData(r)), [runLoad, team.id]);
  useEffect(() => {
    reload();
  }, [reload]);

  if (!data) {
    return <Panel>{load.error ? <ErrorCallout error={load.error} /> : <Skeleton lines={4} />}</Panel>;
  }
  const orgOffered = data.org.catalog ? data.offered.filter((m) => covers(data.org.catalog, m)) : data.offered;
  // What the team may use: the organisation's catalog narrowed by the team's own list.
  const teamChoices = data.team ? orgOffered.filter((m) => covers(data.team.models, m)) : orgOffered;
  const memberLimit = (userId) => data.members.find((m) => m.scope_id === `${team.id}:${userId}`) ?? null;

  return (
    <div className="stack">
      <Callout tone="info" title="How model limits combine">
        What someone may use is the organisation&apos;s catalog, narrowed by the team&apos;s limit, narrowed by their own limit. A limit
        can only remove models, never add them. If an agent uses a model someone may not use, their run stops before the call
        {data.org.fallback_model ? ` — or uses the fallback model (${modelLabel(data.org.fallback_model)}) when they may use it` : ""}.
      </Callout>

      <Panel
        title="Team limit"
        subtitle={isMaster ? "Applies to every project this team owns" : "Set by the Super Admin"}
      >
        <ModelChecklist
          key={summarizeLimit(data.team?.models ?? null)}
          name="the team"
          choices={orgOffered}
          value={data.team ? data.team.models : null}
          disabled={!isMaster}
          onSave={async (list) => {
            const done = list === null ? await api.clearTeamModels(team.id) : await api.setTeamModels(team.id, list);
            reload();
            return done;
          }}
        />
      </Panel>

      <Panel title="Member limits" subtitle="Narrow what one person may use in this team" flush>
        {!members ? (
          <div className="panel__body">
            <Skeleton lines={3} />
          </div>
        ) : (
          members.map((m) => {
            const limit = memberLimit(m.user_id);
            return (
              <details key={m.user_id} className="modelcheck__member">
                <summary>
                  <span>{m.email}</span>
                  <span className="muted">{limit ? `${limit.models.length} model${limit.models.length === 1 ? "" : "s"}` : "No extra limit"}</span>
                </summary>
                <div className="panel__body">
                  <ModelChecklist
                    key={summarizeLimit(limit?.models ?? null)}
                    name={m.email}
                    choices={teamChoices}
                    value={limit ? limit.models : null}
                    onSave={async (list) => {
                      const done =
                        list === null ? await api.clearMemberModels(team.id, m.user_id) : await api.setMemberModels(team.id, m.user_id, list);
                      reload();
                      return done;
                    }}
                  />
                </div>
              </details>
            );
          })
        )}
      </Panel>
    </div>
  );
}
