import { useState } from "react";
import { api } from "../lib/api.js";
import { projectName, projectTitle } from "../lib/format.js";
import { useAction } from "../lib/useAction.js";
import { Icon } from "./icons.jsx";

const NAME_MAX = 100;

/**
 * A project's name with a small pencil to rename it in place. Enter or ✓ saves, Escape or
 * × cancels; saving an empty name goes back to the brief's first line. `renderName`
 * draws the name (a heading, a link…); `onRenamed` gets the updated project.
 */
export function ProjectName({
  project,
  onRenamed,
  renderName = (name) => <span>{name}</span>,
  max = 72,
  className,
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const save = useAction();
  const name = projectName(project, max);
  const fallback = projectTitle(project.brief, max);

  function start(event) {
    event.preventDefault();
    event.stopPropagation();
    // Start from the name as shown (in full), ready to edit.
    setValue(project.name || projectTitle(project.brief, NAME_MAX));
    setEditing(true);
  }

  function cancel() {
    setEditing(false);
  }

  async function submit(event) {
    event.preventDefault();
    event.stopPropagation();
    const updated = await save.run(() =>
      api.renameProject(project.project_id, value),
    );
    if (updated) {
      setEditing(false);
      onRenamed?.(updated);
    }
  }

  if (editing) {
    return (
      <form
        className={["pname pname--editing", className]
          .filter(Boolean)
          .join(" ")}
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              cancel();
            }
          }}
          maxLength={NAME_MAX}
          placeholder={fallback}
          aria-label="Project name"
          // Focus moves here as the field replaces the name the user just chose to edit.
          autoFocus
          // Caret at the end, so the name can be edited rather than retyped.
          onFocus={(e) =>
            e.target.setSelectionRange(
              e.target.value.length,
              e.target.value.length,
            )
          }
          disabled={save.busy}
        />
        <button
          type="submit"
          className="pname__btn"
          aria-label="Save name"
          disabled={save.busy}
        >
          <Icon name="check" size={14} />
        </button>
        <button
          type="button"
          className="pname__btn"
          aria-label="Cancel renaming"
          onClick={cancel}
          disabled={save.busy}
        >
          <Icon name="close" size={14} />
        </button>
        {save.error && (
          <span className="pname__error" role="alert">
            {save.error.message}
          </span>
        )}
      </form>
    );
  }

  return (
    <span className={["pname", className].filter(Boolean).join(" ")}>
      {renderName(name)}
      <button
        type="button"
        className="pname__edit"
        aria-label={`Rename ${name}`}
        title="Rename"
        onClick={start}
      >
        <Icon name="edit" size={14} />
      </button>
    </span>
  );
}
