import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Callout,
  Empty,
  ErrorCallout,
  Field,
  PageHeader,
  Panel,
  Pill,
  Skeleton,
} from "../components/ui.jsx";
import {
  CHILD_KINDS,
  allocatableParents,
  budgetLabel,
  budgetTree,
  formatMicro,
  meter,
  microToDollars,
  parseDollars,
} from "../lib/access.js";
import { api } from "../lib/api.js";
import { useAction } from "../lib/useAction.js";

const KIND_LABELS = { pool: "Sub Admin pool", team: "Team", user: "Person" };

function Meter({ node }) {
  const m = meter(node);
  return (
    <span className="access__meter">
      <span
        className={`meter meter--${m.tone}`}
        role="img"
        aria-label={`${m.percent}% used`}
      >
        <span className="meter__fill" style={{ "--fill": `${m.width}%` }} />
      </span>
      <span className="access__meter-text">{m.percent}%</span>
    </span>
  );
}

function EditAmount({ node, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(microToDollars(node.amount));
  const save = useAction();
  async function submit(e) {
    e.preventDefault();
    const micro = parseDollars(text);
    if (micro === null) return;
    const done = await save.run(() => api.setBudget(node.scope_type, node.scope_id, { amount: micro }));
    if (done) {
      setEditing(false);
      onSaved();
    }
  }
  if (!editing) {
    return (
      <Button size="sm" onClick={() => setEditing(true)} aria-label={`Change amount of ${node.id}`}>
        Change
      </Button>
    );
  }
  return (
    <form className="access__confirm" onSubmit={submit} aria-label={`Change amount of ${node.id}`}>
      <input
        value={text}
        inputMode="decimal"
        aria-label={`New amount in dollars for ${node.id}`}
        onChange={(e) => setText(e.target.value)}
        size={8}
      />
      <Button type="submit" size="sm" variant="primary" loading={save.busy} disabled={parseDollars(text) === null}>
        Save
      </Button>
      <Button size="sm" onClick={() => setEditing(false)} disabled={save.busy}>
        Cancel
      </Button>
      <ErrorCallout error={save.error} />
    </form>
  );
}

function RemoveBudget({ node, onRemoved }) {
  const [asking, setAsking] = useState(false);
  const del = useAction();
  if (!asking) {
    return (
      <Button size="sm" onClick={() => setAsking(true)} aria-label={`Remove budget ${node.id}`}>
        Remove
      </Button>
    );
  }
  return (
    <span className="access__confirm" role="group" aria-label={`Confirm removing ${node.id}`}>
      <span className="muted">Its amount goes back to the budget above.</span>
      <Button
        size="sm"
        variant="danger"
        loading={del.busy}
        onClick={async () => {
          const done = await del.run(() => api.deleteBudget(node.scope_type, node.scope_id));
          if (done) onRemoved();
        }}
      >
        Remove
      </Button>
      <Button size="sm" onClick={() => setAsking(false)} disabled={del.busy}>
        Keep
      </Button>
      <ErrorCallout error={del.error} />
    </span>
  );
}

function AllocateForm({ parents, ctx, me, teams, onDone }) {
  const [parentId, setParentId] = useState(parents[0]?.id ?? "");
  const parent = parents.find((p) => p.id === parentId) ?? parents[0];
  const kinds = CHILD_KINDS[parent?.scope_type] ?? [];
  const [kind, setKind] = useState("");
  const [target, setTarget] = useState("");
  const [amount, setAmount] = useState("");
  const [period, setPeriod] = useState("monthly");
  const [soft, setSoft] = useState(false);
  const [people, setPeople] = useState(null);
  const save = useAction();
  const load = useAction();
  const { run: runLoad } = load;
  const activeKind = kinds.includes(kind) ? kind : kinds[0];

  // Who can be picked: the Super Admin and Sub Admins choose from everyone; a group admin from their team.
  useEffect(() => {
    if (activeKind !== "user" && activeKind !== "pool") return;
    if (me.role === "master" || me.role === "admin") {
      runLoad(() => api.adminUsers(1)).then((r) => r && setPeople(r.users));
    } else if (parent?.scope_type === "team") {
      runLoad(() => api.teamMembers(parent.scope_id)).then(
        (r) => r && setPeople(r.members.map((m) => ({ id: m.user_id, email: m.email, role: "user" }))),
      );
    }
  }, [activeKind, me.role, parent, runLoad]);

  const options =
    activeKind === "team"
      ? teams.map((t) => ({ id: t.id, label: t.name }))
      : (people ?? [])
          .filter((u) => (activeKind === "pool" ? u.role === "admin" : true))
          .map((u) => ({ id: u.id, label: u.email }));
  const micro = parseDollars(amount);

  async function submit(e) {
    e.preventDefault();
    const done = await save.run(() =>
      api.setBudget(activeKind, target, {
        amount: micro,
        parent: parent.id,
        period,
        hard_limit: !soft,
      }),
    );
    if (done) {
      setTarget("");
      setAmount("");
      onDone();
    }
  }

  return (
    <form className="access__row" onSubmit={submit} aria-label="Allocate a budget">
      <Field label="Allocate from">
        <select value={parent?.id ?? ""} onChange={(e) => { setParentId(e.target.value); setKind(""); setTarget(""); }}>
          {parents.map((p) => (
            <option key={p.id} value={p.id}>
              {budgetLabel(p, ctx)} ({formatMicro(p.unallocated)} unallocated)
            </option>
          ))}
        </select>
      </Field>
      <Field label="Give it to a">
        <select value={activeKind ?? ""} onChange={(e) => { setKind(e.target.value); setTarget(""); }}>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Who">
        <select value={target} onChange={(e) => setTarget(e.target.value)} required disabled={options.length === 0}>
          <option value="">{load.busy ? "Loading…" : "Choose…"}</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Amount per period (USD)" hint={amount && micro === null ? "Use a plain amount like 25 or 12.50" : undefined}>
        <input value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)} placeholder="25" required />
      </Field>
      <Field label="Period">
        <select value={period} onChange={(e) => setPeriod(e.target.value)}>
          <option value="monthly">Monthly</option>
          <option value="weekly">Weekly (from Monday)</option>
          <option value="one_time">One time</option>
        </select>
      </Field>
      <label className="access__check">
        <input type="checkbox" checked={soft} onChange={(e) => setSoft(e.target.checked)} />
        Warn only (don&apos;t stop at the limit)
      </label>
      <Button type="submit" variant="primary" loading={save.busy} disabled={!target || micro === null}>
        Allocate
      </Button>
      <ErrorCallout error={save.error ?? load.error} />
    </form>
  );
}

