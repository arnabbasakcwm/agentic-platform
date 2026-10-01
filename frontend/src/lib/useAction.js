import { useCallback, useState } from "react";

// Wraps one kind of request a page makes: tracks whether it is in flight and the last
// error, and resolves to null (rather than throwing) when the request fails.
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const run = useCallback(async (fn) => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e);
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  return { busy, error, run };
}
