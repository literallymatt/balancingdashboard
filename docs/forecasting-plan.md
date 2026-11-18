# GB system price forecasting: project brief

Goal: forecast the GB system (imbalance) price for the next three settlement periods, and measure
how accurate the forecast is against simple baselines. This is research first. The answer may be
"not enough skill to be worth it", and that is a fine outcome.

This project builds on the **bmdash** dashboard
(`github.com/literallymatt/balancingdashboard`), which already downloads and stores most of the
historical balancing data. See "Reusing bmdash" below for how to use it without copying it.

---

## 1. The problem

- **What sets the price.** GB has had a single imbalance price since 2015 (BSC modification P305),
  so SSP = SBP in almost every period. It is set by the marginal balancing actions on the side NESO
  is balancing:
  - a **short** system prices off accepted offers, so the price is high;
  - a **long** system prices off accepted bids, so the price is low and sometimes negative.
- **So the problem splits in two:**
  1. predict the sign and size of the net imbalance volume (NIV);
  2. predict where that NIV lands in the bid-offer stack.
- **The forecast is really 4–5 periods ahead.** Elexon publishes a period's price some time after
  the period ends. When we forecast SP+1 to SP+3 from "now" (inside SP0), the latest price we know
  is roughly SP−1 or SP−2. Measure this lag from the data rather than assuming it.
- **Gate closure helps.** Physical notifications (PNs) are final 1 hour before a period starts. At
  forecast time, the PNs for SP+1 and SP+2 (and usually SP+3) are therefore already fixed.
- **Pick the target run.** Prices are published quickly as an initial value and revised in later
  settlement runs. Decide which run is the target and stick to it. The initial price
  (`/balancing/settlement/system-prices`) is the practical choice.

## 2. What bmdash already provides

Stored as zstd Parquet, one file per dataset per settlement day, queried with DuckDB:

| Dataset (bmdash name) | Source | Useful for |
|---|---|---|
| `system_prices` | Elexon system prices (DISEBSP): SSP, SBP, NIV, price derivation code, accepted / tagged / adjustment volumes | **Target**, plus NIV history |
| `acceptances` | BOALF: every acceptance with time issued, levels and SO/STOR/RR flags | How NESO was acting just before the forecast |
| `boav` | DISPTAV + EBOCF: accepted volume and cashflow per unit, period, direction and bid-offer pair | The marginal price per side, by technology |
| `disbsad` | BSAD: non-BM actions (incl. interconnector trades) | Adjustments that feed the price |
| `units` | BM unit reference data, technology, GSP group | Joins |
| `constraint_hh.parquet` | NESO day-ahead constraint flows and limits | Constraint pressure |
| `remit_msg`, `remit_seg` | REMIT outages (up to 28 days ahead) | Unavailable capacity |
| `ic_trade`, `ic_flow_hh` | BSAD interconnector trades, FUELHH flows | Interconnector position |
| `cost_daily.parquet` | NESO daily balancing costs by purpose | Context only (daily, published late) |
| `dfs_*` | Demand Flexibility Service events | Rare events |

History is held from about April 2025 for the system-level sources. The per-day BM datasets go back
as far as someone runs `bmdash ingest --from ...`.

**Caveat:** this is settled, after-the-fact data, fetched in daily batches. It is right for the
target and for training labels, but most of it was not available at forecast time. Use it only for
features you can prove were known at that moment (e.g. acceptances whose `acceptance_time` is before
the forecast time).

## 3. What is missing

### 3.1 Data known before the period

| Need | Source (Elexon Insights unless stated) |
|---|---|
| Market index price for every period (bmdash only fetches it for DFS events) | `MID` |
| Physical notifications, aggregated (final at gate closure) | `PN` |
| The bid-offer stack: what price a given NIV clears at | `BOD` |
| Demand forecasts | `NDF`, `TSDF`, NESO short-term demand forecasts |
| Wind and solar forecasts | `WINDFOR`, NESO embedded wind/solar forecasts |
| Generation by fuel in real time (5-min) | `FUELINST` |
| NESO's imbalance and margin indications | `IMBALNGC`, `MELNGC` |
| Scarcity pricing inputs | `LOLPDRM` |
| Grid frequency | `FREQ` |
| Acceptances as they happen during the day | `BOALF`, polled every few minutes |

