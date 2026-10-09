import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { UploadArea } from "../components/KnowledgeUpload.jsx";
import { Icon } from "../components/icons.jsx";
import {
  Button,
  Callout,
  DeleteButton,
  Empty,
  ErrorCallout,
  PageHeader,
  Panel,
  Pill,
  Skeleton,
  StatusBadge,
} from "../components/ui.jsx";
import { api } from "../lib/api.js";
import { fullDate, projectName, timeAgo } from "../lib/format.js";
import {
  NO_PROJECT,
  batches,
  canChangeEmbedding,
  checkFiles,
  documentBadge,
  embeddingKey,
  embeddingLabel,
  extensionOf,
  filterDocuments,
  findEmbedding,
  formatBytes,
  isIndexing,
  knowledgeTotals,
  providerName,
} from "../lib/knowledge.js";
import { paths } from "../lib/router.js";
import { useAction } from "../lib/useAction.js";

const POLL_MS = 2000;
function Stat({ label, value, tone }) {
  return (
    <div
      className={["kstat", tone && `kstat--${tone}`].filter(Boolean).join(" ")}
    >
      <span className="kstat__value">{value}</span>
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
  const attached = doc.project_ids
    .map((id) => projectsById[id])
    .filter(Boolean);

  // Close the checklist on Escape or a click elsewhere.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    const onClick = (e) =>
      wrapRef.current && !wrapRef.current.contains(e.target) && setOpen(false);
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  async function toggle(projectId, checked) {
    const current = pending ?? doc.project_ids;
    const next = checked
      ? [...current, projectId]
      : current.filter((id) => id !== projectId);
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
            <a
              className="kproject"
              href={paths.project(p.project_id, "resources", "documents")}
            >
              {projectName(p, 60)}
            </a>
            {p.ready > 0 && p.used_by.length === 0 && (
              <a
                href={paths.project(p.project_id, "resources", "documents")}
                className="kproject__hint"
              >
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
        <fieldset
          id={panelId}
          className="kattach__panel"
          disabled={pending !== null}
        >
          <legend className="kattach__legend">Attach {doc.filename} to</legend>
          {projects.map((p) => (
            <label key={p.project_id} className="kattach__option">
              <input
                type="checkbox"
                checked={ticked.includes(p.project_id)}
                onChange={(e) => toggle(p.project_id, e.target.checked)}
              />
              <span>{projectName(p, 48)}</span>
            </label>
          ))}
        </fieldset>
      )}
    </div>
  );
}

/**
 * A file's embedding model. Picking another one asks first, in the row, because
 * re-indexing sends all of the file's text to that model again.
 */
function FileEmbedding({ doc, options, onChange }) {
  const [choice, setChoice] = useState(null);
  const change = useAction();
  const current = embeddingKey(doc.embedding);
  const chosen = choice ? findEmbedding(options, choice) : null;
  const locked = !canChangeEmbedding(doc);

  async function confirm() {
    const done = await change.run(() => onChange(doc, chosen));
    if (done) setChoice(null);
  }

  if (!doc.embedding) return <span className="muted">—</span>;
  return (
    <div className="kmodel">
      <select
        aria-label={`Embedding model for ${doc.filename}`}
        value={choice ?? current}
        disabled={locked || change.busy}
        title={
          locked && doc.status === "failed"
            ? "Nothing to re-index: upload the file again"
            : embeddingLabel(doc.embedding)
        }
        onChange={(e) =>
          setChoice(e.target.value === current ? null : e.target.value)
        }
      >
        {!findEmbedding(options, current) && (
          <option value={current}>{embeddingLabel(doc.embedding)}</option>
        )}
        {options.map((o) => (
          <option
            key={embeddingKey(o)}
            value={embeddingKey(o)}
            disabled={!o.available && embeddingKey(o) !== current}
          >
            {embeddingLabel(o)}
            {o.available ? "" : " (no API key)"}
          </option>
        ))}
      </select>
      {chosen && (
        <span
          className="row kmodel__confirm"
          role="group"
          aria-label={`Confirm re-indexing ${doc.filename}`}
        >
          <span className="kmodel__prompt">
            Re-index with {providerName(chosen.provider)}? Its text is embedded
            again.
          </span>
          <Button
            size="sm"
            variant="primary"
            onClick={confirm}
            loading={change.busy}
          >
            Re-index
          </Button>
          <Button
            size="sm"
            onClick={() => setChoice(null)}
            disabled={change.busy}
          >
            Cancel
          </Button>
        </span>
      )}
      <ErrorCallout error={change.error} />
    </div>
  );
}

function FileRow({
  doc,
  projects,
  projectsById,
  embeddingOptions,
  onDelete,
  onAttachmentsChange,
  onEmbeddingChange,
}) {
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
              {extensionOf(doc.filename).slice(1).toUpperCase()} ·{" "}
              {formatBytes(doc.size_bytes)} · added {timeAgo(doc.created_at)}
            </span>
            {doc.status === "failed" && doc.error && (
              <span className="doclist__error">{doc.error}</span>
            )}
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
      <td>
        <FileEmbedding
          doc={doc}
          options={embeddingOptions}
          onChange={onEmbeddingChange}
        />
      </td>
      <td className="table__num">
        {doc.status === "ready" ? doc.chunk_count : "—"}
      </td>
      <td>
        <StatusBadge status={badge} label={label} />
      </td>
      <td className="kcol-actions">
        <DeleteButton
          name={doc.filename}
          prompt={
            doc.project_ids.length
              ? "Delete from library and all projects?"
              : "Delete from library?"
          }
          onDelete={() => onDelete(doc)}
        />
      </td>
    </tr>
  );
}

