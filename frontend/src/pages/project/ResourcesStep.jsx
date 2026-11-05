import { Icon } from "../../components/icons.jsx";
import { ActionBar, LinkButton, SlidingThumb } from "../../components/ui.jsx";
import { resourceCounts } from "../../lib/resources.js";
import { RESOURCE_TABS, navigate, paths } from "../../lib/router.js";
import { DataStep } from "./DataStep.jsx";
import { KnowledgeStep } from "./KnowledgeStep.jsx";
import { McpTab } from "./McpTab.jsx";
import { requireAccess } from "../../components/AccessGuard.jsx";

const TABS = {
  documents: {
    label: "Documents",
    note: "Agents search these files with the knowledge_search tool.",
  },
  databases: {
    label: "Databases",
    note: "Agents query these tables with sql_schema and sql_query: read-only, capped per query.",
  },
  tools: {
    label: "MCP tools",
    note: "Agents call these servers' approved tools; what they pass is sent to the server.",
  },
};

/**
 * What this project's agents can use, in one step: documents, databases and MCP tools.
 * Attaching any of them is the project's opt-in; agents get them as tools on the Brief
 * step (or from the assistant). The tab is part of the URL.
 */
function ResourcesStepInner({
  project,
  tab,
  onKnowledgeChanged,
  onDataChanged,
  onRevised,
}) {
  const id = project.project_id;
  const counts = resourceCounts(project);
  const current = RESOURCE_TABS.includes(tab) ? tab : RESOURCE_TABS[0];

  return (
    <>
      <div className="page">
        <div className="resources__head">
          <p className="muted resources__intro">
            What this project&apos;s agents can use. Attaching something is this
            project&apos;s opt-in; give agents the matching tools on the{" "}
            <a href={paths.project(id, "brief")}>Brief</a> step.
          </p>
          <div
            className="segmented resources__tabs"
            role="tablist"
            aria-label="Resources"
          >
            <SlidingThumb on={current} />
            {RESOURCE_TABS.map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                id={`resources-tab-${key}`}
                aria-controls="resources-panel"
                aria-selected={current === key}
                className={
                  current === key
                    ? "segmented__item segmented__item--on"
                    : "segmented__item"
                }
                onClick={() => navigate(paths.project(id, "resources", key))}
              >
                {TABS[key].label}
                {counts[key] > 0 && (
                  <span className="count-chip">{counts[key]}</span>
                )}
              </button>
            ))}
          </div>
        </div>

        <div
          role="tabpanel"
          id="resources-panel"
          aria-labelledby={`resources-tab-${current}`}
        >
          {current === "documents" && (
            // Not keyed by plan version: a revision made from it (giving agents access)
            // shouldn't wipe the assistant's reply it shows.
            <KnowledgeStep
              project={project}
              onKnowledgeChanged={onKnowledgeChanged}
              onRevised={onRevised}
            />
          )}
          {current === "databases" && (
            <DataStep
              project={project}
              onDataChanged={onDataChanged}
              onRevised={onRevised}
            />
          )}
          {current === "tools" && (
            <McpTab project={project} onRevised={onRevised} />
          )}
        </div>
      </div>

      <ActionBar note={`Optional. ${TABS[current].note}`}>
        <LinkButton href={paths.project(id, "brief")}>
          <Icon name="arrowLeft" />
          Back to Brief
        </LinkButton>
        <LinkButton variant="primary" href={paths.project(id, "plan")}>
          Review plan
          <Icon name="arrowRight" />
        </LinkButton>
      </ActionBar>
    </>
  );
}

export const ResourcesStep = requireAccess("manage", ResourcesStepInner, "attach files, data and tools to a project");
