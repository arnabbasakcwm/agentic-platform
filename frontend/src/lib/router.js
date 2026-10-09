// Hash-based routing: enough for a handful of pages, works with the browser's back and
// forward buttons and a page refresh, and needs no server-side route handling.
//
//   #/projects                 the project list
//   #/new                      define a new project
//   #/knowledge                every knowledge-base file across projects
//   #/data                     data sources (BigQuery) agents may query
//   #/mcp                      MCP servers whose tools agents may call
//   #/usage                    models, tokens and cost
//   #/projects/<id>/<step>     one project, at a step of its workflow
//   #/projects/<id>/resources/<tab>   the Resources step's documents | databases | tools

import { useEffect, useState } from "react";

export const PROJECT_STEPS = [
  "brief",
  "resources",
  "plan",
  "compile",
  "run",
  "deploy",
];

// The Resources step's tabs: what a project's agents can use.
export const RESOURCE_TABS = ["documents", "databases", "tools"];

// Steps that became Resources tabs, so old links and bookmarks still land right.
const MOVED_STEPS = { knowledge: "documents", data: "databases" };

export function parseRoute(hash) {
  const [first, id, step, tab] = hash
    .replace(/^#\/?/, "")
    .split("/")
    .filter(Boolean);
  if (first === "new") return { page: "new" };
  if (first === "knowledge") return { page: "knowledge" };
  if (first === "data") return { page: "data" };
  if (first === "mcp") return { page: "mcp" };
  if (first === "usage") return { page: "usage" };
  if (first === "projects" && id) {
    if (MOVED_STEPS[step]) {
      return { page: "project", id, step: "resources", tab: MOVED_STEPS[step] };
    }
    if (step === "resources") {
      return {
        page: "project",
        id,
        step,
        tab: RESOURCE_TABS.includes(tab) ? tab : RESOURCE_TABS[0],
      };
    }
    return {
      page: "project",
      id,
      step: PROJECT_STEPS.includes(step) ? step : "plan",
    };
  }
  if (first === "projects") return { page: "projects" };
  // No (or an unknown) route: the New project page is the console's landing page.
  return { page: "new" };
}

export function useRoute() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return parseRoute(hash);
}

export function navigate(path) {
  window.location.hash = path;
}

export const paths = {
  projects: "#/projects",
  newProject: "#/new",
  knowledge: "#/knowledge",
  data: "#/data",
  mcp: "#/mcp",
  usage: "#/usage",
  project: (id, step = "plan", tab = null) =>
    tab ? `#/projects/${id}/${step}/${tab}` : `#/projects/${id}/${step}`,
};
