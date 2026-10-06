import { useEffect, useId, useRef, useState } from "react";
import {
  filterSections,
  modelKey,
  modelName,
  modelSections,
  modelVendor,
  pickerLabel,
  scopeLabel,
} from "../lib/models.js";
import { Icon } from "./icons.jsx";

const MENU_HEIGHT = 380;
const MENU_WIDTH = 360;
const domId = (base, key) =>
  `${base}-${key.replace(/[^A-Za-z0-9_-]/g, "-") || "none"}`;

/**
 * A searchable model menu: the platform's models, then the Amazon Bedrock models this
 * account can use, grouped by vendor with where each one runs. `value` and onChange use
 * "provider/model" keys; `emptyLabel` adds a first choice with the key "" (e.g. "Platform
 * default"). Keyboard: arrows move, Enter picks, Escape closes; typing filters.
 */
export function ModelPicker({
  value,
  options,
  onChange,
  label,
  emptyLabel,
  placeholder = "Choose a model",
  isDisabled = (o) => o.available === false,
  disabled = false,
  className,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(null);
  const [place, setPlace] = useState({ up: false, right: false });
  const id = useId();
  const wrapRef = useRef(null);
  const buttonRef = useRef(null);
  const inputRef = useRef(null);

  const sections = modelSections(options);
  const visible = filterSections(sections, query);
  const showEmpty = Boolean(emptyLabel) && !query.trim();
  const keysFor = (q) => [
    ...(emptyLabel && !q.trim() ? [""] : []),
    ...filterSections(sections, q).flatMap((s) =>
      s.options.filter((o) => !isDisabled(o)).map(modelKey),
    ),
  ];

  const selected = options.find((o) => modelKey(o) === value);
  const current = selected
    ? pickerLabel(selected)
    : value === "" && emptyLabel
      ? emptyLabel
      : value || placeholder;

  function openMenu() {
    const rect = buttonRef.current.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom;
    setPlace({
      up: below < MENU_HEIGHT && rect.top > below,
      right: rect.left + MENU_WIDTH > window.innerWidth - 8,
    });
    setQuery("");
    const keys = keysFor("");
    setActive(keys.includes(value) ? value : (keys[0] ?? null));
    setOpen(true);
  }

  function close(focusButton = true) {
    setOpen(false);
    if (focusButton) buttonRef.current?.focus();
  }

  function choose(key) {
    onChange(key);
    close();
  }

  // Search box gets focus on open; a click elsewhere closes the menu.
  useEffect(() => {
    if (!open) return undefined;
    inputRef.current?.focus();
    const onClick = (e) =>
      wrapRef.current && !wrapRef.current.contains(e.target) && setOpen(false);
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  // Keep the highlighted option in view while moving with the keyboard.
  useEffect(() => {
    if (open && active !== null)
      document
        .getElementById(domId(id, active))
        ?.scrollIntoView({ block: "nearest" });
  }, [open, active, id]);

  function onKey(e) {
    const keys = keysFor(query);
    const at = keys.indexOf(active);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (keys.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive(keys[(at + step + keys.length) % keys.length]);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive(e.key === "Home" ? keys[0] : keys[keys.length - 1]);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active !== null && keys.includes(active)) choose(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      close(false);
    }
  }

  function search(text) {
    setQuery(text);
    setActive(keysFor(text)[0] ?? null);
  }

  const listId = `${id}-list`;
  const labelId = `${id}-label`;
  const valueId = `${id}-value`;

  const optionProps = (key, off) => ({
    role: "option",
    id: domId(id, key),
    "aria-selected": key === value,
    "aria-disabled": off || undefined,
    className: [
      "mpick__option",
      key === active && "mpick__option--active",
      key === value && "mpick__option--selected",
      off && "mpick__option--disabled",
    ]
      .filter(Boolean)
      .join(" "),
    "data-key": key,
    "data-off": off || undefined,
    onMouseEnter: () => !off && setActive(key),
  });

  // One click handler for every option (each carries its key).
  function pick(e) {
    const option = e.target.closest("[data-key]");
    if (option && !option.dataset.off) choose(option.dataset.key);
  }

  return (
    <div
      className={["mpick", className].filter(Boolean).join(" ")}
      ref={wrapRef}
    >
      {label && (
        <span id={labelId} className="sr-only">
          {label}
        </span>
      )}
      <button
        type="button"
        ref={buttonRef}
        className="mpick__button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={label ? `${labelId} ${valueId}` : undefined}
        disabled={disabled}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            openMenu();
          }
        }}
      >
        <span
          id={valueId}
          className={[
            "mpick__value",
            !selected && !value && !emptyLabel && "mpick__value--placeholder",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {current}
        </span>
        <Icon name="chevronDown" size={14} />
      </button>

      {open && (
        <div
          className={[
            "mpick__menu",
            place.up && "mpick__menu--up",
            place.right && "mpick__menu--right",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <div className="mpick__search">
            <Icon name="search" size={14} />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={
                active !== null ? domId(id, active) : undefined
              }
              aria-label={`Search ${label ? label.toLowerCase() : "models"}`}
              placeholder="Search models, vendors, regions"
              value={query}
              onChange={(e) => search(e.target.value)}
              onKeyDown={onKey}
            />
          </div>
          <div
            className="mpick__list"
            role="listbox"
            id={listId}
            aria-label={label ?? "Models"}
            // Keep focus in the search box, so the menu doesn't close before the click lands.
            onMouseDown={(e) => e.preventDefault()}
            onClick={pick}
          >
            {showEmpty && (
              <div {...optionProps("", false)}>
                <span className="mpick__name">{emptyLabel}</span>
                <span className="mpick__tags">
                  {value === "" && <Icon name="check" size={13} />}
                </span>
              </div>
            )}
            {visible.map((section) => (
              <div
                key={section.id}
                role="group"
                aria-labelledby={`${id}-${section.id}`}
              >
                <div className="mpick__heading" id={`${id}-${section.id}`}>
                  {section.title}
                </div>
                {section.options.map((o) => {
                  const key = modelKey(o);
                  const off = isDisabled(o);
                  const scope = scopeLabel(o);
                  return (
                    <div key={key} {...optionProps(key, off)} title={o.model}>
                      <span className="mpick__name">{modelName(o)}</span>
                      {!section.id.startsWith("vendor-") && (
                        <span className="mpick__meta">{modelVendor(o)}</span>
                      )}
                      <span className="mpick__tags">
                        {o.default && (
                          <span className="mpick__tag">Default</span>
                        )}
                        {scope && <span className="mpick__tag">{scope}</span>}
                        {off && (
                          <span className="mpick__tag mpick__tag--warn">
                            No API key
                          </span>
                        )}
                        {key === value && <Icon name="check" size={13} />}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
            {visible.length === 0 && !showEmpty && (
              <div className="mpick__empty">
                No models match “{query.trim()}”
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
