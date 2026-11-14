package bmdash

import java.time.LocalDate
import java.time.LocalDateTime

/**
 * Demand Flexibility Service for the DFS tab (mirrors bmdash/dfs.py and the /api/dfs routes in bmdash/api.py).
 * NESO publishes, per year, a summary per event half-hour (requirement, MW procured, accepted cost, settled delivery)
 * and every provider bid (DFS unit x half-hour: MW, price, accepted or not). Volumes are MW for a half-hour
 * (MWh = MW x 0.5). The 2025/26 archive has no event ids, types or tags: one Downwards event a day, named by its date.
 * The service requirement file adds the guaranteed acceptance price and, from April 2026, a cap per zone (dfs_cap); each
 * event half-hour also carries Elexon's market index price (MID, APX). Bids are taken cheapest first and paid their own
 * price, so a half-hour's clearing price is its highest accepted bid.
 */
object Dfs {
    private const val PACKAGE = "demand-flexibility"
    private val SUMMARY = Regex("DFS Utilisation Report Summary( \\(Archive (\\d{4})/\\d{4}\\))?")
    private val BIDS = Regex("DFS Utilisation Report( \\(Archive (\\d{4})/\\d{4}\\))?")
    private val REQ = Regex("DFS Service Requirement( \\(Archive (\\d{4})/\\d{4}\\))?")
    private val CAP = Regex("\\s*Z(\\d+)\\s*:\\s*([\\d.]+)\\s*")
    private val SUFFIX = Regex("[ ,.]+(LIMITED|LTD\\.?)$")

    /** One name per provider: upper case, without the company suffix (NESO spells some differently file to file). */
    fun partyName(s: String?): String {
        val p = (s ?: "").trim().split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ").uppercase().replace(SUFFIX, "")
        return p.ifEmpty { "UNKNOWN" }
    }

    private fun num(v: Any?): Double? = when (v) {
        null -> null
        is Number -> v.toDouble()
        else -> v.toString().replace(",", "").takeIf { it.isNotEmpty() }?.toDoubleOrNull()
    }

    private fun settlementPeriod(local: LocalDateTime): Pair<String, Long> {
        val d = local.toLocalDate()
        val z = java.time.ZonedDateTime.ofLocal(local, Ingester.LONDON, null)
        val mins = java.time.Duration.between(Ingester.dayBoundsUtc(d).first, z.toInstant()).toMinutes()
        return d.toString() to (mins / 30) + 1
    }

    private fun whenOf(r: Map<String, Any?>): Pair<String, Long>? {
        val d = r.str("Delivery Date") ?: return null
        val t = (r.str("From_Local") ?: r.str("From"))?.trim() ?: return null
        val (hh, mm) = t.take(5).split(":").map { it.toInt() }
        return settlementPeriod(LocalDate.parse(d.take(10)).atTime(hh, mm))
    }

    /** (event id, direction, tag). */
    private fun eventOf(r: Map<String, Any?>, day: String): Triple<String, String, String> {
        val id = num(r["Event ID"]) ?: return Triple(day, "Downwards", "")
        return Triple(id.toLong().toString(), r.str("Event Type")?.takeIf { it.isNotEmpty() } ?: "Downwards", r.str("Event Tag") ?: "")
    }

    private fun live(r: Map<String, Any?>) = if ((r.str("Service Requirement Type") ?: "Live").ifEmpty { "Live" } != "Test") 1L else 0L

    fun summaryRow(r: Map<String, Any?>): List<Any?>? {
        val (d, sp) = whenOf(r) ?: return null
        val (ev, dir, tag) = eventOf(r, d)
        return listOf(d, sp, ev, dir, tag, live(r), num(r["Service Requirement MW"]), num(r["DFS Procured MW"]) ?: 0.0,
            num(r["DFS Provider Bids Accepted Total Cost GBP"]) ?: 0.0, num(r["Settled Volume MW"]), num(r["Settled Cost GBP"]), null, null)
    }

    fun bidRow(r: Map<String, Any?>): List<Any?>? {
        val w = whenOf(r)
        val mw = num(if (r.containsKey("DFS Procured MW")) r["DFS Procured MW"] else r["DFS Volume MW"])
        if (w == null || mw == null) return null
        val (d, sp) = w
        val (ev, dir, tag) = eventOf(r, d)
        return listOf(d, sp, ev, dir, tag, live(r), partyName(r.str("Registered DFS Participant")),
            r.str("DFS Unit ID")?.trim()?.ifEmpty { null } ?: "Unknown", num(r["Zone"])?.toLong(), mw,
            num(r["Utilisation Price GBP per MWh"]), if ((r.str("Status") ?: "").trim().lowercase() == "accepted") 1L else 0L)
    }

