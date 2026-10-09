# Console redesign log

The design system is `docs/design.md`; it wins any conflict. This log holds the
checklist extracted from it, the page inventory, the audits and the iteration log.

**Tools**
- `frontend/scripts/audit-tokens.mjs` counts literal colours, font sizes, spacing and
  inline styles outside the token definitions.
- `frontend/e2e/redesign-sweep.spec.js` screenshots every page at 375, 768 and 1440 px
  (plus 1440 dark). It also records serious axe violations, sideways overflow and page
  errors in `e2e/screenshots/sweep/<tag>/report.json`.

## design.md checklist (testable)

| # | Rule (from design.md) |
|---|---|
| C1 | Page canvas is warm paper `#f6f5f4`. Cards, fields and the nav bar are white `#ffffff`. |
| C2 | Card borders and dividers are 1px hairline `#e6e6e6`. |
| C3 | Text colours: ink is black at about 95%. Secondary is `#31302e`, muted is `#615d59`, faint is `#a39e98`. |
| C4 | Exactly one structural accent, blue `#0075de`. It is used for the primary CTA fill, links, the active tab and focus. No other hue paints an action. |
| C5 | The pressed state of the primary CTA is `#005bab`. |
| C6 | The sticker palette (sky, purple, pink, orange, teal, green, brown) is decoration only, never a CTA or a structural fill. |
| C7 | Deep indigo `#213183` is used for a single "night" hero moment, not repeated bands. |
| C8 | One family, Inter, everywhere, with `lnum` on. There is no display monospace. |
| C9 | Type scale: display-1 64/700/1.0/−2.125px · display-2 54/700/1.04/−1.875px · heading-1 40/700/1.1/−1px · heading-2 26/700/1.23/−0.625px · heading-3 22/700/1.27/−0.25px · title 20/600/1.4/−0.125px · body-md 16/400/1.5 · body-sm 15/400/1.33 · caption 14/400/1.43 · eyebrow 12/600/1.33/+0.125px. Headlines are 700 with negative tracking. Body copy is never heavy. |
| C10 | Button labels are 16px, weight 500. |
| C11 | Spacing scale: 4 · 8 · 12 · 16 · 24 · 28 · 32. Cards pad 24. |
| C12 | Radii: xs 4 for fields, small tags and chips · sm 5 for menu items, list rows and status pills · md 8 for utility buttons and small cards · lg 12 for cards · xl 16 for large containers · full for pill CTAs, badges and circular icon buttons. Form fields are never pill-shaped. |
| C13 | Text input: white, 1px `rgb(221,221,221)` border, radius 4, padding 6px, 15px text. Focus adds the level-1 shadow. |
| C14 | Elevation: cards are flat with a hairline. Raised surfaces use the level-1 layered micro-shadow. Modals, popovers and drawers use level 2. No heavy cast shadows. |
| C15 | Utility button: white, hairline border, radius 8, padding 4px 14px. |
| C16 | Badge pill: white, blue text, eyebrow type, full radius, padding 4px 8px. |
| C17 | Data table: the header uses eyebrow type in mono caps. The body uses body-sm. |
| C18 | App-shell (sidebar) row: the active row uses the primary blue as its indicator, with the small radius. |
| C19 | Content sits in a centred column of about 1080–1300px. |
| C20 | Responsive: at ≤600px, single-column stacks, full-width CTAs and 44px touch targets. Grids collapse at 768. |
| C21 | Accessibility (prompt): text contrast ≥ 4.5:1, visible focus, semantic HTML, keyboard reachable. |
| C22 | Prompt: no hard-coded colours, font sizes or spacing outside the token definitions. |

## Page inventory

Stack: React 19 + Vite, one global stylesheet (`frontend/src/styles.css`, about 5,700
lines) with CSS custom properties, and hash routing. Shared components live in
`src/components/` (ui.jsx, Sidebar, TopBar, Stepper, ItemCard, …).

