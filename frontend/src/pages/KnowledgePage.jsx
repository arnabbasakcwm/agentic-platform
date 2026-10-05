import { useCallback, useEffect, useMemo, useState } from "react";
import { DeleteButton, UploadArea } from "../components/KnowledgeUpload.jsx";
import { Icon } from "../components/icons.jsx";
import {
  Button,
  Callout,
  Empty,
  ErrorCallout,
  Field,
  LinkButton,
  PageHeader,
  Panel,
  Pill,
  Skeleton,
  StatusBadge,
} from "../components/ui.jsx";
import { api } from "../lib/api.js";
import { fullDate, projectTitle, timeAgo } from "../lib/format.js";
import {
  batches,
  checkFiles,
  documentBadge,
  extensionOf,
  filterDocuments,
  formatBytes,
  isIndexing,
  knowledgeTotals,
  providerName,
} from "../lib/knowledge.js";
import { paths } from "../lib/router.js";
import { useAction } from "../lib/useAction.js";

const POLL_MS = 2000;
const PROJECT_KEY = "agentic-platform.knowledge-project";

function readSavedProject() {
  try {
    return localStorage.getItem(PROJECT_KEY);
  } catch {
    return null;
  }
}

function saveProject(id) {
  try {
    localStorage.setItem(PROJECT_KEY, id);
  } catch {
    // Not remembered across visits; still works for this one.
  }
}

function Stat({ label, value, tone }) {
  return (
    <div className={["kstat", tone && `kstat--${tone}`].filter(Boolean).join(" ")}>
      <span className="kstat__value mono">{value}</span>
      <span className="kstat__label">{label}</span>
    </div>
  );
}

function FileRow({ doc, project, onDelete }) {
  const { badge, label } = documentBadge(doc.status);
  const knowledgeHref = paths.project(doc.project_id, "knowledge");
  const unused = project && project.ready > 0 && project.used_by.length === 0;
  return (
    <tr>
      <td>
        <div className="kfile">
          <Icon name="file" size={18} />
          <div className="kfile__main">
            <span className="table__title kfile__name" title={doc.filename}>
              {doc.filename}
            </span>
            <span className="table__sub" title={fullDate(doc.created_at)}>
              {extensionOf(doc.filename).slice(1).toUpperCase()} · {formatBytes(doc.size_bytes)} · added{" "}
              {timeAgo(doc.created_at)}
            </span>
            {doc.status === "failed" && doc.error && <span className="doclist__error">{doc.error}</span>}
          </div>
        </div>
      </td>
      <td>
        <a className="kproject" href={knowledgeHref} title="Open this project's Knowledge step">
          {project ? projectTitle(project.brief, 44) : "Project"}
        </a>
        {unused && (
          <a href={knowledgeHref} className="kproject__hint">
            <Pill tone="warn">Agents can&apos;t use yet</Pill>
          </a>
        )}
      </td>
      <td className="table__num">{doc.status === "ready" ? doc.chunk_count : "—"}</td>
      <td>
        <StatusBadge status={badge} label={label} />
      </td>
      <td className="kcol-actions">
        <DeleteButton filename={doc.filename} onDelete={() => onDelete(doc)} />
      </td>
    </tr>
  );
}

function AddFilesPanel({ overview, onUploaded }) {
  const { projects, documents, limits } = overview;
  const [projectId, setProjectId] = useState(() => {
    const saved = readSavedProject();
    return projects.some((p) => p.project_id === saved) ? saved : projects[0]?.project_id ?? "";
  });
  const [problems, setProblems] = useState([]);
  const upload = useAction();
  const project = projects.find((p) => p.project_id === projectId);

  function choose(id) {
    setProjectId(id);
    saveProject(id);
    setProblems([]);
  }

  async function addFiles(files) {
    const existing = documents.filter((d) => d.project_id === projectId).map((d) => d.filename);
    const { accepted, problems: refused } = checkFiles(files, limits, existing);
    setProblems(refused);
    if (accepted.length === 0) return;
    const done = await upload.run(async () => {
      for (const batch of batches(accepted, limits.max_files_per_upload)) {
        await api.uploadDocuments(projectId, batch);
      }
      return true;
    });
    if (done) onUploaded();
  }

  return (
    <Panel title="Add files">
      <div className="stack">
        <Field label="Project" hint="Each file belongs to one project; only that project's agents can search it.">
          <select value={projectId} onChange={(e) => choose(e.target.value)} disabled={upload.busy}>
            {projects.map((p) => (
              <option key={p.project_id} value={p.project_id}>
                {projectTitle(p.brief, 60)}
              </option>
            ))}
          </select>
        </Field>
        <Callout tone="info" title="Where your files go">
          Text from your files, and the questions agents search with, are sent to{" "}
          <strong>
            {project?.embedding
              ? providerName(project.embedding.provider)
              : "the embedding model of the project's provider (Gemini or OpenAI)"}
          </strong>
          . The files themselves aren&apos;t kept — only the text passages taken from them.
        </Callout>
        <UploadArea limits={limits} onFiles={addFiles} uploading={upload.busy} disabled={!project} />
        {problems.length > 0 && (
          <Callout tone="warn" title="Some files weren't added">
            <ul className="steps-list">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Callout>
        )}
        <ErrorCallout error={upload.error} />
      </div>
    </Panel>
  );
}

