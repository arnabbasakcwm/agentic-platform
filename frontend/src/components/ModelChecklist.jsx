import { useMemo, useState } from "react";
import { modelLabel, summarizeLimit, toggleRef } from "../lib/access.js";
import { Button, ErrorCallout } from "./ui.jsx";
import { OptionDropdown } from "./OptionDropdown.jsx";
import { Icon } from "./icons.jsx";
import { useAction } from "../lib/useAction.js";

/** "OpenAI · gpt-4o-mini" -> dropdown option grouped by provider. */
export function modelOptions(refs) {
  return refs
    .map((ref) => {
      const [group, ...rest] = modelLabel(ref).split(" · ");
      return { value: ref, label: rest.join(" · ") || group, group: rest.length ? group : undefined };
    })
    .sort((a, b) => (a.group ?? "").localeCompare(b.group ?? "") || a.label.localeCompare(b.label));
}

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
  const options = useMemo(() => modelOptions(choices), [choices]);

  async function submit(e) {
    e.preventDefault();
    await save.run(() => onSave(limited ? picked : null));
  }

  return (
    <form className="modelcheck" onSubmit={submit} aria-label={`Models for ${name}`}>
      <div className="seg" role="radiogroup" aria-label={`Limit for ${name}`}>
        <label className={`seg__opt${!limited ? " seg__opt--on" : ""}`}>
          <input type="radio" name={`mode-${name}`} checked={!limited} disabled={disabled} onChange={() => setLimited(false)} />
          <span className="seg__title">No limit (every model)</span>
          <span className="seg__sub">Any model the platform offers</span>
        </label>
        <label className={`seg__opt${limited ? " seg__opt--on" : ""}`}>
          <input type="radio" name={`mode-${name}`} checked={limited} disabled={disabled} onChange={() => setLimited(true)} />
          <span className="seg__title">Only these models</span>
          <span className="seg__sub">Pick the allowed list</span>
        </label>
      </div>
      {limited && (
        <div className="modelcheck__list" role="group" aria-label={`Allowed models for ${name}`}>
          {choices.length === 0 ? (
            <p className="muted">There are no models to choose from.</p>
          ) : (
            <OptionDropdown
              multiple
              label={`Allowed models for ${name}`}
              placeholder="Choose models…"
              searchPlaceholder="Search models"
              options={options}
              value={picked}
              onChange={setPicked}
              disabled={disabled}
            />
          )}
          {picked.length > 0 && (
            <ul className="chips" aria-label="Selected models">
              {picked.map((ref) => (
                <li key={ref} className="chip">
                  <span>{modelLabel(ref)}</span>
                  {!disabled && (
                    <button type="button" className="chip__x" aria-label={`Remove ${modelLabel(ref)}`} onClick={() => setPicked((l) => toggleRef(l, ref))}>
                      <Icon name="close" size={12} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
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
