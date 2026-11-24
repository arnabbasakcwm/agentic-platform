# Run graph fixes: working log

Three reported problems: no agent ever shows as running; the START / END edges are slanted;
the pointer loses its outline in places. Checks: `e2e/run-graph.spec.js`,
`e2e/cursor.spec.js`, `src/lib/runState.test.js`.

## 1. No agent shows as running — cause

**It is not the console.** `applyEvent` maps `node_started` to `running`, the node ids match
the plan's agent ids, and the redesigned AgentNode renders `running` (2px sky border, pill
with spinner, live time, glow layer; the glow's static look survives reduced motion). The
`git diff` of the Run page, node and `useProjectRun` shows nothing that dropped the mapping.

**It is in the backend's run recorder** (`backend/src/agentic_platform/app.py`,
`_RunRecorder.event`). A run's events reach the console through the saved run record, and the
recorder writes its buffer only when a *later* event arrives and 0.5 s have passed since the
last write (`run_started` is the only event saved at once). So an event that is the last one
for a while — every `node_started`, because an agent then works for seconds or minutes —
stays in the buffer until the next event, which is that agent's own `node_completed`.

Reproduced offline (probe: `_RunRecorder` with a fake store, timestamps in seconds):

```
0.0   run_started                  -> saved: run_started
0.59  node_started(rbi_researcher) -> saved (0.5 s had passed since the last write)
1.2   node_completed(rbi)          -> saved
1.2   node_started(compliance)     -> NOT saved (written 0 s ago)
6.2   5 s later, still working     -> still NOT saved
```

That is the reported picture exactly: at the start all agents "Queued" (the first
`node_started` sits in the buffer when it follows `run_started` within 0.5 s), later the first
agent "Completed" and the other three "Queued" (each following `node_started` waits behind it).

**What the console now does.** Required fallback in `displayRun` (`lib/runState.js`), applied
once in `useProjectRun`, so the diagram, the progress rows and the cards share one status
source: while a graph run is active and no node is running, the first queued agent (in run
order) is shown as running, timed from the previous completion (or the run start). It is
replaced the moment the real `node_started` arrives. `completed` / `failed` / `skipped` are
never inferred. A node that completes without its `node_started` also gets a start time
(completion minus the server's `duration_ms`), so its progress row still has a bar.

**Not fixed here (needs your decision, see the end of the report):** the recorder itself.
The one-line cause is that `event()` flushes only when the next event arrives; saving
`node_started` at once (like `run_started`) or flushing on a timer fixes it at the source, and
gives the real start time instead of an inferred one.

## 2. START / END edges not straight — cause

dagre was given a fixed height (112 px) for every agent and 36 px for the terminals, but the
rendered agent card is not 112 px tall, so dagre centred START / END on the wrong height and
the handles (always at each node's own vertical centre) ended up at different y. The edge
was then a bezier between two different heights.

Fix (`components/RunDiagram.jsx`): dagre now gets React Flow's *measured* size of every node
(START and END included) and the graph is laid out again after the first measurement (the
view is re-fitted once); level handles (within 2 px, rounding of whole-pixel measurements)
draw a straight line snapped exactly horizontal, branching graphs keep the bezier.

## 3. Pointer loses its outline — not reproduced as a code defect

Searched all CSS / JSX for `cursor:` rules, custom `url()` cursors, `cursor: none`,
`mix-blend-mode`, `background-blend-mode`, `filter`, `backdrop-filter`, `isolation`,
full-size overlays and the React Flow pane/controls. Found:

* No `url()` cursor and no `cursor: none` anywhere; nothing is set on `*`, `html` or `body`.
* No `mix-blend-mode` anywhere. The only `backdrop-filter` is on the sign-in intro's decorative
  chips (no controls inside); the only `filter` is on button hover / disabled states.
* `isolation: isolate` on the primary button and the hero (`.chat__welcome`): not a blend.
* Native `<select>` showed the default arrow although it is clickable: **fixed**, `select` and
  `summary` now use the pointer (`styles/base.css`).
* The graph pane now states `grab` / `grabbing` explicitly; decorative layers (hero glow,
  sign-in chip lines, mesh, glow-breathe) are `pointer-events: none` explicitly.

`cursor.spec.js` computes the cursor, blend modes, filters and "is something on top of this
control" for every element of 14 pages (sign-in, New project with each popover open, projects,
Brief, Resources, Plan, Compile, Run, Deploy, Usage, Knowledge, Data sources, MCP servers,
Admin; sidebar and top bar come with each), in light and dark, plus the Run pane, nodes,
edges, controls and the dragging hand. All pass. An OS-drawn pointer cannot lose its outline
because of this app's CSS; if it still happens, tell me the exact spot and the browser.

### Follow-up: "the outline issue is not fixed" — the cause was the I-beam

The first pass only checked controls and fields. The brief also says `default` everywhere
else, and static text had `cursor: auto`, which the browser turns into the thin **I-beam**
over any text. The I-beam is the one standard pointer with no contrast outline, so over
headings, paragraphs, pills and agent output it looks like the pointer lost its outline.
`cursor.spec.js` now fails on any visible text whose computed cursor is not the arrow or a
purposeful one (it failed on the sign-in page and every project page before the fix).
Fix: `html, body { cursor: default }` (inherited by all text; text stays selectable) with
explicit `cursor: text` for fields (`styles/base.css`). If it is still wrong somewhere,
the remaining candidates are the I-beam over fields on a mid-grey surface, or the OS pointer
scheme; tell me the exact spot.

## Rounds

| Round | What failed | Change |
|---|---|---|
| 1 | Late-`node_started` stream: a completed node had no progress bar; the arrow tip was 2.5 px off my handle-*centre* measure | Start time from `duration_ms`; measure to the handle's outer face, which is where React Flow ends an edge |
| 2 | Zoomed in, START→first edge 1.1–1.3 px off horizontal (whole-pixel measurement) | Snap level edges to exactly horizontal |
| 3 | Cursor spec: native select shows the arrow; label / hidden checkbox / edge-over-pane were test over-strictness | `select, summary { cursor: pointer }`; test tightened to real controls |
| 4 | none | — |
| 5 | Cursor: user reported the outline problem still there | Static text was `cursor: auto` (I-beam, no outline): base cursor is now the arrow; new test for it |
| 6 | Cursor: hand over the graph background and I-beam over the sign-in email field have no visible outline | Pane and text fields use the arrow (caret still shows typing); the audit now forbids grab hands and the I-beam |
