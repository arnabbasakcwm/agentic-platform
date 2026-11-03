# Run graph: baseline inventory of animations and visual state changes

Taken before the redesign (branch `feature/redesign-multicolour`, from `e688b37`).
Every row is a **floor**: after the redesign it must still be there, restyled to the new
tokens, or be replaced by something that shows the same state at least as clearly. Nothing
is removed without asking first. File references are to the code as it was before any
change.

## Where the states come from

States are never simulated: they come from the run's server events, reduced in
`src/lib/runState.js`.

| Event / moment | Node state it sets | Code |
|---|---|---|
| Run started (client side, before the first event) | every agent in a graph run → `queued`; the chosen agent in a single-agent run → `running` | `runState.js:45-60` |
| `node_started` | that agent → `running` | `runState.js:81-95` |
| `node_retry` | stays `running`; records `retryError`, `attempts` | `runState.js:100` |
| `node_completed` | → `completed` (output, duration, attempts) | `runState.js:102-108` |
| `node_failed` | → `failed` (error, attempts) | `runState.js:122-125` |
| `node_skipped` | → `skipped` (reason) | `runState.js:129-130` |
| `run_completed` | outputs filled; errors → `failed`/`skipped`; anything still queued → `skipped` ("Did not run") | `runState.js:132-154` |
| `run_failed` | running → `failed` (or `skipped` when stopped); queued → `skipped` | `runState.js:158-169` |

Six node states: `idle | queued | running | completed | failed | skipped`
(`runState.js:6`).

## A. Agent nodes (`src/components/RunDiagram.jsx` `AgentNode`, CSS `styles.css:3347-3494`)

| # | State / animation | What it looks like | Trigger | Timing | Code |
|---|---|---|---|---|---|
| A1 | Node shape | 216×66 card: 5px agent-colour stripe on the left, title (agent key turned into "Title Case"), role, state at the right | always | — | `RunDiagram.jsx:19,105-147`; `styles.css:3348-3413` |
| A2 | **Idle** | solid `--border-strong` border, surface background, label "Idle" | no run yet | — | `styles.css:3425-3427` |
| A3 | **Queued** | sunken background (no fading, for contrast), clock icon + "Queued" | run started, agent not yet started | — | `styles.css:3431-3433`; icon `RunDiagram.jsx:33-38` |
| A4 | **Running: gradient border** | 2px border, gradient from the agent colour to `--primary` | `node_started` | instant | `styles.css:3435-3441` |
| A5 | **Running: glow pulse** | outer glow ring in the agent colour on a separate layer, opacity pulsing 0.25 → 1 (compositor-only) | while running | 1.6s ease-in-out, infinite | `styles.css:3444-3467` |
| A6 | **Running: spinner** | small spinning ring in the state slot, text in the accent colour | while running | 0.6s linear rotation | `RunDiagram.jsx:135-136`; `.spin` `styles.css:1737-1751`, `.spin--sm` `2876-2880`, colour `3455-3457` |
| A7 | **Running: live elapsed time** | the state slot counts up ("3.2 s") | while running; re-rendered every 250ms by `useClock` | 250ms tick | `RunDiagram.jsx:102,140,281-286`; `RunStep.jsx:44-52,431` |
| A8 | **Completed** | border `--success-border`, check icon, duration in success colour | `node_completed` | border transition 0.2s | `styles.css:3362,3469-3475` |
| A9 | **Failed** | border `--danger`, `--danger-soft` background, × icon, danger text, the error as a hover tooltip | `node_failed` / `run_failed` | border transition 0.2s | `styles.css:3477-3484`; tooltip `RunDiagram.jsx:111` |
| A10 | **Skipped** | dashed border, canvas background, no shadow, muted title, skip icon | `node_skipped`, or never ran | — | `styles.css:3486-3494` |
| A11 | Router tag | small "ROUTER" tag next to the supervisor's title | supervisor plans | — | `RunDiagram.jsx:130`; `styles.css:3396-3405` |
| A12 | Click / keyboard to open the output | click or Enter/Space scrolls to the agent's output card (smooth unless reduced motion), focuses it, and highlights it with a 3px ring for 1.6s | user action | smooth scroll; ring 1.6s; `box-shadow` transition 0.2s | `RunDiagram.jsx:114-119,345-347`; `RunStep.jsx:436-447`; `styles.css:2916,2929-2931` |
| A13 | Focus ring | 2px accent outline, 3px offset | keyboard focus | — | `styles.css:3365-3368` |
| A14 | Accessible label | "Title: running, 3.2 s. Show its output." | always | — | `RunDiagram.jsx:103` |

## B. Start / End terminals (`TerminalNode`, `styles.css:3497-3520`)

| # | State | What it looks like | Trigger | Code |
|---|---|---|---|---|
| B1 | Idle | grey pill, play / flag icon, "Start" / "End" | no run | `RunDiagram.jsx:151-172` |
| B2 | Start completed | success border and text | as soon as a run starts | `RunDiagram.jsx:65-71`; `styles.css:3512-3515` |
| B3 | End queued | stays grey while running | run in progress | `RunDiagram.jsx:68` |
| B4 | End completed | success border and text | run completed | `styles.css:3512-3515` |
| B5 | End failed | danger border and text | run failed or halted | `RunDiagram.jsx:69`; `styles.css:3517-3520` |

## C. Edges (`FlowEdge`, `styles.css:3522-3556`)

