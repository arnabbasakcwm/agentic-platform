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
    (runId, after) => {
      watchRef.current?.abort();
      const controller = new AbortController();
      watchRef.current = controller;
      const update = (fn) =>
        setShown((current) =>
          current && current.id === runId
            ? { ...current, state: fn(current.state) }
            : current,
        );

      // Events already shown (single-agent runs stream the same events as full ones): a reopened run is built from its saved events.
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
    [projectId, refreshHistory],
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
          watch(run.id, run.events?.length ?? 0);
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
        watch(run.id, 0); // a fresh run: follow from its first event
      } catch (error) {
        setShown({ id: null, version, state: failRun(pending, error) });
      }
    },
    [plan, version, projectId, refreshHistory, watch],
  );

  // Ask the server to stop the shown run. The run ends there within seconds and the
  // stream being followed reports it (run_failed, RunStopped), so nothing changes here
  // until the server says so — apart from the button showing it was pressed.
  const [stopping, setStopping] = useState(null); // id of the run being stopped
  const [stopError, setStopError] = useState(null);
  const shownId = shown?.id ?? null;
  const stop = useCallback(async () => {
    if (!shownId) return;
    setStopping(shownId);
    setStopError(null);
    try {
      const { run } = await api.stopRun(projectId, shownId);
      if (run.status !== "running") {
        // Already over (it finished just now, or its process was gone): show it as saved.
        setShown((current) =>
          current?.id === run.id
            ? { ...current, state: stateFromRecord(plan, run) }
            : current,
        );
        refreshHistory();
      }
    } catch (error) {
      setStopError(error);
      setStopping(null);
    }
  }, [shownId, projectId, plan, refreshHistory]);

  const run = !plan ? null : shown ? shown.state : idleRun(plan);
  const isStopping = stopping != null && stopping === shownId && run?.status === "running";
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
    stop,
    stopping: isStopping,
    stopError: shownId && run?.status === "running" ? stopError : null,
  };
}
