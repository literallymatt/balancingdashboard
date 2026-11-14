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

from . import costs, ingest, remit, store
from .elexon import Elexon

STATIC = Path(__file__).parent / "static"
app = FastAPI(title="bmdash")

_con = None
_con_lock = threading.Lock()
# A dashboard page fires about eight queries at once and each one opens a Parquet file per held day, so
# run only a couple at a time: it keeps open-file use (and memory) bounded however much data is held.
_query_slots = threading.BoundedSemaphore(2)


def q(sql: str, params: list | None = None) -> list[dict]:
    global _con
    with _con_lock:
        if _con is None:
            _con = store.connect()
    with _query_slots:
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


# ---------------------------------------------------------------- total costs (system-level, no unit detail)

MIN_PERIODS = 44  # a NESO day counts as published once it has most of its 46-50 settlement periods


@app.get("/api/costs/monthly")
def costs_monthly(start: date | None = Query(None, alias="from"), end: date | None = Query(None, alias="to")):
    """Monthly balancing costs by source and by purpose, over the days NESO has fully published.

    BM cost is derived as NESO's total (BM + non-BM actions) minus BSAD, which matches unit-level Elexon BM
    cashflows to within about 1% on complete days."""
    lo, hi = start or date(2000, 1, 1), end or date(2100, 1, 1)
    rows = q("""WITH ok AS (SELECT date FROM cost_daily WHERE source = 'neso_purpose' AND category = '_n' AND amount >= ?)
                SELECT strftime(date, '%Y-%m') AS m, source, category, sum(amount) AS v, count(DISTINCT date) AS n
                FROM cost_daily WHERE date BETWEEN ? AND ? AND source IN ('neso_purpose', 'bsad', 'eac')
                AND (source = 'eac' OR date IN (SELECT date FROM ok))
                GROUP BY ALL""", [MIN_PERIODS, lo, hi])
    months: dict[str, dict] = {}
    for r in rows:
        m = months.setdefault(r["m"], {"month": r["m"], "days": 0, "purpose": {}, "bsad": {}, "eac": {}})
        if r["source"] == "neso_purpose":
            if r["category"] == "_n":
                m["days"] = r["n"]
            else:
                m["purpose"][r["category"]] = r["v"]
        elif r["source"] == "bsad":
            m["bsad"][r["category"]] = r["v"]
        else:
            m["eac"][r["category"]] = r["v"]
    out = []
    for key in sorted(months):
        m = months[key]
        y, mo = int(key[:4]), int(key[5:7])
        m["calendar_days"] = (date(y + (mo == 12), mo % 12 + 1, 1) - date(y, mo, 1)).days
        m["neso_total"] = sum(m["purpose"].values())
        m["bsad_total"] = sum(m["bsad"].values())
        m["eac_total"] = sum(m["eac"].values())
        m["bm_derived"] = m["neso_total"] - m["bsad_total"]
        m["partial"] = m["days"] < m["calendar_days"]
        out.append(m)
    through = q("SELECT max(date) AS d FROM cost_daily WHERE source = 'neso_purpose' AND category = '_n' AND amount >= ?", [MIN_PERIODS])[0]["d"]
    return {"months": out, "through": through.isoformat() if through else None, **costs.status(), "running": COSTS_JOB["running"]}


# ---------------------------------------------------------------- network constraints (system-level)

# One row per boundary x half-hour (NESO day-ahead flows and limits). `bind`: the forecast flow reached the limit.
CON = """SELECT settlement_date, sp, grp, limit_mw, flow_mw,
                CASE WHEN limit_mw > 0 AND flow_mw >= limit_mw THEN 1 ELSE 0 END AS bind,
                CASE WHEN limit_mw > 0 THEN flow_mw / limit_mw END AS load,
                CASE WHEN flow_mw > limit_mw THEN (flow_mw - limit_mw) * 0.5 ELSE 0 END AS excess
         FROM constraint_hh WHERE settlement_date BETWEEN ? AND ? AND flow_mw IS NOT NULL"""
