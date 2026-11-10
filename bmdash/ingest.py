"""Parallel ingestion of Balancing Mechanism data from Elexon into the Parquet store."""
from __future__ import annotations

import asyncio
import re
import time
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from . import store
from .elexon import Elexon

LONDON = ZoneInfo("Europe/London")
# Indicative data is first published the day after and revised for a few days.
SETTLE_DAYS = 5
PAIR_KEYS = [(f"{sign}{n}", n if sign == "positive" else -n)
             for sign in ("negative", "positive") for n in range(1, 7)]
VOL_COL = {"Original": "volume_original", "Tagged": "volume_tagged",
           "Re-priced": "volume_repriced", "Original-Priced": "volume_orig_priced"}


def day_bounds_utc(d: date) -> tuple[datetime, datetime]:
    start = datetime(d.year, d.month, d.day, tzinfo=LONDON).astimezone(timezone.utc)
    n = d + timedelta(days=1)
    end = datetime(n.year, n.month, n.day, tzinfo=LONDON).astimezone(timezone.utc)
    return start, end


def periods_in_day(d: date) -> int:
    """46, 48 or 50 depending on clock changes."""
    start, end = day_bounds_utc(d)
    return int((end - start).total_seconds() // 1800)


def _iso(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%MZ")


# ---------------------------------------------------------------- reference data

_BATTERY_NAME = re.compile(r"BESS|BATTER|STORAGE|ENERGY STORE", re.I)
_BATTERY_NGC = re.compile(r"^[A-Z0-9]{4}B-\d+$")
_FUEL_TECH = {"CCGT": "Gas", "OCGT": "Gas", "WIND": "Wind", "PS": "Pumped storage",
              "NPSHYD": "Hydro", "BIOMASS": "Biomass", "NUCLEAR": "Nuclear", "COAL": "Coal"}


def classify_tech(u: dict) -> str:
    """Coarse technology label. Elexon's fuelType is null for most non-transmission units,
    so batteries are inferred from the unit name / NESO id pattern (heuristic)."""
    fuel = u.get("fuelType")
    if u.get("interconnectorId") or (fuel or "").startswith("INT") or (u.get("elexonBmUnit") or "").startswith("I_"):
        return "Interconnector"
    if fuel in _FUEL_TECH:
        return _FUEL_TECH[fuel]
    name, ngc = u.get("bmUnitName") or "", u.get("nationalGridBmUnit") or ""
    if _BATTERY_NAME.search(name) or _BATTERY_NGC.match(ngc):
        return "Battery"
    return "Other"


async def ingest_units(api: Elexon) -> int:
    raw = await api.get("/reference/bmunits/all")
    rows, seen = [], set()
    for u in raw:
        # Elexon occasionally lists a unit twice (e.g. T_WLNYO-4); keep one row so joins don't double-count.
        if not u.get("elexonBmUnit") or u["elexonBmUnit"] in seen:
            continue
        seen.add(u["elexonBmUnit"])
        rows.append({
            "bm_unit": u["elexonBmUnit"], "ngc_bm_unit": u.get("nationalGridBmUnit"),
            "name": u.get("bmUnitName"), "fuel_type": u.get("fuelType"), "tech": classify_tech(u),
            "lead_party": u.get("leadPartyName"), "lead_party_id": u.get("leadPartyId"),
            "bm_unit_type": u.get("bmUnitType"), "gsp_group": u.get("gspGroupName"),
            "generation_capacity": u.get("generationCapacity"),
            "demand_capacity": u.get("demandCapacity"),
            "interconnector_id": u.get("interconnectorId"),
        })
    store.write_units(rows)
    return len(rows)


# ---------------------------------------------------------------- one settlement day

async def _fetch_acceptances(api: Elexon, d: date) -> list[dict]:
    start, end = day_bounds_utc(d)
    raw = await api.get("/datasets/BOALF/stream",
                        {"from": _iso(start - timedelta(hours=6)), "to": _iso(end + timedelta(hours=6))})
    ds, seen, rows = d.isoformat(), set(), []
    for r in raw:
        if r.get("settlementDate") != ds:
            continue
        key = (r["bmUnit"], r["acceptanceNumber"], r["timeFrom"], r["timeTo"], r["levelFrom"], r["levelTo"])
        if key in seen:
            continue
        seen.add(key)
        rows.append({
            "settlement_date": ds, "sp_from": r["settlementPeriodFrom"], "sp_to": r["settlementPeriodTo"],
            "time_from": r["timeFrom"], "time_to": r["timeTo"],
            "level_from": r["levelFrom"], "level_to": r["levelTo"],
            "bm_unit": r["bmUnit"], "ngc_bm_unit": r.get("nationalGridBmUnit"),
            "acceptance_number": r["acceptanceNumber"], "acceptance_time": r["acceptanceTime"],
            "deemed_bo": r.get("deemedBoFlag"), "so_flag": r.get("soFlag"),
            "stor_flag": r.get("storFlag"), "rr_flag": r.get("rrFlag"),
            "amendment_flag": r.get("amendmentFlag"),
        })
    return rows


async def _fetch_prices(api: Elexon, d: date) -> list[dict]:
    raw = await api.get(f"/balancing/settlement/system-prices/{d.isoformat()}", {"format": "json"})
    return [{
        "settlement_date": r["settlementDate"], "sp": r["settlementPeriod"], "start_time": r["startTime"],
        "ssp": r.get("systemSellPrice"), "sbp": r.get("systemBuyPrice"), "niv": r.get("netImbalanceVolume"),
        "price_derivation_code": r.get("priceDerivationCode"),
        "accepted_offer_volume": r.get("totalAcceptedOfferVolume"),
        "accepted_bid_volume": r.get("totalAcceptedBidVolume"),
        "tagged_offer_volume": r.get("totalSystemTaggedAcceptedOfferVolume"),
        "tagged_bid_volume": r.get("totalSystemTaggedAcceptedBidVolume"),
        "adj_sell_volume": r.get("totalAdjustmentSellVolume"),
        "adj_buy_volume": r.get("totalAdjustmentBuyVolume"),
    } for r in raw]


async def _fetch_disbsad(api: Elexon, d: date) -> list[dict]:
    start, end = day_bounds_utc(d)
    raw = await api.get("/datasets/DISBSAD/stream",
                        {"from": _iso(start - timedelta(hours=2)), "to": _iso(end + timedelta(hours=2))})
    ds, seen, rows = d.isoformat(), set(), []
    for r in raw:
        key = (r.get("settlementPeriod"), r.get("id"))
        if r.get("settlementDate") != ds or key in seen:
            continue
        seen.add(key)
        rows.append({
            "settlement_date": ds, "sp": r["settlementPeriod"], "id": r.get("id"),
            "cost": r.get("cost"), "volume": r.get("volume"), "so_flag": r.get("soFlag"),
            "stor_flag": r.get("storFlag"), "party_id": r.get("partyId"), "asset_id": r.get("assetId"),
            "is_tendered": r.get("isTendered"), "service": r.get("service"),
        })
    return rows


async def _fetch_boav(api: Elexon, d: date) -> dict[tuple, dict]:
    """Volumes + cashflows for every unit and settlement period, both directions.
    Uses Elexon's whole-day endpoints: four requests per settlement day."""
    ds = d.isoformat()
    base = "/balancing/settlement/indicative"
    jobs = []
    for direction in ("bid", "offer"):
        jobs.append((direction, "v", api.get(f"{base}/volumes/all/{direction}/{ds}", {"format": "json"})))
        jobs.append((direction, "c", api.get(f"{base}/cashflows/all/{direction}/{ds}", {"format": "json"})))
    results = await asyncio.gather(*(j[2] for j in jobs))

    rows: dict[tuple, dict] = {}

    def row(r: dict, direction: str, pair: int) -> dict:
        key = (r["settlementPeriod"], r["bmUnit"], direction, pair)
        if key not in rows:
            rows[key] = {
                "settlement_date": ds, "sp": r["settlementPeriod"], "start_time": r["startTime"],
                "bm_unit": r["bmUnit"], "ngc_bm_unit": r.get("nationalGridBmUnit"),
                "lead_party": r.get("leadPartyName"), "bm_unit_type": r.get("bmUnitType"),
                "direction": direction, "pair": pair,
                "volume": 0.0, "volume_original": 0.0, "volume_tagged": 0.0, "volume_repriced": 0.0,
                "volume_orig_priced": 0.0, "cashflow": 0.0, "so_flag": False, "n_acceptances": 0,
            }
        return rows[key]

    for (direction, kind, _), data in zip(jobs, results):
        for r in data:
            if not r.get("bmUnit"):
                continue
            if kind == "v":
                col = VOL_COL.get(r.get("dataType"))
                pairs = r.get("pairVolumes") or {}
            else:
                col, pairs = "cashflow", r.get("bidOfferPairCashflows") or {}
            if col is None:
                continue
            for key, pair in PAIR_KEYS:
                v = pairs.get(key)
                if v:
                    row(r, direction, pair)[col] = float(v)
    return rows


async def ingest_day(api: Elexon, d: date) -> dict:
    boav, acc, prices, bsad = await asyncio.gather(
        _fetch_boav(api, d), _fetch_acceptances(api, d), _fetch_prices(api, d), _fetch_disbsad(api, d))

    # Flag unit-periods touched by an SO-flagged acceptance (system rather than energy action).
    so: dict[tuple, bool] = defaultdict(bool)
    count: dict[tuple, set] = defaultdict(set)
    for a in acc:
        for sp in range(a["sp_from"], max(a["sp_to"], a["sp_from"]) + 1):
            k = (sp, a["bm_unit"])
            so[k] = so[k] or bool(a["so_flag"])
            count[k].add(a["acceptance_number"])
    for (sp, unit, _, _), r in boav.items():
        # Elexon's "Original" series is zero for SO-flagged actions while "Tagged" carries
        # them; the larger of the two reconciles with DISEBSP total accepted volume.
        r["volume"] = max(r["volume_original"], r["volume_tagged"], key=abs)
        r["so_flag"] = so.get((sp, unit), False)
        r["n_acceptances"] = len(count.get((sp, unit), ()))

    store.write_day("acceptances", d, acc)
    store.write_day("system_prices", d, prices)
    store.write_day("disbsad", d, bsad)
    store.write_day("boav", d, list(boav.values()))  # last: its presence marks the day as held
    return {"date": d.isoformat(), "boav": len(boav), "acceptances": len(acc),
            "prices": len(prices), "disbsad": len(bsad)}


# ---------------------------------------------------------------- ranges / jobs

def daterange(a: date, b: date) -> list[date]:
    return [a + timedelta(days=i) for i in range((b - a).days + 1)]


def days_needed(a: date, b: date, force: bool = False) -> list[date]:
    """Days in [a, b] not held yet, or fetched before their data had settled."""
    today = datetime.now(LONDON).date()
    held = store.coverage()
    out = []
    for d in daterange(a, min(b, today)):
        mtime = held.get(d.isoformat())
        if force or mtime is None:
            out.append(d)
            continue
        settled_at = datetime(d.year, d.month, d.day, tzinfo=LONDON) + timedelta(days=SETTLE_DAYS)
        if mtime < settled_at.timestamp():
            out.append(d)
    return out


@dataclass
class Job:
    start: str = ""
    end: str = ""
    running: bool = False
    total: int = 0
    done: int = 0
    failed: list[str] = field(default_factory=list)
    requests: int = 0
    rows: int = 0
    started_at: float = 0.0
    finished_at: float = 0.0
    last: str = ""
    error: str = ""

    def as_dict(self) -> dict:
        d = dict(self.__dict__)
        d["elapsed"] = round((self.finished_at or time.time()) - self.started_at, 1) if self.started_at else 0
        return d


async def run(a: date, b: date, *, force: bool = False, concurrency: int = 16,
              parallel_days: int = 4, job: Job | None = None, on_day=None) -> Job:
    job = job or Job()
    job.__dict__.update(start=a.isoformat(), end=b.isoformat(), running=True, done=0, failed=[],
                        rows=0, requests=0, error="", started_at=time.time(), finished_at=0.0, last="")
    store.ensure_layout()
    days = days_needed(a, b, force)
    days.sort(reverse=True)  # newest first: the most useful data lands first
    job.total = len(days)
    try:
        async with Elexon(concurrency=concurrency) as api:
            try:
                await ingest_units(api)
            except Exception as e:  # reference data is nice-to-have; keep going
                job.error = f"units: {e}"
            day_sem = asyncio.Semaphore(parallel_days)

            async def one(d: date) -> None:
                async with day_sem:
                    try:
                        res = await ingest_day(api, d)
                        job.rows += res["boav"]
                        job.last = d.isoformat()
                        if on_day:
                            on_day(res)
                    except Exception as e:
                        job.failed.append(d.isoformat())
                        job.error = f"{d}: {e}"
                    finally:
                        job.done += 1
                        job.requests = api.requests

            await asyncio.gather(*(one(d) for d in days))
    finally:
        job.running = False
        job.finished_at = time.time()
    return job
