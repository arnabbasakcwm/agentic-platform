import { useState } from "react";
import { modelLabel, summarizeLimit, toggleRef } from "../lib/access.js";
import { Button, ErrorCallout } from "./ui.jsx";
import { useAction } from "../lib/useAction.js";

/**
 * Choose which models something is limited to: "no limit" (null) or a list. `choices` are the models
 * that can be picked (a group admin is offered only what they may use themselves; the API refuses
 * anything above that again). `onSave(list | null)` resolves to a truthy value on success.
 */
export function ModelChecklist({ name, choices, value, onSave, disabled, saveLabel = "Save" }) {
  const [limited, setLimited] = useState(value !== null);
  const [picked, setPicked] = useState(value ?? []);
  const save = useAction();
  const dirty = limited !== (value !== null) || (limited && summarizeLimit(picked) !== summarizeLimit(value ?? []));

  async function submit(e) {
    e.preventDefault();
    await save.run(() => onSave(limited ? picked : null));
  }

  return (
    <form className="modelcheck" onSubmit={submit} aria-label={`Models for ${name}`}>
      <div className="modelcheck__modes" role="radiogroup" aria-label={`Limit for ${name}`}>
        <label className="access__check">
          <input type="radio" name={`mode-${name}`} checked={!limited} disabled={disabled} onChange={() => setLimited(false)} />
          No limit (every model)
        </label>
        <label className="access__check">
          <input type="radio" name={`mode-${name}`} checked={limited} disabled={disabled} onChange={() => setLimited(true)} />
          Only these models
        </label>
      </div>
      {limited && (
        <div className="modelcheck__list" role="group" aria-label={`Allowed models for ${name}`}>
          {choices.length === 0 && <p className="muted">There are no models to choose from.</p>}
          {choices.map((ref) => (
            <label key={ref} className="access__check">
              <input
                type="checkbox"
                checked={picked.includes(ref)}
                disabled={disabled}
                onChange={() => setPicked((list) => toggleRef(list, ref))}
              />
              {modelLabel(ref)}
            </label>
          ))}
        </div>
      )}
      {!disabled && (
        <div className="access__row">
          <Button type="submit" variant="primary" loading={save.busy} disabled={!dirty}>
            {saveLabel}
          </Button>
        </div>
      )}
      <ErrorCallout error={save.error} />
    </form>
  );
}
