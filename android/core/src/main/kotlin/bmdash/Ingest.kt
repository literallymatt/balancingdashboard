package bmdash

import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.concurrent.Callable
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.atomic.AtomicInteger

/** Mutable progress record for the running (or last) ingest; shape matches the Python backend. */
class Job {
    @Volatile var start = ""
    @Volatile var end = ""
    @Volatile var running = false
    @Volatile var total = 0
    val doneCount = AtomicInteger()
    val failed: MutableList<String> = java.util.Collections.synchronizedList(mutableListOf())
    @Volatile var requests = 0
    val rows = AtomicInteger()
    @Volatile var startedAt = 0.0
    @Volatile var finishedAt = 0.0
    @Volatile var last = ""
    @Volatile var error = ""

    fun asMap(): Map<String, Any?> {
        val now = System.currentTimeMillis() / 1000.0
        return linkedMapOf(
            "start" to start, "end" to end, "running" to running, "total" to total,
            "done" to doneCount.get(), "failed" to failed.toList(), "requests" to requests,
            "rows" to rows.get(), "started_at" to startedAt, "finished_at" to finishedAt,
            "last" to last, "error" to error,
            "elapsed" to if (startedAt > 0) Math.round(((if (finishedAt > 0) finishedAt else now) - startedAt) * 10) / 10.0 else 0.0,
        )
    }
}

/** What the API layer needs from whatever runs ingests (a thread on the JVM, a foreground service on Android). */
interface IngestControl {
    fun status(): Map<String, Any?>
    /** Begin an ingest. Returns false if one is already running. */
    fun start(a: LocalDate, b: LocalDate, force: Boolean): Boolean
}

/** Parallel ingestion of Balancing Mechanism data from Elexon into the SQLite store. */
class Ingester(private val db: SqlDb, private val concurrency: Int = 8, private val parallelChunks: Int = 2) {
    val job = Job()
    /** Wall-clock milliseconds spent per phase (summed across threads); for profiling. */
    val timings = java.util.concurrent.ConcurrentHashMap<String, java.util.concurrent.atomic.AtomicLong>()
    private inline fun <T> timed(name: String, f: () -> T): T {
        val t0 = System.nanoTime()
        try { return f() } finally { timings.getOrPut(name) { java.util.concurrent.atomic.AtomicLong() }.addAndGet((System.nanoTime() - t0) / 1_000_000) }
    }

    fun run(a: LocalDate, b: LocalDate, force: Boolean = false, onDay: ((String) -> Unit)? = null): Job {
        job.apply {
            start = a.toString(); end = b.toString(); running = true; doneCount.set(0); failed.clear()
            rows.set(0); requests = 0; error = ""; startedAt = System.currentTimeMillis() / 1000.0
            finishedAt = 0.0; last = ""
        }
        val api = Elexon(concurrency)
        val http = Executors.newFixedThreadPool(concurrency)
        val chunkPool = Executors.newFixedThreadPool(parallelChunks)
        try {
            Store.init(db)
            val days = daysNeeded(db, a, b, force).sortedByDescending { it.toEpochDay() } // newest first
            job.total = days.size
            try {
                ingestUnits(api)
            } catch (e: Exception) { // reference data is nice-to-have; keep going
                job.error = "units: ${e.message}"
            }
            val chunks = days.chunked(CHUNK_DAYS)
            val futures = chunks.map { chunk ->
                chunkPool.submit { ingestChunk(api, http, chunk, onDay) }
            }
            for (f in futures) f.get()
        } catch (e: Exception) {
            job.error = e.message ?: e.toString()
        } finally {
            http.shutdownNow(); chunkPool.shutdownNow()
            job.requests = api.requests
            job.running = false
            job.finishedAt = System.currentTimeMillis() / 1000.0
        }
        return job
    }

    // ------------------------------------------------------------ reference data

    private fun ingestUnits(api: Elexon) {
        val raw = api.get("/reference/bmunits/all")
        val rows = ArrayList<List<Any?>>(raw.length())
        raw.forEachObject { u ->
            val id = u.str("elexonBmUnit") ?: return@forEachObject
            rows.add(listOf(
                id, u.str("nationalGridBmUnit"), u.str("bmUnitName"), u.str("fuelType"), classifyTech(u),
                u.str("leadPartyName"), u.str("leadPartyId"), u.str("bmUnitType"), u.str("gspGroupName"),
                u.dbl("generationCapacity"), u.dbl("demandCapacity"), u.str("interconnectorId"),
            ))
        }
        Store.writeUnits(db, rows)
    }