    fun held(db: SqlDb): Boolean = db.query("SELECT 1 FROM dfs_hh LIMIT 1").isNotEmpty()

    /** Tables from before the price columns are dropped (and re-fetched in full on the next refresh). */
    fun needsMigration(db: SqlDb): Boolean = db.query("PRAGMA table_info(dfs_hh)").none { it["name"] == "mip" }

    private class ReqAcc { val gap = HashMap<String, Double?>(); val caps = ArrayList<List<Any?>>() }
    private class MipAcc { val p = HashMap<String, Double>() }

    private class Acc { val rows = ArrayList<List<Any?>>() }

    /** Read the current year's files whole (and the archives until held); replace everything from the first date read. */
    fun ingest(db: SqlDb, neso: Elexon, elexon: Elexon): Pair<Int, Int> {
        val full = !held(db)
        val hh = ArrayList<List<Any?>>()
        val bids = ArrayList<List<Any?>>()
        val gap = HashMap<String, Double?>()
        val caps = ArrayList<List<Any?>>()
        for (res in neso.list("/package_show", listOf("id" to PACKAGE), listOf("result", "resources"))) {
            val name = (res.str("name") ?: "").trim()
            val id = res.str("id") ?: continue
            val kind = when { SUMMARY.matches(name) -> "hh"; BIDS.matches(name) -> "bid"; REQ.matches(name) -> "req"; else -> continue }
            val archive = (when (kind) { "hh" -> SUMMARY; "bid" -> BIDS; else -> REQ }).matchEntire(name)!!.groupValues[1].isNotEmpty()
            if (archive && !full) continue
            if (kind == "req") {
                val acc = neso.read("/datastore_search_sql", listOf("sql" to "SELECT * FROM \"$id\""), { ReqAcc() }, listOf("result", "records")) { a, r ->
                    val (d, sp) = whenOf(r) ?: return@read
                    val ev = eventOf(r, d).first
                    a.gap["$ev|$sp"] = num(r["Guaranteed Acceptance Price GBP per MWh"])
                    for (part in (r.str("Zonal Cap") ?: "").split(",")) {
                        val m = CAP.matchEntire(part) ?: continue
                        a.caps.add(listOf(d, sp, ev, m.groupValues[1].toLong(), m.groupValues[2].toDouble()))
                    }
                }
                gap.putAll(acc.gap); caps.addAll(acc.caps)
                continue
            }
            val acc = neso.read("/datastore_search_sql", listOf("sql" to "SELECT * FROM \"$id\""), { Acc() }, listOf("result", "records")) { a, r ->
                (if (kind == "hh") summaryRow(r) else bidRow(r))?.let { a.rows.add(it) }
            }
            (if (kind == "hh") hh else bids).addAll(acc.rows)
        }
        if (hh.isEmpty()) throw IllegalStateException("no DFS summary rows in $PACKAGE")
        // Market index price (APX) for the event half-hours, a month per request.
        val mip = HashMap<String, Double>()
        for (ym in hh.map { (it[0] as String).take(7) }.toSortedSet()) {
            val a = LocalDate.parse("$ym-01")
            val acc = elexon.read("/datasets/MID/stream", listOf("from" to "${a}T00:00Z", "to" to "${a.plusMonths(1)}T00:00Z"), { MipAcc() }) { x, r ->
                if (r.str("dataProvider") != "APXMIDP") return@read
                val v = r.dbl("volume") ?: return@read
                if (v == 0.0) return@read
                val d = r.str("settlementDate") ?: return@read
                x.p["$d|${r.long("settlementPeriod") ?: return@read}"] = r.dbl("price") ?: return@read
            }
            mip.putAll(acc.p)
        }
        val rows = hh.map { r -> r.take(11) + listOf(gap["${r[2]}|${r[1]}"], mip["${r[0]}|${r[1]}"]) }
        val start = (hh + bids).minOf { it[0] as String }
        db.transaction {
            for (t in listOf("dfs_hh", "dfs_bid", "dfs_cap")) db.exec("DELETE FROM $t WHERE settlement_date >= ?", listOf(start))
            db.insertBatch("INSERT INTO dfs_hh VALUES (${List(13) { "?" }.joinToString(",")})", rows)
            db.insertBatch("INSERT INTO dfs_bid VALUES (${List(12) { "?" }.joinToString(",")})", bids)
            db.insertBatch("INSERT INTO dfs_cap VALUES (?, ?, ?, ?, ?)", caps.filter { (it[0] as String) >= start })
        }
        return hh.size to bids.size
    }

