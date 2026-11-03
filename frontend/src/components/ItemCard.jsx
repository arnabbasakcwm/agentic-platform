import { Icon } from "./icons.jsx";
import { SlidingThumb } from "./ui.jsx";

/**
 * One item on a library page (a data source, an MCP server): a one-line header that
 * expands it, then its parts as tabs. The header's actions sit outside the toggle, so
 * no button is nested in another.
 */
export function ItemCard({
  id,
  title,
  summary,
  status,
  actions,
  open,
  onToggle,
  tabs,
  tab,
  onTab,
  notice,
  children,
}) {
  const bodyId = `item-${id}-body`;
  const panelId = `item-${id}-panel`;
  const tabId = (key) => `item-${id}-tab-${key}`;
  return (
    <section
      className={open ? "itemcard itemcard--open" : "itemcard"}
      aria-label={title}
    >
      <header className="itemcard__head">
        <button
          type="button"
          className="itemcard__toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <span className="itemcard__chev">
            <Icon name="chevronRight" size={16} />
          </span>
          <span className="itemcard__text">
            <span className="itemcard__title">{title}</span>
            {summary && <span className="itemcard__summary">{summary}</span>}
          </span>
        </button>
        {status && <span className="itemcard__status">{status}</span>}
        {actions && <span className="itemcard__actions">{actions}</span>}
      </header>
      {open && (
        <div className="itemcard__body" id={bodyId}>
          {notice}
          <div
            className="segmented itemcard__tabs"
            role="tablist"
            aria-label={`${title}: sections`}
          >
            <SlidingThumb on={tab} />
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                id={tabId(t.key)}
                aria-controls={panelId}
                aria-selected={tab === t.key}
                className={
                  tab === t.key
                    ? "segmented__item segmented__item--on"
                    : "segmented__item"
                }
                onClick={() => onTab(t.key)}
              >
                {t.label}
                {t.count != null && <span className="count-chip">{t.count}</span>}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={panelId} aria-labelledby={tabId(tab)}>
            {children}
          </div>
        </div>
      )}
    </section>
  );
}
