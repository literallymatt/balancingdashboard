"""System-level balancing costs from public sources, for the Total costs tab.

These figures are totals with no unit or asset behind them, so they live apart from the unit-level BM data:

- ``neso_purpose``: NESO's daily balancing cost data (the basis of the BSUoS charge), split by what the
  action was for (constraints, energy imbalance, reserve, frequency control, other). Daily.
- ``bsad``: non-BM actions (Elexon BSAD, i.e. trades and system actions outside the Balancing Mechanism). Daily.
- ``eac``: response and reserve availability payments from NESO's EAC auctions (clearing price x volume x
  window length). Monthly (dated the first of the month).
- ``thermal`` and ``constraint_type``: daily constraint costs for the Constraints tab, plus the half-hourly
  boundary flows and limits (see constraints.py).
- REMIT outage messages for the REMIT tab are fetched in the same refresh (see remit.py).
- Interconnector trades (from the same BSAD download) and flows for the Interconnectors tab (see interconnectors.py).
- Demand Flexibility Service events and bids for the DFS tab (see dfs.py).

BM cost is derived as NESO's total minus BSAD: NESO's total covers the BM plus non-BM actions, and that
difference tracks the unit-level Elexon BM cashflows to within about 1%.
"""
from __future__ import annotations

import json
import re
import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone

import httpx
import pyarrow as pa
import pyarrow.parquet as pq

from . import store

NESO = "https://api.neso.energy/api/3/action"
ELEXON = "https://data.elexon.co.uk/bmrs/api/v1"
DAILY_PACKAGE = "daily-balancing-costs-balancing-services-use-of-system"
EAC_PACKAGE = "eac-auction-results"
DEFAULT_START = date(2025, 4, 1)  # start of a financial year: both NESO's daily files and the EAC archives split there

PURPOSE = {  # NESO column -> category
    "Energy Imbalance": "energy_imbalance", "Frequency Control": "frequency_control",
    "Positive Reserve": "positive_reserve", "Constraints": "constraints",
    "Negative Reserve": "negative_reserve", "Other": "other",
}
# EAC products: DC/DM/DR (response) are four-hour windows; QR/SR/BR (reserve) are half-hour windows.
EAC_GROUP = {"DCH": "DC", "DCL": "DC", "DMH": "DM", "DML": "DM", "DRH": "DR", "DRL": "DR",
             "NQR": "QR", "PQR": "QR", "NSR": "SR", "PSR": "SR", "NBR": "BR", "PBR": "BR"}
EAC_HOURS = {"DC": 4.0, "DM": 4.0, "DR": 4.0, "QR": 0.5, "SR": 0.5, "BR": 0.5}

SCHEMA = pa.schema([("date", pa.date32()), ("source", pa.string()), ("category", pa.string()), ("amount", pa.float64())])
META = store.DATA / "cost_meta.json"


def _timeout(attempt: int) -> httpx.Timeout:
    """Read timeout for a retry: short at first, because a hung request (no bytes at all) is far more common than a
    genuinely slow one and the same request sent again usually answers in seconds; doubled on each retry."""
    return httpx.Timeout(min(120.0, 20.0 * 2**attempt), connect=10.0)


def _get(client: httpx.Client, url: str, params: dict | None = None) -> dict | list:
    last: Exception | None = None
    for attempt in range(5):
        try:
            r = client.get(url, params=params, timeout=_timeout(attempt))
            if r.status_code == 200:
                return r.json()
            if r.status_code not in (429, 500, 502, 503, 504):
                raise RuntimeError(f"{url} -> HTTP {r.status_code}: {r.text[:120]}")
            last = RuntimeError(f"HTTP {r.status_code}")
        except httpx.TimeoutException as e:  # hung: retry at once with a longer timeout (see elexon.Elexon)
            last = e
            continue
        except httpx.HTTPError as e:
            last = e
        time.sleep(min(20.0, 1.0 * 2 ** attempt))
    raise RuntimeError(f"request failed after retries: {url}: {last!r}")


def _sql(client: httpx.Client, sql: str) -> list[dict]:
    # NESO's firewall rejects string functions (substr, LEFT) in this endpoint; plain aggregates and ranges are fine.
    body = _get(client, f"{NESO}/datastore_search_sql", {"sql": sql})
    return body["result"]["records"]


def _resources(client: httpx.Client, package: str) -> list[dict]:
    return _get(client, f"{NESO}/package_show", {"id": package})["result"]["resources"]


def _fy(d: date) -> int:
    """Financial year (April to March) as the calendar year in which it starts."""
    return d.year if d.month >= 4 else d.year - 1


def _months(a: date, b: date):
    d = date(a.year, a.month, 1)
    while d <= b:
        nxt = date(d.year + (d.month == 12), d.month % 12 + 1, 1)
        yield d, nxt
        d = nxt


