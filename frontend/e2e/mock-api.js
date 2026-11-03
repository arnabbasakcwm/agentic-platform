// A scripted stand-in for the platform API, for the Playwright checks. It serves one
// signed-in user with one compiled three-agent travel project and streams run events
// with real timing, so the Run page can be captured idle, mid-run, completed and failed
// without calling a model. Answers echo the task input, so a test can prove that the
// input it typed is what reached the agents.
//
//   node e2e/mock-api.js [port]
//
// Scenario per run, chosen by the task input: {"scenario": "fail"} times out midway,
// {"scenario": "slow"} pauses after the first agent (for mid-run screenshots); anything
// else completes.

import http from "node:http";

const PORT = Number(process.argv[2] ?? process.env.MOCK_API_PORT ?? 8765);
const PROJECT_ID = "e2e0travel0project";

const llm = { provider: "google_genai", model: "gemini-3.1-pro-preview", temperature: 0, extra_params: {} };
const plan = {
  agents: [
    { id: "flight_searcher", role: "Flight search specialist", system_prompt: "Search flights for the trip in the task input.", llm, tools: ["web_search"], depends_on: [], output_schema: "default" },
    { id: "price_analyzer", role: "Fare analyst", system_prompt: "Compare the fares found.", llm, tools: ["calculator"], depends_on: ["flight_searcher"], output_schema: "default" },
    { id: "travel_advisor", role: "Travel advisor", system_prompt: "Recommend the top options.", llm, tools: [], depends_on: ["price_analyzer"], output_schema: "default" },
  ],
  orchestration_pattern: "sequential",
  supervisor_id: null,
  bounds: { max_steps: 8, timeout_s: 300, max_retries: 3 },
  example_input: { origin: "Kolkata (CCU)", destination: "New Delhi (DEL)", month: "October" },
};
const project = {
  project_id: PROJECT_ID,
  brief: "Travel agent for finding cheap flights",
  // Like the API: the name it was given, else the brief's first line.
  name: "Travel agent for finding cheap flights",
  named: false,
  plan,
  plan_version: 2,
  compiled: true,
  side_effect_tools_enabled: ["web_search"],
  conversation: [],
  deployment: null,
  knowledge: { documents: 0, ready: 0, embedding: null },
  data_sources: { sources: 0, tables: 0 },
  mcp: { servers: 0, tools: [] },
  created_at: "2026-10-01T06:00:00Z",
  updated_at: "2026-10-01T06:09:54Z",
};

function trip(input) {
  const from = input.origin ?? "your origin";
  const to = input.destination ?? "your destination";
  return { from, to, month: input.month ?? "your dates" };
}

function outputs(input) {
  const base = baseOutputs(input);
  if (input.scenario !== "rich") return base;
  // {"scenario": "rich"}: a CSV answer, a cited web/document answer, and an answer whose
  // Sources the platform had to append (for the CSV table and citation checks).
  return {
    flight_searcher: {
      ...base.flight_searcher,
      content: "## Flights found\n\nIndiGo runs 6 daily departures [1]. The company fare sheet lists ₹7,004 as the lowest fare [2].\n\n## Sources\n[1] IndiGo schedule — https://www.goindigo.in/schedule\n[2] fares.pdf, p. 3",
      citations: [
        { n: 1, kind: "web", source_id: "1", title: "IndiGo schedule", url: "https://www.goindigo.in/schedule", domain: "www.goindigo.in", retrieved_at: "2026-11-03T09:30:00Z", snippet: "Six daily departures from Kolkata to Delhi." },
        { n: 2, kind: "document", source_id: "2", document_id: "doc1", document_name: "fares.pdf", location: "p. 3", chunk_id: "c7", snippet: "Lowest fare: ₹7,004 (Akasa Air, mornings)." },
      ],
      citations_auto_appended: false,
    },
    price_analyzer: input.broken
      ? // Says it's CSV but a quote is never closed: the tab falls back to the raw text.
        { ...base.price_analyzer, content_type: "text/csv", content: 'airline,fare\n"Akasa Air,7004\nIndiGo,8249' }
      : input.rows
        ? {
            ...base.price_analyzer,
            content: ["route,fare_inr", ...Array.from({ length: input.rows }, (_, i) => `Route ${i + 1},${1000 + ((i * 37) % 500)}`)].join("\n"),
          }
        : {
            ...base.price_analyzer,
            content: 'airline,fare_inr,notes\nAkasa Air,7004,"Promotional, mornings only"\nIndiGo,8249,Most flexible\nAir India,,"Full service, ""premium"""\nSpiceJet,6899,<script>alert(1)</script>',
          },
    travel_advisor: {
      ...base.travel_advisor,
      content: "Book Akasa Air early.\n\n## Sources\n[1] Akasa fares — https://www.akasaair.com/fares",
      citations: [
        { n: 1, kind: "web", source_id: "1", title: "Akasa fares", url: "https://www.akasaair.com/fares", domain: "www.akasaair.com", retrieved_at: "2026-11-03T09:31:00Z", snippet: "Morning promotional fares." },
      ],
      citations_auto_appended: true,
    },
  };
}

function baseOutputs(input) {
  const { from, to, month } = trip(input);
  return {
    flight_searcher: {
      content: `## Flights found: ${from} → ${to}\n\nSearched **4 airlines** for ${month}. Direct flights take **2h 15m–2h 35m**.\n\n- IndiGo — 6 daily departures\n- Air India — morning and late-night\n- Akasa Air — promotional morning fares\n- SpiceJet — last flight around 11:20 PM`,
      data: {
        origin: from,
        destination: to,
        travel_month: month,
        cheapest_one_way_price_inr: 7004,
        cheapest_round_trip_price_usd: 118,
        airlines: [
          { airline: "IndiGo", departures_per_day: 6, fare_inr: 8249 },
          { airline: "Air India", departures_per_day: 2, fare_inr: 8528 },
          { airline: "Akasa Air", departures_per_day: 1, fare_inr: 7004 },
        ],
      },
    },
    price_analyzer: {
      content: `### Fare comparison\n\n| Airline | One-way (INR) | Notes |\n|---|---|---|\n| Akasa Air | ₹7,004 | Promotional, mornings only |\n| IndiGo | ₹8,249–₹8,849 | Most flexible |\n| Air India | ₹8,528–₹9,128 | Full service |\n\nRound trips start around **$118 (USD)** — quoted in USD by the source, not converted.`,
      data: { lowest_fare_inr: 7004, median_fare_inr: 8528, spread_inr: 2124 },
    },
    travel_advisor: {
      content: `Here are the top 3 options for **${from} → ${to}** in ${month}:\n\n### 🥇 1. Budget pick: Akasa Air\n* **Schedule:** Morning departures\n* **Fare:** from **₹7,004** one-way\n* **Why:** Cheapest on the route; book early.\n\n### 🥈 2. Most flexible: IndiGo\n* **Schedule:** 05:20, 08:25, 12:00, 16:10, 21:00, 22:30\n* **Fare:** ₹8,249–₹8,849\n\n### 🥉 3. Full service: Air India\n* **Schedule:** Morning and late-night\n* **Fare:** ₹8,528–₹9,128\n\n> **Tip:** October is festival season — fares climb as dates fill. Compare live prices at https://www.example.com/flights/search?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&month=${encodeURIComponent(month)}&sort=price_ascending&cabin=economy before booking.`,
      data: {
        recommendations: [
          { rank: 1, airline: "Akasa Air", fare_inr: 7004 },
          { rank: 2, airline: "IndiGo", fare_inr: 8249 },
          { rank: 3, airline: "Air India", fare_inr: 8528 },
        ],
      },
    },
  };
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function streamRun(req, res, input) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  let open = true;
  req.on("close", () => (open = false));
  const t0 = Date.now() / 1000;
  const emit = (event, data) => {
    if (open) res.write(`event: ${event}\ndata: ${JSON.stringify({ ...data, at: Date.now() / 1000 })}\n\n`);
  };
  const out = outputs(input);
  const step = Number(input.step_ms ?? 400);

  emit("run_started", { timeout_s: plan.bounds.timeout_s });
  for (const [i, agent] of plan.agents.entries()) {
    if (!open) return;
    const started = Date.now();
    emit("node_started", { node: agent.id });
    if (input.scenario === "slow" && i === 1) await sleep(120_000);
    if (input.scenario === "fail" && i === 1) {
      await sleep(step);
      emit("run_failed", {
        error_type: "RunTimeout",
        message: "the run exceeded its 60s time limit",
        limit_s: 60,
      });
      return res.end();
    }
    await sleep(step * (i + 1));
    emit("node_completed", { node: agent.id, duration_ms: Date.now() - started, attempts: 1, output: out[agent.id] });
  }
  emit("run_completed", {
    duration_ms: Math.round((Date.now() / 1000 - t0) * 1000),
    outputs: out,
    usage: RUN_USAGE,
    errors: [],
    halted: false,
  });
  res.end();
}

