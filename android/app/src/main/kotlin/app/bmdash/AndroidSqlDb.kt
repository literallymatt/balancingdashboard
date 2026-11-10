package app.bmdash

import android.database.Cursor
import android.database.sqlite.SQLiteCursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteProgram
import bmdash.SqlDb
import java.io.File

/** SqlDb over android.database.sqlite. WAL mode lets dashboard queries run concurrently with an ingest. */
class AndroidSqlDb(file: File) : SqlDb {
    private val db: SQLiteDatabase = SQLiteDatabase.openOrCreateDatabase(file, null).also {
        it.enableWriteAheadLogging()
    }

    private fun bind(p: SQLiteProgram, args: List<Any?>) {
        args.forEachIndexed { i, a ->
            val n = i + 1
            when (a) {
                null -> p.bindNull(n)
                is Long -> p.bindLong(n, a)
                is Int -> p.bindLong(n, a.toLong())
                is Boolean -> p.bindLong(n, if (a) 1 else 0)
                is Double -> p.bindDouble(n, a)
                is Float -> p.bindDouble(n, a.toDouble())
                else -> p.bindString(n, a.toString())
            }
        }
    }

    override fun exec(sql: String, args: List<Any?>) {
        if (args.isEmpty()) db.execSQL(sql) else db.execSQL(sql, args.toTypedArray())
    }

    override fun query(sql: String, args: List<Any?>): List<Map<String, Any?>> {
        // rawQuery binds every argument as a string; a cursor factory lets us bind real types.
        val factory = SQLiteDatabase.CursorFactory { _, driver, editTable, query ->
            bind(query, args)
            SQLiteCursor(driver, editTable, query)
        }
        db.rawQueryWithFactory(factory, sql, null, "").use { c ->
            val names = c.columnNames
            val out = ArrayList<Map<String, Any?>>(minOf(c.count, 4096))
            while (c.moveToNext()) {
                val row = LinkedHashMap<String, Any?>(names.size * 2)
                for (i in names.indices) {
                    row[names[i]] = when (c.getType(i)) {
                        Cursor.FIELD_TYPE_INTEGER -> c.getLong(i)
                        Cursor.FIELD_TYPE_FLOAT -> c.getDouble(i)
                        Cursor.FIELD_TYPE_STRING -> c.getString(i)
                        else -> null
                    }
                }
                out.add(row)
            }
            return out
        }
    }

    override fun insertBatch(sql: String, rows: List<List<Any?>>) {
        val st = db.compileStatement(sql)
        try {
            for (r in rows) {
                st.clearBindings()
                bind(st, r)
                st.executeInsert()
            }
        } finally {
            st.close()
        }
    }

    override fun <T> transaction(block: () -> T): T {
        db.beginTransaction()
        try {
            val r = block()
            db.setTransactionSuccessful()
            return r
        } finally {
            db.endTransaction()
        }
    }
}