def fetch_purpose(client: httpx.Client, start: date, end: date) -> list[tuple]:
    res = {}
    for r in _resources(client, DAILY_PACKAGE):
        m = re.fullmatch(r"Daily Balancing Costs (\d{4})-(\d{4})", r["name"])
        if m:
            res[int(m.group(1))] = r["id"]
    rows = []
    for fy in range(_fy(start), _fy(end) + 1):
        if fy not in res:
            continue
        sums = ", ".join(f'SUM("{c}") AS {k}' for c, k in PURPOSE.items())
        sql = (f'SELECT "SETT_DATE" AS d, {sums}, COUNT(*) AS n FROM "{res[fy]}" '
               f"WHERE \"SETT_DATE\" >= '{start}' AND \"SETT_DATE\" <= '{end}' GROUP BY \"SETT_DATE\" ORDER BY \"SETT_DATE\"")
        for r in _sql(client, sql):
            d = date.fromisoformat(str(r["d"])[:10])
            for k in PURPOSE.values():
                rows.append((d, "neso_purpose", k, float(r[k] or 0)))
            rows.append((d, "neso_purpose", "_n", float(r["n"])))  # settlement periods present that day
    return rows


def fetch_eac(client: httpx.Client, start: date, end: date) -> list[tuple]:
    resources = _resources(client, EAC_PACKAGE)
    cur = next((r["id"] for r in resources if r["name"] == "NESO Response-Reserve Results Summary"), None)
    arch = {int(m.group(1)): r["id"] for r in resources
            if (m := re.fullmatch(r"NESO Response-Reserve Results Summary FY(\d{4}) \(Archive\)", r["name"]))}
    rows = []
    for first, nxt in _months(start, end):
        rid = arch.get(_fy(first), cur)
        if rid is None:
            continue
        # delivery windows are UTC; the month boundary is shifted an hour to approximate GB local time
        lo, hi = f"{first}T00:00:00", f"{nxt}T00:00:00"
        sql = (f'SELECT "auctionProduct" AS p, SUM("clearedVolume" * "clearingPrice") AS c FROM "{rid}" '
               f"WHERE \"deliveryStart\" >= '{lo}' AND \"deliveryStart\" < '{hi}' GROUP BY \"auctionProduct\"")
        by = defaultdict(float)
        for r in _sql(client, sql):
            g = EAC_GROUP.get(r["p"])
            if g:
                by[g] += float(r["c"] or 0) * EAC_HOURS[g]
        for g in EAC_HOURS:
            rows.append((first, "eac", g, by.get(g, 0.0)))
    return rows


def fetch_bsad(client: httpx.Client, start: date, end: date, ic_sink=None) -> list[tuple]:
    """Daily BSAD cost by service. ``ic_sink`` (interconnectors.TradeSink), when given, also collects the
    interconnector trades from the same download."""
    rows = []
    for first, nxt in _months(start, end):
        a = max(first, start)
        b = min(nxt, end + timedelta(days=1))
        data = _get(client, f"{ELEXON}/datasets/DISBSAD/stream",
                    {"from": f"{a}T00:00Z", "to": f"{b}T00:00Z"})
        data = data["data"] if isinstance(data, dict) else data
        seen, by = set(), defaultdict(float)
        for r in data:
            key = (r.get("settlementDate"), r.get("settlementPeriod"), r.get("id"))
            ds = r.get("settlementDate")
            if key in seen or not ds or not (a.isoformat() <= ds < b.isoformat()):
                continue
            seen.add(key)
            if ic_sink is not None:
                ic_sink.add(r)
            svc = (r.get("service") or "").lower()
            by[(ds, "energy" if svc == "energy" else "system" if svc == "system" else "other")] += float(r.get("cost") or 0)
        days = {ds for ds, _ in by}
        for ds in days:
            for cat in ("energy", "system", "other"):
                rows.append((date.fromisoformat(ds), "bsad", cat, by.get((ds, cat), 0.0)))
    return rows


def read_all() -> list[tuple]:
    p = store.DATA / "cost_daily.parquet"
    if not p.exists():
        return []
    t = pq.read_table(p)
    return list(zip(*(t[c].to_pylist() for c in ("date", "source", "category", "amount"))))


def write_all(rows: list[tuple]) -> None:
    cols = list(zip(*rows)) if rows else [[], [], [], []]
    t = pa.table({"date": pa.array(cols[0], type=pa.date32()), "source": pa.array(cols[1], type=pa.string()),
                  "category": pa.array(cols[2], type=pa.string()), "amount": pa.array(cols[3], type=pa.float64())}, schema=SCHEMA)
    store._atomic_write(t, store.DATA / "cost_daily.parquet")


