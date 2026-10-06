import {
  cannotCallTools,
  modelName,
  toolsBlocked,
  withVerdicts,
} from "../../lib/models.js";
import { useToolCheck } from "../../lib/useToolCheck.js";
import { useMemo, useState } from "react";
import { Icon } from "../../components/icons.jsx";
import { ModelPicker } from "../../components/ModelPicker.jsx";
import {
  ActionBar,
  Button,
  Callout,
  ErrorCallout,
  LinkButton,
  MetaList,
  Panel,
  Pill,
} from "../../components/ui.jsx";
import { api } from "../../lib/api.js";
import { fullDate } from "../../lib/format.js";
import { paths } from "../../lib/router.js";
import { providerLabel } from "../../lib/usage.js";
import { useAction } from "../../lib/useAction.js";

// Need a data source attached to the project (Data sources page).
const SQL_TOOLS = new Set(["sql_schema", "sql_query"]);
const unique = (values) => [...new Set(values)];
const modelKey = (llm) => `${llm.provider}/${llm.model}`;

/** The models an agent may use: the platform's list, plus whatever it uses now. */
function modelOptions(providers, plan) {
  const options = providers.map((p) => ({
    ...p,
    key: `${p.provider}/${p.model}`,
  }));
  for (const agent of plan.agents) {
    if (!options.some((o) => o.key === modelKey(agent.llm))) {
      options.push({
        provider: agent.llm.provider,
        model: agent.llm.model,
        key: modelKey(agent.llm),
        available: true,
      });
    }
  }
  return options;
}

function draftFrom(plan) {
  return Object.fromEntries(
    plan.agents.map((a) => [
      a.id,
      { model: modelKey(a.llm), tools: [...a.tools] },
    ]),
  );
}

