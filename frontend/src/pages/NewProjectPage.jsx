import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../components/icons.jsx";
import { LinkButton, Pill, Switch } from "../components/ui.jsx";
import { api } from "../lib/api.js";
import { paths } from "../lib/router.js";

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
            {providers.map((p) => (
              <option key={`${p.provider}/${p.model}`} value={`${p.provider}/${p.model}`}>
                {p.provider} · {p.model}
              </option>
            ))}
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
    const request = { brief, ...effectiveSettings };
    const replyId = ++nextMessageId;
    setMessages((all) => [
      ...all,
      {
        id: ++nextMessageId,
        role: "user",
        brief,
        settingsLabel: describeSettings(request, tools, providers),
      },
      { id: replyId, role: "assistant", status: "pending", request },
    ]);
    setDraft("");
    setSettingsOpen(false);
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
