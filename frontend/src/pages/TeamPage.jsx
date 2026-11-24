import { OptionDropdown } from "../components/OptionDropdown.jsx";
import { useCallback, useEffect, useState } from "react";
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
import { ActivityTab } from "../components/team/ActivityTab.jsx";
import { ModelsTab } from "../components/team/ModelsTab.jsx";
import { teamRoleLabel } from "../lib/access.js";
import { api } from "../lib/api.js";
import { navigate, paths } from "../lib/router.js";
import { useAction } from "../lib/useAction.js";

const DEFAULT_TEAM = "default";

/** One confirm-in-place button: asks "Are you sure?" with the reason before doing a role change. */
function Confirm({ label, prompt, tone, onConfirm, ariaLabel }) {
  const [asking, setAsking] = useState(false);
  const act = useAction();
  if (asking) {
    return (
      <span className="access__confirm" role="group" aria-label={`Confirm: ${ariaLabel ?? label}`}>
        <span className="muted">{prompt}</span>
        <Button
          size="sm"
          variant={tone === "danger" ? "danger" : "primary"}
          loading={act.busy}
          onClick={async () => {
            const ok = await act.run(onConfirm);
            if (ok !== null) setAsking(false);
          }}
        >
          {label}
        </Button>
        <Button size="sm" onClick={() => setAsking(false)} disabled={act.busy}>
          Cancel
        </Button>
        <ErrorCallout error={act.error} />
      </span>
    );
  }
  return (
    <Button size="sm" onClick={() => setAsking(true)} aria-label={ariaLabel ?? label}>
      {label}
    </Button>
  );
}

function MemberRow({ team, member, me, isMaster, isTeamAdmin, onChanged }) {
  const isAdmin = member.role === "group_admin";
  const isMe = member.user_id === me.id;
  // The same rules the API enforces: appoint = master or the team's admin; take an admin's role
  // away = the master, or the admin themself; remove a plain member = master or the team's admin.
  const canAppoint = !isAdmin && (isMaster || isTeamAdmin);
  const canStepDown = isAdmin && (isMaster || isMe);
  const canRemove = isAdmin ? isMaster || isMe : isMaster || isTeamAdmin;
  return (
    <tr>
      <td>
        {member.email}
        {isMe && <span className="table__sub">you</span>}
      </td>
      <td>
        <Pill tone={isAdmin ? "accent" : undefined}>{teamRoleLabel(member.role)}</Pill>
      </td>
      <td className="access__actions">
        {canAppoint && (
          <Confirm
            label="Make group admin"
            ariaLabel={`Make ${member.email} a group admin`}
            prompt={`${member.email} will manage this team.`}
            onConfirm={() => api.makeGroupAdmin(team.id, member.user_id).then((r) => (onChanged(), r))}
          />
        )}
        {canStepDown && (
          <Confirm
            label={isMe ? "Step down" : "Remove admin role"}
            ariaLabel={`${isMe ? "Step down as group admin" : `Remove ${member.email} as group admin`}`}
            prompt={isMe ? "You will no longer manage this team." : `${member.email} becomes a member.`}
            onConfirm={() => api.removeGroupAdmin(team.id, member.user_id).then((r) => (onChanged(), r))}
          />
        )}
        {canRemove && (
          <Confirm
            tone="danger"
            label="Remove"
            ariaLabel={`Remove ${member.email} from the team`}
            prompt="They lose access to the team's projects."
            onConfirm={() => api.removeTeamMember(team.id, member.user_id).then((r) => (onChanged(), r))}
          />
        )}
      </td>
    </tr>
  );
}

function AddMember({ team, members, onChanged }) {
  const [users, setUsers] = useState(null);
  const [pick, setPick] = useState("");
  const load = useAction();
  const add = useAction();
  const { run: runLoad } = load;
  useEffect(() => {
    runLoad(() => api.adminUsers(1)).then((r) => r && setUsers(r.users));
  }, [runLoad]);

  const inTeam = new Set(members.map((m) => m.user_id));
  const candidates = (users ?? []).filter((u) => !inTeam.has(u.id));

  async function submit(e) {
    e.preventDefault();
    const done = await add.run(() => api.addTeamMember(team.id, pick));
    if (done) {
      setPick("");
      onChanged();
    }
  }
  return (
    <form className="access__row" onSubmit={submit} aria-label="Add a member">
      <Field
        label="Add a person"
        hint={users && candidates.length === 0 ? "Everyone with an account is already in this team." : undefined}
      >
        <OptionDropdown
          label="Add a person"
          options={candidates.map((u) => ({ value: u.id, label: u.email }))}
          value={pick}
          onChange={setPick}
          placeholder={users ? (candidates.length ? "Choose a person…" : "Nobody left to add") : "Loading…"}
          searchPlaceholder="Search by email"
          disabled={!users || candidates.length === 0}
        />
      </Field>
      <Button type="submit" variant="primary" loading={add.busy} disabled={!pick}>
        Add to team
      </Button>
      <ErrorCallout error={load.error ?? add.error} />
    </form>
  );
}

