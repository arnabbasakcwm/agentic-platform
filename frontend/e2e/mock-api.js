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
  plan,
  plan_version: 2,
  compiled: true,
  side_effect_tools_enabled: ["web_search"],
  conversation: [],
  deployment: null,
  knowledge: { documents: 0, ready: 0, embedding: null },
  created_at: "2026-10-01T06:00:00Z",
  updated_at: "2026-10-01T06:09:54Z",
};

function trip(input) {
  const from = input.origin ?? "your origin";
  const to = input.destination ?? "your destination";
  return { from, to, month: input.month ?? "your dates" };
}

function outputs(input) {
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
    },
    by_day: byDay,
    by_model: [
      { provider: "google_genai", model: "gemini-3.1-pro-preview", priced: true, estimated: false, calls: sum("calls") - 2, input_tokens: sum("input_tokens") - 14, output_tokens: sum("output_tokens"), cost: totalCost, unpriced_tokens: 0 },
      { provider: "google_genai", model: "gemini-embedding-001", priced: false, estimated: true, calls: 2, input_tokens: 14, output_tokens: 0, cost: 0, unpriced_tokens: 14 },
    ],
    by_project: projectId ? projects.filter((x) => x.project_id === projectId) : projects,
    by_kind: [
      { kind: "run", calls: sum("calls") - 6, input_tokens: sum("input_tokens") - 9000, output_tokens: sum("output_tokens") - 2000, cost: Number((totalCost - 0.05).toFixed(4)), unpriced_tokens: 0 },
      { kind: "planner", calls: 2, input_tokens: 6000, output_tokens: 1500, cost: 0.03, unpriced_tokens: 0 },
      { kind: "assistant", calls: 2, input_tokens: 3000, output_tokens: 500, cost: 0.02, unpriced_tokens: 0 },
      { kind: "embedding_query", calls: 2, input_tokens: 14, output_tokens: 0, cost: 0, unpriced_tokens: 14 },
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

// Deploys: off ("AWS not set up") unless a test turns them on with POST /__deploy_available.
const deploys = { available: false, current: null, count: 0 };

// The deployed-usage sync: "Sync now" moves the cursor and records the result.
const usageSync = { at: null, last: null };

// The knowledge spec changes the project (uploads, a revision); it resets it afterwards
// so the other specs see the original.
const PRISTINE = structuredClone(project);

function reset() {
  delete project.deleted;
  Object.assign(project, structuredClone(PRISTINE));
  Object.assign(plan, project.plan);
  project.plan = plan;
  knowledge.embedding = null;
  knowledge.documents = [];
  Object.assign(deploys, { available: false, current: null, count: 0 });
  created.last = null;
}

// ---- knowledge library: files belong to the user and are attached to any number of
// projects. Uploads go from processing to ready after INDEX_MS.
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
  { provider: "google_genai", model: "gemini-embedding-001", available: true },
  { provider: "openai", model: "text-embedding-3-small", available: false },
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
    embedding: knowledge.embedding,
    embedding_options: EMBEDDING_OPTIONS,
    documents: newestFirst(knowledge.documents).map(publicDoc),
    passages: knowledge.documents.reduce((n, d) => n + d.chunk_count, 0),
    projects: [
      ...(project.deleted ? [] : [summary(PROJECT_ID, project.brief, project.updated_at)]),
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
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    added: Date.now(),
  }));
  knowledge.documents.push(...added);
  send(res, 202, { documents: added.map(publicDoc) });
}

function revise(res, message) {
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
  if (req.method === "OPTIONS") return res.writeHead(204).end();

  const path = new URL(req.url, "http://x").pathname;
  const p = `/projects/${PROJECT_ID}`;

  if (path === "/health") return send(res, 200, { status: "ok" });
  if (path === "/__reset" && req.method === "POST") {
    reset();
    return send(res, 200, { reset: true });
  }
  if (path === "/tools") {
    return send(res, 200, {
      tools: [
        { name: "knowledge_search", side_effect: false, description: "Search the project's knowledge files" },
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
        { provider: "google_genai", model: "gemini-3.1-pro-preview", default: true, available: true },
        { provider: "openai", model: "gpt-4o-mini", default: false, available: true },
        { provider: "anthropic", model: "claude-sonnet-4-6", default: false, available: false },
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
      user: { id: "u1", email: body.email, created_at: "2026-10-01T00:00:00Z" },
    });
  }
  if (path === "/projects" && req.method === "POST") {
    const body = await readBody(req);
    created.last = body;
    const id = "e2e0new0project";
    for (const docId of body.document_ids ?? []) {
      const d = knowledge.documents.find((x) => x.id === docId);
      if (d) d.project_ids = [...new Set([...d.project_ids, id])];
    }
    await sleep(300);
    return send(res, 201, { project_id: id, plan: { ...plan, agents: plan.agents.slice(0, 2) }, side_effect_tools_enabled: [] });
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
  if (path === "/auth/me") return send(res, 200, { id: "u1", email: "e2e@example.com", created_at: "2026-10-01T00:00:00Z" });
  if (path === "/projects") {
    if (project.deleted) return send(res, 200, { projects: [] });
    return send(res, 200, {
      projects: [{ project_id: PROJECT_ID, brief: project.brief, orchestration_pattern: "sequential", agent_count: 3, compiled: true, created_at: project.created_at, updated_at: project.updated_at }],
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
  if (path === p) {
    knowledgeBody();
    return send(res, 200, project);
  }
  // Library
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
      })),
    });
  }
  if (path === `${p}/revise` && req.method === "POST") {
    const body = await readBody(req);
    return revise(res, body.message ?? "");
  }
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