    // ------------------------------------------------------------ a chunk of consecutive-ish days

    private fun ingestChunk(api: Elexon, http: ExecutorService, chunk: List<LocalDate>, onDay: ((String) -> Unit)?) {
        // Acceptances and non-BM actions come as one multi-day stream request per chunk.
        var acc: Map<String, List<List<Any?>>>
        var bsad: Map<String, List<List<Any?>>>
        try {
            val lo = dayBoundsUtc(chunk.last()).first.minusSeconds(6 * 3600) // chunks are newest-first
            val hi = dayBoundsUtc(chunk.first()).second.plusSeconds(6 * 3600)
            val accF = http.submit(Callable { fetchAcceptances(api, chunk, lo, hi) })
            val bsadF = http.submit(Callable { fetchDisbsad(api, chunk, lo.plusSeconds(4 * 3600), hi.minusSeconds(4 * 3600)) })
            acc = timed("chunk: acceptances+disbsad (wait)") { accF.get().also { bsadF.get() } }; bsad = bsadF.get()
        } catch (e: Exception) {
            for (d in chunk) { job.failed.add(d.toString()); job.doneCount.incrementAndGet() }
            job.error = "${chunk.first()}: ${e.message}"
            return
        }
        for (d in chunk) {
            val ds = d.toString()
            try {
                val boav = timed("day: boav fetch+parse") { fetchBoav(api, http, d) }
                val accRows = acc[ds].orEmpty()
                val prices = timed("day: prices") { fetchPrices(api, d) }
                // Flag unit-periods touched by an SO-flagged acceptance and count distinct acceptances.
                val so = HashMap<String, Boolean>()
                val count = HashMap<String, MutableSet<Long>>()
                for (r in accRows) {
                    val spFrom = (r[1] as Number).toInt()
                    val spTo = maxOf((r[2] as Number).toInt(), spFrom)
                    for (sp in spFrom..spTo) {
                        val k = "$sp|${r[7]}"
                        so[k] = (so[k] ?: false) || (r[12] == 1)
                        count.getOrPut(k) { HashSet() }.add((r[9] as Number).toLong())
                    }
                }
                val boavRows = ArrayList<List<Any?>>(boav.size)
                for (r in boav.values) {
                    // "Original" is zero for SO-flagged actions while "Tagged" carries them; the larger of the two
                    // reconciles with DISEBSP total accepted volume.
                    r.volume = if (Math.abs(r.volOriginal) >= Math.abs(r.volTagged)) r.volOriginal else r.volTagged
                    val k = "${r.sp}|${r.unit}"
                    r.so = so[k] ?: false
                    r.nAcc = count[k]?.size ?: 0
                    boavRows.add(r.toRow())
                }
                timed("day: sqlite write") { Store.writeDay(db, ds, linkedMapOf(
                    "acceptances" to accRows, "system_prices" to prices,
                    "disbsad" to bsad[ds].orEmpty(), "boav" to boavRows,
                ), System.currentTimeMillis() / 1000) }
                job.rows.addAndGet(boavRows.size)
                job.last = ds
                onDay?.invoke("$ds  ${boavRows.size} bid/offer rows  ${accRows.size} acceptances")
            } catch (e: Exception) {
                job.failed.add(ds)
                job.error = "$ds: ${e.message}"
            } finally {
                job.doneCount.incrementAndGet()
                job.requests = api.requests
            }
        }
    }

    // ------------------------------------------------------------ fetchers

    private fun fetchAcceptances(api: Elexon, chunk: List<LocalDate>, lo: Instant, hi: Instant): Map<String, List<List<Any?>>> {
        val raw = timed("boalf http+parse") { api.get("/datasets/BOALF/stream", listOf("from" to iso(lo), "to" to iso(hi))) }
        val wanted = chunk.map { it.toString() }.toSet()
        val seen = HashSet<String>()
        val out = HashMap<String, MutableList<List<Any?>>>()
        raw.forEachObject { r ->
            val ds = r.str("settlementDate")
            if (ds == null || ds !in wanted) return@forEachObject
            val key = listOf(r.str("bmUnit"), r.opt("acceptanceNumber"), r.str("timeFrom"), r.str("timeTo"),
                r.opt("levelFrom"), r.opt("levelTo")).joinToString("|")
            if (!seen.add(key)) return@forEachObject
            out.getOrPut(ds) { ArrayList() }.add(listOf(
                ds, r.int("settlementPeriodFrom"), r.int("settlementPeriodTo"),
                r.str("timeFrom"), r.str("timeTo"), r.dbl("levelFrom"), r.dbl("levelTo"),
                r.str("bmUnit"), r.str("nationalGridBmUnit"), r.optLong("acceptanceNumber"),
                r.str("acceptanceTime"), r.flag("deemedBoFlag"), r.flag("soFlag"), r.flag("storFlag"),
                r.flag("rrFlag"), r.str("amendmentFlag"),
            ))
        }
        return out
    }

