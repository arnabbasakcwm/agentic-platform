import { Icon } from "../../components/icons.jsx";
import { ActionBar, LinkButton, MetaList, Panel, Pill } from "../../components/ui.jsx";
import { fullDate } from "../../lib/format.js";
import { paths } from "../../lib/router.js";

const unique = (values) => [...new Set(values)];

export function BriefStep({ project }) {
  const { plan } = project;
  const models = unique(plan.agents.map((a) => a.llm.model));
  const toolsInUse = unique(plan.agents.flatMap((a) => a.tools));
  const external = project.side_effect_tools_enabled ?? [];

  return (
    <>
      <div className="page">
        <div className="split">
          <Panel title="Task brief" subtitle="What the planner was asked to build a team for.">
            <p className="prose">{project.brief}</p>
          </Panel>

          <aside className="split__aside">
            <Panel title="Details">
              <MetaList
                rows={[
                  ["Created", project.created_at ? fullDate(project.created_at) : null],
                  ["Last changed", project.updated_at ? fullDate(project.updated_at) : null],
                  ["Agents", <span key="Agents" className="mono">{plan.agents.length}</span>],
                  ["Models", models.map((m) => <Pill key={m}>{m}</Pill>)],
                  [
                    "Tools in use",
                    toolsInUse.length > 0 ? (
                      toolsInUse.map((t) => (
                        <Pill key={t} tone={external.includes(t) ? "warn" : undefined}>
                          {t}
                        </Pill>
                      ))
                    ) : (
                      <span className="muted">None</span>
                    ),
                  ],
                  [
                    "External access",
                    external.length > 0 ? (
                      external.map((t) => (
                        <Pill key={t} tone="warn">
                          {t}
                        </Pill>
                      ))
                    ) : (
                      <span className="muted">None allowed</span>
                    ),
                  ],
                ]}
              />
            </Panel>
          </aside>
        </div>
      </div>

      <ActionBar note="The brief is fixed once a plan exists. To work from a different brief, start a new project.">
        <LinkButton variant="primary" href={paths.project(project.project_id, "plan")}>
          Review plan
          <Icon name="arrowRight" />
        </LinkButton>
      </ActionBar>
    </>
  );
}