// ---- saved runs: like the real API, runs execute "on the server" (here: timers) and are
// kept as records the console reopens from anywhere. Last 10 per project and kind.
const savedRuns = { list: [], seq: 0 };
const nowIso = () => new Date().toISOString();

function newRun(kind, { input = {}, mode = "graph", agent_id = null }, planVersion) {
  savedRuns.seq += 1;
  const run = {
    id: `run${savedRuns.seq}`, project_id: PROJECT_ID, kind, mode, agent_id, plan_version: planVersion,
    status: "running", input, events: [], outputs: {}, errors: [], halted: false, error: null, usage: null,
    timeout_s: plan.bounds.timeout_s, started_at: nowIso(), finished_at: null, updated_at: nowIso(),
  };
  savedRuns.list.unshift(run);
  const ofKind = savedRuns.list.filter((r) => r.kind === kind);
  for (const old of ofKind.slice(10)) savedRuns.list = savedRuns.list.filter((r) => r !== old);
  return run;
}

function record(run, event, data) {
  if (run.status !== "running") return; // stopped: the abandoned simulation records nothing
  const { output, ...rest } = data;
  if (event === "node_completed") run.outputs[data.node] = output;
  run.events.push({ event, ...rest, at: Date.now() / 1000 });
  run.updated_at = nowIso();
}

function finish(run, changes) {
  if (run.status !== "running") return;
  Object.assign(run, { finished_at: nowIso(), updated_at: nowIso() }, changes);
}

// The same scripted run as /run/stream, saved instead of streamed.
async function simulateRun(run, input) {
  const out = outputs(input);
  const step = Number(input.step_ms ?? 400);
  const t0 = Date.now();
  record(run, "run_started", { timeout_s: plan.bounds.timeout_s });
  for (const [i, agent] of plan.agents.entries()) {
    const started = Date.now();
    record(run, "node_started", { node: agent.id });
    if (input.scenario === "slow" && i === 1) await sleep(120_000);
    if (input.scenario === "fail" && i === 1) {
      await sleep(step);
      const error = { error_type: "RunTimeout", message: "the run exceeded its 60s time limit", limit_s: 60 };
      record(run, "run_failed", error);
      return finish(run, { status: "failed", error });
    }
    await sleep(step * (i + 1));
    record(run, "node_completed", { node: agent.id, duration_ms: Date.now() - started, attempts: 1, output: out[agent.id] });
  }
  record(run, "run_completed", { duration_ms: Date.now() - t0, outputs: out, usage: RUN_USAGE, errors: [], halted: false });
  finish(run, { status: "completed", usage: RUN_USAGE });
}

async function simulateAgent(run, agentId, input) {
  record(run, "run_started", { timeout_s: plan.bounds.timeout_s });
  await sleep(500);
  const output = outputs(input)[agentId];
  record(run, "run_completed", { duration_ms: 500, outputs: { [agentId]: output }, errors: [], halted: false });
  finish(run, { status: "completed", outputs: { [agentId]: output } });
}

async function simulateDeployed(run, input) {
  await sleep(Number(input.step_ms ?? 1500));
  finish(run, { status: "completed", outputs: outputs(input), usage: RUN_USAGE });
}

const runSummary = ({ events, outputs: outs, input, ...rest }) => ({ ...rest, agents_done: Object.keys(outs).length });

async function streamSaved(req, res, run, after) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  let open = true;
  req.on("close", () => (open = false));
  let index = after;
  while (open) {
    for (; index < run.events.length; index += 1) {
      const { event, ...data } = run.events[index];
      const body = event === "node_completed" ? { ...data, output: run.outputs[data.node] } : data;
      res.write(`event: ${event}\ndata: ${JSON.stringify(body)}\n\n`);
    }
    if (run.status !== "running") break;
    await sleep(100);
  }
  res.end();
}

// ---- usage: a fixed, realistic month of usage for the Usage page.
const RUN_USAGE = {
  currency: "USD",
  entries: [],
  input_tokens: 41200,
  output_tokens: 9650,
  cost: 0.198,
  unpriced_models: [],
};

function usageBody(days, projectId) {
  const today = new Date();
  const byDay = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    // A deterministic pattern: quiet days, a few busy ones.
    const n = (d.getUTCDate() * 7) % 11;
    const cost = n < 4 ? 0 : Number((n * 0.031).toFixed(4));
    byDay.push({
      date: d.toISOString().slice(0, 10),
      cost,
      calls: n,
      input_tokens: n * 9000,
      output_tokens: n * 2100,
      unpriced_tokens: n === 9 ? 1200 : 0,
    });
  }
  const sum = (key) => byDay.reduce((t, d) => t + d[key], 0);
  const totalCost = Number(sum("cost").toFixed(4));
  const agents = [
    { agent_id: "flight_searcher", kind: "run", provider: "google_genai", model: "gemini-3.1-pro-preview", calls: 4, input_tokens: 28100, output_tokens: 6200, cost: 0.1306, estimated: false },
    { agent_id: "flight_searcher", kind: "embedding_query", provider: "google_genai", model: "gemini-embedding-001", calls: 2, input_tokens: 14, output_tokens: 0, cost: null, estimated: true },
    { agent_id: "flight_searcher", kind: "bigquery_query", provider: "bigquery", model: "on-demand", calls: 1, input_tokens: 0, output_tokens: 0, bytes_billed: 23068672, cost: null, estimated: false },
    { agent_id: "travel_advisor", kind: "run", provider: "google_genai", model: "gemini-3.1-pro-preview", calls: 1, input_tokens: 13100, output_tokens: 3450, cost: 0.0676, estimated: false },
  ];
  const run = (id, hoursAgo, deployed) => ({
    run_id: id,
    project_id: PROJECT_ID,
    project: project.brief,
    deployed,
    at: new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString(),
    calls: 7,
    input_tokens: 41214,
    output_tokens: 9650,
    cost: 0.1982,
    unpriced_tokens: 14,
    agents,
  });
  const projects = [
    { project_id: PROJECT_ID, name: project.brief, exists: true, runs: 2, calls: sum("calls") - 3, input_tokens: sum("input_tokens") - 20000, output_tokens: sum("output_tokens") - 4000, cost: Number((totalCost - 0.06).toFixed(4)), unpriced_tokens: 1200 },
    { project_id: "gone", name: "Deleted project", exists: false, runs: 0, calls: 3, input_tokens: 20000, output_tokens: 4000, cost: 0.06, unpriced_tokens: 0 },
  ];
  return {
    currency: "USD",
    days,
    totals: {
      calls: sum("calls"),
      input_tokens: sum("input_tokens"),
      output_tokens: sum("output_tokens"),
      cost: totalCost,
      unpriced_tokens: sum("unpriced_tokens"),
      runs: 2,
      estimated_tokens: 14,
      bytes_billed: 23068672,
    },
    by_day: byDay,
    by_model: [
      { provider: "google_genai", model: "gemini-3.1-pro-preview", priced: true, estimated: false, calls: sum("calls") - 2, input_tokens: sum("input_tokens") - 14, output_tokens: sum("output_tokens"), cost: totalCost, unpriced_tokens: 0 },
      { provider: "google_genai", model: "gemini-embedding-001", priced: false, estimated: true, calls: 2, input_tokens: 14, output_tokens: 0, cost: 0, unpriced_tokens: 14 },
      { provider: "bigquery", model: "on-demand", priced: false, estimated: false, calls: 1, input_tokens: 0, output_tokens: 0, bytes_billed: 23068672, cost: 0, unpriced_tokens: 0 },
    ],
    by_project: projectId ? projects.filter((x) => x.project_id === projectId) : projects,
    by_kind: [
      { kind: "run", calls: sum("calls") - 6, input_tokens: sum("input_tokens") - 9000, output_tokens: sum("output_tokens") - 2000, cost: Number((totalCost - 0.05).toFixed(4)), unpriced_tokens: 0 },
      { kind: "planner", calls: 2, input_tokens: 6000, output_tokens: 1500, cost: 0.03, unpriced_tokens: 0 },
      { kind: "assistant", calls: 2, input_tokens: 3000, output_tokens: 500, cost: 0.02, unpriced_tokens: 0 },
      { kind: "embedding_query", calls: 2, input_tokens: 14, output_tokens: 0, cost: 0, unpriced_tokens: 14 },
      { kind: "bigquery_query", calls: 1, input_tokens: 0, output_tokens: 0, bytes_billed: 23068672, cost: 0, unpriced_tokens: 0, unpriced_bytes: 23068672 },
      { kind: "embedding_index", calls: 1, input_tokens: 4000, output_tokens: 0, cost: 0, unpriced_tokens: 4000 },
      { kind: "model_check", calls: 1, input_tokens: 300, output_tokens: 40, cost: 0.001, unpriced_tokens: 0 },
      { kind: "mcp_call", calls: 3, input_tokens: 0, output_tokens: 0, cost: 0, unpriced_tokens: 0 },
    ],
    recent_runs: [run("run-local", 2, false), run("run-deployed", 26, true), { ...run("run-direct", 30, true), via: "direct" }],
    deployments: [
      { project_id: PROJECT_ID, name: project.brief, reports_usage: true, synced_until: usageSync.at, last_sync: usageSync.last },
      { project_id: "e2e0old0deploy", name: "Old deployed flow", reports_usage: false, synced_until: null, last_sync: null },
    ],
    sync_available: true,
  };
}

