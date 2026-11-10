package app.bmdash

import android.content.Context
import android.content.Intent
import bmdash.Api
import bmdash.IngestControl
import bmdash.Ingester
import bmdash.Store
import android.os.Process
import java.time.LocalDate
import java.util.concurrent.ThreadFactory

/** Process-wide singletons: the database, the API over it, and the ingester that fills it. */
object Backend {
    /** How much history to keep on the phone by default; the Data tab can fetch older days. */
    const val DEFAULT_DAYS = 30
    private const val SCHEMA_VERSION = 2

    private var started = false
    lateinit var db: AndroidSqlDb
    lateinit var ingester: Ingester
    lateinit var api: Api

    @Synchronized
    fun init(ctx: Context) {
        if (started) return
        val app = ctx.applicationContext
        db = AndroidSqlDb(app.getDatabasePath("bmdash.sqlite").also { it.parentFile?.mkdirs() }, SCHEMA_VERSION)
        Store.init(db)
        // Background priority keeps the downloads on the efficient cores and out of the UI's way, so the phone
        // stays cool and responsive; a few connections are plenty because Elexon's response time is the limit.
        val background = ThreadFactory { r ->
            Thread { Process.setThreadPriority(Process.THREAD_PRIORITY_BACKGROUND); r.run() }.apply { isDaemon = true }
        }
        ingester = Ingester(db, concurrency = 6, parallelChunks = 2, threadFactory = background)
        api = Api(db, object : IngestControl {
            override fun status() = ingester.job.asMap()
            override fun start(a: LocalDate, b: LocalDate, force: Boolean): Boolean = startIngest(app, a, b, force)
        })
        started = true
    }

    @Synchronized
    fun startIngest(ctx: Context, a: LocalDate, b: LocalDate, force: Boolean): Boolean {
        if (ingester.job.running) return false
        ingester.job.running = true // visible to status polls straight away
        try {
            ctx.startForegroundService(Intent(ctx, IngestService::class.java)
                .putExtra("start", a.toString()).putExtra("end", b.toString()).putExtra("force", force))
        } catch (e: Exception) {
            ingester.job.running = false
            throw e
        }
        return true
    }
}
