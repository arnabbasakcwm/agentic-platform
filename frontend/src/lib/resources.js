// The Resources step: what a project's agents can use (documents, databases, MCP tools).

/** Counts per tab, from the project summary the API returns. */
export function resourceCounts(project) {
  return {
    documents: project?.knowledge?.documents ?? 0,
    databases: project?.data_sources?.sources ?? 0,
    tools: project?.mcp?.servers ?? 0,
  };
}

/** The stepper's hint: "2 docs · 1 db · 1 MCP", or "Optional" when nothing is attached. */
export function resourcesHint(project) {
  const { documents, databases, tools } = resourceCounts(project);
  const parts = [];
  if (documents) {
    const ready = project.knowledge?.ready ?? documents;
    parts.push(
      ready < documents
        ? `${ready}/${documents} docs ready`
        : `${documents} doc${documents === 1 ? "" : "s"}`,
    );
  }
  if (databases) parts.push(`${databases} db${databases === 1 ? "" : "s"}`);
  if (tools) parts.push(`${tools} MCP`);
  return parts.length ? parts.join(" · ") : "Optional";
}

/** Whether agents can use anything: a ready file, a table, or an approved MCP tool. */
export function resourcesReady(project) {
  return (
    (project?.knowledge?.ready ?? 0) > 0 ||
    (project?.data_sources?.tables ?? 0) > 0 ||
    (project?.mcp?.tools?.length ?? 0) > 0
  );
}
