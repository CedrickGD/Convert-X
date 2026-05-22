package expo.modules.convertxffmpeg

import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.content.FileProvider
import com.arthenica.ffmpegkit.FFmpegKit
import com.arthenica.ffmpegkit.FFmpegSession
import com.arthenica.ffmpegkit.FFprobeKit
import com.arthenica.ffmpegkit.ReturnCode
import com.arthenica.ffmpegkit.Statistics
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * Convert-X FFmpeg bridge.
 *
 * Wraps the published `ffmpeg-kit` Maven artifact. Three responsibilities:
 *  - executeAsync(sessionId, args, durationMs): runs FFmpeg with a JS-supplied
 *    string array, reports progress via `onProgress` events, resolves with
 *    return code + log lines when done.
 *  - cancel(sessionId): cancels the in-flight session by its FFmpegKit
 *    session id (we map our JS-side string `sessionId` to FFmpegKit's
 *    numeric session id via `sessions`).
 *  - getMediaInfo(uri): runs ffprobe and surfaces duration / resolution /
 *    bitrate / codec / format.
 */
class ConvertXFfmpegModule : Module() {

  private val sessions = ConcurrentHashMap<String, Long>()

  companion object {
    @Volatile private var loadAttempted: Boolean = false
    @Volatile private var loadError: Throwable? = null
  }

  /**
   * Eager-load the native FFmpegKit libs and surface the underlying
   * UnsatisfiedLinkError if `libffmpegkit.so` (or any of its deps) won't
   * map. On the first reference to FFmpegKit / FFmpegKitConfig the class
   * loader runs `System.loadLibrary("ffmpegkit")`; if that throws, the
   * class is left in error state and every subsequent access turns into a
   * bare `NoClassDefFoundError` with no message about *why*. Cache the
   * original cause so executeAsync / getMediaInfo can return a real
   * diagnostic instead of "class not found".
   */
  private fun ffmpegLoadError(): Throwable? {
    if (loadAttempted) return loadError
    synchronized(ConvertXFfmpegModule::class.java) {
      if (loadAttempted) return loadError
      loadAttempted = true
      loadError = try {
        Class.forName(
          "com.arthenica.ffmpegkit.FFmpegKitConfig",
          true,
          ConvertXFfmpegModule::class.java.classLoader,
        )
        null
      } catch (t: Throwable) {
        // Unwrap ExceptionInInitializerError to the underlying
        // UnsatisfiedLinkError / Error("FFmpegKit failed to start on …").
        t.cause ?: t
      }
    }
    return loadError
  }

  private fun rejectIfFfmpegMissing(promise: expo.modules.kotlin.Promise): Boolean {
    val err = ffmpegLoadError() ?: return false
    val msg = err.message ?: err.javaClass.simpleName
    promise.reject(CodedException("FFMPEG_UNAVAILABLE", "FFmpeg native library failed to load: $msg", err))
    return true
  }

