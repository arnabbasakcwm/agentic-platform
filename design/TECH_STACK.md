# Tech stack for the redesign

The redesign is a visual reskin, and the current stack already suits it. **Keep everything that works; add only four small dependencies (two runtime, two dev).** No framework, router, state or styling-framework changes.

## Unchanged
| Area | Current | Decision |
|---|---|---|
| Framework | React 19, plain JavaScript (.jsx) | **Keep.** Don't convert to TypeScript during the reskin; mixing a language migration with a visual change makes regressions hard to trace. Optionally add JSDoc types on the new shared components. |
| Build | Vite 7 + @vitejs/plugin-react, `/api` proxied to :8000 | **Keep.** |
| Routing | Hand-written hash router (`src/lib/router.js`) | **Keep.** The breadcrumb and phase stepper links use the existing `#/projects/<id>/<phase>` routes. |
| State | Built-in hooks + `useProjectRun`, `useAction`, `useDeployedRuns`, `useToolCheck` | **Keep, don't touch.** The Run-graph animations read their status from `useProjectRun` / SSE events. |
| API | `fetch` in `src/lib/api.js`, SSE reader in `src/lib/sse.js` | **Keep, don't touch.** |
| Run diagram | React Flow (`@xyflow/react`) + dagre | **Keep.** Restyle with custom node types and an edge `className`; keep the dagre layout. Set the node width in dagre to 220px to match the new AgentNode. |
| Markdown | react-markdown + remark-gfm (no raw HTML) | **Keep**, including the no-raw-HTML rule. Just restyle the typography. |
| Charts | Hand-built `CostChart.jsx` | **Keep and extend**: gradient bars, grow-in animation, tooltip. Add a tiny hand-built `Sparkline.jsx` (an SVG path) for the KPI tiles. No chart library is needed. |

## Styling: stay with plain CSS + variables
- **No Tailwind, no CSS-in-JS, no component framework** (MUI, Ant, shadcn). The app already has one variable-driven CSS file with light and dark themes, which is exactly what the tokens need.
- **Merge** `design/tokens/tokens.css` into `src/styles.css`: map new values onto existing variable names where they mean the same thing, and add the new ones (phase colours, agent colours, gradients, motion timings). Keep one source of truth.
- `src/styles.css` will grow a lot. **Split it** into imported partials in `src/styles/`: `tokens.css`, `base.css`, `layout.css` (sidebar/top bar), `components.css` (buttons, pills, cards, stepper, footer), `motion.css` (from the pack), and `pages/*.css`. `styles.css` then just `@import`s them. Same approach, no new tools.
- **Update `docs/design.md`** to the new system (replace its contents with `design/DESIGN.md`, or link to it), so the repo's design doc and the code agree.

## Add
| Package | Type | Why |
|---|---|---|
| `@fontsource-variable/inter`, `@fontsource/jetbrains-mono` | runtime | Self-host the two fonts, imported once in `main.jsx`. No calls to Google Fonts, which corporate networks and some compliance reviews block. JetBrains Mono is new (IDs, agent keys, model names, JSON). |
| `lucide-react` | runtime | SVG icons for the sidebar, buttons and status (a sparkle for Assistant, checks, etc.). Tree-shaken, so only the icons used are bundled. Use it only where the app doesn't already have icons; don't use icon fonts. |
| `@playwright/test` | dev | Run-graph baseline and before/after recording, plus screenshot checks that the header/stepper/footer are identical on every phase page. |
| `@axe-core/playwright` | dev | Automated accessibility check (contrast of the new colours, focus states) in the same tests. |

## Optional (only if wanted)
| Package | When |
|---|---|
| `@uiw/react-codemirror` + `@codemirror/lang-json` + `@codemirror/theme-one-dark` | If you want the Run page's Task input to have syntax highlighting and live "JSON syntax valid" checking, as in the design. Otherwise, style the existing textarea dark with a monospace font and keep the current validation. |
| `@radix-ui/react-dropdown-menu`, `-dialog`, `-tabs`, `-tooltip` | Only if the existing dropdowns, dialogs or tabs aren't keyboard- and screen-reader-accessible. They're unstyled, so they work with plain CSS. Add them one at a time where needed, not as a blanket dependency. |

## Deliberately not added
- **An animation library (Motion/Framer, GSAP).** Everything in DESIGN.md §7 is done with `motion.css` plus two small hooks: `useCountUp` (in the pack), and a sliding-indicator helper that measures the active item's offset/width and sets CSS variables.
- **A router, state library or data-fetching library.** No behaviour changes.
- **TypeScript migration.** Worth doing later, as its own change.

## Scripts to add to package.json
```json
"test:e2e": "playwright test",
"test:baseline": "playwright test design/baseline/record-run.spec.js"
```
(Use `.js` for the spec files to match the plain-JS codebase.)
