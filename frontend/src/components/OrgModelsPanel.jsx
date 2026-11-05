import { useCallback, useEffect, useState } from "react";
import { ModelChecklist } from "./ModelChecklist.jsx";
import { Button, Callout, ErrorCallout, Field, Panel, Skeleton } from "./ui.jsx";
import { modelLabel, summarizeLimit, toggleRef } from "../lib/access.js";
import { api } from "../lib/api.js";
import { useAction } from "../lib/useAction.js";

/** What happens when a model isn't allowed, and which priceless models may run under a hard budget. */
function Fallback({ org, offered, disabled, onSaved }) {
  const [fallback, setFallback] = useState(org.fallback_model ?? "");
  const [overrides, setOverrides] = useState(org.unpriced_overrides ?? []);
  const save = useAction();
  const dirty = fallback !== (org.fallback_model ?? "") || summarizeLimit(overrides) !== summarizeLimit(org.unpriced_overrides ?? []);
  async function submit(e) {
    e.preventDefault();
    const done = await save.run(() =>
      api.setOrgModels({ catalog: org.catalog, fallback_model: fallback || null, unpriced_overrides: overrides }),
    );
    if (done) onSaved();
  }
  return (
    <form className="stack" onSubmit={submit} aria-label="Fallback and unpriced models">
      <Field
        label="Fallback model"
        hint="Used instead when an agent's model isn't allowed for the person running it — only if they may use the fallback. Leave empty to stop the run instead."
      >
        <select value={fallback} onChange={(e) => setFallback(e.target.value)} disabled={disabled}>
          <option value="">No fallback — stop the run</option>
          {offered.map((m) => (
            <option key={m} value={m}>
              {modelLabel(m)}
            </option>
          ))}
        </select>
      </Field>
      <div className="modelcheck__list" role="group" aria-label="Models allowed without a price">
        <p className="muted">
          Under a hard budget, a model with no price can&apos;t be metered, so it is refused. Tick a model to let it run anyway (its cost
          counts as zero; its tokens are still recorded).
        </p>
        {offered.map((m) => (
          <label key={m} className="access__check">
            <input
              type="checkbox"
              checked={overrides.includes(m)}
              disabled={disabled}
              onChange={() => setOverrides((list) => toggleRef(list, m))}
            />
            {modelLabel(m)}
          </label>
        ))}
      </div>
      {!disabled && (
        <div className="access__row">
          <Button type="submit" variant="primary" loading={save.busy} disabled={!dirty}>
            Save fallback and exceptions
          </Button>
        </div>
      )}
      <ErrorCallout error={save.error} />
    </form>
  );
}

/** The organisation's model catalog (Super Admin edits; Sub Admins read). */
export function OrgModelsPanel({ me }) {
  const [data, setData] = useState(null);
  const load = useAction();
  const { run: runLoad } = load;
  const isMaster = me.role === "master";
  const reload = useCallback(() => runLoad(() => api.adminModels()).then((r) => r && setData(r)), [runLoad]);
  useEffect(() => {
    reload();
  }, [reload]);

  if (!data) {
    return <Panel title="Models">{load.error ? <ErrorCallout error={load.error} /> : <Skeleton lines={3} />}</Panel>;
  }
  return (
    <Panel
      title="Models"
      subtitle={isMaster ? "Which models anyone on the platform may use" : "Set by the Super Admin"}
    >
      <div className="stack">
        {!isMaster && <Callout tone="info">Only the Super Admin changes the organisation&apos;s models.</Callout>}
        <ModelChecklist
          key={summarizeLimit(data.org.catalog)}
          name="the organisation"
          choices={data.offered}
          value={data.org.catalog}
          disabled={!isMaster}
          onSave={async (catalog) => {
            const done = await api.setOrgModels({
              catalog,
              fallback_model: data.org.fallback_model,
              unpriced_overrides: data.org.unpriced_overrides,
            });
            reload();
            return done;
          }}
        />
        <Fallback key={`${data.org.fallback_model}-${summarizeLimit(data.org.unpriced_overrides)}`} org={data.org} offered={data.offered} disabled={!isMaster} onSaved={reload} />
      </div>
    </Panel>
  );
}