/** The centred upload area. Files go to the library; attach them to projects from their rows. */
function AddFiles({ library, onUploaded }) {
  const {
    documents,
    limits,
    default_embedding: current,
    embedding_options: options,
  } = library;
  const [problems, setProblems] = useState([]);
  const upload = useAction();
  const provider =
    current?.provider ?? options.find((o) => o.available)?.provider;

  async function addFiles(files) {
    const { accepted, problems: refused } = checkFiles(
      files,
      limits,
      documents.map((d) => d.filename),
    );
    setProblems(refused);
    if (accepted.length === 0) return;
    const done = await upload.run(async () => {
      for (const batch of batches(accepted, limits.max_files_per_upload))
        await api.uploadToLibrary(batch);
      return true;
    });
    if (done) onUploaded();
  }

  return (
    <section className="kadd" aria-label="Add files">
      <div className="kadd__inner stack">
        <UploadArea
          limits={limits}
          onFiles={addFiles}
          uploading={upload.busy}
        />
        <p className="kadd__note">
          Text from your files, and the questions agents search with, are sent
          to each file&apos;s embedding provider
          {provider ? ` (new files: ${providerName(provider)})` : ""}. The files
          themselves aren&apos;t kept — only the text passages taken from them.
        </p>
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
    </section>
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
    () =>
      Object.fromEntries(
        (library?.projects ?? []).map((p) => [p.project_id, p]),
      ),
    [library],
  );
  const visible = useMemo(
    () =>
      filterDocuments(library?.documents ?? [], {
        query,
        project: projectFilter,
        status,
      }),
    [library, query, projectFilter, status],
  );

  async function deleteDocument(doc) {
    const res = await remove.run(() => api.deleteFromLibrary(doc.id));
    if (!res) return false;
    await reload();
    return true;
  }

  async function changeEmbedding(doc, option) {
    const res = await api.setDocumentEmbedding(doc.id, option);
    await reload();
    return res;
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
        <Panel>
          {load.error ? (
            <ErrorCallout error={load.error} />
          ) : (
            <Skeleton lines={4} />
          )}
        </Panel>
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
        <Stat
          label="Indexing"
          value={totals.indexing}
          tone={totals.indexing ? "info" : undefined}
        />
        <Stat
          label="Failed"
          value={totals.failed}
          tone={totals.failed ? "danger" : undefined}
        />
        <Stat label="Passages" value={totals.passages} />
      </div>

      <AddFiles library={library} onUploaded={reload} />

      <div className="kmain">
        <Panel
          title="Files"
          subtitle={
            filtering ? `${visible.length} of ${totals.files}` : undefined
          }
          flush
        >
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
                      {projectName(p, 40)}
                    </option>
                  ))}
              </select>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                aria-label="Filter by status"
              >
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
                Add PDF, Word, text, Markdown or CSV files. They don&apos;t need
                a project: attach them to projects now or later, and those
                projects&apos; agents can search them and cite them in their
                answers.
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
                  <th>Embedding model</th>
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
                    embeddingOptions={library.embedding_options}
                    onDelete={deleteDocument}
                    onAttachmentsChange={changeAttachments}
                    onEmbeddingChange={changeEmbedding}
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
    </div>
  );
}
