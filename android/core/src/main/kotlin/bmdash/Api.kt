package bmdash

import java.net.URLDecoder
import java.time.LocalDate

class Response(val status: Int, val body: String, val contentType: String = "application/json")

class HttpError(val status: Int, message: String) : Exception(message)

/**
 * The dashboard's JSON API over the SQLite store. Mirrors bmdash/api.py: same routes, parameters and
 * response shapes, so the web front end runs unchanged against either backend.
 */
class Api(private val db: SqlDb, private val control: IngestControl, private val debug: DebugSampler? = null) {

    /** Returns null when the path is not an API route. */
    fun handle(method: String, path: String, queryString: String?): Response? {
        if (!path.startsWith("/api/")) return null
        return try {
            val p = parseQuery(queryString)
            Response(200, Json.write(route(path.removePrefix("/api/"), p)))
        } catch (e: HttpError) {
            Response(e.status, Json.write(mapOf("detail" to e.message)))
        } catch (e: Exception) {
            Response(500, Json.write(mapOf("detail" to (e.message ?: e.toString()))))
        }
    }

    private fun route(r: String, p: Map<String, String>): Any? = when {
        r == "meta" -> meta()
        r == "agg" -> agg(Filters(p), p["bucket"] ?: "day", p["group"] ?: "none", (p["top"] ?: "8").toInt(), p["rank"] ?: "cash")
        r == "summary" -> summary(Filters(p))
        r == "breakdown" -> breakdown(Filters(p), p["group"] ?: "tech", (p["limit"] ?: "500").toInt())
        r == "heatmap" -> heatmap(Filters(p))
        r == "units" -> units(Filters(p))
        r == "periods" -> periods(Filters(p), (p["limit"] ?: "2000").toInt())
        r == "acceptances" -> acceptances(req(p, "unit"), date(p, "from"), date(p, "to"), (p["limit"] ?: "2000").toInt())
        r == "prices" -> prices(date(p, "from"), date(p, "to"), p["bucket"] ?: "day")
        r == "bsad" -> bsad(date(p, "from"), date(p, "to"), p["bucket"] ?: "day")
        r == "ingest" -> control.status()
        r == "debug" -> debug?.let { it.ensureRunning(); it.snapshot() } ?: throw HttpError(404, "Not Found")
        r == "ingest/start" -> startIngest(p)
        r.startsWith("unit/") && r.endsWith("/day") ->
            unitDay(r.removePrefix("unit/").removeSuffix("/day").let { URLDecoder.decode(it, "UTF-8") }, date(p, "date"))
        r.startsWith("unit/") -> unitInfo(URLDecoder.decode(r.removePrefix("unit/"), "UTF-8"))
        else -> throw HttpError(404, "Not Found")
    }

    // ------------------------------------------------------------ query building

    private class Filters(p: Map<String, String>) {
        val where = arrayListOf("settlement_date BETWEEN ? AND ?")
        val params = arrayListOf<Any?>(date(p, "from"), date(p, "to"))

        init {
            for (dim in DIM_ORDER) {
                val raw = p[dim]
                if (raw.isNullOrEmpty()) continue
                val vals = raw.split("|").filter { it.isNotEmpty() }
                if (vals.isEmpty()) continue
                if (dim == "so") {
                    where.add(if (vals[0] == "SO-flagged") "so_flag" else "NOT so_flag")
                    continue
                }
                where.add("${DIMS.getValue(dim)} IN (${vals.joinToString(",") { "?" }})")
                params.addAll(vals)
            }
        }

        val sql: String get() = where.joinToString(" AND ")
    }

    private fun clean(rows: List<Map<String, Any?>>): List<Map<String, Any?>> {
        for (r in rows) {
            val m = r as MutableMap<String, Any?>
            for (k in BOOL_COLS) if (m.containsKey(k) && m[k] != null) m[k] = (m[k] as Number).toLong() != 0L
        }
        return rows
    }

    // ------------------------------------------------------------ endpoints

    private fun meta(): Any {
        val held = Store.coverage(db).keys.sorted()
        return linkedMapOf(
            "days" to held, "min" to held.firstOrNull(), "max" to held.lastOrNull(),
            "dims" to DIMS.keys.toList(),
            "techs" to db.query("SELECT DISTINCT tech FROM units ORDER BY 1").map { it["tech"] },
        )
    }

