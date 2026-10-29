package expo.modules.convertxdownloader

import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.zip.ZipFile

/**
 * Convert-X yt-dlp bridge.
 *
 * Wraps `io.github.junkfood02.youtubedl-android:library:0.18.1` (the
 * 16KB-page-aligned release — Android 15+ safe). Exposes:
 *   - probe(url, opts) -> info JSON (formats, title, thumbnail, duration,
 *     and for playlists / carousels the per-entry list).
 *   - download(sessionId, opts) -> resolves when the file is on disk.
 *     Emits `onProgress` events keyed by the JS-supplied sessionId.
 *   - cancel(sessionId) -> destroyProcessById on the underlying processId.
 *
 * The first call to any of the above triggers `YoutubeDL.init(context)`
 * which unzips libpython.zip.so into the app's noBackup storage and
 * lays down the yt-dlp binary (~2-6s on first run, <100 ms thereafter).
 */
class ConvertXDownloaderModule : Module() {

  private val sessions = ConcurrentHashMap<String, String>()
  @Volatile private var initialized = false
  private val scope = CoroutineScope(Dispatchers.IO)

  /**
   * Walk the Throwable cause chain and produce a one-line diagnostic.
   * yausername's YoutubeDLException often surfaces only the top-level
   * "failed to initialize" with the actual reason (libpython unpack
   * failure, disk-full, missing native dep, …) buried in `cause`. Joining
   * the chain gives users and bug reports the real explanation.
   */
  private fun describe(t: Throwable): String {
    val parts = mutableListOf<String>()
    var cur: Throwable? = t
    var depth = 0
    while (cur != null && depth < 4) {
      val msg = cur.message?.takeIf { it.isNotBlank() } ?: "(no message)"
      parts.add("${cur.javaClass.simpleName}: $msg")
      cur = cur.cause
      depth += 1
    }
    return parts.joinToString(" → ")
  }

