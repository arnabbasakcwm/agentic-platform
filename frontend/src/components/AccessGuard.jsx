import { canEditProject, canManageProject, canRunProject } from "../lib/access.js";
import { Callout } from "./ui.jsx";

const CHECKS = { manage: canManageProject, edit: canEditProject, use: canRunProject };
const WHO = {
  manage: "Only the project's owner, or an admin of its team, can",
  edit: "You need Edit access to",
  use: "You need Use access to",
};

function NoAccess({ level, what, restricted }) {
  return (
    <div className="page">
      <Callout tone="info" title="Not available with your access">
        {restricted
          ? "This project is shared with you one agent at a time, so only its agents' configuration is shown."
          : `${WHO[level]} ${what}. Ask the project's owner if you need it.`}
      </Callout>
    </div>
  );
}

/**
 * A project step that needs more access than the person has is replaced by a plain explanation, so
 * they aren't offered buttons that will only be refused. The API checks every request again; this
 * only keeps the console honest about what is on offer.
 */
export function requireAccess(level, Step, what) {
  function Guarded(props) {
    const { project } = props;
    // A project shared agent by agent has no whole plan to run, compile or edit.
    const restricted = Boolean(project?.restricted);
    if (!CHECKS[level](project) || restricted) return <NoAccess level={level} what={what} restricted={restricted} />;
    return <Step {...props} />;
  }
  Guarded.displayName = `Guarded(${Step.displayName ?? Step.name ?? "Step"})`;
  return Guarded;
}