| Page | Route |
|---|---|
| Sign in / create account | `/` (signed out) |
| New project (intake chat) | `#/new` |
| Projects | `#/projects` |
| Project · Brief | `#/projects/<id>/brief` |
| Project · Resources: Documents, Databases, MCP tools | `#/projects/<id>/resources/<tab>` |
| Project · Plan | `#/projects/<id>/plan` |
| Project · Compile | `#/projects/<id>/compile` |
| Project · Run | `#/projects/<id>/run` |
| Project · Deploy | `#/projects/<id>/deploy` |
| Knowledge | `#/knowledge` |
| Data sources | `#/data` |
| MCP servers | `#/mcp` |
| Usage | `#/usage` |

Plus overlays: the assistant panel, the run-history drawer and the model picker popover.

## Baseline audit (iteration 0)

Screenshots are in `frontend/e2e/screenshots/sweep/baseline/`. The token audit found 8
colours, 102 font sizes, 335 spacing values and 30 inline styles outside the tokens.

**Global issues**

| Area | Issue |
|---|---|
| C1–C5 | Cool slate canvas `#f8fafc` with an indigo accent `#4f46e5`. The spec's warm paper and single blue are not used. |
| C8 | JetBrains Mono is used for status pills, stat numbers, step hints, the health pill and sidebar labels: display text, not code. |
| C9 | Page titles are 600 at about 22px with no tracking. Body text is 14/1.55. Font sizes include 10–13.5px literals off the scale. |
| C12 | Radii are 6, 8 and 12. Inputs are 8 (spec 4). Primary buttons are 8 (spec pill). Status pills are full (spec 5). |
| C13 | Inputs are 13px with an 8px radius and a slate border. |
| C14 | Shadows are close to flat, which is fine, but use slate rgba. |
| C22 | 445 hard-coded values. |

**Specific issues**
- **Plan @375:** agent cards are cut off on the right (`article.agent`).
- **Compile @375:** the flow overflows, and `.flow` scrolls but isn't focusable (axe `scrollable-region-focusable`).
- **Brief @375:** the model picker and tool chips run wider than the screen.
- **Project header @375:** the breadcrumb truncates to "P… / Travel ag… / P".
- **Projects and Usage @375:** tables scroll sideways inside their wrapper (acceptable).
- **Usage:** stat numbers are in mono, and the chart bars use the indigo accent.

**Baseline scores (1–5)**

Columns: Adh = adherence to design.md, Hier = hierarchy, Cons = consistency, Space = spacing and alignment, Resp = responsiveness, A11y = accessibility, States = hover, empty, error and similar.

| Page | Adh | Hier | Cons | Space | Resp | A11y | States |
|---|---|---|---|---|---|---|---|
| Sign in | 2 | 4 | 3 | 4 | 4 | 4 | 4 |
| New project | 2 | 4 | 3 | 3 | 3 | 4 | 4 |
| Projects | 2 | 3 | 3 | 3 | 3 | 4 | 3 |
| Brief | 2 | 3 | 3 | 3 | 2 | 4 | 3 |
| Resources (3 tabs) | 2 | 3 | 3 | 3 | 3 | 4 | 3 |
| Plan | 2 | 3 | 3 | 3 | 2 | 4 | 3 |
| Compile | 2 | 3 | 3 | 3 | 2 | 3 | 3 |
| Run | 2 | 3 | 3 | 3 | 3 | 4 | 4 |
| Deploy | 2 | 3 | 3 | 3 | 3 | 4 | 3 |
| Knowledge | 2 | 3 | 3 | 3 | 3 | 4 | 3 |
| Data sources | 2 | 4 | 4 | 3 | 4 | 4 | 4 |
| MCP servers | 2 | 4 | 4 | 3 | 4 | 4 | 4 |
| Usage | 2 | 3 | 3 | 3 | 3 | 4 | 3 |

## Decisions where design.md is silent

