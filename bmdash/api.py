"""FastAPI backend: aggregate queries over the Parquet store plus on-demand unit detail."""
from __future__ import annotations

import asyncio
import json
import threading
from datetime import date, datetime, timedelta
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import ingest, store
from .elexon import Elexon

STATIC = Path(__file__).parent / "static"
app = FastAPI(title="bmdash")

_con = None
_con_lock = threading.Lock()


def q(sql: str, params: list | None = None) -> list[dict]:
    global _con
    with _con_lock:
        if _con is None:
            _con = store.connect()
    cur = _con.cursor()
    try:
        cur.execute(sql, params or [])
        cols = [c[0] for c in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]
    finally:
        cur.close()


# ---------------------------------------------------------------- query building

# Every row of `f` is one unit x period x direction x pair, enriched with reference data.
BASE = """
SELECT b.settlement_date, b.sp, b.bm_unit, b.direction, b.pair, b.volume, b.cashflow,
       b.volume_original, b.volume_tagged, b.volume_repriced, b.volume_orig_priced,
       b.so_flag, b.n_acceptances,
       coalesce(u.lead_party, b.lead_party, 'Unknown') AS party,
       coalesce(b.bm_unit_type, u.bm_unit_type, '?') AS unit_type,
       coalesce(u.tech, 'Other') AS tech,
       coalesce(u.fuel_type, 'Unclassified') AS fuel,
       coalesce(u.gsp_group, 'Transmission / n.a.') AS gsp,
       coalesce(u.name, b.bm_unit) AS unit_name
FROM boav b LEFT JOIN units u USING (bm_unit)
"""

DIMS = {
    "direction": "direction",
    "tech": "tech",
    "fuel": "fuel",
    "party": "party",
    "unit": "bm_unit",
    "unit_type": "unit_type",
    "gsp": "gsp",
    "pair": "CASE WHEN pair > 0 THEN 'Pair +' || pair ELSE 'Pair ' || pair END",
    "so": "CASE WHEN so_flag THEN 'SO-flagged' ELSE 'Not SO-flagged' END",
}
SLOT = "(settlement_date + to_minutes(30 * (sp - 1)))"
BUCKETS = {
    "sp": SLOT,
    "hour": f"date_trunc('hour', {SLOT})",
    "day": "CAST(settlement_date AS TIMESTAMP)",
    "week": "date_trunc('week', settlement_date)",
    "month": "date_trunc('month', settlement_date)",
    "tod": "sp",       # time-of-day profile across the whole range
    "none": "0",
}
MEASURES = """
    sum(volume) FILTER (direction = 'offer') AS offer_vol,
    sum(volume) FILTER (direction = 'bid') AS bid_vol,
    sum(cashflow) FILTER (direction = 'offer') AS offer_cash,
    sum(cashflow) FILTER (direction = 'bid') AS bid_cash
"""


class Filters:
    """Shared query-string filters: date range plus comma-separated dimension values."""

    def __init__(self, start: date, end: date, **dims: str | None):
        self.where = ["settlement_date BETWEEN ? AND ?"]
        self.params: list = [start, end]
        for dim, raw in dims.items():
            if not raw:
                continue
            vals = [v for v in raw.split("|") if v]
            if dim == "so":
                self.where.append("so_flag" if vals[0] == "SO-flagged" else "NOT so_flag")
                continue
            self.where.append(f"{DIMS[dim]} IN ({','.join('?' * len(vals))})")
            self.params += vals

    @property
    def sql(self) -> str:
        return " AND ".join(self.where)


def filters(start: date = Query(alias="from"), end: date = Query(alias="to"),
            direction: str | None = None, tech: str | None = None, fuel: str | None = None,
            party: str | None = None, unit: str | None = None, unit_type: str | None = None,
            gsp: str | None = None, so: str | None = None, pair: str | None = None) -> Filters:
    return Filters(start, end, direction=direction, tech=tech, fuel=fuel, party=party, unit=unit,
                   unit_type=unit_type, gsp=gsp, so=so, pair=pair)


def _clean(rows: list[dict]) -> list[dict]:
    for r in rows:
        for k, v in r.items():
            if isinstance(v, (datetime, date)):
                r[k] = v.isoformat()
    return rows


# ---------------------------------------------------------------- endpoints

from fastapi import Depends  # noqa: E402


@app.get("/api/meta")
def meta():
    held = sorted(store.coverage())
    return {
        "days": held,
        "min": held[0] if held else None,
        "max": held[-1] if held else None,
        "dims": list(DIMS),
        "techs": [r["tech"] for r in q("SELECT DISTINCT tech FROM units ORDER BY 1")],
    }