    private fun fetchDisbsad(api: Elexon, chunk: List<LocalDate>, lo: Instant, hi: Instant): Map<String, List<List<Any?>>> {
        val raw = api.get("/datasets/DISBSAD/stream", listOf("from" to iso(lo), "to" to iso(hi)))
        val wanted = chunk.map { it.toString() }.toSet()
        val seen = HashSet<String>()
        val out = HashMap<String, MutableList<List<Any?>>>()
        raw.forEachObject { r ->
            val ds = r.str("settlementDate")
            if (ds == null || ds !in wanted) return@forEachObject
            if (!seen.add("$ds|${r.opt("settlementPeriod")}|${r.opt("id")}")) return@forEachObject
            out.getOrPut(ds) { ArrayList() }.add(listOf(
                ds, r.int("settlementPeriod"), r.int("id"), r.dbl("cost"), r.dbl("volume"), r.flag("soFlag"),
                r.flag("storFlag"), r.str("partyId"), r.str("assetId"), r.flag("isTendered"), r.str("service"),
            ))
        }
        return out
    }

    private fun fetchPrices(api: Elexon, d: LocalDate): List<List<Any?>> {
        val raw = api.get("/balancing/settlement/system-prices/$d", listOf("format" to "json"))
        val out = ArrayList<List<Any?>>()
        raw.forEachObject { r ->
            out.add(listOf(
                r.str("settlementDate"), r.int("settlementPeriod"), r.str("startTime"),
                r.dbl("systemSellPrice"), r.dbl("systemBuyPrice"), r.dbl("netImbalanceVolume"),
                r.str("priceDerivationCode"), r.dbl("totalAcceptedOfferVolume"), r.dbl("totalAcceptedBidVolume"),
                r.dbl("totalSystemTaggedAcceptedOfferVolume"), r.dbl("totalSystemTaggedAcceptedBidVolume"),
                r.dbl("totalAdjustmentSellVolume"), r.dbl("totalAdjustmentBuyVolume"),
            ))
        }
        return out
    }

    class BoavRow(
        val date: String, val sp: Int, val start: String?, val unit: String, val ngc: String?,
        val party: String?, val type: String?, val direction: String, val pair: Int,
    ) {
        var volume = 0.0; var volOriginal = 0.0; var volTagged = 0.0; var volRepriced = 0.0
        var volOrigPriced = 0.0; var cash = 0.0; var so = false; var nAcc = 0
        fun toRow(): List<Any?> = listOf(date, sp, start, unit, ngc, party, type, direction, pair, volume,
            volOriginal, volTagged, volRepriced, volOrigPriced, cash, if (so) 1 else 0, nAcc)
    }

    /** Volumes + cashflows for every unit and settlement period, both directions: four whole-day requests. */
    private fun fetchBoav(api: Elexon, http: ExecutorService, d: LocalDate): Map<String, BoavRow> {
        val ds = d.toString()
        val base = "/balancing/settlement/indicative"
        val jobs = ArrayList<Triple<String, Boolean, Future<org.json.JSONArray>>>()
        for (direction in listOf("bid", "offer")) {
            jobs.add(Triple(direction, true, http.submit(Callable { api.get("$base/volumes/all/$direction/$ds", listOf("format" to "json")) })))
            jobs.add(Triple(direction, false, http.submit(Callable { api.get("$base/cashflows/all/$direction/$ds", listOf("format" to "json")) })))
        }
        val rows = LinkedHashMap<String, BoavRow>()
        // Processed in a fixed order (as the Python ingest does) so the first-seen descriptive fields are deterministic.
        for ((direction, isVolume, fut) in jobs) {
            val data = fut.get()
            data.forEachObject { r ->
                val unit = r.str("bmUnit")
                if (unit.isNullOrEmpty()) return@forEachObject
                val setter: ((BoavRow, Double) -> Unit)?
                val pairs: JSONObject?
                if (isVolume) {
                    setter = when (r.str("dataType")) {
                        "Original" -> { row, v -> row.volOriginal = v }
                        "Tagged" -> { row, v -> row.volTagged = v }
                        "Re-priced" -> { row, v -> row.volRepriced = v }
                        "Original-Priced" -> { row, v -> row.volOrigPriced = v }
                        else -> null
                    }
                    pairs = r.optJSONObject("pairVolumes")
                } else {
                    setter = { row, v -> row.cash = v }
                    pairs = r.optJSONObject("bidOfferPairCashflows")
                }
                if (setter == null || pairs == null) return@forEachObject
                for ((key, pair) in PAIR_KEYS) {
                    val v = pairs.optDouble(key, 0.0)
                    if (v == 0.0 || v.isNaN()) continue
                    val sp = r.optInt("settlementPeriod")
                    val k = "$sp|$unit|$direction|$pair"
                    val row = rows.getOrPut(k) {
                        BoavRow(ds, sp, r.str("startTime"), unit, r.str("nationalGridBmUnit"),
                            r.str("leadPartyName"), r.str("bmUnitType"), direction, pair)
                    }
                    setter(row, v)
                }
            }
        }
        return rows
    }

