import {
  ArrowLeft,
  ArrowUp,
  BookOpen,
  ChevronDown,
  CircleAlert,
  Cpu,
  Database,
  File,
  Globe,
  Lock,
  Plug,
  Plus,
  Search,
  Shield,
  Upload,
  Users,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { api } from "../../lib/api.js";
import {
  KNOWLEDGE_TOOL,
  MAX_AGENTS,
  MIN_AGENTS,
  modelChipValue,
  modelGroups,
  modelSub,
  modelTag,
  parseTeamSize,
  teamLabel,
  toggleableTools,
  toolCount,
  toolGroups,
  toolsChanged,
} from "../../lib/composer.js";
import { batches, checkFiles, documentBadge, formatBytes } from "../../lib/knowledge.js";
import { cannotCallTools, modelKey, modelName } from "../../lib/models.js";
import { useAction } from "../../lib/useAction.js";
import { StatusBadge, Switch } from "../ui.jsx";
import { Popover } from "./Popover.jsx";

const MAX_COMPOSER_HEIGHT = 220;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
let nextUploadKey = 0;

/** A toolbar chip that opens a popover: "Model Gemini 3.1 Pro ⌄". */
function Chip({ chipRef, open, popId, haspopup, icon: ChipIcon, k, value, changed, iconOnly, label, onToggle, disabled }) {
  return (
    <button
      ref={chipRef}
      type="button"
      data-composer-chip=""
      className={["cchip", changed && "cchip--changed", iconOnly && "cchip--icon"]
        .filter(Boolean)
        .join(" ")}
      aria-haspopup={haspopup}
      aria-expanded={open}
      aria-controls={open ? popId : undefined}
      aria-label={label}
      onClick={onToggle}
      disabled={disabled}
    >
      <ChipIcon size={15} aria-hidden="true" />
      {!iconOnly && (
        <>
          <span className="cchip__k">{k}</span>
          <span className="cchip__v">{value}</span>
          <ChevronDown size={14} aria-hidden="true" className="cchip__chev" />
        </>
      )}
    </button>
  );
}

// ------------------------------------------------------------------ + menu
const MENU = [
  { id: "upload", icon: Upload, tone: "violet", title: "Upload files" },
  { id: "library", icon: BookOpen, tone: "teal", title: "Choose from library" },
  { id: "data", icon: Database, tone: "amber", title: "Add data source" },
  { id: "mcp", icon: Plug, tone: "sky", title: "Attach MCP server" },
];

function AddMenu({ descriptions, onPick, initialFocus }) {
  const listRef = useRef(null);
  useEffect(() => {
    const items = [...listRef.current.querySelectorAll("[role=menuitem]")];
    (items.find((i) => i.dataset.id === initialFocus) ?? items[0])?.focus();
  }, [initialFocus]);

  function onKeyDown(event) {
    const items = [...listRef.current.querySelectorAll("[role=menuitem]")];
    const at = items.indexOf(document.activeElement);
    const go = (i) => {
      event.preventDefault();
      items[(i + items.length) % items.length].focus();
    };
    if (event.key === "ArrowDown") go(at + 1);
    else if (event.key === "ArrowUp") go(at - 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(items.length - 1);
  }

  return (
    <div className="cpop__body cmenu" ref={listRef} onKeyDown={onKeyDown}>
      {MENU.map((item) => {
        const ItemIcon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            data-id={item.id}
            tabIndex={-1}
            className="cmenu__item"
            onClick={() => onPick(item.id)}
          >
            <span className="cmenu__ico" data-tone={item.tone} aria-hidden="true">
              <ItemIcon size={16} />
            </span>
            <span>
              <span className="cmenu__t">{item.title}</span>
              <span className="cmenu__d">{descriptions[item.id]}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A + menu sub-view: a pinned header with Back, and a checklist. */
function SubView({ title, onBack, children }) {
  const backRef = useRef(null);
  useEffect(() => backRef.current?.focus(), []);
  return (
    <>
      <div className="cpop__head cpop__head--row">
        <button
          ref={backRef}
          type="button"
          className="cpop__back"
          onClick={onBack}
          aria-label="Back to the add menu"
        >
          <ArrowLeft size={15} aria-hidden="true" />
        </button>
        <span className="cpop__title">{title}</span>
      </div>
      <div className="cpop__body">{children}</div>
    </>
  );
}

function CheckRow({ checked, onChange, disabled, icon: RowIcon, name, meta, children }) {
  return (
    <label className="ccheck">
      <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} />
      <RowIcon size={15} aria-hidden="true" className="ccheck__ico" />
      <span className="ccheck__main">
        <span className="ccheck__name" title={name}>
          {name}
        </span>
        {meta && <span className="ccheck__meta">{meta}</span>}
      </span>
      {children}
    </label>
  );
}

// ------------------------------------------------------------------ model
// The "" choice when the composer has a baseline (the Assistant: keep each agent's model).
const KEEP = { provider: "", model: "", keep: true };

function ModelList({ value, providers, onPick, baseline }) {
  const [query, setQuery] = useState("");
  const listId = useId();
  const { sections: found, keyless } = modelGroups(providers, query);
  const sections =
    baseline && !query.trim()
      ? [{ id: "keep", title: "Current", options: [KEEP] }, ...found]
      : found;
  const flat = sections.flatMap((s) => s.options);
  const defaultKey = providers.find((p) => p.default && !p.group);
  // "" is the platform default on New project, or "keep" in the Assistant.
  const selectedKey = value || (baseline ? "/" : defaultKey ? modelKey(defaultKey) : "");
  const [active, setActive] = useState(() =>
    Math.max(0, flat.findIndex((o) => modelKey(o) === selectedKey)),
  );
  const at = Math.min(active, flat.length - 1);
  const optionId = (o) => `${listId}-${modelKey(o).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const inputRef = useRef(null);
  useEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    if (at >= 0 && flat[at]) {
      document.getElementById(optionId(flat[at]))?.scrollIntoView({ block: "nearest" });
    }
  });

  function onKeyDown(event) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!flat.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((at + step + flat.length) % flat.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (flat[at]) onPick(flat[at]);
    }
  }

  return (
    <>
      <div className="cpop__head">
        <label className="csearch">
          <Search size={15} aria-hidden="true" />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={flat[at] ? optionId(flat[at]) : undefined}
            aria-label="Search models"
            placeholder="Search models"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
        </label>
      </div>
      {/* Focusable so the list can be scrolled by keyboard too (arrows in the search
          field already move through it). */}
      <div className="cpop__body" tabIndex={0}>
        <div role="listbox" id={listId} aria-label="Model">
          {sections.map((s) => (
            <div key={s.id} role="group" aria-labelledby={`${listId}-${s.id}`}>
              <div className="cpop__grp" id={`${listId}-${s.id}`} role="presentation">
                {s.title}
              </div>
              {s.options.map((o) => {
                const key = modelKey(o);
                const selected = key === selectedKey;
                const tag = o.keep ? null : modelTag(o);
                return (
                  <div
                    key={key}
                    id={optionId(o)}
                    role="option"
                    aria-selected={selected}
                    className={`copt${flat[at] === o ? " copt--active" : ""}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onPick(o)}
                  >
                    <span className="copt__name">
                      {o.keep ? (
                        <>
                          {baseline.label} <span className="copt__sub">· {baseline.sub}</span>
                        </>
                      ) : (
                        <>
                          {modelName(o)} <span className="copt__sub">· {modelSub(o)}</span>
                        </>
                      )}
                    </span>
                    <span className="copt__right">
                      {tag && (
                        <span className={`ctag${tag === "Default" ? " ctag--default" : ""}`}>{tag}</span>
                      )}
                      {selected && <span className="copt__check" aria-hidden="true">✓</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        {flat.length === 0 && <p className="cpop__hint">No model matches “{query}”.</p>}
        {keyless > 0 && (
          <p className="cpop__keyless" title="API keys are set on the server by an administrator.">
            <Lock size={14} aria-hidden="true" />
            {plural(keyless, "model")} need{keyless === 1 ? "s" : ""} an API key
          </p>
        )}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ team
function TeamPanel({ agentCount, onChange, onDone }) {
  const [last, setLast] = useState(agentCount ?? 3);
  const [text, setText] = useState(String(agentCount ?? 3));
  const [error, setError] = useState(null);
  const auto = agentCount == null;
  const inputRef = useRef(null);
  const autoRef = useRef(null);
  const hintId = useId();

  useEffect(() => {
    (auto ? autoRef : inputRef).current?.focus();
    // Focus once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function typed(value) {
    setText(value);
    const parsed = parseTeamSize(value);
    if (parsed.error) {
      setError(parsed.error);
    } else {
      setError(null);
      setLast(parsed.value);
      onChange(parsed.value);
    }
  }

  return (
    <div className="cpop__body cteam">
      <div className="cseg" role="group" aria-label="Team size">
        <button
          ref={autoRef}
          type="button"
          aria-pressed={auto}
          onClick={() => {
            setError(null);
            onChange(null);
            onDone();
          }}
        >
          Auto
        </button>
        <button
          type="button"
          aria-pressed={!auto}
          onClick={() => {
            if (auto) {
              setText(String(last));
              setError(null);
              onChange(last);
            }
            setTimeout(() => inputRef.current?.focus());
          }}
        >
          Set a number
        </button>
      </div>
      {!auto && (
        <label className="cteam__field">
          <span>Up to</span>
          <input
            ref={inputRef}
            type="text"
            inputMode="numeric"
            className="cteam__input"
            value={text}
            onChange={(e) => typed(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (!parseTeamSize(text).error) onDone();
              }
            }}
            aria-label="Most agents"
            aria-invalid={Boolean(error)}
            aria-describedby={hintId}
          />
          <span>agents</span>
        </label>
      )}
      {error && (
        <p className="cpop__error" role="alert">
          {error}
        </p>
      )}
      <p className="cpop__hint" id={hintId}>
        {auto
          ? "Auto lets the planner choose the number of agents. You review the plan before anything runs."
          : `The planner uses up to ${last} agent${last === 1 ? "" : "s"} (${MIN_AGENTS}–${MAX_AGENTS}).`}
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ tools
function ToolsPanel({ tools, chosen, onToggle, files, noTools, modelLabel, servers, attached, onAttach, busy }) {
  // `files`: how many files are attached (knowledge_search follows them).
  const groups = toolGroups(tools);
  const attachedIds = new Set(attached.map((s) => s.id));
  return (
    <div className="cpop__body">
      {noTools && (
        <p className="cpop__warn" role="status">
          {modelLabel} can&apos;t call tools, so its agents get no tools (including knowledge search and
          data queries). Choose another model to use tools.
        </p>
      )}
      {groups.map((g) => {
        const GroupIcon = g.external ? Globe : Shield;
        return (
          <div key={g.id} role="group" aria-label={`${g.title}, ${g.note}`}>
            <div className="cpop__grp">
              <GroupIcon size={13} aria-hidden="true" />
              {g.title} <small>· {g.note}</small>
            </div>
            {g.tools.map((t) => {
              if (t.name === KNOWLEDGE_TOOL) {
                const on = files > 0 && !noTools;
                return (
                  <div key={t.name} className="crow crow--locked" title={t.description}>
                    <span className="crow__name mono">
                      {t.name}
                      {on ? (
                        <span className="ctag ctag--ok">auto · {plural(files, "file")}</span>
                      ) : (
                        <span className="crow__hint">Turns on when you attach files</span>
                      )}
                    </span>
                    <Lock size={13} aria-hidden="true" className="crow__lock" />
                    <Switch checked={on} disabled onChange={() => {}} label={`${t.name} (automatic)`} />
                  </div>
                );
              }
              return (
                <div key={t.name} className="crow" title={t.description}>
                  <span className="crow__name mono">{t.name}</span>
                  <Switch
                    checked={!noTools && chosen.includes(t.name)}
                    disabled={busy || noTools}
                    onChange={() => onToggle(t.name)}
                    label={t.name}
                  />
                </div>
              );
            })}
          </div>
        );
      })}
      <div role="group" aria-label="MCP servers">
        <div className="cpop__grp">
          <Plug size={13} aria-hidden="true" />
          MCP servers
        </div>
        {servers === null ? (
          <p className="cpop__hint">Loading…</p>
        ) : servers.length === 0 ? (
          <p className="cpop__hint">
            No MCP server with approved tools yet. <a href="#/mcp">Connect a server</a> first.
          </p>
        ) : (
          servers.map((s) => {
            const n = s.tools.filter((x) => x.usable).length;
            const on = attachedIds.has(s.id);
            return (
              <div key={s.id} className="crow">
                <span className="crow__name">
                  {s.name} <span className="copt__sub">· {plural(n, "tool")}</span>
                </span>
                <button
                  type="button"
                  className="clink"
                  onClick={() => onAttach(s)}
                  disabled={busy}
                  aria-label={`${on ? "Remove" : "Attach"} ${s.name}`}
                >
                  {on ? "Remove" : "Attach"}
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ composer
/**
 * The New project composer: the task box, the attachments, and the toolbar whose chips
 * open one popover at a time. It only changes the UI around the page's state; what is
 * sent is decided by the page, exactly as before.
 */
export function Composer({
  draft,
  onDraft,
  onKeyDown,
  textareaRef,
  placeholder,
  label = "Task description",
  sendLabel = "Send",
  disabled,
  busy,
  docked,
  variant = "page",
  onSubmit,
  settings,
  onSettings,
  tools,
  providers,
  modelBaseline,
  toolsBaseline,
  files,
  sources,
  mcpServers,
  onToggleFile,
  onToggleSource,
  onToggleMcp,
  onUploaded,
  uploadBatch = api.uploadToLibrary,
  attachmentsBusy = false,
  footer,
}) {
  const [open, setOpen] = useState(null); // "add" | "model" | "team" | "tools"
  const [addView, setAddView] = useState("menu"); // "menu" | "library" | "data" | "mcp"
  const [menuFocus, setMenuFocus] = useState(null);
  const [library, setLibrary] = useState(null);
  const [dataBody, setDataBody] = useState(null);
  const [mcpBody, setMcpBody] = useState(null);
  const [uploads, setUploads] = useState([]); // in flight or failed
  const loadLibrary = useAction();
  const loadData = useAction();
  const loadMcp = useAction();
  const boxRef = useRef(null);
  const inputRef = useRef(null);
  const chipRefs = { add: useRef(null), model: useRef(null), team: useRef(null), tools: useRef(null) };
  const popId = useId();
  const { run: runLibrary } = loadLibrary;
  const { run: runData } = loadData;
  const { run: runMcp } = loadMcp;

  // The + menu says what's there ("2 files ready"), so the lists load with the page.
  useEffect(() => {
    runLibrary(() => api.knowledgeOverview()).then((b) => b && setLibrary(b));
    runData(() => api.dataSources()).then((b) => b && setDataBody(b));
    runMcp(() => api.mcpServers()).then((b) => b && setMcpBody(b));
  }, [runLibrary, runData, runMcp]);

  // Grow the message box with its content, up to a cap.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_COMPOSER_HEIGHT)}px`;
  }, [draft, textareaRef]);

  const usableSources = (dataBody?.sources ?? []).filter((s) => s.tables.length > 0);
  const usableServers = mcpBody ? mcpBody.servers.filter((s) => s.tools.some((t) => t.usable)) : null;
  const chosenModel = providers.find((p) => modelKey(p) === settings.model);
  const noTools = cannotCallTools(chosenModel);
  const offered = toggleableTools(tools).map((t) => t.name);
  const chosenTools = settings.tools.filter((t) => offered.includes(t));
  const ready = (library?.documents ?? []).filter((d) => d.status === "ready").length;

  function toggle(id) {
    setOpen((current) => (current === id ? null : id));
    setAddView("menu");
    setMenuFocus(null);
  }

  function close({ restoreFocus }) {
    const id = open;
    setOpen(null);
    setAddView("menu");
    if (restoreFocus && id) chipRefs[id].current?.focus();
  }

  // Tab out of a popover: to its chip (backwards) or the next toolbar control (forwards).
  function tabOut(direction) {
    const id = open;
    setOpen(null);
    setAddView("menu");
    const chip = chipRefs[id].current;
    if (direction < 0) return chip?.focus();
    const controls = [...boxRef.current.querySelectorAll(".composer__bar button:not(:disabled)")];
    (controls[controls.indexOf(chip) + 1] ?? chip)?.focus();
  }

  function toggleTool(name) {
    const next = new Set(chosenTools);
    next.has(name) ? next.delete(name) : next.add(name);
    // Registry order, so the request is the same however the switches were clicked.
    onSettings({ tools: offered.filter((n) => next.has(n)) });
  }

  const has = (list, item) => list.some((x) => x.id === item.id);

  // The existing upload flow: checked in the page, sent in batches to the library, then
  // attached. Each file shows as a chip at once, with a spinner until it lands.
  async function addFiles(list) {
    if (!library) return;
    const { accepted, problems } = checkFiles(
      list,
      library.limits,
      library.documents.map((d) => d.filename),
    );
    const refused = list
      .filter((f) => !accepted.includes(f))
      .map((f) => ({
        key: ++nextUploadKey,
        filename: f.name,
        status: "error",
        error: problems.find((p) => p.startsWith(`${f.name}:`)) ?? problems.at(-1),
      }));
    const pending = accepted.map((f) => ({ key: ++nextUploadKey, filename: f.name, status: "uploading" }));
    const keys = new Set(pending.map((u) => u.key));
    setUploads((all) => [...all, ...refused, ...pending]);
    if (!accepted.length) return;
    try {
      const docs = [];
      for (const batch of batches(accepted, library.limits.max_files_per_upload)) {
        docs.push(...(await uploadBatch(batch)).documents);
      }
      setUploads((all) => all.filter((u) => !keys.has(u.key)));
      onUploaded(docs);
      setLibrary((lib) => ({ ...lib, documents: [...docs, ...lib.documents] }));
    } catch (error) {
      setUploads((all) =>
        all.map((u) => (keys.has(u.key) ? { ...u, status: "error", error: error.message } : u)),
      );
    }
  }

  function pickMenu(id) {
    if (id === "upload") {
      close({ restoreFocus: false });
      inputRef.current?.click();
      return;
    }
    setAddView(id);
  }

  const fileIds = new Set(files.map((f) => f.id));
  const sourceIds = new Set(sources.map((s) => s.id));
  const serverIds = new Set(mcpServers.map((s) => s.id));
  const attachments = [
    ...files.map((f) => ({ key: `f-${f.id}`, icon: File, name: f.filename, onRemove: () => onToggleFile(f, false) })),
    ...uploads.map((u) => ({
      key: `u-${u.key}`,
      icon: File,
      name: u.filename,
      status: u.status,
      error: u.error,
      onRemove: () => setUploads((all) => all.filter((x) => x.key !== u.key)),
    })),
    ...sources.map((s) => ({ key: `d-${s.id}`, icon: Database, name: s.name, onRemove: () => onToggleSource(s, false) })),
    ...mcpServers.map((s) => ({ key: `m-${s.id}`, icon: Plug, name: s.name, onRemove: () => onToggleMcp(s, false) })),
  ];

  const prefer = docked ? "above" : "below";
  const popProps = (id) => ({
    id: `${popId}-${id}`,
    anchorRef: chipRefs[id],
    boxRef,
    prefer,
    onClose: close,
    onTabOut: tabOut,
  });
  const chipProps = (id) => ({
    chipRef: chipRefs[id],
    open: open === id,
    popId: `${popId}-${id}`,
    onToggle: () => toggle(id),
    disabled,
  });

  const subTitle = { library: "Choose from library", data: "Add data source", mcp: "Attach MCP server" };

  return (
    <form className={`composer composer--${variant}`} onSubmit={onSubmit}>
      <div className="composer__inner">
        <div className="composer__box ap-focus-ring" ref={boxRef}>
          <textarea
            ref={textareaRef}
            rows={1}
            value={draft}
            onChange={(e) => onDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            aria-label={label}
            disabled={disabled}
          />
          {attachments.length > 0 && (
            <ul className="attachments" aria-label="Attachments for this project">
              {attachments.map((a) => {
                const AttIcon = a.status === "error" ? CircleAlert : a.icon;
                return (
                  <li
                    key={a.key}
                    className={`att ap-fade${a.status === "error" ? " att--error" : ""}`}
                    title={a.status === "error" ? a.error : a.name}
                  >
                    {a.status === "uploading" ? (
                      <span className="spin spin--sm" aria-hidden="true" />
                    ) : (
                      <AttIcon size={14} aria-hidden="true" className="att__ico" />
                    )}
                    <span className="att__name">{a.name}</span>
                    {a.status === "uploading" && <span className="sr-only">uploading</span>}
                    {a.status === "error" && <span className="sr-only">upload failed: {a.error}</span>}
                    <button
                      type="button"
                      onClick={a.onRemove}
                      aria-label={`Remove ${a.name}`}
                      disabled={a.status === "uploading" || attachmentsBusy}
                    >
                      <X size={12} aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="composer__bar">
            <Chip {...chipProps("add")} haspopup="menu" icon={Plus} iconOnly label="Add context" />
            <Chip
              {...chipProps("model")}
              haspopup="listbox"
              icon={Cpu}
              k="Model"
              value={!settings.model && modelBaseline ? modelBaseline.chip : modelChipValue(settings.model, providers)}
              changed={Boolean(settings.model)}
            />
            <Chip
              {...chipProps("team")}
              haspopup="dialog"
              icon={Users}
              k="Team"
              value={teamLabel(settings.agentCount)}
              changed={settings.agentCount != null}
            />
            <Chip
              {...chipProps("tools")}
              haspopup="dialog"
              icon={Wrench}
              k="Tools"
              value={toolCount({ tools: chosenTools, hasFiles: files.length > 0, noTools })}
              changed={toolsChanged(chosenTools, toolsBaseline ?? tools.default)}
            />
            <span className="composer__spacer" />
            <button
              type="submit"
              className={`composer__send${draft.trim() && !busy ? " ap-btn-primary" : ""}`}
              disabled={disabled || busy || !draft.trim()}
              aria-label={sendLabel}
            >
              {busy ? <span className="spin" /> : <ArrowUp size={18} aria-hidden="true" />}
            </button>
          </div>
        </div>
        {footer}
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
      </div>

      {open === "add" && (
        <Popover
          {...popProps("add")}
          role={addView === "menu" ? "menu" : "dialog"}
          label={addView === "menu" ? "Add context" : subTitle[addView]}
          className="cpop--menu"
        >
          {addView === "menu" && (
            <AddMenu
              initialFocus={menuFocus}
              onPick={pickMenu}
              descriptions={{
                upload: "PDF, Word, text, Markdown or CSV",
                library: library ? `${plural(ready, "file")} ready` : "Loading…",
                data: dataBody
                  ? usableSources.length
                    ? usableSources.map((s) => s.name).join(", ")
                    : "No data source with tables yet"
                  : "BigQuery tables",
                mcp: usableServers
                  ? usableServers.length
                    ? usableServers.map((s) => s.name).join(", ")
                    : "No server with approved tools yet"
                  : "Loading…",
              }}
            />
          )}
          {addView !== "menu" && (
            <SubView
              title={subTitle[addView]}
              onBack={() => {
                setMenuFocus(addView);
                setAddView("menu");
              }}
            >
              {addView === "library" &&
                (loadLibrary.error ? (
                  <p className="cpop__error">{loadLibrary.error.message}</p>
                ) : !library ? (
                  <p className="cpop__hint">Loading…</p>
                ) : library.documents.length === 0 ? (
                  <p className="cpop__hint">Your library is empty. Upload files from the + menu.</p>
                ) : (
                  <>
                    {library.documents.map((doc) => {
                      const { badge, label } = documentBadge(doc.status);
                      return (
                        <CheckRow
                          key={doc.id}
                          checked={fileIds.has(doc.id)}
                          onChange={() => onToggleFile(doc, !has(files, doc))}
                          disabled={busy}
                          icon={File}
                          name={doc.filename}
                          meta={formatBytes(doc.size_bytes)}
                        >
                          <StatusBadge status={badge} label={label} />
                        </CheckRow>
                      );
                    })}
                    <p className="cpop__hint">
                      Agents search these with knowledge_search; file text is sent to the embedding
                      provider to index it.
                    </p>
                  </>
                ))}
              {addView === "data" &&
                (loadData.error ? (
                  <p className="cpop__error">{loadData.error.message}</p>
                ) : !dataBody ? (
                  <p className="cpop__hint">Loading…</p>
                ) : usableSources.length === 0 ? (
                  <p className="cpop__hint">
                    No data source with tables yet. <a href="#/data">Connect BigQuery and choose tables</a> first.
                  </p>
                ) : (
                  <>
                    {usableSources.map((s) => (
                      <CheckRow
                        key={s.id}
                        checked={sourceIds.has(s.id)}
                        onChange={() => onToggleSource(s, !has(sources, s))}
                        disabled={busy}
                        icon={Database}
                        name={s.name}
                        meta={s.tables.map((t) => t.id).join(", ")}
                      />
                    ))}
                    <p className="cpop__hint">
                      Agents query these with sql_schema and sql_query: read-only, capped per query.
                      Results are sent to the agents&apos; model provider.
                    </p>
                  </>
                ))}
              {addView === "mcp" &&
                (loadMcp.error ? (
                  <p className="cpop__error">{loadMcp.error.message}</p>
                ) : !usableServers ? (
                  <p className="cpop__hint">Loading…</p>
                ) : usableServers.length === 0 ? (
                  <p className="cpop__hint">
                    No MCP server with approved tools yet. <a href="#/mcp">Connect a server and approve its tools</a> first.
                  </p>
                ) : (
                  <>
                    {usableServers.map((s) => (
                      <CheckRow
                        key={s.id}
                        checked={serverIds.has(s.id)}
                        onChange={() => onToggleMcp(s, !has(mcpServers, s))}
                        disabled={busy}
                        icon={Plug}
                        name={s.name}
                        meta={s.tools.filter((t) => t.usable).map((t) => t.name).join(", ")}
                      />
                    ))}
                    <p className="cpop__hint">
                      Agents can call these servers&apos; approved tools; whatever they pass to a tool is
                      sent to that server.
                    </p>
                  </>
                ))}
            </SubView>
          )}
        </Popover>
      )}

      {open === "model" && (
        <Popover {...popProps("model")} className="cpop--model">
          <ModelList
            value={settings.model}
            providers={providers}
            baseline={modelBaseline}
            onPick={(o) => {
              // New project: the platform default is "" (nothing sent). With a baseline
              // (the Assistant), only the "keep" row is "", and any model is explicit.
              const model = o.keep
                ? ""
                : !modelBaseline && o.default && !o.group
                  ? ""
                  : modelKey(o);
              onSettings({ model });
              close({ restoreFocus: true });
            }}
          />
        </Popover>
      )}

      {open === "team" && (
        <Popover {...popProps("team")} role="dialog" label="Team size" className="cpop--team">
          <TeamPanel
            agentCount={settings.agentCount}
            onChange={(agentCount) => onSettings({ agentCount })}
            onDone={() => close({ restoreFocus: true })}
          />
        </Popover>
      )}

      {open === "tools" && (
        <Popover {...popProps("tools")} role="dialog" label="Tools" className="cpop--tools">
          <ToolsPanel
            tools={tools}
            chosen={chosenTools}
            onToggle={toggleTool}
            files={files.length}
            noTools={noTools}
            modelLabel={chosenModel ? modelName(chosenModel) : ""}
            servers={usableServers}
            attached={mcpServers}
            onAttach={(s) => onToggleMcp(s, !has(mcpServers, s))}
            busy={busy || attachmentsBusy}
          />
        </Popover>
      )}
    </form>
  );
}
