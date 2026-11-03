# Agentic Platform redesign: handoff package for Claude Code

## What's inside
| Path | What it is |
|---|---|
| `CLAUDE_CODE_PROMPT.md` | The prompt to paste into Claude Code |
| `TECH_STACK.md` | Stack decisions for this codebase: keep React 19/Vite 7/plain JS/hash router/plain CSS/React Flow + dagre; add @fontsource, lucide-react, Playwright and axe; optional CodeMirror and Radix primitives |
| `DESIGN.md` | Full design spec: palette and colour mappings, type, layout, shared components, per-page notes, motion (global + per page), and what NOT to copy from the Stitch screens |
| `reference/phase-chrome.html` + `.png` | Working HTML/CSS reference for the parts that must be identical on every project phase: project header, phase stepper (Brief / Plan / Compile / Run states), sticky footer, run-graph agent node. **Source of truth** for these. |
| `tokens/tokens.css` | Token values (colours, gradients, fonts, radii, shadows, motion timings, dark theme), to merge into `src/styles.css` |
| `tokens/motion.css` | Animation classes: page/card enter, button shimmer, live dots, skeletons, sliding indicators, running-node glow, animated React Flow edges, stepper fill, chart bar grow, sparkline draw, check draw, toasts, modal, drawer; all off under prefers-reduced-motion |
| `tokens/useCountUp.js` | React hook for the KPI count-up animation |
| `screenshots/` | Full-page captures of the Stitch screens (1536px wide): 00 Sign in, 01 New project, 02 Brief, 03 Plan, 04 Compile, 05 Run, 06 Usage |

## How to use
1. Unzip into your repo as `design/`.
2. Optional: in Stitch, select the screens → **Export** → code, and unzip it to `design/stitch-code/` for markup reference.
3. Run `claude` in the repo and paste the prompt from `CLAUDE_CODE_PROMPT.md`.

## Notes
- The screenshots show the look and layout. Stitch filled them with sample content, and some features in them don't exist in the app; DESIGN.md §8 lists what to ignore.
- Stitch draws the phase stepper and header with small differences from screen to screen. `reference/phase-chrome.html` defines the one correct version.
- Stitch project: https://stitch.withgoogle.com/projects/6730811640639010643 (use the multi-colour row of screens).
