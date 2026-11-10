package app.bmdash

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.view.WindowInsets
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import bmdash.Ingester
import bmdash.Store
import java.io.ByteArrayInputStream
import java.time.LocalDate

/**
 * Hosts the dashboard UI in a WebView. Requests to a private https origin are answered in-process:
 * API routes (under /api/) by the Kotlin API over the on-device SQLite store, everything else from bundled assets.
 */
class MainActivity : Activity() {
    private lateinit var web: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Backend.init(this)

        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.cacheMode = WebSettings.LOAD_NO_CACHE
            settings.setSupportZoom(false)
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            webViewClient = Client()
        }
        // Targeting SDK 35 draws edge-to-edge, so the page would sit under the status bar and navigation bar.
        // The system-bar insets are applied as padding on a container: a WebView ignores its own padding for
        // page content, which is what hid the tabs behind the clock and Wi-Fi icons.
        val root = FrameLayout(this).apply { setBackgroundColor(getColor(R.color.page_bg)) }
        root.addView(web, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        setContentView(root)
        root.setOnApplyWindowInsetsListener { v, insets ->
            val b = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
            v.setPadding(b.left, b.top, b.right, b.bottom)
            WindowInsets.CONSUMED
        }
        root.requestApplyInsets()

        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }

        if (savedInstanceState != null) web.restoreState(savedInstanceState) else web.loadUrl("$ORIGIN/")
        refreshDataIfStale()
    }

    /** On launch, top up the last 30 days: fetches only days that are missing or were fetched before they settled. */
    private fun refreshDataIfStale() {
        Thread {
            try {
                val end = Ingester.today()
                val start = end.minusDays(Backend.DEFAULT_DAYS - 1L)
                if (Ingester.daysNeeded(Backend.db, start, end, false).isNotEmpty()) {
                    Backend.startIngest(this, start, end, false)
                }
            } catch (_: Exception) { /* offline etc.: the Data view can retry */ }
        }.start()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    private inner class Client : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val uri = request.url
            if ("${uri.scheme}://${uri.host}" != ORIGIN) return empty(403) // nothing leaves the app
            val path = uri.path ?: "/"
            val r = Backend.api.handle(request.method, path, uri.encodedQuery)
            if (r != null) return stream(r.status, r.contentType, r.body.toByteArray(), noStore = true)
            val asset = if (path == "/") "static/index.html" else path.removePrefix("/")
            if (!asset.startsWith("static/") || asset.contains("..")) return empty(404)
            return try {
                val bytes = assets.open(asset).use { it.readBytes() }
                val mime = when (asset.substringAfterLast('.')) {
                    "html" -> "text/html"; "js" -> "text/javascript"; "css" -> "text/css"
                    "svg" -> "image/svg+xml"; "png" -> "image/png"; "json" -> "application/json"
                    else -> "application/octet-stream"
                }
                stream(200, mime, bytes, noStore = false)
            } catch (e: java.io.IOException) {
                empty(404)
            }
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val u = request.url
            if ("${u.scheme}://${u.host}" == ORIGIN) return false
            // External links (e.g. docs) open in the browser, never inside the app.
            runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(u.toString()))) }
            return true
        }

        private fun stream(status: Int, mime: String, body: ByteArray, noStore: Boolean) =
            WebResourceResponse(mime, "utf-8", status, reason(status),
                mapOf("Cache-Control" to if (noStore) "no-store" else "no-cache"), ByteArrayInputStream(body))

        private fun empty(status: Int) = stream(status, "text/plain", ByteArray(0), true)
        private fun reason(s: Int) = when (s) { 200 -> "OK"; 404 -> "Not Found"; 403 -> "Forbidden"; 409 -> "Conflict"; else -> "Error" }
    }

    companion object {
        // A reserved host for in-app content: it is always answered by shouldInterceptRequest.
        const val ORIGIN = "https://appassets.androidplatform.net"
    }
}
