package bmdash

import java.time.LocalDate

/**
 * System-level balancing costs for the Total costs tab, from public sources (see bmdash/costs.py):
 * NESO's daily cost data by purpose, Elexon BSAD (non-BM actions) and the EAC response/reserve auctions.
 * Totals only: there is no unit or asset behind these figures.
 */
class CostIngester(private val db: SqlDb) {
    @Volatile var running = false
    @Volatile var error = ""

    fun status(): Map<String, Any?> {
        val meta = db.query("SELECT k, v FROM cost_meta").associate { it["k"] as String to it["v"] as String? }
        return linkedMapOf(
            "updated_at" to meta["updated_at"]?.toDoubleOrNull(), "start" to meta["start"], "end" to meta["end"],
            "error" to (meta["error"] ?: ""), "running" to running,
        )
    }

    /** Fetch every source for [start]..[end] and merge into the store. Each source is independent: one failing keeps the rest. */
    fun run(start: LocalDate = DEFAULT_START, end: LocalDate = Ingester.today()): Boolean {
        synchronized(this) { if (running) return false; running = true }
        val errors = ArrayList<String>()
        try {
            Store.init(db)
            val neso = Elexon(2, base = Elexon.NESO_BASE)
            val elexon = Elexon(2)
            for ((name, fn) in listOf<Pair<String, () -> List<List<Any?>>>>(
                "neso_purpose" to { fetchPurpose(neso, start, end) },
                "eac" to { fetchEac(neso, start, end) },
                "bsad" to { fetchBsad(elexon, start, end) },
            )) {
                try {
                    val rows = fn()
                    db.transaction {
                        db.exec("DELETE FROM cost_daily WHERE source = ? AND date BETWEEN ? AND ?", listOf(name, start.toString(), end.toString()))
                        db.insertBatch("INSERT OR REPLACE INTO cost_daily VALUES (?, ?, ?, ?)", rows)
                    }
                } catch (e: Exception) {
                    errors.add("$name: ${e.message}")
                }
            }
        } catch (e: Exception) {
            errors.add(e.message ?: e.toString())
        } finally {
            error = errors.joinToString("; ")
            runCatching {
                db.transaction {
                    for ((k, v) in listOf("updated_at" to (System.currentTimeMillis() / 1000.0).toString(), "start" to start.toString(),
                        "end" to end.toString(), "error" to error)) db.exec("INSERT OR REPLACE INTO cost_meta VALUES (?, ?)", listOf(k, v))
                }
            }
            running = false
        }
        return errors.isEmpty()
    }

    // ------------------------------------------------------------ sources

    private fun fiscalYear(d: LocalDate) = if (d.monthValue >= 4) d.year else d.year - 1

    private fun months(a: LocalDate, b: LocalDate): List<Pair<LocalDate, LocalDate>> {
        val out = ArrayList<Pair<LocalDate, LocalDate>>()
        var d = a.withDayOfMonth(1)
        while (!d.isAfter(b)) { val n = d.plusMonths(1); out.add(d to n); d = n }
        return out
    }

    // NESO's firewall rejects string functions in this endpoint; plain aggregates and ranges are fine.
    private fun sql(api: Elexon, query: String) =
        api.list("/datastore_search_sql", listOf("sql" to query), listOf("result", "records"))

    private fun resources(api: Elexon, pkg: String) =
        api.list("/package_show", listOf("id" to pkg), listOf("result", "resources"))

    private fun fetchPurpose(api: Elexon, start: LocalDate, end: LocalDate): List<List<Any?>> {
        val res = HashMap<Int, String>()
        for (r in resources(api, DAILY_PACKAGE)) {
            val m = Regex("Daily Balancing Costs (\\d{4})-(\\d{4})").matchEntire(r.str("name") ?: "") ?: continue
            res[m.groupValues[1].toInt()] = r.str("id") ?: continue
        }
        val rows = ArrayList<List<Any?>>()
        for (fy in fiscalYear(start)..fiscalYear(end)) {
            val rid = res[fy] ?: continue
            val sums = PURPOSE.entries.joinToString(", ") { "SUM(\"${it.key}\") AS ${it.value}" }
            val q = "SELECT \"SETT_DATE\" AS d, $sums, COUNT(*) AS n FROM \"$rid\" " +
                "WHERE \"SETT_DATE\" >= '$start' AND \"SETT_DATE\" <= '$end' GROUP BY \"SETT_DATE\" ORDER BY \"SETT_DATE\""
            for (r in sql(api, q)) {
                val d = (r.str("d") ?: continue).take(10)
                for (k in PURPOSE.values) rows.add(listOf(d, "neso_purpose", k, r.dbl(k) ?: 0.0))
                rows.add(listOf(d, "neso_purpose", "_n", r.dbl("n") ?: 0.0)) // settlement periods present that day
            }
        }
        return rows
    }

