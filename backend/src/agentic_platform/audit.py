"""Writing to the audit log.

One function, so every privileged action records the same shape. It is called after the
action succeeded (a refused or failed action changes nothing, so it records nothing here;
blocked model and budget calls are recorded where they are blocked). A failure to write is
logged loudly with the whole entry rather than turned into an error for the caller, because
the action itself has already happened and undoing it half-way would be worse.

Entries hold ids and small before/after values only: never a password, key, prompt, brief
or run content.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from .stores import AuditEntry, AuditStore

logger = logging.getLogger(__name__)


def record(
    store: AuditStore,
    actor_id: str,
    action: str,
    target_type: str,
    target_id: str,
    *,
    team_id: str | None = None,
    before: dict[str, Any] | None = None,
    after: dict[str, Any] | None = None,
    details: dict[str, Any] | None = None,
) -> AuditEntry:
    entry = AuditEntry(
        id=uuid.uuid4().hex,
        actor_id=actor_id,
        action=action,
        target_type=target_type,
        target_id=target_id,
        team_id=team_id,
        before=before,
        after=after,
        details=details or {},
    )
    try:
        store.append(entry)
    except Exception:  # noqa: BLE001 - see the module note
        logger.error("AUDIT WRITE FAILED: %s", entry.model_dump_json(), exc_info=True)
    return entry