    // ------------------------------------------------------------ queries (same SQL as bmdash/api.py)

    private val DIMS = linkedMapOf(
        "direction" to "direction",
        "tag" to "CASE WHEN tag = '' THEN 'Not stated' ELSE tag END",
        "party" to "party",
        "zone" to "CASE WHEN zone IS NULL THEN 'No zone' ELSE 'Zone ' || CAST(zone AS VARCHAR) END",
        "unit" to "unit",
    )
    private val HH_GROUPS = setOf("direction", "tag")
    // Event half-hours with their clearing price (highest accepted bid) and cheapest rejected bid.
    private const val HHP = """SELECT h.settlement_date AS settlement_date, h.sp AS sp, h.event AS event, h.direction AS direction, h.tag AS tag,
        h.live AS live, h.req_mw AS req_mw, h.procured_mw AS procured_mw, h.cost AS cost, h.settled_mw AS settled_mw,
        h.settled_cost AS settled_cost, h.gap AS gap, h.mip AS mip, p.clr AS clr, p.rej AS rej
        FROM dfs_hh h LEFT JOIN (SELECT event, sp, max(CASE WHEN accepted THEN price END) AS clr,
            min(CASE WHEN NOT accepted THEN price END) AS rej FROM dfs_bid GROUP BY 1, 2) p ON p.event = h.event AND p.sp = h.sp"""
    private const val HH = """sum(req_mw) * 0.5 AS req_mwh, sum(procured_mw) * 0.5 AS proc_mwh, sum(cost) AS cost,
        sum(settled_mw) * 0.5 AS settled_mwh, sum(settled_cost) AS settled_cost,
        sum(CASE WHEN settled_mw IS NOT NULL THEN procured_mw END) * 0.5 AS proc_settled_mwh,
        count(*) AS n_hh, count(DISTINCT event) AS n_events,
        sum(clr * procured_mw) / NULLIF(sum(CASE WHEN clr IS NOT NULL THEN procured_mw END), 0) AS clr_avg,
        min(clr) AS clr_min, max(clr) AS clr_max, min(rej) AS rej_min, count(clr) AS n_cleared,
        sum(CASE WHEN clr IS NOT NULL THEN mip * procured_mw END) / NULLIF(sum(CASE WHEN clr IS NOT NULL AND mip IS NOT NULL THEN procured_mw END), 0) AS mip_w,
        avg(mip) AS mip_avg, max(gap) AS gap_max"""
    private const val BID = """sum(mw) * 0.5 AS offered_mwh, sum(CASE WHEN accepted THEN mw END) * 0.5 AS proc_mwh,
        sum(CASE WHEN accepted THEN mw * 0.5 * price END) AS cost, count(*) AS n_bids,
        sum(CASE WHEN accepted THEN 1 ELSE 0 END) AS n_accepted, count(DISTINCT unit) AS n_units, count(DISTINCT event) AS n_events,
        min(CASE WHEN accepted THEN price END) AS price_min, max(CASE WHEN accepted THEN price END) AS price_max,
        min(CASE WHEN NOT accepted THEN price END) AS rej_min"""

    private fun vals(raw: String?) = (raw ?: "").split("|").filter { it.isNotEmpty() }

    class Filter(p: Map<String, String>, from: String, to: String) {
        val where = arrayListOf("settlement_date BETWEEN ? AND ?")
        val params = arrayListOf<Any?>(from, to)
        init {
            if (!(p["test"] == "true" || p["test"] == "1")) where.add("live")
            for (dim in listOf("direction", "tag")) {
                val v = vals(p[dim])
                if (v.isEmpty()) continue
                where.add("${DIMS.getValue(dim)} IN (${v.joinToString(",") { "?" }})")
                params.addAll(v)
            }
        }
        val sql get() = where.joinToString(" AND ")
        /** Add the provider and zone picks, which only bids carry. */
        fun withParty(party: String?, zone: String? = null): Pair<String, List<Any?>> = bidf(sql, params, party, zone)
    }

