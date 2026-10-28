"""HMAC signing for service-to-service calls (Express <-> agent).

signature = hex(HMAC_SHA256(secret, f"{timestamp}.{METHOD}.{path}.{body}"))
Headers: X-Agent-Timestamp, X-Agent-Signature. Requests older than 5 minutes
are rejected (replay protection)."""
from __future__ import annotations

import hashlib
import hmac
import time

from fastapi import HTTPException, Request

from .config import settings

MAX_SKEW_S = 300


def sign(method: str, path: str, body: bytes, ts: str | None = None) -> tuple[str, str]:
    ts = ts or str(int(time.time()))
    msg = f"{ts}.{method.upper()}.{path}.".encode() + body
    return ts, hmac.new(settings.shared_secret.encode(), msg, hashlib.sha256).hexdigest()


async def verify(request: Request) -> None:
    ts = request.headers.get("x-agent-timestamp", "")
    sig = request.headers.get("x-agent-signature", "")
    if not ts or not sig:
        raise HTTPException(status_code=401, detail="missing signature")
    try:
        if abs(time.time() - int(ts)) > MAX_SKEW_S:
            raise HTTPException(status_code=401, detail="stale signature")
    except ValueError:
        raise HTTPException(status_code=401, detail="bad timestamp")
    body = await request.body()
    _, expected = sign(request.method, request.url.path, body, ts)
    if not hmac.compare_digest(expected, sig):
        raise HTTPException(status_code=401, detail="bad signature")