  override fun definition() = ModuleDefinition {
    Name("ConvertXDownloader")
    Events("onProgress", "onStage")

    OnDestroy {
      mainHandler.post { destroyBridgeView() }
    }

    AsyncFunction("init") { promise: Promise ->
      scope.launch {
        try {
          ensureInitializedSync()
          promise.resolve(null)
        } catch (e: Throwable) {
          promise.reject(CodedException("INIT_FAILED", describe(e), e))
        }
      }
    }

    /** Manually flush youtubedl-android's extracted cache. Useful after
     *  a failed auto-update or to force a clean reinstall of yt-dlp. */
    AsyncFunction("resetCache") { promise: Promise ->
      scope.launch {
        try {
          resetCacheSync()
          ensureInitializedSync()
          promise.resolve(null)
        } catch (e: Throwable) {
          promise.reject(CodedException("RESET_FAILED", describe(e), e))
        }
      }
    }

    /**
     * Update yt-dlp WITHOUT the GitHub REST API.
     *
     * youtubedl-android's own updater calls api.github.com/releases/latest,
     * which is rate-limited to 60 requests per hour PER IP. Phones on
     * carrier NAT share one public IP with thousands of users, so the call
     * fails with HTTP 403 much of the time — the "Check for update
     * sometimes just errors" users hit. The release redirect
     * (github.com/.../releases/latest → /releases/tag/<ver>) and the asset
     * download URLs are plain CDN endpoints with no such limit, so this
     * resolves the version from the redirect, downloads the asset only
     * when it differs from the installed one, verifies it against the
     * release's SHA2-256SUMS and as a loadable zip, then swaps it in with
     * an atomic rename. A killed app can therefore never leave a half-
     * written yt-dlp behind (the corruption the old in-place copy caused).
     *
     * opts.force     — re-download even when the version matches.
     * opts.checkOnly — only resolve the latest tag, never download.
     * Resolves {status: DONE|ALREADY_UP_TO_DATE|AVAILABLE, version, latest}.
     */
    AsyncFunction("updateYtDlp") { opts: Map<String, Any?>?, promise: Promise ->
      scope.launch {
        try {
          ensureInitializedSync()
          val ctx = appContext.reactContext
            ?: throw CodedException("NO_CONTEXT", "Application context unavailable", null)
          val force = opts?.get("force") as? Boolean ?: false
          val checkOnly = opts?.get("checkOnly") as? Boolean ?: false
          val result = try {
            runYtDlpUpdate(ctx, force, checkOnly)
          } catch (first: Throwable) {
            if (!looksCorrupted(first)) throw first
            resetCacheSync()
            ensureInitializedSync()
            runYtDlpUpdate(ctx, force, checkOnly)
          }
          promise.resolve(result)
        } catch (e: Throwable) {
          promise.reject(CodedException("UPDATE_FAILED", describe(e), e))
        }
      }
    }

    /** Installed yt-dlp version, read from the on-disk zipapp itself (the
     *  library's SharedPreferences only know about versions ITS updater
     *  installed, so the bundled build reads as "unknown" there). */
    AsyncFunction("getYtDlpVersion") { promise: Promise ->
      scope.launch {
        try {
          ensureInitializedSync()
          val ctx = appContext.reactContext
            ?: throw CodedException("NO_CONTEXT", "Application context unavailable", null)
          promise.resolve(
            mapOf(
              "version" to installedYtDlpVersion(ctx),
              "updatedAt" to ctx.getSharedPreferences(YTDLP_PREFS, android.content.Context.MODE_PRIVATE)
                .getLong(PREF_UPDATED_AT, 0L)
            )
          )
        } catch (e: Throwable) {
          promise.reject(CodedException("VERSION_FAILED", describe(e), e))
        }
      }
    }

    /**
     * HTTP through a hidden Android System WebView — i.e. a real Chromium.
     *
     * Instagram (and increasingly other Meta properties) fingerprint the
     * TLS/HTTP2 handshake and serve non-browser clients a JS shell, a
     * login redirect or an HTML page where JSON was asked for — WITH valid
     * session cookies. React Native's fetch (OkHttp) and yt-dlp's Python
     * stack both look like bots to it; yt-dlp works around this on
     * desktop with curl_cffi impersonation, which does not exist on
     * Android. The WebView is the one HTTP client on the device that IS
     * a browser, so requests sent from it are indistinguishable from the
     * in-app login the cookies came from.
     *
     * The page the fetch runs in is a blank document served by
     * shouldInterceptRequest under the target origin
     * (https://www.instagram.com/__convertx_bridge__), so fetch() is
     * same-origin: cookies attach, Origin/Referer/Sec-Fetch-* are set by
     * Chromium, and responses are readable without CORS. Cookies come
     * from the caller (cookies.txt stays the source of truth) and are
     * installed into the WebView jar before the request; the jar's
     * state for the origin is returned afterwards so rotated values can
     * be written back.
     *
     * opts: url, method, headers{}, body, referrer, userAgent, timeoutMs,
     *       cookies [{name,value,domain}] + cookieMode "replace"|"keep".
     * Resolves {status, url, redirected, headers{}, body, cookies}.
     */
    AsyncFunction("webFetch") { opts: Map<String, Any?>, promise: Promise ->
      mainHandler.post {
        try {
          enqueueBridgeRequest(opts, promise)
        } catch (e: Throwable) {
          promise.reject(CodedException("WEBVIEW_UNAVAILABLE", describe(e), e))
        }
      }
    }

    AsyncFunction("probe") { url: String, opts: Map<String, Any?>?, promise: Promise ->
      scope.launch {
        try {
          ensureInitializedSync()
          val request = YoutubeDLRequest(url)
          request.addOption("--dump-json")
          // No --no-warnings: when an extractor (Instagram especially)
          // can't find anything but doesn't raise — yt-dlp exits 0 with
          // empty stdout AND empty stderr because warnings were
          // suppressed. Keeping warnings on stderr means the
          // exited-0-no-JSON error path can surface the actual reason
          // ("Restricted Video: login required", "Empty media response"…).
          // No --flat-playlist: it collapses Instagram / TikTok / Reddit
          // carousels into a single entry (or nothing at all), defeating
          // the whole "pick image 6 of 10" UX. For multi-thousand-item
          // YouTube playlists this means a slower probe, but those are
          // an outlier — let yt-dlp expand each post and we'll trim the
          // entry list in the UI if needed.
          applyAuthOpts(request, opts)
          // Use raw --dump-json + parse stdout ourselves. The library's
          // typed VideoInfo class field names are not stable across the
          // 0.18.x line, so we avoid it.
          //
          // One-shot corruption recovery: a previous half-applied
          // updateYoutubeDL() can leave the yt-dlp.zip in a state that
          // python's zipimport rejects. Catch the specific error, wipe
          // the cache so the bundled zip gets re-extracted from the
          // `.zip.so` payloads in the APK, and retry once.
          val response: com.yausername.youtubedl_android.YoutubeDLResponse = try {
            YoutubeDL.getInstance().execute(request)
          } catch (first: Throwable) {
            if (!looksCorrupted(first)) throw first
            resetCacheSync()
            ensureInitializedSync()
            YoutubeDL.getInstance().execute(request)
          }
          val out = response.out.trim()
          val lines = out.lines().filter { it.isNotBlank() && it.startsWith("{") }
          val result = if (lines.size > 1) {
            // Playlist: yt-dlp emits one JSON object per entry on stdout.
            val arr = org.json.JSONArray()
            for (line in lines) arr.put(JSONObject(line))
            JSONObject().apply {
              put("isPlaylist", true)
              put("entries", arr)
              put("url", url)
            }
          } else if (lines.size == 1) {
            val info = JSONObject(lines[0])
            info.put("isPlaylist", false)
            info
          } else {
            // yt-dlp exited with no JSON output. Stuff everything the
            // process produced into the error payload so JS can show
            // the user *what* yt-dlp actually said (login required,
            // unsupported URL, rate-limited, …) instead of a useless
            // "yt-dlp returned no JSON".
            val stderrTail = response.err.takeIf { it.isNotBlank() } ?: "(empty stderr)"
            val stdoutTail = response.out.takeIf { it.isNotBlank() } ?: "(empty stdout)"
            JSONObject().apply {
              put("isPlaylist", false)
              put("error", "yt-dlp exited ${response.exitCode} with no JSON")
              put("stderr", stderrTail)
              put("stdout", stdoutTail)
              put("exitCode", response.exitCode)
            }
          }
          promise.resolve(result.toString())
        } catch (e: Throwable) {
          promise.reject(CodedException("PROBE_FAILED", describe(e), e))
        }
      }
    }

    AsyncFunction("download") { sessionId: String, opts: Map<String, Any?>, promise: Promise ->
      scope.launch {
        try {
          ensureInitializedSync()
          val url = opts["url"] as? String
            ?: throw CodedException("MISSING_URL", "url is required", null)
          val outputPath = opts["outputPath"] as? String
            ?: throw CodedException("MISSING_OUTPUT", "outputPath is required", null)
          val format = opts["format"] as? String
          val audioOnly = opts["audioOnly"] as? Boolean ?: false
          val audioFormat = opts["audioFormat"] as? String
          val quality = opts["quality"] as? String

          val request = YoutubeDLRequest(url)
          request.addOption("-o", outputPath)
          request.addOption("--no-warnings")
          // Sanitize titles so the resolved path is always safe to write
          // and to hand to MediaLibrary (Android File API rejects slashes,
          // colons, NUL bytes, etc. in filenames).
          request.addOption("--restrict-filenames")
          // No mtime — yt-dlp by default rewrites the file mtime to the
          // upload time, which makes the gallery sort the file as old.
          request.addOption("--no-mtime")
          // Tell yt-dlp to print the resolved final filepath after all
          // post-processing / moves. We need this because outputPath
          // contains the %(title)s.%(ext)s template — the actual file
          // is only known once the title is sanitized and the extension
          // is chosen by the downloader. The JS side uses this real path
          // for the gallery save.
          request.addOption("--print", "after_move:filepath")
          // --print implies --quiet, which also silences the
          // "[download]  NN.N%" lines the library's progress callback is
          // parsed from — without these two options onProgress never
          // fires and the UI bar sits at 0% for the whole download.
          request.addOption("--progress")
          request.addOption("--newline")
          // Carousel / playlist item selection. The probe hands the UI one
          // entry per carousel child, but Instagram/TikTok children share
          // the parent post URL — downloading that URL N times yields the
          // same file N times. The JS side sends the 1-based index instead
          // and we scope yt-dlp to exactly that child.
          val playlistItems = opts["playlistItems"] as? String
          if (!playlistItems.isNullOrBlank()) {
            request.addOption("--playlist-items", playlistItems)
          } else {
            // Single-item download: never fan out into a playlist that the
            // URL happens to also reference (e.g. watch?v=X&list=Y).
            request.addOption("--no-playlist")
          }
          // Single connection / fail-soft on transient network issues
          // instead of giving up at the first hiccup.
          request.addOption("--retries", "10")
          request.addOption("--fragment-retries", "10")

          if (audioOnly) {
            request.addOption("-x")
            if (!audioFormat.isNullOrBlank()) {
              request.addOption("--audio-format", audioFormat)
            }
            if (!quality.isNullOrBlank() && quality != "best") {
              request.addOption("--audio-quality", quality)
            }
          } else if (!format.isNullOrBlank()) {
            request.addOption("-f", format)
          } else if (!quality.isNullOrBlank() && quality != "best") {
            request.addOption(
              "-f",
              "bestvideo[height<=$quality]+bestaudio/best[height<=$quality]/best"
            )
          }

          applyAuthOpts(request, opts)

          val processId = "convert-x-download-$sessionId"
          sessions[sessionId] = processId

          // execute() takes a Kotlin Function3<Float, Long, String?, Unit>
          // (the SAM-style DownloadProgressCallback class isn't actually
          // wired into the public API). Keep this as a plain lambda
          // variable so both the initial attempt and the retry after
          // resetCacheSync share the same progress wiring.
          val progressCb: (Float, Long, String?) -> Unit = { progress, eta, line ->
            sendEvent(
              "onProgress",
              mapOf(
                "sessionId" to sessionId,
                "percent" to progress.toDouble(),
                "etaSeconds" to eta,
                "line" to (line ?: "")
              )
            )
          }

          val response = try {
            YoutubeDL.getInstance().execute(request, processId, progressCb)
          } catch (first: Throwable) {
            if (!looksCorrupted(first)) throw first
            resetCacheSync()
            ensureInitializedSync()
            YoutubeDL.getInstance().execute(request, processId, progressCb)
          }
          sessions.remove(sessionId)

          // Pull the resolved final filepath out of stdout — yt-dlp's
          // `--print after_move:filepath` writes one line per item with
          // the canonical post-processing path. Pick the last absolute
          // path that points at the downloads dir we asked it to use.
          val outDirHint = outputPath.substringBeforeLast('/')
          val resolvedPath = response.out
            .lineSequence()
            .map { it.trim() }
            .filter { it.startsWith("/") && it.contains(outDirHint) }
            .lastOrNull()
            ?: outputPath

          promise.resolve(
            mapOf(
              "outputPath" to resolvedPath,
              "exitCode" to response.exitCode,
              "stdout" to response.out,
              "stderr" to response.err
            )
          )
        } catch (e: Throwable) {
          sessions.remove(sessionId)
          // YoutubeDL throws a cancellation-flavored exception when
          // destroyProcessById fires; surface that as `cancelled: true`
          // instead of an error so the JS side can no-op.
          if (e.message?.contains("Cancelled", ignoreCase = true) == true ||
              e.message?.contains("destroyed", ignoreCase = true) == true
          ) {
            promise.resolve(mapOf("cancelled" to true))
          } else {
            promise.reject(CodedException("DOWNLOAD_FAILED", describe(e), e))
          }
        }
      }
    }

    Function("cancel") { sessionId: String ->
      val processId = sessions.remove(sessionId)
      if (processId != null) {
        try {
          YoutubeDL.destroyProcessById(processId)
        } catch (_: Throwable) {
        }
      }
    }

    /**
     * Publish a finished file into the user's gallery WITHOUT any system
     * consent dialog. expo-media-library's album flow modifies an existing
     * MediaStore row (a move), which on Android 11+ pops the per-file
     * "May Convert-X modify this photo?" write-request dialog on every
     * save. Inserting a fresh row that this app owns needs no permission
     * and no dialog on API 29+ — this is what gallery-writing apps do.
     *
     * Resolves { uri, publicPath } — uri is the content:// URI, publicPath
     * the human-readable RELATIVE_PATH + display name.
     */
    AsyncFunction("saveToGallery") { filePath: String, displayName: String, promise: Promise ->
      scope.launch {
        try {
          val ctx = appContext.reactContext
            ?: throw CodedException("NO_CONTEXT", "Application context unavailable", null)
          val src = java.io.File(filePath.removePrefix("file://"))
          if (!src.exists() || src.length() == 0L) {
            throw CodedException("NO_SOURCE", "Source file missing or empty: $filePath", null)
          }
          val safeName = displayName.ifBlank { src.name }
          val ext = safeName.substringAfterLast('.', "").lowercase()
          val mime = android.webkit.MimeTypeMap.getSingleton()
            .getMimeTypeFromExtension(ext) ?: "application/octet-stream"

          // API < 29 has no RELATIVE_PATH / IS_PENDING — publish via the
          // classic public-directory copy + media scan instead (the
          // manifest grants WRITE_EXTERNAL_STORAGE up to API 28).
          if (android.os.Build.VERSION.SDK_INT < 29) {
            // The public-directory copy below needs a runtime
            // WRITE_EXTERNAL_STORAGE grant on API 23–28. The JS wrapper
            // (ensureLegacyWriteAccess) requests it first; guard here too so a
            // denied grant surfaces a clear coded error instead of an EACCES
            // buried in copyTo().
            if (ctx.checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
              throw CodedException(
                "NO_STORAGE_PERMISSION",
                "Saving to the gallery on Android 9 and older needs the storage permission",
                null
              )
            }
            val baseDir = when {
              mime.startsWith("video/") -> android.os.Environment.DIRECTORY_MOVIES
              mime.startsWith("audio/") -> android.os.Environment.DIRECTORY_MUSIC
              mime.startsWith("image/") -> android.os.Environment.DIRECTORY_PICTURES
              else -> android.os.Environment.DIRECTORY_DOWNLOADS
            }
            val destDir = java.io.File(
              android.os.Environment.getExternalStoragePublicDirectory(baseDir),
              "Convert-X"
            )
            if (!destDir.mkdirs() && !destDir.isDirectory) {
              throw CodedException(
                "MKDIR_FAILED",
                "Could not create the Convert-X folder under $baseDir",
                null
              )
            }
            val dest = java.io.File(destDir, safeName)
            src.copyTo(dest, overwrite = true)
            android.media.MediaScannerConnection.scanFile(
              ctx, arrayOf(dest.absolutePath), arrayOf(mime), null
            )
            promise.resolve(
              mapOf(
                "uri" to android.net.Uri.fromFile(dest).toString(),
                "publicPath" to "$baseDir/Convert-X/$safeName"
              )
            )
            return@launch
          }

          // Route by media class so files land where users expect them:
          // photos in Pictures, videos in Movies, audio in Music — all
          // under a Convert-X folder, which galleries show as the album.
          val (collection, relativeDir) = when {
            mime.startsWith("image/") ->
              android.provider.MediaStore.Images.Media.getContentUri(
                android.provider.MediaStore.VOLUME_EXTERNAL_PRIMARY
              ) to "${android.os.Environment.DIRECTORY_PICTURES}/Convert-X"
            mime.startsWith("video/") ->
              android.provider.MediaStore.Video.Media.getContentUri(
                android.provider.MediaStore.VOLUME_EXTERNAL_PRIMARY
              ) to "${android.os.Environment.DIRECTORY_MOVIES}/Convert-X"
            mime.startsWith("audio/") ->
              android.provider.MediaStore.Audio.Media.getContentUri(
                android.provider.MediaStore.VOLUME_EXTERNAL_PRIMARY
              ) to "${android.os.Environment.DIRECTORY_MUSIC}/Convert-X"
            else ->
              android.provider.MediaStore.Downloads.getContentUri(
                android.provider.MediaStore.VOLUME_EXTERNAL_PRIMARY
              ) to "${android.os.Environment.DIRECTORY_DOWNLOADS}/Convert-X"
          }

          val values = android.content.ContentValues().apply {
            put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, safeName)
            put(android.provider.MediaStore.MediaColumns.MIME_TYPE, mime)
            put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, relativeDir)
            put(android.provider.MediaStore.MediaColumns.IS_PENDING, 1)
          }
          val resolver = ctx.contentResolver
          val uri = resolver.insert(collection, values)
            ?: throw CodedException("INSERT_FAILED", "MediaStore rejected the insert", null)
          try {
            resolver.openOutputStream(uri)?.use { out ->
              src.inputStream().use { input -> input.copyTo(out) }
            } ?: throw CodedException("OPEN_FAILED", "Could not open output stream", null)
            values.clear()
            values.put(android.provider.MediaStore.MediaColumns.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
          } catch (e: Throwable) {
            // Don't leave a pending ghost row behind on a failed copy.
            resolver.delete(uri, null, null)
            throw e
          }
          promise.resolve(
            mapOf(
              "uri" to uri.toString(),
              "publicPath" to "$relativeDir/$safeName"
            )
          )
        } catch (e: Throwable) {
          promise.reject(CodedException("SAVE_FAILED", describe(e), e))
        }
      }
    }
  }

  @Synchronized
  private fun ensureInitializedSync() {
    if (initialized) return
    val ctx = appContext.reactContext
      ?: throw CodedException("NO_CONTEXT", "Application context unavailable", null)
    YoutubeDL.getInstance().init(ctx)
    // Best-effort ffmpeg / aria2c init — they live in separate artifacts.
    try {
      val ffmpegClass = Class.forName("com.yausername.ffmpeg.FFmpeg")
      val instance = ffmpegClass.getMethod("getInstance").invoke(null)
      ffmpegClass.getMethod("init", android.content.Context::class.java).invoke(instance, ctx)
    } catch (_: Throwable) {
    }
    try {
      val aria2cClass = Class.forName("com.yausername.aria2c.Aria2c")
      val instance = aria2cClass.getMethod("getInstance").invoke(null)
      aria2cClass.getMethod("init", android.content.Context::class.java).invoke(instance, ctx)
    } catch (_: Throwable) {
    }
    initialized = true

    // No auto-update on init. The previous async updateYoutubeDL() call
    // was responsible for a "bad local file header" zip corruption on
    // user devices: the download replaces the bundled yt-dlp.zip in
    // place, and a partial / interrupted write left a half-baked zip
    // that python's zipimport refused to load. The bundled yt-dlp in
    // youtubedl-android 0.18.1 (Feb 2026) is fresh enough; users who
    // want the latest extractors can tap "Update yt-dlp" in the
    // download settings, which calls updateYtDlp() below.
  }

  /**
   * Nuke youtubedl-android's extracted cache so the next init re-creates
   * everything from the bundled `.zip.so` payloads. Use this to recover
   * from a corrupted yt-dlp zip (zipimport "bad local file header") or
   * a half-applied update.
   */
  private fun resetCacheSync() {
    initialized = false
    val ctx = appContext.reactContext ?: return
    val root = java.io.File(ctx.noBackupFilesDir, "youtubedl-android")
    if (root.exists()) root.deleteRecursively()
    // The library tracks the installed yt-dlp version in SharedPreferences
    // and its updater compares ONLY that value against GitHub's latest tag.
    // Wiping the binaries above reverts the on-disk yt-dlp to the bundled
    // version, so the stale prefs entry would make every future update
    // return ALREADY_UP_TO_DATE without downloading anything — the exact
    // "update does nothing" dead-end users hit. Clear the bookkeeping so
    // the next update actually installs.
    ctx.getSharedPreferences("youtubedl-android", android.content.Context.MODE_PRIVATE)
      .edit()
      .remove("dlpVersion")
      .remove("dlpVersionName")
      .remove("convertxDlpUpdatedAt")
      .commit()
  }

  // ── yt-dlp updater ────────────────────────────────────────────────────

  private val YTDLP_PREFS = "youtubedl-android"
  private val PREF_DLP_VERSION = "dlpVersion"
  private val PREF_DLP_VERSION_NAME = "dlpVersionName"
  private val PREF_UPDATED_AT = "convertxDlpUpdatedAt"
  private val YTDLP_LATEST_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest"
  private val YTDLP_DOWNLOAD_BASE = "https://github.com/yt-dlp/yt-dlp/releases/download"
  private val YTDLP_TAG_RE = Regex("""^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$""")
  private val UPDATER_UA = "Convert-X-Android (+https://github.com/CedrickGD/Convert-X)"

  private fun ytDlpDir(ctx: android.content.Context): File =
    File(File(ctx.noBackupFilesDir, "youtubedl-android"), "yt-dlp")

  private fun ytDlpBinary(ctx: android.content.Context): File = File(ytDlpDir(ctx), "yt-dlp")

  /** Version string baked into the zipapp (yt_dlp/version.py). Null when
   *  the file is missing or unreadable. */
  private fun readYtDlpVersionFromZip(file: File): String? {
    if (!file.isFile || file.length() == 0L) return null
    return try {
      ZipFile(file).use { zip ->
        val entry = zip.getEntry("yt_dlp/version.py") ?: return null
        val text = zip.getInputStream(entry).bufferedReader().use { it.readText() }
        Regex("""__version__\s*=\s*['"]([^'"]+)['"]""").find(text)?.groupValues?.get(1)
      }
    } catch (_: Throwable) {
      null
    }
  }

  /** Does python's zipimport stand a chance with this file? Opens the
   *  central directory and checks the package is there. */
  private fun zipLooksLoadable(file: File): Boolean {
    if (!file.isFile || file.length() < 1024) return false
    return try {
      ZipFile(file).use { zip ->
        zip.getEntry("yt_dlp/__init__.py") != null || zip.getEntry("__main__.py") != null
      }
    } catch (_: Throwable) {
      false
    }
  }

  /** Installed yt-dlp version: the zipapp's own version.py first, the
   *  library's SharedPreferences bookkeeping as a fallback. */
  private fun installedYtDlpVersion(ctx: android.content.Context): String? {
    readYtDlpVersionFromZip(ytDlpBinary(ctx))?.let { return it }
    val prefs = ctx.getSharedPreferences(YTDLP_PREFS, android.content.Context.MODE_PRIVATE)
    return prefs.getString(PREF_DLP_VERSION, null) ?: prefs.getString(PREF_DLP_VERSION_NAME, null)
  }

  private fun openHttp(url: String, followRedirects: Boolean): HttpURLConnection {
    val conn = URL(url).openConnection() as HttpURLConnection
    conn.instanceFollowRedirects = followRedirects
    conn.connectTimeout = 15_000
    conn.readTimeout = 30_000
    conn.setRequestProperty("User-Agent", UPDATER_UA)
    conn.setRequestProperty("Accept", "*/*")
    return conn
  }

  /** Latest stable tag via the /releases/latest redirect — no API call. */
  private fun resolveLatestYtDlpTag(): String {
    // GitHub bounces /releases/latest to /releases/tag/<tag>; one hop is
    // all we need. Extra hops (rare) are followed manually so a redirect
    // chain can't be mistaken for a missing one.
    var url = YTDLP_LATEST_URL
    repeat(3) {
      val conn = openHttp(url, false)
      try {
        val code = conn.responseCode
        val location = conn.getHeaderField("Location")
        if (code in 300..399 && !location.isNullOrBlank()) {
          val resolved = URL(URL(url), location).toString()
          val tag = resolved.trimEnd('/').substringAfterLast('/')
          if (resolved.contains("/releases/tag/") && YTDLP_TAG_RE.matches(tag)) return tag
          url = resolved
        } else {
          throw IOException("GitHub did not redirect to the latest yt-dlp release (HTTP $code)")
        }
      } finally {
        conn.disconnect()
      }
    }
    throw IOException("Could not resolve the latest yt-dlp release")
  }

  private fun downloadToFile(url: String, dest: File) {
    val conn = openHttp(url, true)
    try {
      val code = conn.responseCode
      if (code != 200) throw IOException("Download failed: HTTP $code for $url")
      conn.inputStream.use { input ->
        dest.outputStream().use { output -> input.copyTo(output, 64 * 1024) }
      }
    } finally {
      conn.disconnect()
    }
  }

  private fun fetchText(url: String): String {
    val conn = openHttp(url, true)
    try {
      val code = conn.responseCode
      if (code != 200) throw IOException("HTTP $code for $url")
      return conn.inputStream.bufferedReader().use { it.readText() }
    } finally {
      conn.disconnect()
    }
  }

  private fun sha256Hex(file: File): String {
    val md = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buf = ByteArray(64 * 1024)
      while (true) {
        val n = input.read(buf)
        if (n < 0) break
        md.update(buf, 0, n)
      }
    }
    return md.digest().joinToString("") { "%02x".format(it) }
  }

  /** The release's published SHA-256 for the `yt-dlp` asset, or null when
   *  the checksum file can't be fetched (then only the zip check gates
   *  the install — better than refusing every update on a flaky link). */
  private fun publishedYtDlpSha256(tag: String): String? {
    return try {
      fetchText("$YTDLP_DOWNLOAD_BASE/$tag/SHA2-256SUMS")
        .lineSequence()
        .map { it.trim().split(Regex("""\s+""")) }
        .firstOrNull { it.size >= 2 && it.last() == "yt-dlp" }
        ?.first()
        ?.lowercase()
    } catch (_: Throwable) {
      null
    }
  }

  private fun runYtDlpUpdate(
    ctx: android.content.Context,
    force: Boolean,
    checkOnly: Boolean
  ): Map<String, Any?> {
    val binary = ytDlpBinary(ctx)
    val installed = installedYtDlpVersion(ctx)
    val latest = resolveLatestYtDlpTag()
    val healthy = zipLooksLoadable(binary)
    if (checkOnly) {
      return mapOf(
        "status" to if (installed == latest && healthy) "ALREADY_UP_TO_DATE" else "AVAILABLE",
        "version" to installed,
        "latest" to latest
      )
    }
    if (!force && installed == latest && healthy) {
      return mapOf("status" to "ALREADY_UP_TO_DATE", "version" to installed, "latest" to latest)
    }

    val dir = ytDlpDir(ctx)
    if (!dir.isDirectory && !dir.mkdirs()) {
      throw IOException("Could not create ${dir.absolutePath}")
    }
    // Stage in the SAME directory so the final rename is an atomic
    // same-filesystem swap; a crash mid-download only ever leaves a
    // `.part` file behind, never a torn yt-dlp.
    val staged = File(dir, "yt-dlp.$latest.part")
    staged.delete()
    try {
      downloadToFile("$YTDLP_DOWNLOAD_BASE/$latest/yt-dlp", staged)
      val expected = publishedYtDlpSha256(latest)
      if (expected != null) {
        val actual = sha256Hex(staged)
        if (actual != expected) {
          throw IOException("Downloaded yt-dlp failed its checksum (got $actual, expected $expected)")
        }
      }
      if (!zipLooksLoadable(staged)) {
        throw IOException("Downloaded yt-dlp is not a loadable zipapp")
      }
      val zipVersion = readYtDlpVersionFromZip(staged)
      if (!staged.renameTo(binary)) {
        // Fallback for exotic filesystems where rename over an existing
        // file fails: delete + rename (not atomic, but the bundled copy
        // is restored by init_ytdlp on the next run if this is torn).
        binary.delete()
        if (!staged.renameTo(binary)) throw IOException("Could not install the new yt-dlp")
      }
      val prefs = ctx.getSharedPreferences(YTDLP_PREFS, android.content.Context.MODE_PRIVATE)
      prefs.edit()
        .putString(PREF_DLP_VERSION, latest)
        .putString(PREF_DLP_VERSION_NAME, latest)
        .putLong(PREF_UPDATED_AT, System.currentTimeMillis())
        .commit()
      return mapOf("status" to "DONE", "version" to (zipVersion ?: latest), "latest" to latest)
    } finally {
      staged.delete()
    }
  }

  // ── Hidden WebView HTTP bridge ─────────────────────────────────────────

  private val mainHandler = Handler(Looper.getMainLooper())
  private val BRIDGE_PATH = "/__convertx_bridge__"
  private var bridgeView: WebView? = null
  /** Origin (scheme://host) the blank bridge document is currently loaded
   *  under, once onPageFinished confirmed it. */
  private var bridgeOrigin: String? = null
  private var bridgeLoading: String? = null
  private val bridgeLoadWaiters = ArrayList<(Throwable?) -> Unit>()
  private val bridgeQueue = ArrayDeque<Pair<Map<String, Any?>, Promise>>()
  private var bridgeBusy = false
  private var bridgeSeq = 0L
  private class BridgeCall(val promise: Promise, val origin: String, val timeout: Runnable)
  private val bridgeCalls = HashMap<String, BridgeCall>()

  private fun originOf(url: String): String {
    val u = Uri.parse(url)
    val scheme = u.scheme ?: throw IllegalArgumentException("URL has no scheme: $url")
    val host = u.host ?: throw IllegalArgumentException("URL has no host: $url")
    val port = u.port
    return if (port > 0) "$scheme://$host:$port" else "$scheme://$host"
  }

  private fun destroyBridgeView() {
    val view = bridgeView ?: return
    bridgeView = null
    bridgeOrigin = null
    bridgeLoading = null
    try {
      view.stopLoading()
      view.destroy()
    } catch (_: Throwable) {
    }
  }

  private inner class BridgeInterface {
    @JavascriptInterface
    fun done(id: String, json: String) {
      mainHandler.post { completeBridgeCall(id, json, null) }
    }

    @JavascriptInterface
    fun fail(id: String, message: String) {
      mainHandler.post { completeBridgeCall(id, null, message) }
    }
  }

  private fun ensureBridgeView(): WebView {
    bridgeView?.let { return it }
    val ctx = appContext.reactContext
      ?: throw IllegalStateException("Application context unavailable")
    val view = WebView(ctx)
    val s = view.settings
    s.javaScriptEnabled = true
    s.domStorageEnabled = true
    s.blockNetworkImage = true
    s.loadsImagesAutomatically = false
    s.mediaPlaybackRequiresUserGesture = true
    s.cacheMode = android.webkit.WebSettings.LOAD_NO_CACHE
    val cm = CookieManager.getInstance()
    cm.setAcceptCookie(true)
    cm.setAcceptThirdPartyCookies(view, true)
    view.addJavascriptInterface(BridgeInterface(), "ConvertXBridge")
    view.webViewClient = object : WebViewClient() {
      override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest
      ): WebResourceResponse? {
        if (request.url.path == BRIDGE_PATH) {
          val html = "<!doctype html><html><head><meta charset=\"utf-8\"></head><body></body></html>"
          return WebResourceResponse(
            "text/html", "utf-8", 200, "OK",
            mapOf("Cache-Control" to "no-store"),
            ByteArrayInputStream(html.toByteArray(Charsets.UTF_8))
          )
        }
        return null
      }

      override fun onPageFinished(view: WebView, url: String) {
        if (Uri.parse(url).path != BRIDGE_PATH) return
        bridgeOrigin = try { originOf(url) } catch (_: Throwable) { null }
        bridgeLoading = null
        val waiters = ArrayList(bridgeLoadWaiters)
        bridgeLoadWaiters.clear()
        for (w in waiters) w(null)
      }

      override fun onReceivedError(
        view: WebView,
        request: WebResourceRequest,
        error: android.webkit.WebResourceError
      ) {
        if (!request.isForMainFrame) return
        bridgeLoading = null
        val waiters = ArrayList(bridgeLoadWaiters)
        bridgeLoadWaiters.clear()
        val msg = "Bridge page failed to load: ${error.description}"
        for (w in waiters) w(IOException(msg))
      }
    }
    bridgeView = view
    return view
  }

  private fun enqueueBridgeRequest(opts: Map<String, Any?>, promise: Promise) {
    bridgeQueue.addLast(opts to promise)
    pumpBridgeQueue()
  }

  private fun pumpBridgeQueue() {
    if (bridgeBusy) return
    val next = bridgeQueue.removeFirstOrNull() ?: return
    bridgeBusy = true
    try {
      runBridgeRequest(next.first, next.second)
    } catch (e: Throwable) {
      bridgeBusy = false
      next.second.reject(CodedException("WEBVIEW_UNAVAILABLE", describe(e), e))
      pumpBridgeQueue()
    }
  }

  private fun finishBridgeSlot() {
    bridgeBusy = false
    pumpBridgeQueue()
  }

  private fun syncBridgeCookies(origin: String, cookies: List<Map<String, Any?>>) {
    val cm = CookieManager.getInstance()
    val host = Uri.parse(origin).host ?: return
    val wanted = cookies.mapNotNull { it["name"] as? String }.toSet()
    // Expire what the jar holds for this origin that the caller did not
    // send — a logged-out account's leftovers must not ride along on the
    // next (anonymous or re-logged-in) request.
    val existing = cm.getCookie(origin)
      ?.split(';')
      ?.mapNotNull { it.trim().substringBefore('=').takeIf { n -> n.isNotBlank() } }
      ?: emptyList()
    val apex = host.removePrefix("www.")
    for (name in existing) {
      if (name in wanted) continue
      cm.setCookie(origin, "$name=; Domain=.$apex; Path=/; Max-Age=0")
      cm.setCookie(origin, "$name=; Domain=$host; Path=/; Max-Age=0")
      cm.setCookie(origin, "$name=; Path=/; Max-Age=0")
    }
    for (c in cookies) {
      val name = c["name"] as? String ?: continue
      val value = c["value"] as? String ?: ""
      val domain = (c["domain"] as? String)?.takeIf { it.isNotBlank() } ?: ".$apex"
      cm.setCookie(origin, "$name=$value; Domain=$domain; Path=/; Secure; Max-Age=31536000")
    }
    cm.flush()
  }

  @Suppress("UNCHECKED_CAST")
  private fun runBridgeRequest(opts: Map<String, Any?>, promise: Promise) {
    val url = opts["url"] as? String
      ?: throw IllegalArgumentException("url is required")
    val origin = originOf(url)
    val view = ensureBridgeView()

    (opts["userAgent"] as? String)?.takeIf { it.isNotBlank() }?.let { ua ->
      if (view.settings.userAgentString != ua) view.settings.userAgentString = ua
    }
    val cookieMode = opts["cookieMode"] as? String ?: "keep"
    if (cookieMode == "replace") {
      val cookies = (opts["cookies"] as? List<*>)
        ?.mapNotNull { it as? Map<String, Any?> }
        ?: emptyList()
      syncBridgeCookies(origin, cookies)
    }

    val go: (Throwable?) -> Unit = { loadErr ->
      if (loadErr != null) {
        finishBridgeSlot()
        promise.reject(CodedException("WEBFETCH_FAILED", describe(loadErr), loadErr))
      } else {
        try {
          dispatchBridgeFetch(view, origin, opts, promise)
        } catch (e: Throwable) {
          finishBridgeSlot()
          promise.reject(CodedException("WEBFETCH_FAILED", describe(e), e))
        }
      }
    }

    if (bridgeOrigin == origin && bridgeLoading == null) {
      go(null)
      return
    }
    bridgeLoadWaiters.add(go)
    if (bridgeLoading != origin) {
      bridgeLoading = origin
      bridgeOrigin = null
      val timeoutMs = (opts["timeoutMs"] as? Number)?.toLong() ?: 20_000L
      val loadTimeout = Runnable {
        if (bridgeLoading == origin && bridgeOrigin != origin) {
          bridgeLoading = null
          val waiters = ArrayList(bridgeLoadWaiters)
          bridgeLoadWaiters.clear()
          for (w in waiters) w(IOException("Bridge page load timed out"))
        }
      }
      mainHandler.postDelayed(loadTimeout, timeoutMs)
      view.loadUrl("$origin$BRIDGE_PATH")
    }
  }

  @Suppress("UNCHECKED_CAST")
  private fun dispatchBridgeFetch(
    view: WebView,
    origin: String,
    opts: Map<String, Any?>,
    promise: Promise
  ) {
    val id = "b${++bridgeSeq}"
    val req = JSONObject()
    req.put("url", opts["url"] as String)
    req.put("method", (opts["method"] as? String)?.uppercase() ?: "GET")
    val headers = JSONObject()
    (opts["headers"] as? Map<String, Any?>)?.forEach { (k, v) ->
      if (v != null) headers.put(k, v.toString())
    }
    req.put("headers", headers)
    (opts["body"] as? String)?.let { req.put("body", it) }
    (opts["referrer"] as? String)?.let { req.put("referrer", it) }
    val maxBody = (opts["maxBodyBytes"] as? Number)?.toInt() ?: 6_000_000
    req.put("maxBody", maxBody)

    val script = """
      (function(){
        var id = ${JSONObject.quote(id)};
        var req = $req;
        function fail(e){ try { ConvertXBridge.fail(id, String(e && e.message || e)); } catch(_) {} }
        try {
          var init = { method: req.method, headers: req.headers, credentials: 'include', redirect: 'follow', cache: 'no-store' };
          if (req.body != null) init.body = req.body;
          if (req.referrer) init.referrer = req.referrer;
          fetch(req.url, init).then(function(r){
            var h = {};
            try { r.headers.forEach(function(v, k){ h[k] = v; }); } catch(_) {}
            return r.text().then(function(t){
              if (t.length > req.maxBody) t = t.slice(0, req.maxBody);
              ConvertXBridge.done(id, JSON.stringify({ status: r.status, url: r.url, redirected: !!r.redirected, headers: h, body: t }));
            });
          }).catch(fail);
        } catch (e) { fail(e); }
      })();
    """.trimIndent()

    val timeoutMs = (opts["timeoutMs"] as? Number)?.toLong() ?: 20_000L
    val timeout = Runnable {
      val call = bridgeCalls.remove(id) ?: return@Runnable
      finishBridgeSlot()
      call.promise.reject(
        CodedException("WEBFETCH_TIMEOUT", "Request timed out after ${timeoutMs}ms", null)
      )
    }
    bridgeCalls[id] = BridgeCall(promise, origin, timeout)
    mainHandler.postDelayed(timeout, timeoutMs)
    view.evaluateJavascript(script, null)
  }

  private fun completeBridgeCall(id: String, json: String?, error: String?) {
    val call = bridgeCalls.remove(id) ?: return
    mainHandler.removeCallbacks(call.timeout)
    finishBridgeSlot()
    if (error != null || json == null) {
      call.promise.reject(
        CodedException("WEBFETCH_FAILED", error ?: "Bridge returned nothing", null)
      )
      return
    }
    try {
      val obj = JSONObject(json)
      val headers = HashMap<String, String>()
      obj.optJSONObject("headers")?.let { h ->
        val keys = h.keys()
        while (keys.hasNext()) {
          val k = keys.next()
          headers[k] = h.optString(k)
        }
      }
      val jar = try { CookieManager.getInstance().getCookie(call.origin) } catch (_: Throwable) { null }
      call.promise.resolve(
        mapOf(
          "status" to obj.optInt("status", 0),
          "url" to obj.optString("url", ""),
          "redirected" to obj.optBoolean("redirected", false),
          "headers" to headers,
          "body" to obj.optString("body", ""),
          "cookies" to (jar ?: "")
        )
      )
    } catch (e: Throwable) {
      call.promise.reject(CodedException("WEBFETCH_FAILED", describe(e), e))
    }
  }

  /** True when the throwable's chain mentions a corrupted yt-dlp zip. */
  private fun looksCorrupted(t: Throwable): Boolean {
    var cur: Throwable? = t
    var depth = 0
    while (cur != null && depth < 6) {
      val msg = cur.message ?: ""
      if (msg.contains("bad local file header", ignoreCase = true) ||
          msg.contains("BadZipFile", ignoreCase = true) ||
          msg.contains("ZipImportError", ignoreCase = true)
      ) return true
      cur = cur.cause
      depth += 1
    }
    return false
  }

  private fun applyAuthOpts(request: YoutubeDLRequest, opts: Map<String, Any?>?) {
    if (opts == null) return
    (opts["cookies"] as? String)?.let { if (it.isNotBlank()) request.addOption("--cookies", it) }
    val spotifyId = opts["spotifyClientId"] as? String
    val spotifySecret = opts["spotifyClientSecret"] as? String
    if (!spotifyId.isNullOrBlank() && !spotifySecret.isNullOrBlank()) {
      // yt-dlp's Spotify auth lives behind --extractor-args, NOT
      // --client-id / --username.
      request.addOption(
        "--extractor-args",
        "spotify:client_id=$spotifyId;client_secret=$spotifySecret"
      )
    }
    (opts["userAgent"] as? String)?.let {
      if (it.isNotBlank()) request.addOption("--user-agent", it)
    }
  }
}
