import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../components/icons.jsx";
import { ModelOptions } from "../components/ModelOptions.jsx";
import { ErrorCallout, LinkButton, Pill, StatusBadge, Switch } from "../components/ui.jsx";
import { api } from "../lib/api.js";
import { batches, checkFiles, documentBadge, formatBytes } from "../lib/knowledge.js";
import { paths } from "../lib/router.js";
import { useAction } from "../lib/useAction.js";

const MIN_AGENTS = 1;
const MAX_AGENTS = 10;
const MAX_COMPOSER_HEIGHT = 220;

// Starting points, not templates: picking one only fills the message box.
const EXAMPLES = [
  {
    label: "Research and summarise",
    brief:
      "Research a topic the user names, draft a short summary of the key findings, then fact-check the summary and correct anything unsupported.",
  },
  {
    label: "Pros, cons, verdict",
    brief:
      "For a decision the user describes, have one agent argue the advantages and another the disadvantages independently, then a third weigh both and give a balanced verdict.",
  },
  {
    label: "Question answering",
    brief:
      "Answer a factual question from the user, doing any arithmetic it needs, then rewrite the answer as one clear sentence.",
  },
];

const PATTERN_PHRASE = {
  sequential: "working one after another",
  parallel: "working in parallel, then combining their results",
  supervisor: "coordinated by a router that decides who acts next",
};

let nextMessageId = 0;

function describeSettings(settings, tools, providers) {
  const parts = [settings.agentCount ? `${settings.agentCount} agents` : "Auto team size"];
  const model = providers.find((p) => `${p.provider}/${p.model}` === settings.model);
  parts.push(model ? model.model : "Default model");
  parts.push(`${settings.tools.length} of ${tools.tools?.length ?? 0} tools`);
  return parts.join(" · ");
}

const filesLabel = (n) => `${n} file${n === 1 ? "" : "s"}`;

// ------------------------------------------------------------------ knowledge tray
/**
 * Pick knowledge files for the next project: upload new ones (they go into the library)
 * or tick existing library files. They're attached when the project is created, and the
 * planner is told about them so it can give agents knowledge_search.
 */
