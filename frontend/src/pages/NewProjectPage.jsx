import { CircleHelp, FileSearch, Scale } from "lucide-react";
import { ProjectName } from "../components/ProjectName.jsx";
import { cannotCallTools, pickerLabel, withVerdicts } from "../lib/models.js";
import { useToolCheck } from "../lib/useToolCheck.js";
import { useEffect, useRef, useState } from "react";
import { Composer } from "../components/composer/Composer.jsx";
import { Icon } from "../components/icons.jsx";
import { LinkButton, Pill } from "../components/ui.jsx";
import { api } from "../lib/api.js";
import { paths } from "../lib/router.js";
import { addAnswer, latestBriefTurn, toApiMessages } from "../lib/intake.js";
import { Markdown } from "../components/Markdown.jsx";

// Starting points, not templates: picking one only fills the message box.
// Template cards, coloured violet / teal / amber (DESIGN.md §2).
const EXAMPLES = [
  {
    label: "Research and summarise",
    icon: FileSearch,
    tone: "violet",
    brief:
      "Research a topic the user names, draft a short summary of the key findings, then fact-check the summary and correct anything unsupported.",
  },
  {
    label: "Pros, cons, verdict",
    icon: Scale,
    tone: "teal",
    brief:
      "For a decision the user describes, have one agent argue the advantages and another the disadvantages independently, then a third weigh both and give a balanced verdict.",
  },
  {
    label: "Question answering",
    icon: CircleHelp,
    tone: "amber",
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

/** A list with `item` added at the end (on) or removed (off), by id. */
const toggled = (list, item, on) =>
  on
    ? list.some((x) => x.id === item.id)
      ? list
      : [...list, item]
    : list.filter((x) => x.id !== item.id);

function describeSettings(settings, tools, providers) {
  const parts = [
    settings.agentCount ? `${settings.agentCount} agents` : "Auto team size",
  ];
  const model = providers.find(
    (p) => `${p.provider}/${p.model}` === settings.model,
  );
  parts.push(model ? (model.name ?? model.model) : "Default model");
  // The SQL tools come with data sources (the Data tray), not from these settings.
  const offered = (tools.tools ?? []).filter(
    (t) => t.name !== "sql_schema" && t.name !== "sql_query",
  );
  parts.push(`${settings.tools.length} of ${offered.length} tools`);
  return parts.join(" · ");
}

// ------------------------------------------------------------------ messages
function AssistantAvatar() {
  return (
    <span className="msg__avatar" aria-hidden="true">
      <Icon name="brand" size={14} />
    </span>
  );
}

/** An agent's model as the menus name it ("Claude Haiku 4.5 · Anthropic on Bedrock"). */
function agentModel(agent, providers) {
  const option = providers.find(
    (p) => p.provider === agent.llm.provider && p.model === agent.llm.model,
  );
  return option
    ? pickerLabel(option)
    : `${agent.llm.provider} · ${agent.llm.model}`;
}

// The composer's settings survive leaving the page (e.g. to connect a data source) for
// the rest of this tab. A per-viewer convenience: without storage they reset, as before.
const SETTINGS_KEY = "agentic-platform.new-project-settings";
const DEFAULT_SETTINGS = { agentCount: null, model: "", tools: null };

function readSettings() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SETTINGS_KEY) ?? "null");
    return saved && typeof saved === "object"
      ? { ...DEFAULT_SETTINGS, ...saved }
      : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(settings) {
  try {
    sessionStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Not remembered; the choice still applies on this page.
  }
}

function PlanReply({ project, providers, onRenamed }) {
  const { plan } = project;
  const n = plan.agents.length;
  return (
    <>
      <ProjectName
        project={project}
        className="msg__name"
        renderName={(name) => <strong>{name}</strong>}
        onRenamed={onRenamed}
      />
      <p>
        Here's a team of{" "}
        <strong>
          {n} agent{n === 1 ? "" : "s"}
        </strong>
        ,{" "}
        {PATTERN_PHRASE[plan.orchestration_pattern] ??
          plan.orchestration_pattern}
        .
      </p>
      <ol className="msg__agents">
        {plan.agents.map((agent) => (
          <li key={agent.id}>
            <span className="mono">{agent.id}</span>
            <span className="muted">{agent.role}</span>
            <span className="msg__model mono">
              {agentModel(agent, providers)}
            </span>
            {agent.id === plan.supervisor_id && (
              <Pill tone="accent">router</Pill>
            )}
          </li>
        ))}
      </ol>
      <p className="muted">
        Nothing has run yet. Review the plan, then compile and run it.
      </p>
      <div className="msg__actions">
        <LinkButton
          variant="primary"
          size="sm"
          href={paths.project(project.project_id, "plan")}
        >
          Review plan
          <Icon name="arrowRight" size={14} />
        </LinkButton>
      </div>
    </>
  );
}

