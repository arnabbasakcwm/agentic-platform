// Pure helpers for the Knowledge page: checking files before upload, and how a
// document's indexing status is shown.

const PROVIDER_NAMES = { google_genai: "Google Gemini", openai: "OpenAI" };

export function providerName(provider) {
  return PROVIDER_NAMES[provider] ?? provider;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

export function extensionOf(name) {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

/**
 * Split chosen files into those worth sending and a problem per refused file, using the
 * same limits the API enforces (it checks again; this just saves a wasted upload).
 */
export function checkFiles(files, limits, existingNames) {
  const taken = new Set(existingNames.map((n) => n.toLowerCase()));
  const accepted = [];
  const problems = [];
  for (const file of files) {
    const ext = extensionOf(file.name);
    if (!limits.file_types.includes(ext)) {
      problems.push(`${file.name}: not a supported type (${limits.file_types.join(", ")})`);
    } else if (file.size === 0) {
      problems.push(`${file.name}: the file is empty`);
    } else if (file.size > limits.max_file_bytes) {
      problems.push(`${file.name}: larger than ${formatBytes(limits.max_file_bytes)}`);
    } else if (taken.has(file.name.toLowerCase())) {
      problems.push(`${file.name}: already added — delete it first to replace it`);
    } else {
      taken.add(file.name.toLowerCase());
      accepted.push(file);
    }
  }
  const room = limits.max_files - existingNames.length;
  if (accepted.length > room) {
    problems.push(
      `Only ${Math.max(room, 0)} more file${room === 1 ? "" : "s"} fit (limit ${limits.max_files} per project).`,
    );
    accepted.splice(Math.max(room, 0));
  }
  // The API takes a limited number per request; the page sends them in batches.
  return { accepted, problems };
}

export function batches(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Document status -> the badge status and label used across the console.
const STATUS = {
  queued: ["queued", "Queued"],
  processing: ["running", "Indexing"],
  ready: ["completed", "Ready"],
  failed: ["failed", "Failed"],
};

export function documentBadge(status) {
  const [badge, label] = STATUS[status] ?? STATUS.queued;
  return { badge, label };
}

export function isIndexing(documents) {
  return documents.some((d) => d.status === "queued" || d.status === "processing");
}

// What the "give agents access" button asks the plan assistant for.
export const ACCESS_REQUEST =
  "Give the agents that need facts from the uploaded documents the knowledge_search tool, " +
  "and have them cite the file and page or rows for facts they use from it.";

export function knowledgeHint(summary) {
  if (!summary || summary.documents === 0) return "Optional";
  const n = summary.documents;
  if (summary.ready < n) return `${summary.ready} of ${n} ready`;
  return `${n} file${n === 1 ? "" : "s"}`;
}

// Status filter values on the workspace Knowledge page -> document statuses.
export const STATUS_FILTERS = {
  all: null,
  ready: ["ready"],
  indexing: ["queued", "processing"],
  failed: ["failed"],
};

/** Documents matching a name search, a project id ("" = all) and a STATUS_FILTERS key. */
export function filterDocuments(documents, { query = "", project = "", status = "all" } = {}) {
  const needle = query.trim().toLowerCase();
  const statuses = STATUS_FILTERS[status] ?? null;
  return documents.filter(
    (d) =>
      (!needle || d.filename.toLowerCase().includes(needle)) &&
      (!project || d.project_id === project) &&
      (!statuses || statuses.includes(d.status)),
  );
}

export function knowledgeTotals(documents) {
  const totals = { files: documents.length, ready: 0, indexing: 0, failed: 0, passages: 0 };
  for (const d of documents) {
    if (d.status === "ready") totals.ready += 1;
    else if (d.status === "failed") totals.failed += 1;
    else totals.indexing += 1;
    totals.passages += d.chunk_count ?? 0;
  }
  return totals;
}