# Constraint costs are daily, so finer buckets fall back to days and the time-of-day profile has none.
COST_BUCKETS = {"sp": "CAST(date AS TIMESTAMP)", "hour": "CAST(date AS TIMESTAMP)", "day": "CAST(date AS TIMESTAMP)",
                "week": "date_trunc('week', date)", "month": "date_trunc('month', date)", "none": "0"}


@app.get("/api/constraints/meta")
def constraints_meta():
    span = q("SELECT min(settlement_date) AS min, max(settlement_date) AS max, count(*) AS n FROM constraint_hh")[0]
    groups = q("""SELECT grp AS g, min(settlement_date) AS first, max(settlement_date) AS last, count(*) AS n
                  FROM constraint_hh GROUP BY 1 ORDER BY 1""")
    cost = q("SELECT max(date) AS d FROM cost_daily WHERE source = 'thermal'")[0]["d"]
    return {**_clean([span])[0], "groups": _clean(groups), "costs_through": cost.isoformat() if cost else None,
            **costs.status(), "running": COSTS_JOB["running"]}


@app.get("/api/constraints/agg")
def constraints_agg(start: date = Query(alias="from"), end: date = Query(alias="to"), bucket: str = "day"):
    """Per boundary and time bucket: half-hours held, half-hours at or over the limit, loading (flow / limit) and
    energy over the limit. The '_any' group counts half-hours in which at least one boundary was at its limit."""
    if bucket not in BUCKETS:
        raise HTTPException(400, "bad bucket")
    b = BUCKETS[bucket]
    rows = q(f"""WITH c AS ({CON})
                 SELECT {b} AS t, grp AS g, count(*) AS n, sum(bind) AS n_bind, avg(load) AS load_avg, max(load) AS load_max,
                        avg(flow_mw) AS flow_avg, max(flow_mw) AS flow_max, avg(limit_mw) AS limit_avg,
                        min(limit_mw) AS limit_min, sum(excess) AS excess_mwh
                 FROM c GROUP BY 1, 2
                 UNION ALL
                 SELECT {b} AS t, '_any' AS g, count(*) AS n, sum(bind) AS n_bind, NULL, NULL, NULL, NULL, NULL, NULL, NULL
                 FROM (SELECT settlement_date, sp, max(bind) AS bind FROM c GROUP BY 1, 2) a GROUP BY 1
                 ORDER BY t, g""", [start, end])
    return {"rows": _clean(rows)}


@app.get("/api/constraints/costs")
def constraints_costs(start: date = Query(alias="from"), end: date = Query(alias="to"), bucket: str = "day"):
    """Daily constraint costs: by boundary group ('thermal') and by reason ('constraint_type')."""
    if bucket not in BUCKETS:
        raise HTTPException(400, "bad bucket")
    b = COST_BUCKETS.get(bucket, "0")
    rows = q(f"""SELECT {b} AS t, source, category, sum(amount) AS v, count(DISTINCT date) AS n FROM cost_daily
                 WHERE source IN ('thermal', 'constraint_type') AND date BETWEEN ? AND ? GROUP BY 1, 2, 3 ORDER BY 1""",
             [start, end])
    through = q("SELECT max(date) AS d FROM cost_daily WHERE source = 'thermal'")[0]["d"]
    return {"rows": _clean(rows), "daily": bucket in ("sp", "hour", "tod"), "through": through.isoformat() if through else None}


# ---------------------------------------------------------------- REMIT outages (see remit.py)

def _kind(kind: str) -> str:
    if kind not in remit.KINDS:
        raise HTTPException(400, "bad kind")
    return kind


@app.get("/api/remit/meta")
def remit_meta():
    m, _ = remit.read()
    return {**remit.extent(), "n": m.num_rows, "updated_at": remit.status().get("updated_at"),
            "error": costs.status().get("error", ""), "running": COSTS_JOB["running"]}


@app.get("/api/remit/agg")
def remit_agg(start: date = Query(alias="from"), end: date = Query(alias="to"), bucket: str = "day", kind: str = "production",
              long: bool = False):
    """Average unavailable MW per time bucket, by GSP group, by fuel and by planned / unplanned. `long` includes events
    longer than a year (closed and mothballed stations)."""
    if bucket not in BUCKETS:
        raise HTTPException(400, "bad bucket")
    return remit.aggregate(start, end, _kind(kind), bucket, long)


