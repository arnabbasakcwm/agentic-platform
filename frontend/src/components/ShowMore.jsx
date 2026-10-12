import { useState } from "react";
import { ROWS_SHOWN, visibleRows } from "../lib/usage.js";
import { Icon } from "./icons.jsx";

/**
 * A list that shows its first few rows, then a down-arrow button that opens the rest
 * (and points up to close them again). `children` renders the rows it's given; `noun`
 * names them for screen readers ("Show all 9 models").
 */
export function ShowMore({ rows, noun, limit = ROWS_SHOWN, children }) {
  const [open, setOpen] = useState(false);
  const label = open ? "Show fewer" : `Show all ${rows.length} ${noun}`;
  return (
    <>
      {children(visibleRows(rows, open, limit))}
      {rows.length > limit && (
        <div className="showmore">
          <button
            type="button"
            className="showmore__button"
            aria-expanded={open}
            aria-label={label}
            title={label}
            onClick={() => setOpen((o) => !o)}
          >
            <span
              className={`showmore__icon${open ? " showmore__icon--open" : ""}`}
              aria-hidden="true"
            >
              <Icon name="chevronDown" size={18} />
            </span>
          </button>
        </div>
      )}
    </>
  );
}
