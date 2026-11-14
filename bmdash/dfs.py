"""Demand Flexibility Service (DFS) data from the NESO Data Portal, for the DFS tab.

In a DFS event NESO asks households and businesses, through registered providers (suppliers and aggregators), to move
their demand for set half-hours: *Downwards* events ask them to use less (the original winter service), *Upwards*
events (from April 2026) to use more, for example when wind would otherwise be curtailed. NESO tags each event as
*Energy* (the national energy balance) or *System* (for example a constraint). Providers bid a volume per DFS unit and
half-hour at a price; NESO accepts bids up to its requirement, cheapest first, and later publishes what was delivered
(settled).

Two NESO files per year, in the ``demand-flexibility`` package (the current year, plus an archive per finished year):

- ``DFS Utilisation Report Summary``: one row per event half-hour: requirement MW, MW procured, the cost of the
  accepted bids and, once settled, the volume delivered and its cost. Stored as ``data/dfs_hh.parquet``.
- ``DFS Utilisation Report``: one row per bid (DFS unit x half-hour): provider, unit, zone, MW, price and whether NESO
  accepted it. Stored as ``data/dfs_bid.parquet``.
- ``DFS Service Requirement``: per event half-hour, the guaranteed acceptance price (bids at or below it are accepted;
  almost always 0) and, from April 2026, a cap per zone ("Z1:500,Z2:0,..."; 0 means the zone was closed to the event).
  The price goes on ``dfs_hh``; the caps are stored as ``data/dfs_cap.parquet`` (event x half-hour x zone).

Each event half-hour also carries the wholesale market index price for that half-hour (Elexon ``MID``, the APX
price), fetched a month at a time, so the DFS clearing price can be compared with the market.

Accepted bids are paid their own price (pay-as-bid) and NESO takes bids cheapest first: in every half-hour no rejected
bid is cheaper than the dearest accepted one. The *clearing price* of a half-hour is therefore its highest accepted
price; the cheapest rejected bid shows where NESO stopped.

Volumes are MW held for a half-hour, so MWh = MW x 0.5; the cost of an accepted bid is MW x 0.5 x its price, which
reproduces the summary's accepted cost. The archive for 2025/26 (which runs from November 2024) has no event ids,
event types or tags: there was one event a day, all Downwards, so its event id is its date and its tag "".
Zones (1-12) appear from April 2026 only.

Fetched with the Total costs data (see costs.ingest_costs). The files are small (about 35k rows in all), so a refresh
re-reads the current year's files whole; the archives are read only until held. Mirrored on the phone in Dfs.kt.
"""
from __future__ import annotations

import re
from datetime import date, datetime

import httpx
import pyarrow as pa
import pyarrow.parquet as pq

from . import store

PACKAGE = "demand-flexibility"
SUMMARY = re.compile(r"DFS Utilisation Report Summary( \(Archive (\d{4})/\d{4}\))?")
BIDS = re.compile(r"DFS Utilisation Report( \(Archive (\d{4})/\d{4}\))?")

HH_SCHEMA = pa.schema([
    ("settlement_date", pa.date32()), ("sp", pa.int16()), ("event", pa.string()), ("direction", pa.string()),
    ("tag", pa.string()), ("live", pa.bool_()), ("req_mw", pa.float64()), ("procured_mw", pa.float64()),
    ("cost", pa.float64()), ("settled_mw", pa.float64()), ("settled_cost", pa.float64()),
    ("gap", pa.float64()), ("mip", pa.float64()),
])
CAP_SCHEMA = pa.schema([("settlement_date", pa.date32()), ("sp", pa.int16()), ("event", pa.string()), ("zone", pa.int16()),
                        ("cap_mw", pa.float64())])
BID_SCHEMA = pa.schema([
    ("settlement_date", pa.date32()), ("sp", pa.int16()), ("event", pa.string()), ("direction", pa.string()),
    ("tag", pa.string()), ("live", pa.bool_()), ("party", pa.string()), ("unit", pa.string()), ("zone", pa.int16()),
    ("mw", pa.float64()), ("price", pa.float64()), ("accepted", pa.bool_()),
])
HH_PATH = store.DATA / "dfs_hh.parquet"
BID_PATH = store.DATA / "dfs_bid.parquet"
CAP_PATH = store.DATA / "dfs_cap.parquet"
REQ = re.compile(r"DFS Service Requirement( \(Archive (\d{4})/\d{4}\))?")
ELEXON = "https://data.elexon.co.uk/bmrs/api/v1"