    /** Time-bucketed bid/offer volume and cashflow, optionally split by one dimension.
     *  Groups beyond the `top` largest (by absolute cashflow or volume) fold into 'Other'. */
    private fun agg(f: Filters, bucket: String, group: String, top: Int, rank: String): Any {
        val b = BUCKETS[bucket]
        if (b == null || (group != "none" && group !in DIMS)) throw HttpError(400, "bad bucket or group")
        if (group == "none") {
            val rows = db.query("WITH f AS ($BASE) SELECT $b AS t, 'All' AS g, $MEASURES FROM f WHERE ${f.sql} GROUP BY 1 ORDER BY t", f.params)
            return linkedMapOf("rows" to rows, "groups" to listOf("All"))
        }
        val g = DIMS.getValue(group)
        val measure = if (rank == "cash") "cashflow" else "volume"
        val ranked = db.query("WITH f AS ($BASE) SELECT $g AS g, sum(abs($measure)) AS m FROM f WHERE ${f.sql} GROUP BY 1 ORDER BY m DESC", f.params)
        val keep = ranked.take(top).map { it["g"] }
        val folded = ranked.size > top
        val gexpr: String
        val params: List<Any?>
        if (folded) {
            gexpr = "CASE WHEN $g IN (${keep.joinToString(",") { "?" }}) THEN $g ELSE 'Other (rest)' END"
            params = keep + f.params
        } else {
            gexpr = g; params = f.params
        }
        val rows = db.query("WITH f AS ($BASE) SELECT $b AS t, $gexpr AS g, $MEASURES FROM f WHERE ${f.sql} GROUP BY 1, 2 ORDER BY t", params)
        return linkedMapOf("rows" to rows, "groups" to keep + (if (folded) listOf("Other (rest)") else emptyList()), "n_groups" to ranked.size)
    }

    private fun summary(f: Filters): Any {
        val row = LinkedHashMap(db.query(
            """WITH f AS ($BASE) SELECT $MEASURES,
               sum(CASE WHEN so_flag THEN cashflow END) AS so_cash,
               sum(CASE WHEN so_flag THEN abs(volume) END) AS so_vol,
               count(DISTINCT bm_unit) AS n_units, count(DISTINCT settlement_date) AS n_days
               FROM f WHERE ${f.sql}""", f.params)[0])
        val range = listOf(f.params[0], f.params[1])
        row.putAll(db.query("""SELECT avg(sbp) AS avg_price, max(sbp) AS max_price, min(sbp) AS min_price,
            sum(niv) AS niv FROM system_prices WHERE settlement_date BETWEEN ? AND ?""", range)[0])
        row.putAll(db.query("""SELECT sum(cost) AS bsad_cost, sum(abs(volume)) AS bsad_vol FROM disbsad
            WHERE settlement_date BETWEEN ? AND ?""", range)[0])
        return row
    }

    private fun breakdown(f: Filters, group: String, limit: Int): Any {
        val g = DIMS[group] ?: throw HttpError(400, "bad group")
        val rows = db.query(
            """WITH f AS ($BASE) SELECT $g AS g, $MEASURES, count(DISTINCT bm_unit) AS n_units
               FROM f WHERE ${f.sql} GROUP BY 1
               ORDER BY abs(coalesce(offer_cash,0) + coalesce(bid_cash,0)) DESC LIMIT $limit""", f.params)
        return mapOf("rows" to rows)
    }

    private fun heatmap(f: Filters): Any = mapOf("rows" to db.query(
        "WITH f AS ($BASE) SELECT settlement_date AS d, sp, $MEASURES FROM f WHERE ${f.sql} GROUP BY 1, 2 ORDER BY 1, 2", f.params))

    private fun units(f: Filters): Any = mapOf("rows" to db.query(
        """WITH f AS ($BASE) SELECT bm_unit, max(unit_name) AS name, max(tech) AS tech, max(fuel) AS fuel,
           max(party) AS party, max(unit_type) AS unit_type, max(gsp) AS gsp, $MEASURES,
           count(DISTINCT settlement_date || '#' || sp) AS n_periods,
           count(DISTINCT CASE WHEN so_flag THEN settlement_date || '#' || sp END) AS n_so_periods
           FROM f WHERE ${f.sql} GROUP BY bm_unit""", f.params))

