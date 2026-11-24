import { forwardRef, useMemo, useState } from "react";
import { agentTitle } from "../lib/flow.js";
import { fileBase } from "../lib/exports.js";
import { formatDuration } from "../lib/format.js";
import { citationMap, splitSources } from "../lib/citations.js";
import { detectTable } from "../lib/tabular.js";
import { SourcesPanel, showSource } from "./Citations.jsx";
import { DataTable, RawFallback, TableBoundary } from "./DataTable.jsx";
import { DataView } from "./DataView.jsx";
import { Icon } from "./icons.jsx";
import { CopyButton } from "./JsonView.jsx";
import { Markdown } from "./Markdown.jsx";
import { OutputActions } from "./OutputActions.jsx";
import { Pill, Skeleton, StatusBadge } from "./ui.jsx";

/**
 * The answer itself: a table when it is one (CSV, JSON array, Markdown table), else
 * Markdown. A table that can't be read shows the raw text with a notice instead.
 */
function OutputContent({ output, agentId, projectName, runId }) {
  const content = output.content ?? "";
  const base = fileBase({ projectName, agentId, runId });
  const table = useMemo(() => {
    try {
      return detectTable(content, output.content_type);
    } catch (error) {
      return { error: error.message };
    }
  }, [content, output.content_type]);
  const citations = useMemo(() => citationMap(output.citations), [output.citations]);
  if (table?.error) return <RawFallback raw={content} reason={table.error} />;
  if (table) {
    return (
      <>
        <TableBoundary raw={content}>
          <DataTable table={table} raw={content} label={`${agentId} table`} fileName={`${base}.csv`} />
        </TableBoundary>
        <SourcesPanel agentId={agentId} citations={output.citations} autoAppended={output.citations_auto_appended} />
      </>
    );
  }
  if (citations.size === 0) return <Markdown fileBase={base}>{content}</Markdown>;
  // With structured citations, the written Sources section gives way to the panel.
  const { body } = splitSources(content);
  return (
    <>
      <Markdown citations={citations} onCite={(n) => showSource(agentId, n)} fileBase={base}>
        {body}
      </Markdown>
      <SourcesPanel
        agentId={agentId}
        citations={[...citations.values()]}
        autoAppended={output.citations_auto_appended}
      />
    </>
  );
}

/**
 * One agent's part of a run: a readable title, its state, how long it took, and its
 * answer rendered as Markdown with any structured data as a card. The colour matches
 * the agent's node in the diagram and its bar in the timeline.
 */
export const AgentOutputCard = forwardRef(function AgentOutputCard(
  { agentId, role, color, node, isFinal, highlighted, projectId, projectName, runId },
  ref,
) {
  const [open, setOpen] = useState(true);
  const title = agentTitle(agentId);
  const output = node.output;
  const bodyId = `output-body-${agentId}`;

  return (
    <article
      ref={ref}
      id={`output-${agentId}`}
      tabIndex={-1}
      className={[
        "outcard",
        `outcard--${node.status}`,
        isFinal && "outcard--final",
        highlighted && "outcard--highlight",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ "--agent-color": color }}
      aria-label={`${title} output`}
    >
      <header className="outcard__head">
        <span className="outcard__icon" aria-hidden="true">
          <Icon name="agent" size={15} />
        </span>
        <div className="outcard__titles">
          <h3 className="outcard__title">
            {title}
            {isFinal && <Pill tone="accent">Final answer</Pill>}
          </h3>
          {role && <span className="outcard__role">{role}</span>}
        </div>
        <div className="outcard__meta">
          <StatusBadge status={node.status} />
          {node.durationMs != null && (
            <span className="outcard__time" title="Time this agent took">
              <Icon name="clock" size={12} />
              {formatDuration(node.durationMs)}
            </span>
          )}
          {node.attempts > 1 && <Pill tone="warn">{node.attempts} attempts</Pill>}
          {output?.content && <CopyButton text={output.content} label="Copy" />}
          {output && node.status === "completed" && (
            <OutputActions
              projectId={projectId}
              projectName={projectName}
              runId={runId}
              agentId={agentId}
            />
          )}
          <button
            type="button"
            className="iconbtn"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls={bodyId}
            aria-label={open ? `Collapse ${title}` : `Expand ${title}`}
          >
            <span className={open ? "chev chev--open" : "chev"}>
              <Icon name="chevronDown" size={15} />
            </span>
          </button>
        </div>
      </header>

      {open && (
        <div className="outcard__body" id={bodyId}>
          {output ? (
            // Fades in as the agent's answer arrives.
            <div className="ap-fade">
              <OutputContent output={output} agentId={agentId} projectName={projectName} runId={runId} />
              <DataView data={output.data} fileBase={fileBase({ projectName, agentId, runId })} />
            </div>
          ) : node.status === "running" || node.status === "queued" ? (
            <>
              {node.retryError && (
                <p className="outcard__note">Retrying after an error: {node.retryError}</p>
              )}
              <Skeleton lines={4} />
            </>
          ) : (
            <p className={node.status === "failed" ? "outcard__error" : "outcard__note"}>
              {node.error ?? "No output."}
            </p>
          )}
        </div>
      )}
    </article>
  );
});
