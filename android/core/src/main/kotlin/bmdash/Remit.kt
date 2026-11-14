package bmdash

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.TreeMap
import java.util.concurrent.Executors

/**
 * REMIT outage messages for the REMIT tab. A port of bmdash/remit.py: same fetch, same GSP-group placement and the
 * same adding-up, so both backends return the same numbers. See remit.py for the reasoning behind each rule.
 *
 * Stored in `remit_msg` (one row per message, latest revision) and `remit_seg` (unavailable MW through the event,
 * one row per outage-profile step). Times are epoch seconds (UTC).
 */
object Remit {
    val DEFAULT_START: LocalDate = LocalDate.of(2025, 4, 1)
    const val AHEAD = 28L // days ahead: planned outages are published in advance
    private const val BATCH = 100
    private const val HH = 1800L
    val KINDS = linkedMapOf("production" to "Production unavailability", "consumption" to "Consumption unavailability")
    private const val MSG_TYPE = "UnavailabilitiesOfElectricityFacilities"
    // Closed and mothballed stations stay in REMIT as open-ended outages; events longer than this are left out unless asked.
    private const val LONG_TERM = 365 * 86400L
    private val MINUTE = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm'Z'").withZone(ZoneOffset.UTC)

    private fun epoch(s: String?): Long? = if (s.isNullOrEmpty()) null else Instant.parse(if (s.endsWith("Z") || s.contains('+')) s else s + "Z").epochSecond
    private fun iso(t: Long): String = MINUTE.format(Instant.ofEpochSecond(t))

    // ------------------------------------------------------------ unit -> GSP group

    /** BM unit id (Elexon and NESO ids) -> (name, GSP group). Transmission units are placed by their loss factor. */
    fun unitPlaces(ref: List<Map<String, Any?>>): Map<String, Pair<String?, String?>> {
        val byTlf = HashMap<String, LinkedHashMap<String, Int>>()
        for (u in ref) {
            val g = u.str("gspGroupId"); val tlf = u.str("transmissionLossFactor")
            if (!g.isNullOrEmpty() && tlf != null) byTlf.getOrPut(tlf) { LinkedHashMap() }.merge(g, 1, Int::plus)
        }
        // Most common group per loss factor (ties: the group seen first, as Python's Counter.most_common).
        val zone = byTlf.mapValues { (_, c) -> c.entries.fold(null as Map.Entry<String, Int>?) { b, e -> if (b == null || e.value > b.value) e else b }!!.key }
        val out = HashMap<String, Pair<String?, String?>>()
        for (u in ref) {
            var g = u.str("gspGroupId")
            if (g.isNullOrEmpty()) g = zone[u.str("transmissionLossFactor")]
            val place = u.str("bmUnitName") to g
            for (k in listOf(u.str("elexonBmUnit"), u.str("nationalGridBmUnit"))) if (!k.isNullOrEmpty() && k !in out) out[k] = place
        }
        return out
    }

    // ------------------------------------------------------------ fetch

