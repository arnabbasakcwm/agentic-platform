# Prompt for Claude Code: New project composer (self-checking loop)

Paste everything below the line into Claude Code from the repo root. `design/new-project-composer.html` and `design/new-project-composer.png` must already be in the repo.

---

You are finishing the New project composer (`#/new`). Work in a **build → test → fix loop** until every acceptance check in section 4 passes. Don't stop to ask me unless a stop condition in section 5 applies.

`design/new-project-composer.html` is the visual reference. Where it differs from the decisions below, **the decisions below win**.

## 1. Decisions (final, don't re-ask)

1. **knowledge_search**
   - Show it in the Built-in group as **on and locked** (switch disabled, with a lock or "auto" style) and the tag **"auto · n files"** when files are attached. With no files, show it off and locked, with the hint "Turns on when you attach files".
   - **Never add it to `available_tools`.** The server adds it exactly when files are attached (`app.py` ~1972), so the request stays identical to today.
2. **Team size**
   - Two options only: **Auto** (omit `agent_count`) or **a number** (one integer input, 1–10, sent as `agent_count`). No ranges and no presets.
   - The chip reads "Team Auto" or "Team up to N". The hint says "The planner uses up to N agents." Saved values load into the number input.
3. **"Let the planner pick tools"**: not supported by the backend, so leave it out entirely. Behaviour of omitting `available_tools` stays as today.
4. **Model picker**
   - Tags: `/providers` has no speed or size data, so the only tag is **"Local"** on Ollama models, plus "Default" on the platform default.
   - Keep the Recommended (default + Bedrock "recommended") and More models groups, and search.
   - Collapse keyless models into one muted row, "n models need an API key", with **no link**. Its tooltip says "API keys are set on the server by an administrator."
5. **Popover direction and placement** (see section 3 for the full rules): downward on the empty page; upward once the conversation has started and the composer sits at the bottom of the screen.
6. **Upload progress**: the upload is one request with no progress events. Each file gets a chip immediately with a spinner. It becomes the normal chip on success, or an error chip (red icon, message on hover, × to remove) on failure. No percentage.
7. **+ menu items**
   - Upload files: opens the native file picker.
   - Choose from library, Add data source, Attach MCP server: each opens a **checklist view inside the same popover**, with a back arrow to return to the menu. The views show library files with status, data sources with their tables, and MCP servers with their approved tools.
   - Use the same filters and data as today's trays. Ticking an item adds or removes its attachment chip immediately.

## 2. Hard rules
- **Same request as today.** For the same user choices, the create/plan request body must be byte-for-byte equivalent to the old page (field names, values, omitted fields). Reuse the existing state, hooks, upload flow and `src/lib/api.js`.
- **One popover at a time, everywhere on the page.**
  - Clicking another chip while a popover is open closes the current one and opens the new one in **one click**. No second click, no flash of two.
  - Clicking the open chip again closes it. Esc and an outside click close it, and focus returns to its chip.
  - Sub-views (library, data, MCP) replace the + menu's content; they never stack a second popover.
  - Tooltips are not popovers, but hide any tooltip when a popover opens.
- No new dependencies. Plain JSX, the existing `src/styles/` variables, `motion.css` and `lucide-react`.

## 3. Placement: popovers must never be obstructed
The old Model dropdown opened upward, covered the headline, and was cut off by the top bar. That must not be possible anymore.
- Render popovers in a **portal at `document.body`** with `position: fixed`, so no ancestor `overflow` or `z-index` can clip them. Their z-index sits above the top bar, sidebar and sticky footers.
- **Usable area:** the viewport minus the top bar (and the sidebar on the left), with an 8px margin.
- **Placement:** preferred side is below the chip on the empty page and above the chip when the composer is docked at the bottom. If the preferred side has less room than the popover's natural height and the other side has more, flip. Clamp horizontally so the popover never leaves the usable area. Keep it aligned to the chip's left edge where possible.
- **Height:** `max-height` = the space available on the chosen side. Content scrolls **inside** the popover; the search field (model picker) and header row (sub-views) stay pinned.
- The popover must never cover its own chip or the composer's text area.
- Reposition on scroll, window resize, textarea growth and attachment changes; close if the chip scrolls out of view.
- Works at 1280×720, 1440×900 and 1920×1080, in light and dark themes, and with the sidebar collapsed or expanded.

## 4. Acceptance checks (the loop's exit condition)
Write these as Playwright tests in `e2e/new-project-composer.spec.js`, plus a request-equivalence test.

**A. Request equivalence.** Use a test build or route mock that records the outgoing create request. Compare old vs new for:
- defaults;
- a non-default model + team "up to 4" + web_search and wikipedia;
- a library file + a data source + an MCP server;
- an uploaded file (check that `knowledge_search` is **not** in `available_tools`).

Bodies must match. (Capture the old page's bodies first from the current code, before replacing it, and save them as fixtures.)

**B. One popover at a time.** For every ordered pair of chips (+, Model, Team, Tools), open the first, click the second, and assert exactly one `[role=dialog],[role=listbox],[role=menu]` popover is visible and it belongs to the second chip. Also check:
- clicking the same chip twice closes it;
- Esc closes it and focus returns to the chip;
- opening a + sub-view leaves exactly one popover.

**C. Never obstructed.** For each popover, at each viewport size, in both the empty state and the docked-at-bottom state (send a mocked first message), assert that the popover's bounding box:
- is fully inside the usable area;
- doesn't intersect the top bar, the sidebar or its own chip;
- has a scroll height that is reachable (`scrollHeight > clientHeight` only when content overflows, and the last item can be scrolled into view and clicked).

Then take screenshots to `e2e/__screens__/` and look at them.

**D. Behaviour.**
- knowledge_search is locked and shows "auto · n files" as files are added and removed.
- Team: Auto omits `agent_count`, a number sends it, and out-of-range input is rejected with an inline message.
- Model search filters, and arrow keys + Enter pick a model.
- The keyless row shows the right count and has no link.
- An upload spinner chip turns into a normal chip, and a forced failure shows the error chip.
- Sub-view ticks add and remove chips.

**E. Quality.** axe has no serious or critical issues in light and dark. Keyboard-only use works (Tab order textarea → chips → send; Enter sends; Shift+Enter adds a new line). `npm run build` and lint pass. No console errors.

**Loop:** run all checks → fix the first failing area → re-run everything → repeat. After each round, append one line to `e2e/LOOP_LOG.md`: round number, what failed, and what you changed. Exit when everything passes twice in a row, or after **8 rounds**, whichever comes first.

## 5. Stop and ask me only if
- matching the old request exactly would need a backend change;
- an existing feature on the old page has no home in this design;
- after 8 rounds something still fails (report what and why).

## 6. Finish with
A short summary: the result of each check (A–E), the number of loop rounds, the files changed, the screenshots worth looking at, and anything you decided that isn't covered above.
