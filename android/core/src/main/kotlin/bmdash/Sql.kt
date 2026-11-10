package bmdash

/**
 * Tiny SQLite abstraction so the same store / API / ingest code runs on Android
 * (android.database.sqlite) and on the JVM (sqlite-jdbc, used by the test harness).
 * Argument values are String, Long, Int, Double, Boolean or null.
 */
interface SqlDb {
    fun exec(sql: String, args: List<Any?> = emptyList())
    fun query(sql: String, args: List<Any?> = emptyList()): List<Map<String, Any?>>
    fun insertBatch(sql: String, rows: List<List<Any?>>)
    fun <T> transaction(block: () -> T): T
}
