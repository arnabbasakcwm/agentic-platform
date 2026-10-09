import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { api } from "../lib/api.js";
import { ASSISTANT_WIDTH, clampWidth } from "../lib/layout.js";
import { paths } from "../lib/router.js";
import { Icon } from "./icons.jsx";
import { Pill } from "./ui.jsx";

const MAX_INPUT_HEIGHT = 160;
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
const SUGGESTIONS = [
  "Run the independent agents in parallel",
  "Add an agent that reviews the final answer",
  "Use fewer agents",
  "Change the task to: ",
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
        <Icon name="brand" size={12} />
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

// A chat beside the project's brief, plan and compile pages: each message asks the
// planner to change the project, and the reply says what it changed.
export function AssistantPanel({ project, onRevised, onClose }) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(null);
  const [failed, setFailed] = useState(null);
  const inputRef = useRef(null);
  const endRef = useRef(null);
  const messages = project.conversation ?? [];
  const empty = messages.length === 0 && !pending && !failed;
  const panelRef = useRef(null);
  const { width, resizing, handle } = useResizableWidth(panelRef);
  // Fullscreen fills the work area (the sidebar and top bar stay); not remembered, so the
  // page never opens covered.
  const [full, setFull] = useState(false);

  // Leaving fullscreen with Esc, from anywhere in the panel.
  function onPanelKeyDown(event) {
    if (full && event.key === "Escape") {
      event.stopPropagation();
      setFull(false);
    }
  }

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  }, [draft]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, pending, failed]);

  async function send(text) {
    const message = (text ?? draft).trim();
    if (!message || pending) return;
    setPending(message);
    setFailed(null);
    setDraft("");
    try {
      const res = await api.reviseProject(project.project_id, message);
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

  return (
    <aside
      ref={panelRef}
      className={[
        "assistant",
        full && "assistant--full",
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
          <div className="assistant__intro">
            <p className="muted">
              Describe a change in your own words. I'll update the plan, and the
              brief too if you change the task. You can review every change
              before compiling.
            </p>
            <div className="assistant__suggestions">
              {SUGGESTIONS.map((text) => (
                <button
                  key={text}
                  type="button"
                  className="chip"
                  onClick={() => suggest(text)}
                >
                  {text.endsWith(": ") ? `${text}…` : text}
                </button>
              ))}
            </div>
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

      <form className="assistant__composer" onSubmit={onSubmit}>
        <div className="composer__box">
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="e.g. Add an agent that checks the facts"
            aria-label="Change request"
          />
          <div className="composer__bar">
            <span className="assistant__hint">
              Changes need compiling again
            </span>
            <button
              type="submit"
              className="composer__send"
              disabled={Boolean(pending) || !draft.trim()}
              aria-label="Send change request"
              title="Send (Enter)"
            >
              {pending ? (
                <span className="spin" />
              ) : (
                <Icon name="arrowUp" size={15} />
              )}
            </button>
          </div>
        </div>
      </form>
    </aside>
  );
}
