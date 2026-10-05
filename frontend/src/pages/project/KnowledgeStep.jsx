import { useCallback, useEffect, useState } from "react";
import { UploadArea } from "../../components/KnowledgeUpload.jsx";
import { Icon } from "../../components/icons.jsx";
import {
  ActionBar,
  Button,
  Callout,
  DeleteButton,
  Empty,
  ErrorCallout,
  Field,
  LinkButton,
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

function DocumentRow({ doc, onDelete }) {
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
          {doc.status === "ready" && ` · ${doc.chunk_count} passage${doc.chunk_count === 1 ? "" : "s"}`}
          {doc.created_at && ` · added ${timeAgo(doc.created_at)}`}
        </div>
        {doc.status === "failed" && doc.error && <div className="doclist__error">{doc.error}</div>}
      </div>
      <StatusBadge status={badge} label={label} />
      <DeleteButton name={doc.filename} onDelete={() => onDelete(doc)} />
    </li>
  );
}

function EmbeddingPanel({ project, knowledge, onChanged }) {
  const current = knowledge.embedding;
  const [choice, setChoice] = useState(current?.provider ?? "");
  const save = useAction();
  const options = knowledge.embedding_options;
  const changed = current && choice && choice !== current.provider;
  const busy = isIndexing(knowledge.documents);

  async function apply() {
    const option = options.find((o) => o.provider === choice);
    const res = await save.run(() => api.setEmbedding(project.project_id, option));
    if (res) onChanged(res);
  }

  return (
    <Panel title="Embedding model">
      {current ? (
        <div className="stack">
          <Field
            label="Model used to index and search these files"
            hint="Every file is indexed with one model. Changing it re-indexes all of them; nothing needs uploading again."
          >
            <select value={choice} onChange={(e) => setChoice(e.target.value)} disabled={save.busy}>
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
              <Button variant="primary" onClick={apply} loading={save.busy} disabled={busy}>
                Re-index with {providerName(choice)}
              </Button>
              <Button onClick={() => setChoice(current.provider)} disabled={save.busy}>
                Cancel
              </Button>
            </div>
          )}
          {changed && busy && <p className="muted">Wait for indexing to finish before switching.</p>}
          <ErrorCallout error={save.error} />
        </div>
      ) : (
        <p className="muted">
          Chosen when you add the first file: the embedding model of your agents&apos; provider if it
          has one (Gemini or OpenAI), otherwise the first one this server has a key for.
        </p>
      )}
    </Panel>
  );
}

