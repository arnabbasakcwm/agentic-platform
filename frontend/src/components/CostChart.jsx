import { useId, useState } from "react";
import { formatCost, formatCount, niceScale, shortDate } from "../lib/usage.js";

// Estimated cost per day as columns: one series in the violet → pink bar gradient, the
// latest day (or the one pointed at) in orange (DESIGN.md §2), columns capped at 24px with
// a 4px rounded top and a square baseline, a 2px gap between neighbours, hairline
// gridlines. Bars grow up from the baseline, staggered, on first show (.ap-bar-grow). Each day is a hit target (the full column
// slot, not just the painted bar); the chart is one tab stop and the arrow keys move
// between days. Every value is also in the table view, so the tooltip never gates data.

const W = 720;
const H = 220;
const PAD = { top: 12, right: 8, bottom: 28, left: 56 };
const MAX_BAR = 24;
const GAP = 2;
const RADIUS = 4;

function columnPath(x, y, w, h) {
  const r = Math.min(RADIUS, h, w / 2);
  const base = y + h;
  return `M${x},${base}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${base}Z`;
}

export function CostChart({ days, currency = "USD" }) {
  const [active, setActive] = useState(null);
  const [showTable, setShowTable] = useState(false);
  const titleId = useId();
  const barFill = useId();
  const hotFill = useId();
  const latest = days.reduce((last, d, i) => (d.cost > 0 ? i : last), -1);
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const scale = niceScale(Math.max(0, ...days.map((d) => d.cost)));
  const slot = plotW / Math.max(days.length, 1);
  const barW = Math.max(2, Math.min(MAX_BAR, slot - GAP));
  const labelEvery = Math.ceil(days.length / 6);
  const y = (v) => PAD.top + plotH - (v / scale.max) * plotH;
  const focused = active !== null ? days[active] : null;

  function onKeyDown(event) {
    if (!days.length) return;
    const last = days.length - 1;
    const moves = { ArrowRight: 1, ArrowLeft: -1, Home: -Infinity, End: Infinity };
    if (!(event.key in moves)) return;
    event.preventDefault();
    setActive((current) => {
      const base = current ?? (moves[event.key] > 0 ? -1 : last + 1);
      return Math.min(last, Math.max(0, base + moves[event.key]));
    });
  }

  return (
    <div className="costchart">
      <div className="costchart__frame">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="costchart__svg"
          role="group"
          aria-labelledby={titleId}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onBlur={() => setActive(null)}
          onPointerLeave={() => setActive(null)}
        >
          <title id={titleId}>Estimated cost per day. Use the left and right arrow keys to read each day.</title>
          <defs>
            <linearGradient id={barFill} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" className="costchart__stop-top" />
              <stop offset="1" className="costchart__stop-bottom" />
            </linearGradient>
            <linearGradient id={hotFill} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" className="costchart__stop-hot-top" />
              <stop offset="1" className="costchart__stop-hot-bottom" />
            </linearGradient>
          </defs>
          {scale.ticks.map((t) => (
            <g key={t}>
              <line className="costchart__grid" x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} />
              <text className="costchart__tick" x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
                {formatCost(t, currency)}
              </text>
            </g>
          ))}
          {days.map((d, i) => {
            const x = PAD.left + i * slot + (slot - barW) / 2;
            const h = d.cost > 0 ? Math.max(1, PAD.top + plotH - y(d.cost)) : 0;
            return (
              <g key={d.date}>
                {h > 0 && (
                  <path
                    className={`costchart__bar ap-bar-grow${active === i ? " costchart__bar--active" : ""}`}
                    d={columnPath(x, PAD.top + plotH - h, barW, h)}
                    fill={`url(#${active === i || (active === null && i === latest) ? hotFill : barFill})`}
                    style={{ "--i": i }}
                  />
                )}
                {/* The whole slot is the hit target, so short or empty days are easy to point at. */}
                <rect
                  className="costchart__hit"
                  x={PAD.left + i * slot}
                  y={PAD.top}
                  width={slot}
                  height={plotH}
                  onPointerEnter={() => setActive(i)}
                />
                {i % labelEvery === 0 && (
                  <text className="costchart__tick" x={PAD.left + i * slot + slot / 2} y={H - 8} textAnchor="middle">
                    {shortDate(d.date)}
                  </text>
                )}
              </g>
            );
          })}
          <line className="costchart__axis" x1={PAD.left} x2={W - PAD.right} y1={PAD.top + plotH} y2={PAD.top + plotH} />
        </svg>
        {focused && (
          <div
            className="costchart__tip"
            style={{ left: `${((PAD.left + (active + 0.5) * slot) / W) * 100}%` }}
            aria-hidden="true"
          >
            <strong>~{formatCost(focused.cost, currency)}</strong>
            <span>{shortDate(focused.date)}</span>
            <span>
              {formatCount(focused.input_tokens)} in · {formatCount(focused.output_tokens)} out
            </span>
            {focused.unpriced_tokens > 0 && <span>{formatCount(focused.unpriced_tokens)} tokens unpriced</span>}
          </div>
        )}
        {/* Announces the day the arrow keys land on. */}
        <p className="sr-only" aria-live="polite">
          {focused
            ? `${shortDate(focused.date)}: about ${formatCost(focused.cost, currency)}, ${formatCount(focused.input_tokens)} input and ${formatCount(focused.output_tokens)} output tokens`
            : ""}
        </p>
      </div>
      <button type="button" className="linkbtn" onClick={() => setShowTable((s) => !s)} aria-expanded={showTable}>
        {showTable ? "Hide table" : "Show as table"}
      </button>
      {showTable && (
        <div className="costchart__table" tabIndex={0} role="region" aria-label="Cost per day table">
          <table className="table">
            <thead>
              <tr>
                <th>Day</th>
                <th className="table__num">Est. cost</th>
                <th className="table__num">Input tokens</th>
                <th className="table__num">Output tokens</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.date}>
                  <td>{shortDate(d.date)}</td>
                  <td className="table__num">{formatCost(d.cost, currency)}</td>
                  <td className="table__num">{formatCount(d.input_tokens)}</td>
                  <td className="table__num">{formatCount(d.output_tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
