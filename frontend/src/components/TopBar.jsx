import { useTheme } from "../lib/theme.js";
import { Icon } from "./icons.jsx";
import { Pill } from "./ui.jsx";

const STATUS = {
  checking: { tone: undefined, label: "Checking API" },
  online: { tone: "success", label: "API online" },
  offline: { tone: "danger", label: "API unreachable" },
};

export function HealthPill({ health }) {
  const status = STATUS[health] ?? STATUS.checking;
  return (
    <Pill tone={status.tone} dot>
      {status.label}
    </Pill>
  );
}

/** Switches between light and dark; shows the theme you'd switch to. */
export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="iconbtn theme-toggle"
      onClick={toggle}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
    >
      <Icon name={next === "dark" ? "moon" : "sun"} />
    </button>
  );
}

// `crumbs` is the path to the current page: [{ label, href? }], last entry = this page.
export function TopBar({ crumbs, health }) {
  return (
    <header className="topbar">
      <nav className="crumbs" aria-label="Breadcrumb">
        {crumbs.map((crumb, i) => {
          const last = i === crumbs.length - 1;
          return (
            <span key={i} style={{ display: "contents" }}>
              {i > 0 && <span className="crumbs__sep">/</span>}
              {last || !crumb.href ? (
                <span className={last ? "crumbs__current" : undefined}>{crumb.label}</span>
              ) : (
                <a href={crumb.href}>{crumb.label}</a>
              )}
            </span>
          );
        })}
      </nav>
      <HealthPill health={health} />
      <ThemeToggle />
    </header>
  );
}
