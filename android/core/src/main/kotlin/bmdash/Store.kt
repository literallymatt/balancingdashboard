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
    )

    fun init(db: SqlDb) {
        for (s in DDL) db.exec(s)
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
