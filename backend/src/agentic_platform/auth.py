"""Password hashing and access tokens.

Pure functions, no storage and no HTTP: the API layer (`app.py`) owns the routes and the
user store, and calls in here for the two things that must be done exactly right —
hashing a password and signing/verifying a token. Passwords are hashed with Argon2id;
tokens are short-lived HS256 JWTs whose only claim of substance is the user id.
"""

from __future__ import annotations

import logging
import secrets
from datetime import datetime, timedelta, timezone

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

from .config import JWT_EXPIRES_MINUTES, JWT_SECRET
from .errors import AuthenticationError

logger = logging.getLogger(__name__)

_ALGORITHM = "HS256"
# HS256 needs a key at least as long as its 256-bit output to be worth anything.
_MIN_SECRET_LENGTH = 32

_hasher = PasswordHasher()
# Verified against when a login names an unknown email, so that path costs the same as a
# wrong password and response time doesn't reveal which emails are registered.
_DUMMY_HASH = _hasher.hash(secrets.token_urlsafe(16))


def _resolve_secret() -> str:
    if JWT_SECRET is None:
        logger.warning(
            "JWT_SECRET is not set; using a random per-process secret, so every restart "
            "invalidates all issued tokens"
        )
        return secrets.token_urlsafe(48)
    if len(JWT_SECRET) < _MIN_SECRET_LENGTH:
        raise RuntimeError(
            f"JWT_SECRET must be at least {_MIN_SECRET_LENGTH} characters long"
        )
    return JWT_SECRET


_SECRET = _resolve_secret()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str | None) -> bool:
    """True only if `password` matches. Pass None for an unknown user: the check still
    does a full hash verification and returns False."""
    try:
        _hasher.verify(password_hash or _DUMMY_HASH, password)
    except (VerificationError, InvalidHashError):
        return False
    return password_hash is not None


def create_access_token(user_id: str, *, now: datetime | None = None) -> str:
    issued = now or datetime.now(timezone.utc)
    claims = {
        "sub": user_id,
        "iat": issued,
        "exp": issued + timedelta(minutes=JWT_EXPIRES_MINUTES),
    }
    return jwt.encode(claims, _SECRET, algorithm=_ALGORITHM)


def decode_access_token(token: str) -> str:
    """Return the user id a valid token was issued to; raise AuthenticationError for
    anything else (bad signature, expired, malformed, missing claims)."""
    try:
        claims = jwt.decode(
            token,
            _SECRET,
            # Pinned: never let the token's own header choose how it is verified.
            algorithms=[_ALGORITHM],
            options={"require": ["sub", "exp"]},
        )
    except jwt.ExpiredSignatureError:
        raise AuthenticationError("token has expired") from None
    except jwt.InvalidTokenError:
        raise AuthenticationError("invalid token") from None
    return claims["sub"]
