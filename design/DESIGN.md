# Agentic Platform — Design System & Redesign Spec

Source: Google Stitch project "Enterprise Agentic Platform Console"
(https://stitch.withgoogle.com/projects/6730811640639010643), recoloured multi-colour version.
Reference images: `screenshots/`, full-page captures of each Stitch screen at 1536px wide. Use them for layout and colour; this document is authoritative for exact values, component behaviour and anything the images get wrong.

**This is a visual reskin only.** Keep every route, API call, piece of state, data flow and behaviour as it is today.

---

## 1. Principles

- Enterprise, calm, data-dense but airy. Looks at home in a bank or a boardroom.
- Neutral base (white cards on a soft grey canvas). Colour is used **meaningfully**: one colour per phase, per agent and per metric, not as decoration.
- The primary gradient appears only on primary actions and the active state. Never more than one gradient button in view at a time.
- Motion is subtle and functional (it shows state). Respect `prefers-reduced-motion`.

## 2. Colour

### Neutrals
| Token | Hex | Use |
|---|---|---|
| `--bg-canvas` | `#F7F8FC` | App background |
| `--bg-card` | `#FFFFFF` | Cards, sidebar, top bar |
| `--bg-subtle` | `#F1F3F9` | Inputs, segmented controls, table header |
| `--border` | `#E4E7F0` | Hairline borders (1px) |
| `--text-strong` | `#0F172A` | Headings |
| `--text` | `#334155` | Body |
| `--text-muted` | `#64748B` | Secondary text, labels |
| `--code-bg` | `#0F172A` | JSON editor background |

### Primary gradient
`linear-gradient(90deg, #7C3AED 0%, #DB2777 55%, #F97316 100%)`
Used for: New project, Run graph, Compile, Review plan, Deploy, Sign in, composer send button, and the active step indicator.

### Accent palette
| Name | Hex | Soft tint (bg) |
|---|---|---|
| Violet | `#7C3AED` | `#F3EEFF` |
| Pink | `#DB2777` | `#FDEEF6` |
| Orange | `#F97316` | `#FFF2E8` |
| Teal | `#0D9488` | `#E7F7F5` |
| Emerald | `#10B981` | `#E8F8F1` |
| Amber | `#F59E0B` | `#FEF5E4` |
| Sky | `#0EA5E9` | `#E8F6FD` |
| Rose | `#E11D48` | `#FDECEF` |

### Semantic colour mapping (use these consistently)
- **Project phases (stepper):** Brief violet · Resources teal · Plan amber · Compile emerald · Run pink · Deploy orange
- **Agents (card top bar, graph node border, legend dot):** rbi_researcher violet · compliance_analyst teal · action_planner amber · report_formatter rose. For other projects, assign agents in order: violet, teal, amber, rose, sky, emerald.
- **Sidebar nav icons:** Projects violet · Knowledge teal · Data sources amber · MCP servers sky · Usage pink · Admin slate (`#64748B`)
- **Usage KPI tiles (icon, value, sparkline):** Estimated cost violet · Input tokens sky · Output tokens teal · Runs amber · Model calls pink · BigQuery billed emerald
- **Template cards (New project):** Research & summarise violet · Pros, cons, verdict teal · Question answering amber
- **Status pills (semantic, unchanged):** Completed / Ready / Connected = emerald · Warning / Queued / Price not set = amber · Failed = rose · Running = sky · Idle / Skipped = slate

### Special surfaces
- **Sign-in left panel:** mesh gradient `#1E1B4B → #4C1D95` with soft radial glows of pink (`#DB2777` at ~25%) and orange (`#F97316` at ~15%). Content chips on it are glassy: `rgba(255,255,255,0.08)` with a `1px rgba(255,255,255,0.15)` border and `backdrop-filter: blur(12px)`.
- **New project hero glow:** a soft radial blend of violet, pink and orange at ~12% opacity behind the headline.
- **Usage chart bars:** vertical gradient `#7C3AED → #DB2777`, with the latest/highlighted bar in orange.

## 3. Typography
- UI: **Inter** (400/500/600/700). Code, IDs, agent keys, model names: **JetBrains Mono** (400/500).
- Scale: Page title 28/34 600 · Section title 18/26 600 · Card title 15/22 600 · Body 14/22 400 · Small/label 12/16 500 · Overline 11/16 600 uppercase, letter-spacing 0.06em.
- Headings use letter-spacing -0.01em.

## 4. Layout, spacing, shape
- Sidebar 248px (collapsible to 64px). Top bar 56px. Content max-width 1280px, side padding 32px.
- 4px spacing grid; card padding 20–24px; gap between cards 16–20px.
- Radius: cards 12px, inputs/buttons 10px, pills 999px.
- Shadows: card `0 1px 2px rgba(15,23,42,.04), 0 4px 16px rgba(15,23,42,.04)`; raised/hover `0 8px 24px rgba(15,23,42,.08)`; primary button glow `0 6px 20px rgba(219,39,119,.25)`.

## 5. Shared components (build these once, reuse everywhere)

> **Source of truth for the phase chrome:** `reference/phase-chrome.html` (rendered in `reference/phase-chrome.png`) is a working HTML/CSS implementation of the ProjectHeader, PhaseStepper (all four current-page states), StickyFooter and the Run-graph AgentNode, built with the tokens in this pack. Port it 1:1 to React. Stitch drew these slightly differently on each screenshot (connector length, title size, pill casing); where a screenshot and the reference differ, **follow the reference**.

1. **Sidebar:** logo + "Agentic Platform"; full-width gradient **New project** button; WORKSPACE section (Projects, Knowledge, Data sources, MCP servers, Usage, Admin), each with a coloured icon and a count/badge on the right; RECENT section (recent project names); footer with API docs link and the user avatar, email and sign-out. The active item gets a soft tinted pill in its own colour with a 3px left accent.
2. **TopBar:** breadcrumb (Projects / RBI Compliance Tracker / Run), an "API online" emerald pill with a pulsing dot, and the theme toggle.
3. **ProjectHeader:** identical on every project phase page. Project title (28px, editable pencil), pills `sequential` (violet tint) and `Ready to run` (emerald with dot), monospace project ID with copy icon, and a single outlined **Assistant** button on the right with a gradient sparkle icon. Nothing else: no version-history buttons, SLA badges or region text.
4. **PhaseStepper:** one component, **pixel-identical on Brief, Resources, Plan, Compile, Run and Deploy**. Only the active step changes. Each step is a link to its page.
   - Container: white card, full content width, 12px radius, 1px `--border`, 20px padding, six equal columns.
   - Each column: a 28px circle centred above a two-line label. Line 1 is "1. Brief" (13px, 600); line 2 is the status (12px, `--text-muted`): Brief "Defined" · Resources "Attached"/"Optional" · Plan "v2 · 4 agents" · Compile "Compiled" · Run "Ready" · Deploy "Not deployed". Use real status values from the API.
   - Circles are joined by a 2px horizontal connector, running from the right edge of one circle to the left edge of the next (never past the first or last circle).
   - **Completed:** circle filled with the phase colour, white check icon. The connector to the next step is in this phase's colour **only if the next step is also completed**; otherwise it is grey.
   - **Active:** circle filled with the phase colour showing a white number, plus a 4px soft ring (`box-shadow: 0 0 0 4px <phase>-soft`); label in the phase colour; the whole column gets the phase's soft tint background with 10px radius.
   - **Pending:** white circle, 1.5px `--border`, grey number; grey connector; muted label.
   - States reflect the **project**, so they are the same on every page; only the highlighted current-page column moves.
   - Do **not** use "STEP 1" overlines, "ACTIVE" text, bordered tiles or connectors that extend past the end circles.
   - Under 900px wide, the labels collapse to circles only, with a tooltip.
5. **StickyFooter:** identical on every project phase page. A full-width white bar fixed to the bottom of the content area, with a 1px top border and a subtle upward shadow. Helper text on the left (13px muted); on the right, an outlined "← Back to X" button and a primary gradient "Next →" button. The text and buttons per page are in the table in section 6.
6. **Card / SectionHeader:** white card, title + muted subtitle inline, optional right-side action.
7. **StatusPill:** tinted background, coloured text, optional leading dot.
8. **GradientButton:** primary gradient with shimmer (see Motion); secondary = white + border; ghost = text only.
9. **AgentNode (Run graph):** 220px wide; index (mono 11px) on line 1, the full agent key on line 2 (mono 14px, never wrapped or truncated), status pill on its own line, then one muted meta line (model · tools) that may truncate. 3px top border in the agent colour; the running node gets a sky glow. If four nodes don't fit, the graph scrolls horizontally.
10. **AgentCard:** coloured 3px top bar; `01` index; agent key (mono) + role; model pill; system-prompt excerpt in a subtle box; tool chips; "Depends on" footer.
11. **ToolChip:** mono 12px; selected = violet tint + check icon; unselected = white + border.
12. **KpiTile:** icon in a tinted square, label, big value, delta or helper line, sparkline in the tile colour.

## 6. Screens

| Screen | Key content | Footer |
|---|---|---|
| **Sign in** (`00-sign-in.png`) | Split 50/50. Left: aubergine mesh, headline "Describe a task. Get a team of agents that does it.", mini pipeline of 3 glass chips (Researcher Completed → Analyst Running → Writer Queued), 3 feature rows. Right: card with Sign in / Create account tabs, email, password (eye toggle), gradient Sign in button. | — |
| **New project** (`01-new-project-home.png`) | Centred hero "What should your agent team do?" + one supporting line, soft gradient glow. One composer (placeholder "Describe the task, or ask how to start..."), chips Add files / Add data / Add MCP / "Auto team size · Default model · 3 of 10 tools", round gradient send button. Three minimal template cards below. **Keep it uncluttered.** | Enter / Shift+Enter hint text |
| **Brief** (`02-brief.png`) | Task brief card + Details side card (Created, Last changed, Agents). Models & tools card: "Use one model for all" select, then one row per agent: key, role, model select, tool chips. | "The task brief is fixed once a plan exists…" · Review plan → |
| **Resources** (no screen) | Tabs Documents / Databases / MCP tools; "Where your files go" info box; dropzone; Agent access side card. Use the shared components. | Optional… · ← Brief · Review plan → |
| **Plan** (`03-plan.png`) | Overview card (Pattern pill, limit pills: 8 tool steps per agent, 3 attempts per agent, 300s per run). **Keep this card even though the screenshot omits it**: place it between the stepper and Agents, in the same card style. Agents "4 in this team" + Edit as JSON; 2-column grid of AgentCards. | "This plan is compiled and ready to run." · ← Brief · Compile → |
| **Compile** (`04-compile.png`) | Execution flow: 4 stage boxes with coloured top bars and arrows; explanatory note. Status side card (emerald "Compiled" + Compile again). Run limits card. | "Compiling checks every agent's tools…" · ← Plan · Run → |
| **Run** (`05-run.png`) | Orchestration canvas (React Flow): Start → agents → End, nodes with an agent-colour border, status badge and a legend row; History button. Full graph / Single agent toggle; Task input (JSON) dark editor; gradient Run graph; Result card. | "Runs are saved on the server…" · ← Compile · Deploy → |
| **Deploy** (no screen) | Deployment card (Amazon Bedrock AgentCore Runtime, Not deployed pill, gradient Deploy to AgentCore); "Once it's live" card. | "A deployment serves the plan version…" · ← Run |
| **Usage** (`06-usage.png`) | Range segmented control (7/30/90 days) + project select; sync line; 6 KPI tiles; amber "Some models have no price yet" banner; cost-per-day bar chart; tabs Models / Activity / Projects / Runs with a table. | — |
| **Admin** (no screen) | Same filters and KPI tiles; Users table; "How cost is counted" note. | — |
| **Projects / Knowledge / Data sources / MCP servers** (no screens) | Page title + subtitle + gradient action button top-right; content in cards and tables using the shared components and pills. | — |

## 7. Motion
Motion should be quick, quiet and tied to state. All classes are in `tokens/motion.css` (plain CSS, no animation library; see TECH_STACK.md). Durations: 160ms (hover/press), 240ms (enter), 400ms (state changes). Easing `cubic-bezier(.2,.7,.2,1)`. **Everything turns off under `prefers-reduced-motion: reduce`.**

### Global
| Where | Animation | Class |
|---|---|---|
| Route change | Content fades in and rises 8px; the sidebar and top bar stay still | `.ap-page` |
| Cards / sections | Fade and rise, staggered 40ms per card (set `style="--i: n"`) | `.ap-enter` |
| Primary gradient buttons | Slow shimmer sweep every ~3s; hover lifts 1px with a stronger glow; press flattens | `.ap-btn-primary` |
| Secondary buttons, cards that are links | Hover lifts 1–2px with a raised shadow | `.ap-lift` |
| Sidebar active item | The tinted pill slides to the new item (shared-layout / transform) | `.ap-nav-indicator` |
| "API online" dot, live badges | Gentle pulse ring | `.ap-dot.ap-dot--live` |
| Loading data | Shimmer skeletons in the shape of the final content (no spinners for page loads) | `.ap-skeleton` |
| Tabs / segmented controls | Underline or pill slides between options | `.ap-nav-indicator` |
| Toasts / banners | Slide down and fade in; fade out | `.ap-toast` |
| Modals / Assistant drawer | Overlay fades; panel scales from 98% (modal) or slides in from the right (drawer) | `.ap-modal`, `.ap-drawer` |

### Per page
| Page | Animation |
|---|---|
| **Sign in** | The background mesh drifts very slowly (20s loop, `.ap-mesh`); the three pipeline chips light up in sequence (Completed → Running → Queued) on a loop. |
| **New project** | The hero glow breathes slowly (`.ap-glow-breathe`); the composer border becomes a gradient on focus (`.ap-focus-ring`); template cards lift on hover; the send button shimmers only when there is text. |
| **Brief** | Tool chips pop slightly (scale 0.96→1, 160ms) when toggled; model selects use the standard focus ring. |
| **Plan** | Agent cards enter in staggered order, matching the agent index; "Edit as JSON" crossfades between the cards and the editor. |
| **Compile** | Stage boxes enter left→right; connectors draw in after each stage (`.ap-connector-fill`); on success the status card's check draws in (`.ap-check-draw`) with a brief emerald glow. |
| **Run** | **Existing Run-graph animations are the floor**: keep every one (restyled) or replace it with something at least as clear; new motion is added on top (see the baseline/comparison steps in CLAUDE_CODE_PROMPT.md). Running node: sky glow pulse (`.ap-node--running`) plus a spinner dot in its badge. Edges into running/queued nodes: dashed flow (`.ap-edge-flow`, React Flow edge className). Completed node: check pops and the border turns emerald (400ms). Failed node: short shake (`.ap-shake`, 300ms) and a rose border. The stepper and the "Run graph" button switch to a disabled shimmer while running. Result text streams in as it arrives. |
| **Deploy** | The deploy button shows progress; when the deployment goes live, the status pill transitions Not deployed → Deploying (pulsing) → Live (emerald). |
| **Usage / Admin** | KPI values count up from 0 on first load (600ms, `useCountUp` from the pack); sparklines draw left→right (`.ap-draw-line`); chart bars grow up from the baseline, staggered (`.ap-bar-grow`); table rows fade in. |
| **Phase stepper** | When a phase completes, its connector fills left→right in the phase colour (`.ap-connector-fill`) and the circle swaps number → check with a pop. |

Avoid: bouncing or elastic easing, parallax, auto-playing carousels, anything longer than 600ms, and motion on every hover in dense tables.

## 8. Do NOT copy from Stitch
The screenshots are for **look and layout**. Stitch filled them with sample content, and some of it describes features the app doesn't have. Use real data from the API, and do not build any of the following:

- **Sign in:** "v2.4 LTS / Banking & Enterprise Cloud Edition" tag, Enterprise SSO button, "Work Email STRING_EMAIL" hint, "US-East-1 OK", tenant card, SOC-2 / ISO / HIPAA badges, GuardDuty footer. Keep: headline, mesh panel, pipeline chips, three feature rows, Sign in / Create account tabs, email, password, gradient button.
- **Top bar:** notification bell with badge (unless the app has notifications). Use the app's real breadcrumb.
- **Sidebar:** the counts shown (12, 8, 24, 7) and "Live" / "Org" badges are samples; show real counts. "Recent projects" lists the user's real projects.
- **New project:** template names and descriptions should be the app's real templates.
- **Brief:** "Domain / Target sector / Output" tags, per-agent role badges ("Lead Web Scout"…), and agent descriptions, unless the plan provides them.
- **Plan:** "System prompt directive" text must be the real system prompt excerpt; "Depends on" comes from the real plan.
- **Compile:** stage roles ("Lead Web Scout"), "Bedrock: Claude 3.5 …" model lines (use the real model), "Topology: Directed Acyclic", "State Transition Chain", "v2.4-build", "0.42s latency", "CloudFormation & Bedrock AgentCore AST verified" text. Keep: four stages, the sequential notice, Compiled status + Compile again, and the run limits card.
- **Run:** node "Model / Tools" lines must be real; the JSON payload is the project's real example input; "v2.1", "Prettify" / "Load sample" only if they exist.
- **Usage:** "Financial governance & telemetry / AWS US-EAST-1" overline, date-range and "Production" selects (use the app's 7/30/90-day toggle + project select), Export CSV, "Configure pricing", deltas and "% cached" lines, avg latency column, the "Monthly soft limit & quotas" and "Quick governance actions" cards. Keep: tiles with sparklines, the price warning, the cost-per-day chart, and the model table (+ Activity / Projects / Runs tabs from the real app).
