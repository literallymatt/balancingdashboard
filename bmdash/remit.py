"""REMIT outage messages from Elexon, for the REMIT tab.

Market participants must publish every planned or unplanned change of 100 MW or more to a unit's availability as a
REMIT "unavailability of electricity facilities" message: the unit, its normal capacity, the capacity still available,
the event's start and end and, often, an outage profile (the available capacity step by step through the event).
Messages are revised as an outage develops; only the latest revision of each message (``mrid``) is kept, and
messages withdrawn by the participant (status "Dismissed") are ignored when adding up.

Stored in two files under ``data/``:

- ``remit_msg.parquet``: one row per message (latest revision), with the unit's GSP group.
- ``remit_seg.parquet``: the unavailable MW through the event, one row per profile step (one row when the message
  has no profile). Times are epoch seconds (UTC).

**GSP group.** Elexon's reference data gives a GSP group for embedded units but not for transmission-connected ones,
which are most of the capacity in REMIT. Their transmission loss factor, though, is set per GSP-group zone (one value
per zone per season), so a transmission unit's loss factor identifies its zone: matched against the loss factors of
units whose GSP group is known, this places all but a sliver of REMIT capacity (over the year to November 2026, under
0.1% of the unavailable MW outside closures). The rest show as "Unknown".

**Adding up.** A unit's unavailable MW in a half-hour is the time-weighted average across the half-hour of its
normal capacity minus the profile's available capacity (or the message's own unavailable capacity when it has no
profile). Events longer than a year are left out by default: they are closed or mothballed stations, which REMIT
keeps as open-ended outages. When several live messages cover the same unit and half-hour (a planned outage and an unplanned extension,
say) the largest is taken rather than the sum, so an outage reported twice is not counted twice.
"""
from __future__ import annotations

import json
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone

import httpx
import pyarrow as pa
import pyarrow.parquet as pq

from . import store
from .ingest import LONDON, day_bounds_utc, periods_in_day

ELEXON = "https://data.elexon.co.uk/bmrs/api/v1"
DEFAULT_START = date(2025, 4, 1)  # same as the Total costs and Constraints data
AHEAD = 28  # days: planned outages are published in advance, so the tab can look this far forward
BATCH = 100  # messages per request
KINDS = {"production": "Production unavailability", "consumption": "Consumption unavailability"}
MSG_TYPE = "UnavailabilitiesOfElectricityFacilities"
# Closed and mothballed stations stay in REMIT as open-ended "outages" (Ratcliffe, Fiddler's Ferry and Dungeness B run
# to 2050), which would swamp everything else, so events longer than this are left out unless asked for.
LONG_TERM = 365 * 86400

MSG_SCHEMA = pa.schema([
    ("mrid", pa.string()), ("revision", pa.int32()), ("msg_id", pa.int64()), ("published", pa.int64()),
    ("kind", pa.string()), ("planned", pa.bool_()), ("status", pa.string()), ("asset_id", pa.string()),
    ("unit_name", pa.string()), ("fuel", pa.string()), ("gsp_group", pa.string()), ("normal_mw", pa.float64()),
    ("available_mw", pa.float64()), ("unavailable_mw", pa.float64()), ("t_start", pa.int64()), ("t_end", pa.int64()),
    ("cause", pa.string()), ("participant", pa.string()),
])
SEG_SCHEMA = pa.schema([("mrid", pa.string()), ("t0", pa.int64()), ("t1", pa.int64()), ("mw", pa.float64())])
MSG_PATH = store.DATA / "remit_msg.parquet"
SEG_PATH = store.DATA / "remit_seg.parquet"
META = store.DATA / "remit_meta.json"


def _epoch(s: str | None) -> int | None:
    if not s:
        return None
    return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())


def _iso(t: int) -> str:
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%MZ")


