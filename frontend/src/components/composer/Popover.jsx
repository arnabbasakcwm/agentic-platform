import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

const GAP = 8; // between the composer and the popover
const MARGIN = 8; // kept clear inside the usable area

/**
 * The part of the viewport a popover may use: below the top bar, right of the sidebar
 * (when it sits beside the content rather than over it), less a margin.
 */
export function usableArea() {
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  let top = 0;
  let left = 0;
  const bar = document.querySelector(".topbar")?.getBoundingClientRect();
  if (bar && bar.height > 0 && bar.top <= 0) top = Math.max(top, bar.bottom);
  const side = document.querySelector(".sidebar")?.getBoundingClientRect();
  if (side && side.width > 0 && side.left <= 0 && side.right > 0 && side.right < vw / 2) {
    left = Math.max(left, side.right);
  }
  return { top: top + MARGIN, left: left + MARGIN, right: vw - MARGIN, bottom: vh - MARGIN };
}

/**
 * Where the popover goes: on the preferred side of the whole composer box (so it never
 * covers the text area or its own chip), flipped when that side is too short and the
 * other has more room; left-aligned with the chip, clamped inside the usable area; as
 * tall as its content or the room on that side, whichever is less (content scrolls
 * inside). Applied straight to the element, before paint.
 */
function place(pop, chip, box, prefer, onOutOfView) {
  const area = usableArea();
  const c = chip.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  if (c.bottom < area.top || c.top > area.bottom || c.width === 0) {
    onOutOfView();
    return;
  }
  pop.style.maxHeight = "none";
  pop.style.maxWidth = `${area.right - area.left}px`;
  // offset sizes: unaffected by the entrance animation's scale.
  const natural = pop.offsetHeight;
  const room = {
    below: Math.max(0, area.bottom - (b.bottom + GAP)),
    above: Math.max(0, b.top - GAP - area.top),
  };
  const other = prefer === "below" ? "above" : "below";
  const side = natural > room[prefer] && room[other] > room[prefer] ? other : prefer;
  const height = Math.min(natural, room[side]);
  const width = pop.offsetWidth;
  const left = Math.max(area.left, Math.min(c.left, area.right - width));
  pop.style.maxHeight = `${room[side]}px`;
  pop.style.top = `${side === "below" ? b.bottom + GAP : b.top - GAP - height}px`;
  pop.style.left = `${left}px`;
  pop.dataset.side = side;
}

/**
 * A popover in a portal at document.body (position: fixed), so no ancestor's overflow
 * or stacking can clip it. Closes on Esc (focus back to the chip), on a pointer press
 * outside it and its chips, and when its chip scrolls out of view; repositions on
 * scroll, resize and when the composer or the popover changes size.
 */
export function Popover({
  id,
  anchorRef,
  boxRef,
  prefer,
  role,
  label,
  className = "",
  onClose,
  onTabOut,
  children,
}) {
  const ref = useRef(null);
  // The latest handlers, without re-subscribing listeners on every render.
  const handlers = useRef({ onClose, onTabOut });
  useLayoutEffect(() => {
    handlers.current = { onClose, onTabOut };
  });

  useLayoutEffect(() => {
    const pop = ref.current;
    const chip = anchorRef.current;
    const box = boxRef.current;
    if (!pop || !chip || !box) return undefined;
    const update = () =>
      place(pop, chip, box, prefer, () => handlers.current.onClose({ restoreFocus: false }));
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    // The composer grows (text, attachments); the popover's content changes (a search,
    // a sub-view).
    const resized = new ResizeObserver(update);
    resized.observe(box);
    const changed = new MutationObserver(update);
    changed.observe(pop, { childList: true, subtree: true });
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      resized.disconnect();
      changed.disconnect();
    };
  }, [anchorRef, boxRef, prefer]);

  useEffect(() => {
    function onPointerDown(event) {
      const t = event.target;
      if (ref.current?.contains(t) || t.closest?.("[data-composer-chip]")) return;
      handlers.current.onClose({ restoreFocus: false });
    }
    function onKey(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        handlers.current.onClose({ restoreFocus: true });
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  // Tab past either end leaves the popover for the toolbar, not the end of the page
  // (the portal sits at the end of <body>).
  function onKeyDown(event) {
    if (event.key !== "Tab") return;
    const focusables = [
      ...ref.current.querySelectorAll(
        "button:not(:disabled), input:not(:disabled), a[href], [tabindex='0']",
      ),
    ];
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      handlers.current.onTabOut?.(-1);
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      handlers.current.onTabOut?.(1);
    }
  }

  return createPortal(
    <div
      id={id}
      ref={ref}
      role={role}
      aria-label={role ? label : undefined}
      className={`cpop ap-popover ${className}`}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>,
    document.body,
  );
}
