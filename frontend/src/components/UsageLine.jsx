import { paths } from "../lib/router.js";
import { usageLine } from "../lib/usage.js";
import { Icon } from "./icons.jsx";

/** "12.3K tokens · ~$0.04" for a finished run, linking to the Usage page. */
export function UsageLine({ usage }) {
  const text = usageLine(usage);
  if (!text) return null;
  return (
    <div className="usageline">
      <Icon name="chart" size={14} />
      <span>{text}</span>
      <a href={paths.usage}>Usage</a>
    </div>
  );
}
