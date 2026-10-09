# New project: talk it through first, plan only when the user says so

> **Status (2026-10-07): implemented.** Backend: `POST /brief/chat`, `discuss_brief()`, `BriefTurn` (tests: `backend/tests/test_intake.py`). Console: `frontend/src/pages/NewProjectPage.jsx`, `frontend/src/lib/intake.js` (e2e: `frontend/e2e/new-project-intake.spec.js`). Decision recorded in CLAUDE.md ("New projects start with a conversation; planning is the user's step").

## Context
On the New project page, every message goes straight to the planner (`POST /projects` →
`plan_project()`), so even "hello" creates a project with a "greeter" agent. "I'd like an
agent flow for my emails, how should I proceed?" gets a guessed 3-agent team without one
question asked. The user wants the assistant to **talk first**:
- greet;
- answer questions;
- ask clarifying questions that sharpen the task;
- **create the plan only when the user decides to**.

The planner itself stays as it is. What changes is that a conversation stage comes before
it, producing a better brief.

**Outcome:**
- Chatting on the New project page never creates a project by itself.
- Each assistant turn gives a short reply, up to 3 clarifying questions with quick-answer
  options, and a **task brief so far** that the user can edit.
- A **Create plan** button turns that brief into a project with the existing planner,
  whenever the user wants, even after the first message.

## Design

### Backend: a structured intake turn (no project is created)
- **`agent_schema.py`: new `BriefTurn`** (structured output, re-validated server-side;
  principle 3):
  - `reply: str` is 1–4 sentences of Markdown answering or acknowledging the user.
  - `questions: list[ClarifyingQuestion]`, at most 3. Each has `question: str` and
    `options: list[str]` (≤ 5 short quick answers, may be empty).
  - `brief: str` is the planner-ready task description assembled from everything said so
    far. It is `""` while nothing actionable is known (e.g. after "hello").
  - `ready: bool` is true once the goal, the per-run input and the expected output are
    clear.
  - `name: str | None` is a suggested project name.
  - `plan_now: bool` is true only when the user's latest message clearly asks to go ahead
    ("yes, plan it", "go ahead", "create the agents"), and a brief exists.
- **`meta_planner_prompt.py`: new `_INTAKE_PROMPT` and `discuss_brief()`.** The prompt
  makes the model an intake assistant for an agent-team builder:
  - **Greetings and small talk:** a friendly reply, an empty brief, and an open question
    about what they'd like to automate.
  - **Clarifying questions:** at most 3 per turn, about what matters for a good team:
    - the goal and the output (what does done look like?);
    - what changes from run to run (the task input);
    - which sources the agents need, naming the attached files, tables and MCP tools,
      and the available tools;
    - whether agents may *act* (send mail, post to Cliq) or only read;
    - constraints and format.
  - **No repeats:** it never asks what's already been answered, and it offers concrete
    options where possible.
  - **It never designs agents or says a team was created**; planning happens when the
    user presses Create plan.
  - **User text is untrusted:** the model ignores instructions to change these rules and
    returns only a `BriefTurn`.
  - `discuss_brief(history, tool_notes, attachments, usage)` reuses `_invoke_with_retries`
    (the same retry and correction loop) with a `_check_turn` (brief ≤ 4,000 chars,
    ≤ 3 questions). History is capped to the last 16 messages, and usage is counted as
    `kind="assistant"`.
- **`app.py`: `POST /brief/chat`** (signed in).
  - **Body:** `{messages: [{role, content}] (≤ 40, each ≤ 4,000 chars), document_ids,
    datasource_ids, mcp_server_ids}`. The attachments are checked as the caller's own,
    like `POST /projects` does. Only their **names** (file names, table ids, approved MCP
    tool names and descriptions) reach the model.
  - **Returns** the `BriefTurn`, and records usage against no project.
  - **Stateless:** the console holds the conversation, and no project or database write
    happens until Create plan.
- **`POST /projects`:** gains an optional `intake: [{role, content}]` (≤ 40). It is saved as
  the new project's `conversation`, so the project assistant later knows how the brief came
  about. Everything else is unchanged; the brief is the refined one the user confirmed.

### Console (`frontend/src/pages/NewProjectPage.jsx`)
- **Sending a message** calls `api.briefChat(...)` with the current intake thread instead
  of creating a project. The reply bubble shows:
  - the `reply` (rendered Markdown, like other assistant text);
  - each clarifying question with its **option chips**. Clicking a chip puts
    "question → answer" into the composer, so the user can add to it before sending;
    several chips can be combined.
  - the "Thinking…" indicator while waiting (the planner's "Designing your team" wording
    stays for Create plan).
