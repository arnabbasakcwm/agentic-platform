import { useState } from "react";
import { Icon } from "../../components/icons.jsx";
import {
  ActionBar,
  Button,
  Callout,
  Empty,
  ErrorCallout,
  Field,
  LinkButton,
  Panel,
  Pill,
} from "../../components/ui.jsx";
import { api } from "../../lib/api.js";
import { paths } from "../../lib/router.js";
import { useAction } from "../../lib/useAction.js";

const SAMPLE = '{\n  "question": "What is the speed of light?"\n}';

function Results({ result }) {
  const outputs = Object.entries(result.outputs ?? {});
  const errors = result.errors ?? [];

  return (
    <>
      {errors.map((err, i) => (
        <div key={i} style={{ marginBottom: 10 }}>
          <Callout
            tone="danger"
            title={
              err.attempts > 0
                ? `${err.agent_id} failed after ${err.attempts} attempt${err.attempts === 1 ? "" : "s"}`
                : `${err.agent_id} did not run`
            }
          >
            {err.error}
          </Callout>
        </div>
      ))}

      {outputs.map(([agentId, output]) => (
        <div key={agentId} className="result">
          <header className="result__head">
            <span className="agent__id">{agentId}</span>
          </header>
          <div className="result__body">{output.content}</div>
          {output.data && Object.keys(output.data).length > 0 && (
            <pre className="result__data">{JSON.stringify(output.data, null, 2)}</pre>
          )}
        </div>
      ))}

      {outputs.length === 0 && errors.length === 0 && <Empty>The run produced no output.</Empty>}
    </>
  );
}

export function RunStep({ project, result, onResult }) {
  const [mode, setMode] = useState("graph");
  const [input, setInput] = useState(SAMPLE);
  const [agentId, setAgentId] = useState("");
  const [parseError, setParseError] = useState(null);
  const run = useAction();

  const agents = project.plan.agents;
  const selectedAgent = agentId || agents[0]?.id || "";
  const blocked = mode === "graph" && !project.compiled;

  async function execute(event) {
    event.preventDefault();
    let parsed;
    try {
      parsed = JSON.parse(input);
    } catch (e) {
      setParseError({ errorType: "Invalid JSON", message: e.message });
      return;
    }
    setParseError(null);
    onResult(null);

    if (mode === "graph") {
      const res = await run.run(() => api.run(project.project_id, parsed));
      if (res) onResult({ ...res, label: "Full graph" });
    } else {
      const res = await run.run(() => api.invokeAgent(project.project_id, selectedAgent, parsed));
      // A single-agent call returns that node's raw state update; give it the same
      // {outputs, errors, halted} shape a full run has.
      if (res) {
        onResult({
          outputs: res.result.outputs ?? {},
          errors: res.result.errors ?? [],
          halted: Boolean(res.result.halted),
          label: `Agent ${selectedAgent}`,
        });
      }
    }
  }

  return (
    <>
      <div className="page">
        <div className="split split--even">
          <form onSubmit={execute}>
            <Panel
              title="Input"
              footer={
                <Button type="submit" variant="primary" loading={run.busy} disabled={blocked}>
                  {!run.busy && <Icon name="play" size={14} />}
                  {run.busy ? "Running…" : mode === "graph" ? "Run graph" : "Run agent"}
                </Button>
              }
            >
              <div className="tabs" role="tablist">
                {[
                  ["graph", "Full graph"],
                  ["agent", "Single agent"],
                ].map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={mode === key}
                    className={mode === key ? "tab tab--active" : "tab"}
                    onClick={() => setMode(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {mode === "agent" && (
                <Field label="Agent" hint="Runs this one agent on its own, without the rest of the team.">
                  <select value={selectedAgent} onChange={(e) => setAgentId(e.target.value)}>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.id} — {a.role}
                      </option>
                    ))}
                  </select>
                </Field>
              )}

              <Field
                label="Task input (JSON)"
                hint={
                  mode === "graph"
                    ? "Every agent receives this as the shared task input."
                    : "The agent receives this as its task input."
                }
              >
                <textarea
                  className="mono"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  style={{ minHeight: 160 }}
                  spellCheck={false}
                />
              </Field>

              {blocked && (
                <Callout tone="warn" title="Not compiled">
                  The full graph needs a compiled plan.{" "}
                  <a href={paths.project(project.project_id, "compile")}>Go to Compile</a>
                </Callout>
              )}
              {parseError && <ErrorCallout error={parseError} />}
            </Panel>
          </form>

          <Panel
            title="Result"
            subtitle={result?.label}
            actions={
              result && (
                <div className="row">
                  <Pill>{Object.keys(result.outputs ?? {}).length} outputs</Pill>
                  <Pill tone={result.halted ? "danger" : "success"} dot>
                    {result.halted ? "Halted" : "Completed"}
                  </Pill>
                </div>
              )
            }
          >
            {run.error ? (
              <ErrorCallout error={run.error} />
            ) : run.busy ? (
              <Empty title="Running…">
                Agents are working. A run can take a while when several agents call models in turn.
              </Empty>
            ) : result ? (
              <Results result={result} />
            ) : (
              <Empty title="No run yet">Results appear here, one block per agent.</Empty>
            )}
          </Panel>
        </div>
      </div>

      <ActionBar note="Results are shown here only. Run history isn't saved yet.">
        <LinkButton href={paths.project(project.project_id, "compile")}>
          <Icon name="arrowLeft" />
          Compile
        </LinkButton>
      </ActionBar>
    </>
  );
}