def _get(client: httpx.Client, path: str, params=None) -> list[dict]:
    last: Exception | None = None
    for attempt in range(5):
        try:
            r = client.get(ELEXON + path, params=params, timeout=60)
            if r.status_code == 200:
                body = r.json()
                return body["data"] if isinstance(body, dict) else body
            if r.status_code == 404:
                return []
            if r.status_code not in (429, 500, 502, 503, 504):
                raise RuntimeError(f"Elexon {r.status_code} for {path}: {r.text[:200]}")
            last = RuntimeError(f"HTTP {r.status_code}")
        except httpx.HTTPError as e:
            last = e
        time.sleep(min(20.0, 1.0 * 2 ** attempt))
    raise RuntimeError(f"request failed after retries: {path}: {last!r}")


# ---------------------------------------------------------------- unit -> GSP group

def unit_places(ref: list[dict]) -> dict[str, tuple[str | None, str | None]]:
    """BM unit id (Elexon and NESO ids both) -> (name, GSP group id such as '_N'), from Elexon's reference data.

    Units without a GSP group (transmission-connected ones) are placed by their transmission loss factor: each
    GSP-group zone has one loss factor for most of its units, so a value shared by 20 or more units of one known
    group identifies that group. Less common values fall back to whichever known group mostly uses them."""
    by_tlf: dict[str, Counter] = defaultdict(Counter)
    for u in ref:
        if u.get("gspGroupId") and u.get("transmissionLossFactor") is not None:
            by_tlf[u["transmissionLossFactor"]][u["gspGroupId"]] += 1
    zone = {}
    for tlf, groups in by_tlf.items():
        g, n = groups.most_common(1)[0]
        zone[tlf] = (g, n)
    out: dict[str, tuple[str | None, str | None]] = {}
    for u in ref:
        g = u.get("gspGroupId")
        if not g:
            z = zone.get(u.get("transmissionLossFactor"))
            g = z[0] if z else None
        place = (u.get("bmUnitName"), g)
        for k in (u.get("elexonBmUnit"), u.get("nationalGridBmUnit")):
            if k and k not in out:
                out[k] = place
    return out


# ---------------------------------------------------------------- fetch

def parse(m: dict, places: dict) -> tuple[tuple, list[tuple]] | None:
    """One Elexon REMIT message -> (message row, segment rows); None when it is not a unit unavailability."""
    kind = next((k for k, v in KINDS.items() if v == m.get("eventType")), None)
    if m.get("messageType") != MSG_TYPE or kind is None or not m.get("mrid"):
        return None
    t0, t1 = _epoch(m.get("eventStartTime")), _epoch(m.get("eventEndTime"))
    if t0 is None or t1 is None:
        return None
    asset = m.get("assetId") or m.get("affectedUnit") or ""
    name, gsp = places.get(asset) or places.get(m.get("affectedUnit") or "") or (None, None)
    normal = m.get("normalCapacity")
    unavail = m.get("unavailableCapacity")
    if unavail is None and normal is not None and m.get("availableCapacity") is not None:
        unavail = normal - m["availableCapacity"]
    segs = []
    prof = m.get("outageProfile") or []
    if prof and normal is not None:
        for p in prof:
            a, b = _epoch(p.get("startTime")), _epoch(p.get("endTime"))
            if a is None or b is None or b <= a or p.get("capacity") is None:
                continue
            segs.append((m["mrid"], a, b, max(0.0, float(normal) - float(p["capacity"]))))
    elif unavail is not None:
        segs.append((m["mrid"], t0, t1, max(0.0, float(unavail))))
    row = (m["mrid"], int(m.get("revisionNumber") or 0), int(m.get("id") or 0), _epoch(m.get("publishTime")) or 0, kind,
           m.get("unavailabilityType") == "Planned", m.get("eventStatus") or "", asset, name, m.get("fuelType"), gsp,
           None if normal is None else float(normal),
           None if m.get("availableCapacity") is None else float(m["availableCapacity"]),
           None if unavail is None else float(unavail), t0, t1, m.get("cause"), m.get("participantId"))
    return row, segs


def _listing(client: httpx.Client, kind: str, a: datetime, b: datetime, **extra) -> list[dict]:
    """Message ids (with mrid and revision) from /remit/list/by-event or /by-publish, a week at a time (the API's limit)."""
    weeks = []
    while a < b:
        weeks.append((a, min(a + timedelta(days=7), b)))
        a = weeks[-1][1]
    fmt = "%Y-%m-%dT%H:%MZ"
    with ThreadPoolExecutor(4) as pool:  # a few at a time: a long backfill is about 90 weeks
        parts = pool.map(lambda w: _get(client, f"/remit/list/{kind}", {"from": w[0].strftime(fmt), "to": w[1].strftime(fmt),
                                                                       "messageType": MSG_TYPE, **extra}), weeks)
        return [e for part in parts for e in part]


