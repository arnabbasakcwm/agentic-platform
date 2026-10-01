// Hash-based routing: enough for a handful of pages, works with the browser's back and
// forward buttons and a page refresh, and needs no server-side route handling.
//
//   #/projects                 the project list
//   #/new                      define a new project
//   #/projects/<id>/<step>     one project, at a step of its workflow

import { useEffect, useState } from "react";

export const PROJECT_STEPS = ["brief", "knowledge", "plan", "compile", "run", "deploy"];

export function parseRoute(hash) {
  const [first, id, step] = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (first === "new") return { page: "new" };
  if (first === "projects" && id) {
    return { page: "project", id, step: PROJECT_STEPS.includes(step) ? step : "plan" };
  }
  return { page: "projects" };
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
  project: (id, step = "plan") => `#/projects/${id}/${step}`,
};