    private fun unitInfo(unit: String): Any {
        val rows = db.query("SELECT * FROM units WHERE bm_unit = ?", listOf(unit))
        val span = db.query("SELECT min(settlement_date) AS first, max(settlement_date) AS last FROM boav WHERE bm_unit = ?", listOf(unit))[0]
        return linkedMapOf("unit" to (rows.firstOrNull() ?: mapOf("bm_unit" to unit, "name" to unit))) + span
    }

    /** Finest grain: unit x period x direction x pair rows (for tables). */
    private fun periods(f: Filters, limit: Int): Any = mapOf("rows" to clean(db.query(
        """WITH f AS ($BASE) SELECT settlement_date, sp, bm_unit, direction, pair, volume, cashflow,
           volume_original, volume_tagged, so_flag, n_acceptances
           FROM f WHERE ${f.sql} ORDER BY settlement_date DESC, sp DESC, bm_unit, pair LIMIT $limit""", f.params)))

    private fun acceptances(unit: String, from: String, to: String, limit: Int): Any {
        val rows = try {
            liveAcceptances(unit, from, to)
        } catch (e: Exception) {
            throw HttpError(502, "Elexon: ${e.message}")
        }
        return mapOf("rows" to rows.sortedWith(
            compareByDescending<Map<String, Any?>> { it["time_from"] as String? ?: "" }
                .thenByDescending { it["acceptance_number"] as Long? ?: 0L }).take(limit))
    }

    /**
     * Acceptances (BOALF) for one unit over a range of settlement dates, fetched live. They are not stored:
     * they were most of the on-phone data and are only ever shown for the single unit being viewed.
     */
    private fun liveAcceptances(unit: String, from: String, to: String): List<Map<String, Any?>> {
        val lo = Ingester.dayBoundsUtc(LocalDate.parse(from)).first.minusSeconds(6 * 3600)
        val hi = Ingester.dayBoundsUtc(LocalDate.parse(to)).second.plusSeconds(6 * 3600)
        val seen = HashSet<String>()
        return Elexon(2).read("/datasets/BOALF/stream",
            listOf("from" to Ingester.iso(lo), "to" to Ingester.iso(hi), "bmUnit" to unit),
            { ArrayList<Map<String, Any?>>() }) { acc, r ->
            val ds = r.str("settlementDate")
            if (ds != null && ds >= from && ds <= to && r.str("bmUnit") == unit &&
                seen.add(listOf(r["acceptanceNumber"], r.str("timeFrom"), r.str("timeTo"), r["levelFrom"], r["levelTo"]).joinToString("|"))) {
                acc.add(linkedMapOf(
                    "settlement_date" to ds, "sp_from" to r.int("settlementPeriodFrom"), "sp_to" to r.int("settlementPeriodTo"),
                    "time_from" to r.str("timeFrom"), "time_to" to r.str("timeTo"),
                    "level_from" to r.dbl("levelFrom"), "level_to" to r.dbl("levelTo"),
                    "bm_unit" to unit, "ngc_bm_unit" to r.str("nationalGridBmUnit"),
                    "acceptance_number" to r.long("acceptanceNumber"), "acceptance_time" to r.str("acceptanceTime"),
                    "deemed_bo" to r["deemedBoFlag"], "so_flag" to r["soFlag"], "stor_flag" to r["storFlag"],
                    "rr_flag" to r["rrFlag"], "amendment_flag" to r.str("amendmentFlag")))
            }
        }
    }

    private fun prices(from: String, to: String, bucket: String): Any {
        val b = BUCKETS[bucket] ?: throw HttpError(400, "bad bucket")
        return mapOf("rows" to db.query(
            """SELECT $b AS t, avg(sbp) AS price, min(sbp) AS price_min, max(sbp) AS price_max, sum(niv) AS niv
               FROM system_prices WHERE settlement_date BETWEEN ? AND ? GROUP BY 1 ORDER BY t""", listOf(from, to)))
    }

