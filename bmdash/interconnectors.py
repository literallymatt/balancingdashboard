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
costs.fetch_bsad), so they cost no extra requests. Physical flows per link come from Elexon's half-hourly generation by
fuel type (``FUELHH``: INTFR, INTIFA2, ... in MW, positive = import into GB).

Stored as ``data/ic_trade.parquet`` (one row per settlement period x link x counterparty x SO flag x direction, summed)
and ``data/ic_flow_hh.parquet`` (one row per settlement period x link). Mirrored on the phone in Interconnectors.kt.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta

import httpx
import pyarrow as pa
import pyarrow.parquet as pq

from . import store

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

TRADE_SCHEMA = pa.schema([
    ("settlement_date", pa.date32()), ("sp", pa.int16()), ("ic", pa.string()), ("party", pa.string()),
    ("kind", pa.string()), ("so_flag", pa.bool_()), ("volume", pa.float64()), ("cost", pa.float64()), ("n", pa.int32()),
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
        self.acc: dict[tuple, list] = defaultdict(lambda: [0.0, 0.0, 0])

    def add(self, r: dict) -> None:
        c = classify(r.get("assetId"))
        vol = r.get("volume")
        if c is None or not vol:
            return
        ic, kind = c
        vol = float(vol)
        key = (r["settlementDate"], int(r["settlementPeriod"]), ic, r.get("partyId") or "Unknown", kind, bool(r.get("soFlag")), vol > 0)
        x = self.acc[key]
        x[0] += vol
        x[1] += float(r.get("cost") or 0)
        x[2] += 1

    def rows(self) -> list[tuple]:
        return [(date.fromisoformat(k[0]), k[1], k[2], k[3], k[4], k[5], v[0], v[1], v[2]) for k, v in self.acc.items()]


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

def held() -> bool:
    """True once a first backfill has stored something (a refresh is then incremental)."""
    return TRADE_PATH.exists() and pq.read_metadata(TRADE_PATH).num_rows > 0


def _merge(path, schema: pa.Schema, rows: list[tuple], start: date, end: date) -> None:
    """Replace what is held for settlement dates in [start, end] with ``rows``; keep everything else."""
    old = pq.read_table(path) if path.exists() else schema.empty_table()
    keep = [r for r in zip(*(old[c].to_pylist() for c in schema.names)) if not (start <= r[0] <= end)]
    allrows = sorted(keep + rows, key=lambda r: (r[0], r[1], r[2]))
    cols = list(zip(*allrows)) if allrows else [[] for _ in schema]
    store._atomic_write(pa.table({f.name: pa.array(c, type=f.type) for f, c in zip(schema, cols)}, schema=schema), path)


def merge_trades(rows: list[tuple], start: date, end: date) -> None:
    _merge(TRADE_PATH, TRADE_SCHEMA, rows, start, end)


def merge_flows(rows: list[tuple], start: date, end: date) -> None:
    _merge(FLOW_PATH, FLOW_SCHEMA, rows, start, end)


def ensure_layout() -> None:
    for path, schema in ((TRADE_PATH, TRADE_SCHEMA), (FLOW_PATH, FLOW_SCHEMA)):
        if not path.exists():
            store._atomic_write(schema.empty_table(), path)
