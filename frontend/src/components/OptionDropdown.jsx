import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "./icons.jsx";

const MENU_HEIGHT = 380;

/**
 * A styled dropdown for choosing one option or several (`multiple`). Options are
 * `{ value, label, group?, hint? }`; groups become sticky headings. Searchable, keyboard
 * driven (arrows, Enter/Space, Home/End, Escape), and a multi menu stays open so several
 * can be ticked in one go. Single mode: `value` is a string and `onChange(value)`.
 * Multi mode: `value` is an array and `onChange(list)`. `emptyLabel` adds a first
 * single-mode choice with the value "".
 */
export function OptionDropdown({
  options,
  value,
  onChange,
  multiple = false,
  label,
  placeholder = "Choose…",
  emptyLabel,
  searchPlaceholder = "Search",
  disabled = false,
  className,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(null);
  const [up, setUp] = useState(false);
  const id = useId();
  const wrapRef = useRef(null);
  const buttonRef = useRef(null);
  const inputRef = useRef(null);

  const picked = multiple ? value : [value];
  const isOn = (v) => picked.includes(v);
  const q = query.trim().toLowerCase();

  const rows = useMemo(() => {
    const list = [];
    if (emptyLabel && !multiple && !q) list.push({ value: "", label: emptyLabel, empty: true });
    for (const o of options) {
      if (!q || `${o.label} ${o.group ?? ""} ${o.value}`.toLowerCase().includes(q)) list.push(o);
    }
    return list;
  }, [options, q, emptyLabel, multiple]);

  const selected = options.filter((o) => isOn(o.value));
  const optionId = (v) => `${id}-o-${v.replace(/[^A-Za-z0-9_-]/g, "-") || "none"}`;

  function openMenu() {
    const rect = buttonRef.current.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom;
    setUp(below < MENU_HEIGHT && rect.top > below);
    setQuery("");
    setActive(multiple ? (options[0]?.value ?? null) : (value ?? null));
    setOpen(true);
  }

  function close(focusButton = true) {
    setOpen(false);
    if (focusButton) buttonRef.current?.focus();
  }

  function choose(v) {
    if (multiple) {
      onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
    } else {
      onChange(v);
      close();
    }
  }

  useEffect(() => {
    if (!open) return undefined;
    inputRef.current?.focus();
    const onDown = (e) => wrapRef.current && !wrapRef.current.contains(e.target) && setOpen(false);
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open && active !== null) document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);

  function onKey(e) {
    const at = rows.findIndex((r) => r.value === active);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!rows.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive(rows[(at + step + rows.length) % rows.length].value);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      if (rows.length) setActive(rows[e.key === "Home" ? 0 : rows.length - 1].value);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active !== null && rows.some((r) => r.value === active)) choose(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      close(false);
    }
  }

  let summary;
  if (multiple) {
    summary =
      selected.length === 0 ? (
        <span className="odrop__placeholder">{placeholder}</span>
      ) : (
        <span className="odrop__count">
          {selected.length} selected
        </span>
      );
  } else {
    const one = selected[0];
    summary = one ? (
      <span className="odrop__text">{one.label}</span>
    ) : value === "" && emptyLabel ? (
      <span className="odrop__text">{emptyLabel}</span>
    ) : (
      <span className="odrop__placeholder">{placeholder}</span>
    );
  }

  let lastGroup;
  return (
    <div className={["odrop", className].filter(Boolean).join(" ")} ref={wrapRef}>
      <button
        type="button"
        ref={buttonRef}
        className="odrop__button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            openMenu();
          }
        }}
      >
        {summary}
        <Icon name="chevronDown" size={16} />
      </button>

      {open && (
        <div className={["odrop__menu", up && "odrop__menu--up"].filter(Boolean).join(" ")}>
          <div className="odrop__search">
            <Icon name="search" size={14} />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={`${id}-list`}
              aria-autocomplete="list"
              aria-activedescendant={active !== null ? optionId(active) : undefined}
              aria-label={`Search ${label ?? "options"}`}
              placeholder={searchPlaceholder}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(null);
              }}
              onKeyDown={onKey}
            />
            {multiple && options.length > 0 && (
              <button
                type="button"
                className="odrop__bulk"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onChange(selected.length === options.length ? [] : options.map((o) => o.value))}
              >
                {selected.length === options.length ? "Clear all" : "Select all"}
              </button>
            )}
          </div>
          <div
            className="odrop__list"
            role="listbox"
            id={`${id}-list`}
            aria-label={label}
            aria-multiselectable={multiple || undefined}
            onMouseDown={(e) => e.preventDefault()}
          >
            {rows.map((r) => {
              const on = isOn(r.value);
              const heading = r.group && r.group !== lastGroup ? r.group : null;
              lastGroup = r.group;
              return (
                <div key={r.value || "__empty"}>
                  {heading && <div className="odrop__heading">{heading}</div>}
                  <div
                    role="option"
                    id={optionId(r.value)}
                    aria-selected={on}
                    className={[
                      "odrop__option",
                      r.value === active && "odrop__option--active",
                      on && "odrop__option--on",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onMouseEnter={() => setActive(r.value)}
                    onClick={() => choose(r.value)}
                  >
                    {multiple && (
                      <span className="odrop__box" aria-hidden="true">
                        {on && <Icon name="check" size={12} />}
                      </span>
                    )}
                    <span className="odrop__label">{r.label}</span>
                    {r.hint && <span className="odrop__hint">{r.hint}</span>}
                    {!multiple && on && <Icon name="check" size={14} />}
                  </div>
                </div>
              );
            })}
            {rows.length === 0 && <div className="odrop__empty">Nothing matches “{query.trim()}”</div>}
          </div>
        </div>
      )}
    </div>
  );
}
