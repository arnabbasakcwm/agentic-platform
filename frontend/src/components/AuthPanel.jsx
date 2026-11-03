import { useId, useState } from "react";
import { Icon } from "./icons.jsx";
import { Button, Callout, ErrorCallout, SlidingThumb } from "./ui.jsx";

const MIN_PASSWORD = 8; // mirrors the API's rule, so most mistakes never cost a request

const MODES = {
  login: {
    tab: "Sign in",
    title: "Sign in",
    sub: "Welcome back. Pick up your projects where you left them.",
    submit: "Sign in",
    busy: "Signing in…",
  },
  register: {
    tab: "Create account",
    title: "Create your account",
    sub: "Your projects, documents and runs stay private to your account.",
    submit: "Create account",
    busy: "Creating account…",
  },
};

/** A password input with a show/hide button; the hint (if any) describes the input. */
function PasswordField({ id, label, value, onChange, autoComplete, disabled, hint }) {
  const [shown, setShown] = useState(false);
  const hintId = `${id}-hint`;
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <div className="pwfield">
        <input
          id={id}
          type={shown ? "text" : "password"}
          value={value}
          onChange={onChange}
          autoComplete={autoComplete}
          aria-describedby={hint ? hintId : undefined}
          disabled={disabled}
          required
        />
        <button
          type="button"
          className="pwfield__toggle"
          onClick={() => setShown((s) => !s)}
          aria-label={shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          aria-pressed={shown}
          disabled={disabled}
        >
          <Icon name={shown ? "eyeOff" : "eye"} />
        </button>
      </div>
      {hint && (
        <span className="field__hint" id={hintId}>
          {hint}
        </span>
      )}
    </div>
  );
}

export function AuthPanel({ onLogin, onRegister, busy, error, notice, disabled }) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState(null);
  const id = useId();

  const registering = mode === "register";
  const labels = MODES[mode];

  function switchMode(next) {
    setMode(next);
    setPassword("");
    setConfirm("");
    setLocalError(null);
  }

  function submit(event) {
    event.preventDefault();
    if (registering && password.length < MIN_PASSWORD) {
      setLocalError(`Password must be at least ${MIN_PASSWORD} characters.`);
      return;
    }
    if (registering && password !== confirm) {
      setLocalError("The two passwords don't match.");
      return;
    }
    setLocalError(null);
    (registering ? onRegister : onLogin)({ email: email.trim(), password });
  }

  return (
    <form className="auth" onSubmit={submit} aria-labelledby={`${id}-title`}>
      <h1 className="auth__title" id={`${id}-title`}>
        {labels.title}
      </h1>
      <p className="auth__sub">{labels.sub}</p>

      <div className="auth__modes" role="tablist" aria-label="Sign in or create an account">
        <SlidingThumb on={mode} active=".auth__mode--on" />
        {Object.entries(MODES).map(([key, m]) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`${id}-tab-${key}`}
            aria-selected={mode === key}
            aria-controls={`${id}-panel`}
            className={mode === key ? "auth__mode auth__mode--on" : "auth__mode"}
            onClick={() => switchMode(key)}
          >
            {m.tab}
          </button>
        ))}
      </div>

      <div
        className="auth__fields"
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-tab-${mode}`}
      >
        {notice && <Callout tone="warn">{notice}</Callout>}
        {disabled && (
          <Callout tone="warn">
            The platform API isn't reachable right now, so you can't sign in. Check that the
            server is running, then try again.
          </Callout>
        )}

        <div className="field">
          <label className="field__label" htmlFor={`${id}-email`}>
            Email
          </label>
          <input
            id={`${id}-email`}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            placeholder="you@company.com"
            disabled={disabled}
            required
          />
        </div>

        <PasswordField
          key={`password-${mode}`}
          id={`${id}-password`}
          label="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={registering ? "new-password" : "current-password"}
          disabled={disabled}
          hint={registering ? `At least ${MIN_PASSWORD} characters.` : undefined}
        />

        {registering && (
          <PasswordField
            id={`${id}-confirm`}
            label="Confirm password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            disabled={disabled}
          />
        )}

        {localError ? (
          <Callout tone="danger">{localError}</Callout>
        ) : (
          <ErrorCallout error={error} />
        )}

        <Button
          type="submit"
          variant="primary"
          block
          loading={busy}
          disabled={disabled || !email.trim() || !password}
        >
          {busy ? labels.busy : labels.submit}
          {!busy && <Icon name="arrowRight" size={14} />}
        </Button>
      </div>
    </form>
  );
}
