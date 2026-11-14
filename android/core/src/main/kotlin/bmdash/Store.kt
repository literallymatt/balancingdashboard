package bmdash

/** SQLite schema and day-level writes. One settlement day is replaced atomically. */
object Store {
    private val DDL = listOf(
        // One row per unit x period x direction x bid-offer pair. Kept deliberately slim: this is the
        // table every chart reads, and a phone does not need the raw Elexon series that the UI never shows.
        """CREATE TABLE IF NOT EXISTS boav (
            settlement_date TEXT NOT NULL, sp INTEGER, bm_unit TEXT, lead_party TEXT, bm_unit_type TEXT,
            direction TEXT, pair INTEGER, volume REAL, volume_original REAL, volume_tagged REAL,
            cashflow REAL, so_flag INTEGER, n_acceptances INTEGER)""",
        "CREATE INDEX IF NOT EXISTS boav_date ON boav(settlement_date)",
        "CREATE INDEX IF NOT EXISTS boav_unit ON boav(bm_unit, settlement_date)",
        """CREATE TABLE IF NOT EXISTS system_prices (
            settlement_date TEXT NOT NULL, sp INTEGER, start_time TEXT, ssp REAL, sbp REAL, niv REAL,
            price_derivation_code TEXT, accepted_offer_volume REAL, accepted_bid_volume REAL,
            tagged_offer_volume REAL, tagged_bid_volume REAL, adj_sell_volume REAL, adj_buy_volume REAL)""",
        "CREATE INDEX IF NOT EXISTS sp_date ON system_prices(settlement_date)",
        """CREATE TABLE IF NOT EXISTS disbsad (
            settlement_date TEXT NOT NULL, sp INTEGER, id INTEGER, cost REAL, volume REAL, so_flag INTEGER,
            stor_flag INTEGER, party_id TEXT, asset_id TEXT, is_tendered INTEGER, service TEXT)""",
        "CREATE INDEX IF NOT EXISTS bsad_date ON disbsad(settlement_date)",
        """CREATE TABLE IF NOT EXISTS units (
            bm_unit TEXT PRIMARY KEY, ngc_bm_unit TEXT, name TEXT, fuel_type TEXT, tech TEXT, lead_party TEXT,
            lead_party_id TEXT, bm_unit_type TEXT, gsp_group TEXT, generation_capacity REAL,
            demand_capacity REAL, interconnector_id TEXT)""",
        // A day is "held" once its row is here; written in the same transaction as the day's data.
        "CREATE TABLE IF NOT EXISTS day_meta (settlement_date TEXT PRIMARY KEY, fetched_at INTEGER)",
        "CREATE TABLE IF NOT EXISTS cache (k TEXT PRIMARY KEY, v TEXT)",
        // System-level balancing costs (Total costs tab): no unit detail, so kept apart from the BM tables.
        "CREATE TABLE IF NOT EXISTS cost_daily (date TEXT NOT NULL, source TEXT NOT NULL, category TEXT NOT NULL, amount REAL, PRIMARY KEY (date, source, category))",
        "CREATE TABLE IF NOT EXISTS cost_meta (k TEXT PRIMARY KEY, v TEXT)",
        // Network constraints tab: NESO day-ahead flow and limit per transmission boundary per half-hour. WITHOUT ROWID
        // stores the rows once, in key order: half the size of a rowid table plus its primary-key index.
        """CREATE TABLE IF NOT EXISTS constraint_hh (settlement_date TEXT NOT NULL, sp INTEGER NOT NULL, grp TEXT NOT NULL,
            limit_mw REAL, flow_mw REAL, PRIMARY KEY (settlement_date, grp, sp)) WITHOUT ROWID""",
        // REMIT tab (see Remit.kt): one row per outage message (latest revision) and its unavailable MW through the event.
        """CREATE TABLE IF NOT EXISTS remit_msg (mrid TEXT PRIMARY KEY, revision INTEGER, msg_id INTEGER, published INTEGER, kind TEXT,
            planned INTEGER, status TEXT, asset_id TEXT, unit_name TEXT, fuel TEXT, gsp_group TEXT, normal_mw REAL, available_mw REAL,
            unavailable_mw REAL, t_start INTEGER, t_end INTEGER, cause TEXT, participant TEXT)""",
        "CREATE TABLE IF NOT EXISTS remit_seg (mrid TEXT NOT NULL, t0 INTEGER, t1 INTEGER, mw REAL)",
        "CREATE INDEX IF NOT EXISTS remit_seg_mrid ON remit_seg(mrid)",
        // Interconnectors tab (see Interconnectors.kt): NESO's trades over the links (from BSAD), summed per settlement period
        // x link x counterparty x kind x SO flag x direction, and the physical flow per link and half-hour.
        """CREATE TABLE IF NOT EXISTS ic_trade (settlement_date TEXT NOT NULL, sp INTEGER, ic TEXT, party TEXT, kind TEXT,
            so_flag INTEGER, volume REAL, cost REAL, n INTEGER, price_max REAL, price_min REAL)""",
        "CREATE INDEX IF NOT EXISTS ic_trade_date ON ic_trade(settlement_date)",
        """CREATE TABLE IF NOT EXISTS ic_flow (settlement_date TEXT NOT NULL, sp INTEGER NOT NULL, ic TEXT NOT NULL, flow_mw REAL,
            PRIMARY KEY (settlement_date, ic, sp)) WITHOUT ROWID""",
        // DFS tab (see Dfs.kt): one row per event half-hour, and one per provider bid (DFS unit x half-hour).
        """CREATE TABLE IF NOT EXISTS dfs_hh (settlement_date TEXT NOT NULL, sp INTEGER, event TEXT, direction TEXT, tag TEXT, live INTEGER,
            req_mw REAL, procured_mw REAL, cost REAL, settled_mw REAL, settled_cost REAL, gap REAL, mip REAL)""",
        "CREATE INDEX IF NOT EXISTS dfs_hh_date ON dfs_hh(settlement_date)",
        """CREATE TABLE IF NOT EXISTS dfs_bid (settlement_date TEXT NOT NULL, sp INTEGER, event TEXT, direction TEXT, tag TEXT, live INTEGER,
            party TEXT, unit TEXT, zone INTEGER, mw REAL, price REAL, accepted INTEGER)""",
        "CREATE INDEX IF NOT EXISTS dfs_bid_date ON dfs_bid(settlement_date)",
        "CREATE INDEX IF NOT EXISTS dfs_bid_event ON dfs_bid(event)",
        "CREATE TABLE IF NOT EXISTS dfs_cap (settlement_date TEXT NOT NULL, sp INTEGER, event TEXT, zone INTEGER, cap_mw REAL)",
        "CREATE INDEX IF NOT EXISTS dfs_cap_event ON dfs_cap(event, sp)",
    )

