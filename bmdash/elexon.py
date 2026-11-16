"""Async client for the Elexon Insights (BMRS) API with bounded parallelism, hedging and retries."""
from __future__ import annotations

import asyncio
import random

import httpx

BASE = "https://data.elexon.co.uk/bmrs/api/v1"
RETRY_STATUS = {429, 500, 502, 503, 504}


class Elexon:
    """About one Elexon request in ten hangs: it sends nothing back at all, whatever the concurrency, while the same
    request sent again answers in seconds. (Healthy responses take 1.3 s at the median and 3.6 s at the 90th percentile,
    even for the 12 MB whole-day files.) A settlement day needs about seven requests, so most days used to wait for at
    least one hung request to time out (60 s, then a backoff, sometimes more than once). Three defences:

    - ``hedge_after``: a request still running after this long is sent a second time, and whichever answers first wins.
    - ``timeout``: the read timeout (no bytes for this long) of the first attempt, doubled on each retry up to
      ``max_timeout``. Short, so a hung request is given up quickly; the doubling still lets a genuinely slow response
      through on a later attempt. A timed-out attempt is retried at once rather than after a backoff.
    - ``deadline``: the read timeout restarts with every chunk, so a response that trickles in (seen on the BOALF files,
      which normally arrive in a second or two) could still take minutes. Each attempt also has this overall limit,
      doubled the same way up to five minutes; it is generous so a slow connection shared by 16 downloads is not cut off.
    """

    def __init__(self, concurrency: int = 16, timeout: float = 20.0, deadline: float = 60.0,
                 max_timeout: float = 120.0, hedge_after: float | None = 8.0, retries: int = 6):
        self._sem = asyncio.Semaphore(concurrency)
        self._retries = retries
        self._timeout, self._deadline, self._max_timeout = timeout, deadline, max_timeout
        self._hedge_after = hedge_after
        self._client = httpx.AsyncClient(
            base_url=BASE,
            timeout=httpx.Timeout(timeout, connect=10.0),
            # room for each request's hedge
            limits=httpx.Limits(max_connections=2 * concurrency, max_keepalive_connections=concurrency),
            headers={"Accept": "application/json", "User-Agent": "bmdash/0.1"},
        )
        self.requests = 0
        self.hedged = 0

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "Elexon":
        return self

    async def __aexit__(self, *exc) -> None:
        await self.aclose()

    async def _send(self, path: str, params, attempt: int) -> httpx.Response:
        self.requests += 1
        read = min(self._max_timeout, self._timeout * 2**attempt)
        async with asyncio.timeout(min(300.0, self._deadline * 2**attempt)):
            return await self._client.get(path, params=params, timeout=httpx.Timeout(read, connect=10.0))

    async def _hedged(self, path: str, params, attempt: int) -> httpx.Response:
        """One attempt, sent again if it has not answered after ``hedge_after``: the first response wins."""
        first = asyncio.create_task(self._send(path, params, attempt))
        if self._hedge_after is None:
            return await first
        done, _ = await asyncio.wait({first}, timeout=self._hedge_after)
        if done:
            return first.result()
        self.hedged += 1
        pending = {first, asyncio.create_task(self._send(path, params, attempt))}
        try:
            while True:
                done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
                for t in done:
                    if t.exception() is None:
                        return t.result()
                if not pending:  # both failed
                    raise next(iter(done)).exception()
        finally:
            for t in pending:
                t.cancel()

    async def get(self, path: str, params=None) -> list[dict]:
        """GET a path and return its list of records ([] when Elexon has no data)."""
        last: Exception | None = None
        for attempt in range(self._retries):
            hung = False
            async with self._sem:
                try:
                    r = await self._hedged(path, params, attempt)
                except (httpx.TimeoutException, TimeoutError) as e:  # stalled: retry at once, not after a backoff
                    last, r, hung = e, None, True
                except httpx.HTTPError as e:  # other network errors
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
            if not hung:
                await asyncio.sleep(min(30.0, 0.5 * 2**attempt) + random.random() * 0.3)
        raise RuntimeError(f"Elexon request failed after {self._retries} attempts: {path}: {last!r}")
