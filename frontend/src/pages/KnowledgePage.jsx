import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { UploadArea } from "../components/KnowledgeUpload.jsx";
import { Icon } from "../components/icons.jsx";
import {
  Button,
  Callout,
  DeleteButton,
  Empty,
  ErrorCallout,
  Field,
  PageHeader,
  Panel,
  Pill,
  Skeleton,
  StatusBadge,
} from "../components/ui.jsx";
import { api } from "../lib/api.js";
import { fullDate, projectTitle, timeAgo } from "../lib/format.js";
import {
  NO_PROJECT,
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
const ATTACH_KEY = "agentic-platform.knowledge-attach-to";

function readSaved() {
  try {
    return localStorage.getItem(ATTACH_KEY) ?? "";
  } catch {
    return "";
  }
}

function save(value) {
  try {
    localStorage.setItem(ATTACH_KEY, value);
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

/** Which projects a file is attached to: links, plus a checklist to change them. */
function ProjectAttachments({ doc, projects, projectsById, onChange }) {
  const [open, setOpen] = useState(false);
  // The ticked projects while a change is being saved, so a click shows at once.
  const [pending, setPending] = useState(null);
  const panelId = useId();
  const wrapRef = useRef(null);
  const attached = doc.project_ids.map((id) => projectsById[id]).filter(Boolean);

  // Close the checklist on Escape or a click elsewhere.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    const onClick = (e) => wrapRef.current && !wrapRef.current.contains(e.target) && setOpen(false);
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  async function toggle(projectId, checked) {
    const current = pending ?? doc.project_ids;
    const next = checked ? [...current, projectId] : current.filter((id) => id !== projectId);
    setPending(next);
    await onChange(doc, next);
    setPending(null);
  }

  const ticked = pending ?? doc.project_ids;

  return (
    <div className="kattach" ref={wrapRef}>
      <div className="kattach__list">
        {attached.length === 0 && <span className="muted">Library only</span>}
        {attached.map((p) => (
          <span key={p.project_id} className="kattach__item">
            <a className="kproject" href={paths.project(p.project_id, "knowledge")}>
              {projectTitle(p.brief, 60)}
            </a>
            {p.ready > 0 && p.used_by.length === 0 && (
              <a href={paths.project(p.project_id, "knowledge")} className="kproject__hint">
                <Pill tone="warn">Agents can&apos;t use yet</Pill>
              </a>
            )}
          </span>
        ))}
      </div>
      {projects.length > 0 && (
        <button
          type="button"
          className="kattach__toggle"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={`Projects for ${doc.filename}`}
          onClick={() => setOpen((o) => !o)}
        >
          <Icon name="edit" size={13} />
          {attached.length === 0 ? "Attach" : "Change"}
        </button>
      )}
      {open && (
        <fieldset id={panelId} className="kattach__panel" disabled={pending !== null}>
          <legend className="kattach__legend">Attach {doc.filename} to</legend>
          {projects.map((p) => (
            <label key={p.project_id} className="kattach__option">
              <input
                type="checkbox"
                checked={ticked.includes(p.project_id)}
                onChange={(e) => toggle(p.project_id, e.target.checked)}
              />
              <span>{projectTitle(p.brief, 48)}</span>
            </label>
          ))}
        </fieldset>
      )}
    </div>
  );
}

function FileRow({ doc, projects, projectsById, onDelete, onAttachmentsChange }) {
  const { badge, label } = documentBadge(doc.status);
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
        <ProjectAttachments
          doc={doc}
          projects={projects}
          projectsById={projectsById}
          onChange={onAttachmentsChange}
        />
      </td>
      <td className="table__num">{doc.status === "ready" ? doc.chunk_count : "—"}</td>
      <td>
        <StatusBadge status={badge} label={label} />
      </td>
      <td className="kcol-actions">
        <DeleteButton
          name={doc.filename}
          prompt={doc.project_ids.length ? "Delete from library and all projects?" : "Delete from library?"}
          onDelete={() => onDelete(doc)}
        />
      </td>
    </tr>
  );
}

function AddFilesPanel({ library, onUploaded }) {
  const { projects, documents, limits, embedding, embedding_options: options } = library;
  const [attachTo, setAttachTo] = useState(() => {
    const saved = readSaved();
    return projects.some((p) => p.project_id === saved) ? saved : "";
  });
  const [problems, setProblems] = useState([]);
  const upload = useAction();
  const provider = embedding?.provider ?? options.find((o) => o.available)?.provider;

  function choose(value) {
    setAttachTo(value);
    save(value);
  }

  async function addFiles(files) {
    const { accepted, problems: refused } = checkFiles(
      files,
      limits,
      documents.map((d) => d.filename),
    );
    setProblems(refused);
    if (accepted.length === 0) return;
    const done = await upload.run(async () => {
      for (const batch of batches(accepted, limits.max_files_per_upload)) {
        if (attachTo) await api.uploadDocuments(attachTo, batch);
        else await api.uploadToLibrary(batch);
      }
      return true;
    });
    if (done) onUploaded();
  }

  return (
    <Panel title="Add files">
      <div className="stack">
        <Field label="Attach to" hint="Optional. You can attach files to projects any time from the table.">
          <select value={attachTo} onChange={(e) => choose(e.target.value)} disabled={upload.busy}>
            <option value="">No project — library only</option>
            {projects.map((p) => (
              <option key={p.project_id} value={p.project_id}>
                {projectTitle(p.brief, 60)}
              </option>
            ))}
          </select>
        </Field>
        <Callout tone="info" title="Where your files go">
          Text from your files, and the questions agents search with, are sent to{" "}
          <strong>{provider ? providerName(provider) : "the embedding provider"}</strong>. The files
          themselves aren&apos;t kept — only the text passages taken from them.
        </Callout>
        <UploadArea limits={limits} onFiles={addFiles} uploading={upload.busy} />
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

function EmbeddingPanel({ library, onChanged }) {
  const current = library.embedding;
  const options = library.embedding_options;
  const [choice, setChoice] = useState(current?.provider ?? "");
  const change = useAction();
  const changed = current && choice && choice !== current.provider;
  const busy = isIndexing(library.documents);

  async function apply() {
    const option = options.find((o) => o.provider === choice);
    const res = await change.run(() => api.setLibraryEmbedding(option));
    if (res) onChanged(res);
  }

  return (
    <Panel title="Embedding model">
      {current ? (
        <div className="stack">
          <Field
            label="Indexes and searches every file in your library"
            hint="One model for the whole library, whatever model a project's agents use. Changing it re-indexes every file; nothing needs uploading again."
          >
            <select value={choice} onChange={(e) => setChoice(e.target.value)} disabled={change.busy}>
              {options.map((o) => (
                <option key={o.provider} value={o.provider} disabled={!o.available}>
                  {providerName(o.provider)} · {o.model}
                  {o.available ? "" : " (no API key)"}
                </option>
              ))}
            </select>
          </Field>
          {changed && (
            <div className="row">
              <Button variant="primary" onClick={apply} loading={change.busy} disabled={busy}>
                Re-index with {providerName(choice)}
              </Button>
              <Button onClick={() => setChoice(current.provider)} disabled={change.busy}>
                Cancel
              </Button>
            </div>
          )}
          {changed && busy && <p className="muted">Wait for indexing to finish before switching.</p>}
          <ErrorCallout error={change.error} />
        </div>
      ) : (
        <p className="muted">
          Chosen when you add your first file: Gemini&apos;s embedding model if this server has a
          Gemini key, otherwise OpenAI&apos;s.
        </p>
      )}
    </Panel>
  );
}

/** The user's knowledge library: every file, which projects use it, add and delete. */
export function KnowledgePage({ onCountChanged }) {
  const [library, setLibrary] = useState(null);
  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [status, setStatus] = useState("all");
  const load = useAction();
  const remove = useAction();
  const attach = useAction();
  const { run: runLoad } = load;

  const loaded = useCallback(
    (body) => {
      setLibrary(body);
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
  const indexing = library ? isIndexing(library.documents) : false;
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
    () => Object.fromEntries((library?.projects ?? []).map((p) => [p.project_id, p])),
    [library],
  );
  const visible = useMemo(
    () => filterDocuments(library?.documents ?? [], { query, project: projectFilter, status }),
    [library, query, projectFilter, status],
  );

  async function deleteDocument(doc) {
    const res = await remove.run(() => api.deleteFromLibrary(doc.id));
    if (!res) return false;
    await reload();
    return true;
  }

  async function changeAttachments(doc, projectIds) {
    const res = await attach.run(() => api.setAttachments(doc.id, projectIds));
    if (res) await reload();
  }

  const header = (
    <PageHeader
      title="Knowledge"
      subtitle="Your library of files for agents to search. Upload once, then attach a file to any of your projects — each project's agents search only the files attached to it."
    />
  );

  if (!library) {
    return (
      <div className="page">
        {header}
        <Panel>{load.error ? <ErrorCallout error={load.error} /> : <Skeleton lines={4} />}</Panel>
      </div>
    );
  }

  const totals = knowledgeTotals(library.documents);
  const filtering = query.trim() || projectFilter || status !== "all";

  return (
    <div className="page">
      {header}
      <div className="kstats" aria-label="Library totals">
        <Stat label="Files" value={totals.files} />
        <Stat label="Ready" value={totals.ready} tone="success" />
        <Stat label="Indexing" value={totals.indexing} tone={totals.indexing ? "info" : undefined} />
        <Stat label="Failed" value={totals.failed} tone={totals.failed ? "danger" : undefined} />
        <Stat label="Passages" value={totals.passages} />
      </div>

      <div className="split">
        <div className="kmain">
          <Panel title="Files" subtitle={filtering ? `${visible.length} of ${totals.files}` : undefined} flush>
            {library.documents.length > 0 && (
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
                  <option value="">All files</option>
                  <option value={NO_PROJECT}>Not attached to a project</option>
                  {library.projects
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

            {library.documents.length === 0 ? (
              <div className="panel__body">
                <Empty title="No files yet">
                  Add PDF, Word, text, Markdown or CSV files. They don&apos;t need a project: attach
                  them to projects now or later, and those projects&apos; agents can search them and
                  cite them in their answers.
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
                    <th>Projects</th>
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
                      projects={library.projects}
                      projectsById={projectsById}
                      onDelete={deleteDocument}
                      onAttachmentsChange={changeAttachments}
                    />
                  ))}
                </tbody>
              </table>
            )}
            {(remove.error || attach.error) && (
              <div className="panel__body">
                <ErrorCallout error={remove.error || attach.error} />
              </div>
            )}
          </Panel>
        </div>

        <aside className="split__aside stack">
          <AddFilesPanel library={library} onUploaded={reload} />
          <EmbeddingPanel key={library.embedding?.provider ?? "none"} library={library} onChanged={loaded} />
        </aside>
      </div>
    </div>
  );
}
