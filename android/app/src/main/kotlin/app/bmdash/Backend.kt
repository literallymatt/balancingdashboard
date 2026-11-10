package app.bmdash

import android.content.Context
import android.content.Intent
import bmdash.Api
import bmdash.IngestControl
import bmdash.Ingester
import bmdash.Store
import java.time.LocalDate

/** Process-wide singletons: the database, the API over it, and the ingester that fills it. */
object Backend {
    private var started = false
    lateinit var db: AndroidSqlDb
    lateinit var ingester: Ingester
    lateinit var api: Api

    @Synchronized
    fun init(ctx: Context) {
        if (started) return
        val app = ctx.applicationContext
        db = AndroidSqlDb(app.getDatabasePath("bmdash.sqlite").also { it.parentFile?.mkdirs() })
        Store.init(db)
        ingester = Ingester(db, concurrency = 12, parallelChunks = 3)
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
