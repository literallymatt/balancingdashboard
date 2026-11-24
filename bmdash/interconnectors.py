"""Interconnector balancing data, for the Interconnectors tab.

Interconnectors do not take part in the Balancing Mechanism (no bid-offer acceptances on the ``I_`` units). NESO
balances across them with trades outside the BM, which Elexon publishes in BSAD (``DISBSAD``) alongside its other
non-BM actions:

- **Counterparty trades**: NESO buys or sells energy from a trader for delivery over one link. The BSAD asset id is
  the trader's interconnector BM unit, e.g. ``IFG-DSKC1`` (IFA, Danske Commodities): the three-letter prefix names the
  link (``IFG``/``IFD`` IFA, ``I2G``/``I2D`` IFA2, ``IBG``/``IBD`` BritNed, ...).
- **SO-SO trades**: NESO trades with the neighbouring system operator (RTE, Statnett, EirGrid, SONI...). The asset id
  is a short code for the link (``IF1``, ``IF2``, ``EL1``, ``NSL``, ``EWIC``, ``MOYLE``); many are published with no cost.

Positive volume is energy NESO buys (more import into GB, or less export); negative is energy it sells. Cost is what
NESO paid (negative: what it received).

The trades are taken from the same monthly DISBSAD download as the Total costs tab's BSAD figures (see
costs.fetch_bsad), so they cost no extra requests. Elexon publishes a settlement period's BSAD only once the period
starts, but NESO awards most of these trades hours ahead in its interconnector auctions (NESO Data Portal,
"Interconnector Requirement and Auction Summary Data"). So the lots already awarded for periods BSAD does not cover yet
are added from that file (see fetch_auctions), as party ``AUCTION_PARTY``; the next refresh replaces them with the BSAD
trades once those are published. Physical flows per link come from Elexon's half-hourly generation by
fuel type (``FUELHH``: INTFR, INTIFA2, ... in MW, positive = import into GB).

Stored as ``data/ic_trade.parquet`` (one row per settlement period x link x counterparty x SO flag x direction, summed,
keeping the highest and lowest single-trade price so the tab can show marginal ("clearing") prices)
and ``data/ic_flow_hh.parquet`` (one row per settlement period x link). Mirrored on the phone in Interconnectors.kt.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

import httpx
import pyarrow as pa
import pyarrow.parquet as pq

from . import store
from .ingest import LONDON, day_bounds_utc

ELEXON = "https://data.elexon.co.uk/bmrs/api/v1"

# BSAD asset-id prefix (counterparty trades: the trader's interconnector BM unit) -> link.
PREFIX = {
    "IFG": "IFA", "IFD": "IFA", "I2G": "IFA2", "I2D": "IFA2", "ILG": "ELEC", "ILD": "ELEC",
    "IBG": "BRTN", "IBD": "BRTN", "ING": "NEMO", "IND": "NEMO", "IVG": "VKL", "IVD": "VKL",
    "ISG": "NSL", "ISD": "NSL", "IIG": "EWIC", "IID": "EWIC", "IMG": "MOYL", "IMD": "MOYL",
    "IGG": "GRNL", "IGD": "GRNL",
}
# Whole BSAD asset ids used for SO-SO trades with the neighbouring system operator -> link.
SOSO = {"IF1": "IFA", "IF2": "IFA2", "EL1": "ELEC", "NSL": "NSL", "EWIC": "EWIC", "MOYLE": "MOYL",
        "BN1": "BRTN", "BRITNED": "BRTN", "NEMO": "NEMO", "NEM1": "NEMO", "VKL": "VKL", "VK1": "VKL",
        "GREENLINK": "GRNL", "GRN": "GRNL"}
# Elexon FUELHH fuel type -> link.
FUEL = {"INTFR": "IFA", "INTIFA2": "IFA2", "INTELEC": "ELEC", "INTNED": "BRTN", "INTNEM": "NEMO", "INTVKL": "VKL",
        "INTNSL": "NSL", "INTEW": "EWIC", "INTIRL": "MOYL", "INTGRNL": "GRNL"}

# NESO auction file: per-link cleared volume column -> link.
AUCTION_PACKAGE = "interconnector-requirement-and-auction-summary-data"
AUCTION_RESOURCE = "Interconnector Requirements and Auction Summary"
AUCTION_LINK = {"IFA1 Volume": "IFA", "IFA2 Volume": "IFA2", "EL Volume": "ELEC", "BN Volume": "BRTN",
                "NEMO Volume": "NEMO", "VKL Volume": "VKL"}
# Qualified IC code in the auction file -> link (for lots on one link that give no per-link split).
AUCTION_IC = {"IFA1": "IFA", "IFA": "IFA", "IFA2": "IFA2", "EL": "ELEC", "BN": "BRTN", "NEMO": "NEMO", "VKL": "VKL"}
# Party shown for awarded auction lots that BSAD has not published yet.
AUCTION_PARTY = "NESO auction (awaiting BSAD)"

TRADE_SCHEMA = pa.schema([
    ("settlement_date", pa.date32()), ("sp", pa.int16()), ("ic", pa.string()), ("party", pa.string()),
    ("kind", pa.string()), ("so_flag", pa.bool_()), ("volume", pa.float64()), ("cost", pa.float64()), ("n", pa.int32()),
    # Highest and lowest price (cost / volume) of the priced trades summed into the row; null when none had a cost.
    ("price_max", pa.float64()), ("price_min", pa.float64()),
])
FLOW_SCHEMA = pa.schema([("settlement_date", pa.date32()), ("sp", pa.int16()), ("ic", pa.string()), ("flow_mw", pa.float64())])
TRADE_PATH = store.DATA / "ic_trade.parquet"
FLOW_PATH = store.DATA / "ic_flow_hh.parquet"


def classify(asset_id: str | None) -> tuple[str, str] | None:
    """BSAD asset id -> (link, kind) for interconnector trades; None for any other non-BM action."""
    a = (asset_id or "").strip().upper()
    if not a:
        return None
    if a in SOSO:
        return SOSO[a], "soso"
    if "-" in a and a.split("-", 1)[0] in PREFIX:
        return PREFIX[a.split("-", 1)[0]], "trade"
    return None


class TradeSink:
    """Collects interconnector trades from DISBSAD records (already de-duplicated by the caller)."""

    def __init__(self) -> None:
        self.acc: dict[tuple, list] = defaultdict(lambda: [0.0, 0.0, 0, None, None])
        # Latest (settlement date, period) with any real BSAD action: periods after it are not published yet (every
        # future period carries a placeholder row with no asset), so awarded auction lots fill them (see fetch_auctions).
        self.through: tuple[str, int] | None = None

    def add(self, r: dict) -> None:
        if r.get("assetId") and r.get("settlementDate") and r.get("settlementPeriod"):
            at = (r["settlementDate"], int(r["settlementPeriod"]))
            if self.through is None or at > self.through:
                self.through = at
        c = classify(r.get("assetId"))
        vol = r.get("volume")
        if c is None or not vol:
            return
        ic, kind = c
        vol = float(vol)
        key = (r["settlementDate"], int(r["settlementPeriod"]), ic, r.get("partyId") or "Unknown", kind, bool(r.get("soFlag")), vol > 0)
        cost = float(r.get("cost") or 0)
        x = self.acc[key]
        x[0] += vol
        x[1] += cost
        x[2] += 1
        if cost:
            price = cost / vol
            x[3] = price if x[3] is None else max(x[3], price)
            x[4] = price if x[4] is None else min(x[4], price)

    def rows(self) -> list[tuple]:
        return [(date.fromisoformat(k[0]), k[1], k[2], k[3], k[4], k[5], *v) for k, v in self.acc.items()]


def _sp_of(utc: datetime) -> tuple[date, int]:
    """UTC instant -> (settlement date, settlement period)."""
    d = utc.astimezone(LONDON).date()
    return d, int((utc - day_bounds_utc(d)[0]).total_seconds() // 1800) + 1


def _num(v) -> float | None:
    try:
        return None if v is None or v == "" else float(v)
    except (TypeError, ValueError):
        return None


def fetch_auctions(client: httpx.Client, after: tuple[str, int] | None, end: date) -> list[tuple]:
    """Trade rows (TRADE_SCHEMA) for the interconnector auction lots NESO has awarded for delivery in settlement periods
    after ``after`` (the last one BSAD has published) up to the end of ``end``.

    A lot is one hour on one or more links, in MW: each link's cleared volume becomes MW x 0.5 MWh in each of the
    hour's two settlement periods, priced at the lot's volume-weighted average price (the highest and lowest prices are
    its clearing and best prices). Lots that give no per-link split and qualify more than one link are left out."""
    from .costs import _resources, _sql  # costs imports this module

    if after is None:
        return []
    d0, sp0 = date.fromisoformat(after[0]), after[1]
    lo = day_bounds_utc(d0)[0] + timedelta(minutes=30 * sp0)  # end of the last published period
    hi = day_bounds_utc(end)[1]
    rid = next((r["id"] for r in _resources(client, AUCTION_PACKAGE) if r["name"] == AUCTION_RESOURCE), None)
    if rid is None:
        raise RuntimeError(f"no '{AUCTION_RESOURCE}' resource in {AUCTION_PACKAGE}")
    # Times are UTC. A window starting before `lo` still has its later hour(s) to deliver, so fetch from an earlier start.
    sql = (f'SELECT * FROM "{rid}" WHERE "End Time" > \'{lo:%Y-%m-%dT%H:%M:%S}\' '
           f'AND "Start Time" < \'{hi:%Y-%m-%dT%H:%M:%S}\' AND "Cleared Volume" > 0 ORDER BY "_id"')
    lots = {}
    for r in _sql(client, sql):
        lots[r.get("Auction Lot ID") or r["_id"]] = r  # a re-published lot replaces the earlier copy
    acc: dict[tuple, list] = defaultdict(lambda: [0.0, 0.0, 0, None, None])
    for r in lots.values():
        try:
            t0 = datetime.fromisoformat(str(r["Start Time"])[:19]).replace(tzinfo=timezone.utc)
            t1 = datetime.fromisoformat(str(r["End Time"])[:19]).replace(tzinfo=timezone.utc)
        except (KeyError, ValueError):
            continue
        sign = -1.0 if str(r.get("Buy Sell") or "").strip().lower() == "sell" else 1.0
        vwa, clear, best = _num(r.get("VWA Price")), _num(r.get("Clearing Price")), _num(r.get("Best Price"))
        prices = [p for p in (clear, best, vwa) if p is not None]
        per_link = {AUCTION_LINK[k]: _num(r.get(k)) for k in AUCTION_LINK if _num(r.get(k))}
        if not per_link:
            qualified = [AUCTION_IC.get(x.strip().upper()) for x in str(r.get("Qualified IC") or "").split("/")]
            if len(qualified) != 1 or qualified[0] is None:
                continue
            per_link = {qualified[0]: _num(r.get("Cleared Volume")) or 0.0}
        so = str(r.get("System Flag") or "").strip().upper() == "T"
        t = t0
        while t < t1:
            d, sp = _sp_of(t)
            t += timedelta(minutes=30)
            if t <= lo or d > end:
                continue
            for ic, mw in per_link.items():
                vol = sign * mw * 0.5
                x = acc[(d, sp, ic, AUCTION_PARTY, "trade", so, vol > 0)]
                x[0] += vol
                x[1] += vol * vwa if vwa is not None else 0.0
                x[2] += 1
                if vwa is not None and prices:
                    x[3] = max(prices) if x[3] is None else max(x[3], *prices)
                    x[4] = min(prices) if x[4] is None else min(x[4], *prices)
    return [(k[0], k[1], k[2], k[3], k[4], k[5], *v) for k, v in acc.items()]


def fetch_flows(client: httpx.Client, start: date, end: date) -> list[tuple]:
    """Half-hourly physical flow per link (MW, positive = import into GB), a month per request."""
    from .costs import _get, _months  # costs imports this module

    rows, seen = [], set()
    for first, nxt in _months(start, end):
        a, b = max(first, start), min(nxt - timedelta(days=1), end)
        data = _get(client, f"{ELEXON}/datasets/FUELHH/stream", {"settlementDateFrom": a.isoformat(), "settlementDateTo": b.isoformat()})
        data = data["data"] if isinstance(data, dict) else data
        for r in data:
            ic = FUEL.get(r.get("fuelType"))
            if ic is None or not r.get("settlementDate") or r.get("generation") is None:
                continue
            key = (r["settlementDate"], r["settlementPeriod"], ic)
            if key in seen:
                continue
            seen.add(key)
            rows.append((date.fromisoformat(r["settlementDate"]), int(r["settlementPeriod"]), ic, float(r["generation"])))
    return rows


# ---------------------------------------------------------------- stores

def _current(path, schema: pa.Schema) -> bool:
    """The file exists with every column of ``schema`` (files from older versions lack the price columns)."""
    return path.exists() and set(schema.names) <= set(pq.read_schema(path).names)


def held() -> bool:
    """True once a first backfill has stored something in the current layout (a refresh is then incremental)."""
    return _current(TRADE_PATH, TRADE_SCHEMA) and pq.read_metadata(TRADE_PATH).num_rows > 0


def _merge(path, schema: pa.Schema, rows: list[tuple], start: date, end: date) -> None:
    """Replace what is held for settlement dates in [start, end] with ``rows``; keep everything else."""
    old = pq.read_table(path) if _current(path, schema) else schema.empty_table()
    keep = [r for r in zip(*(old[c].to_pylist() for c in schema.names)) if not (start <= r[0] <= end)]
    allrows = sorted(keep + rows, key=lambda r: (r[0], r[1], r[2]))
    cols = list(zip(*allrows)) if allrows else [[] for _ in schema]
    store._atomic_write(pa.table({f.name: pa.array(c, type=f.type) for f, c in zip(schema, cols)}, schema=schema), path)


def merge_trades(rows: list[tuple], start: date, end: date) -> None:
    _merge(TRADE_PATH, TRADE_SCHEMA, rows, start, end)


def merge_flows(rows: list[tuple], start: date, end: date) -> None:
    _merge(FLOW_PATH, FLOW_SCHEMA, rows, start, end)


def ensure_layout() -> None:
    """Create empty files, or reset ones from an older layout (the next refresh then backfills them)."""
    for path, schema in ((TRADE_PATH, TRADE_SCHEMA), (FLOW_PATH, FLOW_SCHEMA)):
        if not _current(path, schema):
            store._atomic_write(schema.empty_table(), path)