def read() -> tuple[pa.Table, pa.Table]:
    m = pq.read_table(MSG_PATH) if MSG_PATH.exists() else MSG_SCHEMA.empty_table()
    s = pq.read_table(SEG_PATH) if SEG_PATH.exists() else SEG_SCHEMA.empty_table()
    return m, s


def status() -> dict:
    try:
        return json.loads(META.read_text())
    except (OSError, ValueError):
        return {}


def ingest_remit(client: httpx.Client, log=print) -> int:
    """Fetch new and revised REMIT unavailability messages; returns how many were stored.

    First run: every message whose event overlaps DEFAULT_START .. today + AHEAD (latest revisions only). Later runs:
    everything published since the last run, plus the forward window again (so planned outages published long ago
    for dates that have only now come into the window are picked up)."""
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    msgs, segs = read()
    held = dict(zip(msgs["mrid"].to_pylist(), msgs["revision"].to_pylist()))
    meta = status()
    ahead = now + timedelta(days=AHEAD)
    if not held or not meta.get("published_to"):
        start = datetime(DEFAULT_START.year, DEFAULT_START.month, DEFAULT_START.day, tzinfo=timezone.utc)
        listing = _listing(client, "by-event", start, ahead, latestRevisionOnly="true")
        first = DEFAULT_START.isoformat()
    else:
        since = datetime.fromtimestamp(meta["published_to"], timezone.utc) - timedelta(hours=1)
        listing = _listing(client, "by-publish", since, now) + _listing(client, "by-event", now, ahead, latestRevisionOnly="true")
        first = meta.get("start") or DEFAULT_START.isoformat()
    latest: dict[str, tuple[int, int]] = {}  # mrid -> (revision, message id)
    for e in listing:
        r = int(e.get("revisionNumber") or 0)
        if e.get("mrid") and (e["mrid"] not in latest or r > latest[e["mrid"]][0]):
            latest[e["mrid"]] = (r, int(e["id"]))
    want = sorted(i for mrid, (r, i) in latest.items() if mrid not in held or r > held[mrid])
    log(f"  remit: {len(listing)} listed, {len(want)} new or revised")
    places = unit_places(_get(client, "/reference/bmunits/all")) if want else {}
    new_m, new_s = {}, {}
    batches = [want[i:i + BATCH] for i in range(0, len(want), BATCH)]
    with ThreadPoolExecutor(4) as pool:
        got = [m for part in pool.map(lambda ids: _get(client, "/remit", [("messageId", str(x)) for x in ids]), batches) for m in part]
    for m in got:
        p = parse(m, places)
        if p and (p[0][0] not in new_m or p[0][1] > new_m[p[0][0]][1]):
            new_m[p[0][0]], new_s[p[0][0]] = p
    if new_m:
        cols = MSG_SCHEMA.names
        keep_m = [r for r in zip(*(msgs[c].to_pylist() for c in cols)) if r[0] not in new_m]
        keep_s = [r for r in zip(*(segs[c].to_pylist() for c in SEG_SCHEMA.names)) if r[0] not in new_m]
        _write(keep_m + list(new_m.values()), MSG_SCHEMA, MSG_PATH)
        _write(keep_s + [r for v in new_s.values() for r in v], SEG_SCHEMA, SEG_PATH)
    META.write_text(json.dumps({"start": first, "published_to": int(now.timestamp()), "updated_at": time.time()}))
    log(f"  remit: {len(new_m)} messages stored")
    return len(new_m)


def _write(rows: list[tuple], schema: pa.Schema, path) -> None:
    cols = list(zip(*rows)) if rows else [[] for _ in schema]
    store._atomic_write(pa.table({f.name: pa.array(c, type=f.type) for f, c in zip(schema, cols)}, schema=schema), path)


# ---------------------------------------------------------------- adding up (mirrored in android core Remit.kt)