def _num(v) -> float | None:
    if v is None or v == "":
        return None
    try:
        return float(str(v).replace(",", ""))
    except ValueError:
        return None


def party_name(s: str | None) -> str:
    """One name per provider: NESO spells some differently from file to file ("GRIDIMP LTD", "GRIDIMP LIMITED";
    "Electryone AI", "ELECTRYONE AI LIMITED"), so upper-case and drop the company suffix."""
    p = " ".join((s or "").split()).upper()
    p = re.sub(r"[ ,.]+(LIMITED|LTD\.?)$", "", p)
    return p or "UNKNOWN"


def _when(r: dict) -> tuple[date, int] | None:
    from .constraints import settlement_period  # constraints imports costs, which imports this module

    d, t = r.get("Delivery Date"), r.get("From_Local") or r.get("From")
    if not d or not t:
        return None
    day = date.fromisoformat(str(d)[:10])
    hh, mm = (int(x) for x in str(t).strip()[:5].split(":"))
    return settlement_period(datetime(day.year, day.month, day.day, hh, mm))


def _event(r: dict, day: date) -> tuple[str, str, str]:
    """(event id, direction, tag). The 2025/26 archive has none of these: one Downwards event a day."""
    eid = r.get("Event ID")
    if eid is None or eid == "":
        return day.isoformat(), "Downwards", ""
    return str(int(float(eid))), r.get("Event Type") or "Downwards", r.get("Event Tag") or ""


def summary_rows(records: list[dict]) -> list[tuple]:
    rows = []
    for r in records:
        w = _when(r)
        if w is None:
            continue
        d, sp = w
        ev, direction, tag = _event(r, d)
        rows.append((d, sp, ev, direction, tag, (r.get("Service Requirement Type") or "Live") != "Test",
                     _num(r.get("Service Requirement MW")), _num(r.get("DFS Procured MW")) or 0.0,
                     _num(r.get("DFS Provider Bids Accepted Total Cost GBP")) or 0.0,
                     _num(r.get("Settled Volume MW")), _num(r.get("Settled Cost GBP")), None, None))
    return rows


def requirement_rows(records: list[dict]) -> tuple[dict, list[tuple]]:
    """((event, sp) -> guaranteed acceptance price, cap rows) from the service requirement file."""
    gap, caps = {}, []
    for r in records:
        w = _when(r)
        if w is None:
            continue
        d, sp = w
        ev = _event(r, d)[0]
        gap[(ev, sp)] = _num(r.get("Guaranteed Acceptance Price GBP per MWh"))
        for part in (r.get("Zonal Cap") or "").split(","):
            m = re.fullmatch(r"\s*Z(\d+)\s*:\s*([\d.]+)\s*", part)
            if m:
                caps.append((d, sp, ev, int(m.group(1)), float(m.group(2))))
    return gap, caps


def fetch_mip(client: httpx.Client, days: set[date]) -> dict:
    """(settlement date, period) -> market index price (APX) for the months containing ``days``, one request a month."""
    from .costs import _get

    out = {}
    for y, m in sorted({(d.year, d.month) for d in days}):
        a, b = date(y, m, 1), date(y + (m == 12), m % 12 + 1, 1)
        data = _get(client, f"{ELEXON}/datasets/MID/stream", {"from": f"{a}T00:00Z", "to": f"{b}T00:00Z"})
        for r in data["data"] if isinstance(data, dict) else data:
            if r.get("dataProvider") == "APXMIDP" and r.get("volume") and r.get("settlementDate"):
                out[(r["settlementDate"], int(r["settlementPeriod"]))] = float(r["price"])
    return out