/** Change each agent's model and tools. Saving makes a new plan version. */
function AgentSettings({ project, tools, providers, onSaved, savedVersion }) {
  const { plan } = project;
  const original = useMemo(() => draftFrom(plan), [plan]);
  const [draft, setDraft] = useState(original);
  const save = useAction();
  const toolCheck = useToolCheck();
  const options = useMemo(
    () => withVerdicts(modelOptions(providers, plan), toolCheck.verdicts),
    [providers, plan, toolCheck.verdicts],
  );
  const optionFor = (key) => options.find((o) => o.key === key);
  // Agents whose model can't call tools but whose job needs it: they can't be saved.
  const blocked = plan.agents.filter((a) =>
    toolsBlocked(optionFor(draft[a.id].model), {
      tools: draft[a.id].tools,
      isRouter: a.id === plan.supervisor_id,
    }),
  );
  const hasData = (project.data_sources?.sources ?? 0) > 0;
  const hasKnowledge = (project.knowledge?.documents ?? 0) > 0;
  // knowledge_search only makes sense with files attached (the server checks too).
  const toolList = (tools.tools ?? []).filter(
    (t) =>
      (t.name !== "knowledge_search" || hasKnowledge) &&
      (!SQL_TOOLS.has(t.name) || hasData),
  );
  const enabledExternal = new Set(project.side_effect_tools_enabled ?? []);
  const external = new Set(
    toolList.filter((t) => t.side_effect).map((t) => t.name),
  );

  const changed = plan.agents.filter((a) => {
    const d = draft[a.id];
    return (
      d.model !== original[a.id].model ||
      d.tools.join() !== original[a.id].tools.join()
    );
  });
  const newlyExternal = unique(
    changed
      .flatMap((a) => draft[a.id].tools)
      .filter((t) => external.has(t) && !enabledExternal.has(t)),
  );
  const missingKey = unique(
    changed
      .map((a) => options.find((o) => o.key === draft[a.id].model))
      .filter((o) => o && o.available === false)
      .map((o) => providerLabel(o.provider)),
  );

  function setAgent(id, patch) {
    setDraft((d) => ({ ...d, [id]: { ...d[id], ...patch } }));
  }

  function chooseModel(id, key) {
    setAgent(id, { model: key });
    toolCheck.check(optionFor(key));
  }

  function toggleTool(id, name) {
    const current = new Set(draft[id].tools);
    current.has(name) ? current.delete(name) : current.add(name);
    // Registry order, so the result doesn't depend on click order.
    setAgent(id, {
      tools: toolList.map((t) => t.name).filter((n) => current.has(n)),
    });
  }

  function applyToAll(key) {
    if (!key) return;
    toolCheck.check(optionFor(key));
    setDraft((d) =>
      Object.fromEntries(
        Object.entries(d).map(([id, v]) => [id, { ...v, model: key }]),
      ),
    );
  }

  async function submit() {
    const agents = changed.map((a) => {
      const [provider, ...rest] = draft[a.id].model.split("/");
      return {
        id: a.id,
        provider,
        model: rest.join("/"),
        tools: draft[a.id].tools,
      };
    });
    const updated = await save.run(() =>
      api.updateAgents(project.project_id, agents),
    );
    if (updated) onSaved(updated);
  }

  return (
    <Panel
      title="Models and tools"
      subtitle="Choose each agent's model and the tools it may use."
      actions={
        <ModelPicker
          className="agentset__all"
          label="Use one model for every agent"
          value=""
          placeholder="Use one model for all…"
          options={options}
          onChange={applyToAll}
          disabled={save.busy}
        />
      }
      flush
    >
      <ul className="agentset">
        {plan.agents.map((agent) => {
          const d = draft[agent.id];
          const isRouter = agent.id === plan.supervisor_id;
          const current = optionFor(d.model);
          const noTools = cannotCallTools(current);
          const job = { tools: d.tools, isRouter };
          return (
            <li key={agent.id} className="agentset__item">
              <div className="agentset__who">
                <span className="mono agentset__id">{agent.id}</span>
                <span className="muted agentset__role">{agent.role}</span>
                {isRouter && <Pill tone="accent">router</Pill>}
              </div>
              <div className="agentset__model">
                <ModelPicker
                  label={`Model for ${agent.id}`}
                  value={d.model}
                  options={options}
                  onChange={(model) => chooseModel(agent.id, model)}
                  isDisabled={(o) =>
                    o.key !== d.model &&
                    (o.available === false || toolsBlocked(o, job))
                  }
                  disabledReason={(o) =>
                    toolsBlocked(o, job)
                      ? isRouter
                        ? "Can't call tools, so it can't route the team"
                        : "Can't call tools, and this agent has tools"
                      : null
                  }
                  disabled={save.busy}
                />
              </div>
              {toolCheck.checking === d.model && (
                <span className="muted agentset__note" role="status">
                  Checking whether {modelName(current ?? { model: d.model })}{" "}
                  can call tools…
                </span>
              )}
              {toolsBlocked(current, job) && (
                <p className="agentset__warn" role="alert">
                  <strong>{modelName(current)}</strong> can&apos;t call tools,{" "}
                  {isRouter
                    ? "so it can't route the team. Choose a model that can call tools."
                    : "so it can't use this agent's tools. Remove its tools, or choose a model that can call tools."}
                </p>
              )}
              {isRouter ? (
                <span className="muted agentset__note">
                  The router only chooses who acts next; it uses no tools.
                </span>
              ) : (
                <div
                  className="togglechips"
                  role="group"
                  aria-label={`Tools for ${agent.id}`}
                >
                  {toolList.map((tool) => {
                    const on = d.tools.includes(tool.name);
                    return (
                      <button
                        key={tool.name}
                        type="button"
                        className={[
                          "togglechip",
                          on && "togglechip--on",
                          tool.side_effect && "togglechip--external",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        aria-pressed={on}
                        title={
                          !on && noTools
                            ? `${modelName(current)} can't call tools`
                            : tool.description +
                              (tool.side_effect
                                ? " — sends data to a third party"
                                : "")
                        }
                        onClick={() => toggleTool(agent.id, tool.name)}
                        // A tool can always be switched off; switched on only if the model can call tools.
                        disabled={save.busy || (!on && noTools)}
                      >
                        {on && <Icon name="check" size={12} />}
                        {tool.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <div className="panel__body stack">
        {newlyExternal.length > 0 && (
          <Callout tone="warn" title="External access">
            Turning on <strong>{newlyExternal.join(", ")}</strong> lets this
            project&apos;s agents send task data to third-party services. Saving
            counts as this project&apos;s opt-in.
          </Callout>
        )}
        {missingKey.length > 0 && (
          <Callout tone="warn" title="No API key">
            This server has no key for {missingKey.join(", ")}, so those agents
            can&apos;t run until one is added.
          </Callout>
        )}
        {savedVersion === project.plan_version && changed.length === 0 && (
          <Callout tone="success" title={`Saved as plan v${savedVersion}`}>
            Compile it again before running.{" "}
            <a href={paths.project(project.project_id, "compile")}>
              Go to Compile
            </a>
          </Callout>
        )}
        <ErrorCallout error={save.error} />
        <div className="row">
          <Button
            variant="primary"
            onClick={submit}
            loading={save.busy}
            disabled={
              changed.length === 0 ||
              blocked.length > 0 ||
              toolCheck.checking !== null
            }
          >
            Save changes
          </Button>
          <Button
            onClick={() => setDraft(original)}
            disabled={changed.length === 0 || save.busy}
          >
            Reset
          </Button>
          <span className="muted">
            {changed.length > 0
              ? `${changed.length} agent${changed.length === 1 ? "" : "s"} changed — saving makes plan v${project.plan_version + 1}.`
              : "No changes."}
          </span>
        </div>
      </div>
    </Panel>
  );
}

export function BriefStep({ project, tools, providers, onSaved }) {
  const { plan } = project;
  // Kept here, not in the editor (which starts fresh for each plan version), so the
  // "Saved" confirmation survives the save.
  const [savedVersion, setSavedVersion] = useState(null);
  const models = unique(plan.agents.map((a) => a.llm.model));
  const toolsInUse = unique(plan.agents.flatMap((a) => a.tools));
  const external = project.side_effect_tools_enabled ?? [];

  return (
    <>
      <div className="page">
        <div className="split">
          <div className="stack">
            <Panel
              title="Task brief"
              subtitle="What the planner was asked to build a team for."
            >
              <p className="prose">{project.brief}</p>
            </Panel>
            <AgentSettings
              key={project.plan_version}
              project={project}
              tools={tools}
              providers={providers}
              savedVersion={savedVersion}
              onSaved={(updated) => {
                setSavedVersion(updated.plan_version);
                onSaved(updated);
              }}
            />
          </div>

          <aside className="split__aside">
            <Panel title="Details">
              <MetaList
                rows={[
                  [
                    "Created",
                    project.created_at ? fullDate(project.created_at) : null,
                  ],
                  [
                    "Last changed",
                    project.updated_at ? fullDate(project.updated_at) : null,
                  ],
                  [
                    "Agents",
                    <span key="Agents" className="mono">
                      {plan.agents.length}
                    </span>,
                  ],
                  ["Models", models.map((m) => <Pill key={m}>{m}</Pill>)],
                  [
                    "Tools in use",
                    toolsInUse.length > 0 ? (
                      toolsInUse.map((t) => (
                        <Pill
                          key={t}
                          tone={external.includes(t) ? "warn" : undefined}
                        >
                          {t}
                        </Pill>
                      ))
                    ) : (
                      <span className="muted">None</span>
                    ),
                  ],
                  [
                    "External access",
                    external.length > 0 ? (
                      external.map((t) => (
                        <Pill key={t} tone="warn">
                          {t}
                        </Pill>
                      ))
                    ) : (
                      <span className="muted">None allowed</span>
                    ),
                  ],
                ]}
              />
            </Panel>
          </aside>
        </div>
      </div>

      <ActionBar note="The task brief is fixed once a plan exists; change models and tools here, or ask the assistant for other changes.">
        <LinkButton
          variant="primary"
          href={paths.project(project.project_id, "plan")}
        >
          Review plan
          <Icon name="arrowRight" />
        </LinkButton>
      </ActionBar>
    </>
  );
}