@app.get("/api/agg")
def agg(f: Filters = Depends(filters), bucket: str = "day", group: str = "none",
        top: int = 8, rank: str = "cash"):
    """Time-bucketed bid/offer volume and cashflow, optionally split by one dimension.
    Groups beyond the `top` largest (by absolute cashflow or volume) fold into 'Other'."""
    if bucket not in BUCKETS or (group != "none" and group not in DIMS):
        raise HTTPException(400, "bad bucket or group")
    b = BUCKETS[bucket]
    if group == "none":
        rows = q(f"WITH f AS ({BASE}) SELECT {b} AS t, 'All' AS g, {MEASURES} FROM f "
                 f"WHERE {f.sql} GROUP BY ALL ORDER BY t", f.params)
        return {"rows": _clean(rows), "groups": ["All"]}
    g = DIMS[group]
    measure = "cashflow" if rank == "cash" else "volume"
    ranked = q(f"WITH f AS ({BASE}) SELECT {g} AS g, sum(abs({measure})) AS m FROM f "
               f"WHERE {f.sql} GROUP BY ALL ORDER BY m DESC", f.params)
    keep = [r["g"] for r in ranked[:top]]
    folded = len(ranked) > top
    if folded:
        ph = ",".join("?" * len(keep))
        gexpr = f"CASE WHEN {g} IN ({ph}) THEN {g} ELSE 'Other (rest)' END"
        params = keep + f.params
    else:
        gexpr, params = g, f.params
    rows = q(f"WITH f AS ({BASE}) SELECT {b} AS t, {gexpr} AS g, {MEASURES} FROM f "
             f"WHERE {f.sql} GROUP BY ALL ORDER BY t", params)
    return {"rows": _clean(rows), "groups": keep + (["Other (rest)"] if folded else []),
            "n_groups": len(ranked)}


@app.get("/api/summary")
def summary(f: Filters = Depends(filters)):
    row = q(f"""WITH f AS ({BASE}) SELECT {MEASURES},
                sum(cashflow) FILTER (so_flag) AS so_cash,
                sum(abs(volume)) FILTER (so_flag) AS so_vol,
                count(DISTINCT bm_unit) AS n_units,
                count(DISTINCT settlement_date) AS n_days
                FROM f WHERE {f.sql}""", f.params)[0]
    start, end = f.params[0], f.params[1]
    row.update(q("""SELECT avg(sbp) AS avg_price, max(sbp) AS max_price, min(sbp) AS min_price,
                    sum(niv) AS niv FROM system_prices WHERE settlement_date BETWEEN ? AND ?""",
                 [start, end])[0])
    row.update(q("""SELECT sum(cost) AS bsad_cost, sum(abs(volume)) AS bsad_vol FROM disbsad
                    WHERE settlement_date BETWEEN ? AND ?""", [start, end])[0])
    return row


@app.get("/api/breakdown")
def breakdown(f: Filters = Depends(filters), group: str = "tech", limit: int = 500):
    if group not in DIMS:
        raise HTTPException(400, "bad group")
    rows = q(f"""WITH f AS ({BASE}) SELECT {DIMS[group]} AS g, {MEASURES},
                 count(DISTINCT bm_unit) AS n_units
                 FROM f WHERE {f.sql} GROUP BY ALL
                 ORDER BY abs(coalesce(offer_cash,0) + coalesce(bid_cash,0)) DESC LIMIT {int(limit)}""",
             f.params)
    return {"rows": rows}


@app.get("/api/heatmap")
def heatmap(f: Filters = Depends(filters)):
    rows = q(f"WITH f AS ({BASE}) SELECT settlement_date AS d, sp, {MEASURES} FROM f "
             f"WHERE {f.sql} GROUP BY ALL ORDER BY d, sp", f.params)
    return {"rows": _clean(rows)}


@app.get("/api/units")
def units(f: Filters = Depends(filters)):
    rows = q(f"""WITH f AS ({BASE}) SELECT bm_unit, any_value(unit_name) AS name, any_value(tech) AS tech,
                 any_value(fuel) AS fuel, any_value(party) AS party, any_value(unit_type) AS unit_type,
                 any_value(gsp) AS gsp, {MEASURES},
                 count(DISTINCT (settlement_date, sp)) AS n_periods,
                 count(DISTINCT (settlement_date, sp)) FILTER (so_flag) AS n_so_periods
                 FROM f WHERE {f.sql} GROUP BY bm_unit""", f.params)
    return {"rows": rows}


@app.get("/api/unit/{bm_unit}")
def unit_info(bm_unit: str):
    rows = q("SELECT * FROM units WHERE bm_unit = ?", [bm_unit])
    span = q("SELECT min(settlement_date) AS first, max(settlement_date) AS last FROM boav WHERE bm_unit = ?",
             [bm_unit])[0]
    return {"unit": rows[0] if rows else {"bm_unit": bm_unit, "name": bm_unit}, **_clean([span])[0]}


@app.get("/api/periods")
def periods(f: Filters = Depends(filters), limit: int = 2000):
    """Finest grain: unit x period x direction x pair rows (for tables)."""
    rows = q(f"""WITH f AS ({BASE}) SELECT settlement_date, sp, bm_unit, direction, pair, volume, cashflow,
                 volume_original, volume_tagged, volume_repriced, volume_orig_priced, so_flag, n_acceptances
                 FROM f WHERE {f.sql} ORDER BY settlement_date DESC, sp DESC, bm_unit, pair
                 LIMIT {int(limit)}""", f.params)
    return {"rows": _clean(rows)}


