import { GitFork, Minimize2, PenLine, UserPlus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { toggleableTools, toolsChanged } from "../lib/composer.js";
import { ASSISTANT_WIDTH, clampWidth } from "../lib/layout.js";
import { cannotCallTools, modelKey, withVerdicts } from "../lib/models.js";
import { paths } from "../lib/router.js";
import { useAction } from "../lib/useAction.js";
import { useToolCheck } from "../lib/useToolCheck.js";
import { Composer } from "./composer/Composer.jsx";
import { Icon } from "./icons.jsx";
import { ErrorCallout, Pill } from "./ui.jsx";

// The width the user dragged the panel to: a per-browser convenience, so localStorage.
const WIDTH_KEY = "agentic-platform.assistant-width";
const KEY_STEP = 24;

function readWidth() {
  try {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    return stored > 0 ? stored : ASSISTANT_WIDTH.default;
  } catch {
    return ASSISTANT_WIDTH.default;
  }
}

function saveWidth(width) {
  try {
    localStorage.setItem(WIDTH_KEY, String(width));
  } catch {
    // Storage unavailable: the width just isn't remembered.
  }
}

/**
 * The panel's width, changed by dragging its left edge (or with the arrow keys on it),
 * kept within limits that leave the page usable, and remembered in this browser.
 */
function useResizableWidth(panelRef) {
  const [width, setWidth] = useState(readWidth);
  const [resizing, setResizing] = useState(false);

  const clamp = useCallback(
    (value) => {
      const workspace = panelRef.current?.parentElement;
      const available = workspace?.clientWidth ?? window.innerWidth;
      const overlay =
        window.matchMedia?.("(max-width: 1100px)").matches ?? false;
      return clampWidth(value, available, { overlay });
    },
    [panelRef],
  );

  const set = useCallback(
    (value, { save = true } = {}) => {
      const next = clamp(value);
      setWidth(next);
      if (save) saveWidth(next);
    },
    [clamp],
  );

  function onPointerDown(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("is-resizing");
    setResizing(true);
  }

  // The panel's right edge stays put, so its width is that edge minus the pointer.
  function widthAt(event) {
    const right =
      panelRef.current?.getBoundingClientRect().right ?? window.innerWidth;
    return right - event.clientX;
  }

  function onPointerMove(event) {
    if (resizing) set(widthAt(event), { save: false });
  }

  function onPointerUp(event) {
    if (!resizing) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    document.body.classList.remove("is-resizing");
    setResizing(false);
    set(widthAt(event));
  }

  // An interrupted drag (a cancelled touch) keeps the width it reached.
  function onPointerCancel() {
    document.body.classList.remove("is-resizing");
    setResizing(false);
    saveWidth(width);
  }

  // Closing the panel mid-drag mustn't leave the page unselectable.
  useEffect(() => () => document.body.classList.remove("is-resizing"), []);

  // The handle is on the panel's left edge: moving it left makes the panel wider.
  function onKeyDown(event) {
    const moves = {
      ArrowLeft: width + KEY_STEP,
      ArrowRight: width - KEY_STEP,
      Home: ASSISTANT_WIDTH.min,
      End: ASSISTANT_WIDTH.max,
    };
    if (!(event.key in moves)) return;
    event.preventDefault();
    set(moves[event.key]);
  }

  const handle = {
    role: "separator",
    "aria-orientation": "vertical",
    "aria-label": "Resize assistant",
    "aria-valuemin": ASSISTANT_WIDTH.min,
    "aria-valuemax": ASSISTANT_WIDTH.max,
    "aria-valuenow": width,
    tabIndex: 0,
    title: "Drag to resize · double-click to reset",
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onKeyDown,
    onDoubleClick: () => set(ASSISTANT_WIDTH.default),
  };
  return { width, resizing, handle };
}

// Clicking one only fills the message box, so it can be adjusted before sending.
// Template cards for an empty conversation, like New project's (DESIGN.md §6).
const SUGGESTIONS = [
  { text: "Run the independent agents in parallel", icon: GitFork, tone: "violet" },
  { text: "Add an agent that reviews the final answer", icon: UserPlus, tone: "teal" },
  { text: "Use fewer agents", icon: Minimize2, tone: "amber" },
  { text: "Change the task to: ", icon: PenLine, tone: "violet" },
];

function UserMessage({ content }) {
  return (
    <div className="msg msg--user">
      <div className="msg__bubble">
        <p className="prose">{content}</p>
      </div>
    </div>
  );
}

function AssistantMessage({ children, error }) {
  return (
    <div className="msg msg--assistant">
      <span className="msg__avatar" aria-hidden="true">
        <Icon name="brand" size={14} />
      </span>
      <div className={`msg__bubble ${error ? "msg__bubble--error" : ""}`}>
        {children}
      </div>
    </div>
  );
}

function Reply({ message, project }) {
  const version = message.plan_version;
  const isCurrent = version === project.plan_version;
  return (
    <AssistantMessage>
      <p className="prose">{message.content}</p>
      {version ? (
        <div className="row gap-field">
          <Pill tone="accent">plan v{version}</Pill>
          {isCurrent && !project.compiled && (
            <a
              className="msg__link"
              href={paths.project(project.project_id, "compile")}
            >
              Needs compiling
            </a>
          )}
        </div>
      ) : null}
    </AssistantMessage>
  );
}

const CHIPS_DEFAULT = { model: "", agentCount: null, tools: null };
// The Model chip's "" row: each agent keeps the model it has.
const KEEP_MODELS = { chip: "Current", label: "Keep each agent's model", sub: "no change" };

/** The tools the planner may use now: the built-ins plus this project's external opt-ins. */
function currentTools(tools, project) {
  const on = new Set([...(tools.default ?? []), ...(project.side_effect_tools_enabled ?? [])]);
  return toggleableTools(tools)
    .map((t) => t.name)
    .filter((n) => on.has(n));
}

/**
 * What a change request sends: the message, plus each chip that differs from its default
 * (untouched chips send exactly `{message}`, as before).
 */
export function reviseExtras(chips, baselineTools, chosenModel) {
  const extras = {};
  if (chips.model && chosenModel) {
    extras.model = { provider: chosenModel.provider, model: chosenModel.model };
  }
  if (chips.agentCount) extras.agentCount = chips.agentCount;
  if (cannotCallTools(chosenModel)) {
    // A model that can't call tools gets none (the server enforces this too).
    extras.tools = [];
  } else if (chips.tools && toolsChanged(chips.tools, baselineTools)) {
    extras.tools = chips.tools;
  }
  return extras;
}

// A chat beside the project's pages, in the same composer as New project: each message
// asks the planner to change the project, the chips limit what it may use for that change,
// and the reply says what it changed.
export function AssistantPanel({
  project,
  tools,
  providers,
  onRevised,
  onResourcesChanged,
  onClose,
}) {
  const id = project.project_id;
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(null);
  const [failed, setFailed] = useState(null);
  const [chips, setChips] = useState(CHIPS_DEFAULT);
  const [attached, setAttached] = useState({ files: [], sources: [], servers: [] });
  const attach = useAction();
  const toolCheck = useToolCheck();
  const modelList = withVerdicts(providers, toolCheck.verdicts);
  const inputRef = useRef(null);
  const endRef = useRef(null);
  const messages = project.conversation ?? [];
  const empty = messages.length === 0 && !pending && !failed;
  const panelRef = useRef(null);
  const { width, resizing, handle } = useResizableWidth(panelRef);
  // Fullscreen fills the work area (the sidebar and top bar stay); not remembered, so the
  // page never opens covered.
  const [full, setFull] = useState(false);
  const baselineTools = currentTools(tools, project);
  const effective = { ...chips, tools: chips.tools ?? baselineTools };
  const chosenModel = modelList.find((p) => modelKey(p) === chips.model);

  // What's attached to this project (the + menu's chips). A list that fails to load
  // keeps what it showed.
  const loadAttached = useCallback(
    () =>
      Promise.all([
        api.getKnowledge(id).catch(() => null),
        api.projectDataSources(id).catch(() => null),
        api.projectMcpServers(id).catch(() => null),
      ]).then(([knowledge, data, mcp]) =>
        setAttached((prev) => ({
          files: knowledge ? knowledge.documents : prev.files,
          sources: data ? data.attached : prev.sources,
          servers: mcp ? mcp.servers.filter((s) => s.attached) : prev.servers,
        })),
      ),
    [id],
  );

  useEffect(() => {
    let current = true;
    Promise.resolve().then(() => current && loadAttached());
    return () => {
      current = false;
    };
  }, [loadAttached]);

  // Leaving fullscreen with Esc, from anywhere in the panel; an open chip popover (which
  // bubbles here through its portal) closes first.
  function onPanelKeyDown(event) {
    if (full && event.key === "Escape" && !document.querySelector(".cpop")) {
      event.stopPropagation();
      setFull(false);
    }
  }

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, pending, failed]);

  function updateChips(patch) {
    setChips((c) => ({ ...c, ...patch }));
    if (patch.model) {
      toolCheck.check(modelList.find((p) => modelKey(p) === patch.model));
    }
  }

  async function send(text) {
    const message = (text ?? draft).trim();
    if (!message || pending) return;
    const extras = reviseExtras(effective, baselineTools, chosenModel);
    setPending(message);
    setFailed(null);
    setDraft("");
    try {
      const res = await api.reviseProject(id, message, extras);
      onRevised(res.project, res.changed);
    } catch (error) {
      setFailed({ message, error });
    } finally {
      setPending(null);
    }
  }

  function onSubmit(event) {
    event.preventDefault();
    send();
  }

  function onKeyDown(event) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      send();
    }
  }

  function suggest(text) {
    setDraft(text);
    const el = inputRef.current;
    el?.focus();
    // Put the caret at the end, ready to finish "Change the task to: …".
    requestAnimationFrame(() =>
      el?.setSelectionRange(text.length, text.length),
    );
  }

  // + menu: attaching here attaches to the project at once, like the Resources step. The
  // chip shows straight away; the lists are reloaded from the server afterwards, which
  // also undoes the chip if the request failed.
  async function change(call, kind, item, on) {
    if (kind) {
      setAttached((all) => ({
        ...all,
        [kind]: on
          ? [...all[kind].filter((x) => x.id !== item.id), item]
          : all[kind].filter((x) => x.id !== item.id),
      }));
    }
    const done = await attach.run(call);
    await loadAttached();
    if (done !== null) onResourcesChanged?.();
  }

  return (
    <aside
      ref={panelRef}
      className={[
        "assistant",
        full && "assistant--full",
        empty && "assistant--empty",
        resizing && "assistant--resizing",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ "--assistant-width": `${width}px` }}
      aria-label="Plan assistant"
      onKeyDown={onPanelKeyDown}
    >
      {!full && <div className="assistant__resize" {...handle} />}
      <header className="assistant__head">
        <Icon name="chat" />
        <div className="assistant__title">
          <span>Assistant</span>
          <span className="assistant__sub">
            Ask to change the brief or the plan
          </span>
        </div>
        <button
          type="button"
          className="btn btn--sm btn--ghost assistant__fullbtn"
          onClick={() => setFull((f) => !f)}
          aria-pressed={full}
          aria-label={full ? "Exit fullscreen" : "Fullscreen"}
          title={full ? "Exit fullscreen (Esc)" : "Fullscreen"}
        >
          <Icon name={full ? "minimize" : "maximize"} size={14} />
          <span className="assistant__fulllabel">
            {full ? "Exit fullscreen" : "Fullscreen"}
          </span>
        </button>
        <button
          type="button"
          className="iconbtn"
          onClick={onClose}
          aria-label="Close assistant"
          title="Close assistant"
        >
          <Icon name="close" />
        </button>
      </header>

      <div className="assistant__thread">
        {empty && (
          <div className="chat__welcome assistant__hero">
            <span className="chat__glow ap-glow-breathe" aria-hidden="true" />
            <h2>What should change?</h2>
            <p className="muted">
              Describe a change in your own words. You review every change
              before compiling.
            </p>
          </div>
        )}

        {messages.map((message, i) =>
          message.role === "user" ? (
            <UserMessage key={i} content={message.content} />
          ) : (
            <Reply key={i} message={message} project={project} />
          ),
        )}

        {pending && (
          <>
            <UserMessage content={pending} />
            <AssistantMessage>
              <div className="typing" aria-live="polite">
                <span className="typing__dots" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
                Updating the plan…
              </div>
            </AssistantMessage>
          </>
        )}

        {failed && (
          <>
            <UserMessage content={failed.message} />
            <AssistantMessage error>
              <p className="msg__error-title">
                {failed.error.errorType ?? "Error"}
              </p>
              <p>{failed.error.message}</p>
              <div className="msg__actions">
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => send(failed.message)}
                >
                  Try again
                </button>
              </div>
            </AssistantMessage>
          </>
        )}
        <div ref={endRef} />
      </div>

      <div className="assistant__bottom">
        <ErrorCallout error={attach.error} />
        <Composer
          variant="panel"
          draft={draft}
          onDraft={setDraft}
          onKeyDown={onKeyDown}
          textareaRef={inputRef}
          placeholder="e.g. Add an agent that checks the facts"
          label="Change request"
          sendLabel="Send change request"
          busy={Boolean(pending)}
          // Popovers open below only while an empty fullscreen centres the composer.
          docked={!(full && empty)}
          onSubmit={onSubmit}
          settings={effective}
          onSettings={updateChips}
          tools={tools}
          toolsBaseline={baselineTools}
          providers={modelList}
          modelBaseline={KEEP_MODELS}
          files={attached.files}
          sources={attached.sources}
          mcpServers={attached.servers}
          attachmentsBusy={attach.busy}
          onToggleFile={(doc, on) =>
            change(
              () => (on ? api.attachDocument(id, doc.id) : api.detachDocument(id, doc.id)),
              "files",
              doc,
              on,
            )
          }
          onToggleSource={(s, on) =>
            change(
              () => (on ? api.attachDataSource(id, s.id) : api.detachDataSource(id, s.id)),
              "sources",
              s,
              on,
            )
          }
          onToggleMcp={(s, on) =>
            change(
              () => (on ? api.attachMcpServer(id, s.id) : api.detachMcpServer(id, s.id)),
              "servers",
              s,
              on,
            )
          }
          uploadBatch={(batch) => api.uploadDocuments(id, batch)}
          onUploaded={() => change(async () => true)}
          footer={<p className="composer__hint">Changes need compiling again</p>}
        />
        {empty && (
          <div className="suggestions assistant__suggestions">
            {SUGGESTIONS.map((s) => {
              const SuggestionIcon = s.icon;
              return (
                <button
                  key={s.text}
                  type="button"
                  className="suggestion ap-lift"
                  data-tone={s.tone}
                  onClick={() => suggest(s.text)}
                >
                  <span className="suggestion__icon" aria-hidden="true">
                    <SuggestionIcon size={16} />
                  </span>
                  <span className="suggestion__title">
                    {s.text.endsWith(": ") ? `${s.text}…` : s.text}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
