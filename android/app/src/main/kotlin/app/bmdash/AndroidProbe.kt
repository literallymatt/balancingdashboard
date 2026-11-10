package app.bmdash

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.TrafficStats
import android.os.BatteryManager
import android.os.Debug
import android.os.PowerManager
import android.system.Os
import android.system.OsConstants
import java.io.File

/** Raw device readings for the debug panel: app CPU, battery, thermal status, network and memory. */
class AndroidProbe(private val ctx: Context) {
    private val pm = ctx.getSystemService(PowerManager::class.java)
    private val bm = ctx.getSystemService(BatteryManager::class.java)
    private val clkTck = runCatching { Os.sysconf(OsConstants._SC_CLK_TCK) }.getOrDefault(100L).coerceAtLeast(1L)
    private val cores = Runtime.getRuntime().availableProcessors()

    private val thermalNames = mapOf(0 to "none (normal)", 1 to "light", 2 to "moderate", 3 to "severe", 4 to "critical", 5 to "emergency", 6 to "shutdown")

    fun read(): Map<String, Any?> {
        val m = LinkedHashMap<String, Any?>()
        m["cores"] = cores
        m["cpu_ms"] = android.os.Process.getElapsedCpuTime()
        m["threads"] = threads()

        // Thermal: status is the OS's own "are we hot / throttling" verdict; headroom runs 0.0 (cool) to 1.0 (throttling starts).
        val status = pm.currentThermalStatus
        m["thermal_status"] = status
        m["thermal_name"] = thermalNames[status] ?: status.toString()
        val headroom = runCatching { pm.getThermalHeadroom(10) }.getOrDefault(Float.NaN)
        m["headroom"] = if (headroom.isNaN()) null else headroom.toDouble()

        val b = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        if (b != null) {
            m["batt_temp_c"] = b.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE).let { if (it == Int.MIN_VALUE) null else it / 10.0 }
            val level = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
            val scale = b.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
            m["batt_pct"] = if (level >= 0) 100.0 * level / scale else null
            m["batt_mv"] = b.getIntExtra(BatteryManager.EXTRA_VOLTAGE, 0).takeIf { it > 0 }
            m["charging"] = b.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0
        }
        val microAmps = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW)
        m["batt_ma"] = if (microAmps == Int.MIN_VALUE || microAmps == 0) null else microAmps / 1000.0

        val uid = android.os.Process.myUid()
        m["rx_bytes"] = TrafficStats.getUidRxBytes(uid).takeIf { it >= 0 }
        m["tx_bytes"] = TrafficStats.getUidTxBytes(uid).takeIf { it >= 0 }

        val rt = Runtime.getRuntime()
        m["heap_used_mb"] = (rt.totalMemory() - rt.freeMemory()) / 1e6
        m["heap_max_mb"] = rt.maxMemory() / 1e6
        m["native_mb"] = Debug.getNativeHeapAllocatedSize() / 1e6

        // Usually blocked by SELinux for apps; shown only when the device allows it.
        m["cpu_mhz"] = (0 until cores).mapNotNull { readLong("/sys/devices/system/cpu/cpu$it/cpufreq/scaling_cur_freq") }.takeIf { it.isNotEmpty() }?.map { it / 1000.0 }
        m["zones"] = (0 until 40).mapNotNull { i ->
            val t = readLong("/sys/class/thermal/thermal_zone$i/temp") ?: return@mapNotNull null
            mapOf("type" to (readText("/sys/class/thermal/thermal_zone$i/type") ?: "zone$i"), "c" to if (t > 1000) t / 1000.0 else t.toDouble())
        }.takeIf { it.isNotEmpty() }
        return m
    }

    /** Per-thread CPU time of this process, from /proc/self/task/<tid>/stat. */
    private fun threads(): List<Map<String, Any?>> {
        val out = ArrayList<Map<String, Any?>>()
        File("/proc/self/task").listFiles()?.forEach { dir ->
            runCatching {
                val stat = File(dir, "stat").readText()
                val name = stat.substringAfter('(').substringBeforeLast(')')
                val f = stat.substringAfterLast(')').trim().split(' ') // fields after "state": utime is #12, stime #13 here
                val ticks = f[11].toLong() + f[12].toLong()
                out.add(mapOf("tid" to dir.name.toLong(), "name" to name, "cpu_ms" to ticks * 1000.0 / clkTck))
            }
        }
        return out
    }

    private fun readText(path: String): String? = runCatching { File(path).readText().trim() }.getOrNull()
    private fun readLong(path: String): Long? = readText(path)?.toLongOrNull()
}