    private fun bidf(where0: String, params0: List<Any?>, party: String?, zone: String?): Pair<String, List<Any?>> {
        var where = where0
        var params = params0
        for ((col, v) in listOf("party" to vals(party), "zone" to vals(zone).filter { s -> s.all { it.isDigit() } }.map { it.toLong() })) {
            if (v.isEmpty()) continue
            where = "$where AND $col IN (${v.joinToString(",") { "?" }})"
            params = params + v
        }
        return where to params
    }

    fun meta(db: SqlDb, status: Map<String, Any?>): Map<String, Any?> {
        val t = db.query("SELECT min(settlement_date) AS min, max(settlement_date) AS max, count(DISTINCT event) AS n_events FROM dfs_hh WHERE live")[0]
        val s = db.query("SELECT max(settlement_date) AS d FROM dfs_hh WHERE settled_mw IS NOT NULL")[0]
        return LinkedHashMap(t) + mapOf("settled_through" to s["d"]) + status
    }

    fun agg(db: SqlDb, f: Filter, b: String, group: String, party: String?, zone: String?, top: Int, rank: String): Map<String, Any?> {
        if (group != "none" && group !in DIMS) throw HttpError(400, "bad bucket or group")
        val bids = !(group == "none" || group in HH_GROUPS) || vals(party).isNotEmpty() || vals(zone).isNotEmpty()
        val table = if (bids) "dfs_bid" else "($HHP) x"
        val measures = if (bids) BID else HH
        val (where, params) = if (bids) f.withParty(party, zone) else f.sql to f.params
        val source = if (bids) "bids" else "events"
        if (group == "none") {
            val rows = db.query("SELECT $b AS t, 'All' AS g, $measures FROM $table WHERE $where GROUP BY 1, 2 ORDER BY 1", params)
            return linkedMapOf("rows" to rows, "groups" to listOf("All"), "source" to source)
        }
        val g = DIMS.getValue(group)
        val m = if (bids) (if (rank == "cash") "CASE WHEN accepted THEN mw * price END" else "CASE WHEN accepted THEN mw END")
                else (if (rank == "cash") "cost" else "procured_mw")
        val ranked = db.query("SELECT $g AS g, coalesce(sum($m), 0) AS m FROM $table WHERE $where GROUP BY 1 ORDER BY 2 DESC, 1", params)
        val keep = ranked.take(top).map { it["g"] }
        val folded = ranked.size > top
        val gexpr = if (folded) "CASE WHEN $g IN (${keep.joinToString(",") { "?" }}) THEN $g ELSE 'Other (rest)' END" else g
        val rows = db.query("SELECT $b AS t, $gexpr AS g, $measures FROM $table WHERE $where GROUP BY 1, 2 ORDER BY 1",
            (if (folded) keep else emptyList()) + params)
        return linkedMapOf("rows" to rows, "groups" to keep + (if (folded) listOf("Other (rest)") else emptyList()),
            "n_groups" to ranked.size, "source" to source)
    }

    fun events(db: SqlDb, f: Filter, party: String?, zone: String?): Map<String, Any?> {
        val ev = db.query("""SELECT event, min(settlement_date) AS date, min(direction) AS direction, min(tag) AS tag, min(CASE WHEN live THEN 1 ELSE 0 END) AS live,
               min(sp) AS sp_from, max(sp) AS sp_to, $HH, max(req_mw) AS req_mw
               FROM ($HHP) x WHERE ${f.sql} GROUP BY 1""", f.params)
        val (bw, bp) = f.withParty(party, zone)
        val bids = db.query("SELECT event, $BID, count(DISTINCT party) AS n_parties, " +
            "count(DISTINCT CASE WHEN accepted THEN party END) AS n_parties_acc FROM dfs_bid WHERE $bw GROUP BY 1", bp).associateBy { it["event"] as String }
        val picked = vals(party).isNotEmpty() || vals(zone).isNotEmpty()
        val out = ArrayList<Map<String, Any?>>()
        for (r in ev) {
            val b = bids[r["event"] as String]
            if (picked && b == null) continue
            val x = LinkedHashMap(r)
            if (b != null) {
                for (k in listOf("offered_mwh", "n_bids", "n_accepted", "n_units", "n_parties", "n_parties_acc", "price_min", "price_max")) x[k] = b[k]
                if (picked) { x["party_mwh"] = b["proc_mwh"]; x["party_cost"] = b["cost"] }
            }
            out.add(x)
        }
        out.sortWith(compareBy<Map<String, Any?>>({ it["date"] as String }, { (it["sp_from"] as Number).toLong() }, { it["event"] as String }).reversed())
        return mapOf("rows" to out)
    }