    private fun bsad(from: String, to: String, bucket: String): Any {
        val b = BUCKETS[bucket] ?: throw HttpError(400, "bad bucket")
        return mapOf("rows" to db.query(
            """SELECT $b AS t, CASE WHEN so_flag THEN 'System (SO-flagged)' ELSE 'Energy' END AS g,
               sum(cost) AS cost, sum(volume) AS volume
               FROM disbsad WHERE settlement_date BETWEEN ? AND ? GROUP BY 1, 2 ORDER BY t""", listOf(from, to)))
    }

    /** Physical notifications, limits and the bid-offer price ladder for one unit-day, fetched live from
     *  Elexon (cached once the day is old enough to have settled). */
    private fun unitDay(unit: String, d: String): Any {
        val key = "unitday2|$unit|$d"
        val cached = db.query("SELECT v FROM cache WHERE k = ?", listOf(key)).firstOrNull()?.get("v") as String?
        val live: Map<String, Any?>
        if (cached != null) {
            @Suppress("UNCHECKED_CAST")
            live = Json.parse(cached) as Map<String, Any?>
        } else {
            val day = LocalDate.parse(d)
            val (s, e) = Ingester.dayBoundsUtc(day)
            val rng = listOf("bmUnit" to unit, "from" to Ingester.iso(s), "to" to Ingester.iso(e), "format" to "json")
            val pool = java.util.concurrent.Executors.newFixedThreadPool(3)
            try {
                val physF = pool.submit(java.util.concurrent.Callable {
                    Elexon(2).list("/balancing/physical", rng + listOf("dataset" to "PN", "dataset" to "MELS", "dataset" to "MILS"))
                        .filter { it.str("settlementDate") == d }.map { r -> linkedMapOf(
                            "dataset" to r.str("dataset"), "timeFrom" to r.str("timeFrom"), "timeTo" to r.str("timeTo"),
                            "levelFrom" to r.dbl("levelFrom"), "levelTo" to r.dbl("levelTo")) }
                })
                val bodF = pool.submit(java.util.concurrent.Callable {
                    Elexon(2).list("/balancing/bid-offer", rng)
                        .filter { it.str("settlementDate") == d }.map { r -> linkedMapOf(
                            "sp" to r.int("settlementPeriod"), "pair" to r.int("pairId"), "levelFrom" to r.dbl("levelFrom"),
                            "levelTo" to r.dbl("levelTo"), "bid" to r.dbl("bid"), "offer" to r.dbl("offer")) }
                })
                val accF = pool.submit(java.util.concurrent.Callable {
                    liveAcceptances(unit, d, d).sortedWith(compareBy<Map<String, Any?>>({ it["acceptance_time"] as String? ?: "" },
                        { it["acceptance_number"] as Long? ?: 0L }, { it["time_from"] as String? ?: "" })).map { a ->
                        a.filterKeys { it in setOf("acceptance_number", "acceptance_time", "time_from", "time_to", "level_from",
                            "level_to", "so_flag", "stor_flag", "rr_flag", "deemed_bo") } }
                })
                live = mapOf("physical" to physF.get(), "bod" to bodF.get(), "acceptances" to accF.get())
            } catch (e: Exception) {
                throw HttpError(502, "Elexon: ${e.cause?.message ?: e.message}")
            } finally {
                pool.shutdown()
            }
            if (day.isBefore(Ingester.today().minusDays(Ingester.SETTLE_DAYS))) {
                db.exec("INSERT OR REPLACE INTO cache VALUES (?, ?)", listOf(key, Json.write(live)))
            }
        }
        val per = clean(db.query(
            """SELECT sp, direction, pair, volume, cashflow, so_flag FROM boav
               WHERE bm_unit = ? AND settlement_date = ? ORDER BY sp, pair, direction""", listOf(unit, d)))
        return linkedMapOf<String, Any?>("physical" to live["physical"], "bod" to live["bod"],
            "acceptances" to live["acceptances"], "periods" to per)
    }

