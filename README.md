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
  (16 by default) and retry/backoff. Elexon offers whole-day endpoints for indicative volumes
  (DISPTAV) and cashflows (EBOCF), so a settlement day is four requests for the bid/offer data
  (volumes and cashflows, bid and offer) plus one each for acceptances (BOALF), system prices
  (DISEBSP) and BSAD: about 7 requests per day, down from about 195 when it went period by
  period (90 days: 17,169 requests became about 640). Results are identical to the per-period
  fetch (checked row by row over 12 days).
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
- Elexon's reference data can list a BM unit twice (e.g. `T_WLNYO-4`); units are de-duplicated on ingest so joins do not double-count.

## Android app

`android/` is a native Android app with the same features, running entirely on the phone: no
server and no account. It downloads from the Elexon API itself and keeps the data in on-device
SQLite (see "What is stored" below).

- **`core/`** (Kotlin, no Android dependencies): the SQLite store, the Elexon client, the ingest
  and a line-for-line port of `api.py` (same routes and JSON shapes, so the web UI runs
  unchanged). Ingest uses the whole-day endpoints and pulls acceptances and BSAD in 3-day
  chunks.
- **`app/`**: an Activity hosting the shared UI (`bmdash/static`, copied in at build time) in a
  WebView. Requests to a private origin are answered in-process: `/api/...` by `core`, the rest
  from bundled assets. Downloads run in a foreground service, so they survive the screen
  turning off, and the app tops up the last 30 days each time it opens (only missing or
  unsettled days are fetched). First launch takes a few minutes; later opens take seconds.
- **What is stored** (and why the phone stays cool): only what the charts read. Per unit, period,
  direction and bid-offer pair that is a slim row (volume, cashflow, SO flag, acceptance count);
  plus system prices and non-BM actions. Individual acceptances (BOALF) are *not* stored: they were
  78% of an earlier version's 550 MB and are only shown for the one unit being viewed, so the unit
  page fetches them live (about 70 KB per unit per fortnight). The ingest still streams BOALF to
  derive the per-period SO flag and acceptance count, then discards the records. Result: about
  34 MB for the default 30 days (about 100 MB for 90), and 16 s of CPU for the first download.
  Responses are stream-parsed record by record, so memory use does not grow with response size
  (an earlier version built whole JSON trees and ran out of memory on the phone). Downloads run
  at background thread priority, and days fetched before they settled are re-fetched at most
  every 6 hours rather than on every launch.
- **`harness/`**: runs `core` on the JVM against sqlite-jdbc with a small HTTP server, so the
  phone code path can be exercised and compared with the Python backend without a device:
  `gradle -p android :harness:installDist`, then
  `android/harness/build/install/harness/bin/harness ingest --days 7 --db /tmp/bm.sqlite` and
  `... serve --db /tmp/bm.sqlite --static bmdash/static`.

Build: `gradle -p android :app:assembleRelease` (JDK 17+, Android SDK 35) gives
`android/app/build/outputs/apk/release/app-release.apk`, signed with the debug key so it can be
sideloaded. The GitHub Actions workflow `android.yml` builds it on every push to `main` and
attaches it to the `android-latest` release, which is a stable download link for the phone.