    private fun fetchEac(api: Elexon, start: LocalDate, end: LocalDate): List<List<Any?>> {
        val all = resources(api, EAC_PACKAGE)
        val cur = all.firstOrNull { it.str("name") == "NESO Response-Reserve Results Summary" }?.str("id")
        val arch = HashMap<Int, String>()
        for (r in all) {
            val m = Regex("NESO Response-Reserve Results Summary FY(\\d{4}) \\(Archive\\)").matchEntire(r.str("name") ?: "") ?: continue
            arch[m.groupValues[1].toInt()] = r.str("id") ?: continue
        }
        val rows = ArrayList<List<Any?>>()
        for ((first, next) in months(start, end)) {
            val rid = arch[fiscalYear(first)] ?: cur ?: continue
            val q = "SELECT \"auctionProduct\" AS p, SUM(\"clearedVolume\" * \"clearingPrice\") AS c FROM \"$rid\" " +
                "WHERE \"deliveryStart\" >= '${first}T00:00:00' AND \"deliveryStart\" < '${next}T00:00:00' GROUP BY \"auctionProduct\""
            val by = HashMap<String, Double>()
            for (r in sql(api, q)) {
                val g = EAC_GROUP[r.str("p")] ?: continue
                by[g] = (by[g] ?: 0.0) + (r.dbl("c") ?: 0.0) * EAC_HOURS.getValue(g)
            }
            for (g in EAC_HOURS.keys) rows.add(listOf(first.toString(), "eac", g, by[g] ?: 0.0))
        }
        return rows
    }

    private class BsadAcc { val seen = HashSet<String>(); val by = HashMap<String, Double>() }

    private fun fetchBsad(api: Elexon, start: LocalDate, end: LocalDate): List<List<Any?>> {
        val rows = ArrayList<List<Any?>>()
        for ((first, next) in months(start, end)) {
            val a = if (first.isAfter(start)) first else start
            val b = minOf(next.toEpochDay(), end.plusDays(1).toEpochDay()).let { LocalDate.ofEpochDay(it) }
            val acc = api.read("/datasets/DISBSAD/stream", listOf("from" to "${a}T00:00Z", "to" to "${b}T00:00Z"), { BsadAcc() }) { x, r ->
                val ds = r.str("settlementDate")
                if (ds != null && ds >= a.toString() && ds < b.toString() && x.seen.add("$ds|${r["settlementPeriod"]}|${r["id"]}")) {
                    val svc = (r.str("service") ?: "").lowercase()
                    val cat = if (svc == "energy") "energy" else if (svc == "system") "system" else "other"
                    x.by["$ds|$cat"] = (x.by["$ds|$cat"] ?: 0.0) + (r.dbl("cost") ?: 0.0)
                }
            }
            for (ds in acc.by.keys.map { it.substringBefore('|') }.toSortedSet())
                for (cat in listOf("energy", "system", "other")) rows.add(listOf(ds, "bsad", cat, acc.by["$ds|$cat"] ?: 0.0))
        }
        return rows
    }

    companion object {
        val DEFAULT_START: LocalDate = LocalDate.of(2025, 4, 1) // a financial-year start: NESO's daily files and EAC archives split there
        private const val DAILY_PACKAGE = "daily-balancing-costs-balancing-services-use-of-system"
        private const val EAC_PACKAGE = "eac-auction-results"
        private val PURPOSE = linkedMapOf("Energy Imbalance" to "energy_imbalance", "Frequency Control" to "frequency_control",
            "Positive Reserve" to "positive_reserve", "Constraints" to "constraints", "Negative Reserve" to "negative_reserve", "Other" to "other")
        // DC/DM/DR (response) are four-hour windows; QR/SR/BR (reserve) are half-hour windows.
        private val EAC_GROUP = mapOf("DCH" to "DC", "DCL" to "DC", "DMH" to "DM", "DML" to "DM", "DRH" to "DR", "DRL" to "DR",
            "NQR" to "QR", "PQR" to "QR", "NSR" to "SR", "PSR" to "SR", "NBR" to "BR", "PBR" to "BR")
        private val EAC_HOURS = linkedMapOf("DC" to 4.0, "DM" to 4.0, "DR" to 4.0, "QR" to 0.5, "SR" to 0.5, "BR" to 0.5)
    }
}
