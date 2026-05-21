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

  override fun definition() = ModuleDefinition {
    Name("ConvertXDownloader")
    Events("onProgress", "onStage")

    AsyncFunction("init") { promise: Promise ->
      scope.launch {
        try {
          ensureInitializedSync()
          promise.resolve(null)
        } catch (e: Throwable) {
          promise.reject(CodedException("INIT_FAILED", e.message ?: "youtubedl init error", e))
        }
      }
    }

    AsyncFunction("probe") { url: String, opts: Map<String, Any?>?, promise: Promise ->
      scope.launch {
        try {
          ensureInitializedSync()
          val request = YoutubeDLRequest(url)
          request.addOption("--no-warnings")
          request.addOption("--flat-playlist")
          applyAuthOpts(request, opts)
          // `getInfo` runs yt-dlp with --dump-json and parses out into a
          // VideoInfo. Re-serialize so we can hand it to JS without dragging
          // Jackson types across the bridge.
          val info = YoutubeDL.getInstance().getInfo(request)
          val json = JSONObject()
          json.put("id", info.id)
          json.put("title", info.title)
          json.put("description", info.description ?: "")
          json.put("thumbnail", info.thumbnail ?: "")
          json.put("duration", info.duration)
          json.put("uploader", info.uploader ?: "")
          json.put("extractor", info.extractor ?: "")
          json.put("url", info.webpageUrl ?: url)
          // Formats (when available — single-video URLs)
          val formats = org.json.JSONArray()
          info.formats?.forEach { f ->
            val o = JSONObject()
            o.put("formatId", f.formatId)
            o.put("ext", f.ext)
            o.put("note", f.formatNote ?: "")
            o.put("width", f.width)
            o.put("height", f.height)
            o.put("filesize", f.filesize ?: 0)
            o.put("acodec", f.acodec ?: "")
            o.put("vcodec", f.vcodec ?: "")
            formats.put(o)
          }
          json.put("formats", formats)
          // Playlist entries (multi-asset)
          val entries = org.json.JSONArray()
          info.entries?.forEach { e ->
            val o = JSONObject()
            o.put("id", e.id)
            o.put("title", e.title)
            o.put("url", e.url ?: e.webpageUrl ?: "")
            o.put("thumbnail", e.thumbnail ?: "")
            o.put("duration", e.duration)
            entries.put(o)
          }
          json.put("entries", entries)
          json.put("isPlaylist", entries.length() > 0)
          promise.resolve(json.toString())
        } catch (e: Throwable) {
          promise.reject(CodedException("PROBE_FAILED", e.message ?: "yt-dlp probe error", e))
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

          val response = YoutubeDL.getInstance().execute(request, processId) { progress, eta, line ->
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
          sessions.remove(sessionId)

          promise.resolve(
            mapOf(
              "outputPath" to outputPath,
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
            promise.reject(CodedException("DOWNLOAD_FAILED", e.message ?: "yt-dlp download error", e))
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