    companion object {
        const val SETTLE_DAYS = 5L
        const val CHUNK_DAYS = 3
        val LONDON: ZoneId = ZoneId.of("Europe/London")
        val PAIR_KEYS: List<Pair<String, Int>> =
            listOf("negative", "positive").flatMap { sign -> (1..6).map { n -> "$sign$n" to if (sign == "positive") n else -n } }

        private val FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm'Z'").withZone(ZoneOffset.UTC)
        fun iso(t: Instant): String = FMT.format(t)

        fun dayBoundsUtc(d: LocalDate): Pair<Instant, Instant> =
            d.atStartOfDay(LONDON).toInstant() to d.plusDays(1).atStartOfDay(LONDON).toInstant()

        /** 46, 48 or 50 depending on clock changes. */
        fun periodsInDay(d: LocalDate): Int {
            val (s, e) = dayBoundsUtc(d)
            return ((e.epochSecond - s.epochSecond) / 1800).toInt()
        }

        private val BATTERY_NAME = Regex("BESS|BATTER|STORAGE|ENERGY STORE", RegexOption.IGNORE_CASE)
        private val BATTERY_NGC = Regex("^[A-Z0-9]{4}B-\\d+$")
        private val FUEL_TECH = mapOf("CCGT" to "Gas", "OCGT" to "Gas", "WIND" to "Wind", "PS" to "Pumped storage",
            "NPSHYD" to "Hydro", "BIOMASS" to "Biomass", "NUCLEAR" to "Nuclear", "COAL" to "Coal")

        /** Coarse technology label. Elexon's fuelType is null for most non-transmission units, so
         *  batteries are inferred from the unit name / NESO id pattern (heuristic). */
        fun classifyTech(u: JSONObject): String {
            val fuel = u.str("fuelType")
            if (!u.str("interconnectorId").isNullOrEmpty() || (fuel ?: "").startsWith("INT") ||
                (u.str("elexonBmUnit") ?: "").startsWith("I_")) return "Interconnector"
            if (fuel != null && fuel in FUEL_TECH) return FUEL_TECH.getValue(fuel)
            val name = u.str("bmUnitName") ?: ""
            val ngc = u.str("nationalGridBmUnit") ?: ""
            if (BATTERY_NAME.containsMatchIn(name) || BATTERY_NGC.matches(ngc)) return "Battery"
            return "Other"
        }

        fun today(): LocalDate = ZonedDateTime.now(LONDON).toLocalDate()

        /** Days in [a, b] not held yet, or fetched before their data had settled. */
        fun daysNeeded(db: SqlDb, a: LocalDate, b: LocalDate, force: Boolean): List<LocalDate> {
            val held = Store.coverage(db)
            val t = today()
            val last = if (b.isAfter(t)) t else b
            val out = ArrayList<LocalDate>()
            var d = a
            while (!d.isAfter(last)) {
                val fetched = held[d.toString()]
                if (force || fetched == null) out.add(d)
                else {
                    val settledAt = d.plusDays(SETTLE_DAYS).atStartOfDay(LONDON).toEpochSecond()
                    if (fetched < settledAt) out.add(d)
                }
                d = d.plusDays(1)
            }
            return out
        }
    }
}

/** Runs ingests on a plain background thread (JVM harness; Android uses a foreground service instead). */
class ThreadIngestControl(private val ingester: Ingester) : IngestControl {
    override fun status() = ingester.job.asMap()
    override fun start(a: LocalDate, b: LocalDate, force: Boolean): Boolean {
        synchronized(ingester) {
            if (ingester.job.running) return false
            ingester.job.running = true
        }
        Thread { ingester.run(a, b, force) }.apply { isDaemon = true; start() }
        return true
    }
}