@app.get("/api/remit/outages")
def remit_outages(t: str, start: date = Query(alias="from"), end: date = Query(alias="to"), bucket: str = "day",
                  kind: str = "production", long: bool = False):
    """Units with capacity unavailable in the time bucket `t` (a label from /api/remit/agg)."""
    if bucket not in BUCKETS:
        raise HTTPException(400, "bad bucket")
    return {"rows": remit.outages(start, end, _kind(kind), bucket, t, long)}


# ---------------------------------------------------------------- interconnector balancing (see interconnectors.py)

# One row of ic_trade is one settlement period x link x counterparty x kind x SO flag x direction (positive volume:
# NESO buys). CASE rather than FILTER so the same SQL runs on the phone's SQLite (Interconnectors.kt).
IC_DIMS = {
    "ic": "ic",
    "direction": "CASE WHEN volume > 0 THEN 'NESO buys' ELSE 'NESO sells' END",
    "party": "party",
    "kind": "CASE WHEN kind = 'soso' THEN 'SO-SO (system operator)' ELSE 'Counterparty trade' END",
    "so": "CASE WHEN so_flag THEN 'System (SO-flagged)' ELSE 'Energy' END",
}
IC_MEASURES = """
    sum(CASE WHEN volume > 0 THEN volume END) AS buy_vol, sum(CASE WHEN volume < 0 THEN volume END) AS sell_vol,
    sum(CASE WHEN volume > 0 THEN cost END) AS buy_cost, sum(CASE WHEN volume < 0 THEN cost END) AS sell_cost,
    sum(CASE WHEN volume > 0 AND cost <> 0 THEN volume END) AS buy_pvol, sum(CASE WHEN volume < 0 AND cost <> 0 THEN volume END) AS sell_pvol,
    sum(n) AS n_trades"""
IC_FLOW = """count(*) AS n, avg(flow_mw) AS flow_avg, min(flow_mw) AS flow_min, max(flow_mw) AS flow_max,
    sum(CASE WHEN flow_mw > 0 THEN flow_mw * 0.5 ELSE 0 END) AS import_mwh,
    sum(CASE WHEN flow_mw < 0 THEN flow_mw * 0.5 ELSE 0 END) AS export_mwh"""


def ic_filters(start: date = Query(alias="from"), end: date = Query(alias="to"), ic: str | None = None,
               direction: str | None = None, party: str | None = None, kind: str | None = None, so: str | None = None):
    where, params = ["settlement_date BETWEEN ? AND ?"], [start, end]
    for dim, raw in (("ic", ic), ("direction", direction), ("party", party), ("kind", kind), ("so", so)):
        vals = [v for v in (raw or "").split("|") if v]
        if vals:
            where.append(f"{IC_DIMS[dim]} IN ({','.join('?' * len(vals))})")
            params += vals
    return " AND ".join(where), params


@app.get("/api/ic/meta")
def ic_meta():
    t = q("SELECT min(settlement_date) AS min, max(settlement_date) AS max, count(*) AS n FROM ic_trade")[0]
    f = q("SELECT min(settlement_date) AS min, max(settlement_date) AS max FROM ic_flow")[0]
    lo = [d for d in (t["min"], f["min"]) if d]
    hi = [d for d in (t["max"], f["max"]) if d]
    return {"min": min(lo).isoformat() if lo else None, "max": max(hi).isoformat() if hi else None, "n": t["n"],
            "trades_through": t["max"].isoformat() if t["max"] else None, "flows_through": f["max"].isoformat() if f["max"] else None,
            **costs.status(), "running": COSTS_JOB["running"]}


