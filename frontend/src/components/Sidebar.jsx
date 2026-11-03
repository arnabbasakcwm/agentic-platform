import { SquareTerminal } from "lucide-react";
import { useRef } from "react";
import { isAdminRole } from "../lib/admin.js";
import { projectName } from "../lib/format.js";
import { paths } from "../lib/router.js";
import { useSlidingIndicator } from "../lib/useSlidingIndicator.js";
import { Icon } from "./icons.jsx";

const RECENT_LIMIT = 5;
const API_DOCS_URL = "http://127.0.0.1:8000/docs";

// `tone` colours the item's icon and its active pill (DESIGN.md §2: Projects violet,
// Knowledge teal, Data sources amber, MCP servers sky, Usage pink, Admin slate).
function NavItem({
  href,
  icon,
  label,
  active,
  trail,
  tone,
  className = "",
  children,
  ...props
}) {
  return (
    <a
      href={href}
      className={`navitem ${active ? "navitem--active" : ""} ${className}`}
      aria-current={active ? "page" : undefined}
      title={label}
      data-tone={tone}
      {...props}
    >
      {icon && <Icon name={icon} />}
      {children}
      <span className="navitem__label">{label}</span>
      {trail}
    </a>
  );
}

export function Sidebar({
  route,
  projects,
  knowledgeCount,
  user,
  collapsed,
  onToggle,
  onSignOut,
}) {
  const recent = (projects ?? []).slice(0, RECENT_LIMIT);
  // The active item's tinted pill slides between items (DESIGN.md §7).
  const navRef = useRef(null);
  useSlidingIndicator(navRef, ".navitem--active:not(.navitem--cta)", [
    route.page,
    route.id,
    recent.length,
    collapsed,
  ]);

  return (
    <aside className="sidebar" aria-label="Main navigation">
      <div className="sidebar__head">
        <a className="brand" href={paths.projects}>
          <span className="brand__mark">
            <Icon name="brand" size={16} />
          </span>
          <span className="brand__name">Agentic Platform</span>
        </a>
        <button
          type="button"
          className="iconbtn"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <Icon name="sidebar" />
        </button>
      </div>

      <nav className="sidebar__nav" ref={navRef}>
        <span className="sidebar__indicator ap-nav-indicator" aria-hidden="true" />
        <NavItem
          href={paths.newProject}
          icon="plus"
          label="New project"
          active={route.page === "new"}
          className="navitem--cta ap-btn-primary"
        />

        <div className="sidebar__label">Workspace</div>
        <NavItem
          href={paths.projects}
          icon="folder"
          label="Projects"
          tone="violet"
          active={route.page === "projects"}
          trail={
            projects && projects.length > 0 ? (
              <span className="navitem__count">{projects.length}</span>
            ) : null
          }
        />

        <NavItem
          href={paths.knowledge}
          icon="book"
          label="Knowledge"
          tone="teal"
          active={route.page === "knowledge"}
          trail={
            knowledgeCount > 0 ? (
              <span className="navitem__count">{knowledgeCount}</span>
            ) : null
          }
        />
        <NavItem
          href={paths.data}
          icon="database"
          label="Data sources"
          tone="amber"
          active={route.page === "data"}
        />
        <NavItem
          href={paths.mcp}
          icon="bolt"
          label="MCP servers"
          tone="sky"
          active={route.page === "mcp"}
        />
        <NavItem
          href={paths.usage}
          icon="chart"
          label="Usage"
          tone="pink"
          active={route.page === "usage"}
        />
        {isAdminRole(user?.role) && (
          <NavItem
            href={paths.admin}
            icon="shield"
            label="Admin"
            tone="slate"
            active={route.page === "admin" || route.page === "adminUser"}
          />
        )}

        {recent.length > 0 && (
          <div className="sidebar__recent">
            <div className="sidebar__label">Recent projects</div>
            {recent.map((p) => (
              <NavItem
                key={p.project_id}
                href={paths.project(p.project_id, p.compiled ? "run" : "plan")}
                label={projectName(p, 40)}
                tone="violet"
                active={route.page === "project" && route.id === p.project_id}
                className="navitem--sub"
              >
                <SquareTerminal className="icon" size={15} aria-hidden="true" />
              </NavItem>
            ))}
          </div>
        )}
      </nav>

      <div className="sidebar__foot">
        <NavItem
          href={API_DOCS_URL}
          icon="docs"
          label="API docs"
          target="_blank"
          rel="noreferrer"
          trail={
            <span className="navitem__trail">
              <Icon name="external" size={13} />
            </span>
          }
        />
        <div className="sidebar__user">
          <span className="avatar">{user.email[0]}</span>
          <span className="sidebar__email" title={user.email}>
            {user.email}
          </span>
          <button
            type="button"
            className="iconbtn"
            onClick={onSignOut}
            aria-label="Sign out"
            title="Sign out"
          >
            <Icon name="signOut" />
          </button>
        </div>
      </div>
    </aside>
  );
}