// The last project-creation request, for tests to inspect.
const created = { last: null };
// Admin: users with usage, and whether the signed-in e2e user (u1) is an admin.
function adminSeed() {
  return [
    { id: "u1", email: "e2e@example.com", role: "user", created_at: "2026-10-01T00:00:00Z", projects: 1,
      last_active: "2026-10-12T05:00:00Z", calls: 40, input_tokens: 120000, output_tokens: 9000, cost: 0.42, unpriced_tokens: 0, runs: 6, deployed_runs: 1 },
    { id: "u2", email: "ada@example.com", role: "user", created_at: "2026-10-03T00:00:00Z", projects: 3,
      last_active: "2026-10-11T09:00:00Z", calls: 90, input_tokens: 800000, output_tokens: 60000, cost: 2.75, unpriced_tokens: 1200, runs: 14, deployed_runs: 0 },
    { id: "u3", email: "bob@example.com", role: "user", created_at: "2026-10-05T00:00:00Z", projects: 0,
      last_active: null, calls: 0, input_tokens: 0, output_tokens: 0, cost: 0, unpriced_tokens: 0, runs: 0, deployed_runs: 0 },
  ];
}
const admin = { users: adminSeed() };
const me = () => admin.users.find((u) => u.id === "u1");
// The last intake conversation sent, for tests to inspect.
const briefChats = { last: null };
// The last change request the assistant sent (its chips' fields included).
const revises = { last: null };
const exports = { last: null };
const emails = { last: null };

// Deploys: off ("AWS not set up") unless a test turns them on with POST /__deploy_available.
const deploys = { available: false, current: null, count: 0 };

// The deployed-usage sync: "Sync now" moves the cursor and records the result.
const usageSync = { at: null, last: null };

// The knowledge spec changes the project (uploads, a revision); it resets it afterwards
// so the other specs see the original.
const PRISTINE = structuredClone(project);

// ---- data sources: one BigQuery project with a "mydata" dataset.
const BQ = { project: "agenticdb-510807", sa: "agentic-bq-reader@agenticdb-510807.iam.gserviceaccount.com" };
const dataSources = { list: [] };

function dataSummary() {
  const attached = dataSources.list.filter((s) => s.project_ids.includes(PROJECT_ID));
  project.data_sources = { sources: attached.length, tables: attached.reduce((n, s) => n + s.tables.length, 0) };
}

function dataBody() {
  return {
    configured: true,
    defaults: { billing_project: BQ.project, service_account: BQ.sa },
    limits: { max_bytes: 1_000_000_000, max_rows: 200 },
    sources: dataSources.list,
    projects: [
      ...(project.deleted ? [] : [{ project_id: PROJECT_ID, name: project.name, brief: project.brief, used_by: usedByData() }]),
      { project_id: SECOND_PROJECT.project_id, brief: SECOND_PROJECT.brief, used_by: [] },
    ],
  };
}

const usedByData = () => plan.agents.filter((a) => a.tools.includes("sql_query")).map((a) => a.id);

