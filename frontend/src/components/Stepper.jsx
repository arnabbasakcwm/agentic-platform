import { useState } from "react";
import { Icon } from "./icons.jsx";

const doneMap = (steps) => Object.fromEntries(steps.map((s) => [s.key, s.done]));

/**
 * The project's phase stepper (DESIGN.md §5.4, ported 1:1 from
 * design/reference/phase-chrome.html). One component, identical on every phase page:
 * the states describe the project, so only the highlighted current step moves.
 *
 * `steps`: [{ key, label, hint, done, busy, href }] in order; `busy` (a run in progress)
 * makes that step's circle pulse. Every step is a link — the
 * workflow suggests an order but never locks a page.
 *
 * - Done: circle filled in the phase colour with a white check.
 * - Current: a soft tint behind the column, a 4px ring, label in the phase colour.
 * - Pending: white circle, grey number, muted label.
 * - The connector to the next step is in this phase's colour only when this step AND the
 *   next are done; otherwise grey. It runs from one circle's edge to the next, never
 *   past the first or last circle. A connector that turns coloured while the page is
 *   open fills left to right, and the circle swaps its number for a check with a pop.
 */
export function Stepper({ steps, current }) {
  // Steps that became done while the stepper was showing animate once (React's "store
  // the previous value in state" pattern; nothing animates on first render).
  const doneKey = steps.map((s) => `${s.key}:${s.done ? 1 : 0}`).join(",");
  const [seen, setSeen] = useState({ key: doneKey, done: doneMap(steps), fresh: [] });
  if (seen.key !== doneKey) {
    setSeen({
      key: doneKey,
      done: doneMap(steps),
      fresh: steps.filter((s) => s.done && seen.done[s.key] === false).map((s) => s.key),
    });
  }
  const justDone = (key) => seen.fresh.includes(key);

  return (
    <nav className="stepper" aria-label="Project phases">
      <ol className="steps">
        {steps.map((step, i) => {
          const isCurrent = step.key === current;
          const next = steps[i + 1];
          const linkDone = step.done && next?.done;
          const classes = [
            "step",
            step.done && "step--done",
            isCurrent && "step--current",
            step.busy && "step--busy",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <li key={step.key} className="steps__item">
              <a
                href={step.href}
                className={classes}
                data-phase={step.key}
                aria-current={isCurrent ? "step" : undefined}
                title={`${i + 1}. ${step.label} — ${step.hint}`}
              >
                <span
                  className={`step__dot${justDone(step.key) ? " ap-pop" : ""}`}
                  aria-hidden="true"
                >
                  {step.done ? <Icon name="check" size={14} /> : i + 1}
                </span>
                <span className="step__label">
                  {i + 1}. {step.label}
                </span>
                <span className="step__hint">{step.hint}</span>
              </a>
              {next && (
                <span
                  className={[
                    "step__line",
                    linkDone && "step__line--done",
                    linkDone &&
                      (justDone(step.key) || justDone(next.key)) &&
                      "ap-connector-fill",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  data-phase={step.key}
                  aria-hidden="true"
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
