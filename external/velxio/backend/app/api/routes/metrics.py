"""Stateless metrics compatibility routes for the OSS backend.

The private overlay provides the persisted metrics implementation. This route
keeps the shared frontend quiet when the overlay is not installed.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

router = APIRouter()


@router.post("/run", status_code=202)
async def record_run(_payload: dict[str, Any]) -> dict[str, bool]:
    """Accept run telemetry without persisting it in a stateless install."""
    return {"accepted": True}