def bid_rows(records: list[dict]) -> list[tuple]:
    rows = []
    for r in records:
        w = _when(r)
        mw = _num(r.get("DFS Procured MW") if "DFS Procured MW" in r else r.get("DFS Volume MW"))
        if w is None or mw is None:
            continue
        d, sp = w
        ev, direction, tag = _event(r, d)
        zone = _num(r.get("Zone"))
        rows.append((d, sp, ev, direction, tag, (r.get("Service Requirement Type") or "Live") != "Test",
                     party_name(r.get("Registered DFS Participant")), (r.get("DFS Unit ID") or "").strip() or "Unknown",
                     int(zone) if zone is not None else None, mw, _num(r.get("Utilisation Price GBP per MWh")),
                     (r.get("Status") or "").strip().lower() == "accepted"))
    return rows


def resources(client: httpx.Client) -> list[tuple[str, str, bool]]:
    """(kind, resource id, archive?) for every summary and bid file in the package."""
    from .costs import _resources

    out = []
    for r in _resources(client, PACKAGE):
        name = r["name"].strip()
        for kind, pat in (("hh", SUMMARY), ("bid", BIDS), ("req", REQ)):
            m = pat.fullmatch(name)
            if m:
                out.append((kind, r["id"], m.group(1) is not None))
    return out


def ingest_dfs(client: httpx.Client, log=print) -> None:
    from .costs import _sql

    full = not held()
    got, gap, caps = {"hh": [], "bid": []}, {}, []
    for kind, rid, archive in resources(client):
        if archive and not full:
            continue
        recs = _sql(client, f'SELECT * FROM "{rid}"')
        if kind == "req":
            g, c = requirement_rows(recs)
            gap.update(g)
            caps += c
        else:
            got[kind] += summary_rows(recs) if kind == "hh" else bid_rows(recs)
    if not got["hh"]:
        raise RuntimeError(f"no DFS summary rows in {PACKAGE}")
    mip = fetch_mip(client, {r[0] for r in got["hh"]})
    got["hh"] = [r[:11] + (gap.get((r[2], r[1])), mip.get((r[0].isoformat(), r[1]))) for r in got["hh"]]
    # Replace from the first date fetched: everything when backfilling, else the current year's files.
    start = min(r[0] for r in got["hh"] + got["bid"])
    _merge(HH_PATH, HH_SCHEMA, got["hh"], start)
    _merge(BID_PATH, BID_SCHEMA, got["bid"], start)
    _merge(CAP_PATH, CAP_SCHEMA, [c for c in caps if c[0] >= start], start)
    log(f"  dfs: {len(got['hh'])} event half-hours, {len(got['bid'])} bids, {len(caps)} zone caps from {start}")


# ---------------------------------------------------------------- stores

def held() -> bool:
    """True once a backfill is stored in the current layout (files from before the price columns are re-fetched)."""
    if not (HH_PATH.exists() and CAP_PATH.exists()):
        return False
    meta = pq.read_metadata(HH_PATH)
    return meta.num_rows > 0 and "mip" in meta.schema.names


def _merge(path, schema: pa.Schema, rows: list[tuple], start: date) -> None:
    """Replace what is held from ``start`` on with ``rows``; keep everything before."""
    old = pq.read_table(path) if path.exists() else schema.empty_table()
    # A file from an older layout lacks the newer columns: carry its rows with those left empty.
    cols = [old[c].to_pylist() if c in old.column_names else [None] * old.num_rows for c in schema.names]
    keep = [r for r in zip(*cols) if r[0] < start]
    allrows = sorted(keep + rows, key=lambda r: (r[0], r[1], r[2]))
    cols = list(zip(*allrows)) if allrows else [[] for _ in schema]
    store._atomic_write(pa.table({f.name: pa.array(c, type=f.type) for f, c in zip(schema, cols)}, schema=schema), path)


def ensure_layout() -> None:
    for path, schema in ((HH_PATH, HH_SCHEMA), (BID_PATH, BID_SCHEMA), (CAP_PATH, CAP_SCHEMA)):
        if not path.exists() or (path == HH_PATH and "mip" not in pq.read_schema(path).names):
            store._atomic_write(schema.empty_table(), path)
