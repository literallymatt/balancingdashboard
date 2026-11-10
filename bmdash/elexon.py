"""Async client for the Elexon Insights (BMRS) API with bounded parallelism and retries."""
from __future__ import annotations

import asyncio
import random

import httpx

BASE = "https://data.elexon.co.uk/bmrs/api/v1"
RETRY_STATUS = {429, 500, 502, 503, 504}


class Elexon:
    def __init__(self, concurrency: int = 16, timeout: float = 60.0, retries: int = 6):
        self._sem = asyncio.Semaphore(concurrency)
        self._retries = retries
        self._client = httpx.AsyncClient(
            base_url=BASE,
            timeout=timeout,
            limits=httpx.Limits(max_connections=concurrency, max_keepalive_connections=concurrency),
            headers={"Accept": "application/json", "User-Agent": "bmdash/0.1"},
        )
        self.requests = 0

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "Elexon":
        return self

    async def __aexit__(self, *exc) -> None:
        await self.aclose()

    async def get(self, path: str, params=None) -> list[dict]:
        """GET a path and return its list of records ([] when Elexon has no data)."""
        last: Exception | None = None
        for attempt in range(self._retries):
            async with self._sem:
                try:
                    self.requests += 1
                    r = await self._client.get(path, params=params)
                except httpx.HTTPError as e:  # network / timeout
                    last = e
                    r = None
            if r is not None:
                if r.status_code == 200:
                    body = r.json()
                    return body["data"] if isinstance(body, dict) else body
                if r.status_code == 404:
                    return []
                if r.status_code not in RETRY_STATUS:
                    raise RuntimeError(f"Elexon {r.status_code} for {path}: {r.text[:300]}")
                last = RuntimeError(f"Elexon {r.status_code} for {path}")
            await asyncio.sleep(min(30.0, 0.5 * 2**attempt) + random.random() * 0.3)
        raise RuntimeError(f"Elexon request failed after {self._retries} attempts: {path}: {last!r}")
