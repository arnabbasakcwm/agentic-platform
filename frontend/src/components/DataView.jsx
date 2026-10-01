import { formatValue, humanizeKey } from "../lib/format.js";
import { JsonView } from "./JsonView.jsx";

const MAX_DEPTH = 3;
const MAX_COLUMNS = 8;

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function Value({ name, value, depth }) {
  if (Array.isArray(value)) return <ArrayValue name={name} items={value} depth={depth} />;
  if (isPlainObject(value)) {
    if (depth >= MAX_DEPTH) return <code className="data__inline">{JSON.stringify(value)}</code>;
    return <Fields value={value} depth={depth + 1} />;
  }
  return <span className="data__value">{formatValue(name, value)}</span>;
}

function ArrayValue({ name, items, depth }) {
  if (items.length === 0) return <span className="data__value muted">None</span>;
  // A list of records reads best as a table: one row per item, one column per field.
  if (items.every(isPlainObject)) {
    const columns = [...new Set(items.flatMap((item) => Object.keys(item)))].slice(0, MAX_COLUMNS);
    return (
      <div className="data__table" tabIndex={0} role="region" aria-label={humanizeKey(name)}>
        <table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c} scope="col">
                  {humanizeKey(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c}>
                    {isPlainObject(item[c]) || Array.isArray(item[c]) ? (
                      <code className="data__inline">{JSON.stringify(item[c])}</code>
                    ) : (
                      formatValue(c, item[c])
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <ul className="data__list">
      {items.map((item, i) => (
        <li key={i}>
          <Value name={name} value={item} depth={depth} />
        </li>
      ))}
    </ul>
  );
}

function Fields({ value, depth }) {
  return (
    <dl className="data__fields">
      {Object.entries(value).map(([key, v]) => (
        <div key={key} className="data__row">
          <dt>{humanizeKey(key)}</dt>
          <dd>
            <Value name={key} value={v} depth={depth} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Structured agent data as a readable card, with the raw JSON one click away. */
export function DataView({ data }) {
  if (!isPlainObject(data) || Object.keys(data).length === 0) return null;
  return (
    <section className="data" aria-label="Structured data">
      <h4 className="data__title">Structured data</h4>
      <Fields value={data} depth={0} />
      <details className="data__raw">
        <summary>View raw JSON</summary>
        <JsonView value={data} />
      </details>
    </section>
  );
}
