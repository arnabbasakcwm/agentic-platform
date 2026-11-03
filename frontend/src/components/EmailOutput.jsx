import { Mail } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { checkEmailForm, splitAddresses } from "../lib/email.js";
import { Icon } from "./icons.jsx";
import { EXPORT_FORMATS } from "../lib/exports.js";
import { ErrorCallout, Switch } from "./ui.jsx";

/**
 * "Send by email": a modal to email one agent's output (or the whole run) with Word, PDF
 * and/or CSV attachments, made by the same export as the Export menu. The form is checked
 * here for quick feedback; the server checks everything again.
 */
export function EmailButton({ projectId, projectName, runId, agentId, label }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef(null);
  const what = label ?? (agentId ? `${agentId} output` : "run output");
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="btn btn--sm btn--outline"
        aria-label={`Send ${what} by email`}
        onClick={() => setOpen(true)}
      >
        <Mail size={14} aria-hidden="true" />
        Email
      </button>
      {open && (
        <EmailDialog
          projectId={projectId}
          runId={runId}
          agentId={agentId}
          defaultSubject={`${projectName ?? "Project"} — ${agentId ?? "run"} output`}
          onClose={() => {
            setOpen(false);
            requestAnimationFrame(() => buttonRef.current?.focus());
          }}
        />
      )}
    </>
  );
}

function EmailDialog({ projectId, runId, agentId, defaultSubject, onClose }) {
  const ref = useRef(null);
  const id = useId();
  const [form, setForm] = useState({
    to: "",
    cc: "",
    subject: defaultSubject,
    message: "",
    formats: ["pdf"],
    includeBody: true,
  });
  const [problems, setProblems] = useState({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal?.();
  }, []);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  async function submit(event) {
    event.preventDefault();
    const found = checkEmailForm(form);
    setProblems(found);
    const first = ["to", "cc", "subject", "formats"].find((name) => found[name]);
    if (first) {
      // The first field with a problem (the formats' first checkbox).
      const target =
        first === "formats"
          ? ref.current?.querySelector(".emailmodal__formats input")
          : document.getElementById(`${id}-${first}`);
      target?.focus();
      return;
    }
    setSending(true);
    setError(null);
    try {
      const res = await api.emailRun(projectId, runId, {
        to: splitAddresses(form.to),
        cc: splitAddresses(form.cc),
        subject: form.subject.trim(),
        message: form.message,
        formats: form.formats,
        includeBody: form.includeBody,
        agentId,
      });
      setDone(res);
    } catch (e) {
      setError(e);
    } finally {
      setSending(false);
    }
  }

  const field = (name) => ({
    id: `${id}-${name}`,
    "aria-invalid": Boolean(problems[name]),
    "aria-describedby": problems[name] ? `${id}-${name}-error` : undefined,
  });
  const problem = (name) =>
    problems[name] ? (
      <span className="field__error" id={`${id}-${name}-error`}>
        {problems[name]}
      </span>
    ) : null;

  return (
    <dialog
      ref={ref}
      className="modal emailmodal ap-modal"
      aria-labelledby={`${id}-title`}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form className="modal__inner" onSubmit={submit} noValidate>
        <header className="modal__header">
          <h2 className="modal__title" id={`${id}-title`}>
            Send by email
          </h2>
          <button type="button" className="iconbtn" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </header>
        {done ? (
          <div className="modal__body">
            <p role="status" className="emailmodal__done">
              Sent to {done.recipients} recipient{done.recipients === 1 ? "" : "s"} with{" "}
              {done.attachments.join(", ")}.
            </p>
            <div className="modal__actions">
              <button type="button" className="btn btn--primary ap-btn-primary" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <div className="modal__body">
            <div className="field">
              <label className="field__label" htmlFor={`${id}-to`}>
                To
              </label>
              <input
                {...field("to")}
                type="text"
                inputMode="email"
                autoComplete="email"
                value={form.to}
                onChange={(e) => set({ to: e.target.value })}
                placeholder="name@example.com, another@example.com"
              />
              {problem("to")}
            </div>
            <div className="field">
              <label className="field__label" htmlFor={`${id}-cc`}>
                CC (optional)
              </label>
              <input
                {...field("cc")}
                type="text"
                inputMode="email"
                value={form.cc}
                onChange={(e) => set({ cc: e.target.value })}
              />
              {problem("cc")}
            </div>
            <div className="field">
              <label className="field__label" htmlFor={`${id}-subject`}>
                Subject
              </label>
              <input
                {...field("subject")}
                type="text"
                maxLength={200}
                value={form.subject}
                onChange={(e) => set({ subject: e.target.value })}
              />
              {problem("subject")}
            </div>
            <div className="field">
              <label className="field__label" htmlFor={`${id}-message`}>
                Message (optional)
              </label>
              <textarea
                {...field("message")}
                rows={3}
                maxLength={5000}
                value={form.message}
                onChange={(e) => set({ message: e.target.value })}
              />
            </div>
            <fieldset
              className="emailmodal__formats"
              aria-invalid={Boolean(problems.formats)}
              aria-describedby={problems.formats ? `${id}-formats-error` : undefined}
            >
              <legend className="field__label">Attach as</legend>
              {EXPORT_FORMATS.map((f) => (
                <label key={f.id} className="emailmodal__format">
                  <input
                    type="checkbox"
                    checked={form.formats.includes(f.id)}
                    onChange={(e) =>
                      set({
                        formats: EXPORT_FORMATS.map((x) => x.id).filter((x) =>
                          x === f.id ? e.target.checked : form.formats.includes(x),
                        ),
                      })
                    }
                  />
                  {f.label} <span className="muted">{f.ext}</span>
                </label>
              ))}
              {problem("formats")}
            </fieldset>
            <label className="row gap-xs emailmodal__switch">
              <Switch
                checked={form.includeBody}
                onChange={(on) => set({ includeBody: on })}
                label="Include output in email body"
              />
              <span>Include output in email body</span>
            </label>
            <ErrorCallout error={error} />
            <div className="modal__actions">
              <button type="button" className="btn btn--ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn btn--primary ap-btn-primary" disabled={sending}>
                {sending ? <span className="spin spin--sm" aria-hidden="true" /> : <Mail size={14} aria-hidden="true" />}
                {sending ? "Sending…" : "Send"}
              </button>
            </div>
          </div>
        )}
      </form>
    </dialog>
  );
}
