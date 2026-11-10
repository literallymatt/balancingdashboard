package app.bmdash

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import java.time.LocalDate
import kotlin.concurrent.thread

/** Foreground service so a long download keeps going when the app is backgrounded or the screen is off. */
class IngestService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Backend.init(this)
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Data download", NotificationManager.IMPORTANCE_LOW))
        startForeground(ID, notification("Starting download…", 0, 0), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)

        val a = LocalDate.parse(intent?.getStringExtra("start") ?: LocalDate.now().minusDays(Backend.DEFAULT_DAYS - 1L).toString())
        val b = LocalDate.parse(intent?.getStringExtra("end") ?: LocalDate.now().toString())
        val force = intent?.getBooleanExtra("force", false) ?: false
        thread(name = "bmdash-ingest") {
            android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND)
            try {
                Backend.ingester.run(a, b, force) {
                    val j = Backend.ingester.job
                    nm.notify(ID, notification("Downloaded ${j.doneCount.get()} of ${j.total} days", j.doneCount.get(), j.total))
                }
            } finally {
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    private fun notification(text: String, done: Int, total: Int): Notification =
        Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle("GB Balancing data")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .apply { if (total > 0) setProgress(total, done, false) }
            .build()

    companion object {
        private const val CHANNEL = "ingest"
        private const val ID = 1
    }
}