    /** One Elexon REMIT message -> (message row, segment rows); null when it is not a unit unavailability. */
    @Suppress("UNCHECKED_CAST")
    fun parse(m: Map<String, Any?>, places: Map<String, Pair<String?, String?>>): Pair<List<Any?>, List<List<Any?>>>? {
        val kind = KINDS.entries.firstOrNull { it.value == m.str("eventType") }?.key
        val mrid = m.str("mrid")
        if (m.str("messageType") != MSG_TYPE || kind == null || mrid.isNullOrEmpty()) return null
        val t0 = epoch(m.str("eventStartTime")) ?: return null
        val t1 = epoch(m.str("eventEndTime")) ?: return null
        val asset = m.str("assetId")?.takeIf { it.isNotEmpty() } ?: m.str("affectedUnit") ?: ""
        val (name, gsp) = places[asset] ?: places[m.str("affectedUnit") ?: ""] ?: (null to null)
        val normal = m.dbl("normalCapacity")
        val avail = m.dbl("availableCapacity")
        var unavail = m.dbl("unavailableCapacity")
        if (unavail == null && normal != null && avail != null) unavail = normal - avail
        val segs = ArrayList<List<Any?>>()
        val prof = (m["outageProfile"] as? List<Map<String, Any?>>).orEmpty()
        if (prof.isNotEmpty() && normal != null) {
            for (p in prof) {
                val a = epoch(p.str("startTime")) ?: continue
                val b = epoch(p.str("endTime")) ?: continue
                // The streaming reader drops zero values inside nested objects, so a missing capacity is 0 MW available.
                val cap = p.dbl("capacity") ?: 0.0
                if (b <= a) continue
                segs.add(listOf(mrid, a, b, maxOf(0.0, normal - cap)))
            }
        } else if (unavail != null) {
            segs.add(listOf(mrid, t0, t1, maxOf(0.0, unavail)))
        }
        val row = listOf(mrid, (m.long("revisionNumber") ?: 0L), (m.long("id") ?: 0L), epoch(m.str("publishTime")) ?: 0L, kind,
            m.str("unavailabilityType") == "Planned", m.str("eventStatus") ?: "", asset, name, m.str("fuelType"), gsp,
            normal, avail, unavail, t0, t1, m.str("cause"), m.str("participantId"))
        return row to segs
    }

    private fun meta(db: SqlDb): Map<String, String?> =
        db.query("SELECT k, v FROM cost_meta WHERE k LIKE 'remit_%'").associate { (it["k"] as String).removePrefix("remit_") to it["v"] as String? }

    private fun listing(api: Elexon, pool: java.util.concurrent.ExecutorService, kind: String, a0: Instant, b: Instant,
                        extra: List<Pair<String, String>>): List<Map<String, Any?>> {
        val weeks = ArrayList<Pair<Instant, Instant>>()
        var a = a0
        while (a < b) { val c = minOf(a.plusSeconds(7 * 86400L), b); weeks.add(a to c); a = c }
        return weeks.map { (x, y) ->
            pool.submit<List<Map<String, Any?>>> {
                api.list("/remit/list/$kind", listOf("from" to MINUTE.format(x), "to" to MINUTE.format(y), "messageType" to MSG_TYPE) + extra)
            }
        }.flatMap { it.get() }
    }

    /** Fetch new and revised messages (see remit.py ingest_remit); returns how many were stored. Each batch is written
     *  as it arrives, so a phone never holds the whole backfill in memory. */
    fun ingest(db: SqlDb, api: Elexon): Int {
        val now = Instant.ofEpochSecond(Instant.now().epochSecond / 60 * 60)
        val held = db.query("SELECT mrid, revision FROM remit_msg").associate { it["mrid"] as String to (it["revision"] as Number).toLong() }
        val m = meta(db)
        val ahead = now.plusSeconds(AHEAD * 86400)
        val pool = Executors.newFixedThreadPool(3)
        try {
            val latest = ArrayList<Map<String, Any?>>()
            val first: String
            if (held.isEmpty() || m["published_to"] == null) {
                latest += listing(api, pool, "by-event", DEFAULT_START.atStartOfDay(ZoneOffset.UTC).toInstant(), ahead, listOf("latestRevisionOnly" to "true"))
                first = DEFAULT_START.toString()
            } else {
                val since = Instant.ofEpochSecond(m["published_to"]!!.toLong() - 3600)
                latest += listing(api, pool, "by-publish", since, now, emptyList())
                latest += listing(api, pool, "by-event", now, ahead, listOf("latestRevisionOnly" to "true"))
                first = m["start"] ?: DEFAULT_START.toString()
            }
            val best = HashMap<String, Pair<Long, Long>>() // mrid -> (revision, message id)
            for (e in latest) {
                val mrid = e.str("mrid") ?: continue
                val r = e.long("revisionNumber") ?: 0L
                if (best[mrid].let { it == null || r > it.first }) best[mrid] = r to (e.long("id") ?: continue)
            }
            val want = best.filter { (mrid, v) -> held[mrid].let { it == null || v.first > it } }.values.map { it.second }.sorted()
            var stored = 0
            if (want.isNotEmpty()) {
                val places = unitPlaces(api.list("/reference/bmunits/all"))
                val futures = want.chunked(BATCH).map { ids -> pool.submit<List<Map<String, Any?>>> { api.list("/remit", ids.map { "messageId" to it.toString() }) } }
                for (f in futures) {
                    val msgs = LinkedHashMap<String, Pair<List<Any?>, List<List<Any?>>>>()
                    for (raw in f.get()) {
                        val p = parse(raw, places) ?: continue
                        val prev = msgs[p.first[0] as String]
                        if (prev == null || (p.first[1] as Long) > (prev.first[1] as Long)) msgs[p.first[0] as String] = p
                    }
                    if (msgs.isEmpty()) continue
                    db.transaction {
                        for ((mrid, p) in msgs) {
                            db.exec("DELETE FROM remit_msg WHERE mrid = ?", listOf(mrid))
                            db.exec("DELETE FROM remit_seg WHERE mrid = ?", listOf(mrid))
                        }
                        db.insertBatch("INSERT INTO remit_msg VALUES (${List(18) { "?" }.joinToString(",")})", msgs.values.map { it.first })
                        db.insertBatch("INSERT INTO remit_seg VALUES (?, ?, ?, ?)", msgs.values.flatMap { it.second })
                    }
                    stored += msgs.size
                }
            }
            db.transaction {
                for ((k, v) in listOf("start" to first, "published_to" to now.epochSecond.toString(), "updated_at" to (System.currentTimeMillis() / 1000.0).toString()))
                    db.exec("INSERT OR REPLACE INTO cost_meta VALUES (?, ?)", listOf("remit_$k", v))
            }
            return stored
        } finally {
            pool.shutdownNow()
        }
    }

