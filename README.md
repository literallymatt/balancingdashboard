# bmdash: GB Balancing Mechanism dashboard

Drill-down dashboard for Balancing Mechanism costs, built on the Elexon Insights (BMRS) API.

## Run

```bash
uv run bmdash ingest --days 90        # backfill (skips days already held)
uv run bmdash serve                   # http://127.0.0.1:8780
```

### Without uv

Needs Python 3.12 or newer. From the project root:

```bash
python3 -m venv .venv
source .venv/bin/activate              # Windows: .venv\Scripts\activate
pip install --upgrade pip              # older pip can't do editable installs of this project
pip install -e .
```

Then run the same commands without `uv run`:

```bash
bmdash ingest --days 90
bmdash serve
```

Dependency versions aren't pinned this way (`uv.lock` is uv-only), so you get the latest
versions that match `pyproject.toml`.

### Options

`bmdash ingest --from 2025-01-01 --to 2025-12-31` fetches an explicit range; `--force` re-fetches.
The server raises its own open-file limit at start-up and runs at most two queries at a time, because every
query reads one Parquet file per held day (macOS allows only 256 open files by default, which otherwise gives
"IO Error: ... Too many open files" once a few months are held).
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
  had settled (5 days) are re-fetched, but at most every 6 hours (`--force` overrides), so repeated
  ingests do not redo the slowest requests.
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
- **Debug panel**: the *Debug* button in the app header shows what the phone is doing during a
  download: the app's CPU (and its busiest threads), Android's thermal status and headroom,
  battery temperature, power draw, data downloaded and memory, as live tiles and charts, with a
  *Copy log* button. A sampler records these every 2 s while a download runs (or the panel is
  open), so the history is there even if the panel is opened afterwards. The app's CPU excludes
  the WebView's chart drawing, which Android runs in a separate process; the battery and thermal
  readings cover everything. It is not available in the desktop version.
- **Info buttons**: the small *i* buttons next to KPI tiles, headings, controls and table columns
  explain terms such as SO-flagged, bid-offer pairs and settlement periods (tap to open).
- **Total costs tab**: system-level monthly balancing costs, with no unit or asset behind them, so they
  sit apart from the unit tabs. *By source* stacks the Balancing Mechanism, non-BM actions (Elexon BSAD)
  and response/reserve availability (NESO EAC auctions); *By purpose* is NESO's own split of its daily cost
  total (constraints, energy imbalance, reserve, frequency control, other). Sources: NESO Data Portal
  (daily balancing costs; EAC auction results, via its SQL aggregation endpoint), Elexon `DISBSAD`.
  BM cost is derived as NESO's total minus BSAD: on every complete day that matched the unit-level Elexon BM
  cashflows to within £0.4M (about 1%). EAC reserve products are half-hour windows and response products four-hour
  windows, so the multiplier is per product. NESO publishes the daily file a few days late, so a day counts
  once it has 44+ settlement periods and the latest month is shown as partial. **Not included** (no public monthly
  actuals found): other ancillary services (reactive, black start, stability/voltage, reserve delivery), SO-SO
  trades (Elexon's `SOSO` is a price ladder, not executed trades) and reconciliation. Refresh with
  `uv run bmdash costs` (also run at the end of `bmdash ingest`) or the Refresh button; the phone app refreshes
  it on launch when older than 12 hours. The first run backfills from April 2025 (about a minute); after that a
  refresh only re-fetches the current month or so, a few seconds.
- **Constraints tab**: where and when the transmission network was constrained, half-hourly. Source: NESO's
  *day-ahead constraint flows and limits* (per boundary and half-hour: the limit and the flow NESO forecast across it
  the day before). A half-hour counts as "at the limit" when the forecast flow is at or above the limit. The tab
  shows a schematic map of GB with each boundary coloured by how often it was at its limit (or its average loading,
  or energy over the limit) over the selected range, a boundary x time heatmap, flow against limit for one boundary,
  and NESO's daily constraint costs by boundary group (thermal) and by reason (thermal, voltage, inertia, largest
  loss). It uses the same date range and granularity controls as the unit tabs, from settlement period to month;
  costs are only published per day, so they show per day at finer granularities. Notes: these are forecasts, not
  metered flows; NESO renames boundaries as the network changes (SSE_SP became SSE_SP2), so codes are grouped into
  families for the map and costs; map positions are drawn from NESO's network diagrams and are schematic (outline:
  Natural Earth, public domain, `static/vendor/gb.json`). NESO sometimes publishes a day twice; repeats are dropped,
  except the second 01:00-01:59 on the autumn clock change. Fetched with the Total costs data (`bmdash costs`, the
  end of `bmdash ingest`, or the Refresh button): the first backfill from April 2025 is about 365k half-hours and
  two minutes, later refreshes re-fetch the current month. Stored in `data/constraint_hh.parquet` (phone: the
  `constraint_hh` table, about 12 MB for the backfill). The actual BM actions NESO took for constraints carry the
  SO flag; the tab links to the Overview filtered to them, split by technology and unit.
