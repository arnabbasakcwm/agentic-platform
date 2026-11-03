// A tiny line chart for a KPI tile (TECH_STACK.md: hand-built, one SVG path). It draws
// itself left to right on first show (.ap-draw-line); colour comes from the tile
// (currentColor). Decorative: the tile's number and the page's tables carry the data.

const W = 120;
const H = 32;
const PAD = 2;

export function Sparkline({ values }) {
  if (!values || values.length < 2) return null;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const step = (W - 2 * PAD) / (values.length - 1);
  const points = values.map((v, i) => [
    PAD + i * step,
    H - PAD - ((v - min) / span) * (H - 2 * PAD),
  ]);
  const line = points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  const area = `${line}L${points.at(-1)[0].toFixed(1)},${H}L${PAD},${H}Z`;
  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <path className="sparkline__area" d={area} />
      {/* pathLength fixes the dash length the draw-in animation uses. */}
      <path className="sparkline__line ap-draw-line" d={line} pathLength="400" />
    </svg>
  );
}
