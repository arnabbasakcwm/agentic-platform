# Run page audit and working log

Working log for the Run page redesign (readable agent output, design system, animated
orchestration diagram). Newest iteration last.

## Step 0 — Discovery (2026-10-01)

### Stack

| Concern | Finding |
|---|---|
| Framework | React 19 + Vite 7, plain JSX (no TypeScript) |
| Routing | Hand-written hash router, `frontend/src/lib/router.js` (`#/projects/<id>/<step>`) |
| Styling | One global stylesheet, `frontend/src/styles.css`, CSS custom properties; no component library |
| State | Local React state; project held in `pages/ProjectWorkspace.jsx`, the run result kept there across steps |
| API client | `frontend/src/lib/api.js` (`fetch`, typed `ApiError`), Vite proxies `/api` → FastAPI on :8000 |
| Lint / typecheck / unit tests | **None configured** in `frontend/package.json` (only dev/build/preview) |
| Backend | FastAPI in this repo (`backend/src/agentic_platform/app.py`) |

### Where things live

- Run page: `frontend/src/pages/project/RunStep.jsx` (input form, Full graph / Single agent tabs,
  `Results` renderer). Rendered inside `ProjectWorkspace.jsx` with the stepper.
- Result rendering: `Results` in `RunStep.jsx`: `content` in a `div.result__body`
  (`white-space: pre-wrap`), `data` as `JSON.stringify(…, null, 2)` in a `<pre>`.
- Graph definition: the project's `plan` (`agents[].id/role/depends_on/tools/llm`,
  `orchestration_pattern`, `supervisor_id`, `bounds`), from `GET /projects/{id}`.
- Run API: `POST /projects/{id}/run` → `run_graph()` in `graph_builder.py`.

### How results arrived

One JSON response at the end of the run (no SSE/WebSocket/polling):

```json
{
  "project_id": "…",
  "outputs": { "<agent_id>": { "content": "<string>", "data": { "…": "…" } } },
  "errors":  [ { "agent_id": "…", "error": "…", "attempts": 3 } ],
  "halted":  false
}
```

Each agent output is `AgentOutput { content: str, data: dict }` (structured output from the
model). Single-agent runs (`POST /projects/{id}/agents/{agent}/invoke`) return the node's raw
state update under `result`.

### Root causes found

| Bug | Root cause (verified) |
|---|---|
| **B2** line breaks lost | **At the source, not in transport or CSS.** A real model call returned 1,032 characters with **0** newlines: the model writes `AgentOutput.content` (a JSON string field) as one line. CSS already had `pre-wrap`; nothing strips whitespace. Three variants seen in real calls: (a) one flat line, (b) double-escaped `\\n` (two characters), (c) HTML `<br>` tags. |
| **B1** Markdown not rendered | `content` was rendered as plain text. |
| **B3** stale / mismatched input | Two causes. (1) `RunStep` keeps its input box in local state that resets to a hardcoded sample (`{"question": "What is the speed of light?"}`) whenever the page remounts, while the **result** lives in `ProjectWorkspace` and survives navigation, so an old flight result sat under a fresh "speed of light" input. (2) The sample input is the same for every project. Agent prompts were checked: they do **not** hardcode the route; a real run with two different inputs produced different, input-specific answers. |
| **B4** raw JSON dump | `data` printed with `JSON.stringify`. |
| **B5/B6** layout | The workspace pane scrolls as one; the stepper scrolls out of view and the result panel grows the whole page; the action bar is sticky at the bottom of that single scroll area. |
| **B7** number formatting | Numbers printed raw from JSON. |
| Run timeout (found earlier today) | Planner model chose a 60 s limit; unhandled `TimeoutError` → bare 500. Fixed in commit `4aad525`. |

### Backend fixes (iteration 1)

- **B2 at the source:**
  - `AgentOutput.content` schema description asks for Markdown with real line breaks; the final instruction to each agent says the same.
  - A validator normalises double-escaped `\n` and `<br>` tags when the text has no real line break.
  - `_run_agent_once` detects a flattened answer (no line break, with Markdown block markers mid-line or over 700 characters) and sends it back once with the exact problem; if the rewrite is still flat, the original is kept, so the agent doesn't fail over formatting.
- **B3:**
  - Planner rules now require system prompts to work from the TASK INPUT (no hardcoded places, dates or names).
  - The planner fills a new `AgentPlan.example_input`, which the console uses to pre-fill the input box.