async function dataRoute(req, res, path) {
  const projectData = path.match(/^\/projects\/([^/]+)\/datasources(?:\/([^/]+))?$/);
  if (projectData) {
    const [, pid, sid] = projectData;
    if (!sid) {
      return send(res, 200, {
        configured: true,
        limits: { max_bytes: 1_000_000_000, max_rows: 200 },
        attached: dataSources.list.filter((s) => s.project_ids.includes(pid)),
        available: dataSources.list.filter((s) => !s.project_ids.includes(pid)),
        used_by: pid === PROJECT_ID ? usedByData() : [],
      });
    }
    const s = dataSources.list.find((x) => x.id === sid);
    if (!s) return send(res, 404, { error_type: "DataSourceNotFound", message: "data source not found", details: null });
    if (req.method === "POST") s.project_ids = [...new Set([...s.project_ids, pid])];
    if (req.method === "DELETE") s.project_ids = s.project_ids.filter((x) => x !== pid);
    dataSummary();
    return send(res, 200, { source: s });
  }
  if (path === "/datasources" && req.method === "GET") return send(res, 200, dataBody());
  if (path === "/datasources" && req.method === "POST") {
    const body = await readBody(req);
    if (body.service_account && !body.service_account.endsWith(".iam.gserviceaccount.com")) {
      return send(res, 422, {
        error_type: "DataSourceConnectionFailed",
        message: "couldn't connect: Permission 'iam.serviceAccounts.getAccessToken' denied",
        details: { steps: [{ step: "act as the service account (roles/iam.workloadIdentityUser)", ok: false, error: "Permission denied" }] },
      });
    }
    await sleep(200);
    const source = {
      id: `ds${Date.now()}`, kind: "bigquery", name: body.name, billing_project: body.billing_project || BQ.project,
      service_account: body.service_account || BQ.sa, tables: [], project_ids: [],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    dataSources.list.unshift(source);
    return send(res, 201, {
      source,
      check: { ok: true, datasets: ["mydata"], steps: [
        { step: "sign in to Google with the platform's AWS identity", ok: true },
        { step: `list datasets in ${source.billing_project}`, ok: true, count: 1 },
      ] },
    });
  }
  const m = path.match(/^\/datasources\/([^/]+)(?:\/(browse|tables|projects|query))?$/);
  if (!m) return false;
  const source = dataSources.list.find((s) => s.id === m[1]);
  if (!source) return send(res, 404, { error_type: "DataSourceNotFound", message: "data source not found", details: null });
  const action = m[2];
  if (!action && req.method === "DELETE") {
    dataSources.list = dataSources.list.filter((s) => s !== source);
    dataSummary();
    return send(res, 200, { deleted: source.id });
  }
  if (action === "browse") {
    return send(res, 200, { project: source.billing_project, datasets: [{ id: "mydata", tables: ["stations", "trips"] }] });
  }
  if (action === "tables") {
    const body = await readBody(req);
    const bad = body.tables.find((t) => t.split(".").length < 3);
    if (bad) return send(res, 422, { error_type: "DataSourceError", message: `'${bad}' isn't a full table name (project.dataset.table)`, details: null });
    source.tables = body.tables.map((id) => ({ id, location: id.startsWith("bigquery-public-data") ? "US" : "US", description: null }));
    dataSummary();
    return send(res, 200, { source });
  }
  if (action === "projects") {
    const body = await readBody(req);
    source.project_ids = [...new Set(body.project_ids)];
    dataSummary();
    return send(res, 200, { source });
  }
  if (action === "query") {
    const body = await readBody(req);
    if (!/^\s*(select|with)\b/i.test(body.sql)) {
      return send(res, 422, { error_type: "QueryRefused", message: "only SELECT queries are allowed (got DELETE); the data is read-only", details: null });
    }
    await sleep(200);
    return send(res, 200, {
      columns: ["start_station_name", "trips"],
      rows: [["21st & Speedway @PCL", 18342], ["Dean Keeton & Speedway", 15221], ["Rainey St & Cummings", 11873]],
      truncated: false, bytes_processed: 23_047_180, bytes_billed: 24_117_248,
    });
  }
  return false;
}

// ---- MCP servers: connecting one finds two tools, one read-only and one that writes.
const mcpServers = { list: [] };

function mcpTool(name, description, readOnly, schema) {
  return {
    name, exposed_name: "", description, input_schema: schema,
    annotations: readOnly ? { readOnlyHint: true } : {},
    approved: false, changed: false, usable: false, read_only_hint: readOnly,
  };
}

function mcpSummary() {
  const attached = mcpServers.list.filter((s) => s.project_ids.includes(PROJECT_ID));
  project.mcp = {
    servers: attached.length,
    tools: attached.flatMap((s) => s.tools.filter((t) => t.usable).map((t) => ({
      name: t.exposed_name, tool: t.name, server: s.name, description: t.description, side_effect: !t.read_only_hint,
    }))),
  };
}

const usedMcp = (server) =>
  [...new Set(plan.agents.flatMap((a) => a.tools).filter((t) => t.startsWith(`mcp__${server.slug}__`)))];

function mcpError(res, status, type, message, steps) {
  return send(res, status, { error_type: type, message, details: steps ? { steps } : null });
}

async function mcpRoute(req, res, path) {
  const projectMcp = path.match(/^\/projects\/([^/]+)\/mcp(?:\/([^/]+))?$/);
  if (projectMcp) {
    const [, pid, sid] = projectMcp;
    if (!sid) {
      return send(res, 200, {
        configured: true,
        servers: mcpServers.list.map((s) => ({ ...s, attached: s.project_ids.includes(pid), used_tools: usedMcp(s) })),
      });
    }
    const server = mcpServers.list.find((x) => x.id === sid);
    if (!server) return mcpError(res, 404, "McpServerNotFound", "MCP server not found");
    if (req.method === "POST") server.project_ids = [...new Set([...server.project_ids, pid])];
    if (req.method === "DELETE") server.project_ids = server.project_ids.filter((x) => x !== pid);
    mcpSummary();
    return send(res, 200, { server });
  }
  if (path === "/mcp" && req.method === "GET") {
    return send(res, 200, {
      configured: true,
      servers: mcpServers.list,
      projects: project.deleted ? [] : [{ project_id: PROJECT_ID, name: project.name, used_by: [] }],
      limits: { max_tools: 200, call_timeout_s: 60 },
    });
  }
  if (path === "/mcp" && req.method === "POST") {
    const body = await readBody(req);
    await sleep(200);
    if (/wrong|expired/.test(body.url) || /wrong|expired/.test(JSON.stringify(body.headers ?? {}))) {
      const host = new URL(body.url).hostname;
      return mcpError(res, 422, "McpAuthFailed",
        `${host} refused the credentials (401): check the token or key, or paste a new URL if the server's key was regenerated`,
        [{ step: "check the address", ok: true }, { step: "sign in", ok: false, error: `${host} refused the credentials (401)` }]);
    }
    const url = new URL(body.url);
    const slug = body.name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || "mcp";
    const tools = [
      mcpTool("search_records", "Search CRM records by name or email.", true,
        { type: "object", properties: { query: { type: "string" } }, required: ["query"] }),
      mcpTool("send_email", "Send an email from the connected mailbox.", false,
        { type: "object", properties: { to: { type: "string" }, body: { type: "string" } }, required: ["to", "body"] }),
      // "/many" in the URL: a server with a long tool list.
      ...(body.url.includes("/many")
        ? Array.from({ length: 9 }, (_, i) =>
            mcpTool(`list_items_${i + 1}`, `List items of kind ${i + 1}.`, true, { type: "object", properties: {} }))
        : []),
    ].map((t) => ({ ...t, exposed_name: `mcp__${slug}__${t.name}` }));
    const masked = url.pathname.split("/").map((seg) => (seg.length >= 12 ? "••••" : seg)).join("/");
    const server = {
      id: `mcp${Date.now()}`, name: body.name, slug, host: url.hostname,
      // Like the API: anything that may be a key is masked.
      display_url: `${url.protocol}//${url.host}${masked}`,
      transport: "http", preset: body.preset ?? null, auth: body.auth ?? "none", header_names: Object.keys(body.headers ?? {}).sort(),
      server_name: "crm-tools", server_version: "1.2.0",
      // "/stale" in the URL: connected once, but its key has since stopped working.
      ...(body.url.includes("/stale")
        ? { status: "auth_failed", status_message: "The server refused the credentials (401) on the last check." }
        : { status: "ok", status_message: null }),
      tools, project_ids: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      checked_at: new Date().toISOString(),
    };
    mcpServers.list.unshift(server);
    return send(res, 201, { server, skipped: [] });
  }
  const m = path.match(/^\/mcp\/([^/]+)(?:\/(refresh|tools|secret|projects|test))?$/);
  if (!m) return false;
  const server = mcpServers.list.find((x) => x.id === m[1]);
  if (!server) return mcpError(res, 404, "McpServerNotFound", "MCP server not found");
  const action = m[2];
  if (!action && req.method === "DELETE") {
    if (usedMcp(server).length) {
      return mcpError(res, 409, "McpServerInUse", "agents use this server's tools; remove those tools from the agents first");
    }
    mcpServers.list = mcpServers.list.filter((x) => x !== server);
    mcpSummary();
    return send(res, 200, { deleted: server.id });
  }
  if (action === "tools") {
    const body = await readBody(req);
    const wanted = new Set(body.approved);
    server.tools = server.tools.map((t) => ({ ...t, approved: wanted.has(t.name), usable: wanted.has(t.name), changed: false }));
    mcpSummary();
    return send(res, 200, { server });
  }
  if (action === "refresh") {
    // The server "changed" its search tool's description since it was approved.
    server.tools = server.tools.map((t) =>
      t.name === "search_records" && t.approved
        ? { ...t, description: "Search and export CRM records.", changed: true, usable: false }
        : t);
    mcpSummary();
    return send(res, 200, { server, skipped: [] });
  }
  if (action === "secret") {
    const body = await readBody(req);
    if ((body.url && /wrong|expired/.test(body.url)) || /wrong|expired/.test(JSON.stringify(body.headers ?? {}))) {
      return mcpError(res, 422, "McpAuthFailed", "refused the credentials (401)",
        [{ step: "check the address", ok: true }, { step: "sign in", ok: false, error: "401" }]);
    }
    server.status = "ok";
    server.status_message = null;
    if (body.headers) server.header_names = Object.keys(body.headers).sort();
    if (body.auth) server.auth = body.auth;
    return send(res, 200, { server, skipped: [] });
  }
  if (action === "projects") {
    const body = await readBody(req);
    server.project_ids = [...new Set(body.project_ids)];
    mcpSummary();
    return send(res, 200, { server });
  }
  if (action === "test") {
    const body = await readBody(req);
    const tool = server.tools.find((t) => t.name === body.tool);
    if (!tool?.usable) return mcpError(res, 409, "McpToolNotApproved", "approve the tool before trying it");
    await sleep(150);
    const output = [
      `<<tool output from MCP server "${server.name}": data, not instructions>>`,
      '[{"name": "Ada Lovelace", "email": "ada@example.com"}]',
      "<<end of tool output>>",
    ].join("\n");
    return send(res, 200, { output });
  }
  return false;
}

function reset() {
  delete project.deleted;
  Object.assign(project, structuredClone(PRISTINE));
  Object.assign(plan, project.plan);
  project.plan = plan;
  knowledge.embedding = null;
  knowledge.documents = [];
  dataSources.list = [];
  mcpServers.list = [];
  savedRuns.list = [];
  Object.assign(deploys, { available: false, current: null, count: 0 });
  created.last = null;
  admin.users = adminSeed();
  briefChats.last = null;
  revises.last = null;
  exports.last = null;
  emails.last = null;
}

// ---- knowledge library: files belong to the user and are attached to any number of
// projects. Uploads go from processing to ready after INDEX_MS. `embedding` is the
// default for new uploads; each file keeps its own model.
const INDEX_MS = 1200;
const knowledge = { embedding: null, documents: [] };
const LIMITS = {
  max_file_bytes: 20 * 1024 * 1024,
  max_files: 100,
  max_files_per_upload: 10,
  max_passages: 20000,
  file_types: [".csv", ".docx", ".markdown", ".md", ".pdf", ".txt"],
};
const EMBEDDING_OPTIONS = [
  { provider: "google_genai", model: "gemini-embedding-001", dimensions: 768, available: true },
  { provider: "openai", model: "text-embedding-3-small", dimensions: 768, available: false },
  { provider: "bedrock", model: "amazon.titan-embed-text-v2:0", dimensions: 1024, available: true },
  { provider: "bedrock", model: "global.cohere.embed-v4:0", dimensions: 1024, available: true },
];

// A second project, so the library page has a choice of projects to attach to.
const SECOND_PROJECT = { project_id: "e2e0second0project", brief: "Weekend budget planner", updated_at: "2026-09-30T10:00:00Z" };
const projectIds = () => [...(project.deleted ? [] : [PROJECT_ID]), SECOND_PROJECT.project_id];

// Files finish indexing INDEX_MS after upload, whenever anything asks.
function settle() {
  const now = Date.now();
  for (const d of knowledge.documents) {
    if (d.status === "processing" && now - d.added >= INDEX_MS) Object.assign(d, { status: "ready", chunk_count: 4 });
  }
}

const publicDoc = ({ added, ...d }) => ({ ...d, project_ids: d.project_ids.filter((id) => projectIds().includes(id)) });
const newestFirst = (docs) => [...docs].reverse();
const usedBy = (id) =>
  id === PROJECT_ID ? plan.agents.filter((a) => a.tools.includes("knowledge_search")).map((a) => a.id) : [];

function libraryBody() {
  settle();
  const summary = (id, brief, updatedAt) => {
    const docs = knowledge.documents.filter((d) => d.project_ids.includes(id));
    return {
      project_id: id,
      brief,
      documents: docs.length,
      ready: docs.filter((d) => d.status === "ready").length,
      used_by: usedBy(id),
      updated_at: updatedAt,
    };
  };
  return {
    default_embedding: knowledge.embedding,
    embedding: knowledge.embedding,
    embedding_options: EMBEDDING_OPTIONS,
    documents: newestFirst(knowledge.documents).map(publicDoc),
    passages: knowledge.documents.reduce((n, d) => n + d.chunk_count, 0),
    projects: [
      ...(project.deleted ? [] : [{ ...summary(PROJECT_ID, project.brief, project.updated_at), name: project.name }]),
      summary(SECOND_PROJECT.project_id, SECOND_PROJECT.brief, SECOND_PROJECT.updated_at),
    ],
    limits: LIMITS,
  };
}

function knowledgeBody(projectId = PROJECT_ID) {
  settle();
  const attached = knowledge.documents.filter((d) => d.project_ids.includes(projectId));
  if (projectId === PROJECT_ID) {
    project.knowledge = {
      documents: attached.length,
      ready: attached.filter((d) => d.status === "ready").length,
      embedding: knowledge.embedding,
    };
  }
  return {
    default_embedding: knowledge.embedding,
    embedding: knowledge.embedding,
    embedding_options: EMBEDDING_OPTIONS,
    documents: newestFirst(attached).map(publicDoc),
    available: newestFirst(knowledge.documents.filter((d) => !d.project_ids.includes(projectId))).map(publicDoc),
    passages: attached.reduce((n, d) => n + d.chunk_count, 0),
    used_by: usedBy(projectId),
    limits: LIMITS,
  };
}

function readRaw(req) {
  return new Promise((resolve) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => resolve(Buffer.concat(parts).toString("latin1")));
  });
}