- **REMIT tab**: how much generating capacity was unavailable, when, and in which GSP group, from the REMIT outage
  messages that owners must publish for any change of 100 MW or more (Elexon Insights REMIT data). A map of the 14 GSP
  groups shows the average MW unavailable in one period, chosen with a slider (or Play, which steps through the
  selected range on a fixed colour scale); the table lists the units behind it (click one to open that outage: its
  capacity through the event, cause, status and the unit's other REMIT messages, with a link to its BM page), and a stacked chart shows unavailable
  capacity over time by GSP group, fuel or planned/unplanned (click a bar to put that period on the map). It uses the
  same date range and granularity controls as the Constraints tab and reaches 28 days ahead, because planned outages
  are published in advance. Rules (`remit.py`, mirrored in `core/Remit.kt`): only each message's latest revision
  counts and withdrawn ("Dismissed") messages are ignored; a unit's unavailable MW is its normal capacity minus the
  outage profile's available capacity (or the message's own unavailable capacity when there is no profile), averaged
  over each half-hour; overlapping live messages for one unit count once (the larger). Events longer than a year are
  hidden unless *Closures* is ticked: closed and mothballed stations stay in REMIT as open-ended outages (Ratcliffe,
  Fiddler's Ferry and Dungeness B run to 2050), which would otherwise add over 10 GW to every period. **GSP group**:
  Elexon's reference data gives one for embedded units only; transmission-connected units are placed by their
  transmission loss factor, which Elexon sets per GSP-group zone, so a loss factor shared by many units of one known
  group identifies the zone. That places virtually all the capacity outside closures (checked by hand: Drax in
  Yorkshire, Medway in the South East, Heysham in the North West). Region outlines: NESO's GB DNO licence areas
  (NESO Open Data Licence), simplified to 50 KB in `static/vendor/gsp_groups.json`. Fetched with the Total costs data
  (`bmdash costs`, the end of `bmdash ingest`, or the Refresh button): the first backfill from April 2025 is about
  25,000 messages and three to five minutes; later refreshes fetch only what was published since, plus the forward
  window, in seconds. Stored in `data/remit_msg.parquet` and `data/remit_seg.parquet` (1.3 MB; phone: the `remit_msg`
  and `remit_seg` tables, about 10 MB).
- **Interconnectors tab**: the trades NESO takes on the interconnectors to balance the system, and what flowed. Interconnectors
  do not take part in the Balancing Mechanism (no acceptances on the `I_` units), so NESO balances across them with trades
  outside it, which Elexon publishes in BSAD (`DISBSAD`). *Counterparty trades* buy or sell energy from a trader for delivery
  over one link; the BSAD asset id is the trader's interconnector unit, whose prefix names the link (`IFG-DSKC1`: IFA, Danske
  Commodities; `I2G` IFA2, `ILG` ElecLink, `IBG` BritNed, `ING` Nemo Link, `IVG` Viking Link, ...). *SO-SO trades* are with the
  neighbouring system operator (asset ids `IF1`, `IF2`, `EL1`, `NSL`, `EWIC`, `MOYLE`) and are often published with no cost, so
  they count in volumes but not average prices. Positive volume is energy NESO bought (into GB). The tab shows a map of north-west
  Europe with each link drawn from its GB landing point to the far end (width: traded volume, net cost or physical flow; arrows:
  which way the energy went), a table per link, the usual time chart (net cost, volume bought/sold, average price; split by link,
  direction, counterparty, trade type or SO flag), a counterparty breakdown, physical flow per link (Elexon `FUELHH`, positive into
  GB) and a day x settlement-period grid. Click a link or counterparty to filter the tab to it. **Periods**: as on the REMIT tab,
  clicking a period in any of the time charts (or Play, the arrows and the slider) puts that period on the map, the links table, the
  KPIs and the price details; a dashed line marks it on the charts, and *Whole range* goes back to totals. Clicking a half-hour in
  the grid shows that half-hour (zooming to its day first unless the tab is already half-hourly). **Prices**: the trades are
  pay-as-bid, so each has its own price. The tab shows the volume-weighted average (cost / volume), the highest and lowest single
  trade, and a clearing price: the marginal trade in each half-hour (the dearest NESO bought, the cheapest it sold), averaged over
  the half-hours with trades. The *Trade prices* chart shows these over time for purchases or sales, and *Price details* per link
  for the period shown. **Finding expensive half-hours**: the day x settlement-period grid colours by clearing price by default
  (or average price, or net volume); over one or two days it becomes a bar per half-hour, coloured by the interconnector that set
  the clearing price. A *Peak clearing price* KPI jumps to the range's dearest half-hour. Clicking a half-hour fills **Who set the
  price**: every link x counterparty that traded in it, dearest first (cheapest first for sales), with the marginal ones starred;
  over a longer period it ranks them by their dearest trade and counts the half-hours in which each set the clearing price
  (`/api/ic/trades`). The map can colour each link by its clearing price (★ marks the link that set it), and the time chart has a
  *Clearing price* measure split by link or counterparty. Each stored row keeps its highest and lowest single-trade price for this (`price_max`, `price_min`); stores
  from before these columns existed are reset and backfilled on the next refresh. Trades come out of the same monthly
  DISBSAD download as the Total costs figures, so they cost no extra requests; flows are one `FUELHH` request a month. The first
  refresh after upgrading backfills from April 2025 (about two minutes); later refreshes re-fetch the current month. Stored in
  `data/ic_trade.parquet` (summed per settlement period, link, counterparty, kind, SO flag and direction; about 80k rows) and
  `data/ic_flow_hh.parquet` (phone: the `ic_trade` and `ic_flow` tables). Landing points are approximate (outline: Natural Earth,
  public domain, `static/vendor/nweurope.json`).
