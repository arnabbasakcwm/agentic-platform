import { Icon } from "./icons.jsx";

// What the platform does, beside the sign-in form on wide screens. Every point describes
// something the console really does today.
const POINTS = [
  {
    icon: "chat",
    title: "Describe the task",
    text: "Talk it through, then the planner proposes the agents, their models and tools. You review the plan before anything runs.",
  },
  {
    icon: "play",
    title: "Watch every run",
    text: "Follow each agent live, stop a run whenever you need to, and reopen your recent runs later.",
  },
  {
    icon: "database",
    title: "Bring your data, then deploy",
    text: "Give agents your documents, BigQuery tables and approved MCP tools, and deploy the team to Amazon Bedrock AgentCore.",
  },
];

const TEAM = [
  { label: "Researcher", state: "Completed", tone: "success" },
  { label: "Analyst", state: "Running", tone: "running" },
  { label: "Writer", state: "Queued", tone: "warn" },
];

/**
 * A small sequential team: three glass chips handing work along, each with its state.
 * The chips light up in turn on a loop (DESIGN.md §7, sign in); decorative only.
 */
function TeamSketch() {
  return (
    <ol className="authintro__team" aria-hidden="true">
      {TEAM.map((a, i) => (
        <li
          key={a.label}
          className={`authintro__chip authintro__chip--${i + 1}`}
          style={{ "--i": i }}
        >
          <span className="authintro__bar" />
          <span className="authintro__name">{a.label}</span>
          <span className={`authintro__state authintro__state--${a.tone}`}>
            {a.tone === "running" && <span className="dot ap-dot ap-dot--live" />}
            {a.state}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function AuthIntro() {
  return (
    <section className="authintro ap-mesh" aria-label="About Agentic Platform">
      <div className="brand">
        <span className="brand__mark">
          <Icon name="brand" size={16} />
        </span>
        <span className="brand__name">Agentic Platform</span>
      </div>
      <div className="authintro__body">
        <p className="authintro__title">Describe a task. Get a team of agents that does it.</p>
        <TeamSketch />
        <ul className="authintro__points">
          {POINTS.map((p) => (
            <li key={p.title}>
              <span className="authintro__icon">
                <Icon name={p.icon} size={16} />
              </span>
              <span>
                <strong>{p.title}</strong>
                <span className="authintro__text">{p.text}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
