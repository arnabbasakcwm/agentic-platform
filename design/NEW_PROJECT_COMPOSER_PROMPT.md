# Prompt for Claude Code: New project composer

Put `new-project-composer.html` and `new-project-composer.png` in the repo's existing `design/` folder, run `claude` from the repo root, then paste everything below the line.

---

The visual redesign is already implemented. This task changes **only the New project page** (`#/new`): replace its settings card with one composer whose settings open from chips.

Open `design/new-project-composer.html` in a browser (click the chips; it's interactive) and look at `design/new-project-composer.png`, which shows every popover open. That file is the exact spec for layout, sizes, states and copy. Build it with what the app already has: React 19 + plain JSX, the variables already in `src/styles/` (don't add new colours; the reference inlines the same values), the existing `motion.css` classes, and `lucide-react` icons. Add no new dependencies.

## 1. Map the current page first (don't change anything yet)
Read the current New project page and its API call. Show me a table: every field and control today (task text, Name, Team size switch, Model dropdown, Tools chips, Knowledge upload and library, Add files / Add data / Add MCP, the summary chip, and anything else), the state it lives in, what it sends in the request, and where it will live in the new design. Wait for my OK.

## 2. Hard rule: same request as today
The create/plan request must be **identical** to today's for the same choices: task text, model (or platform default), team size or auto, enabled tools, knowledge files (uploaded or from the library), data sources, MCP servers, and the name derived from the task's first line. Reuse the existing state, hooks, upload flow and `src/lib/api.js` calls; only the UI around them changes. If something can't map cleanly, ask me.

## 3. Build
**Page:** hero (40px headline + one supporting line + soft glow) → composer (max 860px) → the three existing template cards. Remove the settings card, the Knowledge card, the Name field and the composer's summary line ("Auto team size · Default model · n of 10 tools").

**Composer:** textarea → attachment chips (only when something is attached) → divider → toolbar: `+` · `Model <value>` · `Team <value>` · `Tools <n>` · spacer · round gradient send button. A chip whose value differs from the default gets a light violet border. One popover open at a time; Esc, an outside click or a selection closes it, and focus goes back to the chip. Popovers open downward from their chip and never cover the hero.

**+ menu:** Upload files · Choose from library (n ready) · Add data source · Attach MCP server. Each adds a removable chip (icon + name + ×) inside the composer. Show upload progress in the chip, using the existing upload flow.

**Model picker:** search field (filters as you type; arrow keys and Enter work). A "Recommended" group (the platform default, tagged Default, plus the recommended models the app already knows about, e.g. the Bedrock "recommended" group) and a "More models" group for every other usable model, each with one neutral tag (Fast / Balanced / Powerful / Local) where the data supports it; otherwise no tag. Models without an API key are **not listed one by one**: show a single muted row, "n models need an API key", with a "Set up" link to Admin. Same model list and default logic as today.

**Team popover:** segmented Auto / 2–3 / 4–5 / Custom (Custom shows a small number input) + a one-line hint. Map these to the existing team-size values; Auto equals today's "Let the planner choose".

**Tools picker:** top switch "Let the planner pick tools" (only if the backend supports it today; otherwise leave it out and tell me). Groups: Built in · runs privately (lookup, calculator, knowledge_search) / Web and research · sends queries out (web_search, wikipedia, arxiv, pubmed) / Data and finance · sends queries out (weather, yahoo_finance_news, wolfram_alpha) / MCP servers (attached servers and their tool counts). Derive the groups from the tool metadata the app already has (today's amber "third-party" flag), not a hard-coded list, so new tools land in the right group. Third-party groups get a globe icon instead of amber colour and stay off by default, as today. `knowledge_search` switches on automatically when a file is attached (tag "auto · n files") and off when the last one is removed; the user can override. The chip shows the number of tools switched on.

**Name:** no field. Keep today's behaviour of naming the project from the task's first line; it can be renamed from the project header.

**Accessibility:** chips are buttons with `aria-expanded`; the model list is a listbox; tool toggles use `role="switch"`; the + menu is a menu; Tab order is textarea → chips → send; Enter sends, Shift+Enter adds a new line.

**Motion:** popovers use `.ap-popover`; attachment chips fade in; the send button shimmers only when there is text. Everything respects prefers-reduced-motion.

## 4. Check before you finish
- For at least three combinations (defaults; a different model + team 4–5 + two web tools; a library file + a data source + an MCP server), capture the outgoing request before and after the change and show me that they match.
- Playwright: open each popover, check keyboard use (Tab, arrows, Enter, Esc) and run axe on the page in light and dark themes.
- Screenshot the empty page and each open popover at 1440px, then compare with `new-project-composer.png` and list any differences.
- Run the build and lint. Finish with a short summary of what changed and which files you touched.
