import { useCallback, useEffect, useState } from "react";
import { UploadArea } from "../../components/KnowledgeUpload.jsx";
import { Icon } from "../../components/icons.jsx";
import {
  Button,
  Callout,
  Empty,
  ErrorCallout,
  Panel,
  Pill,
  Skeleton,
  StatusBadge,
} from "../../components/ui.jsx";
import { api } from "../../lib/api.js";
import { timeAgo } from "../../lib/format.js";
import {
  ACCESS_REQUEST,
  batches,
  checkFiles,
  documentBadge,
  formatBytes,
  isIndexing,
  providerName,
} from "../../lib/knowledge.js";
import { paths } from "../../lib/router.js";
import { useAction } from "../../lib/useAction.js";

const POLL_MS = 2000;

function DocumentRow({ doc, onDetach }) {
  const { badge, label } = documentBadge(doc.status);
  return (
    <li className="doclist__item">
      <Icon name="file" size={18} />
      <div className="doclist__main">
        <div className="doclist__name" title={doc.filename}>
          {doc.filename}
        </div>
        <div className="doclist__meta">
          {formatBytes(doc.size_bytes)}
          {doc.status === "ready" &&
            ` · ${doc.chunk_count} passage${doc.chunk_count === 1 ? "" : "s"}`}
          {doc.created_at && ` · added ${timeAgo(doc.created_at)}`}
        </div>
        {doc.status === "failed" && doc.error && (
          <div className="doclist__error">{doc.error}</div>
        )}
      </div>
      <StatusBadge status={badge} label={label} />
      <button
        type="button"
        className="iconbtn"
        onClick={() => onDetach(doc)}
        aria-label={`Detach ${doc.filename} from this project`}
        title="Detach — it stays in your library"
      >
        <Icon name="close" />
      </button>
    </li>
  );
}

function EmbeddingNote({ knowledge }) {
  const { embedding } = knowledge;
  return (
    <Panel title="Embedding model">
      <p className="muted">
        {embedding ? (
          <>
            New files are indexed with{" "}
            <strong>{providerName(embedding.provider)}</strong> ·{" "}
            <span className="mono">{embedding.model}</span>. Each file keeps the
            model it was indexed with, and search asks every model in use.
          </>
        ) : (
          "Chosen when you add your first file."
        )}{" "}
        <a href={paths.knowledge}>
          Change the default, or one file&apos;s model, on the Knowledge page
        </a>
        .
      </p>
    </Panel>
  );
}

