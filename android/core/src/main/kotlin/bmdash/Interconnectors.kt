package bmdash

import java.time.LocalDate

/**
 * Interconnector balancing for the Interconnectors tab (mirrors bmdash/interconnectors.py and the /api/ic routes in
 * bmdash/api.py). Interconnectors are not in the Balancing Mechanism: NESO's trades over them are non-BM actions in
 * Elexon BSAD, picked out of the same monthly DISBSAD download as the Total costs figures (see CostIngester.fetchBsad).
 * Physical flows per link come from Elexon FUELHH. Positive volume: NESO buys (into GB); positive flow: import.
 * Elexon publishes a period's BSAD only once it starts, so the lots NESO has already awarded in its interconnector auctions
 * for later periods are added from the NESO auction file as party [AUCTION_PARTY] (see CostIngester.fetchAuctions); the
 * next refresh replaces them with the BSAD trades.
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

    // NESO auction file (interconnector-requirement-and-auction-summary-data): per-link cleared volume column -> link.
    const val AUCTION_PACKAGE = "interconnector-requirement-and-auction-summary-data"
    const val AUCTION_RESOURCE = "Interconnector Requirements and Auction Summary"
    val AUCTION_LINK = mapOf(
        "IFA1 Volume" to "IFA", "IFA2 Volume" to "IFA2", "EL Volume" to "ELEC", "BN Volume" to "BRTN",
        "NEMO Volume" to "NEMO", "VKL Volume" to "VKL",
    )
    // Qualified IC code in the auction file -> link (for lots on one link that give no per-link split).
    val AUCTION_IC = mapOf("IFA1" to "IFA", "IFA" to "IFA", "IFA2" to "IFA2", "EL" to "ELEC", "BN" to "BRTN", "NEMO" to "NEMO", "VKL" to "VKL")
    // Party shown for awarded auction lots that BSAD has not published yet.
    const val AUCTION_PARTY = "NESO auction (awaiting BSAD)"

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
        /** Latest (settlement date, period) with any real BSAD action: later periods are not published yet (every future
         *  period carries a placeholder row with no asset), so awarded auction lots fill them. */
        var through: Pair<String, Long>? = null
            private set

        private fun see(d: String, sp: Long) {
            val t = through
            if (t == null || d > t.first || (d == t.first && sp > t.second)) through = d to sp
        }

        fun add(r: Map<String, Any?>) {
            if (!r.str("assetId").isNullOrEmpty()) {
                val d = r.str("settlementDate"); val sp = r.long("settlementPeriod")
                if (d != null && sp != null) see(d, sp)
            }
            val (ic, kind) = classify(r.str("assetId")) ?: return
            val vol = r.dbl("volume") ?: return
            if (vol == 0.0) return
            val key = listOf<Any>(r.str("settlementDate") ?: return, (r.long("settlementPeriod") ?: return), ic,
                r.str("partyId") ?: "Unknown", kind, if (r["soFlag"] == true) 1L else 0L, vol > 0)
            val cost = r.dbl("cost") ?: 0.0
            val x = acc.getOrPut(key) { doubleArrayOf(0.0, 0.0, 0.0, Double.NaN, Double.NaN) }
            x[0] += vol; x[1] += cost; x[2] += 1.0
            if (cost != 0.0) {  // highest and lowest single-trade price in the row (NaN: no priced trade yet)
                val price = cost / vol
                if (x[3].isNaN() || price > x[3]) x[3] = price
                if (x[4].isNaN() || price < x[4]) x[4] = price
            }
        }

        /** One link's share of an awarded auction lot in one settlement period (see CostIngester.fetchAuctions). */
        fun addAuction(d: String, sp: Long, ic: String, so: Boolean, vol: Double, price: Double?, hi: Double?, lo: Double?) {
            if (vol == 0.0) return
            val key = listOf<Any>(d, sp, ic, AUCTION_PARTY, "trade", if (so) 1L else 0L, vol > 0)
            val x = acc.getOrPut(key) { doubleArrayOf(0.0, 0.0, 0.0, Double.NaN, Double.NaN) }
            x[0] += vol; x[1] += if (price != null) vol * price else 0.0; x[2] += 1.0
            if (price != null) {
                if (hi != null && (x[3].isNaN() || hi > x[3])) x[3] = hi
                if (lo != null && (x[4].isNaN() || lo < x[4])) x[4] = lo
            }
        }

        fun merge(o: TradeSink) {
            o.through?.let { see(it.first, it.second) }
            for ((k, v) in o.acc) {
                val x = acc.getOrPut(k) { doubleArrayOf(0.0, 0.0, 0.0, Double.NaN, Double.NaN) }
                for (i in 0..2) x[i] += v[i]
                if (!v[3].isNaN() && (x[3].isNaN() || v[3] > x[3])) x[3] = v[3]
                if (!v[4].isNaN() && (x[4].isNaN() || v[4] < x[4])) x[4] = v[4]
            }
        }

        fun rows(): List<List<Any?>> = acc.map { (k, v) ->
            listOf(k[0], k[1], k[2], k[3], k[4], k[5], v[0], v[1], v[2].toLong(), v[3].takeUnless { it.isNaN() }, v[4].takeUnless { it.isNaN() })
        }
    }

    fun held(db: SqlDb): Boolean = db.query("SELECT 1 FROM ic_trade LIMIT 1").isNotEmpty()

    fun writeTrades(db: SqlDb, rows: List<List<Any?>>, start: LocalDate, end: LocalDate) = db.transaction {
        db.exec("DELETE FROM ic_trade WHERE settlement_date BETWEEN ? AND ?", listOf(start.toString(), end.toString()))
        db.insertBatch("INSERT INTO ic_trade VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
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
        sum(n) AS n_trades,
        max(CASE WHEN volume > 0 THEN price_max END) AS buy_max, min(CASE WHEN volume > 0 THEN price_min END) AS buy_min,
        max(CASE WHEN volume < 0 THEN price_max END) AS sell_max, min(CASE WHEN volume < 0 THEN price_min END) AS sell_min"""
    private const val FLOW = """count(*) AS n, avg(flow_mw) AS flow_avg, min(flow_mw) AS flow_min, max(flow_mw) AS flow_max,
        sum(CASE WHEN flow_mw > 0 THEN flow_mw * 0.5 ELSE 0 END) AS import_mwh,
        sum(CASE WHEN flow_mw < 0 THEN flow_mw * 0.5 ELSE 0 END) AS export_mwh"""

    /** Restrict to one time bucket: `at` is a bucket label from ic/agg at granularity `at_bucket` (mirrors api._at). */
    class At(p: Map<String, String>, buckets: Map<String, String>) {
        val sql: String
        val params: List<Any?>
        init {
            val at = p["at"]
            if (at.isNullOrEmpty()) { sql = ""; params = emptyList() } else {
                val ab = p["at_bucket"] ?: "day"
                val b = buckets[ab]?.takeIf { ab != "none" } ?: throw HttpError(400, "bad at_bucket")
                val v: Any = if (ab == "tod") at.toLongOrNull() ?: throw HttpError(400, "bad at")
                    else at.take(19).let { if (it.length == 10) it + "T00:00:00" else it }
                sql = " AND $b = ?"; params = listOf(v)
            }
        }
    }

    class Filter(p: Map<String, String>, from: String, to: String, buckets: Map<String, String>) {
        val where = arrayListOf("settlement_date BETWEEN ? AND ?")
        val params = arrayListOf<Any?>(from, to)
        private val at = At(p, buckets)
        init {
            for (dim in DIMS.keys) {
                val vals = (p[dim] ?: "").split("|").filter { it.isNotEmpty() }
                if (vals.isEmpty()) continue
                where.add("${DIMS.getValue(dim)} IN (${vals.joinToString(",") { "?" }})")
                params.addAll(vals)
            }
            params.addAll(at.params)
        }
        val sql get() = where.joinToString(" AND ") + at.sql
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

    fun links(db: SqlDb, f: Filter, at: At): Map<String, Any?> {
        val trades = db.query("SELECT ic, $MEASURES, count(DISTINCT party) AS n_parties FROM ic_trade WHERE ${f.sql} GROUP BY 1", f.params)
            .associateBy { it["ic"] as String }
        val flows = db.query("SELECT ic, $FLOW FROM ic_flow WHERE settlement_date BETWEEN ? AND ?${at.sql} GROUP BY 1", f.params.take(2) + at.params)
            .associateBy { it["ic"] as String }
        val rows = (trades.keys + flows.keys).toSortedSet().map { k ->
            LinkedHashMap<String, Any?>().apply { put("ic", k); trades[k]?.let { putAll(it) }; flows[k]?.let { putAll(it) } }
        }
        return mapOf("rows" to rows)
    }

    /** Trade prices per bucket and group, with the average half-hourly marginal ("clearing") price. Mirrors api.ic_prices. */
    fun prices(db: SqlDb, f: Filter, b: String, group: String): Map<String, Any?> {
        val g = if (group == "none") "'All'" else DIMS[group] ?: throw HttpError(400, "bad bucket or group")
        val rows = db.query("SELECT $b AS t, $g AS g, $MEASURES FROM ic_trade WHERE ${f.sql} GROUP BY 1, 2 ORDER BY 1, 2", f.params)
        val marg = db.query("""WITH h AS (SELECT settlement_date, sp, $g AS g,
                max(CASE WHEN volume > 0 THEN price_max END) AS bm, min(CASE WHEN volume < 0 THEN price_min END) AS sm
                FROM ic_trade WHERE ${f.sql} GROUP BY 1, 2, 3)
            SELECT $b AS t, g, avg(bm) AS buy_clear, avg(sm) AS sell_clear, count(bm) AS buy_hh, count(sm) AS sell_hh FROM h GROUP BY 1, 2""", f.params)
            .associateBy { "${it["t"]}|${it["g"]}" }
        for (r in rows) {
            val m = marg["${r["t"]}|${r["g"]}"]
            (r as MutableMap<String, Any?>).apply { for (k in listOf("buy_clear", "sell_clear", "buy_hh", "sell_hh")) put(k, m?.get(k)) }
        }
        return mapOf("rows" to rows)
    }

    /** Who set the price: priced trades per link x counterparty x trade type x SO flag for one direction, with the number of
     *  half-hours each group held the marginal trade. Mirrors api.ic_trades. */
    fun trades(db: SqlDb, f: Filter, dir: String): Map<String, Any?> {
        val (sign, best, col) = when (dir) {
            "buy" -> Triple(">", "max", "price_max")
            "sell" -> Triple("<", "min", "price_min")
            else -> throw HttpError(400, "bad dir")
        }
        val order = if (dir == "buy") "price_max DESC" else "price_min ASC"
        val rows = db.query("""WITH t AS (SELECT * FROM ic_trade WHERE ${f.sql} AND volume $sign 0 AND cost <> 0),
                h AS (SELECT settlement_date, sp, $best($col) AS m FROM t GROUP BY 1, 2)
            SELECT t.ic AS ic, t.party AS party, ${DIMS.getValue("kind")} AS kind, ${DIMS.getValue("so")} AS so,
                   sum(t.volume) AS vol, sum(t.cost) AS cost, max(t.price_max) AS price_max, min(t.price_min) AS price_min,
                   sum(t.n) AS n_trades, count(*) AS n_hh, sum(CASE WHEN t.$col = h.m THEN 1 ELSE 0 END) AS n_marginal
            FROM t JOIN h ON t.settlement_date = h.settlement_date AND t.sp = h.sp
            GROUP BY 1, 2, 3, 4 ORDER BY $order, 1, 2, 3, 4""", f.params)
        return mapOf("rows" to rows)
    }

    fun flow(db: SqlDb, from: String, to: String, b: String, ic: String?): Map<String, Any?> {
        val vals = (ic ?: "").split("|").filter { it.isNotEmpty() }
        val cond = if (vals.isEmpty()) "" else " AND ic IN (${vals.joinToString(",") { "?" }})"
        return mapOf("rows" to db.query("SELECT $b AS t, ic AS g, $FLOW FROM ic_flow WHERE settlement_date BETWEEN ? AND ?$cond GROUP BY 1, 2 ORDER BY 1, 2",
            listOf<Any?>(from, to) + vals))
    }

    // ------------------------------------------------------------ flow reversals (mirrors api.ic_reversals; see the comment above REV_LINKS there)

    private val REV_LINKS = listOf("IFA", "IFA2", "ELEC", "NEMO", "BRTN", "VKL")
    private const val REV_FROM = "2026-05-20"
    private const val REV_LINK_CAP = 300.0
    private const val REV_TOTAL_CAP = 1500.0
    private const val REV_MIN_MW = 50.0
    private const val REV_TOL = 1.0
    private const val REV_SQL = """SELECT f.d AS d, f.h AS h, f.ic AS ic, f.flow AS flow, coalesce(t.neso, 0) AS neso, coalesce(t.cp, 0) AS cp
        FROM (SELECT settlement_date AS d, sp + sp % 2 AS h, ic, avg(flow_mw) AS flow FROM ic_flow
              WHERE settlement_date BETWEEN ? AND ? GROUP BY 1, 2, 3) f
        LEFT JOIN (SELECT settlement_date AS d, sp + sp % 2 AS h, ic, sum(volume) AS neso,
                          sum(CASE WHEN kind = 'trade' THEN volume ELSE 0 END) AS cp FROM ic_trade
                   WHERE settlement_date BETWEEN ? AND ? GROUP BY 1, 2, 3) t
        ON t.d = f.d AND t.h = f.h AND t.ic = f.ic
        ORDER BY 1, 2, 3"""
    // Hours not metered yet in which NESO has already traded (mirrors api.REV_UPCOMING_SQL / api.rev_upcoming).
    private const val REV_UPCOMING_SQL = """SELECT settlement_date AS d, sp + sp % 2 AS h, ic, sum(volume) AS neso,
        sum(CASE WHEN kind = 'trade' THEN volume ELSE 0 END) AS cp FROM ic_trade
        WHERE settlement_date BETWEEN ? AND ? AND settlement_date >= ? GROUP BY 1, 2, 3 ORDER BY 1, 2, 3"""
    private const val REV_LAST_FLOW_SQL =
        "SELECT settlement_date AS d, max(sp) AS sp FROM ic_flow WHERE settlement_date = (SELECT max(settlement_date) FROM ic_flow) GROUP BY 1"

    /** Link-hours after the last metered hour, and the same summed per hour: no verdict, only whether a limit could be broken. */
    private fun upcoming(db: SqlDb, from: String, to: String): Pair<List<Map<String, Any?>>, List<Map<String, Any?>>> {
        val last = db.query(REV_LAST_FLOW_SQL).firstOrNull()
        val lastD = last?.str("d")?.take(10)
        val lastH = last?.long("sp")?.let { it + it % 2 }
        val links = ArrayList<Map<String, Any?>>()
        val hours = LinkedHashMap<String, MutableMap<String, Any?>>()
        for (r in db.query(REV_UPCOMING_SQL, listOf(from, to, lastD ?: from))) {
            val d = r.str("d")!!.take(10)
            val h = r.long("h") ?: continue
            if (lastD != null && lastH != null && (d < lastD || (d == lastD && h <= lastH))) continue
            val ic = r.str("ic")!!
            val cp = r.dbl("cp") ?: 0.0
            val couldOver = d >= REV_FROM && ic in REV_LINKS && Math.abs(cp) > REV_LINK_CAP + REV_TOL
            val hour = h.toInt() / 2 - 1
            links.add(linkedMapOf("d" to d, "hour" to hour, "ic" to ic, "neso" to (r.dbl("neso") ?: 0.0), "cp" to cp, "could_over" to couldOver))
            val x = hours.getOrPut("$d|$hour") { linkedMapOf("d" to d, "hour" to hour, "cp" to 0.0, "n_could_over" to 0, "links" to ArrayList<String>()) }
            if (ic in REV_LINKS) x["cp"] = (x["cp"] as Double) + Math.abs(cp)
            if (couldOver) x["n_could_over"] = (x["n_could_over"] as Int) + 1
            @Suppress("UNCHECKED_CAST")
            (x["links"] as ArrayList<String>).add(ic)
        }
        for (x in hours.values) x["could_total_over"] = (x["d"] as String) >= REV_FROM && (x["cp"] as Double) > REV_TOTAL_CAP + REV_TOL
        return links to hours.values.toList()
    }

    private fun revBucket(d: String, hour: Int, bucket: String): String = when (bucket) {
        "hour" -> "${d}T${"%02d".format(minOf(hour, 23))}:00:00"
        "week" -> LocalDate.parse(d).let { it.minusDays((it.dayOfWeek.value - 1).toLong()) }.toString() + "T00:00:00"
        "month" -> d.substring(0, 8) + "01T00:00:00"
        else -> "${d}T00:00:00"
    }

    /** Hour by hour and link by link: flow, NESO's trades, the flow without them, reversals and the trading limit. */
    fun reversals(db: SqlDb, from: String, to: String, bucketIn: String): Map<String, Any?> {
        val bucket = if (bucketIn in listOf("hour", "day", "week", "month")) bucketIn else if (bucketIn == "sp") "hour" else "day"
        val raw = db.query(REV_SQL, listOf(from, to, from, to))
        val hours = LinkedHashMap<String, MutableMap<String, Any?>>()
        val series = LinkedHashMap<String, MutableMap<String, Any?>>()
        val events = ArrayList<Map<String, Any?>>()
        val detail = ArrayList<Map<String, Any?>>()
        val keepDetail = java.time.temporal.ChronoUnit.DAYS.between(LocalDate.parse(from), LocalDate.parse(to)) <= 6
        for (r in raw) {
            val d = r.str("d")!!.take(10)
            val hour = (r.long("h") ?: 0L).toInt() / 2 - 1
            val ic = r.str("ic")!!
            val flow = r.dbl("flow") ?: 0.0
            val neso = r.dbl("neso") ?: 0.0
            val cp = r.dbl("cp") ?: 0.0
            val pre = flow - neso
            val flipped = Math.abs(pre) >= REV_MIN_MW && Math.abs(flow) >= REV_MIN_MW && (pre > 0) != (flow > 0)
            val against = if (Math.abs(pre) >= REV_MIN_MW && cp * pre < 0) Math.abs(cp) else 0.0
            val over = d >= REV_FROM && ic in REV_LINKS && against > REV_LINK_CAP + REV_TOL
            val row = linkedMapOf<String, Any?>("d" to d, "hour" to hour, "ic" to ic, "flow" to flow, "neso" to neso, "cp" to cp, "pre" to pre,
                "flipped" to flipped, "against" to against, "over" to over)
            if (keepDetail) detail.add(row)
            if (flipped || against != 0.0) events.add(row)
            val h = hours.getOrPut("$d|$hour") { linkedMapOf("d" to d, "hour" to hour, "against" to 0.0, "n_over" to 0, "flips" to 0, "links" to ArrayList<String>()) }
            if (ic in REV_LINKS) h["against"] = (h["against"] as Double) + against
            if (over) h["n_over"] = (h["n_over"] as Int) + 1
            if (flipped) h["flips"] = (h["flips"] as Int) + 1
            @Suppress("UNCHECKED_CAST")
            if (flipped || against != 0.0) (h["links"] as ArrayList<String>).add(ic)
            val t = revBucket(d, hour, bucket)
            val s = series.getOrPut("$t|$ic") { linkedMapOf("t" to t, "ic" to ic, "flip_hours" to 0, "against_mwh" to 0.0, "over_hours" to 0, "hours" to 0) }
            if (flipped) s["flip_hours"] = (s["flip_hours"] as Int) + 1
            s["against_mwh"] = (s["against_mwh"] as Double) + against
            if (over) s["over_hours"] = (s["over_hours"] as Int) + 1
            s["hours"] = (s["hours"] as Int) + 1
        }
        for (h in hours.values) h["total_over"] = (h["d"] as String) >= REV_FROM && (h["against"] as Double) > REV_TOTAL_CAP + REV_TOL
        val restricted = hours.values.filter { (it["d"] as String) >= REV_FROM }
        val summary = linkedMapOf<String, Any?>(
            "hours" to hours.size, "restricted_hours" to restricted.size,
            "flip_hours" to hours.values.count { (it["flips"] as Int) > 0 }, "flip_link_hours" to events.count { it["flipped"] == true },
            "against_mwh" to events.filter { it["ic"] in REV_LINKS }.sumOf { it["against"] as Double },
            "over_link_hours" to events.count { it["over"] == true }, "over_hours" to hours.values.count { (it["n_over"] as Int) > 0 },
            "total_over_hours" to hours.values.count { it["total_over"] == true },
            "max_against" to (restricted.maxOfOrNull { it["against"] as Double } ?: 0.0),
            "max_link_against" to (events.filter { (it["d"] as String) >= REV_FROM && it["ic"] in REV_LINKS }.maxOfOrNull { it["against"] as Double } ?: 0.0),
        )
        val sorted = events.sortedWith(compareBy<Map<String, Any?>>({ if (it["over"] == true) 0 else 1 }, { -(it["against"] as Double) }, { it["d"] as String }, { it["hour"] as Int }))
        val hlist = hours.values.filter { (it["against"] as Double) != 0.0 || (it["flips"] as Int) > 0 || (it["n_over"] as Int) > 0 }
        val (up, upHours) = upcoming(db, from, to)
        return mapOf(
            "upcoming" to up, "upcoming_hours" to upHours,
            "rules" to mapOf("from" to REV_FROM, "link_cap" to REV_LINK_CAP, "total_cap" to REV_TOTAL_CAP, "min_mw" to REV_MIN_MW, "links" to REV_LINKS),
            "summary" to summary, "series" to series.values.sortedWith(compareBy({ it["t"] as String }, { it["ic"] as String })), "hours" to hlist,
            "events" to sorted.take(1000), "n_events" to events.size, "detail" to detail,
        )
    }
}
