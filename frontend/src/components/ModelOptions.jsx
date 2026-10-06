import { modelLabel } from "../lib/usage.js";

/**
 * <option>s for a model <select>: the platform's models first, then each group (e.g. the
 * Amazon Bedrock models this AWS account can use) under its own <optgroup>. `options` are
 * /providers entries; values are "provider/model".
 */
export function ModelOptions({ options, isDisabled = () => false }) {
  const plain = options.filter((o) => !o.group);
  const groups = [...new Set(options.filter((o) => o.group).map((o) => o.group))];
  const option = (o) => {
    const key = `${o.provider}/${o.model}`;
    return (
      <option key={key} value={key} disabled={isDisabled(o)}>
        {modelLabel(o)}
        {o.available === false ? " (no API key)" : ""}
      </option>
    );
  };
  return (
    <>
      {plain.map(option)}
      {groups.map((group) => (
        <optgroup key={group} label={group}>
          {options.filter((o) => o.group === group).map(option)}
        </optgroup>
      ))}
    </>
  );
}