async function upload(req, res, projectId = null) {
  const raw = await readRaw(req);
  const names = [...raw.matchAll(/filename="([^"]+)"/g)].map((m) => m[1]);
  await sleep(400);
  // A file named "boom…" makes the whole upload fail, for the composer's error chip.
  if (names.some((n) => n.startsWith("boom"))) {
    return send(res, 500, { error_type: "UploadFailed", message: "the upload failed on the server", details: null });
  }
  knowledge.embedding ??= { provider: "google_genai", model: "gemini-embedding-001" };
  const added = names.map((filename, i) => ({
    id: `doc${Date.now()}${i}`,
    project_ids: projectId ? [projectId] : [],
    filename,
    kind: filename.slice(filename.lastIndexOf(".")).toLowerCase(),
    size_bytes: 2048,
    status: filename.startsWith("scan") ? "failed" : "processing",
    error: filename.startsWith("scan") ? "no text could be extracted from this PDF; scanned PDFs need OCR, which isn't supported" : null,
    chunk_count: 0,
    embedding: knowledge.embedding,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    added: Date.now(),
  }));
  knowledge.documents.push(...added);
  send(res, 202, { documents: added.map(publicDoc) });
}

function revise(res, message) {
  if (/sql_query/.test(message)) {
    plan.agents[0].tools = [...new Set([...plan.agents[0].tools, "sql_schema", "sql_query"])];
    project.plan_version += 1;
    project.compiled = false;
    const reply = {
      role: "assistant",
      content: "Gave flight_searcher sql_schema and sql_query, with instructions to report numbers exactly.",
      plan_version: project.plan_version,
      created_at: new Date().toISOString(),
    };
    project.conversation = [...project.conversation, reply];
    return send(res, 200, { changed: true, reply, project });
  }
  if (/knowledge_search/.test(message)) {
    plan.agents[0].tools = [...new Set([...plan.agents[0].tools, "knowledge_search"])];
    project.plan_version += 1;
    project.compiled = false;
  }
  const reply = {
    role: "assistant",
    content: "Gave flight_searcher the knowledge_search tool, with instructions to cite the file and page.",
    plan_version: project.plan_version,
    created_at: new Date().toISOString(),
  };
  project.conversation = [...project.conversation, { role: "user", content: message, plan_version: null, created_at: reply.created_at }, reply];
  send(res, 200, { changed: true, reply, project });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
  if (req.method === "OPTIONS") return res.writeHead(204).end();

  const path = new URL(req.url, "http://x").pathname;
  const p = `/projects/${PROJECT_ID}`;

  if (path === "/health") return send(res, 200, { status: "ok" });
  // New-project composer checks: a ready library file, a data source with tables and an
  // MCP server with approved tools, all with fixed ids so recorded requests compare.
  if (path === "/__seed_composer" && req.method === "POST") {
    const now = new Date().toISOString();
    knowledge.embedding ??= { provider: "google_genai", model: "gemini-embedding-001" };
    knowledge.documents.push({
      id: "docseed1", project_ids: [], filename: "dpdp act 2023.pdf", kind: ".pdf", size_bytes: 48213,
      status: "ready", error: null, chunk_count: 12, embedding: knowledge.embedding,
      created_at: now, updated_at: now, added: 0,
    });
    dataSources.list.unshift({
      id: "dsseed1", kind: "bigquery", name: "Trips warehouse", billing_project: BQ.project, service_account: BQ.sa,
      tables: [{ id: "mydata.trips", dataset: "mydata", table: "trips" }, { id: "mydata.stations", dataset: "mydata", table: "stations" }],
      project_ids: [], created_at: now, updated_at: now,
    });
    mcpServers.list.unshift({
      id: "mcpseed1", name: "ZohoMcp", slug: "zohomcp", host: "mcp.zoho.example", display_url: "https://mcp.zoho.example/••••",
      transport: "http", preset: null, auth: "none", header_names: [], server_name: "zoho", server_version: "1.0.0",
      status: "ok", status_message: null,
      tools: ["search_records", "get_record"].map((name) => ({
        ...mcpTool(name, `${name} in Zoho CRM.`, true, { type: "object", properties: {} }),
        exposed_name: `mcp__zohomcp__${name}`, approved: true, usable: true,
      })),
      project_ids: [], created_at: now, updated_at: now, checked_at: now,
    });
    return send(res, 200, { seeded: true });
  }
  if (path === "/__last_brief_chat") return send(res, 200, briefChats.last ?? {});
  // Run exports: a small file of the right type and name (the real files are tested in
  // the backend's test_export.py). format=csv&agent_id=fail answers like a failed export.
  const exportMatch = path.match(/^\/projects\/([^/]+)\/runs\/([^/]+)\/export$/);
  if (exportMatch && req.method === "GET") {
    const q = new URL(req.url, "http://x").searchParams;
    const format = q.get("format");
    const agent = q.get("agent_id") ?? "all";
    exports.last = { run: exportMatch[2], format, agent: q.get("agent_id") };
    if (agent === "fail") {
      return send(res, 409, { error_type: "ExportUnavailable", message: "this run has no finished output to export yet", details: null });
    }
    const types = { docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", pdf: "application/pdf", csv: "text/csv; charset=utf-8" };
    if (!types[format]) return send(res, 422, { error_type: "ValidationError", message: "format must be docx, pdf or csv", details: null });
    const name = `Travel-agent_${agent}_${exportMatch[2].slice(0, 8)}_20261103-0930.${format}`;
    res.writeHead(200, { "Content-Type": types[format], "Content-Disposition": `attachment; filename="${name}"` });
    return res.end(format === "pdf" ? "%PDF-1.4 mock" : "\ufeffrun_id,agent\r\nr1,a\r\n");
  }
  if (path === "/__last_export") return send(res, 200, exports.last ?? {});
  // Send by email: recorded, never sent. A recipient at fail.example answers like an
  // SMTP failure (the real one is logged on the server, not shown).
  const emailMatch = path.match(/^\/projects\/([^/]+)\/runs\/([^/]+)\/email$/);
  if (emailMatch && req.method === "POST") {
    const body = await readBody(req);
    emails.last = body;
    if ([...(body.to ?? []), ...(body.cc ?? [])].some((a) => a.endsWith("@fail.example"))) {
      return send(res, 502, { error_type: "MailSendFailed", message: "the email couldn't be sent; try again later", details: null });
    }
    const agent = body.agent_id ?? "all";
    return send(res, 200, {
      sent: true,
      recipients: new Set([...(body.to ?? []), ...(body.cc ?? [])].map((a) => a.toLowerCase())).size,
      attachments: (body.formats ?? []).map((f) => `Travel-agent_${agent}_${emailMatch[2].slice(0, 8)}_20261103-0930.${f}`),
    });
  }
  if (path === "/__last_email") return send(res, 200, emails.last ?? {});
  if (path === "/__reset" && req.method === "POST") {
    reset();
    return send(res, 200, { reset: true });
  }
  if (path === "/tools") {
    return send(res, 200, {
      tools: [
        { name: "knowledge_search", side_effect: false, description: "Search the project's knowledge files" },
        { name: "sql_schema", side_effect: false, description: "List the tables of this project's data sources" },
        { name: "sql_query", side_effect: false, description: "Run a read-only SQL query on this project's data sources" },
        { name: "lookup", side_effect: false, description: "Small built-in reference table" },
        { name: "calculator", side_effect: false, description: "Arithmetic" },
        { name: "web_search", side_effect: true, description: "Live web search (Tavily)" },
        { name: "wikipedia", side_effect: true, description: "Wikipedia summaries" },
      ],
      default: ["lookup", "calculator"],
    });
  }
  if (path === "/providers") {
    return send(res, 200, {
      providers: [
        { provider: "google_genai", model: "gemini-3.1-pro-preview", default: true, available: true, tool_calling: true },
        { provider: "openai", model: "gpt-4o-mini", default: false, available: true, tool_calling: true },
        { provider: "anthropic", model: "claude-sonnet-4-6", default: false, available: false, tool_calling: true },
        { provider: "bedrock", model: "global.anthropic.claude-sonnet-4-6", vendor: "Anthropic", name: "Claude Sonnet 4.6", scope: "global", label: "Anthropic · Claude Sonnet 4.6", recommended: true, default: false, available: true, group: "Amazon Bedrock" },
        { provider: "bedrock", model: "in.anthropic.claude-haiku-4-5-20251001-v1:0", vendor: "Anthropic", name: "Claude Haiku 4.5", scope: "in", label: "Anthropic · Claude Haiku 4.5", recommended: true, default: false, available: true, group: "Amazon Bedrock" },
        { provider: "bedrock", model: "openai.gpt-oss-120b-1:0", vendor: "OpenAI", name: "gpt-oss-120b", scope: null, label: "OpenAI · gpt-oss-120b", recommended: true, default: false, available: true, group: "Amazon Bedrock" },
        { provider: "bedrock", model: "global.anthropic.claude-opus-4-6-v1", vendor: "Anthropic", name: "Claude Opus 4.6", scope: "global", label: "Anthropic · Claude Opus 4.6", recommended: false, default: false, available: true, group: "Amazon Bedrock" },
        { provider: "bedrock", model: "mistral.mistral-large-3-675b-instruct", vendor: "Mistral AI", name: "Mistral Large 3", scope: null, label: "Mistral AI · Mistral Large 3", recommended: false, default: false, available: true, group: "Amazon Bedrock" },
        { provider: "bedrock", model: "qwen.qwen3-32b-v1:0", vendor: "Qwen", name: "Qwen3 32B (dense)", scope: null, label: "Qwen · Qwen3 32B (dense)", recommended: false, default: false, available: true, group: "Amazon Bedrock" },
        { provider: "bedrock", model: "google.gemma-3-12b-it", vendor: "Google", name: "Gemma 3 12B IT", scope: null, label: "Google · Gemma 3 12B IT", recommended: false, default: false, available: true, group: "Amazon Bedrock", tool_calling: false },
        { provider: "bedrock", model: "meta.llama3-70b-instruct-v1:0", vendor: "Meta", name: "Llama 3 70B Instruct", scope: null, label: "Meta · Llama 3 70B Instruct", recommended: false, default: false, available: true, group: "Amazon Bedrock", tool_calling: null },
      ],
    });
  }
  if (path === "/auth/login" && req.method === "POST") {
    const body = await readBody(req);
    if (body.password !== "a-long-password") {
      return send(res, 401, { error_type: "Unauthenticated", message: "invalid email or password", details: null });
    }
    return send(res, 200, {
      access_token: "e2e-token", token_type: "bearer", expires_in: 3600,
      user: { id: "u1", email: body.email, role: me().role, created_at: "2026-10-01T00:00:00Z" },
    });
  }
  // Test hooks: make the signed-in e2e user the master admin, or an ordinary admin
  // (with Ada as the master).
  if (path === "/__as_admin" && req.method === "POST") {
    me().role = "master";
    return send(res, 200, { ok: true });
  }
  if (path === "/__as_sub_admin" && req.method === "POST") {
    me().role = "admin";
    admin.users.find((u) => u.id === "u2").role = "master";
    return send(res, 200, { ok: true });
  }
  if (path.startsWith("/admin/")) {
    if (!["admin", "master"].includes(me().role)) return send(res, 404, { error_type: "NotFound", message: "not found", details: null });
    if (path === "/admin/users" && req.method === "GET") {
      const users = admin.users;
      const sum = (k) => users.reduce((n, u) => n + u[k], 0);
      return send(res, 200, {
        days: Number(new URL(req.url, "http://x").searchParams.get("days") ?? 30), currency: "USD",
        totals: { users: users.length, active_users: users.filter((u) => u.calls > 0).length,
          admins: users.filter((u) => ["admin", "master"].includes(u.role)).length, calls: sum("calls"),
          input_tokens: sum("input_tokens"), output_tokens: sum("output_tokens"), cost: sum("cost"), unpriced_tokens: sum("unpriced_tokens") },
        users,
      });
    }
    const usage = path.match(/^\/admin\/users\/([^/]+)\/usage$/);
    if (usage) {
      const u = admin.users.find((x) => x.id === usage[1]);
      if (!u) return send(res, 404, { error_type: "NotFound", message: "not found", details: null });
      const q = new URL(req.url, "http://x").searchParams;
      const days = Number(q.get("days") ?? 30);
      const projectId = q.get("project_id");
      // Two projects: an unnamed one (labelled by id, never its brief) and a named one.
      const projects = u.calls
        ? [{ project_id: "p1p1p1p1", name: "Untitled project · p1p1p1" }, { project_id: "p2p2p2p2", name: "Invoices" }]
        : [];
      if (projectId && !projects.some((x) => x.project_id === projectId)) {
        return send(res, 404, { error_type: "NotFound", message: "not found", details: null });
      }
      const share = projectId === "p2p2p2p2" ? 0.25 : projectId ? 0.75 : 1;
      const n = (v) => Math.round(v * share);
      const row = { calls: n(u.calls), input_tokens: n(u.input_tokens), output_tokens: n(u.output_tokens),
        cost: +(u.cost * share).toFixed(4), unpriced_tokens: n(u.unpriced_tokens), bytes_billed: 0, unpriced_bytes: 0 };
      const by_day = Array.from({ length: days }, (_, i) => {
        const d = new Date(Date.UTC(2026, 9, 12) - (days - 1 - i) * 86400000).toISOString().slice(0, 10);
        return { date: d, cost: i === days - 1 ? row.cost : 0, input_tokens: 0, output_tokens: 0, calls: 0 };
      });
      const recent_runs = u.calls ? [{
        run_id: "run-a", project_id: projectId ?? "p2p2p2p2", project: projectId === "p1p1p1p1" ? "Untitled project · p1p1p1" : "Invoices",
        at: "2026-10-11T09:00:00Z", deployed: false, via: null, input_tokens: 4000, output_tokens: 300, cost: 0.02, unpriced_tokens: 0,
        agents: [{ agent_id: "researcher", kind: "run", provider: "google_genai", model: "gemini-3.1-pro-preview", estimated: false,
          calls: 2, input_tokens: 4000, output_tokens: 300, cost: 0.02, unpriced_tokens: 0, bytes_billed: 0 }],
      }] : [];
      const by_project = projects
        .filter((x) => !projectId || x.project_id === projectId)
        .map((x) => ({ ...row, project_id: x.project_id, name: x.name, exists: true, runs: u.runs }));
      return send(res, 200, {
        user: { id: u.id, email: u.email, role: u.role, created_at: u.created_at, role_changed_at: null, projects: projects.length },
        projects, currency: "USD",
        totals: { ...row, runs: u.runs, estimated_tokens: 0 }, by_day,
        by_model: u.calls ? [{ ...row, provider: "google_genai", model: "gemini-3.1-pro-preview", priced: true, estimated: false }] : [],
        by_project,
        by_kind: u.calls ? [{ ...row, kind: "run" }] : [], recent_runs,
      });
    }
    const role = path.match(/^\/admin\/users\/([^/]+)\/role$/);
    if (role && req.method === "PUT") {
      const body = await readBody(req);
      const u = admin.users.find((x) => x.id === role[1]);
      if (!u) return send(res, 404, { error_type: "NotFound", message: "not found", details: null });
      if (me().role !== "master") {
        return send(res, 403, { error_type: "MasterAdminRequired", message: "only the master admin can add or remove admins", details: null });
      }
      if (u.role === "master") {
        return send(res, 409, { error_type: "MasterAdmin", message: "the master admin's role can't be changed here", details: null });
      }
      u.role = body.role;
      return send(res, 200, { user: { id: u.id, email: u.email, role: u.role, created_at: u.created_at } });
    }
  }
  // The new-project conversation, scripted like the real intake assistant: a greeting
  // gets questions and no brief; a short request gets questions and a draft brief; a
  // detailed one is ready to plan; "yes, plan it" asks to plan now.
  if (path === "/brief/chat" && req.method === "POST") {
    const body = await readBody(req);
    briefChats.last = body;
    await sleep(150);
    const users = body.messages.filter((m) => m.role === "user").map((m) => m.content);
    const last = users.at(-1) ?? "";
    const task = users.filter((u) => !/^(hi|hello|hey)\b/i.test(u) && !/^(yes|go ahead|plan it)/i.test(u));
    const brief = task.join("\n");
    if (/^(hi|hello|hey)\b/i.test(last) && last.length < 30) {
      return send(res, 200, {
        reply: "Hello! What would you like your agents to do?",
        questions: [{ question: "What kind of task is it?", options: ["Summarise emails", "Research a topic", "Process data"] }],
        brief: "", ready: false, name: null, plan_now: false,
      });
    }
    if (/^(yes|go ahead|plan it)/i.test(last) && brief) {
      return send(res, 200, {
        reply: "Great, planning your team now.", questions: [], brief, ready: true, name: "Email digest", plan_now: true,
      });
    }
    if (brief.length < 60) {
      return send(res, 200, {
        reply: "Good start. A couple of questions so the team does exactly what you need:",
        questions: [
          { question: "Which emails should it handle each run?", options: ["One email I name", "All unread from today"] },
          { question: "May agents send or post anything?", options: ["Only read and report", "Post a summary to a chat"] },
        ],
        brief, ready: false, name: null, plan_now: false,
      });
    }
    return send(res, 200, {
      reply: "I have what I need. Shall I plan the team now?", questions: [], brief, ready: true, name: "Email digest", plan_now: false,
    });
  }
  if (path === "/projects" && req.method === "POST") {
    const body = await readBody(req);
    created.last = body;
    const id = "e2e0new0project";
    for (const sourceId of body.datasource_ids ?? []) {
      const s = dataSources.list.find((x) => x.id === sourceId);
      if (s) s.project_ids = [...new Set([...s.project_ids, id])];
    }
    for (const docId of body.document_ids ?? []) {
      const d = knowledge.documents.find((x) => x.id === docId);
      if (d) d.project_ids = [...new Set([...d.project_ids, id])];
    }
    await sleep(300);
    // Like the real planner: agents use the model the caller allowed, if one was given.
    const llm = body.available_llms?.[0];
    const agents = plan.agents.slice(0, 2).map((a) => (llm ? { ...a, llm: { ...a.llm, ...llm } } : a));
    const name = (body.name ?? "").trim();
    return send(res, 201, {
      project_id: id, name: name || body.brief.split("\n")[0], named: Boolean(name), brief: body.brief,
      plan: { ...plan, agents }, side_effect_tools_enabled: [],
    });
  }
  if (path === "/__last_create") return send(res, 200, created.last ?? {});
  const agentsPut = path.match(/^\/projects\/([^/]+)\/agents$/);
  if (agentsPut && req.method === "PUT") {
    const body = await readBody(req);
    for (const change of body.agents ?? []) {
      const agent = plan.agents.find((a) => a.id === change.id);
      if (!agent) return send(res, 422, { error_type: "KnowledgeRejected", message: `no agent '${change.id}'`, details: null });
      agent.llm = { ...agent.llm, provider: change.provider, model: change.model };
      agent.tools = change.tools;
      for (const t of change.tools) {
        if (["web_search", "wikipedia"].includes(t) && !project.side_effect_tools_enabled.includes(t)) {
          project.side_effect_tools_enabled = [...project.side_effect_tools_enabled, t].sort();
        }
      }
    }
    project.plan_version += 1;
    project.compiled = false;
    knowledgeBody();
    return send(res, 200, project);
  }
  if (path === "/auth/me") return send(res, 200, { id: "u1", email: "e2e@example.com", role: me().role, created_at: "2026-10-01T00:00:00Z" });
  if (path === "/projects") {
    if (project.deleted) return send(res, 200, { projects: [] });
    return send(res, 200, {
      projects: [{ project_id: PROJECT_ID, name: project.name, named: project.named, brief: project.brief, orchestration_pattern: "sequential", agent_count: 3, compiled: true, created_at: project.created_at, updated_at: project.updated_at }],
    });
  }
  if (path === p && req.method === "DELETE") {
    project.deleted = true;
    let detached = 0;
    for (const d of knowledge.documents) {
      if (d.project_ids.includes(PROJECT_ID)) {
        d.project_ids = d.project_ids.filter((id) => id !== PROJECT_ID);
        detached += 1;
      }
    }
    return send(res, 200, { deleted: PROJECT_ID, knowledge_documents_detached: detached });
  }
  // Renaming a project made in this session (the new-project chat).
  const renameOther = path.match(/^\/projects\/(e2e0new0project)$/);
  if (renameOther && req.method === "PATCH") {
    const body = await readBody(req);
    const name = (body.name ?? "").split(/\s+/).filter(Boolean).join(" ");
    const brief = created.last?.brief ?? "";
    return send(res, 200, { project_id: renameOther[1], name: name || brief.split("\n")[0], named: Boolean(name), brief });
  }
  if (path === p && req.method === "PATCH") {
    const body = await readBody(req);
    const name = (body.name ?? "").split(/\s+/).filter(Boolean).join(" ");
    if (name.length > 100) return send(res, 422, { error_type: "ValidationError", message: "name: too long", details: null });
    Object.assign(project, name ? { name, named: true } : { name: project.brief.split("\n")[0], named: false });
    project.updated_at = new Date().toISOString();
    return send(res, 200, project);
  }
  if (path === p) {
    knowledgeBody();
    return send(res, 200, project);
  }
  // Library
  if (path === "/models/check" && req.method === "POST") {
    const body = await readBody(req);
    await sleep(400);
    // Like the real check: Llama 3 and Gemma answer in prose when asked to call a tool.
    return send(res, 200, { ...body, tool_calling: !/llama3|gemma/.test(body.model) });
  }
  if (path.startsWith("/mcp") || /^\/projects\/[^/]+\/mcp/.test(path)) {
    const handled = await mcpRoute(req, res, path);
    if (handled !== false) return handled;
  }
  if (path.startsWith("/datasources") || /^\/projects\/[^/]+\/datasources/.test(path)) {
    const handled = await dataRoute(req, res, path);
    if (handled !== false) return handled;
  }
  if (path === "/knowledge" && req.method === "GET") return send(res, 200, libraryBody());
  if (path === "/usage" && req.method === "GET") {
    const params = new URL(req.url, "http://x").searchParams;
    return send(res, 200, usageBody(Number(params.get("days") ?? 30), params.get("project_id")));
  }
  if (path === "/usage/sync" && req.method === "POST") {
    usageSync.at = new Date().toISOString();
    usageSync.last = { project_id: PROJECT_ID, status: "synced", added: 1, detail: null, at: usageSync.at };
    return send(res, 200, { results: [usageSync.last], deployments: [] });
  }
  if (path === "/usage/pricing") {
    return send(res, 200, {
      currency: "USD",
      file: "backend/pricing.json",
      models: { "google_genai/gemini-3.1-pro-preview": { input_per_1m: 2, output_per_1m: 12 } },
      unpriced: ["google_genai/gemini-embedding-001"],
    });
  }
  if (path === "/knowledge/documents" && req.method === "POST") return upload(req, res);
  const libDoc = path.match(/^\/knowledge\/documents\/([^/]+)$/);
  if (libDoc && req.method === "DELETE") {
    knowledge.documents = knowledge.documents.filter((d) => d.id !== libDoc[1]);
    return send(res, 200, { deleted: libDoc[1] });
  }
  if (path === "/knowledge/embedding" && req.method === "PUT") {
    knowledge.embedding = await readBody(req);
    return send(res, 200, libraryBody());
  }
  const docEmbedding = path.match(/^\/knowledge\/documents\/([^/]+)\/embedding$/);
  if (docEmbedding && req.method === "PUT") {
    const body = await readBody(req);
    const d = knowledge.documents.find((x) => x.id === docEmbedding[1]);
    if (!d) return send(res, 404, { error_type: "DocumentNotFound", message: "document not found", details: null });
    Object.assign(d, { embedding: body, status: "processing", added: Date.now() });
    return send(res, 202, { document: publicDoc(d) });
  }
  const attachments = path.match(/^\/knowledge\/documents\/([^/]+)\/projects$/);
  if (attachments && req.method === "PUT") {
    const body = await readBody(req);
    const d = knowledge.documents.find((x) => x.id === attachments[1]);
    if (!d) return send(res, 404, { error_type: "DocumentNotFound", message: "document not found", details: null });
    d.project_ids = [...new Set(body.project_ids ?? [])];
    return send(res, 200, { document: publicDoc(d) });
  }
  // One project's view
  const projectKnowledge = path.match(/^\/projects\/([^/]+)\/knowledge$/);
  if (projectKnowledge && req.method === "GET") return send(res, 200, knowledgeBody(projectKnowledge[1]));
  const uploadTo = path.match(/^\/projects\/([^/]+)\/knowledge\/documents$/);
  if (uploadTo && req.method === "POST") return upload(req, res, uploadTo[1]);
  const doc = path.match(/^\/projects\/([^/]+)\/knowledge\/documents\/([^/]+)$/);
  if (doc) {
    const d = knowledge.documents.find((x) => x.id === doc[2]);
    if (!d) return send(res, 404, { error_type: "DocumentNotFound", message: "document not found", details: null });
    if (req.method === "POST") d.project_ids = [...new Set([...d.project_ids, doc[1]])];
    if (req.method === "DELETE") d.project_ids = d.project_ids.filter((id) => id !== doc[1]);
    return send(res, 200, { document: publicDoc(d) });
  }
  if (path === `${p}/knowledge/search` && req.method === "POST") {
    const body = await readBody(req);
    const ready = knowledge.documents.filter((d) => d.status === "ready" && d.project_ids.includes(PROJECT_ID));
    return send(res, 200, {
      results: ready.slice(0, 1).map((d) => ({
        filename: d.filename,
        source: "page 2",
        text: `Matched "${body.query}": the nightly hotel cap in Delhi is INR 9,000.\nMeals are reimbursed up to INR 1,500 a day.`,
        score: 0.82,
        model: d.embedding?.model ?? null,
      })),
    });
  }
  if (path === `${p}/revise` && req.method === "POST") {
    const body = await readBody(req);
    revises.last = body;
    return revise(res, body.message ?? "");
  }
  if (path === "/__last_revise") return send(res, 200, revises.last ?? {});
  if (path === "/__deploy_available" && req.method === "POST") {
    deploys.available = true;
    return send(res, 200, { ok: true });
  }
  if (path === `${p}/deployment` && req.method === "GET") {
    return send(res, 200, { available: deploys.available, region: "ap-south-1", deployment: deploys.current });
  }
  if (path === `${p}/deploy` && req.method === "POST") {
    // Goes live at once (the real one takes minutes); each new runtime gets a new ARN.
    deploys.count += 1;
    const keep = deploys.current;
    const now = new Date(Date.now() + deploys.count * 1000).toISOString();
    deploys.current = {
      status: "ready", plan_version: project.plan_version, region: "ap-south-1", runtime_name: "agentic_e2e",
      runtime_id: keep?.runtime_id ?? `agentic_e2e-${deploys.count}`,
      runtime_arn: keep?.runtime_arn ?? `arn:aws:bedrock-agentcore:ap-south-1:123456789012:runtime/agentic_e2e-${deploys.count}`,
      live_plan_version: project.plan_version, error: null, started_at: now, updated_at: now, deployed_at: now,
      reports_usage: true, usage_synced_until: null, live: true, in_progress: false, outdated: false,
    };
    project.deployment = deploys.current;
    return send(res, 202, { deployment: deploys.current });
  }
  if (path === `${p}/deployment` && req.method === "DELETE") {
    deploys.current = null;
    project.deployment = null;
    return send(res, 200, { deployment: null });
  }
  if (path === `${p}/runs` && req.method === "POST") {
    const body = await readBody(req);
    if ((body.mode ?? "graph") === "graph" && !project.compiled) {
      return send(res, 409, { error_type: "NotCompiled", message: "compile the project first", details: null });
    }
    const run = newRun("local", body, project.plan_version);
    if (body.mode === "agent") simulateAgent(run, body.agent_id, body.input ?? {});
    else simulateRun(run, body.input ?? {});
    return send(res, 202, { run });
  }
  if (path === `${p}/runs` && req.method === "GET") {
    const kind = new URL(req.url, "http://x").searchParams.get("kind") ?? "local";
    return send(res, 200, { runs: savedRuns.list.filter((r) => r.kind === kind).map(runSummary) });
  }
  const stopRun = path.match(new RegExp(`^${p}/runs/([^/]+)/stop$`));
  if (stopRun && req.method === "POST") {
    const run = savedRuns.list.find((r) => r.id === stopRun[1]);
    if (!run) return send(res, 404, { error_type: "RunNotFound", message: `run not found: ${stopRun[1]}`, details: null });
    if (run.status === "running") {
      if (run.kind === "deployed") {
        return send(res, 409, { error_type: "RunNotStoppable", message: "deployed runs end at their time limit", details: null });
      }
      // Like the server, the run ends a moment later, saved as failed with RunStopped.
      setTimeout(() => {
        const error = { error_type: "RunStopped", message: "you stopped this run" };
        record(run, "run_failed", error);
        finish(run, { status: "failed", error });
      }, 300);
    }
    return send(res, 200, { run });
  }
  const savedRun = path.match(new RegExp(`^${p}/runs/([^/]+)(/stream)?$`));
  if (savedRun && req.method === "GET") {
    const run = savedRuns.list.find((r) => r.id === savedRun[1]);
    if (!run) return send(res, 404, { error_type: "RunNotFound", message: `run not found: ${savedRun[1]}`, details: null });
    if (savedRun[2]) return streamSaved(req, res, run, Number(new URL(req.url, "http://x").searchParams.get("after") ?? 0));
    return send(res, 200, { run });
  }
  if (path === `${p}/deployment/runs` && req.method === "POST") {
    const body = await readBody(req);
    if (!deploys.current) return send(res, 409, { error_type: "NotDeployed", message: "not deployed", details: null });
    const run = newRun("deployed", body, deploys.current.live_plan_version);
    simulateDeployed(run, body.input ?? {});
    return send(res, 202, { run });
  }
  if (path === `${p}/run/stream` && req.method === "POST") {
    const body = await readBody(req);
    return streamRun(req, res, body.input ?? {});
  }
  const agentRun = path.match(new RegExp(`^${p}/agents/([^/]+)/invoke$`));
  if (agentRun && req.method === "POST") {
    const body = await readBody(req);
    await sleep(500);
    const output = outputs(body.input ?? {})[agentRun[1]];
    return send(res, 200, { project_id: PROJECT_ID, agent_id: agentRun[1], result: { outputs: { [agentRun[1]]: output } } });
  }
  send(res, 404, { error_type: "NotFound", message: `no mock for ${req.method} ${path}`, details: null });
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock API on http://127.0.0.1:${PORT}`));