function LibraryPanel({ knowledge, onAttach, attaching }) {
  const { available } = knowledge;
  if (available.length === 0) return null;
  return (
    <Panel
      title="Add from your library"
      subtitle={`${available.length} file${available.length === 1 ? "" : "s"} not attached here`}
      flush
    >
      <ul className="doclist">
        {available.map((doc) => {
          const { badge, label } = documentBadge(doc.status);
          return (
            <li key={doc.id} className="doclist__item">
              <Icon name="file" size={18} />
              <div className="doclist__main">
                <div className="doclist__name" title={doc.filename}>
                  {doc.filename}
                </div>
                <div className="doclist__meta">
                  {formatBytes(doc.size_bytes)}
                  {doc.status === "ready" &&
                    ` · ${doc.chunk_count} passage${doc.chunk_count === 1 ? "" : "s"}`}
                  {doc.project_ids.length > 0 &&
                    ` · in ${doc.project_ids.length} other project${doc.project_ids.length === 1 ? "" : "s"}`}
                </div>
              </div>
              <StatusBadge status={badge} label={label} />
              <Button
                size="sm"
                onClick={() => onAttach(doc)}
                loading={attaching === doc.id}
                disabled={Boolean(attaching)}
                aria-label={`Attach ${doc.filename}`}
              >
                Attach
              </Button>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function AccessPanel({ project, knowledge, onRevised, onReload }) {
  const ask = useAction();
  const [reply, setReply] = useState(null);
  const ready = knowledge.documents.some((d) => d.status === "ready");
  const users = knowledge.used_by;

  async function giveAccess() {
    const res = await ask.run(() =>
      api.reviseProject(project.project_id, ACCESS_REQUEST),
    );
    if (res) {
      setReply(res.reply.content);
      onRevised(res.project);
      onReload(); // which agents use the files now
    }
  }

  return (
    <Panel title="Agent access">
      {users.length > 0 ? (
        <div className="stack">
          <p>
            {users.length === 1 ? "This agent searches" : "These agents search"}{" "}
            the files with <code>knowledge_search</code>:
          </p>
          <div className="chips">
            {users.map((id) => (
              <Pill key={id} tone="accent">
                {id}
              </Pill>
            ))}
          </div>
          <p className="muted">
            New files are searchable as soon as they&apos;re ready — no
            recompiling.
          </p>
        </div>
      ) : (
        <div className="stack">
          <Callout
            tone={ready ? "warn" : undefined}
            title="Agents can't use these files yet"
          >
            {ready
              ? "No agent has the knowledge_search tool. Ask the assistant to give it to the agents that need facts from your files."
              : "Once a file is ready, the assistant can give agents the knowledge_search tool."}
          </Callout>
          <div className="row">
            <Button
              variant="primary"
              onClick={giveAccess}
              loading={ask.busy}
              disabled={!ready}
            >
              {!ask.busy && <Icon name="chat" size={14} />}
              Give agents access
            </Button>
          </div>
        </div>
      )}
      {reply && (
        <div className="assistant-note" role="status">
          <span className="assistant-note__label">Assistant</span>
          {reply}
        </div>
      )}
      <ErrorCallout error={ask.error} />
    </Panel>
  );
}

function SearchPanel({ project, knowledge }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const search = useAction();
  const ready = knowledge.documents.some((d) => d.status === "ready");

  async function submit(event) {
    event.preventDefault();
    if (!query.trim()) return;
    const res = await search.run(() =>
      api.searchKnowledge(project.project_id, query.trim(), 3),
    );
    if (res) setResults(res.results);
  }

  return (
    <Panel title="Test search" subtitle="What an agent would find.">
      <form className="searchrow" onSubmit={submit}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            ready ? "Ask something your files answer" : "Add a file first"
          }
          aria-label="Search the knowledge base"
          disabled={!ready}
          maxLength={1000}
        />
        <Button
          type="submit"
          loading={search.busy}
          disabled={!ready || !query.trim()}
        >
          Search
        </Button>
      </form>
      <ErrorCallout error={search.error} />
      {results && results.length === 0 && (
        <p className="muted">No matching passages.</p>
      )}
      {results && results.length > 0 && (
        <ol className="hits">
          {results.map((hit, i) => (
            <li key={i} className="hit">
              <div className="hit__cite">
                <span className="hit__file">{hit.filename}</span>
                <span className="muted"> — {hit.source}</span>
                <span className="hit__score mono">{hit.score.toFixed(2)}</span>
              </div>
              <p className="hit__text" tabIndex={0}>
                {hit.text}
              </p>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

/** The Resources step's Documents tab: files attached to the project. */
export function KnowledgeStep({ project, onKnowledgeChanged, onRevised }) {
  const id = project.project_id;
  const [knowledge, setKnowledge] = useState(null);
  const [problems, setProblems] = useState([]);
  const load = useAction();
  const upload = useAction();
  const detach = useAction();
  const attach = useAction();
  const [attaching, setAttaching] = useState(null);
  const { run: runLoad } = load;

  const loaded = useCallback(
    (body) => {
      setKnowledge(body);
      onKnowledgeChanged({
        documents: body.documents.length,
        ready: body.documents.filter((d) => d.status === "ready").length,
        embedding: body.embedding,
      });
    },
    [onKnowledgeChanged],
  );

  useEffect(() => {
    runLoad(() => api.getKnowledge(id)).then((body) => body && loaded(body));
  }, [id, runLoad, loaded]);

  // While files are being indexed, poll until every one is ready or failed.
  const indexing = knowledge ? isIndexing(knowledge.documents) : false;
  useEffect(() => {
    if (!indexing) return undefined;
    const timer = setInterval(async () => {
      try {
        loaded(await api.getKnowledge(id));
      } catch {
        // A missed poll is retried on the next tick.
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [indexing, id, loaded]);

  async function addFiles(files) {
    // Names must be unique across the whole library, not just this project.
    const { accepted, problems: refused } = checkFiles(
      files,
      knowledge.limits,
      [...knowledge.documents, ...knowledge.available].map((d) => d.filename),
    );
    setProblems(refused);
    if (accepted.length === 0) return;
    await upload.run(async () => {
      for (const batch of batches(
        accepted,
        knowledge.limits.max_files_per_upload,
      )) {
        await api.uploadDocuments(id, batch);
      }
    });
    const body = await runLoad(() => api.getKnowledge(id));
    if (body) loaded(body);
  }

  const reload = useCallback(async () => {
    const body = await runLoad(() => api.getKnowledge(id));
    if (body) loaded(body);
  }, [id, runLoad, loaded]);

  async function detachDocument(doc) {
    const res = await detach.run(() => api.detachDocument(id, doc.id));
    if (res) await reload();
  }

  async function attachDocument(doc) {
    setAttaching(doc.id);
    const res = await attach.run(() => api.attachDocument(id, doc.id));
    setAttaching(null);
    if (res) await reload();
  }

  if (!knowledge) {
    return (
      <Panel>
        {load.error ? (
          <ErrorCallout error={load.error} />
        ) : (
          <Skeleton lines={4} />
        )}
      </Panel>
    );
  }

  const { documents, embedding } = knowledge;
  const provider =
    embedding?.provider ??
    knowledge.embedding_options.find((o) => o.available)?.provider;

  // The Resources step provides the page, its tabs and the action bar.
  return (
    <div className="split">
      <div className="stack">
        <Panel
          title="Knowledge for this project"
          subtitle="This project's agents search only the files attached here. New files also go into your library."
        >
          <div className="stack">
            <Callout tone="info" title="Where your files go">
              Text from your files, and the questions agents search with, are
              sent to{" "}
              <strong>
                {provider ? providerName(provider) : "the embedding provider"}
              </strong>{" "}
              to index and search them. The files themselves aren&apos;t kept —
              only the text passages taken from them.
            </Callout>
            <UploadArea
              limits={knowledge.limits}
              onFiles={addFiles}
              uploading={upload.busy}
            />
            {problems.length > 0 && (
              <Callout tone="warn" title="Some files weren't added">
                <ul className="steps-list">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </Callout>
            )}
            <ErrorCallout
              error={upload.error || detach.error || attach.error}
            />
          </div>
        </Panel>

        <Panel
          title="Attached files"
          subtitle={
            documents.length > 0
              ? `${documents.length} file${documents.length === 1 ? "" : "s"} · ${knowledge.passages} passages`
              : undefined
          }
          flush
        >
          {documents.length === 0 ? (
            <div className="panel__body">
              <Empty title="No files attached">
                Optional. Attach files from your library or add new ones when
                this project&apos;s agents need facts that only your documents
                have.
              </Empty>
            </div>
          ) : (
            <ul className="doclist" aria-live="polite">
              {documents.map((doc) => (
                <DocumentRow key={doc.id} doc={doc} onDetach={detachDocument} />
              ))}
            </ul>
          )}
        </Panel>

        <LibraryPanel
          knowledge={knowledge}
          onAttach={attachDocument}
          attaching={attaching}
        />
      </div>

      <aside className="split__aside stack">
        <AccessPanel
          project={project}
          knowledge={knowledge}
          onRevised={onRevised}
          onReload={reload}
        />
        <SearchPanel project={project} knowledge={knowledge} />
        <EmbeddingNote knowledge={knowledge} />
      </aside>
    </div>
  );
}
