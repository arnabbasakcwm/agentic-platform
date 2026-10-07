import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { stateFromRecord } from "./runReplay.js";
import { applyEvent, failRun, idleRun, startRun } from "./runState.js";

/** The input a project's Run page starts with: its plan's example, or an empty request. */
export function defaultInput(plan) {
  const example = plan?.example_input;
  return example && Object.keys(example).length > 0 ? example : { request: "" };
}

const RECONNECT_MS = 2000;
const POLL_MS = 1000;

/**
 * A project's runs, saved on the server: the run shown (the latest by default, or one
 * picked from the history), the last few runs, and the draft input. Runs execute on the
 * server, so leaving the page only stops watching: coming back — from another step,
 * another page, a refresh or another browser — reloads the run and, if it's still going,
 * follows it again. A run belongs to the plan version it ran on.
 */
export function useProjectRun(project) {
  const plan = project?.plan;
  const version = project?.plan_version;
  const projectId = project?.project_id;

  const [shown, setShown] = useState(null); // { id, version, state }
  const [history, setHistory] = useState([]);
  const [draft, setDraft] = useState(null);
  const watchRef = useRef(null); // AbortController of the run being watched

  const refreshHistory = useCallback(async () => {
    if (!projectId) return [];
    try {
      const { runs } = await api.listRuns(projectId, "local");
      setHistory(runs);
      return runs;
    } catch {
      return null; // the history list is a convenience; the run itself still shows
    }
  }, [projectId]);

  // Follow a running run: replay from `after`, then live events until it ends. A dropped
  // connection is resumed from where it left off.
  const watch = useCallback(
    (runId, record, after) => {
      watchRef.current?.abort();
      const controller = new AbortController();
      watchRef.current = controller;
      const update = (fn) =>
        setShown((current) =>
          current && current.id === runId
            ? { ...current, state: fn(current.state) }
            : current,
        );

      if (record.mode === "agent") {
        // One request on the server: poll until it's done.
        const poll = async () => {
          while (!controller.signal.aborted) {
            await new Promise((r) => setTimeout(r, POLL_MS));
            if (controller.signal.aborted) return;
            try {
              const { run } = await api.getRun(projectId, runId);
              if (run.status !== "running") {
                update(() => stateFromRecord(plan, run));
                refreshHistory();
                return;
              }
            } catch {
              // try again on the next tick
            }
          }
        };
        poll();
        return;
      }

      // Events already shown: a reopened run is built from its saved events.
      let received = after;
      const follow = async () => {
        while (!controller.signal.aborted) {
          let ended = false;
          try {
            await api.followRun(
              projectId,
              runId,
              received,
              ({ event, data }) => {
                received += 1;
                if (event === "run_completed" || event === "run_failed")
                  ended = true;
                update((s) =>
                  applyEvent(s, {
                    event,
                    data: { ...data, receivedAt: Date.now() },
                  }),
                );
              },
              controller.signal,
            );
          } catch (error) {
            if (error?.name === "AbortError") return;
            if (error?.status === 404) {
              update((s) => failRun(s, error));
              return;
            }
          }
          if (ended) {
            refreshHistory();
            return;
          }
          await new Promise((r) => setTimeout(r, RECONNECT_MS));
        }
      };
      follow();
    },
    [projectId, plan, refreshHistory],
  );

  /** Show a saved run (from the history list), following it if it's still going. */
  const open = useCallback(
    async (runId) => {
      if (!plan) return;
      watchRef.current?.abort();
      try {
        const { run } = await api.getRun(projectId, runId);
        setShown({
          id: run.id,
          version: run.plan_version,
          state: stateFromRecord(plan, run),
        });
        if (run.status === "running")
          watch(run.id, run, run.events?.length ?? 0);
      } catch (error) {
        setShown({ id: runId, version, state: failRun(idleRun(plan), error) });
      }
    },
    [plan, projectId, version, watch],
  );

  // On opening the project (or a new plan version): load the history and show the latest
  // run of this plan version.
  useEffect(() => {
    if (!projectId || !plan) return undefined;
    let current = true;
    refreshHistory().then((runs) => {
      const latest = runs?.find((r) => r.plan_version === version);
      if (current && latest) open(latest.id);
    });
    return () => {
      current = false;
    };
    // `open` and `refreshHistory` change with the project; the version is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, version]);

  // Leaving only stops watching; the run carries on, saved on the server.
  useEffect(() => () => watchRef.current?.abort(), []);

  const start = useCallback(
    async ({ input, mode = "graph", agentId = null }) => {
      if (!plan) return;
      watchRef.current?.abort();
      const pending = startRun(plan, { input, mode, agentId });
      setShown({ id: null, version, state: pending });
      try {
        const { run } = await api.startRun(projectId, { input, mode, agentId });
        setShown({ id: run.id, version: run.plan_version, state: pending });
        refreshHistory();
        watch(run.id, run, 0); // a fresh run: follow from its first event
      } catch (error) {
        setShown({ id: null, version, state: failRun(pending, error) });
      }
    },
    [plan, version, projectId, refreshHistory, watch],
  );

  const run = !plan ? null : shown ? shown.state : idleRun(plan);
  // The input box: what you typed, else the shown run's input, else the plan's example.
  const shownInput = shown?.state?.input;
  const draftInput =
    draft ??
    (shownInput
      ? JSON.stringify(shownInput, null, 2)
      : plan
        ? JSON.stringify(defaultInput(plan), null, 2)
        : "");

  return {
    run,
    runId: shown?.id ?? null,
    runVersion: shown?.version ?? null,
    history,
    open,
    draftInput,
    setDraftInput: setDraft,
    start,
  };
}
