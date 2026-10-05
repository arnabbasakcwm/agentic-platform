"""Counting deployed runs that were invoked straight through AWS.

A deployed runtime prints one usage line per invocation (runtime_app.log_usage), which
AgentCore ships to CloudWatch. This reads those lines for one deployment, skips runs the
platform already recorded (it records the runs it makes itself, under the same run id),
and stores the rest. It is idempotent: windows overlap on purpose, because log delivery
can lag, and a run id is only ever recorded once.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from . import usage as usage_mod
from .stores import ProjectRecord, ProjectStore, UsageRecord, UsageStore

logger = logging.getLogger(__name__)

# Re-read this much before the cursor: CloudWatch can deliver a line minutes late.
OVERLAP = timedelta(minutes=10)


@dataclass
class SyncResult:
    project_id: str
    status: str  # synced | skipped | failed
    added: int = 0
    detail: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {"project_id": self.project_id, "status": self.status, "added": self.added, "detail": self.detail}


def make_records(
    tenant_id: str,
    project_id: str | None,
    entries: list[dict[str, Any]],
    *,
    run_id: str | None = None,
    deployed: bool = False,
    via: str | None = None,
    at: datetime | None = None,
) -> list[UsageRecord]:
    """Usage records for one unit of work, costed from the price table as it is now."""
    table = usage_mod.prices()
    records = []
    for e in entries:
        if not (e.get("calls") or e.get("input_tokens") or e.get("output_tokens")):
            continue
        kind = "deployed_run" if deployed and e["kind"] == "run" else e["kind"]
        fields: dict[str, Any] = dict(
            id=uuid.uuid4().hex,
            tenant_id=tenant_id,
            project_id=project_id,
            kind=kind,
            run_id=run_id,
            agent_id=e.get("agent_id"),
            provider=e["provider"],
            model=e["model"],
            calls=int(e.get("calls", 0)),
            input_tokens=int(e.get("input_tokens", 0)),
            output_tokens=int(e.get("output_tokens", 0)),
            estimated=bool(e.get("estimated")),
            cost=usage_mod.cost(e, table),
            currency=table.get("currency", "USD"),
            price=usage_mod.price_for(e["provider"], e["model"], table),
            via=via if deployed else None,
        )
        if at is not None:
            fields["at"] = at
        records.append(UsageRecord(**fields))
    return records


def sync_deployed_usage(
    project: ProjectRecord,
    cloud: Any,
    usage_store: UsageStore,
    project_store: ProjectStore,
    now: datetime | None = None,
) -> SyncResult:
    """Read one deployment's new usage lines into the usage store. Never raises: AWS or
    storage failures come back as a `failed` result for the caller to show."""
    deployment = project.deployment
    if deployment is None or not deployment.runtime_id:
        return SyncResult(project.id, "skipped", detail="not deployed")
    if not deployment.reports_usage:
        return SyncResult(project.id, "skipped", detail="redeploy to count direct AWS calls")

    now = now or datetime.now(timezone.utc)
    start = deployment.usage_synced_until or deployment.deployed_at or deployment.started_at
    since = start - OVERLAP
    try:
        lines = cloud.usage_log_events(
            deployment.runtime_id, int(since.timestamp() * 1000), int(now.timestamp() * 1000)
        )
        known = usage_store.existing_run_ids(project.tenant_id, [line["run_id"] for line in lines])
        records: list[UsageRecord] = []
        for line in lines:
            if line["run_id"] in known:
                continue  # recorded already: by the platform when it made the call, or a previous sync
            known.add(line["run_id"])
            records.extend(
                make_records(
                    project.tenant_id,
                    project.id,
                    line["usage"],
                    run_id=line["run_id"],
                    deployed=True,
                    via=line["via"],
                    at=datetime.fromtimestamp(line["at"], tz=timezone.utc),
                )
            )
        usage_store.add_many(records)
    except Exception as e:  # noqa: BLE001 — reported to the caller, never raised
        logger.warning("usage sync for project %s failed: %s", project.id, e)
        return SyncResult(project.id, "failed", detail=f"{type(e).__name__}: {e}"[:300])

    # Advance the cursor, unless the deployment changed underneath (a redeploy to a new
    # runtime starts its own cursor).
    current = project_store.get(project.id)
    if current is not None and current.deployment is not None and current.deployment.runtime_id == deployment.runtime_id:
        project_store.set_deployment(project.id, current.deployment.model_copy(update={"usage_synced_until": now}))
    runs = len({r.run_id for r in records})
    return SyncResult(project.id, "synced", added=runs)
