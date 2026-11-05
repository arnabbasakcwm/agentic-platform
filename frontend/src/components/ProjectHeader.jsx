import { useId, useState } from "react";
import { canShareProject } from "../lib/access.js";
import { Icon } from "./icons.jsx";
import { ProjectName } from "./ProjectName.jsx";
import { ShareDialog } from "./ShareDialog.jsx";
import { Pill } from "./ui.jsx";

/** The Assistant sparkle, painted with the primary gradient. */
function Sparkle() {
  const id = useId();
  return (
    <svg className="sparkle" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" x2="1">
          <stop offset="0" stopColor="var(--violet)" />
          <stop offset=".55" stopColor="var(--pink)" />
          <stop offset="1" stopColor="var(--orange)" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${id})`}
        d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8zM19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9z"
      />
    </svg>
  );
}

function CopyId({ id }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be refused (permissions, insecure context); nothing to do.
    }
  }
  return (
    <button
      type="button"
      className="projhead__copy"
      onClick={copy}
      aria-label={copied ? "Project id copied" : "Copy project id"}
      title={copied ? "Copied" : "Copy project id"}
    >
      <Icon name={copied ? "check" : "copy"} size={14} />
    </button>
  );
}

/**
 * The project header on every phase page (DESIGN.md §5.3, ported 1:1 from
 * design/reference/phase-chrome.html): the name with its rename pencil, the pattern and
 * readiness pills, the monospace project id with a copy button, and one outlined
 * Assistant button. Nothing else, so it is identical on Brief through Deploy.
 */
export function ProjectHeader({ project, onRenamed, assistant }) {
  const [sharing, setSharing] = useState(false);
  // Offered only to people who can share it; the API checks again on every request.
  const canShare = canShareProject(project);
  return (
    <header className="pagehead projhead">
      <div className="projhead__text">
        <div className="projhead__title">
          <ProjectName
            project={project}
            max={110}
            renderName={(name) => <h1 className="pagehead__title">{name}</h1>}
            onRenamed={onRenamed}
          />
          <Pill tone="violet">{project.plan.orchestration_pattern}</Pill>
          {project.compiled ? (
            <Pill tone="success" live>
              Ready to run
            </Pill>
          ) : (
            <Pill tone="slate" dot>
              Not compiled
            </Pill>
          )}
        </div>
        <div className="projhead__id">
          <span className="mono">{project.project_id}</span>
          <CopyId id={project.project_id} />
        </div>
      </div>
      {canShare && (
        <>
          <button type="button" className="btn btn--outline projhead__share" onClick={() => setSharing(true)}>
            Share
          </button>
          <ShareDialog project={project} open={sharing} onClose={() => setSharing(false)} />
        </>
      )}
      {assistant && (
        <button
          type="button"
          className="btn btn--outline projhead__assistant"
          onClick={assistant.onOpen}
          aria-expanded={false}
        >
          <Sparkle />
          Assistant
        </button>
      )}
    </header>
  );
}