    fun providers(db: SqlDb, f: Filter, group: String, party: String?, zone: String?): Map<String, Any?> {
        if (group !in setOf("party", "zone", "unit")) throw HttpError(400, "bad group")
        val (where, params) = f.withParty(party, zone)
        val extra = if (group == "unit") ", min(party) AS party" else ", count(DISTINCT party) AS n_parties"
        return mapOf("rows" to db.query("SELECT ${DIMS.getValue(group)} AS g, $BID$extra FROM dfs_bid WHERE $where GROUP BY 1 ORDER BY 1", params))
    }

    fun prices(db: SqlDb, f: Filter, party: String?, zone: String?, bin: Double): Map<String, Any?> {
        if (!(bin > 0 && bin <= 1000)) throw HttpError(400, "bad bin")
        val (where, params) = f.withParty(party, zone)
        val rows = db.query("""SELECT direction, price, CASE WHEN accepted THEN 1 ELSE 0 END AS acc, sum(mw) * 0.5 AS mwh, count(*) AS n
            FROM dfs_bid WHERE $where AND price IS NOT NULL GROUP BY 1, 2, 3""", params)
        val acc = java.util.TreeMap<Pair<String, Double>, DoubleArray>(compareBy<Pair<String, Double>>({ it.first }, { it.second }))
        for (r in rows) {
            val p = Math.floor((r["price"] as Number).toDouble() / bin) * bin
            val x = acc.getOrPut((r["direction"] as String) to p) { DoubleArray(4) }
            val a = (r["acc"] as Number).toLong() != 0L
            x[if (a) 0 else 1] += (r["mwh"] as Number?)?.toDouble() ?: 0.0
            x[if (a) 2 else 3] += (r["n"] as Number).toDouble()
        }
        val out = acc.map { (k, v) -> linkedMapOf<String, Any?>("direction" to k.first, "p" to k.second, "acc_mwh" to v[0], "rej_mwh" to v[1],
            "n_acc" to v[2].toLong(), "n_rej" to v[3].toLong()) }
        return linkedMapOf("rows" to out, "bin" to bin)
    }

    fun zones(db: SqlDb, f: Filter, party: String?, event: String?): Map<String, Any?> {
        val (where, params) = if (event != null) "event = ?" to listOf<Any?>(event) else f.sql to f.params
        val (bw, bp) = bidf(where, params, party, null)
        val bids = db.query("SELECT zone, $BID, count(DISTINCT party) AS n_parties FROM dfs_bid WHERE $bw AND zone IS NOT NULL GROUP BY 1", bp)
            .associateBy { (it["zone"] as Number).toLong() }
        val caps = db.query("""SELECT c.zone AS zone, count(*) AS n_cap_hh, sum(CASE WHEN c.cap_mw = 0 THEN 1 ELSE 0 END) AS n_closed,
                min(c.cap_mw) AS cap_min, max(c.cap_mw) AS cap_max
                FROM dfs_cap c JOIN (SELECT event, sp FROM dfs_hh WHERE $where) h ON h.event = c.event AND h.sp = c.sp GROUP BY 1""", params)
            .associateBy { (it["zone"] as Number).toLong() }
        val rows = (bids.keys + caps.keys).toSortedSet().map { z ->
            LinkedHashMap<String, Any?>().apply { put("zone", z); bids[z]?.let { putAll(it) }; caps[z]?.let { putAll(it) }; put("zone", z) }
        }
        return mapOf("rows" to rows)
    }

    fun bids(db: SqlDb, event: String): Map<String, Any?> = linkedMapOf(
        "hh" to db.query("SELECT settlement_date AS date, sp, direction, tag, req_mw, procured_mw, cost, settled_mw, settled_cost, gap, mip, clr, rej " +
            "FROM ($HHP) x WHERE event = ? ORDER BY sp", listOf(event)),
        "bids" to db.query("SELECT sp, party, unit, zone, mw, price, CASE WHEN accepted THEN 1 ELSE 0 END AS accepted FROM dfs_bid " +
            "WHERE event = ? ORDER BY sp, price, unit", listOf(event)),
        "caps" to db.query("SELECT sp, zone, cap_mw FROM dfs_cap WHERE event = ? ORDER BY sp, zone", listOf(event)),
    )
}