### 3.2 Forecasts as they were published at the time

To backtest honestly, every feature must be the value **as known at forecast time**. A wind
forecast must be the version published before the forecast, not the final one. Otherwise the
backtest leaks the future and looks far better than it will live.

- Keep every published version (`publishTime`) rather than overwriting.
- Build features with an "as of" join: the latest version with `publishTime <= forecast_time`.
- Where a source has no history of versions, record that and either leave it out of the backtest
  or collect it live from now on.

### 3.3 More history

At least one year, ideally two, to cover seasons and enough price spikes.

## 4. Measuring accuracy

Report every model against these baselines, for each of SP+1, SP+2 and SP+3 separately:

1. **Last known price**, carried forward (respecting the publication lag).
2. **Same period yesterday.**
3. **Market index price** for the target period.

Metrics:
- MAE and RMSE (£/MWh), plus error by price band, so spikes are visible rather than averaged away.
- Hit rate on the system's direction (long or short).
- Optionally the value of acting on the forecast (e.g. a simple battery or trading rule), if that is
  the eventual use.

Splits are by time only (walk-forward), never random.

## 5. Plan

1. **Baselines on data bmdash already holds.** Measure the publication lag and the three baselines
   above. This is about a day of work and sets the bar.
2. **Best case.** Add `MID` and `BOD` history and measure how much of the price "actual NIV plus the
   stack" explains after the fact. That is roughly the most any model can achieve if it predicted
   NIV perfectly.
3. **Forecasting inputs with their publication times kept** (section 3), then simple models: one
   that predicts whether the system will be long or short (and by how much), and one that predicts
   the price for each side. Gradient-boosted trees are a sensible first choice.
4. **Shadow mode.** Run live for a few weeks, logging forecasts and outcomes, before trusting the
   backtest.
5. **If it works**, add a web-only *Forecast* tab to bmdash that reads this project's output and
   plots forecast against outturn. Keep the forecasting code here, not in bmdash (bmdash's Android
   app mirrors its API in Kotlin and should not have to port an ML pipeline).

---

## Reusing bmdash

bmdash is a normal Python package (`bmdash`, Python 3.12+) with a CLI, and its data folder can be
moved with the `BMDASH_DATA` environment variable. So this project can **depend on it** instead of
copying it.

### Add it as a dependency

```bash
uv add "bmdash @ git+https://github.com/literallymatt/balancingdashboard"
```

(The repository is private, so this needs git credentials that can read it. Locally, your normal
GitHub login works.)

### Run its ingests into this project's data folder

```bash
export BMDASH_DATA="$PWD/data/bmdash"
uv run bmdash ingest --from 2025-01-01 --no-costs   # system prices, BOALF, BOAV, BSAD per day
uv run bmdash costs                                 # constraints, REMIT, interconnectors, DFS, NESO costs
```

Already-held days are skipped, and days that had not settled are re-fetched later, so these can be
re-run safely.

Or, if bmdash is already checked out next to this project with data in it, point at that instead:

```bash
export BMDASH_DATA=../balancingdashboard/data
```

### Read the data

```python
from bmdash import store
con = store.connect()      # DuckDB connection with a view per dataset, reading BMDASH_DATA
prices = con.sql("select * from system_prices order by start_time").df()
```

Set `BMDASH_DATA` **before** importing `bmdash.store`, because the path is read at import time.

### Reuse the HTTP client for new datasets

`bmdash.elexon.Elexon` is an async Elexon Insights client with a request limit, retries, and
"hedging" (a request with no answer after 8 s is sent again, and the first answer wins: about one
Elexon request in ten otherwise hangs). Use it for the new datasets in section 3:

```python
from bmdash.elexon import Elexon

async with Elexon() as api:
    rows = await api.get("/datasets/MID/stream", {"from": "...", "to": "..."})
```

New ingests (MID, BOD, PN, forecasts, ...) belong in **this** project, with publication times kept,
not in bmdash.

### Notes on bmdash data

- Times are settlement time; `start_time` is UTC.
- `boav.volume` is the larger of Elexon's Original and Tagged volumes (Original is zero for
  SO-flagged actions); it reconciles with the system price data's total accepted volume to about 0.1%.
- The SO flag in `boav` is per unit-period and approximate (any SO-flagged acceptance flags the whole
  period).
- Full details are in bmdash's README.
