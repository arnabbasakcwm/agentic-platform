// Pure layout helpers.

// The plan assistant's width, in px: dragged by the user, kept within limits that always
// leave the page usable.
export const ASSISTANT_WIDTH = { default: 360, min: 300, max: 900, pageMin: 360 };

/**
 * A width the assistant may take beside a workspace `available` px wide: at least `min`,
 * at most `max`, and never so wide that the page column gets less than `pageMin`
 * (`overlay` panels slide over the page, so they only keep a small margin instead).
 */
export function clampWidth(width, available, { overlay = false } = {}) {
  const { min, max, pageMin } = ASSISTANT_WIDTH;
  const room = overlay ? available - 48 : available - pageMin;
  const upper = Math.max(min, Math.min(max, room));
  const value = Number.isFinite(width) ? width : ASSISTANT_WIDTH.default;
  return Math.round(Math.min(upper, Math.max(min, value)));
}
