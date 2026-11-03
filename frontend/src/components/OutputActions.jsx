import { Download, FileSpreadsheet, FileText, FileType } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { saveBlob } from "../lib/download.js";
import { Popover } from "./composer/Popover.jsx";

export const EXPORT_FORMATS = [
  { id: "docx", label: "Word", ext: ".docx", icon: FileText },
  { id: "pdf", label: "PDF", ext: ".pdf", icon: FileType },
  { id: "csv", label: "CSV", ext: ".csv", icon: FileSpreadsheet },
];

/**
 * "Export" ▾ — Word, PDF or CSV of one agent's output (`agentId`) or of the whole run,
 * made on the server (with its sources) and saved by the browser.
 */
export function ExportMenu({ projectId, runId, agentId, label }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(null); // the format being made
  const [error, setError] = useState(null);
  const buttonRef = useRef(null);
  const what = label ?? (agentId ? `${agentId} output` : "run output");

  async function download(format) {
    setOpen(false);
    setBusy(format);
    setError(null);
    try {
      const { blob, filename } = await api.exportRun(projectId, runId, format, agentId);
      saveBlob(blob, filename);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
      // After the re-render that enables the button again.
      requestAnimationFrame(() => buttonRef.current?.focus());
    }
  }

  return (
    <span className="outactions__export">
      <button
        ref={buttonRef}
        type="button"
        data-composer-chip=""
        className="btn btn--sm btn--outline"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Export ${what}`}
        onClick={() => setOpen((o) => !o)}
        disabled={Boolean(busy)}
      >
        {busy ? <span className="spin spin--sm" aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
        {busy ? "Exporting…" : "Export"}
      </button>
      {open && (
        <Popover
          anchorRef={buttonRef}
          boxRef={buttonRef}
          prefer="below"
          role="menu"
          label={`Export ${what} as`}
          className="cpop--export"
          onClose={({ restoreFocus }) => {
            setOpen(false);
            if (restoreFocus) buttonRef.current?.focus();
          }}
        >
          <ExportItems onPick={download} />
        </Popover>
      )}
      {error && (
        <span className="outactions__error" role="alert">
          Export failed: {error.message}
        </span>
      )}
    </span>
  );
}

function ExportItems({ onPick }) {
  const listRef = useRef(null);
  useEffect(() => {
    listRef.current?.querySelector("[role=menuitem]")?.focus();
  }, []);

  function onKeyDown(event) {
    const items = [...listRef.current.querySelectorAll("[role=menuitem]")];
    const at = items.indexOf(document.activeElement);
    const go = (i) => {
      event.preventDefault();
      items[(i + items.length) % items.length].focus();
    };
    if (event.key === "ArrowDown") go(at + 1);
    else if (event.key === "ArrowUp") go(at - 1);
  }

  return (
    <div
      className="cpop__body cmenu"
      ref={listRef}
      onKeyDown={onKeyDown}
    >
      {EXPORT_FORMATS.map((f) => {
        const FormatIcon = f.icon;
        return (
          <button
            key={f.id}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="cmenu__item cmenu__item--compact"
            onClick={() => onPick(f.id)}
          >
            <FormatIcon size={15} aria-hidden="true" />
            <span className="cmenu__t">{f.label}</span>
            <span className="cmenu__d">{f.ext}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The actions on a finished output: Export (and, with email, Send by email). */
export function OutputActions({ projectId, runId, agentId, label, children }) {
  if (!projectId || !runId) return null;
  return (
    <span className="outactions">
      <ExportMenu projectId={projectId} runId={runId} agentId={agentId} label={label} />
      {children}
    </span>
  );
}
