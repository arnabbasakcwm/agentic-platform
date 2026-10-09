"""Secrets the platform keeps for users, encrypted at rest.

A sealed secret is a Fernet token (AES-128-CBC + HMAC-SHA256) made with
PLATFORM_SECRET_KEY. Only `open_` turns it back into values, in memory, at the moment a
call needs them; nothing here logs or returns a value. Moving to KMS envelope encryption
later changes these two functions only.
"""

from __future__ import annotations

import json
from typing import Any

from .errors import SecretsNotConfiguredError


def _fernet(key: str | None = None):
    from cryptography.fernet import Fernet

    from .config import PLATFORM_SECRET_KEY

    key = key or PLATFORM_SECRET_KEY
    if not key:
        raise SecretsNotConfiguredError()
    try:
        return Fernet(key.encode("ascii"))
    except (ValueError, TypeError) as e:  # a malformed key: say so without echoing it
        raise SecretsNotConfiguredError() from e


def configured() -> bool:
    try:
        _fernet()
    except SecretsNotConfiguredError:
        return False
    return True


def seal(values: dict[str, Any], key: str | None = None) -> str:
    """Encrypt a JSON-able dict into an opaque token that is safe to store."""
    return _fernet(key).encrypt(json.dumps(values, separators=(",", ":")).encode("utf-8")).decode("ascii")


def open_(token: str, key: str | None = None) -> dict[str, Any]:
    """Decrypt a token made by `seal`. A token from another key (or tampered with) fails
    with SecretsNotConfiguredError rather than returning anything."""
    from cryptography.fernet import InvalidToken

    try:
        return json.loads(_fernet(key).decrypt(token.encode("ascii")))
    except InvalidToken as e:
        raise SecretsNotConfiguredError() from e
