package bmdash

import java.io.IOException
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.Semaphore
import java.util.concurrent.atomic.AtomicInteger
import java.util.zip.GZIPInputStream

/**
 * Blocking client for the Elexon Insights (BMRS) API with bounded parallelism and retries.
 * Responses are stream-parsed record by record: memory use does not depend on response size.
 */
class Elexon(concurrency: Int = 8, private val retries: Int = 6) {
    private val gate = Semaphore(concurrency)
    private val counter = AtomicInteger()
    val requests: Int get() = counter.get()

    /**
     * GET a path and feed each record to [onRecord] together with an accumulator. A fresh accumulator is
     * created for every attempt, so a retry after a mid-stream failure never double-counts records.
     * A 404 yields an empty accumulator (Elexon has no data).
     */
    fun <T> read(path: String, params: List<Pair<String, String>>, newAcc: () -> T,
                 onRecord: (T, Map<String, Any?>) -> Unit): T {
        val qs = params.joinToString("&") { (k, v) -> "${enc(k)}=${enc(v)}" }
        val url = URL(BASE + path + if (qs.isEmpty()) "" else "?$qs")
        var last: Exception? = null
        for (attempt in 0 until retries) {
            var retryable = true
            gate.acquire()
            try {
                counter.incrementAndGet()
                val c = url.openConnection() as HttpURLConnection
                try {
                    c.connectTimeout = 30_000
                    c.readTimeout = 90_000
                    c.setRequestProperty("Accept", "application/json")
                    c.setRequestProperty("Accept-Encoding", "gzip")
                    c.setRequestProperty("User-Agent", "bmdash-android/0.1")
                    val status = c.responseCode
                    when {
                        status == 200 -> {
                            val raw = c.inputStream
                            val ins = if ("gzip".equals(c.contentEncoding, true)) GZIPInputStream(raw, 32 * 1024) else raw
                            val acc = newAcc()
                            InputStreamReader(ins, Charsets.UTF_8).use { JsonReader(it).streamRecords { rec -> onRecord(acc, rec) } }
                            return acc
                        }
                        status == 404 -> return newAcc()
                        status in RETRY -> last = IOException("Elexon $status for $path")
                        else -> { retryable = false; last = IOException("Elexon $status for $path") }
                    }
                } finally {
                    c.disconnect()
                }
            } catch (e: IOException) {
                last = e
            } finally {
                gate.release()
            }
            if (!retryable) throw last!!
            Thread.sleep(minOf(30_000L, 500L * (1L shl attempt)) + (Math.random() * 300).toLong())
        }
        throw IOException("Elexon request failed after $retries attempts: $path: $last")
    }

    /** Small responses only: collect every record. */
    fun list(path: String, params: List<Pair<String, String>> = emptyList()): List<Map<String, Any?>> =
        read(path, params, { ArrayList<Map<String, Any?>>() }) { acc, r -> acc.add(r) }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    companion object {
        const val BASE = "https://data.elexon.co.uk/bmrs/api/v1"
        private val RETRY = setOf(429, 500, 502, 503, 504)
    }
}