    // ------------------------------------------------------------ adding up (mirrors remit.py)

    class Grid(val lo: Long, val dates: List<String>, val sps: List<Int>) { val n get() = dates.size }

    fun slotGrid(start: LocalDate, end: LocalDate): Grid {
        val lo = Ingester.dayBoundsUtc(start).first.epochSecond
        val dates = ArrayList<String>(); val sps = ArrayList<Int>()
        var d = start
        while (!d.isAfter(end)) {
            val n = Ingester.periodsInDay(d)
            for (sp in 1..n) { dates.add(d.toString()); sps.add(sp) }
            d = d.plusDays(1)
        }
        return Grid(lo, dates, sps)
    }

    private val SP_FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:00")
    private val HOUR_FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:00:00")

    /** The time-bucket label for a settlement period: the same values /api/agg returns for each bucket. */
    fun bucketKey(d: String, sp: Int, bucket: String): Any = when (bucket) {
        "tod" -> sp
        "none" -> 0
        "day" -> "${d}T00:00:00"
        "week" -> LocalDate.parse(d).let { "${it.minusDays((it.dayOfWeek.value - 1).toLong())}T00:00:00" }
        "month" -> "${d.take(7)}-01T00:00:00"
        else -> LocalDate.parse(d).atStartOfDay().plusMinutes(30L * (sp - 1)).format(if (bucket == "hour") HOUR_FMT else SP_FMT)
    }

    class Run(val k0: Int, val k1: Int, val mw: Double, val tag: String)

    /** A message's segments (t0, t1, mw) -> runs of half-hour slots with the average MW in each slot. */
    fun slotRuns(segs: List<Triple<Long, Long, Double>>, lo: Long, n: Int, tag: String): List<Run> {
        val out = ArrayList<Run>()
        val hi = lo + n * HH
        for ((t0, t1, mw) in segs) {
            val a = maxOf(t0, lo); val b = minOf(t1, hi)
            if (b <= a || mw <= 0) continue
            var ka = ((a - lo) / HH).toInt(); val kb = ((b - lo) / HH).toInt()
            val fa = (a - lo) % HH; val fb = (b - lo) % HH
            if (ka == kb) { out.add(Run(ka, ka + 1, mw * (b - a) / HH, tag)); continue }
            if (fa != 0L) { out.add(Run(ka, ka + 1, mw * (HH - fa) / HH, tag)); ka += 1 }
            if (ka < kb) out.add(Run(ka, kb, mw, tag))
            if (fb != 0L) out.add(Run(kb, kb + 1, mw * fb / HH, tag))
        }
        return out
    }