- **Streaming:** `POST /projects/{id}/run/stream` (Server-Sent Events). Nodes report through a per-run `emit` callback passed in LangGraph's `config`, so the same compiled graph serves both endpoints. The events are:
  - `run_started`
  - `node_started`, `node_retry`, `node_completed` (with `output`, `duration_ms`, `attempts`), `node_failed`, `node_skipped`
  - `run_completed` (same `outputs`/`errors`/`halted` as `/run`) or `run_failed` (e.g. `RunTimeout`)

  Every event carries `at`. `/run` is unchanged.
- Gotcha recorded: LangGraph only injects `config` into a node whose annotation is the literal `RunnableConfig` / `Optional[RunnableConfig]`; `RunnableConfig | None` is silently ignored under postponed annotations.

### Real-model verification (backend)

- A fresh travel plan from the real planner had `example_input` filled in and no hardcoded specifics in its prompts.
- Two streamed runs with different inputs (JFK→LHR, Bengaluru→Singapore) produced different, input-specific answers. Events arrived in order (`node_started`/`node_completed` per agent).
- After the fixes, Kolkata→Delhi came back with 17 line breaks, headings and bullets.
- **Known model behaviour:** some answers are a single short paragraph of plain prose with no Markdown at all (e.g. Chennai→Goa, about 400 characters). That is rendered exactly as written; it is not flattened Markdown.

Backend tests: 184 passed.

## Frontend (iterations 1–8)

### What was built

