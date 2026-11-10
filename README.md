# bmdash: GB Balancing Mechanism dashboard

Drill-down dashboard for Balancing Mechanism costs, built on the Elexon Insights (BMRS) API.

## Run

```bash
uv run bmdash ingest --days 90        # backfill (skips days already held)
uv run bmdash serve                   # http://127.0.0.1:8780
```

`bmdash ingest --from 2025-01-01 --to 2025-12-31` fetches an explicit range; `--force` re-fetches.
The Data tab in the dashboard can start the same fetch and shows coverage.

## How it works

- **Ingest** (`bmdash/ingest.py`, `elexon.py`): async httpx with a global request semaphore
  (16 by default) and retry/backoff. Per settlement day it fetches, in parallel, indicative
  volumes (DISPTAV) and cashflows (EBOCF) for every settlement period and both directions
  (about 192 requests), plus one request each for acceptances (BOALF), system prices (DISEBSP)
  and BSAD. About 3 seconds per day; 90 days took 4.5 minutes.
- **Store** (`store.py`): one zstd Parquet file per dataset per settlement day under `data/`,
  written atomically. DuckDB queries them through glob views, so the ingester and the server
  can run at the same time and new days appear without a restart. Days fetched before the data
  had settled (5 days) are re-fetched on the next run.
- **API** (`api.py`): FastAPI. `/api/agg` buckets by settlement period, hour, day, week, month
  or time of day, splits by any dimension and folds the tail into "Other".
- **UI** (`static/`): vanilla JS and ECharts, no build step. All state is in the URL.

## Data notes

- `boav` holds one row per unit x period x direction x bid-offer pair. Net cost is offer
  cashflow plus bid cashflow (bid cashflow is negative when units pay NESO).
- **Accepted volume**: Elexon's "Original" volume series is zero for SO-flagged actions while
  "Tagged" carries them. `volume` takes the larger of the two, which reconciles with the
  DISEBSP total accepted volume to within about 0.1%. The raw series are kept as
  `volume_original`, `volume_tagged`, `volume_repriced`, `volume_orig_priced`.
- **SO flag** is approximate: a unit-period is flagged when any acceptance covering it carries
  the BOALF SO flag, so mixed periods count wholly as flagged.
- **Technology** comes from Elexon's fuel type where present; batteries are inferred from the
  unit name / NESO id, and anything else is "Other".
- Unit day detail (PN, MEL/MIL, bid-offer prices) is fetched live per unit-day and cached
  in `data/cache/` once settled.
- Times are settlement (GB local) time.
