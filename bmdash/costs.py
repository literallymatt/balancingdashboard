"""System-level balancing costs from public sources, for the Total costs tab.

These figures are totals with no unit or asset behind them, so they live apart from the unit-level BM data:

- ``neso_purpose``: NESO's daily balancing cost data (the basis of the BSUoS charge), split by what the
  action was for (constraints, energy imbalance, reserve, frequency control, other). Daily.
- ``bsad``: non-BM actions (Elexon BSAD, i.e. trades and system actions outside the Balancing Mechanism). Daily.
- ``eac``: response and reserve availability payments from NESO's EAC auctions (clearing price x volume x
  window length). Monthly (dated the first of the month).

BM cost is derived as NESO's total minus BSAD: NESO's total covers the BM plus non-BM actions, and that
difference tracks the unit-level Elexon BM cashflows to within about 1%.
"""
from __future__ import annotations

import json
import re
import time
from collections import defaultdict
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


def _get(client: httpx.Client, url: str, params: dict | None = None) -> dict | list:
    last: Exception | None = None
    for attempt in range(5):
        try:
            r = client.get(url, params=params, timeout=120)
            if r.status_code == 200:
                return r.json()
            if r.status_code not in (429, 500, 502, 503, 504):
                raise RuntimeError(f"{url} -> HTTP {r.status_code}: {r.text[:120]}")
            last = RuntimeError(f"HTTP {r.status_code}")
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


def fetch_bsad(client: httpx.Client, start: date, end: date) -> list[tuple]:
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


def ingest_costs(start: date = DEFAULT_START, end: date | None = None, log=print) -> dict:
    """Fetch every cost source for [start, end] and merge into data/cost_daily.parquet."""
    end = end or datetime.now(timezone.utc).date()
    store.DATA.mkdir(parents=True, exist_ok=True)
    errors, new = [], []
    with httpx.Client(headers={"User-Agent": "bmdash/0.1"}, follow_redirects=True) as client:
        for name, fn in (("neso_purpose", fetch_purpose), ("eac", fetch_eac), ("bsad", fetch_bsad)):
            try:
                got = fn(client, start, end)
                log(f"  {name}: {len(got)} rows")
                new += got
            except Exception as e:  # a failing source must not discard the others
                errors.append(f"{name}: {e}")
                log(f"  {name}: FAILED {e}")
    fresh = {(s, c) for _, s, c, _ in new}
    sources = {s for s, _ in fresh}
    # replace what this run fetched, within the fetched range; keep everything else
    keep = [r for r in read_all() if not (r[1] in sources and start <= r[0] <= end)]
    write_all(keep + new)
    info = {"updated_at": time.time(), "start": start.isoformat(), "end": end.isoformat(), "error": "; ".join(errors)}
    META.write_text(json.dumps(info))
    return info


def status() -> dict:
    try:
        return json.loads(META.read_text())
    except (OSError, ValueError):
        return {"updated_at": None, "error": ""}