function Rename({ team, onChanged }) {
  const [name, setName] = useState(team.name);
  const save = useAction();
  async function submit(e) {
    e.preventDefault();
    if (await save.run(() => api.renameTeam(team.id, name.trim()))) onChanged();
  }
  return (
    <form className="access__row" onSubmit={submit} aria-label="Rename team">
      <Field label="Team name">
        <input type="text" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} required />
      </Field>
      <Button type="submit" loading={save.busy} disabled={!name.trim() || name.trim() === team.name}>
        Rename
      </Button>
      <ErrorCallout error={save.error} />
    </form>
  );
}

/** One team: its members and their roles, and its activity. */
export function TeamPage({ teamId, me, onChanged }) {
  const [team, setTeam] = useState(null);
  const [members, setMembers] = useState(null);
  const [tab, setTab] = useState("members");
  const load = useAction();
  const membersLoad = useAction();
  const { run: runLoad } = load;
  const { run: runMembers } = membersLoad;
  const isMaster = me.role === "master";

  const reload = useCallback(
    () =>
      runLoad(() => api.team(teamId)).then((t) => {
        if (!t) return;
        setTeam(t.team);
        // Only the Super Admin and the team's group admins may read the member list.
        if (isMaster || t.team.my_role === "group_admin") {
          runMembers(() => api.teamMembers(teamId)).then((m) => m && setMembers(m.members));
        }
      }),
    [runLoad, runMembers, teamId, isMaster],
  );
  useEffect(() => {
    reload();
  }, [reload]);

  const changed = useCallback(() => {
    reload();
    onChanged?.();
  }, [reload, onChanged]);

  if (!team) {
    return (
      <div className="page access">
        <Panel>{load.error ? <ErrorCallout error={load.error} /> : <Skeleton lines={4} />}</Panel>
      </div>
    );
  }
  const isTeamAdmin = team.my_role === "group_admin";
  const canManage = isMaster || isTeamAdmin;
  const tabs = [{ id: "members", label: "Members" }, ...(canManage ? [{ id: "models", label: "Models" }, { id: "activity", label: "Activity" }] : [])];

  return (
    <div className="page access">
      <PageHeader
        title={team.name}
        subtitle={`${team.members} ${team.members === 1 ? "member" : "members"}${team.my_role ? ` · you are ${team.my_role === "group_admin" ? "a group admin" : "a member"}` : ""}`}
        meta={team.id === DEFAULT_TEAM ? <Pill>Default team</Pill> : null}
      />
      {tabs.length > 1 && (
        <div className="segmented" role="tablist" aria-label="Team sections">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`segmented__item${tab === t.id ? " segmented__item--on" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}

      {tab === "members" ? (
        <div className="stack">
          {!canManage ? (
            <Callout tone="info" title="Members aren't listed for you">
              Only group admins see who is in a team. You can see this team&apos;s shared projects
              on the Projects page.
            </Callout>
          ) : !members ? (
            <Panel>
              {membersLoad.error ? <ErrorCallout error={membersLoad.error} /> : <Skeleton lines={3} />}
            </Panel>
          ) : (
            <Panel title="Members" subtitle={`${members.length}`} flush>
              {members.length === 0 ? (
                <div className="panel__body">
                  <Empty title="No members yet" />
                </div>
              ) : (
                <table className="table table--stack">
                  <thead>
                    <tr>
                      <th>Person</th>
                      <th>Role</th>
                      <th>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((m) => (
                      <MemberRow
                        key={m.user_id}
                        team={team}
                        member={m}
                        me={me}
                        isMaster={isMaster}
                        isTeamAdmin={isTeamAdmin}
                        onChanged={changed}
                      />
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>
          )}
          {isMaster && members && <Panel title="Add a person"><AddMember team={team} members={members} onChanged={changed} /></Panel>}
          {canManage && (
            <Panel title="Team settings">
              <Rename key={team.name} team={team} onChanged={changed} />
              {isMaster && team.id !== DEFAULT_TEAM && (
                <div className="access__danger">
                  <span>
                    Delete this team. Its projects become personal again; nothing else is deleted.
                  </span>
                  <DeleteButton
                    name={`team ${team.name}`}
                    prompt="Delete the team?"
                    onDelete={async () => {
                      try {
                        await api.deleteTeam(team.id);
                      } catch {
                        return false;
                      }
                      onChanged?.();
                      navigate(paths.teams);
                      return true;
                    }}
                  />
                </div>
              )}
            </Panel>
          )}
        </div>
      ) : (
        canManage && (tab === "activity" ? <ActivityTab team={team} /> : <ModelsTab team={team} members={members} isMaster={isMaster} />)
      )}
    </div>
  );
}
