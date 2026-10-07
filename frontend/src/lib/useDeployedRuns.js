import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";

const POLL_MS = 2000;

/**
 * Try-it runs on a project's deployment, saved on the server: the run shown (latest by
 * default), the last few, and `start`. A run in flight keeps going on the server when you
 * leave the page; coming back shows it, still running or finished.
 */
export function useDeployedRuns(projectId) {
  const [runs, setRuns] = useState([]);
  const [shown, setShown] = useState(null); // full RunRecord
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const { runs: list } = await api.listRuns(projectId, "deployed");
      setRuns(list);
      return list;
    } catch {
      return null;
    }
  }, [projectId]);

  const poll = useCallback(
    (runId) => {
      clearTimeout(pollRef.current);
      const tick = async () => {
        try {
          const { run } = await api.getRun(projectId, runId);
          setShown((current) =>
            current && current.id !== runId ? current : run,
          );
          if (run.status === "running") {
            pollRef.current = setTimeout(tick, POLL_MS);
            return;
          }
          refresh();
        } catch {
          pollRef.current = setTimeout(tick, POLL_MS);
        }
      };
      pollRef.current = setTimeout(tick, POLL_MS);
    },
    [projectId, refresh],
  );

  const open = useCallback(
    async (runId) => {
      clearTimeout(pollRef.current);
      setError(null);
      try {
        const { run } = await api.getRun(projectId, runId);
        setShown(run);
        if (run.status === "running") poll(run.id);
      } catch (e) {
        setError(e);
      }
    },
    [projectId, poll],
  );

  useEffect(() => {
    let current = true;
    api
      .listRuns(projectId, "deployed")
      .then(({ runs: list }) => {
        if (!current) return;
        setRuns(list);
        if (list.length) open(list[0].id);
      })
      .catch(() => {});
    return () => {
      current = false;
      clearTimeout(pollRef.current);
    };
  }, [projectId, open]);

  const start = useCallback(
    async (input) => {
      setError(null);
      try {
        const { run } = await api.startDeployedRun(projectId, input);
        setShown(run);
        refresh();
        poll(run.id);
      } catch (e) {
        setError(e);
      }
    },
    [projectId, refresh, poll],
  );

  return {
    runs,
    shown,
    error,
    open,
    start,
    running: shown?.status === "running",
  };
}