function AccessPanel({ project, knowledge, onRevised, onReload }) {
  const ask = useAction();
  const [reply, setReply] = useState(null);
  const ready = knowledge.documents.some((d) => d.status === "ready");
  const users = knowledge.used_by;

  async function giveAccess() {
    const res = await ask.run(() => api.reviseProject(project.project_id, ACCESS_REQUEST));
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
            {users.length === 1 ? "This agent searches" : "These agents search"} the files with{" "}
            <code>knowledge_search</code>:
          </p>
          <div className="chips">
            {users.map((id) => (
              <Pill key={id} tone="accent">
                {id}
              </Pill>
            ))}
          </div>
          <p className="muted">New files are searchable as soon as they&apos;re ready — no recompiling.</p>
        </div>
      ) : (
        <div className="stack">
          <Callout tone={ready ? "warn" : undefined} title="Agents can't use these files yet">
            {ready
              ? "No agent has the knowledge_search tool. Ask the assistant to give it to the agents that need facts from your files."
              : "Once a file is ready, the assistant can give agents the knowledge_search tool."}
          </Callout>
          <div className="row">
            <Button variant="primary" onClick={giveAccess} loading={ask.busy} disabled={!ready}>
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
    const res = await search.run(() => api.searchKnowledge(project.project_id, query.trim(), 3));
    if (res) setResults(res.results);
  }

  return (
    <Panel title="Test search" subtitle="What an agent would find.">
      <form className="searchrow" onSubmit={submit}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={ready ? "Ask something your files answer" : "Add a file first"}
          aria-label="Search the knowledge base"
          disabled={!ready}
          maxLength={1000}
        />
        <Button type="submit" loading={search.busy} disabled={!ready || !query.trim()}>
          Search
        </Button>
      </form>
      <ErrorCallout error={search.error} />
      {results && results.length === 0 && <p className="muted">No matching passages.</p>}
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

export function KnowledgeStep({ project, onKnowledgeChanged, onRevised }) {
  const id = project.project_id;
  const [knowledge, setKnowledge] = useState(null);
  const [problems, setProblems] = useState([]);
  const load = useAction();
  const upload = useAction();
  const remove = useAction();
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
    const { accepted, problems: refused } = checkFiles(
      files,
      knowledge.limits,
      knowledge.documents.map((d) => d.filename),
    );
    setProblems(refused);
    if (accepted.length === 0) return;
    await upload.run(async () => {
      for (const batch of batches(accepted, knowledge.limits.max_files_per_upload)) {
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

  async function deleteDocument(doc) {
    const res = await remove.run(() => api.deleteDocument(id, doc.id));
    if (!res) return false;
    const body = await runLoad(() => api.getKnowledge(id));
    if (body) loaded(body);
    return true;
  }

  if (!knowledge) {
    return (
      <div className="page">
        <Panel>{load.error ? <ErrorCallout error={load.error} /> : <Skeleton lines={4} />}</Panel>
      </div>
    );
  }

  const { documents, embedding } = knowledge;
  const provider = embedding?.provider ?? knowledge.embedding_options.find((o) => o.available)?.provider;

  return (
    <>
      <div className="page">
        <div className="split">
          <div className="stack">
            <Panel
              title="Knowledge base"
              subtitle="Documents this project's agents can search and cite."
            >
              <div className="stack">
                <Callout tone="info" title="Where your files go">
                  Text from your files, and the questions agents search with, are sent to{" "}
                  <strong>{provider ? providerName(provider) : "the embedding provider"}</strong> to
                  index and search them. The files themselves aren&apos;t kept — only the text
                  passages taken from them.
                </Callout>
                <UploadArea limits={knowledge.limits} onFiles={addFiles} uploading={upload.busy} />
                {problems.length > 0 && (
                  <Callout tone="warn" title="Some files weren't added">
                    <ul className="steps-list">
                      {problems.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  </Callout>
                )}
                <ErrorCallout error={upload.error || remove.error} />
              </div>
            </Panel>

            <Panel
              title="Files"
              subtitle={
                documents.length > 0
                  ? `${documents.length} file${documents.length === 1 ? "" : "s"} · ${knowledge.passages} passages`
                  : undefined
              }
              flush
            >
              {documents.length === 0 ? (
                <div className="panel__body">
                  <Empty title="No files yet">
                    A knowledge base is optional. Add files when your agents need facts that only
                    your documents have.
                  </Empty>
                </div>
              ) : (
                <ul className="doclist" aria-live="polite">
                  {documents.map((doc) => (
                    <DocumentRow key={doc.id} doc={doc} onDelete={deleteDocument} />
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <aside className="split__aside stack">
            <AccessPanel project={project} knowledge={knowledge} onRevised={onRevised} onReload={reload} />
            <SearchPanel project={project} knowledge={knowledge} />
            <EmbeddingPanel
              key={embedding?.provider ?? "none"}
              project={project}
              knowledge={knowledge}
              onChanged={loaded}
            />
          </aside>
        </div>
      </div>

      <ActionBar note="Optional: agents only see these files through the knowledge_search tool.">
        <LinkButton href={paths.project(id, "brief")}>
          <Icon name="arrowLeft" />
          Brief
        </LinkButton>
        <LinkButton variant="primary" href={paths.project(id, "plan")}>
          Review plan
          <Icon name="arrowRight" />
        </LinkButton>
      </ActionBar>
    </>
  );
}