| # | Decision | Why |
|---|---|---|
| D1 | Dark mode is kept, with derived tokens: warm near-black canvas `#191918`, surface `#232322`, ink `#e3e2e0`, muted `#9b9893`, links `#5eaeee`. The button fill stays `#0075de`. | The user chose to keep dark mode. The spec is light-only. Every pair is checked ≥ 4.5:1. |
| D2 | Muted status set: success `#1f7a3a`, warning `#a8480b`, danger `#c0341d`, each on a pale tint of its own hue. Info callouts are neutral (ink on warm paper), not blue. | The user chose a muted semantic set. Blue is reserved for actions, links and focus (C4). |
| D3 | Blue *text* (links, active labels) uses `#005bab`. The `#0075de` fill stays for buttons. | `#0075de` on the warm canvas is 4.19:1, below AA. `#005bab` is the spec's own pressed blue (6.25:1). |
| D4 | Ash `#a39e98` is used only for placeholders, disabled glyphs and decoration. Captions and metadata use Stone `#615d59`. | Ash on white is 2.66:1, so it fails AA as readable text. |
| D5 | Mono (JetBrains Mono) stays for code, JSON, SQL, ids, model names and table headers (C17). It is removed from status pills, numbers, labels and display text. | The spec has no mono, but a developer console shows code. C17 itself asks for mono-caps table headers. |
| D6 | The base UI text is body-sm 15px with a 1.5 line height, not 1.33. | 1.33 is cramped for multi-line console text. 1.5 matches the spec's "comfortable" body rhythm. |
| D7 | Panel and section titles are 16/600, a "panel label". Page titles are heading-2 26/700/−0.625px. | Spec card titles (22/700) are marketing-sized. Console panels are dense. |
| D8 | Spacing extras: 1px (`--space-px`), 2px (`--space-2xs`), 6px (`--space-field`, the spec's field padding), 14px (`--space-btn`, the spec's button padding), 48 and 64 for sections. Off-scale literals snap to the nearest step, rounding up on a tie. | The spec lists 4–32 plus "section gaps stack the larger steps". |
| D9 | The primary (blue) button is a pill (`button-primary`). Every other button is a utility button (8px, hairline). | Follows C12 and C15 literally. |
| D10 | Single-series charts use sticker teal `#2a9d99`, which is 3.4:1 for graphics. | Blue is reserved (C4). Sky fails 3:1 for non-text graphics. |
| D11 | *(Revised in iteration 4.)* Agent colours are indigo, emerald, sky, lime, teal and cyan. | The user asked for the earlier palette, without orange, pink or purple. |
| D12 | The single "night" moment (C7) is the sign-in screen's intro panel. | It's the product's only marketing-like surface. |
| D14 | The page canvas is neutral grey `#f5f6f8` (dark `#18191b`), not design.md's warm paper. The run graph sits on the white panel surface with a dot grid. | The user found the warm beige hard on the eyes. This overrides C1 and C3's warm greys. |
| D15 | No pink or purple anywhere. The sticker palette is reduced to teal (charts). The sign-in indigo night band stays. | User request. |
| D13 | Inline `style` attributes that carry data (agent colours, computed positions and widths) are allowed. Only literal spacing, size and colour values count against C22. | Those values come from data, not design. |

## Iteration log

### Iteration 1: Foundations (tokens, global type, inputs, buttons)

**Changed**
- **Token layer** (`styles.css` `:root` and both dark blocks), rebuilt from design.md:
  - colour primitives: canvas-soft, hairline, ink ramp, primary and pressed, secondary, the sticker palette;
  - role tokens, keeping the legacy names as aliases;
  - the muted status set (D2) and the derived dark theme (D1);
  - the spacing scale (D8), the type scale (sizes, line heights, tracking), the radius scale;
  - the level-1 and level-2 shadows and the content width.
