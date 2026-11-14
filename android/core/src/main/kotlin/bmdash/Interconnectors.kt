package bmdash

import java.time.LocalDate

/**
 * Interconnector balancing for the Interconnectors tab (mirrors bmdash/interconnectors.py and the /api/ic routes in
 * bmdash/api.py). Interconnectors are not in the Balancing Mechanism: NESO's trades over them are non-BM actions in
 * Elexon BSAD, picked out of the same monthly DISBSAD download as the Total costs figures (see CostIngester.fetchBsad).
 * Physical flows per link come from Elexon FUELHH. Positive volume: NESO buys (into GB); positive flow: import.
 */
object Interconnectors {
    // BSAD asset-id prefix (counterparty trades: the trader's interconnector BM unit) -> link.
    private val PREFIX = mapOf(
        "IFG" to "IFA", "IFD" to "IFA", "I2G" to "IFA2", "I2D" to "IFA2", "ILG" to "ELEC", "ILD" to "ELEC",
        "IBG" to "BRTN", "IBD" to "BRTN", "ING" to "NEMO", "IND" to "NEMO", "IVG" to "VKL", "IVD" to "VKL",
        "ISG" to "NSL", "ISD" to "NSL", "IIG" to "EWIC", "IID" to "EWIC", "IMG" to "MOYL", "IMD" to "MOYL",
        "IGG" to "GRNL", "IGD" to "GRNL",
    )
    // Whole BSAD asset ids used for SO-SO trades with the neighbouring system operator -> link.
    private val SOSO = mapOf(
        "IF1" to "IFA", "IF2" to "IFA2", "EL1" to "ELEC", "NSL" to "NSL", "EWIC" to "EWIC", "MOYLE" to "MOYL",
        "BN1" to "BRTN", "BRITNED" to "BRTN", "NEMO" to "NEMO", "NEM1" to "NEMO", "VKL" to "VKL", "VK1" to "VKL",
        "GREENLINK" to "GRNL", "GRN" to "GRNL",
    )
    // Elexon FUELHH fuel type -> link.
    private val FUEL = mapOf(
        "INTFR" to "IFA", "INTIFA2" to "IFA2", "INTELEC" to "ELEC", "INTNED" to "BRTN", "INTNEM" to "NEMO",
        "INTVKL" to "VKL", "INTNSL" to "NSL", "INTEW" to "EWIC", "INTIRL" to "MOYL", "INTGRNL" to "GRNL",
    )

    /** BSAD asset id -> (link, kind) for interconnector trades; null for any other non-BM action. */
    fun classify(assetId: String?): Pair<String, String>? {
        val a = (assetId ?: "").trim().uppercase()
        if (a.isEmpty()) return null
        SOSO[a]?.let { return it to "soso" }
        val i = a.indexOf('-')
        if (i > 0) PREFIX[a.substring(0, i)]?.let { return it to "trade" }
        return null
    }

    /** Collects trades from DISBSAD records, summed per settlement period x link x counterparty x kind x SO flag x direction. */
    class TradeSink {
        private val acc = HashMap<List<Any>, DoubleArray>()

        fun add(r: Map<String, Any?>) {
            val (ic, kind) = classify(r.str("assetId")) ?: return
            val vol = r.dbl("volume") ?: return
            if (vol == 0.0) return
            val key = listOf<Any>(r.str("settlementDate") ?: return, (r.long("settlementPeriod") ?: return), ic,
                r.str("partyId") ?: "Unknown", kind, if (r["soFlag"] == true) 1L else 0L, vol > 0)
            val x = acc.getOrPut(key) { DoubleArray(3) }
            x[0] += vol; x[1] += r.dbl("cost") ?: 0.0; x[2] += 1.0
        }

        fun merge(o: TradeSink) {
            for ((k, v) in o.acc) { val x = acc.getOrPut(k) { DoubleArray(3) }; for (i in 0..2) x[i] += v[i] }
        }

