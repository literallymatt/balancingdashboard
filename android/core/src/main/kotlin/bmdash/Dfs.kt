package bmdash

import java.time.LocalDate
import java.time.LocalDateTime

/**
 * Demand Flexibility Service for the DFS tab (mirrors bmdash/dfs.py and the /api/dfs routes in bmdash/api.py).
 * NESO publishes, per year, a summary per event half-hour (requirement, MW procured, accepted cost, settled delivery)
 * and every provider bid (DFS unit x half-hour: MW, price, accepted or not). Volumes are MW for a half-hour
 * (MWh = MW x 0.5). The 2025/26 archive has no event ids, types or tags: one Downwards event a day, named by its date.
 */
object Dfs {
    private const val PACKAGE = "demand-flexibility"
    private val SUMMARY = Regex("DFS Utilisation Report Summary( \\(Archive (\\d{4})/\\d{4}\\))?")
    private val BIDS = Regex("DFS Utilisation Report( \\(Archive (\\d{4})/\\d{4}\\))?")
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
            num(r["DFS Provider Bids Accepted Total Cost GBP"]) ?: 0.0, num(r["Settled Volume MW"]), num(r["Settled Cost GBP"]))
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

    private class Acc { val rows = ArrayList<List<Any?>>() }

    /** Read the current year's files whole (and the archives until held); replace everything from the first date read. */
    fun ingest(db: SqlDb, neso: Elexon): Pair<Int, Int> {
        val full = !held(db)
        val hh = ArrayList<List<Any?>>()
        val bids = ArrayList<List<Any?>>()
        for (res in neso.list("/package_show", listOf("id" to PACKAGE), listOf("result", "resources"))) {
            val name = (res.str("name") ?: "").trim()
            val id = res.str("id") ?: continue
            val kind = when { SUMMARY.matches(name) -> "hh"; BIDS.matches(name) -> "bid"; else -> continue }
            val archive = (if (kind == "hh") SUMMARY else BIDS).matchEntire(name)!!.groupValues[1].isNotEmpty()
            if (archive && !full) continue
            val acc = neso.read("/datastore_search_sql", listOf("sql" to "SELECT * FROM \"$id\""), { Acc() }, listOf("result", "records")) { a, r ->
                (if (kind == "hh") summaryRow(r) else bidRow(r))?.let { a.rows.add(it) }
            }
            (if (kind == "hh") hh else bids).addAll(acc.rows)
        }
        if (hh.isEmpty()) throw IllegalStateException("no DFS summary rows in $PACKAGE")
        val start = (hh + bids).minOf { it[0] as String }
        db.transaction {
            db.exec("DELETE FROM dfs_hh WHERE settlement_date >= ?", listOf(start))
            db.exec("DELETE FROM dfs_bid WHERE settlement_date >= ?", listOf(start))
            db.insertBatch("INSERT INTO dfs_hh VALUES (${List(11) { "?" }.joinToString(",")})", hh)
            db.insertBatch("INSERT INTO dfs_bid VALUES (${List(12) { "?" }.joinToString(",")})", bids)
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
    private const val HH = """sum(req_mw) * 0.5 AS req_mwh, sum(procured_mw) * 0.5 AS proc_mwh, sum(cost) AS cost,
        sum(settled_mw) * 0.5 AS settled_mwh, sum(settled_cost) AS settled_cost,
        sum(CASE WHEN settled_mw IS NOT NULL THEN procured_mw END) * 0.5 AS proc_settled_mwh,
        count(*) AS n_hh, count(DISTINCT event) AS n_events"""
    private const val BID = """sum(mw) * 0.5 AS offered_mwh, sum(CASE WHEN accepted THEN mw END) * 0.5 AS proc_mwh,
        sum(CASE WHEN accepted THEN mw * 0.5 * price END) AS cost, count(*) AS n_bids,
        sum(CASE WHEN accepted THEN 1 ELSE 0 END) AS n_accepted, count(DISTINCT unit) AS n_units, count(DISTINCT event) AS n_events,
        min(CASE WHEN accepted THEN price END) AS price_min, max(CASE WHEN accepted THEN price END) AS price_max"""

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
        fun withParty(party: String?): Pair<String, List<Any?>> {
            val v = vals(party)
            return if (v.isEmpty()) sql to params else "$sql AND party IN (${v.joinToString(",") { "?" }})" to params + v
        }
    }

    fun meta(db: SqlDb, status: Map<String, Any?>): Map<String, Any?> {
        val t = db.query("SELECT min(settlement_date) AS min, max(settlement_date) AS max, count(DISTINCT event) AS n_events FROM dfs_hh WHERE live")[0]
        val s = db.query("SELECT max(settlement_date) AS d FROM dfs_hh WHERE settled_mw IS NOT NULL")[0]
        return LinkedHashMap(t) + mapOf("settled_through" to s["d"]) + status
    }

    fun agg(db: SqlDb, f: Filter, b: String, group: String, party: String?, top: Int, rank: String): Map<String, Any?> {
        if (group != "none" && group !in DIMS) throw HttpError(400, "bad bucket or group")
        val bids = !(group == "none" || group in HH_GROUPS) || vals(party).isNotEmpty()
        val table = if (bids) "dfs_bid" else "dfs_hh"
        val measures = if (bids) BID else HH
        val (where, params) = if (bids) f.withParty(party) else f.sql to f.params
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

    fun events(db: SqlDb, f: Filter, party: String?): Map<String, Any?> {
        val ev = db.query("""SELECT event, min(settlement_date) AS date, min(direction) AS direction, min(tag) AS tag, min(CASE WHEN live THEN 1 ELSE 0 END) AS live,
               min(sp) AS sp_from, max(sp) AS sp_to, $HH, max(req_mw) AS req_mw
               FROM dfs_hh WHERE ${f.sql} GROUP BY 1""", f.params)
        val (bw, bp) = f.withParty(party)
        val bids = db.query("SELECT event, $BID, count(DISTINCT party) AS n_parties, " +
            "count(DISTINCT CASE WHEN accepted THEN party END) AS n_parties_acc FROM dfs_bid WHERE $bw GROUP BY 1", bp).associateBy { it["event"] as String }
        val picked = vals(party).isNotEmpty()
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

    fun providers(db: SqlDb, f: Filter, group: String, party: String?): Map<String, Any?> {
        if (group !in setOf("party", "zone", "unit")) throw HttpError(400, "bad group")
        val (where, params) = f.withParty(party)
        val extra = if (group == "unit") ", min(party) AS party" else ", count(DISTINCT party) AS n_parties"
        return mapOf("rows" to db.query("SELECT ${DIMS.getValue(group)} AS g, $BID$extra FROM dfs_bid WHERE $where GROUP BY 1 ORDER BY 1", params))
    }

    fun bids(db: SqlDb, event: String): Map<String, Any?> = linkedMapOf(
        "hh" to db.query("SELECT settlement_date AS date, sp, direction, tag, req_mw, procured_mw, cost, settled_mw, settled_cost FROM dfs_hh " +
            "WHERE event = ? ORDER BY sp", listOf(event)),
        "bids" to db.query("SELECT sp, party, unit, zone, mw, price, CASE WHEN accepted THEN 1 ELSE 0 END AS accepted FROM dfs_bid " +
            "WHERE event = ? ORDER BY sp, price, unit", listOf(event)),
    )
}