/** Every knowledge-base file across the user's projects: see, filter, add and delete. */
export function KnowledgePage({ onCountChanged }) {
  const [overview, setOverview] = useState(null);
  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [status, setStatus] = useState("all");
  const load = useAction();
  const remove = useAction();
  const { run: runLoad } = load;

  const loaded = useCallback(
    (body) => {
      setOverview(body);
      onCountChanged?.(body.documents.length);
    },
    [onCountChanged],
  );

  const reload = useCallback(async () => {
    const body = await runLoad(() => api.knowledgeOverview());
    if (body) loaded(body);
  }, [runLoad, loaded]);

  useEffect(() => {
    runLoad(() => api.knowledgeOverview()).then((body) => body && loaded(body));
  }, [runLoad, loaded]);

  // While files are being indexed, poll until every one is ready or failed.
  const indexing = overview ? isIndexing(overview.documents) : false;
  useEffect(() => {
    if (!indexing) return undefined;
    const timer = setInterval(async () => {
      try {
        loaded(await api.knowledgeOverview());
      } catch {
        // A missed poll is retried on the next tick.
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [indexing, loaded]);

  const projectsById = useMemo(
    () => Object.fromEntries((overview?.projects ?? []).map((p) => [p.project_id, p])),
    [overview],
  );
  const visible = useMemo(
    () => filterDocuments(overview?.documents ?? [], { query, project: projectFilter, status }),
    [overview, query, projectFilter, status],
  );

  async function deleteDocument(doc) {
    const res = await remove.run(() => api.deleteDocument(doc.project_id, doc.id));
    if (!res) return false;
    await reload();
    return true;
  }

  const header = (
    <PageHeader
      title="Knowledge"
      subtitle="Files your agents can search, across all your projects. Open a project's Knowledge step to test search or give its agents access."
    />
  );

  if (!overview) {
    return (
      <div className="page">
        {header}
        <Panel>{load.error ? <ErrorCallout error={load.error} /> : <Skeleton lines={4} />}</Panel>
      </div>
    );
  }

  if (overview.projects.length === 0) {
    return (
      <div className="page">
        {header}
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
            Files are added to a project&apos;s knowledge base, so create a project first.
          </Empty>
        </Panel>
      </div>
    );
  }

  const totals = knowledgeTotals(overview.documents);
  const filtering = query.trim() || projectFilter || status !== "all";

  return (
    <div className="page">
      {header}
      <div className="kstats" aria-label="Knowledge base totals">
        <Stat label="Files" value={totals.files} />
        <Stat label="Ready" value={totals.ready} tone="success" />
        <Stat label="Indexing" value={totals.indexing} tone={totals.indexing ? "info" : undefined} />
        <Stat label="Failed" value={totals.failed} tone={totals.failed ? "danger" : undefined} />
        <Stat label="Passages" value={totals.passages} />
      </div>

      <div className="split">
        <div className="kmain">
        <Panel title="Files" subtitle={filtering ? `${visible.length} of ${totals.files}` : undefined} flush>
          {overview.documents.length > 0 && (
            <div className="ktoolbar">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search file names"
                aria-label="Search file names"
              />
              <select
                value={projectFilter}
                onChange={(e) => setProjectFilter(e.target.value)}
                aria-label="Filter by project"
              >
                <option value="">All projects</option>
                {overview.projects
                  .filter((p) => p.documents > 0)
                  .map((p) => (
                    <option key={p.project_id} value={p.project_id}>
                      {projectTitle(p.brief, 40)}
                    </option>
                  ))}
              </select>
              <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
                <option value="all">Any status</option>
                <option value="ready">Ready</option>
                <option value="indexing">Indexing</option>
                <option value="failed">Failed</option>
              </select>
            </div>
          )}

          {overview.documents.length === 0 ? (
            <div className="panel__body">
              <Empty title="No files yet">
                Add PDF, Word, text, Markdown or CSV files to a project so its agents can search them
                and cite them in their answers.
              </Empty>
            </div>
          ) : visible.length === 0 ? (
            <div className="panel__body">
              <Empty
                title="No files match"
                action={
                  <Button
                    onClick={() => {
                      setQuery("");
                      setProjectFilter("");
                      setStatus("all");
                    }}
                  >
                    Clear filters
                  </Button>
                }
              />
            </div>
          ) : (
            <table className="table ktable">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Project</th>
                  <th>Passages</th>
                  <th>Status</th>
                  <th className="kcol-actions">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody aria-live="polite">
                {visible.map((doc) => (
                  <FileRow
                    key={doc.id}
                    doc={doc}
                    project={projectsById[doc.project_id]}
                    onDelete={deleteDocument}
                  />
                ))}
              </tbody>
            </table>
          )}
          {remove.error && (
            <div className="panel__body">
              <ErrorCallout error={remove.error} />
            </div>
          )}
        </Panel>
        </div>

        <aside className="split__aside">
          <AddFilesPanel overview={overview} onUploaded={reload} />
        </aside>
      </div>
    </div>
  );
}
