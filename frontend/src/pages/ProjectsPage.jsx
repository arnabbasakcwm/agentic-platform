import { Icon } from "../components/icons.jsx";
import { Button, Empty, ErrorCallout, LinkButton, PageHeader, Panel, Pill } from "../components/ui.jsx";
import { fullDate, projectTitle, timeAgo } from "../lib/format.js";
import { navigate, paths } from "../lib/router.js";

// A compiled project opens where you'd use it; an uncompiled one where you'd finish it.
function entryPath(project) {
  return paths.project(project.project_id, project.compiled ? "run" : "plan");
}

function ProjectRow({ project }) {
  const href = entryPath(project);
  return (
    <tr onClick={() => navigate(href)}>
      <td>
        <a className="table__title" href={href} onClick={(e) => e.stopPropagation()}>
          {projectTitle(project.brief)}
        </a>
        <span className="table__sub">{project.project_id}</span>
      </td>
      <td>
        <Pill tone="accent">{project.orchestration_pattern}</Pill>
      </td>
      <td className="table__num">{project.agent_count}</td>
      <td>
        {project.compiled ? (
          <Pill tone="success" dot>
            Ready to run
          </Pill>
        ) : (
          <Pill dot>Not compiled</Pill>
        )}
      </td>
      <td className="muted" title={fullDate(project.updated_at)} style={{ whiteSpace: "nowrap" }}>
        {timeAgo(project.updated_at)}
      </td>
    </tr>
  );
}

export function ProjectsPage({ projects, error, onRetry }) {
  const count = projects?.length ?? 0;

  return (
    <div className="page">
      <PageHeader
        title="Projects"
        subtitle="Every agent team you've planned. Open one to review its plan, compile it, or run it."
        actions={
          <LinkButton variant="primary" href={paths.newProject}>
            <Icon name="plus" />
            New project
          </LinkButton>
        }
      />

      {error ? (
        <Panel>
          <ErrorCallout error={error} />
          <div style={{ marginTop: 12 }}>
            <Button onClick={onRetry}>Try again</Button>
          </div>
        </Panel>
      ) : projects === null ? (
        <Panel>
          <Empty>Loading projects…</Empty>
        </Panel>
      ) : count === 0 ? (
        <Panel>
          <Empty
            title="No projects yet"
            action={
              <LinkButton variant="primary" href={paths.newProject}>
                <Icon name="plus" />
                New project
              </LinkButton>
            }
          >
            Describe a task in plain language and the planner will design an agent team for it.
          </Empty>
        </Panel>
      ) : (
        <Panel flush>
          <table className="table">
            <thead>
              <tr>
                <th>Project</th>
                <th>Pattern</th>
                <th>Agents</th>
                <th>Status</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => (
                <ProjectRow key={project.project_id} project={project} />
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </div>
  );
}