function FilesTray({ selected, onChange, disabled }) {
  const [library, setLibrary] = useState(null);
  const [problems, setProblems] = useState([]);
  const load = useAction();
  const upload = useAction();
  const inputRef = useRef(null);
  const { run: runLoad } = load;

  useEffect(() => {
    runLoad(() => api.knowledgeOverview()).then((body) => body && setLibrary(body));
  }, [runLoad]);

  const ids = new Set(selected.map((d) => d.id));

  function toggle(doc) {
    onChange(ids.has(doc.id) ? selected.filter((d) => d.id !== doc.id) : [...selected, doc]);
  }

  async function addFiles(files) {
    const { accepted, problems: refused } = checkFiles(files, library.limits, library.documents.map((d) => d.filename));
    setProblems(refused);
    if (!accepted.length) return;
    const added = await upload.run(async () => {
      const docs = [];
      for (const batch of batches(accepted, library.limits.max_files_per_upload)) {
        docs.push(...(await api.uploadToLibrary(batch)).documents);
      }
      return docs;
    });
    if (added) {
      onChange([...selected, ...added]);
      setLibrary((lib) => ({ ...lib, documents: [...added, ...lib.documents] }));
    }
  }

  return (
    <div className="tray" id="composer-files">
      <div className="tray__row tray__row--top">
        <span className="tray__label">Knowledge</span>
        <div className="tray__control">
          <div className="row">
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => inputRef.current?.click()}
              disabled={disabled || !library || upload.busy}
            >
              {upload.busy ? <span className="spin" /> : <Icon name="upload" size={13} />}
              Upload files
            </button>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={library?.limits.file_types.join(",")}
              className="sr-only"
              tabIndex={-1}
              aria-label="Upload knowledge files"
              onChange={(e) => {
                if (e.target.files.length) addFiles([...e.target.files]);
                e.target.value = "";
              }}
            />
            <span className="tray__hint">PDF, Word, text, Markdown or CSV. New files also go into your library.</span>
          </div>
          {problems.length > 0 && <span className="tray__hint tray__hint--warn">{problems.join(" ")}</span>}
          <ErrorCallout error={load.error || upload.error} />
          {library && library.documents.length > 0 && (
            <fieldset className="filepick">
              <legend className="tray__hint">Or choose from your library</legend>
              {library.documents.map((doc) => {
                const { badge, label } = documentBadge(doc.status);
                return (
                  <label key={doc.id} className="filepick__item">
                    <input type="checkbox" checked={ids.has(doc.id)} onChange={() => toggle(doc)} disabled={disabled} />
                    <Icon name="file" size={14} />
                    <span className="filepick__name" title={doc.filename}>
                      {doc.filename}
                    </span>
                    <span className="muted filepick__size">{formatBytes(doc.size_bytes)}</span>
                    <StatusBadge status={badge} label={label} />
                  </label>
                );
              })}
            </fieldset>
          )}
          <span className="tray__hint">
            Agents search these files with the knowledge_search tool; file text is sent to the embedding provider
            to index it.
          </span>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ settings tray
function SettingsTray({ settings, onChange, tools, providers, disabled }) {
  const allTools = tools.tools ?? [];
  const defaultModel = providers.find((p) => p.default);
  const auto = settings.agentCount === null;

  function toggleTool(name) {
    const next = new Set(settings.tools);
    next.has(name) ? next.delete(name) : next.add(name);
    // Registry order, so the request is the same however the chips were clicked.
    onChange({ tools: allTools.map((t) => t.name).filter((n) => next.has(n)) });
  }

  const externalOn = allTools.filter((t) => t.side_effect && settings.tools.includes(t.name));

  return (
    <div className="tray" id="composer-settings">
      <div className="tray__row">
        <span className="tray__label">Team size</span>
        <div className="tray__control">
          <label className="row" style={{ gap: 8 }}>
            <Switch
              checked={auto}
              onChange={(on) => onChange({ agentCount: on ? null : 3 })}
              disabled={disabled}
              label="Let the planner choose the team size"
            />
            <span>Let the planner choose</span>
          </label>
          {!auto && (
            <div className="counter counter--sm">
              <button
                type="button"
                aria-label="Fewer agents"
                onClick={() => onChange({ agentCount: Math.max(MIN_AGENTS, settings.agentCount - 1) })}
                disabled={disabled || settings.agentCount <= MIN_AGENTS}
              >
                <Icon name="minus" size={13} />
              </button>
              <span className="counter__value" aria-live="polite">
                {settings.agentCount}
              </span>
              <button
                type="button"
                aria-label="More agents"
                onClick={() => onChange({ agentCount: Math.min(MAX_AGENTS, settings.agentCount + 1) })}
                disabled={disabled || settings.agentCount >= MAX_AGENTS}
              >
                <Icon name="plus" size={13} />
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="tray__row">
        <span className="tray__label">Model</span>
        <div className="tray__control">
          <select
            value={settings.model}
            onChange={(e) => onChange({ model: e.target.value })}
            disabled={disabled}
            aria-label="Model"
          >
            <option value="">Platform default{defaultModel ? ` (${defaultModel.model})` : ""}</option>
            <ModelOptions options={providers} isDisabled={(p) => p.available === false} />
          </select>
        </div>
      </div>

      <div className="tray__row tray__row--top">
        <span className="tray__label">Tools</span>
        <div className="tray__control">
          <div className="togglechips">
            {allTools.map((tool) => {
              const on = settings.tools.includes(tool.name);
              return (
                <button
                  key={tool.name}
                  type="button"
                  className={[
                    "togglechip",
                    on && "togglechip--on",
                    tool.side_effect && "togglechip--external",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  aria-pressed={on}
                  title={tool.description + (tool.side_effect ? " — sends data to a third party" : "")}
                  onClick={() => toggleTool(tool.name)}
                  disabled={disabled}
                >
                  {on && <Icon name="check" size={12} />}
                  {tool.name}
                </button>
              );
            })}
          </div>
          <span className="tray__hint">
            {externalOn.length > 0
              ? `External access on: agents may send task data to ${externalOn.map((t) => t.name).join(", ")}.`
              : "Amber tools reach third-party services and stay off unless you switch them on."}
          </span>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ messages
function AssistantAvatar() {
  return (
    <span className="msg__avatar" aria-hidden="true">
      <Icon name="brand" size={14} />
    </span>
  );
}

function PlanReply({ project }) {
  const { plan } = project;
  const n = plan.agents.length;
  return (
    <>
      <p>
        Here's a team of <strong>{n} agent{n === 1 ? "" : "s"}</strong>,{" "}
        {PATTERN_PHRASE[plan.orchestration_pattern] ?? plan.orchestration_pattern}.
      </p>
      <ol className="msg__agents">
        {plan.agents.map((agent) => (
          <li key={agent.id}>
            <span className="mono">{agent.id}</span>
            <span className="muted">{agent.role}</span>
            {agent.id === plan.supervisor_id && <Pill tone="accent">router</Pill>}
          </li>
        ))}
      </ol>
      <p className="muted">Nothing has run yet. Review the plan, then compile and run it.</p>
      <div className="msg__actions">
        <LinkButton variant="primary" size="sm" href={paths.project(project.project_id, "plan")}>
          Review plan
          <Icon name="arrowRight" size={14} />
        </LinkButton>
      </div>
    </>
  );
}

function Message({ message, onRetry, busy }) {
  if (message.role === "user") {
    return (
      <div className="msg msg--user">
        <div className="msg__bubble">
          <p className="prose">{message.brief}</p>
          {message.files?.length > 0 && (
            <ul className="msg__files" aria-label="Knowledge files">
              {message.files.map((f) => (
                <li key={f.id}>
                  <Icon name="file" size={12} />
                  {f.filename}
                </li>
              ))}
            </ul>
          )}
          <span className="msg__meta">{message.settingsLabel}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="msg msg--assistant" aria-live="polite">
      <AssistantAvatar />
      <div className={`msg__bubble ${message.status === "error" ? "msg__bubble--error" : ""}`}>
        {message.status === "pending" && (
          <div className="typing">
            <span className="typing__dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            Designing your agent team. This can take a minute or so.
          </div>
        )}
        {message.status === "done" && <PlanReply project={message.project} />}
        {message.status === "error" && (
          <>
            <p className="msg__error-title">{message.error.errorType ?? "Error"}</p>
            <p>{message.error.message}</p>
            <div className="msg__actions">
              <button type="button" className="btn btn--sm" onClick={onRetry} disabled={busy}>
                Try again
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ page
export function NewProjectPage({ tools, providers, disabled, onCreated }) {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  // Knowledge files for the next project (library documents).
  const [files, setFiles] = useState([]);
  // agentCount null = the planner decides. tools null = follow the platform default.
  const [settings, setSettings] = useState({ agentCount: null, model: "", tools: null });
  const textareaRef = useRef(null);
  const endRef = useRef(null);

  const effectiveSettings = { ...settings, tools: settings.tools ?? tools.default ?? [] };
  const busy = messages.some((m) => m.status === "pending");
  const empty = messages.length === 0;

  // Grow the message box with its content, up to a cap.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_COMPOSER_HEIGHT)}px`;
  }, [draft]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages]);

  function updateSettings(patch) {
    setSettings((s) => ({ ...s, ...patch }));
  }

  async function plan(request, replyId) {
    const chosen = providers.find((p) => `${p.provider}/${p.model}` === request.model);
    try {
      const project = await api.createProject({
        brief: request.brief,
        agentCount: request.agentCount,
        availableTools: request.tools,
        availableLlms: chosen ? [{ provider: chosen.provider, model: chosen.model }] : null,
        documentIds: request.files.map((f) => f.id),
      });
      setMessages((all) =>
        all.map((m) => (m.id === replyId ? { ...m, status: "done", project } : m)),
      );
      onCreated(project);
    } catch (error) {
      setMessages((all) =>
        all.map((m) => (m.id === replyId ? { ...m, status: "error", error } : m)),
      );
    }
  }

  function send(event) {
    event?.preventDefault();
    const brief = draft.trim();
    if (!brief || busy || disabled) return;
    // Settings are captured per message, so changing them later never rewrites history.
    const request = { brief, ...effectiveSettings, files };
    const replyId = ++nextMessageId;
    setMessages((all) => [
      ...all,
      {
        id: ++nextMessageId,
        role: "user",
        brief,
        files,
        settingsLabel: describeSettings(request, tools, providers),
      },
      { id: replyId, role: "assistant", status: "pending", request },
    ]);
    setDraft("");
    setSettingsOpen(false);
    setFilesOpen(false);
    // The files belong to this project; the next one starts without any.
    setFiles([]);
    plan(request, replyId);
  }

  function retry(message) {
    setMessages((all) =>
      all.map((m) => (m.id === message.id ? { ...m, status: "pending", error: null } : m)),
    );
    plan(message.request, message.id);
  }

  function onKeyDown(event) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      send(event);
    }
  }

  return (
    <div className="chat">
      <div className={`chat__thread ${empty ? "chat__thread--empty" : ""}`}>
        {empty ? (
          <div className="chat__welcome">
            <span className="chat__mark">
              <Icon name="brand" size={22} />
            </span>
            <h1>What should your agent team do?</h1>
            <p className="muted">
              Describe the task in your own words. The planner decides how many agents you
              need, what each one does and how they work together. You review the plan before
              anything runs.
            </p>
            <div className="suggestions">
              {EXAMPLES.map((example) => (
                <button
                  key={example.label}
                  type="button"
                  className="suggestion"
                  onClick={() => {
                    setDraft(example.brief);
                    textareaRef.current?.focus();
                  }}
                  disabled={disabled}
                >
                  <span className="suggestion__title">{example.label}</span>
                  <span className="suggestion__text">{example.brief}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <Message
              key={message.id}
              message={message}
              busy={busy}
              onRetry={() => retry(message)}
            />
          ))
        )}
        <div ref={endRef} />
      </div>

      <form className="composer" onSubmit={send}>
        <div className="composer__inner">
          {filesOpen && <FilesTray selected={files} onChange={setFiles} disabled={busy} />}
          {settingsOpen && (
            <SettingsTray
              settings={effectiveSettings}
              onChange={updateSettings}
              tools={tools}
              providers={providers}
              disabled={busy}
            />
          )}
          <div className="composer__box">
            {files.length > 0 && (
              <ul className="composer__files" aria-label="Knowledge files for this project">
                {files.map((f) => (
                  <li key={f.id} className="filechip">
                    <Icon name="file" size={12} />
                    <span className="filechip__name">{f.filename}</span>
                    <button
                      type="button"
                      className="filechip__remove"
                      onClick={() => setFiles((all) => all.filter((x) => x.id !== f.id))}
                      aria-label={`Remove ${f.filename}`}
                    >
                      <Icon name="close" size={11} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <textarea
              ref={textareaRef}
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={
                empty
                  ? "Describe the task for your agent team…"
                  : "Describe another task to plan a new team…"
              }
              aria-label="Task description"
              disabled={disabled}
            />
            <div className="composer__bar">
              <button
                type="button"
                className={`composer__options ${filesOpen ? "composer__options--open" : ""}`}
                onClick={() => setFilesOpen((open) => !open)}
                aria-expanded={filesOpen}
                aria-controls="composer-files"
                title="Add knowledge files for the agents to search"
              >
                <Icon name="file" size={14} />
                {files.length ? filesLabel(files.length) : "Add files"}
              </button>
              <button
                type="button"
                className={`composer__options ${settingsOpen ? "composer__options--open" : ""}`}
                onClick={() => setSettingsOpen((open) => !open)}
                aria-expanded={settingsOpen}
                aria-controls="composer-settings"
              >
                <Icon name="sliders" size={14} />
                {describeSettings(effectiveSettings, tools, providers)}
              </button>
              <button
                type="submit"
                className="composer__send"
                disabled={disabled || busy || !draft.trim()}
                aria-label="Plan this team"
                title="Plan this team (Enter)"
              >
                {busy ? <span className="spin" /> : <Icon name="arrowUp" size={16} />}
              </button>
            </div>
          </div>
          <p className="composer__hint">
            Enter to send, Shift+Enter for a new line. Each message plans a new project — nothing
            runs until you choose to run it.
          </p>
        </div>
      </form>
    </div>
  );
}