@app.get("/api/ic/agg")
def ic_agg(f=Depends(ic_filters), bucket: str = "day", group: str = "none", top: int = 8, rank: str = "cash"):
    """NESO's interconnector trades per time bucket, optionally split by one dimension; groups beyond the `top`
    largest (by absolute cost or volume) fold into 'Other (rest)'."""
    if bucket not in BUCKETS or (group != "none" and group not in IC_DIMS):
        raise HTTPException(400, "bad bucket or group")
    where, params = f
    b = BUCKETS[bucket]
    if group == "none":
        rows = q(f"SELECT {b} AS t, 'All' AS g, {IC_MEASURES} FROM ic_trade WHERE {where} GROUP BY 1, 2 ORDER BY 1", params)
        return {"rows": _clean(rows), "groups": ["All"]}
    g = IC_DIMS[group]
    measure = "cost" if rank == "cash" else "volume"
    ranked = q(f"SELECT {g} AS g, sum(abs({measure})) AS m FROM ic_trade WHERE {where} GROUP BY 1 ORDER BY 2 DESC, 1", params)
    keep = [r["g"] for r in ranked[:top]]
    folded = len(ranked) > top
    gexpr, gp = (f"CASE WHEN {g} IN ({','.join('?' * len(keep))}) THEN {g} ELSE 'Other (rest)' END", keep) if folded else (g, [])
    rows = q(f"SELECT {b} AS t, {gexpr} AS g, {IC_MEASURES} FROM ic_trade WHERE {where} GROUP BY 1, 2 ORDER BY 1", gp + params)
    return {"rows": _clean(rows), "groups": keep + (["Other (rest)"] if folded else []), "n_groups": len(ranked)}


@app.get("/api/ic/links")
def ic_links(f=Depends(ic_filters)):
    """Per link over the range: NESO's trades and the physical flow."""
    where, params = f
    trades = {r["ic"]: r for r in q(f"SELECT ic, {IC_MEASURES}, count(DISTINCT party) AS n_parties FROM ic_trade WHERE {where} GROUP BY 1", params)}
    flows = {r["ic"]: r for r in q(f"SELECT ic, {IC_FLOW} FROM ic_flow WHERE settlement_date BETWEEN ? AND ? GROUP BY 1", params[:2])}
    return {"rows": [{"ic": k, **(trades.get(k) or {}), **(flows.get(k) or {})} for k in sorted(set(trades) | set(flows))]}


@app.get("/api/ic/flow")
def ic_flow(start: date = Query(alias="from"), end: date = Query(alias="to"), bucket: str = "day", ic: str | None = None):
    """Physical flow per link and time bucket (MW, positive = import into GB)."""
    if bucket not in BUCKETS:
        raise HTTPException(400, "bad bucket")
    vals = [v for v in (ic or "").split("|") if v]
    cond = f" AND ic IN ({','.join('?' * len(vals))})" if vals else ""
    rows = q(f"SELECT {BUCKETS[bucket]} AS t, ic AS g, {IC_FLOW} FROM ic_flow WHERE settlement_date BETWEEN ? AND ?{cond} GROUP BY 1, 2 ORDER BY 1, 2",
             [start, end, *vals])
    return {"rows": _clean(rows)}


# ---------------------------------------------------------------- Demand Flexibility Service (see dfs.py)

# dfs_hh: one row per event half-hour (requirement, procured, cost, settled). dfs_bid: one row per bid (DFS unit x
# half-hour). Volumes are MW for a half-hour, so MWh = MW x 0.5. CASE rather than FILTER so the same SQL runs on the
# phone's SQLite (Dfs.kt).
DFS_DIMS = {
    "direction": "direction",
    "tag": "CASE WHEN tag = '' THEN 'Not stated' ELSE tag END",
    "party": "party",
    "zone": "CASE WHEN zone IS NULL THEN 'No zone' ELSE 'Zone ' || CAST(zone AS VARCHAR) END",
    "unit": "unit",
}
DFS_HH_GROUPS = ("direction", "tag")  # dfs_hh has no provider or zone
DFS_HH = """sum(req_mw) * 0.5 AS req_mwh, sum(procured_mw) * 0.5 AS proc_mwh, sum(cost) AS cost,
    sum(settled_mw) * 0.5 AS settled_mwh, sum(settled_cost) AS settled_cost,
    sum(CASE WHEN settled_mw IS NOT NULL THEN procured_mw END) * 0.5 AS proc_settled_mwh,
    count(*) AS n_hh, count(DISTINCT event) AS n_events"""