    fun init(db: SqlDb) {
        // ic_trade gained its price columns after the Interconnectors tab first shipped: drop an old copy, and the next costs
        // refresh backfills it (Interconnectors.held is false for an empty table).
        val cols = db.query("PRAGMA table_info(ic_trade)").map { it["name"] }
        if (cols.isNotEmpty() && "price_max" !in cols) db.exec("DROP TABLE ic_trade")
        for (s in DDL) db.exec(s)
        if (Dfs.needsMigration(db)) {  // DFS tables from before the price columns: drop, and the next refresh re-fetches them
            for (t in listOf("dfs_hh", "dfs_bid", "dfs_cap")) db.exec("DROP TABLE IF EXISTS $t")
            for (s in DDL) db.exec(s)
        }
    }

    private val TABLES = mapOf(
        "boav" to 13, "system_prices" to 13, "disbsad" to 11,
    )

    /** Replace everything held for one settlement day, atomically. */
    fun writeDay(db: SqlDb, date: String, data: Map<String, List<List<Any?>>>, nowEpoch: Long) {
        db.transaction {
            for ((table, rows) in data) {
                db.exec("DELETE FROM $table WHERE settlement_date = ?", listOf(date))
                val n = TABLES.getValue(table)
                db.insertBatch("INSERT INTO $table VALUES (${List(n) { "?" }.joinToString(",")})", rows)
            }
            db.exec("INSERT OR REPLACE INTO day_meta VALUES (?, ?)", listOf(date, nowEpoch))
        }
    }

    fun writeUnits(db: SqlDb, rows: List<List<Any?>>) {
        db.transaction {
            db.exec("DELETE FROM units")
            db.insertBatch("INSERT OR REPLACE INTO units VALUES (${List(12) { "?" }.joinToString(",")})", rows)
        }
    }

    /** Settlement day -> epoch seconds at which it was fetched. */
    fun coverage(db: SqlDb): Map<String, Long> =
        db.query("SELECT settlement_date, fetched_at FROM day_meta")
            .associate { it["settlement_date"] as String to (it["fetched_at"] as Number).toLong() }
}
