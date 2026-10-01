import { Icon } from "./icons.jsx";

// `steps`: [{ key, label, hint, done, href }]. Every step is a link — the workflow
// suggests an order but never locks a page.
export function Stepper({ steps, current }) {
  return (
    <nav className="stepper" aria-label="Project workflow">
      {steps.map((step, i) => {
        const isCurrent = step.key === current;
        const state = isCurrent ? "current" : step.done ? "done" : "todo";
        return (
          <a
            key={step.key}
            href={step.href}
            className={`step step--${state}`}
            aria-current={isCurrent ? "step" : undefined}
          >
            <span className="step__index">
              {state === "done" ? <Icon name="check" size={12} /> : String(i + 1).padStart(2, "0")}
            </span>
            <span className="step__text">
              <span className="step__label">{step.label}</span>
              <span className="step__hint">{step.hint}</span>
            </span>
          </a>
        );
      })}
    </nav>
  );
}
