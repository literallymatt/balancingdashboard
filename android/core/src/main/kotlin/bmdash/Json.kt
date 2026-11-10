package bmdash

import java.io.IOException
import java.io.Reader
import java.io.StringReader

/** Minimal JSON writer for Map / List / String / Number / Boolean / null trees. */
object Json {
    fun write(v: Any?): String = StringBuilder().also { put(it, v) }.toString()

    /** Parse a whole JSON document into Map / List / String / Long / Double / Boolean / null. */
    fun parse(s: String): Any? = JsonReader(StringReader(s)).readValue()

    private fun put(sb: StringBuilder, v: Any?) {
        when (v) {
            null -> sb.append("null")
            is String -> str(sb, v)
            is Boolean -> sb.append(v)
            is Double -> if (v.isNaN() || v.isInfinite()) sb.append("null") else sb.append(v)
            is Float -> if (v.isNaN() || v.isInfinite()) sb.append("null") else sb.append(v)
            is Number -> sb.append(v)
            is Map<*, *> -> {
                sb.append('{')
                var first = true
                for ((k, x) in v) {
                    if (!first) sb.append(',')
                    first = false
                    str(sb, k.toString()); sb.append(':'); put(sb, x)
                }
                sb.append('}')
            }
            is Iterable<*> -> {
                sb.append('[')
                var first = true
                for (x in v) {
                    if (!first) sb.append(',')
                    first = false
                    put(sb, x)
                }
                sb.append(']')
            }
            else -> str(sb, v.toString())
        }
    }

    private fun str(sb: StringBuilder, s: String) {
        sb.append('"')
        for (c in s) when {
            c == '"' -> sb.append("\\\"")
            c == '\\' -> sb.append("\\\\")
            c == '\n' -> sb.append("\\n")
            c == '\r' -> sb.append("\\r")
            c == '\t' -> sb.append("\\t")
            c < ' ' -> sb.append("\\u%04x".format(c.code))
            else -> sb.append(c)
        }
        sb.append('"')
    }
}

/**
 * Pull parser that reads JSON from a stream. [streamRecords] hands over one array element at a time,
 * so a multi-megabyte Elexon response never exists in memory as a whole (the phone's heap is small).
 */
class JsonReader(private val r: Reader) {
    private val buf = CharArray(16 * 1024)
    private var pos = 0
    private var lim = 0

    private fun peek(): Int {
        if (pos >= lim) {
            lim = r.read(buf, 0, buf.size)
            pos = 0
            if (lim <= 0) { lim = 0; return -1 }
        }
        return buf[pos].code
    }

    private fun next(): Int { val c = peek(); if (c >= 0) pos++; return c }

    private fun skipWs() {
        while (true) {
            val c = peek()
            if (c == 0x20 || c == 0x0A || c == 0x0D || c == 0x09) pos++ else return
        }
    }

    private fun expect(ch: Char) {
        skipWs()
        val c = next()
        if (c != ch.code) throw IOException("Bad JSON: expected '$ch' but found ${if (c < 0) "end of input" else "'${c.toChar()}'"}")
    }

    /** Stream the records of a top-level array, or of the `data` array inside a top-level object. */
    fun streamRecords(onRecord: (Map<String, Any?>) -> Unit) {
        skipWs()
        when (peek()) {
            '['.code -> streamArray(onRecord)
            '{'.code -> {
                pos++
                skipWs()
                if (peek() == '}'.code) { pos++; return }
                while (true) {
                    skipWs()
                    val key = readString()
                    expect(':')
                    skipWs()
                    if (key == "data" && peek() == '['.code) streamArray(onRecord) else readValue()
                    skipWs()
                    val c = next()
                    if (c == ','.code) continue
                    if (c == '}'.code) break
                    throw IOException("Bad JSON in object")
                }
            }
            else -> throw IOException("Bad JSON: expected array or object")
        }
    }

    private fun streamArray(onRecord: (Map<String, Any?>) -> Unit) {
        expect('[')
        skipWs()
        if (peek() == ']'.code) { pos++; return }
        while (true) {
            val v = readValue()
            @Suppress("UNCHECKED_CAST")
            if (v is Map<*, *>) onRecord(v as Map<String, Any?>)
            skipWs()
            val c = next()
            if (c == ','.code) continue
            if (c == ']'.code) return
            throw IOException("Bad JSON in array")
        }
    }

