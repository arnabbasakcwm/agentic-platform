# Plan: Knowledge page layout + embedding model per file

Status: **done** (2026-10-06). Recorded in the CLAUDE.md decision log, "Each knowledge
file has its own embedding model". Where the build differs from this plan, the decision
log and code are what's current: the snapshot keeps one matrix per model in
`knowledge_vectors.npz` (see the 2026-10-06 update below).

## Context

The user asked for three changes to the Knowledge (library) page:

1. **Remove the "Attach to" option from the right-hand panel.** Files are attached to
   projects only from their own row, via the existing **Attach / Change** checklist.
2. **Centre the drag-and-drop upload area.** It moves out of the right-hand panel into
   the middle of the page, above the files table.
3. **Choose the embedding model per file, from the file's row.** Today the library has
   one embedding model for every file (decision log, 2026-10-05, "Knowledge is a
   per-user library").

Change 3 replaces an earlier decision. The library's model becomes the **default for
new uploads**, and each file records the model it was indexed with.

## What per-file models mean for search (the important design point)

- **Separate vector spaces:** each embedding model maps text into its own space. A
  question must be embedded **once per model in use** among the files being searched,
  and each file's passages are compared only with the query vector from its own model.
- **Scores don't compare across models:** a 0.71 from Gemini and a 0.71 from OpenAI
  aren't equivalent, so results can't be merged by score. Instead:
  - rank passages **within each model**;
  - merge the per-model rankings with **reciprocal rank fusion (RRF)**: score =
    Σ 1 / (60 + rank). This is the standard way to combine independent rankings.
  - When every file uses the same model, there's only one ranking, and results are
    identical to today's.
- **Cost:** one query embedding per distinct model per search. Usage accounting already
  records each query embedding, so this shows up per model on the Usage page.
- **Hit score:** a hit keeps its within-model cosine score for display, and is marked
  with the model it came from.

## Backend

### Data
- `KnowledgeDocument.embedding: EmbeddingConfig | None`: the model the file was indexed
  with, set at upload from the library default.
- **Existing files** have no `embedding` field. Read them as "the library default"; no
  migration write is needed. `GET` responses always return the file's effective model.
- `knowledge_settings.embedding` keeps its meaning: the **default for new uploads**.

### Indexing
- `index_document` embeds with the file's own model. `_index_upload` builds the embedder
  from `doc.embedding`, not the library setting.
- **New job `reembed_document(store, tenant_id, document_id, embedder)`**, which reuses
  `reembed_library`'s per-file logic:
  - sets the file to `processing`;
  - re-embeds the stored passage text with the new model;
  - stores the new `embedding` on the document, then sets it to `ready`;
  - on failure, the file is `failed` with the error and **keeps its old vectors and
    model**.

### API
- **New `PUT /knowledge/documents/{doc_id}/embedding {provider, model}`:**
  - owner-scoped (another user's file is a 404); the model must be one of
    `EMBEDDING_MODELS` and its key configured;
  - `409 KnowledgeBusy` while that file is indexing;
  - otherwise re-embeds that one file in the background (202), and the file shows
    "Indexing" until done.
- **`PUT /knowledge/embedding` changes meaning:** it now sets the default for **new
  uploads only**; it no longer re-embeds the whole library. Update its docstring, tests
  and the README API table.
- **`GET /knowledge`:** each document carries its `embedding`, and the response has
  `default_embedding` plus `embedding_options` (already there, with `available`).

### Search, the tool, test search
- `KnowledgeContext` becomes **multi-model**:
  - `load()` returns passages with each document's model;
  - `embedder_for(config)` returns a cached `get_embeddings(config)` per model per
    process;
  - `search()` groups passages by model, embeds the query once per group, ranks within
    each group with `_rank`, then merges with RRF to the top k.
- `store_context(store, tenant_id, project_id)` no longer takes a single embedder.
- **`knowledge_search`:** counts one `embedding_query` usage entry **per model used**.
- **Compiled-graph cache:** `_compiled_graph` no longer keys on the library model,
  because embedders are resolved at search time.

### Deployments
- **Snapshot:** `build_snapshot` records each document's model
  (`documents: {id: {filename, embedding}}`). Vectors stay in one float32 matrix, since
  every model is 768-dimensional.
- **Runtime:** `SnapshotContext` groups rows by model the same way, with an embedder per
  model.
- **Keys:** `runtime_environment(plan, embeddings: list[EmbeddingConfig])` passes the key
  of **every** embedding provider used by the attached files.
- **Old snapshots** (single top-level `embedding`) still load: every document uses that
  model.

## Frontend (Knowledge page)

- **Layout:**
  - drop the right-hand aside;
  - the centred upload area goes full width at the top, under the totals, with a small
    "New files use: [default model ▾]" select beside it (replacing the separate
    "Embedding model" panel);
  - then the toolbar and the files table, full width.
- **Upload:** no "Attach to" select anymore; uploads go to the library only. (The
  project Knowledge step and the new-project chat still attach on upload, as now.)
- **Files table:** new **Embedding model** column with a select per row.
  - Changing it confirms inline ("Re-index policy.pdf with OpenAI?") because it costs
    embedding calls.
  - It then calls the new endpoint, and the row shows "Indexing" through the existing
    polling.
  - Models without an API key are disabled.
- **Unchanged:** project attachments stay in the row's **Attach / Change** checklist.
- **Shared helpers:** `lib/knowledge.js` gets helpers for the model label and options,
  with Vitest tests.
- **Mock API and e2e:**
  - `mock-api.js` gets per-document `embedding`, the new endpoint, and
    `default_embedding`;
  - Playwright covers the centred upload, no attach option in the upload area, changing
    a file's model (confirm → Indexing → Ready), and the default-model select;
  - axe in light and dark, with screenshots reviewed.

## Tests (backend)
- Store: `embedding` round-trips; a missing field reads as `None`.
- Search over mixed models:
  - a fake embedder per model;
  - each group is queried with its own model;
  - the RRF order is deterministic;
  - a single model gives the same results as before.
- The per-file re-embed job, success and failure (the old vectors are kept).
- API:
  - owner scoping;
  - `409` while indexing;
  - an unknown model is `422`;
  - the default-only behaviour of `PUT /knowledge/embedding`.
- Deploy: a snapshot with two models; the runtime searches it; old-format snapshots
  still load; the environment includes both embedding keys.
- Usage: one `embedding_query` entry per model per search.

## Docs
- **Decision log:** a new entry superseding the "one model per library" part of the
  library decision. It says why (the user wants per-file choice), how mixed-model search
  works (per-model query embedding plus RRF), and the cost note.
- Also update the README (Knowledge page, API table) and systemDescription §6.1.

## Verification
1. Offline: the full backend suite, then lint, Vitest, build and Playwright for the
   frontend.
2. **Live, on a throwaway `MONGODB_DB`** (never the real database; see memory):
   - upload two files, switch one to OpenAI (if a key is available) or keep both on
     Gemini;
   - check that the project test search queries each model and returns merged, cited
     results;
   - check that the Usage page shows the query embeddings per model;
   - drop the throwaway database afterwards.

## Update 2026-10-06: vector sizes now differ by model

Bedrock embeddings (Titan v2, Cohere v4) produce **1024-dimension** vectors, while
Gemini/OpenAI produce 768. With one model per library this is harmless, but **per-file**
models would mix sizes. So this plan must also:
- keep one matrix **per model** in search and in the deploy snapshot (the snapshot's
  single matrix currently refuses mixed sizes);
- group by model *and* size, which RRF merging already handles.

## Open question for when we resume
- An OpenAI key isn't configured on this server right now (`/providers` shows OpenAI
  unavailable), so only Gemini is selectable. Mixed-model search can be tested offline
  with fake embedders, but a live mixed-model check needs a second provider's key.