HH = 1800


def slot_grid(start: date, end: date) -> tuple[int, list[str], list[int]]:
    """Half-hours from the start of settlement day ``start`` to the end of ``end``: (first slot's epoch, each slot's
    settlement date, each slot's settlement period). Clock-change days have 46 or 50."""
    lo = int(day_bounds_utc(start)[0].timestamp())
    dates, sps = [], []
    d = start
    while d <= end:
        n = periods_in_day(d)
        dates += [d.isoformat()] * n
        sps += range(1, n + 1)
        d += timedelta(days=1)
    return lo, dates, sps


def bucket_key(d: str, sp: int, bucket: str):
    """The time-bucket label for a settlement period: the same values /api/agg returns for each bucket."""
    if bucket == "tod":
        return sp
    if bucket == "none":
        return 0
    day = date.fromisoformat(d)
    if bucket == "day":
        return f"{d}T00:00:00"
    if bucket == "week":
        return f"{(day - timedelta(days=day.weekday())).isoformat()}T00:00:00"
    if bucket == "month":
        return f"{d[:7]}-01T00:00:00"
    t = datetime(day.year, day.month, day.day) + timedelta(minutes=30 * (sp - 1))
    return t.strftime("%Y-%m-%dT%H:00:00" if bucket == "hour" else "%Y-%m-%dT%H:%M:00")


def slot_runs(segs: list[tuple[int, int, float]], lo: int, n: int) -> list[tuple[int, int, float]]:
    """A message's segments -> runs of half-hour slots [k0, k1) with the average MW in each slot of the run.
    A segment that covers only part of a half-hour contributes its time-weighted share to that slot."""
    out = []
    hi = lo + n * HH
    for t0, t1, mw in segs:
        a, b = max(t0, lo), min(t1, hi)
        if b <= a or mw <= 0:
            continue
        ka, kb = (a - lo) // HH, (b - lo) // HH
        fa, fb = (a - lo) % HH, (b - lo) % HH
        if ka == kb:
            out.append((ka, ka + 1, mw * (b - a) / HH))
            continue
        if fa:
            out.append((ka, ka + 1, mw * (HH - fa) / HH))
            ka += 1
        if ka < kb:
            out.append((ka, kb, mw))
        if fb:
            out.append((kb, kb + 1, mw * fb / HH))
    return out


def sweep(runs: list[tuple], use_max: bool) -> list[tuple]:
    """Overlapping runs (k0, k1, mw, tag) -> disjoint runs. Where runs overlap their MW is added (``use_max`` False:
    pieces of one message) or the largest is kept (True: several messages for one unit); the tag is the largest's."""
    pts = sorted({k for r in runs for k in (r[0], r[1])})
    runs = sorted(runs, key=lambda r: r[0])
    out, active, i = [], [], 0
    for a, b in zip(pts, pts[1:]):
        while i < len(runs) and runs[i][0] <= a:
            active.append(runs[i])
            i += 1
        active = [r for r in active if r[1] > a]  # every active run now spans [a, b): b is the next breakpoint
        if not active:
            continue
        v, top, tag = 0.0, -1.0, None
        for r in active:
            v = max(v, r[2]) if use_max else v + r[2]
            if r[2] > top:
                top, tag = r[2], r[3]
        out.append((a, b, v, tag))
    return out


def resolve(start: date, end: date, kind: str, long_term: bool = False):
    """Per unit, disjoint runs of unavailable MW over the half-hours of [start, end].

    Returns (lo, dates, sps, units, msgs): units maps asset -> [(k0, k1, mw, mrid)], msgs maps mrid -> message row."""
    lo, dates, sps = slot_grid(start, end)
    n = len(dates)
    hi = lo + n * HH
    m, s = read()
    rows = [dict(zip(MSG_SCHEMA.names, r)) for r in zip(*(m[c].to_pylist() for c in MSG_SCHEMA.names))]
    msgs = {r["mrid"]: r for r in rows if r["kind"] == kind and r["status"] != "Dismissed" and r["t_start"] < hi and r["t_end"] > lo
            and (long_term or r["t_end"] - r["t_start"] <= LONG_TERM)}
    by_msg: dict[str, list] = defaultdict(list)
    for mrid, t0, t1, mw in zip(*(s[c].to_pylist() for c in SEG_SCHEMA.names)):
        if mrid in msgs and t0 < hi and t1 > lo:
            by_msg[mrid].append((t0, t1, mw))
    per_unit: dict[str, list] = defaultdict(list)
    for mrid in sorted(by_msg):
        runs = [(a, b, v, mrid) for a, b, v in slot_runs(by_msg[mrid], lo, n)]
        per_unit[msgs[mrid]["asset_id"]] += sweep(runs, False)
    units = {u: sweep(r, True) for u, r in sorted(per_unit.items())}
    return lo, dates, sps, units, msgs