DFS_BID = """sum(mw) * 0.5 AS offered_mwh, sum(CASE WHEN accepted THEN mw END) * 0.5 AS proc_mwh,
    sum(CASE WHEN accepted THEN mw * 0.5 * price END) AS cost, count(*) AS n_bids,
    sum(CASE WHEN accepted THEN 1 ELSE 0 END) AS n_accepted, count(DISTINCT unit) AS n_units, count(DISTINCT event) AS n_events,
    min(CASE WHEN accepted THEN price END) AS price_min, max(CASE WHEN accepted THEN price END) AS price_max"""


def dfs_filters(start: date = Query(alias="from"), end: date = Query(alias="to"), direction: str | None = None,
                tag: str | None = None, test: bool = False):
    """Range, event direction and tag, and whether to include NESO's test events (left out by default)."""
    where, params = ["settlement_date BETWEEN ? AND ?"], [start, end]
    if not test:
        where.append("live")
    for dim, raw in (("direction", direction), ("tag", tag)):
        vals = [v for v in (raw or "").split("|") if v]
        if vals:
            where.append(f"{DFS_DIMS[dim]} IN ({','.join('?' * len(vals))})")
            params += vals
    return " AND ".join(where), params


def _party(where: str, params: list, party: str | None) -> tuple[str, list]:
    vals = [v for v in (party or "").split("|") if v]
    return (f"{where} AND party IN ({','.join('?' * len(vals))})", params + vals) if vals else (where, params)


@app.get("/api/dfs/meta")
def dfs_meta():
    t = q("SELECT min(settlement_date) AS min, max(settlement_date) AS max, count(DISTINCT event) AS n_events FROM dfs_hh WHERE live")[0]
    s = q("SELECT max(settlement_date) AS d FROM dfs_hh WHERE settled_mw IS NOT NULL")[0]
    return {**_clean([t])[0], "settled_through": s["d"].isoformat() if s["d"] else None, **costs.status(), "running": COSTS_JOB["running"]}


@app.get("/api/dfs/agg")
def dfs_agg(f=Depends(dfs_filters), bucket: str = "day", group: str = "none", party: str | None = None, top: int = 8, rank: str = "cash"):
    """Per time bucket. With no split, or split by direction or tag, from the event half-hours (requirement, procured,
    cost, settled); split by provider or zone, or filtered to a provider, from the bids (offered, procured, cost)."""
    if bucket not in BUCKETS or (group != "none" and group not in DFS_DIMS):
        raise HTTPException(400, "bad bucket or group")
    where, params = f
    b = BUCKETS[bucket]
    bids = group not in ("none", *DFS_HH_GROUPS) or bool(party)
    table, measures = ("dfs_bid", DFS_BID) if bids else ("dfs_hh", DFS_HH)
    if bids:
        where, params = _party(where, params, party)
    if group == "none":
        rows = q(f"SELECT {b} AS t, 'All' AS g, {measures} FROM {table} WHERE {where} GROUP BY 1, 2 ORDER BY 1", params)
        return {"rows": _clean(rows), "groups": ["All"], "source": "bids" if bids else "events"}
    g = DFS_DIMS[group]
    if bids:
        m = "CASE WHEN accepted THEN mw * price END" if rank == "cash" else "CASE WHEN accepted THEN mw END"
    else:
        m = "cost" if rank == "cash" else "procured_mw"
    ranked = q(f"SELECT {g} AS g, coalesce(sum({m}), 0) AS m FROM {table} WHERE {where} GROUP BY 1 ORDER BY 2 DESC, 1", params)
    keep = [r["g"] for r in ranked[:top]]
    folded = len(ranked) > top
    gexpr, gp = (f"CASE WHEN {g} IN ({','.join('?' * len(keep))}) THEN {g} ELSE 'Other (rest)' END", keep) if folded else (g, [])
    rows = q(f"SELECT {b} AS t, {gexpr} AS g, {measures} FROM {table} WHERE {where} GROUP BY 1, 2 ORDER BY 1", gp + params)
    return {"rows": _clean(rows), "groups": keep + (["Other (rest)"] if folded else []), "n_groups": len(ranked),
            "source": "bids" if bids else "events"}


