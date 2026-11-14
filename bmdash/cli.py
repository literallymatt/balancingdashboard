"""bmdash command line: `bmdash ingest` to backfill, `bmdash serve` to run the dashboard."""
from __future__ import annotations

import argparse
import asyncio
from datetime import date, datetime, timedelta

from . import ingest


def main() -> None:
    p = argparse.ArgumentParser(prog="bmdash")
    sub = p.add_subparsers(dest="cmd", required=True)

    i = sub.add_parser("ingest", help="fetch BM data from Elexon into ./data")
    i.add_argument("--from", dest="start", help="first settlement date (YYYY-MM-DD)")
    i.add_argument("--to", dest="end", help="last settlement date (default: today)")
    i.add_argument("--days", type=int, default=30, help="days back from --to when --from is omitted")
    i.add_argument("--force", action="store_true", help="re-fetch days already held")
    i.add_argument("--concurrency", type=int, default=16, help="simultaneous HTTP requests")
    i.add_argument("--parallel-days", type=int, default=4)

    c = sub.add_parser("costs", help="fetch system-level balancing costs (NESO, Elexon BSAD, EAC) for the Total costs tab")
    c.add_argument("--from", dest="start", help="first date (default 2025-04-01)")
    i.add_argument("--no-costs", action="store_true", help="skip the system-level cost refresh at the end")

    s = sub.add_parser("serve", help="run the dashboard")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8780)

    a = p.parse_args()
    if a.cmd == "costs":
        from . import costs
        info = costs.ingest_costs(date.fromisoformat(a.start) if a.start else costs.DEFAULT_START)
        if info["error"]:
            raise SystemExit(f"Some sources failed: {info['error']}")
        return
    if a.cmd == "serve":
        import uvicorn
        uvicorn.run("bmdash.api:app", host=a.host, port=a.port)
        return

    end = date.fromisoformat(a.end) if a.end else datetime.now(ingest.LONDON).date()
    start = date.fromisoformat(a.start) if a.start else end - timedelta(days=a.days - 1)

    def on_day(res: dict) -> None:
        print(f"  {res['date']}  {res['boav']:>6} bid/offer rows  {res['acceptances']:>6} acceptances", flush=True)

    print(f"Ingesting {start} .. {end}")
    job = asyncio.run(ingest.run(start, end, force=a.force, concurrency=a.concurrency,
                                 parallel_days=a.parallel_days, on_day=on_day))
    d = job.as_dict()
    print(f"Done: {d['done'] - len(d['failed'])}/{d['total']} days, {d['requests']} requests, "
          f"{d['rows']} rows in {d['elapsed']}s")
    if d["failed"]:
        print("Failed days:", ", ".join(sorted(d["failed"])), "-", d["error"])
        raise SystemExit(1)
    if not a.no_costs:
        from . import costs
        print("System-level costs:")
        try:
            costs.ingest_costs()
        except Exception as e:  # offline or a source is down: the unit-level data is already saved
            print("  skipped:", e)


if __name__ == "__main__":
    main()