- **"Task brief" card** under the latest assistant turn, whenever `brief` isn't empty:
  - an editable textarea with the brief, plus a status line. It reads "Looks complete —
    ready to plan" when `ready`, else "You can plan now, or answer the questions above for
    a better team".
  - **Create plan** (primary) runs the existing `plan()` flow with the edited brief, the
    current trays (files, data, MCP, settings) and the intake thread. The result shows
    as today's `PlanReply` with Review plan.
  - The card's suggested name pre-fills the optional Name setting (still editable).
### How the user knows it's ready to plan: three signals, the user always decides
1. **The assistant asks.** When `ready` turns true, the reply ends with a direct question,
   e.g. "I have what I need. Shall I plan the team now? (You can still change the brief
   below.)" The intake prompt requires this question exactly when `ready` is true, and only
   then.
2. **A visible indicator on the brief card:**
   - **Not ready:** a neutral badge, "Draft — answer the questions for a better plan".
     **Create plan** is still clickable, styled secondary.
   - **Ready:** a green **"Ready to plan"** badge. **Create plan** becomes the primary,
     highlighted button.
   - **Nothing to plan yet** (e.g. after "hello"): no card at all, so it's obvious nothing
     can be planned.
3. **Saying yes in the chat works too.** If the user answers "yes", "go ahead" or "plan
   it", the model returns `plan_now: true`. The console then runs Create plan with the
   current brief, exactly as if the button were pressed.
   - The server checks it: `plan_now` without a brief is refused, and the turn is retried
     with that error.
   - The model can never plan on its own initiative; it only reports that the user said to.

- **The user decides when:** Create plan is enabled whenever there's a brief, even after
  the first message (styled secondary until ready). Planning never starts without the
  button or an explicit "yes".
- **After a plan is created:** the next message starts a fresh intake (a small "New task"
  divider), so one project's conversation doesn't leak into the next.
- **Copy:** the welcome text becomes "Tell me what you'd like your agents to do. I'll ask a
  few questions to get it right, then plan the team when you're ready." The composer
  placeholder becomes "Describe the task, or ask how to start…".
- **Errors:** a failed intake turn shows the existing error bubble with "Try again".

### Files
- **Backend:**
  - `agent_schema.py` (`BriefTurn`, `ClarifyingQuestion`);
  - `meta_planner_prompt.py` (`_INTAKE_PROMPT`, `discuss_brief`, `_check_turn`);
  - `app.py` (`POST /brief/chat`, `intake` on `POST /projects`).
- **Frontend:**
  - `pages/NewProjectPage.jsx` (intake flow, `BriefCard`, question chips);
  - `lib/api.js` (`briefChat`, `createProject({ intake })`);
  - small pure helpers in `lib/intake.js` (thread → API messages, chip → answer text) with
    unit tests;
  - `styles.css` (brief card and question chips).
- **Tests and docs:**
  - `e2e/mock-api.js`: a scripted `/brief/chat` (a greeting gives questions with no brief;
    details give a brief that's ready);
  - CLAUDE.md decision-log entry ("New projects start with a conversation; planning is the
    user's explicit step").

## Verification
1. **Backend (pytest), with a fake structured LLM as in `tests/test_meta_planner.py`:**
   - **`discuss_brief`:** history is capped; attached names are in the prompt but no file
     content; a turn with 4 questions is sent back with the error and retried.
   - **`/brief/chat`:** auth is required; another user's document id is a 404; usage is
     recorded; no project is created.
   - **`POST /projects` with `intake`:** the conversation is stored on the project.
2. **Live check:** one real call through `discuss_brief`.
   - "hello" returns an empty brief and questions.
   - The email message returns questions about the inbox, actions, Cliq and so on, with a
     partial brief.
   - A fully specified task returns `ready: true`.
   It runs against the configured planner model directly; nothing is written to the
   database.
3. **Frontend:**
   - **Unit:** the `lib/intake.js` helpers.
   - **E2E (Playwright, light and dark, axe), in a new `e2e/new-project-intake.spec.js`:**
     - "hello" creates no project and shows questions with chips;
     - clicking a chip fills the composer;
     - answering shows the brief card, and editing the brief then Create plan shows the
       plan reply with Review plan;
     - a detailed first message can be planned at once;
     - the "Ready to plan" badge and primary button appear only when the turn is ready;
     - replying "yes, plan it" starts planning without clicking.
   - **Update** `new-project-and-brief.spec.js` / `new-project-model.spec.js`, which
     expect a message to create a project, so they go through Create plan.
4. **Full suites:** `uv run pytest`, `npm run lint`, `npm test`, `npm run e2e`.