    /** Overlapping runs -> disjoint runs: MW added (one message's pieces) or the largest kept (several messages). */
    fun sweep(runsIn: List<Run>, useMax: Boolean): List<Run> {
        val pts = runsIn.flatMap { listOf(it.k0, it.k1) }.toSortedSet().toList()
        val runs = runsIn.sortedBy { it.k0 }
        val out = ArrayList<Run>()
        var active = ArrayList<Run>()
        var i = 0
        for (j in 0 until pts.size - 1) {
            val a = pts[j]; val b = pts[j + 1]
            while (i < runs.size && runs[i].k0 <= a) { active.add(runs[i]); i++ }
            active = ArrayList(active.filter { it.k1 > a })
            if (active.isEmpty()) continue
            var v = 0.0; var top = -1.0; var tag: String? = null
            for (r in active) {
                v = if (useMax) maxOf(v, r.mw) else v + r.mw
                if (r.mw > top) { top = r.mw; tag = r.tag }
            }
            out.add(Run(a, b, v, tag!!))
        }
        return out
    }

    class Resolved(val grid: Grid, val units: Map<String, List<Run>>, val msgs: Map<String, Map<String, Any?>>)

    fun resolve(db: SqlDb, start: LocalDate, end: LocalDate, kind: String, longTerm: Boolean = false): Resolved {
        val g = slotGrid(start, end)
        val hi = g.lo + g.n * HH
        val short = if (longTerm) "" else " AND t_end - t_start <= $LONG_TERM"
        val msgs = db.query("SELECT * FROM remit_msg WHERE kind = ? AND status != 'Dismissed' AND t_start < ? AND t_end > ?$short",
            listOf(kind, hi, g.lo)).associateBy { it["mrid"] as String }
        val byMsg = TreeMap<String, ArrayList<Triple<Long, Long, Double>>>()
        for (s in db.query("""SELECT s.mrid AS mrid, s.t0 AS t0, s.t1 AS t1, s.mw AS mw FROM remit_seg s JOIN remit_msg m ON m.mrid = s.mrid
                              WHERE m.kind = ? AND m.status != 'Dismissed' AND m.t_start < ? AND m.t_end > ?${short.replace("t_", "m.t_")} AND s.t0 < ? AND s.t1 > ?
                              ORDER BY s.rowid""", listOf(kind, hi, g.lo, hi, g.lo))) {
            byMsg.getOrPut(s["mrid"] as String) { ArrayList() }.add(Triple((s["t0"] as Number).toLong(), (s["t1"] as Number).toLong(), (s["mw"] as Number).toDouble()))
        }
        val perUnit = TreeMap<String, ArrayList<Run>>()
        for ((mrid, segs) in byMsg) perUnit.getOrPut(msgs.getValue(mrid)["asset_id"] as String) { ArrayList() }.addAll(sweep(slotRuns(segs, g.lo, g.n, mrid), false))
        return Resolved(g, perUnit.mapValuesTo(LinkedHashMap()) { sweep(it.value, true) }, msgs)
    }

    private fun group(m: Map<String, Any?>, dim: String): String = when (dim) {
        "gsp" -> (m["gsp_group"] as String?) ?: "Unknown"
        "fuel" -> (m["fuel"] as String?) ?: "Unknown"
        else -> if (truthy(m["planned"])) "Planned" else "Unplanned"
    }

    private fun truthy(v: Any?) = v == true || (v as? Number)?.toLong() == 1L

    private fun keysOf(g: Grid, bucket: String) = List(g.n) { bucketKey(g.dates[it], g.sps[it], bucket) }