        fun rows(): List<List<Any?>> = acc.map { (k, v) -> listOf(k[0], k[1], k[2], k[3], k[4], k[5], v[0], v[1], v[2].toLong()) }
    }

    fun held(db: SqlDb): Boolean = db.query("SELECT 1 FROM ic_trade LIMIT 1").isNotEmpty()

    fun writeTrades(db: SqlDb, rows: List<List<Any?>>, start: LocalDate, end: LocalDate) = db.transaction {
        db.exec("DELETE FROM ic_trade WHERE settlement_date BETWEEN ? AND ?", listOf(start.toString(), end.toString()))
        db.insertBatch("INSERT INTO ic_trade VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
    }

    private class FlowAcc { val seen = HashSet<String>(); val rows = ArrayList<List<Any?>>() }

    /** Half-hourly physical flow per link, a month per request, each month replaced in its own transaction. */
    fun ingestFlows(db: SqlDb, api: Elexon, start: LocalDate, end: LocalDate) {
        var first = start.withDayOfMonth(1)
        while (!first.isAfter(end)) {
            val a = if (first.isBefore(start)) start else first
            val b = minOf(first.plusMonths(1).minusDays(1).toEpochDay(), end.toEpochDay()).let { LocalDate.ofEpochDay(it) }
            val acc = api.read("/datasets/FUELHH/stream", listOf("settlementDateFrom" to a.toString(), "settlementDateTo" to b.toString()), { FlowAcc() }) { x, r ->
                val ic = FUEL[r.str("fuelType")] ?: return@read
                val d = r.str("settlementDate") ?: return@read
                val sp = r.long("settlementPeriod") ?: return@read
                val g = r.dbl("generation") ?: return@read
                if (x.seen.add("$d|$sp|$ic")) x.rows.add(listOf(d, sp, ic, g))
            }
            db.transaction {
                db.exec("DELETE FROM ic_flow WHERE settlement_date BETWEEN ? AND ?", listOf(a.toString(), b.toString()))
                db.insertBatch("INSERT OR REPLACE INTO ic_flow VALUES (?, ?, ?, ?)", acc.rows)
            }
            first = first.plusMonths(1)
        }
    }

    // ------------------------------------------------------------ queries (same SQL as bmdash/api.py)

    val DIMS = linkedMapOf(
        "ic" to "ic",
        "direction" to "CASE WHEN volume > 0 THEN 'NESO buys' ELSE 'NESO sells' END",
        "party" to "party",
        "kind" to "CASE WHEN kind = 'soso' THEN 'SO-SO (system operator)' ELSE 'Counterparty trade' END",
        "so" to "CASE WHEN so_flag THEN 'System (SO-flagged)' ELSE 'Energy' END",
    )
    private const val MEASURES = """
        sum(CASE WHEN volume > 0 THEN volume END) AS buy_vol, sum(CASE WHEN volume < 0 THEN volume END) AS sell_vol,
        sum(CASE WHEN volume > 0 THEN cost END) AS buy_cost, sum(CASE WHEN volume < 0 THEN cost END) AS sell_cost,
        sum(CASE WHEN volume > 0 AND cost <> 0 THEN volume END) AS buy_pvol, sum(CASE WHEN volume < 0 AND cost <> 0 THEN volume END) AS sell_pvol,
        sum(n) AS n_trades"""
    private const val FLOW = """count(*) AS n, avg(flow_mw) AS flow_avg, min(flow_mw) AS flow_min, max(flow_mw) AS flow_max,
        sum(CASE WHEN flow_mw > 0 THEN flow_mw * 0.5 ELSE 0 END) AS import_mwh,
        sum(CASE WHEN flow_mw < 0 THEN flow_mw * 0.5 ELSE 0 END) AS export_mwh"""

    class Filter(p: Map<String, String>, from: String, to: String) {
        val where = arrayListOf("settlement_date BETWEEN ? AND ?")
        val params = arrayListOf<Any?>(from, to)
        init {
            for (dim in DIMS.keys) {
                val vals = (p[dim] ?: "").split("|").filter { it.isNotEmpty() }
                if (vals.isEmpty()) continue
                where.add("${DIMS.getValue(dim)} IN (${vals.joinToString(",") { "?" }})")
                params.addAll(vals)
            }
        }
        val sql get() = where.joinToString(" AND ")
    }

    fun meta(db: SqlDb, status: Map<String, Any?>): Map<String, Any?> {
        val t = db.query("SELECT min(settlement_date) AS min, max(settlement_date) AS max, count(*) AS n FROM ic_trade")[0]
        val f = db.query("SELECT min(settlement_date) AS min, max(settlement_date) AS max FROM ic_flow")[0]
        val lo = listOfNotNull(t["min"] as String?, f["min"] as String?)
        val hi = listOfNotNull(t["max"] as String?, f["max"] as String?)
        return linkedMapOf<String, Any?>("min" to lo.minOrNull(), "max" to hi.maxOrNull(), "n" to t["n"],
            "trades_through" to t["max"], "flows_through" to f["max"]) + status
    }

    fun agg(db: SqlDb, f: Filter, b: String, group: String, top: Int, rank: String): Map<String, Any?> {
        if (group == "none") {
            val rows = db.query("SELECT $b AS t, 'All' AS g, $MEASURES FROM ic_trade WHERE ${f.sql} GROUP BY 1, 2 ORDER BY 1", f.params)
            return linkedMapOf("rows" to rows, "groups" to listOf("All"))
        }
        val g = DIMS[group] ?: throw HttpError(400, "bad bucket or group")
        val measure = if (rank == "cash") "cost" else "volume"
        val ranked = db.query("SELECT $g AS g, sum(abs($measure)) AS m FROM ic_trade WHERE ${f.sql} GROUP BY 1 ORDER BY 2 DESC, 1", f.params)
        val keep = ranked.take(top).map { it["g"] }
        val folded = ranked.size > top
        val gexpr = if (folded) "CASE WHEN $g IN (${keep.joinToString(",") { "?" }}) THEN $g ELSE 'Other (rest)' END" else g
        val rows = db.query("SELECT $b AS t, $gexpr AS g, $MEASURES FROM ic_trade WHERE ${f.sql} GROUP BY 1, 2 ORDER BY 1",
            (if (folded) keep else emptyList()) + f.params)
        return linkedMapOf("rows" to rows, "groups" to keep + (if (folded) listOf("Other (rest)") else emptyList()), "n_groups" to ranked.size)
    }

    fun links(db: SqlDb, f: Filter): Map<String, Any?> {
        val trades = db.query("SELECT ic, $MEASURES, count(DISTINCT party) AS n_parties FROM ic_trade WHERE ${f.sql} GROUP BY 1", f.params)
            .associateBy { it["ic"] as String }
        val flows = db.query("SELECT ic, $FLOW FROM ic_flow WHERE settlement_date BETWEEN ? AND ? GROUP BY 1", f.params.take(2))
            .associateBy { it["ic"] as String }
        val rows = (trades.keys + flows.keys).toSortedSet().map { k ->
            LinkedHashMap<String, Any?>().apply { put("ic", k); trades[k]?.let { putAll(it) }; flows[k]?.let { putAll(it) } }
        }
        return mapOf("rows" to rows)
    }

    fun flow(db: SqlDb, from: String, to: String, b: String, ic: String?): Map<String, Any?> {
        val vals = (ic ?: "").split("|").filter { it.isNotEmpty() }
        val cond = if (vals.isEmpty()) "" else " AND ic IN (${vals.joinToString(",") { "?" }})"
        return mapOf("rows" to db.query("SELECT $b AS t, ic AS g, $FLOW FROM ic_flow WHERE settlement_date BETWEEN ? AND ?$cond GROUP BY 1, 2 ORDER BY 1, 2",
            listOf<Any?>(from, to) + vals))
    }
}
