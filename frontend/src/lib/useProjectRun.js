import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { applyEvent, failRun, finishAgentRun, idleRun, startRun } from "./runState.js";

/** The input a project's Run page starts with: its plan's example, or an empty request. */
export function defaultInput(plan) {
  const example = plan?.example_input;
  return example && Object.keys(example).length > 0 ? example : { request: "" };
}

/**
 * A project's run and its draft input, owned by the project workspace rather than the
 * Run page: a run keeps streaming while you look at other steps, and the input box keeps
 * what you typed. A run belongs to the plan version it ran; once the plan changes, the
 * page starts from an idle run of the new plan.
 */
export function useProjectRun(project) {
  const plan = project?.plan;
  const version = project?.plan_version;
  const projectId = project?.project_id;

  const [box, setBox] = useState(null); // { version, state }
  const [draft, setDraft] = useState(null);
  const abortRef = useRef(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const run = !plan ? null : box && box.version === version ? box.state : idleRun(plan);
  const draftInput = draft ?? (plan ? JSON.stringify(defaultInput(plan), null, 2) : "");

  const start = useCallback(
    async ({ input, mode = "graph", agentId = null }) => {
      if (!plan) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const update = (fn) =>
        setBox((current) => ({
          version,
          state: fn(current && current.version === version ? current.state : idleRun(plan)),
        }));
      update(() => startRun(plan, { input, mode, agentId }));

      if (mode === "agent") {
        const startedMs = Date.now();
        try {
          const res = await api.invokeAgent(projectId, agentId, input);
          update((s) => finishAgentRun(s, agentId, { startedMs, endedMs: Date.now(), result: res.result }));
        } catch (error) {
          update((s) => failRun(s, error));
        }
        return;
      }

      let finished = false;
      try {
        await api.runStream(
          projectId,
          input,
          ({ event, data }) => {
            if (event === "run_completed" || event === "run_failed") finished = true;
            update((s) => applyEvent(s, { event, data: { ...data, receivedAt: Date.now() } }));
          },
          controller.signal,
        );
        if (!finished) {
          update((s) =>
            failRun(s, {
              errorType: "ConnectionLost",
              message: "The connection to the server closed before the run finished.",
            }),
          );
        }
      } catch (error) {
        if (error?.name === "AbortError") return;
        update((s) => failRun(s, error));
      }
    },
    [plan, version, projectId],
  );

  return { run, draftInput, setDraftInput: setDraft, start };
}
