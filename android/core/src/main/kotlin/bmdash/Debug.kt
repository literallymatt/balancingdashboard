package bmdash

/**
 * Samples CPU, thermal and network readings every couple of seconds into a ring buffer, so the debug panel can
 * show what the phone was doing during a download even if the panel was opened afterwards.
 *
 * [probe] supplies raw platform readings (cumulative counters and instantaneous values); this class turns the
 * counters into rates. It only runs while a download is running or the panel has been used in the last minute,
 * so it never costs battery by itself.
 */
class DebugSampler(
    private val probe: () -> Map<String, Any?>,
    private val control: IngestControl,
    private val intervalMs: Long = 2000,
    private val capacity: Int = 1800,
) {
    private val history = ArrayDeque<Map<String, Any?>>()
    @Volatile private var latest: Map<String, Any?> = emptyMap()
    @Volatile private var lastRequest = 0L
    private var thread: Thread? = null
    private var prevRaw: Map<String, Any?>? = null
    private var prevT = 0L
    private var baseRx: Double? = null
    private var baseTx: Double? = null
    private var topThreads: List<Map<String, Any?>> = emptyList()

    /** Start sampling if it is not already running (called by the service and by every debug-panel poll). */
    fun ensureRunning() {
        lastRequest = System.currentTimeMillis()
        synchronized(this) {
            if (thread?.isAlive == true) return
            thread = Thread({ loop() }, "bmdash-debug").apply { isDaemon = true; start() }
        }
        // First panel open: have something to show immediately.
        if (latest.isEmpty()) sampleOnce()
    }

    private fun loop() {
        try {
            while (true) {
                sampleOnce()
                Thread.sleep(intervalMs)
                val idle = System.currentTimeMillis() - lastRequest > 60_000
                if (idle && control.status()["running"] != true) break
            }
        } catch (_: InterruptedException) {
        } finally {
            synchronized(this) { thread = null }
        }
    }

    @Synchronized
    private fun sampleOnce() {
        val raw = try { probe() } catch (e: Exception) { return }
        val t = System.currentTimeMillis()
        val derived = LinkedHashMap<String, Any?>()
        derived["t"] = t
        val prev = prevRaw
        val cpuMs = (raw["cpu_ms"] as? Number)?.toDouble()
        val prevCpu = (prev?.get("cpu_ms") as? Number)?.toDouble()
        if (cpuMs != null && prevCpu != null && t > prevT) derived["cpu_pct"] = 100.0 * (cpuMs - prevCpu) / (t - prevT)

        // Per-thread CPU: which threads (named download threads vs. the rest) are burning time.
        @Suppress("UNCHECKED_CAST")
        val threads = raw["threads"] as? List<Map<String, Any?>>
        @Suppress("UNCHECKED_CAST")
        val prevThreads = (prev?.get("threads") as? List<Map<String, Any?>>)?.associate { (it["tid"] as Number).toLong() to (it["cpu_ms"] as Number).toDouble() }
        if (threads != null && prevThreads != null && t > prevT) {
            topThreads = threads.mapNotNull { th ->
                val before = prevThreads[(th["tid"] as Number).toLong()] ?: 0.0
                val pct = 100.0 * ((th["cpu_ms"] as Number).toDouble() - before) / (t - prevT)
                if (pct >= 0.5) mapOf("name" to th["name"], "cpu_pct" to pct) else null
            }.sortedByDescending { it["cpu_pct"] as Double }.take(6)
        }

        val rx = (raw["rx_bytes"] as? Number)?.toDouble()
        val tx = (raw["tx_bytes"] as? Number)?.toDouble()
        if (rx != null) { if (baseRx == null) baseRx = rx; derived["rx_mb"] = (rx - baseRx!!) / 1e6 }
        if (tx != null) { if (baseTx == null) baseTx = tx; derived["tx_mb"] = (tx - baseTx!!) / 1e6 }
        val ma = (raw["batt_ma"] as? Number)?.toDouble()
        val mv = (raw["batt_mv"] as? Number)?.toDouble()
        if (ma != null && mv != null) derived["watts"] = Math.abs(ma) * mv / 1e6
        val st = control.status()
        derived["ingest_running"] = st["running"]
        derived["ingest_done"] = st["done"]
        derived["ingest_total"] = st["total"]

        val sample = LinkedHashMap<String, Any?>(raw.filterKeys { it != "threads" && it != "cpu_ms" && it != "rx_bytes" && it != "tx_bytes" })
        sample.putAll(derived)
        latest = sample
        history.addLast(sample)
        while (history.size > capacity) history.removeFirst()
        prevRaw = raw
        prevT = t
    }

    @Synchronized
    fun snapshot(): Map<String, Any?> = linkedMapOf(
        "available" to true,
        "latest" to latest,
        "threads" to topThreads,
        "history" to history.toList(),
        "interval_ms" to intervalMs,
    )
}
