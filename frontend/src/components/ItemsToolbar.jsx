import { Icon } from "./icons.jsx";
import { Button } from "./ui.jsx";

const FILTER_FROM = 4; // the filter box appears once there are this many items

/** Above a library list: how many items, a filter, and expand / collapse all. */
export function ItemsToolbar({
  count,
  noun,
  filter,
  onFilter,
  shown,
  allOpen,
  noneOpen,
  onExpandAll,
  onCollapseAll,
}) {
  if (count < 2) return null;
  const plural = `${noun}${count === 1 ? "" : "s"}`;
  return (
    <div className="itemstoolbar">
      <span className="itemstoolbar__count muted" role="status">
        {filter && shown !== count ? `${shown} of ${count} ${plural}` : `${count} ${plural}`}
      </span>
      {count >= FILTER_FROM && (
        <label className="itemstoolbar__filter">
          <Icon name="search" size={14} />
          <span className="sr-only">Filter {noun}s</span>
          <input
            type="text"
            value={filter}
            onChange={(e) => onFilter(e.target.value)}
            placeholder={`Filter ${noun}s`}
          />
        </label>
      )}
      <div className="itemstoolbar__spacer" />
      <Button size="sm" onClick={onExpandAll} disabled={allOpen}>
        Expand all
      </Button>
      <Button size="sm" onClick={onCollapseAll} disabled={noneOpen}>
        Collapse all
      </Button>
    </div>
  );
}

/** Whether an item matches the filter text (name or summary, any case). */
export function matchesFilter(filter, ...texts) {
  const q = filter.trim().toLowerCase();
  return !q || texts.some((t) => (t ?? "").toLowerCase().includes(q));
}
