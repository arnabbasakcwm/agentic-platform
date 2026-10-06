import { useCallback, useState } from "react";
import { api } from "./api.js";
import { modelKey, needsCheck } from "./models.js";

/**
 * Check, once, whether a chosen model can call tools (the server makes one tiny test call
 * the first time anyone picks it). Verdicts are kept for this page; `checking` is the model
 * key being checked, if any.
 */
export function useToolCheck() {
  const [verdicts, setVerdicts] = useState({});
  const [checking, setChecking] = useState(null);

  const check = useCallback(async (option) => {
    if (!option || !needsCheck(option)) return option?.tool_calling ?? null;
    const key = modelKey(option);
    setChecking(key);
    try {
      const res = await api.checkModel(option.provider, option.model);
      setVerdicts((v) => ({ ...v, [key]: res.tool_calling }));
      return res.tool_calling;
    } catch {
      return null; // inconclusive: the server checks again when the plan is saved
    } finally {
      setChecking(null);
    }
  }, []);

  return { verdicts, checking, check };
}
