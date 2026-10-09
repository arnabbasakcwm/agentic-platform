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

/** A small sequential team, drawn: three agents handing work along. Decorative. */
function TeamSketch() {
  const agents = [
    { x: 24, label: "Researcher" },
    { x: 152, label: "Analyst" },
    { x: 280, label: "Writer" },
  ];
  return (
    <svg className="authintro__sketch" viewBox="0 0 400 96" aria-hidden="true" focusable="false">
      {agents.slice(0, -1).map((a) => (
        <g key={a.label} className="authintro__edge">
          <path d={`M${a.x + 96} 48 H${a.x + 128}`} />
          <path d={`M${a.x + 122} 43 l6 5 -6 5`} />
        </g>
      ))}
      {agents.map((a, i) => (
        <g
          key={a.label}
          className={`authintro__node authintro__node--${i + 1}${i === 1 ? " authintro__node--on" : ""}`}
        >
          <rect x={a.x} y={24} width={96} height={48} rx={10} />
          <rect className="authintro__bar" x={a.x} y={24} width={4} height={48} rx={2} />
          <text x={a.x + 16} y={45}>
            {a.label}
          </text>
          <text className="authintro__state" x={a.x + 16} y={60}>
            {i === 0 ? "Completed" : i === 1 ? "Running" : "Queued"}
          </text>
        </g>
      ))}
    </svg>
  );
}

export function AuthIntro() {
  return (
    <section className="authintro" aria-label="About Agentic Platform">
      <div className="brand">
        <span className="brand__mark">
          <Icon name="brand" size={15} />
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
