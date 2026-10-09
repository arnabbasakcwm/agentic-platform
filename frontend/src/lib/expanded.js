import { useCallback, useMemo, useState } from "react";

// Which items of a library page (data sources, MCP servers) are expanded. Remembered per
// browser; a convenience only, so a blocked or empty storage just means the defaults.

/**
 * The ids to start expanded: what was stored (ids that still exist), else a lone item,
 * else only the items that need attention. `stored` is null when nothing was saved.
 */
export function initialExpanded(stored, ids, attention = []) {
  if (Array.isArray(stored)) return ids.filter((id) => stored.includes(id));
  if (ids.length === 1) return [...ids];
  return ids.filter((id) => attention.includes(id));
}

export function readStored(key) {
  try {
    const raw = localStorage.getItem(key);
    const value = raw ? JSON.parse(raw) : null;
    return Array.isArray(value) ? value.filter((v) => typeof v === "string") : null;
  } catch {
    return null;
  }
}

function writeStored(key, ids) {
  try {
    localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    // Not remembered across visits; the page still works.
  }
}

/**
 * Expanded state for a list of items. `ids` are the items shown, `attention` the ones
 * that start open on a first visit. Until the user expands or collapses something, the
 * open set follows initialExpanded(); from then on it is theirs, and remembered.
 */
export function useExpanded(storageKey, ids, attention) {
  const [chosen, setChosen] = useState(null);
  const idsKey = ids.join("|");
  const attentionKey = attention.join("|");
  const openIds = useMemo(
    () => chosen ?? initialExpanded(readStored(storageKey), ids, attention),
    // ids and attention are captured through their keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chosen, storageKey, idsKey, attentionKey],
  );

  const update = useCallback(
    (fn) => {
      const next = fn(openIds);
      writeStored(storageKey, next);
      setChosen(next);
    },
    [openIds, storageKey],
  );

  return useMemo(
    () => ({
      isOpen: (id) => openIds.includes(id),
      toggle: (id) =>
        update((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id])),
      open: (id) => update((cur) => (cur.includes(id) ? cur : [...cur, id])),
      expandAll: () => update(() => [...ids]),
      collapseAll: () => update(() => []),
      openCount: openIds.filter((id) => ids.includes(id)).length,
    }),
    // ids is captured through idsKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [openIds, update, idsKey],
  );
}