- **DFS tab**: NESO's Demand Flexibility Service, in which households and businesses are paid, through registered providers
  (suppliers and aggregators), to shift their demand for set half-hours: *turn-down* (Downwards) events ask them to use less,
  *turn-up* (Upwards, from April 2026) to use more. NESO tags each event *Energy* or *System*. Providers bid a volume per DFS unit
  and half-hour at a price and NESO accepts bids, cheapest first, up to its requirement; settlement later measures what was
  delivered. Source: NESO Data Portal, `demand-flexibility` package: the *DFS Utilisation Report Summary* (one row per event
  half-hour: requirement, MW procured, accepted cost, settled volume and cost) and the *DFS Utilisation Report* (one row per bid:
  provider, DFS unit, zone, MW, price, accepted or rejected), for the current year and the 2025/26 archive (which starts in
  November 2024), plus the *DFS Service Requirement* (guaranteed acceptance price and, from April 2026, a cap per zone per event
  half-hour) and Elexon's market index price (`MID`, APX) for each event half-hour. **Clearing prices**: accepted bids are paid
  their own price (pay-as-bid) and NESO takes bids in price order (in no half-hour is a rejected bid cheaper than the dearest
  accepted one), so a half-hour's clearing price is its highest accepted bid; over several half-hours it is averaged weighted by
  volume procured, and the cheapest rejected bid shows where NESO stopped. The tab shows KPIs (events, procured volume against the
  requirement, accepted cost, turn-down clearing price against the market, share delivered, providers), clearing prices over time by
  direction against the market price, bid volume by price band (accepted and rejected), each event's clearing price against the
  market, the usual time chart (procured volume, accepted cost, average price, share of requirement procured, delivered volume; split
  by direction, reason, provider or zone), a table of events with clearing and market prices, the bid stack for any half-hour of an
  event (each bid as wide as its MW and as tall as its price, with the clearing and market prices and the zones closed), a map of
  the 12 DFS zones (procured volume, cost, prices, acceptance or how often each zone was closed, over the range or for one event),
  a provider / zone / DFS unit breakdown and a day x settlement-period grid. Click a provider or a zone to filter the tab to it.
  Zone outlines: NESO's DFS 12-zone GeoJSON (February 2026, from the DFS page on neso.energy), simplified to 50 KB in
  `static/vendor/dfs_zones.json`; NESO numbers the zones only, so the area names are approximate. Notes: volumes are MW for a half-hour, shown as MWh; accepted bids add up exactly to NESO's
  procured MW and cost for every half-hour (checked over all 3,130 event half-hours). The archive has no event numbers, types or
  tags (one Downwards event a day), so its events are named by date with the reason "Not stated"; zones (1-12) start in April
  2026. Provider names are upper-cased without "Limited", because NESO spells some differently between files. Test events are
  left out unless ticked. Fetched with the Total costs data (`bmdash costs`, the end of `bmdash ingest`, or the Refresh button):
  about 60k rows plus a market-price request per month with events, about 20 seconds; later refreshes re-read only the current year's files. Stored in `data/dfs_hh.parquet`,
  `data/dfs_bid.parquet` and `data/dfs_cap.parquet` (phone: the `dfs_hh`, `dfs_bid` and `dfs_cap` tables; `harness ... dfs --db /tmp/bm.sqlite` fetches just these).