    fun readValue(): Any? {
        skipWs()
        return when (val c = peek()) {
            '{'.code -> readObject()
            '['.code -> readArray()
            '"'.code -> readString()
            't'.code -> literal("true", true)
            'f'.code -> literal("false", false)
            'n'.code -> literal("null", null)
            -1 -> throw IOException("Bad JSON: unexpected end of input")
            else -> if (c == '-'.code || (c >= '0'.code && c <= '9'.code)) readNumber() else throw IOException("Bad JSON: unexpected '${c.toChar()}'")
        }
    }

    private fun literal(word: String, value: Any?): Any? {
        for (ch in word) if (next() != ch.code) throw IOException("Bad JSON literal")
        return value
    }

    private fun readObject(): Map<String, Any?> {
        expect('{')
        val m = LinkedHashMap<String, Any?>(16)
        skipWs()
        if (peek() == '}'.code) { pos++; return m }
        while (true) {
            skipWs()
            val k = readString()
            expect(':')
            m[k] = readValue()
            skipWs()
            val c = next()
            if (c == ','.code) continue
            if (c == '}'.code) return m
            throw IOException("Bad JSON in object")
        }
    }

    private fun readArray(): List<Any?> {
        expect('[')
        val l = ArrayList<Any?>()
        skipWs()
        if (peek() == ']'.code) { pos++; return l }
        while (true) {
            l.add(readValue())
            skipWs()
            val c = next()
            if (c == ','.code) continue
            if (c == ']'.code) return l
            throw IOException("Bad JSON in array")
        }
    }

    private fun readString(): String {
        skipWs()
        if (next() != '"'.code) throw IOException("Bad JSON: expected string")
        val sb = StringBuilder()
        while (true) {
            val c = next()
            when {
                c < 0 -> throw IOException("Bad JSON: unterminated string")
                c == '"'.code -> return sb.toString()
                c == '\\'.code -> when (val e = next()) {
                    'n'.code -> sb.append('\n'); 't'.code -> sb.append('\t'); 'r'.code -> sb.append('\r')
                    'b'.code -> sb.append('\b'); 'f'.code -> sb.append('\u000c')
                    '/'.code, '\\'.code, '"'.code -> sb.append(e.toChar())
                    'u'.code -> {
                        var code = 0
                        repeat(4) {
                            val h = Character.digit(next(), 16)
                            if (h < 0) throw IOException("Bad JSON unicode escape")
                            code = code * 16 + h
                        }
                        sb.append(code.toChar())
                    }
                    else -> throw IOException("Bad JSON escape")
                }
                else -> sb.append(c.toChar())
            }
        }
    }

    private fun readNumber(): Any {
        val sb = StringBuilder()
        var isInt = true
        while (true) {
            val c = peek()
            if (c == '-'.code || c == '+'.code || (c >= '0'.code && c <= '9'.code)) sb.append(c.toChar())
            else if (c == '.'.code || c == 'e'.code || c == 'E'.code) { isInt = false; sb.append(c.toChar()) }
            else break
            pos++
        }
        val s = sb.toString()
        return if (isInt) (s.toLongOrNull() ?: s.toDouble()) else s.toDouble()
    }
}

// Typed accessors for parsed records. Numbers arrive as Long or Double, but Elexon sends some
// (e.g. unit capacities) as numeric strings, so those are accepted too.
private fun Any?.asDouble(): Double? = when (this) { is Number -> toDouble(); is String -> toDoubleOrNull(); else -> null }
fun Map<String, Any?>.str(k: String): String? = this[k]?.let { if (it is String) it else it.toString() }
fun Map<String, Any?>.dbl(k: String): Double? = this[k].asDouble()
fun Map<String, Any?>.int(k: String): Int? = this[k].asDouble()?.toInt()
fun Map<String, Any?>.long(k: String): Long? = (this[k] as? Number)?.toLong() ?: this[k].asDouble()?.toLong()
fun Map<String, Any?>.flag(k: String): Int? = (this[k] as? Boolean)?.let { if (it) 1 else 0 }
