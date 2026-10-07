import { useState } from "react";
import { Icon } from "./icons.jsx";

export function Panel({ title, subtitle, actions, children, footer, flush }) {
  return (
    <section className="panel">
      {(title || actions) && (
        <header className="panel__header">
          {title && <h2 className="panel__title">{title}</h2>}
          {subtitle && <span className="panel__sub">{subtitle}</span>}
          <div className="panel__spacer" />
          {actions}
        </header>
      )}
      {flush ? children : <div className="panel__body">{children}</div>}
      {footer && <div className="panel__footer">{footer}</div>}
    </section>
  );
}

export function PageHeader({ title, subtitle, meta, actions }) {
  return (
    <header className="pagehead">
      <div className="pagehead__text">
        {typeof title === "string" ? (
          <h1 className="pagehead__title">{title}</h1>
        ) : (
          title
        )}
        {subtitle && <p className="pagehead__sub">{subtitle}</p>}
        {meta && <div className="pagehead__meta">{meta}</div>}
      </div>
      {actions}
    </header>
  );
}

// The bar pinned to the bottom of a page: a status note on the left, the page's
// back/continue actions on the right.
export function ActionBar({ note, children }) {
  return (
    <div className="actionbar">
      <div className="actionbar__note">{note}</div>
      {children}
    </div>
  );
}

export function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
      {hint && <span className="field__hint">{hint}</span>}
    </label>
  );
}

function buttonClasses({ variant, size, block }) {
  return [
    "btn",
    variant && `btn--${variant}`,
    size && `btn--${size}`,
    block && "btn--block",
  ]
    .filter(Boolean)
    .join(" ");
}

export function Button({ variant, size, block, loading, children, ...props }) {
  return (
    <button
      type="button"
      className={buttonClasses({ variant, size, block })}
      {...props}
      disabled={loading || props.disabled}
    >
      {loading && <span className="spin" />}
      {children}
    </button>
  );
}

// A link that looks like a button, for navigation between pages.
export function LinkButton({ variant, size, block, children, ...props }) {
  return (
    <a className={buttonClasses({ variant, size, block })} {...props}>
      {children}
    </a>
  );
}

export function Switch({ checked, onChange, disabled, label }) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

export function Pill({ tone, dot, children }) {
  return (
    <span
      className={["pill", tone && `pill--${tone}`].filter(Boolean).join(" ")}
    >
      {dot && <span className="dot" />}
      {children}
    </span>
  );
}

export function Callout({ tone, title, children, detail }) {
  return (
    <div
      className={["callout", tone && `callout--${tone}`]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="callout__body">
        {title && <div className="callout__title">{title}</div>}
        {children}
        {detail && <pre className="callout__detail">{detail}</pre>}
      </div>
    </div>
  );
}

export function ErrorCallout({ error }) {
  if (!error) return null;
  const detail =
    error.details == null
      ? null
      : typeof error.details === "string"
        ? error.details
        : JSON.stringify(error.details, null, 2);
  return (
    <Callout tone="danger" title={error.errorType ?? "Error"} detail={detail}>
      {error.message}
    </Callout>
  );
}

export function Empty({ title, children, action }) {
  return (
    <div className="empty">
      {title && <div className="empty__title">{title}</div>}
      {children}
      {action && <div className="empty__action">{action}</div>}
    </div>
  );
}

// Key/value rows: pass [label, value] pairs; rows whose value is null are skipped.
export function MetaList({ rows }) {
  return (
    <div className="metalist">
      {rows
        .filter(([, value]) => value != null)
        .map(([label, value]) => (
          <div key={label} style={{ display: "contents" }}>
            <span className="metalist__key">{label}</span>
            <span className="metalist__val">{value}</span>
          </div>
        ))}
    </div>
  );
}

const STATUS = {
  idle: { label: "Idle", icon: null },
  queued: { label: "Queued", icon: "clock" },
  running: { label: "Running", icon: null },
  completed: { label: "Completed", icon: "check" },
  failed: { label: "Failed", icon: "close" },
  skipped: { label: "Skipped", icon: "skip" },
};

/** The state of a run or an agent: Idle, Queued, Running, Completed, Failed, Skipped. */
export function StatusBadge({ status, label }) {
  const s = STATUS[status] ?? STATUS.idle;
  return (
    <span className={`badge badge--${status}`}>
      {status === "running" ? (
        <span className="spin spin--sm" aria-hidden="true" />
      ) : (
        s.icon && <Icon name={s.icon} size={12} />
      )}
      {label ?? s.label}
    </span>
  );
}

export function Skeleton({ lines = 3 }) {
  return (
    <div className="skeleton" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <span
          key={i}
          className="skeleton__line"
          style={{ width: `${92 - i * 14}%` }}
        />
      ))}
    </div>
  );
}

/**
 * A trash button that asks for confirmation in place. `name` is what gets deleted (for the
 * accessible label); `onDelete` resolves to true on success.
 */
export function DeleteButton({ name, onDelete, prompt }) {
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function remove() {
    setDeleting(true);
    const ok = await onDelete();
    if (!ok) {
      setDeleting(false);
      setConfirm(false);
    }
  }

  if (confirm) {
    return (
      <span
        className="row confirm-delete"
        role="group"
        aria-label={`Confirm deleting ${name}`}
      >
        {prompt && <span className="confirm-delete__prompt">{prompt}</span>}
        <Button size="sm" variant="danger" onClick={remove} loading={deleting}>
          Delete
        </Button>
        <Button size="sm" onClick={() => setConfirm(false)} disabled={deleting}>
          Keep
        </Button>
      </span>
    );
  }
  return (
    <button
      type="button"
      className="iconbtn"
      onClick={() => setConfirm(true)}
      aria-label={`Delete ${name}`}
      title="Delete"
    >
      <Icon name="trash" />
    </button>
  );
}
