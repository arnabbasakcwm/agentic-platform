import { Icon } from "../components/icons.jsx";
import {
  Button,
  DeleteButton,
  Empty,
  ErrorCallout,
  LinkButton,
  PageHeader,
  Panel,
  Pill,
} from "../components/ui.jsx";
import { api } from "../lib/api.js";
import { ProjectName } from "../components/ProjectName.jsx";
import { fullDate, projectName, timeAgo } from "../lib/format.js";
import { navigate, paths } from "../lib/router.js";
import { useAction } from "../lib/useAction.js";

// A compiled project opens where you'd use it; an uncompiled one where you'd finish it.
function entryPath(project) {
  return paths.project(project.project_id, project.compiled ? "run" : "plan");
}

function ProjectRow({ project, onDelete, onRenamed }) {
  const href = entryPath(project);
  return (
    <tr onClick={() => navigate(href)}>
      <td>
        <ProjectName
          project={project}
          onRenamed={onRenamed}
          renderName={(name) => (
            <a
              className="table__title"
              href={href}
              onClick={(e) => e.stopPropagation()}
            >
              {name}
            </a>
          )}
        />
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
      <td
        className="muted"
        title={fullDate(project.updated_at)}
        style={{ whiteSpace: "nowrap" }}
      >
        {timeAgo(project.updated_at)}
      </td>
      {/* Clicks here mustn't open the project (the row itself is a link). */}
      <td className="table__actions" onClick={(e) => e.stopPropagation()}>
        <DeleteButton
          name={projectName(project, 60)}
          prompt="Delete this project? Its files stay in your library."
          onDelete={() => onDelete(project)}
        />
      </td>
    </tr>
  );
}

export function ProjectsPage({
  projects,
  error,
  onRetry,
  onDeleted,
  onRenamed,
}) {
  const count = projects?.length ?? 0;
  const remove = useAction();

  async function deleteProject(project) {
    const res = await remove.run(() => api.deleteProject(project.project_id));
    if (!res) return false;
    onDeleted(project.project_id);
    return true;
  }

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
            Describe a task in plain language and the planner will design an
            agent team for it.
          </Empty>
        </Panel>
      ) : (
        <Panel flush>
          {remove.error && (
            <div className="panel__body">
              <ErrorCallout error={remove.error} />
            </div>
          )}
          <table className="table">
            <thead>
              <tr>
                <th>Project</th>
                <th>Pattern</th>
                <th>Agents</th>
                <th>Status</th>
                <th>Updated</th>
                <th className="table__actions">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => (
                <ProjectRow
                  key={project.project_id}
                  project={project}
                  onDelete={deleteProject}
                  onRenamed={onRenamed}
                />
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </div>
  );
}