    /** Average unavailable MW per time bucket, split by GSP group, fuel and planned / unplanned. */
    fun aggregate(db: SqlDb, start: LocalDate, end: LocalDate, kind: String, bucket: String, longTerm: Boolean = false): Map<String, Any?> {
        val r = resolve(db, start, end, kind, longTerm)
        val n = r.grid.n
        val keys = keysOf(r.grid, bucket)
        val order: List<Any> = if (bucket == "tod") keys.map { it as Int }.toSortedSet().toList() else LinkedHashSet(keys).toList()
        val count = HashMap<Any, Int>().also { c -> for (k in keys) c.merge(k, 1, Int::plus) }
        val out = linkedMapOf<String, Any?>("slots" to order.map { linkedMapOf("t" to it, "n" to count.getValue(it)) }, "units" to r.units.size)
        for (dim in listOf("gsp", "fuel", "type")) {
            val diff = TreeMap<String, DoubleArray>()
            for (runs in r.units.values) for (run in runs) {
                val d = diff.getOrPut(group(r.msgs.getValue(run.tag), dim)) { DoubleArray(n + 1) }
                d[run.k0] += run.mw; d[run.k1] -= run.mw
            }
            val rows = ArrayList<Map<String, Any?>>()
            for ((g, d) in diff) {
                val acc = HashMap<Any, Double>()
                var run = 0.0
                for (k in 0 until n) { run += d[k]; acc[keys[k]] = (acc[keys[k]] ?: 0.0) + run }
                for (t in order) { val v = acc[t] ?: 0.0; if (Math.abs(v) > 1e-6) rows.add(linkedMapOf("t" to t, "g" to g, "mw" to v / count.getValue(t))) }
            }
            out[dim] = rows
        }
        return out
    }

    /** Units with capacity unavailable in one time bucket, with the message behind most of it. */
    fun outages(db: SqlDb, start: LocalDate, end: LocalDate, kind: String, bucket: String, t: String, longTerm: Boolean = false): List<Map<String, Any?>> {
        val r = resolve(db, start, end, kind, longTerm)
        val keys = keysOf(r.grid, bucket)
        val before = IntArray(keys.size + 1)
        for (k in keys.indices) before[k + 1] = before[k] + if (keys[k].toString() == t) 1 else 0
        val nb = before[keys.size]
        if (nb == 0) return emptyList()
        val out = ArrayList<Map<String, Any?>>()
        for ((asset, runs) in r.units) {
            var tot = 0.0; var peak = 0.0; var best = -1.0; var by: String? = null
            for (run in runs) {
                val ov = before[run.k1] - before[run.k0]
                if (ov <= 0) continue
                tot += run.mw * ov
                peak = maxOf(peak, run.mw)
                if (run.mw * ov > best) { best = run.mw * ov; by = run.tag }
            }
            if (by == null) continue
            val m = r.msgs.getValue(by)
            out.add(linkedMapOf("asset" to asset, "name" to m["unit_name"], "fuel" to m["fuel"], "gsp" to (m["gsp_group"] ?: "Unknown"),
                "mw" to tot / nb, "mw_max" to peak, "normal_mw" to m["normal_mw"], "planned" to truthy(m["planned"]),
                "status" to m["status"], "cause" to m["cause"], "start" to iso((m["t_start"] as Number).toLong()), "end" to iso((m["t_end"] as Number).toLong()),
                "mrid" to m["mrid"], "msg_id" to m["msg_id"], "participant" to m["participant"]))
        }
        return out.sortedByDescending { it["mw"] as Double }
    }

    fun extent(db: SqlDb): Map<String, Any?> {
        val m = meta(db)
        if (m["published_to"] == null) return linkedMapOf("min" to null, "max" to null)
        return linkedMapOf("min" to (m["start"] ?: DEFAULT_START.toString()), "max" to Ingester.today().plusDays(AHEAD).toString())
    }

    fun meta(db: SqlDb, running: Boolean, error: String): Map<String, Any?> =
        extent(db) + linkedMapOf("n" to (db.query("SELECT count(*) AS n FROM remit_msg")[0]["n"]), "updated_at" to meta(db)["updated_at"]?.toDoubleOrNull(),
            "error" to error, "running" to running)
}
