import { useEffect, useState } from "react";
import { Icon } from "../../components/icons.jsx";
import {
  ActionBar,
  Button,
  Callout,
  Empty,
  ErrorCallout,
  Field,
  LinkButton,
  MetaList,
  Panel,
  Pill,
} from "../../components/ui.jsx";
import { API_URL, api } from "../../lib/api.js";
import { fullDate } from "../../lib/format.js";
import { paths } from "../../lib/router.js";
import { useAction } from "../../lib/useAction.js";
import { ResultOutputs } from "../../components/ResultOutputs.jsx";
import { UsageLine } from "../../components/UsageLine.jsx";

const POLL_MS = 3000;
const PROGRESS = [
  ["packaging", "Packaging", "Bundling the plan, the runtime and its dependencies"],
  ["uploading", "Uploading", "Sending the package to S3"],
  ["provisioning", "Provisioning", "Creating the AgentCore runtime and waiting for it to start"],
];
const SAMPLE = '{\n  "question": "What is the speed of light?"\n}';

function Progress({ status }) {
  const current = PROGRESS.findIndex(([key]) => key === status);
  return (
    <ol className="progress">
      {PROGRESS.map(([key, label, detail], i) => {
        const state = i < current ? "done" : i === current ? "current" : "todo";
        return (
          <li key={key} className={`progress__item progress__item--${state}`}>
            <span className="progress__mark">
              {state === "done" ? (
                <Icon name="check" size={12} />
              ) : state === "current" ? (
                <span className="spin" />
              ) : (
                i + 1
              )}
            </span>
            <span>
              <span className="progress__label">{label}</span>
              <span className="progress__detail">{detail}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function SetupHelp({ region }) {
  return (
    <Callout tone="warn" title="Deployment isn't set up on this server">
      <p>The API found no AWS credentials. To enable deploying:</p>
      <ol className="steps-list" style={{ marginTop: 6 }}>
        <li>
          Install the AWS CLI and run <code>aws configure</code> (or <code>aws sso login</code>) for
          an account that can use Amazon Bedrock AgentCore, S3 and IAM.
        </li>
        <li>
          Deployments go to <code>{region}</code>; set <code>AGENTCORE_REGION</code> in{" "}
          <code>backend/.env</code> to change it.
        </li>
        <li>Restart the API, then reload this page.</li>
      </ol>
    </Callout>
  );
}

function StatusPanel({ project, deployment, available, onDeploy, onRemove, deploying, removing }) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const canDeploy = available && project.compiled && !deployment?.in_progress;

  const deployButton = (label) => (
    <Button variant="primary" onClick={onDeploy} loading={deploying} disabled={!canDeploy}>
      {!deploying && <Icon name="arrowUp" size={14} />}
      {label}
    </Button>
  );

  let body;
  if (!deployment) {
    body = (
      <>
        <p className="muted">
          Deploying puts this compiled plan on Amazon Bedrock AgentCore Runtime as its own managed
          runtime, callable from your apps. Deploying takes a few minutes.
        </p>
        {!project.compiled && (
          <Callout tone="warn" title="Not compiled">
            Compile the current plan before deploying it.{" "}
            <a href={paths.project(project.project_id, "compile")}>Go to Compile</a>
          </Callout>
        )}
        <div className="row">{deployButton("Deploy to AgentCore")}</div>
      </>
    );
  } else if (deployment.in_progress) {
    body = (
      <>
        <Progress status={deployment.status} />
        <p className="muted">
          This takes a few minutes and keeps going if you leave the page.
          {deployment.live && ` Plan v${deployment.live_plan_version} keeps serving until the new version is ready.`}
        </p>
      </>
    );
  } else {
    body = (
      <>
        {deployment.status === "failed" && (
          <Callout tone="danger" title="The last deployment failed">
            {deployment.error}
            {deployment.live && (
              <div style={{ marginTop: 6 }}>Plan v{deployment.live_plan_version} is still live.</div>
            )}
          </Callout>
        )}
        {deployment.outdated && (
          <Callout tone="warn" title="Live version is out of date">
            The live runtime serves plan v{deployment.live_plan_version}; the project is now at v
            {project.plan_version}. Compile and redeploy to publish the changes.
          </Callout>
        )}
        {deployment.live && (
          <MetaList
            rows={[
              ["Region", <span key="Region" className="mono">{deployment.region}</span>],
              ["Plan version", <span key="Plan version" className="mono">v{deployment.live_plan_version}</span>],
              ["Deployed", deployment.deployed_at ? fullDate(deployment.deployed_at) : null],
              ["Runtime ARN", <span key="Runtime ARN" className="mono">{deployment.runtime_arn}</span>],
            ]}
          />
        )}
        <div className="row">
          {deployButton(deployment.status === "failed" ? "Try again" : "Redeploy")}
          {confirmRemove ? (
            <>
              <Button onClick={onRemove} loading={removing}>
                Yes, remove it
              </Button>
              <Button onClick={() => setConfirmRemove(false)} disabled={removing}>
                Keep it
              </Button>
            </>
          ) : (
            <Button onClick={() => setConfirmRemove(true)} disabled={!available}>
              Remove deployment
            </Button>
          )}
        </div>
        {confirmRemove && (
          <p className="field__hint">
            Removing deletes the AgentCore runtime and its code packages. Apps calling it will stop
            working.
          </p>
        )}
      </>
    );
  }

  const pill = !deployment ? (
    <Pill dot>Not deployed</Pill>
  ) : deployment.in_progress ? (
    <Pill tone="accent" dot>
      Deploying
    </Pill>
  ) : deployment.live ? (
    <Pill tone={deployment.outdated ? "warn" : "success"} dot>
      {deployment.outdated ? "Live · outdated" : "Live"}
    </Pill>
  ) : (
    <Pill tone="danger" dot>
      Failed
    </Pill>
  );

  return (
    <Panel title="Deployment" subtitle="Amazon Bedrock AgentCore Runtime" actions={pill}>
      <div className="stack">{body}</div>
    </Panel>
  );
}

function TryIt({ project }) {
  const [input, setInput] = useState(SAMPLE);
  const [parseError, setParseError] = useState(null);
  const [result, setResult] = useState(null);
  const run = useAction();

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
    setResult(null);
    const res = await run.run(() => api.invokeDeployment(project.project_id, parsed));
    if (res) setResult(res);
  }

  return (
    <form onSubmit={execute}>
      <Panel
        title="Try the live deployment"
        subtitle="Runs on AgentCore, not on this server."
        footer={
          <Button type="submit" variant="primary" loading={run.busy}>
            {!run.busy && <Icon name="play" size={14} />}
            {run.busy ? "Running…" : "Run on AgentCore"}
          </Button>
        }
      >
        <Field label="Task input (JSON)">
          <textarea
            className="mono"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            style={{ minHeight: 120 }}
            spellCheck={false}
          />
        </Field>
        {parseError && <ErrorCallout error={parseError} />}
        {run.error && <ErrorCallout error={run.error} />}
        {result && (
          <div style={{ marginTop: 12 }}>
            <UsageLine usage={result.usage} />
            <ResultOutputs plan={project.plan} result={result} />
          </div>
        )}
      </Panel>
    </form>
  );
}

function CallIt({ project, deployment }) {
  const curl = `curl -X POST ${API_URL}/projects/${project.project_id}/deployment/invoke \\
  -H "Authorization: Bearer <your token>" \\
  -H "Content-Type: application/json" \\
  -d '{"input": {"question": "..."}}'`;
  const boto = `import boto3, json, uuid
client = boto3.client("bedrock-agentcore", region_name="${deployment.region}")
response = client.invoke_agent_runtime(
    agentRuntimeArn="${deployment.runtime_arn}",
    runtimeSessionId=uuid.uuid4().hex + uuid.uuid4().hex,
    payload=json.dumps({"input": {"question": "..."}}),
)
print(json.loads(response["response"].read()))`;
  return (
    <Panel title="Call it from your app">
      <p className="muted" style={{ marginBottom: 8 }}>
        Through this platform, with a signed-in user's token. Same input and output as Run:
      </p>
      <pre className="codeblock">{curl}</pre>
      <p className="muted" style={{ margin: "12px 0 8px" }}>
        Or directly through AWS, with IAM credentials allowed to invoke the runtime:
      </p>
      <pre className="codeblock">{boto}</pre>
    </Panel>
  );
}

export function DeployStep({ project, onDeploymentChanged }) {
  const [info, setInfo] = useState(null); // { available, region }
  const deployment = project.deployment;
  const load = useAction();
  const deploy = useAction();
  const remove = useAction();

  useEffect(() => {
    load.run(() => api.getDeployment(project.project_id)).then((res) => {
      if (!res) return;
      setInfo({ available: res.available, region: res.region });
      onDeploymentChanged(res.deployment);
    });
    // Only on arrival; polling below keeps it fresh while a deployment runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.project_id]);

  // While a deployment runs, poll its status until it settles.
  const inProgress = Boolean(deployment?.in_progress);
  useEffect(() => {
    if (!inProgress) return undefined;
    const timer = setInterval(async () => {
      try {
        const res = await api.getDeployment(project.project_id);
        onDeploymentChanged(res.deployment);
      } catch {
        // A missed poll is retried on the next tick.
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [inProgress, project.project_id, onDeploymentChanged]);

  async function startDeploy() {
    const res = await deploy.run(() => api.deploy(project.project_id));
    if (res) onDeploymentChanged(res.deployment);
  }

  async function removeDeployment() {
    const res = await remove.run(() => api.removeDeployment(project.project_id));
    if (res) onDeploymentChanged(null);
  }

  if (!info) {
    return (
      <div className="page">
        <Panel>{load.error ? <ErrorCallout error={load.error} /> : <Empty>Loading deployment…</Empty>}</Panel>
      </div>
    );
  }

  return (
    <>
      <div className="page">
        <div className="split split--even">
          <div className="stack">
            {!info.available && <SetupHelp region={info.region} />}
            <StatusPanel
              project={project}
              deployment={deployment}
              available={info.available}
              onDeploy={startDeploy}
              onRemove={removeDeployment}
              deploying={deploy.busy}
              removing={remove.busy}
            />
            {(deploy.error || remove.error) && <ErrorCallout error={deploy.error || remove.error} />}
          </div>
          <div className="stack">
            {deployment?.live ? (
              <>
                <TryIt project={project} />
                <CallIt project={project} deployment={deployment} />
              </>
            ) : (
              <Panel title="Once it's live">
                <p className="muted">
                  You'll be able to try the deployed flow here, and get the snippets to call it
                  from your own apps — through this platform's API, or directly through AWS.
                </p>
              </Panel>
            )}
          </div>
        </div>
      </div>

      <ActionBar note="A deployment serves the plan version it was built from; plan changes need a compile and a redeploy.">
        <LinkButton href={paths.project(project.project_id, "run")}>
          <Icon name="arrowLeft" />
          Run
        </LinkButton>
      </ActionBar>
    </>
  );
}