def _group(msg: dict, dim: str) -> str:
    if dim == "gsp":
        return msg["gsp_group"] or "Unknown"
    if dim == "fuel":
        return msg["fuel"] or "Unknown"
    return "Planned" if msg["planned"] else "Unplanned"


def aggregate(start: date, end: date, kind: str, bucket: str, long_term: bool = False) -> dict:
    """Average unavailable MW per time bucket, split three ways (GSP group, fuel, planned or not)."""
    lo, dates, sps, units, msgs = resolve(start, end, kind, long_term)
    n = len(dates)
    keys = [bucket_key(d, sp, bucket) for d, sp in zip(dates, sps)]
    order = sorted(set(keys)) if bucket == "tod" else list(dict.fromkeys(keys))
    count = Counter(keys)
    out = {"slots": [{"t": t, "n": count[t]} for t in order], "units": len(units)}
    for dim in ("gsp", "fuel", "type"):
        diff: dict[str, list[float]] = {}
        for runs in units.values():
            for a, b, v, mrid in runs:
                d = diff.setdefault(_group(msgs[mrid], dim), [0.0] * (n + 1))
                d[a] += v
                d[b] -= v
        rows = []
        for g in sorted(diff):
            acc: dict = defaultdict(float)
            run = 0.0
            for k in range(n):
                run += diff[g][k]
                acc[keys[k]] += run
            rows += [{"t": t, "g": g, "mw": acc[t] / count[t]} for t in order if abs(acc[t]) > 1e-6]
        out[dim] = rows
    return out


def outages(start: date, end: date, kind: str, bucket: str, t, long_term: bool = False) -> list[dict]:
    """Units with capacity unavailable in one time bucket: average and peak MW over the bucket, and the message
    behind most of it."""
    lo, dates, sps, units, msgs = resolve(start, end, kind, long_term)
    keys = [bucket_key(d, sp, bucket) for d, sp in zip(dates, sps)]
    want = str(t)
    before = [0]
    for k in keys:  # before[k]: slots of the bucket before slot k
        before.append(before[-1] + (str(k) == want))
    nb = before[-1]
    if not nb:
        return []
    out = []
    for asset, runs in units.items():
        tot, peak, best, by = 0.0, 0.0, -1.0, None
        for a, b, v, mrid in runs:
            ov = before[b] - before[a]
            if ov <= 0:
                continue
            tot += v * ov
            peak = max(peak, v)
            if v * ov > best:
                best, by = v * ov, mrid
        if by is None:
            continue
        m = msgs[by]
        out.append({"asset": asset, "name": m["unit_name"], "fuel": m["fuel"], "gsp": m["gsp_group"] or "Unknown",
                    "mw": tot / nb, "mw_max": peak, "normal_mw": m["normal_mw"], "planned": m["planned"],
                    "status": m["status"], "cause": m["cause"], "start": _iso(m["t_start"]), "end": _iso(m["t_end"]),
                    "mrid": m["mrid"], "msg_id": m["msg_id"], "participant": m["participant"]})
    out.sort(key=lambda r: -r["mw"])
    return out


def extent() -> dict:
    """Date range the REMIT tab offers: from the first fetched day to AHEAD days from today."""
    meta = status()
    if not meta.get("published_to"):
        return {"min": None, "max": None}
    today = datetime.now(LONDON).date()
    return {"min": meta.get("start") or DEFAULT_START.isoformat(), "max": (today + timedelta(days=AHEAD)).isoformat()}
