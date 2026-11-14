"""Network constraint data from the NESO Data Portal, for the Constraints tab.

- ``constraint_hh`` (own Parquet file): NESO's *day-ahead* constraint flows and limits, one row per transmission
  boundary per half-hour: the boundary's limit (MW) and the flow NESO forecast across it at the day-ahead stage.
  A forecast flow at or above the limit means NESO expected to have to constrain that boundary. These are
  forecasts made the day before, not metered outturn.
- ``thermal`` (rows in cost_daily): outturn thermal constraint cost per boundary group, per day.
- ``constraint_type`` (rows in cost_daily): NESO's daily constraint cost split by reason (thermal, voltage,
  inertia, largest loss).

Fetched together with the Total costs sources (see costs.ingest_costs), so one refresh covers both tabs.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta, timezone

import httpx
import pyarrow as pa
import pyarrow.parquet as pq

from . import store
from .costs import _fy, _resources, _sql
from .ingest import LONDON, day_bounds_utc

FLOWS_PACKAGE = "day-ahead-constraint-flows-and-limits"
FLOWS_RESOURCE = "Day Ahead Constraint Flows and Limits"
THERMAL_PACKAGE = "thermal-constraint-costs"
BREAKDOWN_PACKAGE = "constraint-breakdown"
TYPES = {  # NESO column -> category
    "Thermal constraints cost": "thermal", "Voltage constraints cost": "voltage",
    "Increasing system inertia cost": "inertia", "Reducing largest loss cost": "largest_loss",
}

SCHEMA = pa.schema([("settlement_date", pa.date32()), ("sp", pa.int16()), ("grp", pa.string()),
                    ("limit_mw", pa.float64()), ("flow_mw", pa.float64())])
PATH = store.DATA / "constraint_hh.parquet"


def _num(v) -> float | None:
    # Some of NESO's yearly files store numbers as text.
    if v is None or v == "":
        return None
    try:
        return float(str(v).replace(",", ""))
    except ValueError:
        return None


def settlement_period(local: datetime, later: bool = False) -> tuple[date, int]:
    """GB local wall-clock start time -> (settlement date, settlement period). On the autumn clock change the
    01:00-01:59 hour happens twice; ``later`` picks the second (GMT) one."""
    d = local.date()
    t = local.replace(tzinfo=LONDON, fold=1 if later else 0).astimezone(timezone.utc)
    return d, int((t - day_bounds_utc(d)[0]).total_seconds() // 1800) + 1


def fetch_boundaries(client: httpx.Client, start: date, end: date) -> list[tuple]:
    rid = next((r["id"] for r in _resources(client, FLOWS_PACKAGE) if r["name"] == FLOWS_RESOURCE), None)
    if rid is None:
        raise RuntimeError(f"no '{FLOWS_RESOURCE}' resource in {FLOWS_PACKAGE}")
    rows = []
    a = start
    while a <= end:  # a month at a time: about 25k rows per request
        b = min(date(a.year + (a.month == 12), a.month % 12 + 1, 1), end + timedelta(days=1))
        q = (f'SELECT "Constraint Group" AS g, "Date_ Time GMT_BST" AS t, "Limit_MW" AS l, "Flow_MW" AS f FROM "{rid}" '
             f"WHERE \"Date_ Time GMT_BST\" >= '{a}T00:00:00' AND \"Date_ Time GMT_BST\" < '{b}T00:00:00' ORDER BY \"_id\"")
        seen = set()
        for r in _sql(client, q):
            if not r.get("g") or not r.get("t"):
                continue
            local = datetime.fromisoformat(str(r["t"])[:19])
            d, sp = settlement_period(local)
            if (r["g"], d, sp) in seen:
                # A repeat is the second 01:xx on the autumn clock change; anywhere else NESO has published the
                # same day twice, so keep the first copy.
                d, sp = settlement_period(local, later=True)
                if (r["g"], d, sp) in seen:
                    continue
            seen.add((r["g"], d, sp))
            rows.append((d, sp, r["g"], _num(r.get("l")), _num(r.get("f"))))
        a = b
    return rows


def _yearly(client: httpx.Client, package: str, pattern: str) -> dict[int, str]:
    """Financial year -> resource id, for packages published as one file per year."""
    out = {}
    for r in _resources(client, package):
        m = re.fullmatch(pattern, r["name"].strip())
        if m:
            y = int(m.group(1))
            out[y + 2000 if y < 100 else y] = r["id"]
    return out


def fetch_thermal(client: httpx.Client, start: date, end: date) -> list[tuple]:
    res = _yearly(client, THERMAL_PACKAGE, r"Thermal Constraint Costs Data (\d{2})-(\d{2})")
    rows = []
    for fy in range(_fy(start), _fy(end) + 1):
        if fy not in res:
            continue
        # Column ids vary between yearly files ("Daily Cost (GBP)" became "Daily Cost GBP"), so select them all.
        q = (f'SELECT * FROM "{res[fy]}" WHERE "Settlement Date" >= \'{start}\' AND "Settlement Date" <= \'{end}\'')
        for r in _sql(client, q):
            cost = next((v for k, v in r.items() if k.lower().startswith("daily cost")), None)
            if r.get("Constraint Group") and r.get("Settlement Date"):
                rows.append((date.fromisoformat(str(r["Settlement Date"])[:10]), "thermal", r["Constraint Group"], _num(cost) or 0.0))
    return rows


def fetch_types(client: httpx.Client, start: date, end: date) -> list[tuple]:
    res = _yearly(client, BREAKDOWN_PACKAGE, r"Constraint Breakdown (\d{4})-(\d{4})")
    rows = []
    for fy in range(_fy(start), _fy(end) + 1):
        if fy not in res:
            continue
        cols = ", ".join(f'"{c}"' for c in TYPES)
        q = f'SELECT "Date", {cols} FROM "{res[fy]}" WHERE "Date" >= \'{start}\' AND "Date" <= \'{end}\''
        for r in _sql(client, q):
            d = date.fromisoformat(str(r["Date"])[:10])
            for c, k in TYPES.items():
                rows.append((d, "constraint_type", k, _num(r.get(c)) or 0.0))
    return rows


# ---------------------------------------------------------------- half-hourly store

def read_hh() -> pa.Table:
    return pq.read_table(PATH) if PATH.exists() else SCHEMA.empty_table()


def merge_hh(rows: list[tuple], start: date, end: date) -> None:
    """Replace the held half-hours in [start, end] with ``rows``; keep everything else."""
    old = read_hh()
    keep = [r for r in zip(*(old[c].to_pylist() for c in SCHEMA.names)) if not (start <= r[0] <= end)]
    allrows = sorted(keep + rows, key=lambda r: (r[0], r[2], r[1]))
    cols = list(zip(*allrows)) if allrows else [[] for _ in SCHEMA]
    t = pa.table({f.name: pa.array(c, type=f.type) for f, c in zip(SCHEMA, cols)}, schema=SCHEMA)
    store._atomic_write(t, PATH)
