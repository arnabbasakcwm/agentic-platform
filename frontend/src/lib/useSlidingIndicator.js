import { useLayoutEffect } from "react";

/**
 * Positions a sliding indicator (the sidebar's active pill, a tab underline, a segmented
 * control's thumb) under the active item: measures the item matching `activeSelector`
 * inside `containerRef` and sets --ind-x / --ind-y / --ind-w / --ind-h (px, relative to
 * the container) and data-indicator="on" on the container. The CSS draws the indicator
 * and animates it with .ap-nav-indicator, so the motion stops under reduced motion while
 * the indicator still lands in the right place.
 *
 * `deps` re-measures when what's active (or the list) changes; a ResizeObserver keeps it
 * in place when the layout changes size.
 */
export function useSlidingIndicator(containerRef, activeSelector, deps = []) {
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const place = () => {
      const active = container.querySelector(activeSelector);
      if (!active || active.offsetParent === null) {
        container.dataset.indicator = "off";
        return;
      }
      const box = container.getBoundingClientRect();
      const rect = active.getBoundingClientRect();
      const x = rect.left - box.left + container.scrollLeft;
      const y = rect.top - box.top + container.scrollTop;
      container.style.setProperty("--ind-x", `${x}px`);
      container.style.setProperty("--ind-y", `${y}px`);
      container.style.setProperty("--ind-w", `${rect.width}px`);
      container.style.setProperty("--ind-h", `${rect.height}px`);
      container.dataset.indicator = "on";
    };

    place();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(place);
    observer.observe(container);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, activeSelector, ...deps]);
}
