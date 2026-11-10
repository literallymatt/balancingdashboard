package bmdash.harness

import bmdash.Api
import bmdash.Ingester
import bmdash.SqlDb
import bmdash.Store
import bmdash.ThreadIngestControl
import com.sun.net.httpserver.HttpServer
import java.io.File
import java.net.InetSocketAddress
import java.sql.Connection
import java.sql.DriverManager
import java.time.LocalDate

/** sqlite-jdbc implementation of SqlDb, for running the shared core on the JVM. */
class JdbcSqlDb(path: String) : SqlDb {
    private val conn: Connection = DriverManager.getConnection("jdbc:sqlite:$path").also {
        it.createStatement().use { s -> s.execute("PRAGMA journal_mode=WAL"); s.execute("PRAGMA synchronous=NORMAL") }
    }

    private fun bind(ps: java.sql.PreparedStatement, args: List<Any?>) {
        args.forEachIndexed { i, a ->
            when (a) {
                null -> ps.setObject(i + 1, null)
                is Boolean -> ps.setInt(i + 1, if (a) 1 else 0)
                is Int -> ps.setInt(i + 1, a)
                is Long -> ps.setLong(i + 1, a)
                is Double -> ps.setDouble(i + 1, a)
                else -> ps.setString(i + 1, a.toString())
            }
        }
    }

    @Synchronized override fun exec(sql: String, args: List<Any?>) {
        conn.prepareStatement(sql).use { bind(it, args); it.execute() }
    }

    @Synchronized override fun query(sql: String, args: List<Any?>): List<Map<String, Any?>> {
        conn.prepareStatement(sql).use { ps ->
            bind(ps, args)
            ps.executeQuery().use { rs ->
                val md = rs.metaData
                val names = (1..md.columnCount).map { md.getColumnLabel(it) }
                val out = ArrayList<Map<String, Any?>>()
                while (rs.next()) {
                    val row = LinkedHashMap<String, Any?>(names.size * 2)
                    names.forEachIndexed { i, n -> row[n] = rs.getObject(i + 1) }
                    out.add(row)
                }
                return out
            }
        }
    }

    @Synchronized override fun insertBatch(sql: String, rows: List<List<Any?>>) {
        conn.prepareStatement(sql).use { ps ->
            for (r in rows) { bind(ps, r); ps.addBatch() }
            ps.executeBatch()
        }
    }

    @Synchronized override fun <T> transaction(block: () -> T): T {
        val auto = conn.autoCommit
        conn.autoCommit = false
        try {
            val r = block()
            conn.commit()
            return r
        } catch (e: Throwable) {
            conn.rollback(); throw e
        } finally {
            conn.autoCommit = auto
        }
    }
}

private fun opt(args: Array<String>, name: String, default: String? = null): String? {
    val i = args.indexOf("--$name")
    return if (i >= 0 && i + 1 < args.size) args[i + 1] else default
}

fun main(args: Array<String>) {
    val cmd = args.firstOrNull() ?: "serve"
    val db = JdbcSqlDb(opt(args, "db", "bmdash.sqlite")!!)
    Store.init(db)
    val ingester = Ingester(db, opt(args, "concurrency", "8")!!.toInt(), opt(args, "chunks", "2")!!.toInt())
    when (cmd) {
        "ingest" -> {
            val end = opt(args, "to")?.let(LocalDate::parse) ?: Ingester.today()
            val start = opt(args, "from")?.let(LocalDate::parse) ?: end.minusDays((opt(args, "days", "7")!!.toLong()) - 1)
            println("Ingesting $start .. $end")
            val job = ingester.run(start, end, args.contains("--force")) { println("  $it") }
            val d = job.asMap()
            println("Done: ${(d["done"] as Int) - job.failed.size}/${d["total"]} days, ${d["requests"]} requests, ${d["rows"]} rows in ${d["elapsed"]}s")
            ingester.timings.toSortedMap().forEach { (k, v) -> println("  [timing] %-40s %6.1fs".format(k, v.get() / 1000.0)) }
            if (job.failed.isNotEmpty()) { println("Failed: ${job.failed} ${job.error}"); System.exit(1) }
        }
        "serve" -> {
            val staticDir = File(opt(args, "static", "../bmdash/static")!!)
            val api = Api(db, ThreadIngestControl(ingester))
            val port = opt(args, "port", "8791")!!.toInt()
            val server = HttpServer.create(InetSocketAddress("127.0.0.1", port), 0)
            server.executor = java.util.concurrent.Executors.newFixedThreadPool(8)
            server.createContext("/") { ex ->
                val t0 = System.nanoTime()
                val path = ex.requestURI.path
                var status = 200; var type = "application/json"; var body: ByteArray
                val r = api.handle(ex.requestMethod, path, ex.requestURI.rawQuery)
                if (r != null) {
                    status = r.status; type = r.contentType; body = r.body.toByteArray()
                } else {
                    val f = File(staticDir, if (path == "/") "index.html" else path.removePrefix("/static/"))
                    if (f.isFile && f.canonicalPath.startsWith(staticDir.canonicalPath)) {
                        body = f.readBytes()
                        type = when (f.extension) { "html" -> "text/html"; "js" -> "text/javascript"; "css" -> "text/css"; else -> "application/octet-stream" }
                    } else { status = 404; body = "not found".toByteArray(); type = "text/plain" }
                }
                ex.responseHeaders.add("Content-Type", "$type; charset=utf-8")
                ex.sendResponseHeaders(status, body.size.toLong())
                ex.responseBody.use { it.write(body) }
                if (path.startsWith("/api/")) System.err.println("%4d ms  %d  %s?%s".format((System.nanoTime() - t0) / 1_000_000, status, path, ex.requestURI.rawQuery ?: ""))
            }
            server.start()
            println("Serving http://127.0.0.1:$port")
        }
        else -> error("usage: ingest|serve")
    }
}
