package bmdash

import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.Semaphore
import java.util.concurrent.atomic.AtomicInteger
import java.util.zip.GZIPInputStream

/** Blocking client for the Elexon Insights (BMRS) API with bounded parallelism and retries. */
class Elexon(concurrency: Int = 8, private val retries: Int = 6) {
    private val gate = Semaphore(concurrency)
    private val counter = AtomicInteger()
    val requests: Int get() = counter.get()

    /** GET a path and return its list of records (empty when Elexon has no data). */
    fun get(path: String, params: List<Pair<String, String>> = emptyList()): JSONArray {
        val qs = params.joinToString("&") { (k, v) -> "${enc(k)}=${enc(v)}" }
        val url = URL(BASE + path + if (qs.isEmpty()) "" else "?$qs")
        var last: Exception? = null
        for (attempt in 0 until retries) {
            var status = -1
            var body: String? = null
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
                    status = c.responseCode
                    if (status == 200) {
                        val raw = c.inputStream
                        val ins = if ("gzip".equals(c.contentEncoding, true)) GZIPInputStream(raw) else raw
                        val out = ByteArrayOutputStream(256 * 1024)
                        ins.use { it.copyTo(out) }
                        body = out.toString("UTF-8")
                    }
                } finally {
                    c.disconnect()
                }
            } catch (e: IOException) {
                last = e
            } finally {
                gate.release()
            }
            when {
                status == 200 && body != null -> return parse(body)
                status == 404 -> return JSONArray()
                status in RETRY || status == -1 -> if (status != -1) last = IOException("Elexon $status for $path")
                else -> throw IOException("Elexon $status for $path")
            }
            Thread.sleep((minOf(30_000L, 500L * (1L shl attempt)) + (Math.random() * 300).toLong()))
        }
        throw IOException("Elexon request failed after $retries attempts: $path: $last")
    }

    private fun parse(body: String): JSONArray {
        val t = body.trimStart()
        return if (t.startsWith("[")) JSONArray(t) else JSONObject(t).optJSONArray("data") ?: JSONArray()
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    companion object {
        const val BASE = "https://data.elexon.co.uk/bmrs/api/v1"
        private val RETRY = setOf(429, 500, 502, 503, 504)
    }
}

/** Iterate a JSONArray of objects. */
inline fun JSONArray.forEachObject(f: (JSONObject) -> Unit) {
    for (i in 0 until length()) f(getJSONObject(i))
}

fun JSONObject.str(k: String): String? = if (isNull(k)) null else optString(k)
fun JSONObject.dbl(k: String): Double? = if (isNull(k)) null else optDouble(k)
fun JSONObject.int(k: String): Int? = if (isNull(k)) null else optInt(k)
fun JSONObject.flag(k: String): Int? = if (isNull(k)) null else if (optBoolean(k)) 1 else 0
