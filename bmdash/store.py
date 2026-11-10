"""Storage layer: one Parquet file per dataset per settlement day, queried through DuckDB views.

Parquet-per-day means the ingester can run (and re-run) alongside the server: files are
written atomically and DuckDB re-globs on every query, so new days simply appear.
"""
from __future__ import annotations

import os
import re
import time
from datetime import date, datetime, timezone
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

DATA = Path(os.environ.get("BMDASH_DATA", Path(__file__).resolve().parent.parent / "data"))

S = pa.string()
F = pa.float64()
B = pa.bool_()
TS = pa.timestamp("us", tz="UTC")

SCHEMAS: dict[str, pa.Schema] = {
    # Accepted bid/offer volumes (DISPTAV) joined with cashflows (EBOCF), one row per
    # unit x settlement period x direction x bid-offer pair. Zero rows are dropped.
    "boav": pa.schema([
        ("settlement_date", pa.date32()), ("sp", pa.int16()), ("start_time", TS),
        ("bm_unit", S), ("ngc_bm_unit", S), ("lead_party", S), ("bm_unit_type", S),
        ("direction", S), ("pair", pa.int16()),
        # volume = accepted MWh (larger magnitude of Original / Tagged, see README)
        ("volume", F), ("volume_original", F), ("volume_tagged", F), ("volume_repriced", F), ("volume_orig_priced", F),
        ("cashflow", F), ("so_flag", B), ("n_acceptances", pa.int32()),
    ]),
    "acceptances": pa.schema([
        ("settlement_date", pa.date32()), ("sp_from", pa.int16()), ("sp_to", pa.int16()),
        ("time_from", TS), ("time_to", TS), ("level_from", F), ("level_to", F),
        ("bm_unit", S), ("ngc_bm_unit", S), ("acceptance_number", pa.int64()),
        ("acceptance_time", TS), ("deemed_bo", B), ("so_flag", B), ("stor_flag", B),
        ("rr_flag", B), ("amendment_flag", S),
    ]),
    "system_prices": pa.schema([
        ("settlement_date", pa.date32()), ("sp", pa.int16()), ("start_time", TS),
        ("ssp", F), ("sbp", F), ("niv", F), ("price_derivation_code", S),
        ("accepted_offer_volume", F), ("accepted_bid_volume", F),
        ("tagged_offer_volume", F), ("tagged_bid_volume", F),
        ("adj_sell_volume", F), ("adj_buy_volume", F),
    ]),
    # Balancing Services Adjustment Data: balancing actions taken outside the BM.
    "disbsad": pa.schema([
        ("settlement_date", pa.date32()), ("sp", pa.int16()), ("id", pa.int32()),
        ("cost", F), ("volume", F), ("so_flag", B), ("stor_flag", B),
        ("party_id", S), ("asset_id", S), ("is_tendered", B), ("service", S),
    ]),
    "units": pa.schema([
        ("bm_unit", S), ("ngc_bm_unit", S), ("name", S), ("fuel_type", S), ("tech", S),
        ("lead_party", S), ("lead_party_id", S), ("bm_unit_type", S), ("gsp_group", S),
        ("generation_capacity", F), ("demand_capacity", F), ("interconnector_id", S),
    ]),
}
DAILY = ["boav", "acceptances", "system_prices", "disbsad"]


def _ts(v):
    if v is None or isinstance(v, datetime):
        return v
    return datetime.fromisoformat(v.replace("Z", "+00:00")).astimezone(timezone.utc)


def _table(name: str, rows: list[dict]) -> pa.Table:
    schema = SCHEMAS[name]
    cols = {}
    for f in schema:
        vals = [r.get(f.name) for r in rows]
        if f.type == TS:
            vals = [_ts(v) for v in vals]
        elif f.type == pa.date32():
            vals = [date.fromisoformat(v) if isinstance(v, str) else v for v in vals]
        elif f.type == F:
            vals = [None if v is None else float(v) for v in vals]
        cols[f.name] = pa.array(vals, type=f.type)
    return pa.table(cols, schema=schema)


def _atomic_write(table: pa.Table, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(f".{os.getpid()}.tmp")
    pq.write_table(table, tmp, compression="zstd")
    for attempt in range(20):  # Windows: a reader may briefly hold the old file open
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            time.sleep(0.1 * (attempt + 1))
    os.replace(tmp, path)


def day_path(name: str, d: date) -> Path:
    return DATA / name / f"{d.isoformat()}.parquet"


def write_day(name: str, d: date, rows: list[dict]) -> None:
    _atomic_write(_table(name, rows), day_path(name, d))


def write_units(rows: list[dict]) -> None:
    _atomic_write(_table("units", rows), DATA / "units.parquet")


def ensure_layout() -> None:
    """Create an empty, correctly-typed placeholder per dataset so globs always match."""
    for name in DAILY:
        p = DATA / name / "_empty.parquet"
        if not p.exists():
            _atomic_write(_table(name, []), p)
    if not (DATA / "units.parquet").exists():
        write_units([])


_DATE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})\.parquet$")


def coverage() -> dict[str, float]:
    """Settlement days held on disk -> mtime of the boav file (the last dataset written)."""
    out: dict[str, float] = {}
    folder = DATA / "boav"
    if folder.exists():
        for p in folder.iterdir():
            m = _DATE_RE.match(p.name)
            if m:
                out[m.group(1)] = p.stat().st_mtime
    return out


def connect() -> duckdb.DuckDBPyConnection:
    ensure_layout()
    con = duckdb.connect(":memory:")
    for name in DAILY:
        glob = (DATA / name / "*.parquet").as_posix()
        con.execute(f"CREATE VIEW {name} AS SELECT * FROM read_parquet('{glob}', union_by_name=true)")
    units = (DATA / "units.parquet").as_posix()
    con.execute(f"CREATE VIEW units AS SELECT * FROM read_parquet('{units}')")
    return con