| Area | Files |
|---|---|
| Design tokens: indigo `#4F46E5` accent, slate neutrals, success/warn/danger/info, light + dark (`prefers-color-scheme`), 8px spacing, 12/14/16/20/24/30 type scale, 12px card radius, soft shadows, Inter + JetBrains Mono | `src/styles.css` (top), `index.html` |
| Live run state from server events (pure reducer) | `src/lib/runState.js`, `src/lib/sse.js` (fetch-based SSE parser), `src/lib/useProjectRun.js` (run owned by the workspace so it keeps streaming across steps; draft input kept) |
| Graph model shared by Compile and Run | `src/lib/flow.js` (compiler's ordering, Start/End, agent colours) |
| Animated orchestration diagram | `src/components/RunDiagram.jsx` (React Flow + dagre, auto layout LR, TB below 640px, zoom/fit controls, keyboard + click → output card), `RunTimeline.jsx` (Gantt bars), `DiagramLegend.jsx` |
| Human-readable output | `src/components/AgentOutputCard.jsx`, `Markdown.jsx` (react-markdown + remark-gfm, `skipHtml`, no `dangerouslySetInnerHTML`), `DataView.jsx` (key/value + tables, currency by key suffix), `JsonView.jsx` (highlighted, copyable raw JSON) |
| Run page | `src/pages/project/RunStep.jsx`: diagram + timeline on top; Input and Result columns with independent scroll areas; "Ran with" input; aria-live announcements; retry |
| Shared | `StatusBadge`, `Skeleton` in `ui.jsx`; formatters (`formatDuration`, `formatValue`, `humanizeKey`) in `format.js` |

### Packages added (and why)

| Package | Why | Weight |
|---|---|---|
| `react-markdown` + `remark-gfm` | Correct GFM (tables, task lists, autolinks) without HTML injection; renders to React elements | ≈200 kB of the main bundle |
| `@xyflow/react` | Pan/zoom/fit controls, custom nodes/edges and accessible controls; hand-rolling these is a large surface | Lazy-loaded with the Run page only (232 kB chunk) |
| `@dagrejs/dagre` | Automatic layered layout (LR/TB), handles the supervisor's cycles | In the lazy chunk |
| dev: `eslint` 9, `@eslint/js`, `eslint-plugin-react`, `eslint-plugin-react-hooks`, `globals` | The repo had no lint; ESLint 9 because eslint-plugin-react doesn't support 10 yet | dev only |
| dev: `vitest` | Unit tests for the pure logic (reuses the Vite config) | dev only |
| dev: `@playwright/test`, `@axe-core/playwright` | Screenshot matrix and WCAG checks; runs the installed Microsoft Edge (`channel: msedge`), so no browser download | dev only |

No JSON-highlighting or clipboard libraries: both are a few lines (`JsonView.jsx`).

### Iteration log

| # | Failed | Change |
|---|---|---|
| 1 | Playwright web server never came up | Vite listened on `localhost` (IPv6) while the check polled `127.0.0.1` → `--host 127.0.0.1`. |
| 2 | 404 in the console on every page; test locator ambiguous | Browser's automatic `/favicon.ico` request → inline SVG favicon. Test scoped to the field value. |
| 3 | Test tried to start a run during a run | Correct behaviour (button disabled) → test reloads after the mid-run capture. |
| 4 | **Clicking a node did nothing**; 7px horizontal scroll at 390px | React Flow only passes pointer events to nodes when `onNodeClick` is set (the handler was inside the node) → `onNodeClick`. Breadcrumb couldn't shrink → ellipsis. fitView capped at 100% zoom. |
| 5 | Workspace 70px too wide at 390px after a run | Result header badge didn't wrap → run panel headers wrap. |
| 6 | axe: contrast of queued/skipped nodes (opacity), unreachable scrollable tables, dark-mode current-step number | Distinguish states by border/surface, never opacity; table scrollers `tabIndex=0 role=region`; current step uses `--primary`. |
| 7 | **Visual review:** diagram nodes stacked on top of each other | dagre writes positions into the label object it is given and all agents shared one object → a fresh object per node. Added an overlap assertion to the e2e test (counts alone had passed). Starting a run now scrolls the diagram into view. |
| 8 | **Visual review:** timeline bars one tick behind (full bar mid-run, missing failed bar) | A 0.25s CSS transition on a 0.25s clock always lagged → removed; failed agents show their duration. |

Earlier, during discovery: the Run page had **no lint**. The first lint run found 18 problems, among them a `setState` cascade in `App.jsx` and missing `key`s in label/value rows. All were fixed.

### Acceptance criteria

| Criterion | Status | Evidence |
|---|---|---|
| No literal Markdown symbols | ✅ | e2e "renders as Markdown"; backend normalises flattened answers at the source |
| Headings/lists/paragraphs on separate lines | ✅ | e2e (3 `h3`, ≥7 `li`, real table); real-model check: 17 line breaks after the fix |
| Changing input changes output | ✅ | e2e with two inputs (mock echoes input through the real data path); real model: JFK→LHR vs Bengaluru→Singapore produced different answers |
| JSON as readable card, raw collapsible + copyable | ✅ | e2e (currency-formatted fields, table, closed `<details>`, Copy JSON) |
| Nothing under header / behind bottom bar | ✅ | e2e at 1440/1024/390: stepper below top bar at end of scroll, panel above action bar, last card fully reachable |
| No horizontal scroll at 390px | ✅ | e2e checks page and workspace in every state |
| Diagram from the real graph, animates, true final state | ✅ | e2e: node/edge counts, no overlap, running/queued/completed mid-run, dash animation only while active, failed/skipped after a timeout |
| Click node → its card | ✅ | e2e (focused and in viewport); Enter/Space on a focused node too |
| `prefers-reduced-motion` | ✅ | e2e: glow and edge-dash `animation-name: none` |
| WCAG AA (axe: 0 serious/critical) | ✅ | Run page: 4 states × 3 widths × 2 themes; other pages × 2 themes |
| Typecheck, lint, tests, build | ✅ / n/a | Lint 0 problems; 18 unit tests; 16 e2e tests; build has no warnings; backend 184 tests. **Typecheck: not applicable** (plain JavaScript, no TypeScript in the project) |
| Existing features work | ✅ | e2e: Single agent tab, Compile and Deploy links, API status pill |

The real API path was checked too: a real run of the travel project, streamed through the Vite dev proxy, delivered each event as it happened (the agents finished 94 s and 58 s apart), so the diagram animates live rather than all at once.

### Limitations and deviations

- **Edge flow animation uses `stroke-dashoffset`**, not transform/opacity: SVG paths can't be animated along their length with transforms. Only the edges carrying data at that moment animate. Node glow, spinners, skeletons and timeline bars use transform/opacity only.
- **Single-agent runs are one request** (no events), so that agent is shown as running from request to response. This is real timing, not simulated progress. Full-graph runs use real per-agent events.
- **A run can't be cancelled from the console.** Closing the page stops watching, but the server finishes the run (as with `/run` today).
- **The model sometimes answers in one plain paragraph** with no Markdown at all. That is rendered as written; only flattened Markdown is sent back for line breaks.
- **Sticky action bar:** content passes beneath it while scrolling, but the end of every column is reachable above it (tested).
- Run history is still not persisted.

### Re-running the checks

```bash
cd frontend
npm run lint          # ESLint
npm test              # Vitest unit tests
npm run build         # production build
npm run e2e           # Playwright: starts the mock API (:8765) and Vite (:5299) itself;
                      # screenshots → frontend/e2e/screenshots/
```
