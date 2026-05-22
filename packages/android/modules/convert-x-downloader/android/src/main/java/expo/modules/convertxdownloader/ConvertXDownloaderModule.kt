package expo.modules.convertxdownloader

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
import java.util.concurrent.ConcurrentHashMap

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

    /** Pull the latest yt-dlp from GitHub. Explicit, not on-init.
     *  If the download corrupts the local zip, the next probe will
     *  detect "bad local file header" and auto-reset. */
    AsyncFunction("updateYtDlp") { promise: Promise ->
      scope.launch {
        try {
          ensureInitializedSync()
          val ctx = appContext.reactContext
            ?: throw CodedException("NO_CONTEXT", "Application context unavailable", null)
          YoutubeDL.getInstance().updateYoutubeDL(ctx)
          promise.resolve(null)
        } catch (e: Throwable) {
          promise.reject(CodedException("UPDATE_FAILED", describe(e), e))
        }
      }
    }

    AsyncFunction("probe") { url: String, opts: Map<String, Any?>?, promise: Promise ->
      scope.launch {
        try {
          ensureInitializedSync()
          val request = YoutubeDLRequest(url)
          request.addOption("--dump-json")
          request.addOption("--no-warnings")
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
          // for MediaLibrary.createAssetAsync.
          request.addOption("--print", "after_move:filepath")
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