def incremental_start() -> date:
    """Where a refresh needs to start when data is already held.

    Only the recent days can change (NESO publishes a few days late and revises briefly), so re-fetch from
    7 days before the last fetched date -- snapped to the 1st of that month, because the monthly EAC rows are
    dated the 1st and the merge replaces whole [start, end] windows per source.
    """
    meta = status()
    if not meta.get("updated_at") or not meta.get("end") or not read_all():
        return DEFAULT_START
    d = date.fromisoformat(meta["end"]) - timedelta(days=7)
    return max(DEFAULT_START, d.replace(day=1))


def ingest_costs(start: date | None = None, end: date | None = None, log=print) -> dict:
    """Fetch every cost source for [start, end] and merge into data/cost_daily.parquet.

    With no explicit start this is incremental: a full backfill from DEFAULT_START the first time, then only
    the recent window (see incremental_start)."""
    start = start or incremental_start()
    end = end or datetime.now(timezone.utc).date()
    store.DATA.mkdir(parents=True, exist_ok=True)
    from . import constraints, dfs, interconnectors, remit  # constraints imports this module, so not at the top

    # The Interconnectors tab's trades come out of the BSAD download. When they are not held yet (first run, or data
    # from before the tab existed) BSAD is fetched from the start of the history so the tab gets a full backfill.
    interconnectors.ensure_layout()
    ic_start = start if interconnectors.held() else min(start, DEFAULT_START)
    ic_sink = interconnectors.TradeSink()
    errors, new, windows = [], [], {}
    lock = threading.Lock()

    def step(name: str, fn) -> None:
        # a failing source must not discard the others
        try:
            fn()
        except Exception as e:
            with lock:
                errors.append(f"{name}: {e}")
            log(f"  {name}: FAILED {e}")

    def daily(name: str, fn, a: date):
        def go() -> None:
            log(f"  {name}: fetching {a} .. {end}", flush=True) if log is print else log(f"  {name}: fetching")
            got = fn(client, a, end)
            log(f"  {name}: {len(got)} rows")
            with lock:
                new.extend(got)
                windows[name] = a
        return go

    def bsad_and_trades() -> None:
        # The interconnector trades are collected from the BSAD download, so they are stored only once it succeeds.
        daily("bsad", lambda c, s, e: fetch_bsad(c, s, e, ic_sink), ic_start)()
        step("interconnector trades", trades)

    def trades() -> None:
        got = ic_sink.rows()
        interconnectors.merge_trades(got, ic_start, end)
        log(f"  interconnector trades: {len(got)} rows")

    def flows() -> None:
        got = interconnectors.fetch_flows(client, ic_start, end)
        interconnectors.merge_flows(got, ic_start, end)
        log(f"  interconnector flows: {len(got)} half-hours")

    def boundaries() -> None:
        # Half-hourly boundary flows and limits have their own file. They are day-ahead forecasts, so tomorrow's
        # are usually published too.
        hh_end = end + timedelta(days=1)
        got = constraints.fetch_boundaries(client, start, hh_end)
        log(f"  boundaries: {len(got)} half-hours")
        constraints.merge_hh(got, start, hh_end)

    # The sources are independent (different files, different endpoints), so they are fetched at the same time:
    # one after another, the first backfill took about 100 s, almost all of it waiting on the network.
    steps = [
        ("neso_purpose", daily("neso_purpose", fetch_purpose, start)),
        ("eac", daily("eac", fetch_eac, start)),
        ("bsad", bsad_and_trades),
        ("thermal", daily("thermal", constraints.fetch_thermal, start)),
        ("constraint_type", daily("constraint_type", constraints.fetch_types, start)),
        ("interconnector flows", flows),
        ("boundaries", boundaries),
        # REMIT outage messages (REMIT tab): incremental by publication time once held.
        ("remit", lambda: remit.ingest_remit(client, log)),
        # Demand Flexibility Service (DFS tab): small files, the current year re-read whole.
        ("dfs", lambda: dfs.ingest_dfs(client, log)),
    ]
    with httpx.Client(headers={"User-Agent": "bmdash/0.1"}, follow_redirects=True) as client, \
            ThreadPoolExecutor(len(steps)) as pool:
        for f in [pool.submit(step, name, fn) for name, fn in steps]:
            f.result()
    # replace what this run fetched, within each source's fetched range; keep everything else
    keep = [r for r in read_all() if not (r[1] in windows and windows[r[1]] <= r[0] <= end)]
    write_all(keep + new)
    prev = status()
    first = min(start.isoformat(), prev.get("start") or start.isoformat())
    # (the Interconnectors tab's own range comes from its data, see api.ic_meta)
    info = {"updated_at": time.time(), "start": first, "end": end.isoformat(), "error": "; ".join(errors)}
    META.write_text(json.dumps(info))
    return info


def status() -> dict:
    try:
        return json.loads(META.read_text())
    except (OSError, ValueError):
        return {"updated_at": None, "error": ""}
