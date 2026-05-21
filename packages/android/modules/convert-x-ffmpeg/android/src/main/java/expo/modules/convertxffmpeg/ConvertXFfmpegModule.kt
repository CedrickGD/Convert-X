package expo.modules.convertxffmpeg

import com.arthenica.ffmpegkit.FFmpegKit
import com.arthenica.ffmpegkit.FFmpegSession
import com.arthenica.ffmpegkit.FFprobeKit
import com.arthenica.ffmpegkit.ReturnCode
import com.arthenica.ffmpegkit.Statistics
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
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

  override fun definition() = ModuleDefinition {
    Name("ConvertXFfmpeg")

    Events("onProgress")

    AsyncFunction("executeAsync") { sessionId: String, args: List<String>, durationMs: Double, promise: expo.modules.kotlin.Promise ->
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

    AsyncFunction("getMediaInfo") { uri: String, promise: expo.modules.kotlin.Promise ->
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