  override fun definition() = ModuleDefinition {
    Name("ConvertXFfmpeg")

    Events("onProgress")

    AsyncFunction("executeAsync") { sessionId: String, args: List<String>, durationMs: Double, promise: expo.modules.kotlin.Promise ->
      if (rejectIfFfmpegMissing(promise)) return@AsyncFunction
      val totalMs = durationMs.toLong()
      val logBuffer = StringBuilder()

      val session: FFmpegSession = FFmpegKit.executeWithArgumentsAsync(
        args.toTypedArray(),
        { completedSession ->
          sessions.remove(sessionId)
          val code = completedSession.returnCode
          val result = mapOf(
            "returnCode" to (code?.value ?: -1),
            "logs" to logBuffer.toString(),
            "cancelled" to ReturnCode.isCancel(code)
          )
          promise.resolve(result)
        },
        { log ->
          // Log callback — capture everything, useful when debugging codec choice.
          val line = log.message
          if (line != null) {
            synchronized(logBuffer) { logBuffer.append(line) }
          }
        },
        { statistics: Statistics ->
          // Progress callback — translate FFmpeg's time= field into a 0..100
          // percentage so JS can drive the ProgressBar.
          val timeMs = statistics.time.toLong()
          val percent = if (totalMs > 0) {
            ((timeMs.toDouble() / totalMs.toDouble()) * 100.0).coerceIn(0.0, 100.0)
          } else {
            0.0
          }
          sendEvent(
            "onProgress",
            mapOf(
              "sessionId" to sessionId,
              "percent" to percent,
              "timeMs" to timeMs,
              "durationMs" to totalMs
            )
          )
        }
      )

      sessions[sessionId] = session.sessionId
    }

    Function("cancel") { sessionId: String ->
      val ffSessionId = sessions.remove(sessionId)
      if (ffSessionId != null) {
        FFmpegKit.cancel(ffSessionId)
      }
    }

    // ── Self-update support ──────────────────────────────────────────
    // The convert-x-ffmpeg module also hosts the small native helpers
    // the in-app updater needs — we already wire its react context here,
    // so adding two more functions avoids a second native module.

    Function("getSupportedAbis") {
      Build.SUPPORTED_ABIS.toList()
    }

    /** Returns null if FFmpeg loaded fine, otherwise a human-readable
     *  diagnostic of why the native library would not map (16KB pages,
     *  missing dep, ABI mismatch, …). Useful for proactive UI warnings. */
    Function("getFfmpegLoadError") {
      val err = ffmpegLoadError() ?: return@Function null as String?
      val parts = mutableListOf<String>()
      var cur: Throwable? = err
      var depth = 0
      while (cur != null && depth < 4) {
        parts.add("${cur.javaClass.simpleName}: ${cur.message ?: "(no message)"}")
        cur = cur.cause
        depth += 1
      }
      parts.joinToString(" → ")
    }

    AsyncFunction("installApk") { uriString: String, promise: expo.modules.kotlin.Promise ->
      try {
        val ctx = appContext.reactContext
          ?: throw CodedException("NO_CONTEXT", "React context unavailable", null)

        // expo-file-system hands back file:// URIs; strip the scheme so
        // we can pass a File to FileProvider.
        val path = if (uriString.startsWith("file://")) {
          Uri.parse(uriString).path
        } else {
          uriString
        } ?: throw CodedException("BAD_URI", "Cannot resolve $uriString", null)

        val apk = File(path)
        if (!apk.exists()) {
          throw CodedException("NO_APK", "APK not found at $path", null)
        }

        val authority = "${ctx.packageName}.fileprovider"
        val contentUri: Uri = FileProvider.getUriForFile(ctx, authority, apk)
        val intent = Intent(Intent.ACTION_VIEW).apply {
          setDataAndType(contentUri, "application/vnd.android.package-archive")
          flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION
        }
        ctx.startActivity(intent)
        promise.resolve(null)
      } catch (e: CodedException) {
        promise.reject(e)
      } catch (e: Throwable) {
        promise.reject(CodedException("INSTALL_FAILED", e.message ?: "install error", e))
      }
    }

    AsyncFunction("getMediaInfo") { uri: String, promise: expo.modules.kotlin.Promise ->
      if (rejectIfFfmpegMissing(promise)) return@AsyncFunction
      try {
        val probeSession = FFprobeKit.getMediaInformation(uri)
        val info = probeSession.mediaInformation
        if (info == null) {
          promise.reject(CodedException("PROBE_FAILED", "ffprobe returned no media info for $uri", null))
          return@AsyncFunction
        }
        val durationSec = info.duration?.toDoubleOrNull() ?: 0.0
        val streams = info.streams
        val videoStream = streams?.firstOrNull { it.type == "video" }
        val width = videoStream?.width?.toInt()
        val height = videoStream?.height?.toInt()
        val codec = videoStream?.codec
        val bitrate = info.bitrate?.toLongOrNull()

        promise.resolve(
          mapOf(
            "durationMs" to (durationSec * 1000.0).toLong(),
            "width" to width,
            "height" to height,
            "bitrate" to bitrate,
            "codec" to codec,
            "format" to info.format
          )
        )
      } catch (e: Throwable) {
        promise.reject(CodedException("PROBE_FAILED", e.message ?: "ffprobe error", e))
      }
    }
  }
}