- **Instruction replay**: on a unit's page, the Day detail card can replay NESO's instructions
  for the day in the order they were issued (plays and loops on its own by default; pause, step,
  slider, and a Loop toggle; reduced-motion users get the final state), showing the unit's plan
  (PN), its output as instructed so far, the previous state and the newest instruction, with a
  marker for when each was issued. Model: the unit follows the newest-issued acceptance covering
  each moment, or its own plan when none does. Checked against Elexon's settled volumes on
  9 unit-days (hundreds of acceptances each): matches to within 0.1 MWh, whereas "a new
  instruction cancels everything earlier" is off by 3.4% and "add them all up" by 28%.
  The Day detail chart above it draws the same model's end state ("Instructed output") rather
  than each acceptance's own profile (still available from the legend), and the Acceptances
  table shows one row per acceptance with its profile in words ("410 → 38 → 0 MW"; tick
  *Show each point* for Elexon's rows).
- **Click-throughs**: the Back button and breadcrumb trail name the page as well as the range
  ("Overview · 9 Nov – 15 Nov 2026 › Unit T_RYHPS-1 › detail for Thu 12 Nov 2026"). A click
  that changes a card further down the page (a unit's day, a boundary, a DFS event's bids)
  scrolls that card into view and flashes it. The header's coverage note follows the tab, since
  each tab has its own source and dates.
- **`harness/`**: runs `core` on the JVM against sqlite-jdbc with a small HTTP server, so the
  phone code path can be exercised and compared with the Python backend without a device:
  `gradle -p android :harness:installDist`, then
  `android/harness/build/install/harness/bin/harness ingest --days 7 --db /tmp/bm.sqlite` and
  `... serve --db /tmp/bm.sqlite --static bmdash/static` (`... remit --db /tmp/bm.sqlite` fetches just the REMIT data).

Build: `gradle -p android :app:assembleRelease` (JDK 17+, Android SDK 35) gives
`android/app/build/outputs/apk/release/app-release.apk`, signed with the debug key so it can be
sideloaded. The GitHub Actions workflow `android.yml` builds it on every push to `main` and
attaches it to the `android-latest` release, which is a stable download link for the phone.