@app.get("/api/dfs/events")
def dfs_events(f=Depends(dfs_filters), party: str | None = None):
    """One row per event in range: its window, requirement, procurement, cost and delivery, and who bid. With a provider
    picked, only events it bid in."""
    where, params = f
    ev = q(f"""SELECT event, min(settlement_date) AS date, min(direction) AS direction, min(tag) AS tag, min(CASE WHEN live THEN 1 ELSE 0 END) AS live,
               min(sp) AS sp_from, max(sp) AS sp_to, {DFS_HH}, max(req_mw) AS req_mw
               FROM dfs_hh WHERE {where} GROUP BY 1""", params)
    bw, bp = _party(where, params, party)
    bids = {r["event"]: r for r in q(f"SELECT event, {DFS_BID}, count(DISTINCT party) AS n_parties, "
                                      f"count(DISTINCT CASE WHEN accepted THEN party END) AS n_parties_acc FROM dfs_bid WHERE {bw} GROUP BY 1", bp)}
    out = []
    for r in ev:
        b = bids.get(r["event"])
        if party and not b:
            continue
        x = {**r}
        if b:
            x.update({k: b[k] for k in ("offered_mwh", "n_bids", "n_accepted", "n_units", "n_parties", "n_parties_acc", "price_min", "price_max")})
            if party:  # the provider's own share
                x.update(party_mwh=b["proc_mwh"], party_cost=b["cost"])
        out.append(x)
    out.sort(key=lambda r: (r["date"], r["sp_from"], r["event"]), reverse=True)
    return {"rows": _clean(out)}


@app.get("/api/dfs/providers")
def dfs_providers(f=Depends(dfs_filters), group: str = "party", party: str | None = None):
    """Bids per provider, zone or DFS unit over the range: offered, accepted and what NESO paid."""
    if group not in ("party", "zone", "unit"):
        raise HTTPException(400, "bad group")
    where, params = _party(*f, party)
    g = DFS_DIMS[group]
    extra = ", min(party) AS party" if group == "unit" else ", count(DISTINCT party) AS n_parties"
    rows = q(f"SELECT {g} AS g, {DFS_BID}{extra} FROM dfs_bid WHERE {where} GROUP BY 1 ORDER BY 1", params)
    return {"rows": rows}


@app.get("/api/dfs/bids")
def dfs_bids(event: str):
    """Every bid in one event, with the event's half-hours: the offer stack NESO accepted from."""
    hh = q("SELECT settlement_date AS date, sp, direction, tag, req_mw, procured_mw, cost, settled_mw, settled_cost FROM dfs_hh "
           "WHERE event = ? ORDER BY sp", [event])
    bids = q("SELECT sp, party, unit, zone, mw, price, CASE WHEN accepted THEN 1 ELSE 0 END AS accepted FROM dfs_bid "
             "WHERE event = ? ORDER BY sp, price, unit", [event])
    return {"hh": _clean(hh), "bids": bids}


COSTS_JOB = {"running": False}


def _run_costs():
    try:
        costs.ingest_costs()
    finally:
        COSTS_JOB["running"] = False


@app.get("/api/costs/refresh")
def costs_refresh():
    """Re-fetch the cost sources in the background (idempotent; one run at a time)."""
    if not COSTS_JOB["running"]:
        COSTS_JOB["running"] = True
        threading.Thread(target=_run_costs, daemon=True).start()
    return {"running": True}


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
               WHERE bm_unit = ? AND settlement_date = ? ORDER BY sp, pair, direction""", [bm_unit, d])
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


@app.get("/api/ingest/start")
async def start_ingest_get(start: date, end: date, force: bool = False):
    """GET form of POST /api/ingest (the Android WebView cannot send request bodies to its in-app backend)."""
    return await start_ingest(IngestRequest(start=start, end=end, force=force))


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
