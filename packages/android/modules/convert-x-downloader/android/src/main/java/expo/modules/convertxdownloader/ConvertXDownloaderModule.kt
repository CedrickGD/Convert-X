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
     *  detect "bad local file header" and auto-reset. Resolves with the
     *  real outcome ({status, version}) so the UI can distinguish
     *  "updated to 2026.x" from "already up to date" instead of lying. */
    AsyncFunction("updateYtDlp") { promise: Promise ->
      scope.launch {
        try {
          ensureInitializedSync()
          val ctx = appContext.reactContext
            ?: throw CodedException("NO_CONTEXT", "Application context unavailable", null)
          // Same one-shot corruption recovery as probe/download — a
          // half-applied previous update must not brick the updater.
          val status = try {
            YoutubeDL.getInstance().updateYoutubeDL(ctx)
          } catch (first: Throwable) {
            if (!looksCorrupted(first)) throw first
            resetCacheSync()
            ensureInitializedSync()
            YoutubeDL.getInstance().updateYoutubeDL(ctx)
          }
          promise.resolve(
            mapOf(
              "status" to (status?.name ?: "UNKNOWN"),
              "version" to installedYtDlpVersion(ctx)
            )
          )
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
            destDir.mkdirs()
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
      .commit()
  }

  /** Read the installed yt-dlp version from the library's own bookkeeping
   *  (SharedPreferences) — avoids depending on version-getter methods whose
   *  names shift across youtubedl-android releases. */
  private fun installedYtDlpVersion(ctx: android.content.Context): String? {
    val prefs = ctx.getSharedPreferences("youtubedl-android", android.content.Context.MODE_PRIVATE)
    return prefs.getString("dlpVersion", null) ?: prefs.getString("dlpVersionName", null)
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