- **Codemod:** 339 spacing values, 100 font sizes and 34 radii were turned into tokens. Layout widths it had wrongly snapped were restored as named tokens (timeline columns, chat width).
- **Base:**
  - 15px body text with a 1.5 line height (D6), lining numerals, a global blue `:focus-visible` ring, and reduced motion respected;
  - page titles are heading-2 (26/700/−0.625px), panel titles 16/600 (D7);
  - panels are flat with a hairline, 12px radius and 24px padding.
- **Inputs (C13):** white, `#ddd` border, 4px radius, 6px padding, 15px text, Ash placeholder.
- **Buttons:**
  - utility (C15): 8px radius, hairline, 4/14 padding, 16/500 label, press scale 0.97;
  - primary: a blue pill, pressed `#005bab`;
  - 44px touch targets on phones.
- **Pills and tags:** status pills use eyebrow type with a 5px radius. `pill--accent` is the badge-pill (white, blue text, full radius). Chips are 4px.
- **Sidebar:** labels are Inter eyebrow. The active row is neutral with a blue inset indicator (C18). Stepper hints are Inter, not mono.
- **Tables:** mono-caps eyebrow headers (C17) and 15px rows.
- **Inline styles:** the 17 literal inline styles became token-based utility classes.
- **Agent colours:** the sticker palette via `--agent-1…9` (D11).

**Verified**
- The token audit is at 0 / 0 / 0 / 0.
- Lint is clean and all 84 unit tests pass.
- The first sweep found white-on-blue text failing in dark mode: `--on-primary` pointed at the dark-mode surface colour. Fixed by making it literal white.

**Self-critique, carried to iteration 2**
- The brand mark is painted the action blue.
- Stat numbers and many labels are still monospace.
- The chart is blue.
- The sign-in intro isn't the night band yet.
- At 375px the page titles squeeze against their actions, and the breadcrumb is unreadable.
- The Compile flow isn't keyboard-scrollable.

### Iteration 2: Components (mono cleanup, night band, brand, phones)

**Changed**
- **Monospace:** 12 rules of display text (counts, numbers, times, stage and state labels, composer buttons) moved to Inter with tabular numerals (D5). Code, JSON, ids and table headers keep mono.
- **Sign-in intro** is the single night band (C7, D12): deep indigo `#213183`, white heading-1 type, sticker-coloured agent marks, translucent icon tiles.
- **Other components:**
  - the brand mark is ink, not blue (C4);
  - stat tiles use Inter heading-3 numbers;
  - the cost chart is teal (D10).
- **Phones (≤600px):**
  - the breadcrumb shows the current page only;
  - page titles step down to heading-3, and header actions wrap below the title;
  - the action-bar note gets its own line, with full-width buttons;
  - panel padding is 16px.
- **Compile:** the flow is a focusable, named region (fixes axe `scrollable-region-focusable`).
- **Inline `display: contents`** moved to classes. As inline styles they beat the stylesheet, which is why the breadcrumb rule first failed.

**Verified**
- Sweep `iter2`: 60 views, 0 serious axe violations, 0 sideways overflow, 0 page errors.

### Iteration 3: Pages (hierarchy, type roles, phone layouts)

**Changed**
- **Type roles:** eyebrow (12px) is now used only for pill badges and small labels, about 30 rules. 64 rules of sentences, hints and metadata moved to caption (14px). 4 code rules (Markdown code block, SQL editor, MCP schema and output) moved to the code size.
- **New project:**
  - the composer's text box is 15px;
  - on phones its option buttons wrap at full size, Send stays at the end, and the long settings summary truncates with an ellipsis (it used to overflow the box).