function Typing({ children }) {
  return (
    <div className="typing">
      <span className="typing__dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {children}
    </div>
  );
}

function ErrorBody({ error, onRetry, busy }) {
  return (
    <>
      <p className="msg__error-title">{error.errorType ?? "Error"}</p>
      <p>{error.message}</p>
      <div className="msg__actions">
        <button
          type="button"
          className="btn btn--sm"
          onClick={onRetry}
          disabled={busy}
        >
          Try again
        </button>
      </div>
    </>
  );
}

/** One intake reply: the answer, and the clarifying questions with quick answers. */
function TurnReply({ turn, onAnswer, busy }) {
  return (
    <>
      <Markdown>{turn.reply}</Markdown>
      {turn.questions?.length > 0 && (
        <ol className="intake__questions">
          {turn.questions.map((q) => (
            <li key={q.question}>
              <span className="intake__question">{q.question}</span>
              {q.options?.length > 0 && (
                <span
                  className="intake__options"
                  role="group"
                  aria-label={`Answers to: ${q.question}`}
                >
                  {q.options.map((option) => (
                    <button
                      key={option}
                      type="button"
                      className="chip"
                      onClick={() => onAnswer(q.question, option)}
                      disabled={busy}
                    >
                      {option}
                    </button>
                  ))}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

/**
 * The task brief assembled so far, editable, and the button that plans the team. It's
 * the user's call: the button works whenever there's a brief, and is the main action
 * once the assistant says it has what it needs.
 */
function BriefCard({ message, settingsLabel, onChange, onCreate, busy }) {
  const ready = Boolean(message.turn.ready);
  const brief = message.editedBrief ?? message.turn.brief;
  return (
    <section
      className={`briefcard ${ready ? "briefcard--ready" : ""}`}
      aria-label="Task brief"
    >
      <header className="briefcard__head">
        <span className="briefcard__title">Task brief</span>
        {ready ? (
          <Pill tone="success" dot>
            Ready to plan
          </Pill>
        ) : (
          <Pill>Draft — answer the questions for a better plan</Pill>
        )}
      </header>
      <textarea
        className="briefcard__text"
        value={brief}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Task brief (you can edit it)"
        rows={Math.min(10, Math.max(3, Math.ceil(brief.length / 90)))}
        disabled={busy}
      />
      <div className="briefcard__bar">
        <span className="muted briefcard__meta">{settingsLabel}</span>
        <button
          type="button"
          className={`btn btn--sm ${ready ? "btn--primary" : ""}`}
          onClick={onCreate}
          disabled={busy || !brief.trim()}
        >
          <Icon name="bolt" size={13} />
          Create plan
        </button>
      </div>
    </section>
  );
}

function Message({
  message,
  onRetry,
  busy,
  providers,
  onRenamed,
  onAnswer,
  briefCard,
}) {
  if (message.role === "divider") {
    return (
      <div className="intake__divider" role="separator">
        <span>New task</span>
      </div>
    );
  }
  if (message.role === "user") {
    return (
      <div className="msg msg--user">
        <div className="msg__bubble">
          <p className="prose">{message.text}</p>
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
        </div>
      </div>
    );
  }

  const failed = message.status === "error";
  return (
    <div className="msg msg--assistant" aria-live="polite">
      <AssistantAvatar />
      <div className="msg__stack">
        <div className={`msg__bubble ${failed ? "msg__bubble--error" : ""}`}>
          {message.status === "pending" &&
            (message.kind === "plan" ? (
              <Typing>
                Designing your agent team. This can take a minute or so.
              </Typing>
            ) : (
              <Typing>Thinking…</Typing>
            ))}
          {message.status === "done" && message.kind === "turn" && (
            <TurnReply turn={message.turn} onAnswer={onAnswer} busy={busy} />
          )}
          {message.status === "done" && message.kind === "plan" && (
            <PlanReply
              project={message.project}
              providers={providers}
              onRenamed={(updated) => onRenamed(message.id, updated)}
            />
          )}
          {failed && (
            <ErrorBody error={message.error} onRetry={onRetry} busy={busy} />
          )}
        </div>
        {briefCard}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ page
export function NewProjectPage({ tools, providers, disabled, onCreated }) {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState([]);
  // Knowledge files for the next project (library documents).
  const [files, setFiles] = useState([]);
  // Data sources for the next project.
  const [sources, setSources] = useState([]);
  // MCP servers for the next project.
  const [mcpServers, setMcpServers] = useState([]);
  // agentCount null = the planner decides. tools null = follow the platform default.
  const [settings, setSettings] = useState(readSettings);
  const toolCheck = useToolCheck();
  const modelList = withVerdicts(providers, toolCheck.verdicts);
  const textareaRef = useRef(null);
  const endRef = useRef(null);

  const effectiveSettings = {
    ...settings,
    tools: settings.tools ?? tools.default ?? [],
  };
  const busy = messages.some((m) => m.status === "pending");
  const empty = messages.length === 0;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages]);

  function updateSettings(patch) {
    setSettings((s) => {
      const next = { ...s, ...patch };
      saveSettings(next);
      return next;
    });
    if (patch.model) {
      toolCheck.check(
        modelList.find((p) => `${p.provider}/${p.model}` === patch.model),
      );
    }
  }

  function patchMessage(id, patch) {
    setMessages((all) =>
      all.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    );
  }

  // Planning: only ever started by the user (the button, or a clear "go ahead").
  async function plan(request, replyId) {
    const chosen = modelList.find(
      (p) => `${p.provider}/${p.model}` === request.model,
    );
    if (request.model && !chosen) {
      // Never fall back to the platform default without saying so.
      patchMessage(replyId, {
        status: "error",
        error: {
          errorType: "ModelUnavailable",
          message: `The model you chose (${request.model}) isn't in the list of available models right now. Choose another model from the Model menu and try again.`,
        },
      });
      return;
    }
    try {
      const project = await api.createProject({
        brief: request.brief,
        agentCount: request.agentCount,
        // A model that can't call tools gets no tools (the server enforces this too).
        availableTools: cannotCallTools(chosen) ? [] : request.tools,
        availableLlms: chosen
          ? [{ provider: chosen.provider, model: chosen.model }]
          : null,
        documentIds: request.files.map((f) => f.id),
        datasourceIds: request.sources.map((s) => s.id),
        mcpServerIds: (request.mcpServers ?? []).map((s) => s.id),
        name: request.name,
        intake: request.intake,
      });
      // The next message starts a new task.
      const dividerId = ++nextMessageId;
      setMessages((all) => [
        ...all.map((m) =>
          m.id === replyId ? { ...m, status: "done", project } : m,
        ),
        { id: dividerId, role: "divider" },
      ]);
      // The attachments belonged to this project.
      setFiles([]);
      onCreated(project);
    } catch (error) {
      patchMessage(replyId, { status: "error", error });
    }
  }

  // `thread`: the conversation to keep with the project (passed in when planning starts
  // from inside a reply, where this render's messages are already out of date).
  function createPlan(turnMessage, thread = messages) {
    if (busy && !turnMessage.autoPlan) return;
    const brief = (turnMessage.editedBrief ?? turnMessage.turn.brief).trim();
    if (!brief) return;
    const request = {
      brief,
      ...effectiveSettings,
      files,
      sources,
      mcpServers,
      // No name field: the intake's suggested name, else the server names the project
      // from the brief's first line. Renamed later from the project header.
      name: turnMessage.turn.name || "",
      intake: toApiMessages(thread),
    };
    // Ids are taken here, never inside a state updater (React may run those twice).
    const replyId = ++nextMessageId;
    setMessages((all) => [
      ...all,
      {
        id: replyId,
        role: "assistant",
        kind: "plan",
        status: "pending",
        request,
      },
    ]);
    plan(request, replyId);
  }

  // One intake turn: never creates anything by itself.
  async function talk(thread, replyId) {
    try {
      const turn = await api.briefChat({
        messages: toApiMessages(thread),
        documentIds: files.map((f) => f.id),
        datasourceIds: sources.map((s) => s.id),
        mcpServerIds: mcpServers.map((s) => s.id),
      });
      const done = { status: "done", turn };
      patchMessage(replyId, done);
      // "Yes, plan it" in the chat counts as pressing Create plan.
      if (turn.plan_now && turn.brief?.trim()) {
        const answered = {
          id: replyId,
          role: "assistant",
          kind: "turn",
          ...done,
        };
        createPlan({ ...answered, autoPlan: true }, [...thread, answered]);
      }
    } catch (error) {
      patchMessage(replyId, { status: "error", error });
    }
  }

  function send(event) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || busy || disabled) return;
    const user = { id: ++nextMessageId, role: "user", text, files };
    const reply = {
      id: ++nextMessageId,
      role: "assistant",
      kind: "turn",
      status: "pending",
    };
    const thread = [...messages, user];
    setMessages([...thread, reply]);
    setDraft("");
    talk(thread, reply.id);
  }

  function retry(message) {
    patchMessage(message.id, { status: "pending", error: null });
    if (message.kind === "plan") {
      plan(message.request, message.id);
    } else {
      talk(
        messages.filter((m) => m.id < message.id),
        message.id,
      );
    }
  }

  function answer(question, option) {
    setDraft((d) => addAnswer(d, question, option));
    textareaRef.current?.focus();
  }

  const briefTurn = latestBriefTurn(messages);

  function onKeyDown(event) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      send(event);
    }
  }

  return (
    <div className={`chat${empty ? " chat--empty" : ""}`}>
      <div className={`chat__thread ${empty ? "chat__thread--empty" : ""}`}>
        {empty ? (
          <div className="chat__welcome">
            <span className="chat__glow ap-glow-breathe" aria-hidden="true" />
            <h1>What should your agent team do?</h1>
            <p className="muted">
              Describe the task. You review the plan before anything runs.
            </p>
          </div>
        ) : (
          messages.map((message) => (
            <Message
              key={message.id}
              message={message}
              busy={busy}
              providers={modelList}
              onRenamed={(id, updated) => {
                setMessages((all) =>
                  all.map((m) =>
                    m.id === id
                      ? {
                          ...m,
                          project: {
                            ...m.project,
                            name: updated.name,
                            named: updated.named,
                          },
                        }
                      : m,
                  ),
                );
                onCreated(updated);
              }}
              onRetry={() => retry(message)}
              onAnswer={answer}
              briefCard={
                briefTurn?.id === message.id ? (
                  <BriefCard
                    message={message}
                    settingsLabel={describeSettings(
                      effectiveSettings,
                      tools,
                      providers,
                    )}
                    onChange={(text) =>
                      patchMessage(message.id, { editedBrief: text })
                    }
                    onCreate={() => createPlan(message)}
                    busy={busy}
                  />
                ) : null
              }
            />
          ))
        )}
        <div ref={endRef} />
      </div>

      <Composer
        draft={draft}
        onDraft={setDraft}
        onKeyDown={onKeyDown}
        textareaRef={textareaRef}
        placeholder={
          empty
            ? "Describe the task, or ask how to start…"
            : "Reply, answer the questions, or describe another task…"
        }
        disabled={disabled}
        busy={busy}
        docked={!empty}
        onSubmit={send}
        settings={effectiveSettings}
        onSettings={updateSettings}
        tools={tools}
        providers={modelList}
        files={files}
        sources={sources}
        mcpServers={mcpServers}
        // The next project's attachments: kept here, sent when it's created.
        onToggleFile={(doc, on) => setFiles((all) => toggled(all, doc, on))}
        onToggleSource={(s, on) => setSources((all) => toggled(all, s, on))}
        onToggleMcp={(s, on) => setMcpServers((all) => toggled(all, s, on))}
        onUploaded={(docs) => setFiles((all) => [...all, ...docs])}
      />
      {empty && (
        // Below the composer, in reading and keyboard order (DESIGN.md §6 New project).
        <div className="suggestions">
          {EXAMPLES.map((example) => {
            const ExampleIcon = example.icon;
            return (
              <button
                key={example.label}
                type="button"
                className="suggestion ap-lift"
                data-tone={example.tone}
                onClick={() => {
                  setDraft(example.brief);
                  textareaRef.current?.focus();
                }}
                disabled={disabled}
              >
                <span className="suggestion__icon" aria-hidden="true">
                  <ExampleIcon size={18} />
                </span>
                <span className="suggestion__title">{example.label}</span>
                <span className="suggestion__text">{example.brief}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
