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
