import { useCallback, useEffect, useState } from "react";
import { AuthPanel } from "./components/AuthPanel.jsx";
import { Icon } from "./components/icons.jsx";
import { Sidebar } from "./components/Sidebar.jsx";
import { HealthPill, TopBar } from "./components/TopBar.jsx";
import { api, session } from "./lib/api.js";
import { projectTitle } from "./lib/format.js";
import { navigate, paths, useRoute } from "./lib/router.js";
import { useAction } from "./lib/useAction.js";
import { NewProjectPage } from "./pages/NewProjectPage.jsx";
import { ProjectWorkspace } from "./pages/ProjectWorkspace.jsx";
import { ProjectsPage } from "./pages/ProjectsPage.jsx";

const COLLAPSED_KEY = "agentic-platform.sidebar-collapsed";
const STEP_LABELS = { brief: "Brief", plan: "Plan", compile: "Compile", run: "Run" };

// A per-browser convenience only, so it lives in localStorage and the app works the
// same if storage is unavailable.
function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function crumbsFor(route, projects) {
  const root = { label: "Projects", href: paths.projects };
  if (route.page === "new") return [root, { label: "New project" }];
  if (route.page === "project") {
    const known = projects?.find((p) => p.project_id === route.id);
    return [
      root,
      {
        label: known ? projectTitle(known.brief, 48) : "Project",
        href: paths.project(route.id, "plan"),
      },
      { label: STEP_LABELS[route.step] },
    ];
  }
  return [{ label: "Projects" }];
}

export default function App() {
  const route = useRoute();

  const [health, setHealth] = useState("checking");
  const [tools, setTools] = useState({ tools: [], default: [] });
  const [providers, setProviders] = useState([]);

  // undefined = still restoring a saved session, null = signed out.
  const [user, setUser] = useState(session.hasToken() ? undefined : null);
  const [authNotice, setAuthNotice] = useState(null);
  const auth = useAction();

  // null = not loaded yet.
  const [projects, setProjects] = useState(null);
  const [projectsError, setProjectsError] = useState(null);

  const [collapsed, setCollapsed] = useState(readCollapsed);

  useEffect(() => {
    api
      .health()
      .then(() => setHealth("online"))
      .catch(() => setHealth("offline"));
    api.tools().then(setTools).catch(() => {});
    api
      .providers()
      .then((r) => setProviders(r.providers))
      .catch(() => {});
  }, []);

  useEffect(() => {
    session.onExpired(() => {
      setUser(null);
      setAuthNotice("Your session has expired. Sign in again to continue.");
    });
    // Restore a saved session; a rejected token is cleared by the handler above.
    if (session.hasToken()) {
      api
        .me()
        .then(setUser)
        .catch(() => setUser(null));
    }
  }, []);

  const refreshProjects = useCallback(() => {
    api
      .listProjects()
      .then((r) => {
        setProjects(r.projects);
        setProjectsError(null);
      })
      .catch(setProjectsError);
  }, []);

  const userId = user?.id;
  useEffect(() => {
    setProjects(null);
    setProjectsError(null);
    if (userId) refreshProjects();
  }, [userId, refreshProjects]);

  async function authenticate(action, credentials) {
    const result = await auth.run(() => action(credentials));
    if (!result) return;
    session.set(result.access_token);
    setAuthNotice(null);
    setUser(result.user);
  }

  function signOut() {
    session.clear();
    setUser(null);
    setAuthNotice(null);
    navigate(paths.projects);
  }

  function toggleSidebar() {
    setCollapsed((was) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, was ? "0" : "1");
      } catch {
        // Not remembered across visits; still works for this one.
      }
      return !was;
    });
  }

  if (!user) {
    return (
      <div className="authscreen">
        <div className="brand">
          <span className="brand__mark">
            <Icon name="brand" size={15} />
          </span>
          <span className="brand__name">Agentic Platform</span>
        </div>
        {user === null && (
          <AuthPanel
            onLogin={(c) => authenticate(api.login, c)}
            onRegister={(c) => authenticate(api.register, c)}
            busy={auth.busy}
            error={auth.error}
            notice={authNotice}
            disabled={health === "offline"}
          />
        )}
        <div className="authscreen__status">
          <HealthPill health={health} />
        </div>
      </div>
    );
  }

  return (
    <div className={collapsed ? "shell shell--collapsed" : "shell"}>
      <Sidebar
        route={route}
        projects={projects}
        user={user}
        collapsed={collapsed}
        onToggle={toggleSidebar}
        onSignOut={signOut}
      />

      <div className="main">
        <TopBar crumbs={crumbsFor(route, projects)} health={health} />
        {health === "offline" && (
          <div className="banner" role="alert">
            The API is unreachable. Start the backend on port 8000, then reload this page.
          </div>
        )}

        <main className="content">
          {route.page === "projects" && (
            <ProjectsPage projects={projects} error={projectsError} onRetry={refreshProjects} />
          )}
          {route.page === "new" && (
            <NewProjectPage
              tools={tools}
              providers={providers}
              disabled={health === "offline"}
              onCreated={refreshProjects}
            />
          )}
          {route.page === "project" && (
            <ProjectWorkspace
              key={route.id}
              id={route.id}
              step={route.step}
              onChanged={refreshProjects}
            />
          )}
        </main>
      </div>
    </div>
  );
}