    private fun startIngest(p: Map<String, String>): Any {
        val a = LocalDate.parse(req(p, "start")); val b = LocalDate.parse(req(p, "end"))
        if (b.isBefore(a) || java.time.temporal.ChronoUnit.DAYS.between(a, b) > 3 * 366)
            throw HttpError(400, "range must be between 1 day and 3 years")
        if (!control.start(a, b, p["force"] == "1" || p["force"] == "true")) throw HttpError(409, "an ingest is already running")
        return control.status()
    }

    companion object {
        private val DIMS = linkedMapOf(
            "direction" to "direction", "tech" to "tech", "fuel" to "fuel", "party" to "party", "unit" to "bm_unit",
            "unit_type" to "unit_type", "gsp" to "gsp",
            "pair" to "CASE WHEN pair > 0 THEN 'Pair +' || pair ELSE 'Pair ' || pair END",
            "so" to "CASE WHEN so_flag THEN 'SO-flagged' ELSE 'Not SO-flagged' END",
        )
        private val DIM_ORDER = listOf("direction", "tech", "fuel", "party", "unit", "unit_type", "gsp", "so", "pair")
        private val BOOL_COLS = setOf("so_flag", "stor_flag", "rr_flag", "deemed_bo")

        // settlement_date is 'YYYY-MM-DD' text; buckets reproduce the Python backend's ISO timestamps.
        private const val SLOT = "datetime(settlement_date, '+' || (30 * (sp - 1)) || ' minutes')"
        private val BUCKETS = mapOf(
            "sp" to "replace($SLOT, ' ', 'T')",
            "hour" to "strftime('%Y-%m-%dT%H:00:00', $SLOT)",
            "day" to "settlement_date || 'T00:00:00'",
            "week" to "date(settlement_date, '-6 days', 'weekday 1') || 'T00:00:00'",
            "month" to "strftime('%Y-%m-01T00:00:00', settlement_date)",
            "tod" to "sp",
            "none" to "0",
        )

        private const val MEASURES = """
            sum(CASE WHEN direction = 'offer' THEN volume END) AS offer_vol,
            sum(CASE WHEN direction = 'bid' THEN volume END) AS bid_vol,
            sum(CASE WHEN direction = 'offer' THEN cashflow END) AS offer_cash,
            sum(CASE WHEN direction = 'bid' THEN cashflow END) AS bid_cash"""

        // Every row of `f` is one unit x period x direction x pair, enriched with reference data.
        private const val BASE = """
            SELECT b.settlement_date AS settlement_date, b.sp AS sp, b.bm_unit AS bm_unit, b.direction AS direction,
                   b.pair AS pair, b.volume AS volume, b.cashflow AS cashflow, b.volume_original AS volume_original,
                   b.volume_tagged AS volume_tagged, b.so_flag AS so_flag, b.n_acceptances AS n_acceptances,
                   coalesce(u.lead_party, b.lead_party, 'Unknown') AS party,
                   coalesce(b.bm_unit_type, u.bm_unit_type, '?') AS unit_type,
                   coalesce(u.tech, 'Other') AS tech,
                   coalesce(u.fuel_type, 'Unclassified') AS fuel,
                   coalesce(u.gsp_group, 'Transmission / n.a.') AS gsp,
                   coalesce(u.name, b.bm_unit) AS unit_name
            FROM boav b LEFT JOIN units u ON u.bm_unit = b.bm_unit"""

        private val DATE_RE = Regex("^\\d{4}-\\d{2}-\\d{2}$")

        private fun req(p: Map<String, String>, k: String) = p[k]?.takeIf { it.isNotEmpty() } ?: throw HttpError(422, "missing $k")
        private fun date(p: Map<String, String>, k: String): String {
            val v = req(p, k)
            if (!DATE_RE.matches(v)) throw HttpError(422, "bad date for $k")
            return v
        }

        fun parseQuery(qs: String?): Map<String, String> {
            if (qs.isNullOrEmpty()) return emptyMap()
            val out = LinkedHashMap<String, String>()
            for (kv in qs.split("&")) {
                if (kv.isEmpty()) continue
                val i = kv.indexOf('=')
                val k = URLDecoder.decode(if (i < 0) kv else kv.substring(0, i), "UTF-8")
                out[k] = if (i < 0) "" else URLDecoder.decode(kv.substring(i + 1), "UTF-8")
            }
            return out
        }
    }
}