| # | State / animation | What it looks like | Trigger | Timing | Code |
|---|---|---|---|---|---|
| C1 | Idle | 1.5px `--border-strong` bezier, grey arrowhead | target not started | — | `RunDiagram.jsx:80-87,312-313`; `styles.css:3523-3527` |
| C2 | **Active: data in flight** | edge tinted with the target agent's colour at 35%, plus a second path of round dashes in the agent colour **travelling along it** | source completed and target running | dashes `6 10`, offset −32 every 0.9s, linear, infinite | `RunDiagram.jsx:84,199-201`; `styles.css:3538-3556` |
| C3 | **Done** | solid 2px in the target agent's colour, arrowhead in that colour | source and target completed | stroke transition 0.3s | `RunDiagram.jsx:85,301-316`; `styles.css:3526,3529-3532` |
| C4 | **Failed** | edge and arrowhead in `--danger` | target failed after a completed source | stroke transition 0.3s | `RunDiagram.jsx:83,314-315`; `styles.css:3534-3536` |

## D. Diagram canvas (`RunDiagram`, `styles.css:3310-3339`)

| # | Behaviour | Code |
|---|---|---|
| D1 | Dotted canvas background (18px grid of `--border-strong` dots) | `styles.css:3310-3316` |
| D2 | Auto layout with dagre, left→right; switches to top→bottom under 640px wide | `RunDiagram.jsx:19-63,218-233` |
| D3 | `fitView` (max zoom 100%, padding 12%), zoom controls bottom-right, no drag, no scroll-zoom | `RunDiagram.jsx:325-351` |
| D4 | Theme follows the app's light/dark toggle (`colorMode`) | `RunDiagram.jsx:216,343` |
| D5 | Node measurements kept between updates so edges never vanish mid-run | `RunDiagram.jsx:240-255` |
| D6 | Loading placeholder while the diagram's code loads (`diagram--loading`, `aria-busy`) | `RunStep.jsx:515-518` |

## E. Around the graph (Run page, `src/pages/project/RunStep.jsx`)

| # | State / animation | What it looks like | Trigger | Timing | Code |
|---|---|---|---|---|---|
| E1 | Run status badge in the diagram header | "Not run yet" / "Running · 12.4 s" (spinner, live) / "Completed in 9.8 s" / "Failed after …" / "Stopped after …" / "Halted after …" | run status | spinner 0.6s; 250ms tick | `RunStep.jsx:59-73,93-98,489-492`; `ui.jsx:186-198`; `styles.css:2834-2874` |
| E2 | Progress count | "2/3 done · 1 failed" | while a run exists | — | `RunStep.jsx:485-490` |
| E3 | Stop buttons | "Stop" in the diagram header and beside the Run button, only while running; "Stopping…" with a spinner | running, server knows the run id | — | `RunStep.jsx:75-90,205-210,493-499` |
| E4 | Run button busy | "Run graph" → disabled "Running…" with a spinner | while running | spinner 0.6s | `RunStep.jsx:192-203`; `ui.jsx:70-78` |
| E5 | Start scrolls the diagram into view | smooth scroll to the diagram (instant under reduced motion) | pressing Run | smooth scroll | `RunStep.jsx:450-456` |
| E6 | **Timeline bars** | one bar per agent in its colour, positioned at its start, growing with elapsed time (transform only) | running / done | redrawn every 250ms, no transition | `RunTimeline.jsx:10-58`; `styles.css:3620-3699` |
| E7 | Timeline running bar breathes | opacity 0.85 ↔ 0.55 | agent running | 1.2s ease-in-out, infinite | `styles.css:3664-3681` |
| E8 | Timeline failed / skipped bars | failed = danger colour; skipped = 35% opacity, "Skipped" text | agent failed / skipped | — | `styles.css:3669-3675`; `RunTimeline.jsx:49` |
| E9 | Legend | agent colour dots + one swatch per node state (idle, queued, running, completed, failed, skipped), each mirroring the node style | always | — | `DiagramLegend.jsx`; `styles.css:3558-3618` |
| E10 | Output cards follow the nodes | each card has the agent colour (3px left border), a status badge, duration, attempts pill; "Final answer" ring on the last agents | node events | `box-shadow`/`border-color` transition 0.2s | `AgentOutputCard.jsx:15-74`; `styles.css:2910-2931` |
| E11 | Output skeleton | pulsing lines while an agent is queued or running, plus "Retrying after an error: …" | queued / running | 1.4s pulse | `AgentOutputCard.jsx:83-89`; `ui.jsx:200-212`; `styles.css:2883-2901` |
| E12 | Screen-reader announcements | "Run started." / "Price Analyzer completed." / "Run failed: …" in a polite live region | status changes | — | `RunStep.jsx:102-138,570` |

## F. Reduced motion (`styles.css:3701-3733`)

| # | Behaviour |
|---|---|
| F1 | All animations and transitions cut to ~0ms. |
| F2 | Running glow stays visible but still (opacity 0.6) instead of pulsing. |
| F3 | Edge dashes stay visible but still (`6 6`) instead of travelling. |
| F4 | Spinners become a still ring at 60% opacity; skeletons and the timeline's running bar stop pulsing. |
| F5 | State changes (borders, backgrounds, icons, labels) still update instantly. |

## How states are told apart without colour

| State | Non-colour cue |
|---|---|
| Idle | label "Idle", plain border |
| Queued | clock icon + "Queued", sunken background |
| Running | spinner + live time, thicker (2px) border, glow |
| Completed | check icon + duration |
| Failed | × icon + "Failed" tooltip / time, tinted background |
| Skipped | skip icon, **dashed** border, no shadow |

## Recording

`design/baseline/record-run.spec.js` records these states against the scripted mock API
(`e2e/mock-api.js`), which costs nothing and is repeatable: idle, first agent running,
mid-run (paused on the second agent), completed, and failed (`{"scenario": "fail"}`).
Output: `design/baseline/before/` (video + screenshots).
