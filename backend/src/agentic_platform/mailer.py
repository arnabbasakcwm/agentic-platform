"""Outgoing email: provider-agnostic SMTP (any provider with an SMTP endpoint — SES,
SendGrid, Mailgun, Gmail, a company relay), configured only by environment variables:

    SMTP_HOST, SMTP_PORT (587), SMTP_USER, SMTP_PASS, MAIL_FROM,
    SMTP_SECURITY = starttls (default) | ssl | none

No SMTP_HOST means email is off and the API answers 503 MailNotConfigured. The password
is read at send time and never logged or returned. Tests replace `transport` — they
never send real email.

Platform-only (deploy.PLATFORM_ONLY_MODULES).
"""

from __future__ import annotations

import os
import smtplib
import ssl
import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from email.message import EmailMessage
from typing import Callable

SEND_TIMEOUT_S = 30
MAX_RECIPIENTS = 10
MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024


@dataclass(frozen=True)
class MailConfig:
    host: str
    port: int
    user: str | None
    password: str | None
    sender: str
    security: str  # starttls | ssl | none


def mail_config() -> MailConfig | None:
    host = os.environ.get("SMTP_HOST", "").strip()
    sender = os.environ.get("MAIL_FROM", "").strip()
    if not host or not sender:
        return None
    security = os.environ.get("SMTP_SECURITY", "starttls").strip().lower()
    default_port = 465 if security == "ssl" else (25 if security == "none" else 587)
    try:
        port = int(os.environ.get("SMTP_PORT") or default_port)
    except ValueError:
        port = default_port
    return MailConfig(
        host=host, port=port, sender=sender,
        user=os.environ.get("SMTP_USER") or None,
        password=os.environ.get("SMTP_PASS") or None,
        security=security if security in ("starttls", "ssl", "none") else "starttls",
    )


def smtp_transport(config: MailConfig, message: EmailMessage) -> None:
    """Send one message over SMTP (TLS verified by default)."""
    context = ssl.create_default_context()
    if config.security == "ssl":
        server: smtplib.SMTP = smtplib.SMTP_SSL(config.host, config.port, timeout=SEND_TIMEOUT_S, context=context)
    else:
        server = smtplib.SMTP(config.host, config.port, timeout=SEND_TIMEOUT_S)
    with server:
        if config.security == "starttls":
            server.starttls(context=context)
        if config.user and config.password:
            server.login(config.user, config.password)
        server.send_message(message)


# Replaced in tests; the API calls send(), which calls this.
transport: Callable[[MailConfig, EmailMessage], None] = smtp_transport


def send(config: MailConfig, message: EmailMessage) -> None:
    transport(config, message)


class RateLimiter:
    """At most `limit` events per `window_s` per key, in this process. Good enough while
    the API runs one worker (see CLAUDE.md); move to Redis with the job queue."""

    def __init__(self, limit: int, window_s: float):
        self.limit = limit
        self.window_s = window_s
        self._events: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key: str, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        with self._lock:
            events = self._events[key]
            while events and now - events[0] >= self.window_s:
                events.popleft()
            if len(events) >= self.limit:
                return False
            events.append(now)
            return True

    def reset(self) -> None:
        with self._lock:
            self._events.clear()


def _rate_limit() -> int:
    try:
        return max(1, int(os.environ.get("EMAIL_RATE_LIMIT_PER_HOUR", "10")))
    except ValueError:
        return 10


# Emails per user per hour.
limiter = RateLimiter(_rate_limit(), 3600)
