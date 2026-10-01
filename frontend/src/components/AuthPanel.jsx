import { useState } from "react";
import { Button, Callout, ErrorCallout, Field, Panel } from "./ui.jsx";

const MIN_PASSWORD = 8; // mirrors the API's rule, so most mistakes never cost a request

const MODES = {
  login: { tab: "Sign in", submit: "Sign in", busy: "Signing in…" },
  register: { tab: "Create account", submit: "Create account", busy: "Creating account…" },
};

export function AuthPanel({ onLogin, onRegister, busy, error, notice, disabled }) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState(null);

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
    <form className="auth" onSubmit={submit}>
      <Panel
        title={registering ? "Create your account" : "Sign in to the console"}
        footer={
          <Button
            type="submit"
            variant="primary"
            block
            loading={busy}
            disabled={disabled || !email.trim() || !password}
          >
            {busy ? labels.busy : labels.submit}
          </Button>
        }
      >
        <div className="tabs" role="tablist">
          {Object.entries(MODES).map(([key, m]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={mode === key}
              className={mode === key ? "tab tab--active" : "tab"}
              onClick={() => switchMode(key)}
            >
              {m.tab}
            </button>
          ))}
        </div>

        {notice && (
          <div style={{ marginBottom: 16 }}>
            <Callout tone="warn">{notice}</Callout>
          </div>
        )}

        <Field label="Email">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            placeholder="you@company.com"
            disabled={disabled}
            required
          />
        </Field>

        <Field
          label="Password"
          hint={registering ? `At least ${MIN_PASSWORD} characters.` : undefined}
        >
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={registering ? "new-password" : "current-password"}
            disabled={disabled}
            required
          />
        </Field>

        {registering && (
          <Field label="Confirm password">
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              disabled={disabled}
              required
            />
          </Field>
        )}

        {localError ? (
          <Callout tone="danger">{localError}</Callout>
        ) : (
          <ErrorCallout error={error} />
        )}
      </Panel>
    </form>
  );
}