@app.get("/api/acceptances")
def acceptances(unit: str, start: date = Query(alias="from"), end: date = Query(alias="to"),
                limit: int = 2000):
    rows = q(f"""SELECT * FROM acceptances WHERE bm_unit = ? AND settlement_date BETWEEN ? AND ?
                 ORDER BY time_from DESC, acceptance_number DESC LIMIT {int(limit)}""", [unit, start, end])
    return {"rows": _clean(rows)}


@app.get("/api/prices")
def prices(start: date = Query(alias="from"), end: date = Query(alias="to"), bucket: str = "day"):
    if bucket not in BUCKETS:
        raise HTTPException(400, "bad bucket")
    rows = q(f"""SELECT {BUCKETS[bucket]} AS t, avg(sbp) AS price, min(sbp) AS price_min, max(sbp) AS price_max,
                 sum(niv) AS niv FROM system_prices WHERE settlement_date BETWEEN ? AND ?
                 GROUP BY ALL ORDER BY t""", [start, end])
    return {"rows": _clean(rows)}


@app.get("/api/bsad")
def bsad(start: date = Query(alias="from"), end: date = Query(alias="to"), bucket: str = "day"):
    if bucket not in BUCKETS:
        raise HTTPException(400, "bad bucket")
    rows = q(f"""SELECT {BUCKETS[bucket]} AS t,
                 CASE WHEN so_flag THEN 'System (SO-flagged)' ELSE 'Energy' END AS g,
                 sum(cost) AS cost, sum(volume) AS volume
                 FROM disbsad WHERE settlement_date BETWEEN ? AND ? GROUP BY ALL ORDER BY t""", [start, end])
    return {"rows": _clean(rows)}


# ---------------------------------------------------------------- on-demand unit day detail

CACHE = store.DATA / "cache"


@app.get("/api/unit/{bm_unit}/day")
async def unit_day(bm_unit: str, d: date = Query(alias="date")):
    """Physical notifications, limits and the bid-offer price ladder for one unit-day,
    fetched live from Elexon (cached once the day is a few days old)."""
    path = CACHE / f"{bm_unit}_{d.isoformat()}.json"
    if path.exists():
        live = json.loads(path.read_text())
    else:
        start, end = ingest.day_bounds_utc(d)
        rng = {"bmUnit": bm_unit, "from": ingest._iso(start), "to": ingest._iso(end), "format": "json"}
        async with Elexon(concurrency=4) as api:
            try:
                phys, bod = await asyncio.gather(
                    api.get("/balancing/physical", {**rng, "dataset": ["PN", "MELS", "MILS"]}),
                    api.get("/balancing/bid-offer", rng))
            except Exception as e:
                raise HTTPException(502, f"Elexon: {e}")
        ds = d.isoformat()
        live = {
            "physical": [{k: r.get(k) for k in ("dataset", "timeFrom", "timeTo", "levelFrom", "levelTo")}
                         for r in phys if r.get("settlementDate") == ds],
            "bod": [{"sp": r["settlementPeriod"], "pair": r["pairId"], "levelFrom": r["levelFrom"],
                     "levelTo": r["levelTo"], "bid": r["bid"], "offer": r["offer"]}
                    for r in bod if r.get("settlementDate") == ds],
        }
        if d < datetime.now(ingest.LONDON).date() - timedelta(days=ingest.SETTLE_DAYS):
            CACHE.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(live))
    acc = q("""SELECT acceptance_number, acceptance_time, time_from, time_to, level_from, level_to,
               so_flag, stor_flag, rr_flag, deemed_bo FROM acceptances
               WHERE bm_unit = ? AND settlement_date = ? ORDER BY acceptance_time, acceptance_number, time_from""",
            [bm_unit, d])
    per = q("""SELECT sp, direction, pair, volume, cashflow, so_flag FROM boav
               WHERE bm_unit = ? AND settlement_date = ? ORDER BY sp, pair""", [bm_unit, d])
    return {**live, "acceptances": _clean(acc), "periods": per}


# ---------------------------------------------------------------- ingest control

JOB = ingest.Job()


class IngestRequest(BaseModel):
    start: date
    end: date
    force: bool = False


@app.post("/api/ingest")
async def start_ingest(req: IngestRequest):
    if JOB.running:
        raise HTTPException(409, "an ingest is already running")
    if req.end < req.start or (req.end - req.start).days > 3 * 366:
        raise HTTPException(400, "range must be between 1 day and 3 years")
    JOB.running = True
    asyncio.get_running_loop().create_task(ingest.run(req.start, req.end, force=req.force, job=JOB))
    return JOB.as_dict()


@app.get("/api/ingest")
def ingest_status():
    return JOB.as_dict()


# ---------------------------------------------------------------- static app

@app.get("/")
def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-store"})


@app.exception_handler(Exception)
async def on_error(_, exc: Exception):
    return JSONResponse({"detail": str(exc)}, status_code=500)


app.mount("/static", StaticFiles(directory=STATIC), name="static")