/** The budgets you can see, how full each is, and (where you hold the budget above) a way to hand it on. */
export function BudgetsPage({ me }) {
  const [state, setState] = useState(null);
  const load = useAction();
  const { run: runLoad } = load;

  const reload = useCallback(
    () =>
      runLoad(() => Promise.all([api.budgets(), api.myBudget(), api.teams()])).then((r) => {
        if (!r) return;
        const [budgets, mine, teams] = r;
        setState({ nodes: budgets.budgets, mine, teams: teams.teams });
      }),
    [runLoad],
  );
  useEffect(() => {
    reload();
  }, [reload]);

  // Names for the people in the table: everyone for admins; a group admin knows their team's members.
  const [users, setUsers] = useState([]);
  const { run: runUsers } = useAction();
  const administered = (state?.teams ?? []).filter((t) => t.my_role === "group_admin").map((t) => t.id).join(",");
  useEffect(() => {
    if (me.role === "master" || me.role === "admin") {
      runUsers(() => api.adminUsers(1)).then((r) => r && setUsers(r.users));
    } else if (administered) {
      runUsers(() => Promise.all(administered.split(",").map((id) => api.teamMembers(id)))).then(
        (r) => r && setUsers(r.flatMap((x) => x.members.map((m) => ({ id: m.user_id, email: m.email })))),
      );
    }
  }, [me.role, administered, runUsers]);

  const ctx = useMemo(() => ({ teams: state?.teams ?? [], users: [...users, { id: me.id, email: me.email }] }), [state, users, me]);
  const tree = useMemo(() => budgetTree(state?.nodes ?? []), [state]);
  const parents = useMemo(() => (state ? allocatableParents(state.nodes, me, state.teams) : []), [state, me]);
  const manageable = new Set(parents.map((p) => p.id));

  return (
    <div className="page access">
      <PageHeader
        title="Budgets"
        subtitle="Spending limits, from the organisation down to each person. A budget can only hand on what it holds; when a hard limit is reached, runs stop before spending more."
      />
      {!state ? (
        <Panel>{load.error ? <ErrorCallout error={load.error} /> : <Skeleton lines={4} />}</Panel>
      ) : (
        <div className="stack">
          <Panel title="Your limit" subtitle="What stops your own runs">
            {state.mine.chain.length === 0 && state.mine.tightest_remaining === null ? (
              <p className="muted">No budget limits your runs.</p>
            ) : (
              <>
                {state.mine.chain.map((n) => (
                  <div key={n.id} className="access__mine">
                    <span>{n.scope_type === "user" ? "Your budget" : budgetLabel(n, ctx)}</span>
                    <Meter node={{ amount: n.amount, remaining: n.remaining }} />
                    <span>
                      {formatMicro(n.remaining)} left of {formatMicro(n.amount)}
                    </span>
                    {n.thresholds_reached.length > 0 && <Pill tone="warn">{Math.max(...n.thresholds_reached)}% reached</Pill>}
                    {!n.hard_limit && <Pill>Warn only</Pill>}
                  </div>
                ))}
                {state.mine.tightest_remaining !== null && (
                  <p className="muted">
                    The tightest limit above you leaves {formatMicro(state.mine.tightest_remaining)} for this period.
                  </p>
                )}
              </>
            )}
          </Panel>

          {tree.length === 0 ? (
            <Callout tone="info" title="No budgets set">
              Nothing limits spending yet. An administrator sets the organisation&apos;s budget and hands it down.
            </Callout>
          ) : (
            <Panel title="Budgets" subtitle={`${tree.length}`} flush>
              <table className="table table--stack">
                <thead>
                  <tr>
                    <th>Budget</th>
                    <th>Used</th>
                    <th className="table__num">Amount</th>
                    <th className="table__num">Left to allocate</th>
                    <th>Period</th>
                    <th>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {tree.map((n) => (
                    <tr key={n.id}>
                      <td className={`budgetrow budgetrow--d${Math.min(n.depth, 3)}`}>
                        {budgetLabel(n, ctx)}
                        <span className="table__sub">
                          {KIND_LABELS[n.scope_type] ?? "Organisation"}
                          {!n.hard_limit && " · warn only"}
                        </span>
                      </td>
                      <td>
                        <Meter node={n} />
                      </td>
                      <td className="table__num">{formatMicro(n.amount)}</td>
                      <td className="table__num">{n.scope_type === "user" ? "—" : formatMicro(n.unallocated)}</td>
                      <td>{n.period === "one_time" ? "One time" : n.period === "weekly" ? "Weekly" : "Monthly"}</td>
                      <td className="access__actions">
                        {n.parent_id && manageable.has(n.parent_id) && (
                          <>
                            <EditAmount key={n.amount} node={n} onSaved={reload} />
                            <RemoveBudget node={n} onRemoved={reload} />
                          </>
                        )}
                        {n.scope_type === "org" && me.role === "master" && <EditAmount key={n.amount} node={n} onSaved={reload} />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          )}

          {parents.length > 0 ? (
            <Panel title="Allocate a budget" subtitle="Hand part of a budget you hold to a team or a person">
              <AllocateForm key={tree.length} parents={parents} ctx={ctx} me={me} teams={state.teams} onDone={reload} />
            </Panel>
          ) : (
            tree.length > 0 && (
              <Empty title="Nothing to allocate">
                You hold no budget that you can hand on. Group admins split their team&apos;s budget; Sub Admins their pool.
              </Empty>
            )
          )}
        </div>
      )}
    </div>
  );
}