- **Projects, phones:** the table reflows into stacked rows (`.table--stack`, design.md's tables-to-cards pattern). Agent counts gain a visible "agents" unit, and the header row stays available to screen readers.
- **Disabled primary buttons** are neutral (sunken fill, muted text), not washed-out blue: disabled isn't an action (C4).
- **Sweep:** now also captures overlays (model picker, run-history drawer, assistant panel, an expanded MCP card).

**Verified**
- Sweeps `iter3a` and `iter3b`: 60 views, 0 issues.
- Token audit 0 / 0 / 0 / 0, lint clean.

**Self-critique**
- **Minor:** the sign-in status pill sits close to the brand on phones.
- **Minor:** the run diagram's node text is small at fit-to-view (React Flow zoom).
- **Minor:** stepper labels truncate at 768px ("Reso…", "Com…"). The step number and tick still identify each step.

### Iteration 4: User feedback (palette), overlays, regressions

**User feedback (overrides design.md where they conflict)**
- The warm beige page background "hurts the eye": use a neutral grey everywhere.
- The run graph's background must differ from the page.
- No pink, and no purple used as a fill.
- Agent colours: go back to the earlier palette, without orange or the light purples.
- The sign-in indigo panel stays.

**Changed**
- **D14, neutral page:**
  - light: canvas `#f5f6f8`, sunken `#eceef1`, hairline `#e3e5e8`, strong border `#cdd1d6`, ink-secondary `#2f3338`, muted `#5b6169`, faint `#9aa0a8`;
  - dark: canvas `#18191b`, surface `#222327`, sunken `#2a2c30`, hairline `#33363b`, ink `#e5e7ea`, muted `#9ca1a8`;
  - every text pair re-checked ≥ 4.5:1 (muted 5.78:1, link 6.30:1).
- **D15, no pink or purple:** the sticker primitives purple, purple-deep, pink, orange, orange-deep, sky, green and brown are removed. Code-literal highlighting is cyan (`#0e7490` / `#67e8f9`) instead of magenta.
- **D11, revised agent colours:** indigo `#6366f1`, emerald `#10b981`, sky `#0ea5e9`, lime `#84cc16`, teal `#14b8a6`, cyan `#06b6d4`, the same in both themes. The sign-in sketch uses the first three.
- **Run graph canvas:** the panel surface with a faint dot grid (`--border-strong` dots), distinct from the grey page.
- **Layering bug:** the overlaying assistant (≤1100px) and the fullscreen assistant were at `z-index` 5–6, so the sticky stepper bar (6) covered them and took their pointer events. Once the redesign made the header taller, this broke resizing on narrow screens. Both are now 8.
- **Assistant header:** a fixed 52px height clipped the larger type. It is now a 56px minimum with padding, and the subtitle truncates to one line.
- **Tests:**
  - the theme test now expects the new canvas colours;
  - the assistant "remembered across a reload" check polls, because the first frame after a load can still be laying out the panel (one frame at 317px, then the saved width). That frame is noted under minor issues;
  - sweep overlays now start from a blank page (same-hash navigation doesn't reload) and retry opening the model picker until its list loads.

**Verified**
- Sweep `iter4`: 60 page views plus 12 overlay views. 0 serious axe violations, 0 overflow, 0 page errors.
- Assistant specs 12/12 across three repeats.
- Token audit 0 / 0 / 0 / 0.

### Iteration 5: Final polish and verification

**Changed**
- **New-project welcome heading:** now heading-2 (26/700/−0.625px), consistent with page titles. It was 22/600.
- **Markdown in agent output:** `h1` is heading-3, so it no longer matches `h2`.
- **Segmented controls everywhere:** labels stay on one line, and the strip scrolls sideways on narrow screens. At 375px the Resources tabs used to wrap "MCP tools" onto a second row.

**Self-critique, two final rounds**
- **Round A** found the welcome heading out of step with the other titles (moderate). Fixed.
- **Round B** found the Resources tabs wrapping (minor). Fixed.

**Remaining issues, all minor**
- The assistant panel renders one frame at 317px during page load before settling at its saved width.
- Run-diagram node text is small at fit-to-view (React Flow zoom).
- Stepper labels truncate at 768px ("Reso…", "Com…"); the step number and tick still identify each step.
- The sign-in status pill sits close to the brand on phones.
- `npm run build` warns about a JS chunk over 500 kB. It isn't caused by the redesign, which added no JS dependencies.

**Verified**
- Lint is clean, and unit tests pass (84).
- Token audit `{"colors":0,"fontSizes":0,"spacing":0,"inlineStyles":0}`.
- Full e2e suite: 102 passing across the final runs. That includes the strict sweep (`SWEEP_STRICT=1`) of 15 pages × 4 views plus 4 overlays × 3 views: 0 serious axe violations, 0 sideways scroll, 0 page errors.
- Production build succeeds.

## Final checklist status

| # | Status |
|---|---|
| C1 | Overridden by the user (D14): the canvas is a neutral grey, not warm paper. Cards, fields and the nav are white ✓ |
| C2 | ✓ 1px hairline (neutral `#e3e5e8` per D14) |
| C3 | ✓ near-black ink at 92–95%. The secondary, muted and faint greys are neutral per D14. All ≥ 4.5:1 |
| C4 | ✓ blue only for primary actions, links, the active tab and focus. Disabled primaries are neutral |
| C5 | ✓ pressed `#005bab` |
| C6 | ✓ the sticker palette is reduced to teal for charts (D10, D15). Agent colours per D11 |
| C7 | ✓ a single night band (sign-in intro) |
| C8 | ✓ Inter with `lnum`. Mono only for code, ids and table headers (D5) |
| C9 | ✓ the full scale is tokenised. Page titles are heading-2 700/−0.625. Body is 400 |
| C10 | ✓ buttons are 16/500 (small buttons 14, logged) |
| C11 | ✓ the 4–32 scale plus the logged extras (D8) |
| C12 | ✓ inputs 4, status pills 5, utility buttons 8, cards 12, primary and badges full |
| C13 | ✓ white, 1px field border (neutral `#d5d8dc` per D14), radius 4, padding 6, 15px. Focus is a blue border, ring and level-1 shadow |
| C14 | ✓ flat cards. Level 1 for raised surfaces, level 2 for popovers and drawers |
| C15 | ✓ |
| C16 | ✓ `pill--accent` |
| C17 | ✓ |
| C18 | ✓ |
| C19 | ✓ 1200px |
| C20 | ✓ ≤600px single column, 44px targets, full-width action bar. Tables stack |
| C21 | ✓ 0 serious axe violations across every page and overlay at three widths and dark mode |
| C22 | ✓ audit at zero |

## Final scores (1–5)

Columns as in the baseline: Adh = adherence to design.md, Hier = hierarchy, Cons = consistency, Space = spacing and alignment, Resp = responsiveness, A11y = accessibility, States = hover, empty, error and similar.

| Page | Adh | Hier | Cons | Space | Resp | A11y | States |
|---|---|---|---|---|---|---|---|
| Sign in | 5 | 5 | 5 | 4 | 4 | 5 | 5 |
| New project | 5 | 5 | 5 | 4 | 4 | 5 | 4 |
| Projects | 5 | 4 | 5 | 5 | 5 | 5 | 4 |
| Brief | 5 | 4 | 5 | 4 | 4 | 5 | 4 |
| Resources (3 tabs) | 5 | 4 | 5 | 4 | 4 | 5 | 4 |
| Plan | 5 | 4 | 5 | 4 | 4 | 5 | 4 |
| Compile | 5 | 4 | 5 | 4 | 4 | 5 | 4 |
| Run | 4 | 4 | 5 | 4 | 4 | 5 | 5 |
| Deploy | 5 | 4 | 5 | 4 | 4 | 5 | 4 |
| Knowledge | 5 | 4 | 5 | 4 | 4 | 5 | 4 |
| Data sources | 5 | 5 | 5 | 4 | 5 | 5 | 5 |
| MCP servers | 5 | 5 | 5 | 4 | 5 | 5 | 5 |
| Usage | 5 | 4 | 5 | 4 | 4 | 5 | 4 |

Run's adherence is 4 because of the small diagram text at fit-to-view, which is minor.
