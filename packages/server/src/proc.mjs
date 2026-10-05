// Child-process runner for yt-dlp / pip.
//
// yt-dlp forks helpers (ffmpeg for merges, node for YouTube challenges), so a
// plain child.kill() would orphan them. On Linux every child is spawned
// detached — its own process group — and killed as a group (kill(-pid)).
// Windows (dev machines only) has no process groups; taskkill /T walks the
// tree instead.

import { spawn, execFile } from "node:child_process";
import readline from "node:readline";
import { pushTailLine } from "./ytdlp.mjs";

const IS_WIN = process.platform === "win32";
const STDERR_KEEP = 256 * 1024;

/** Signal a whole process tree. Best effort, never throws. */
export function killTree(child, signal = "SIGTERM") {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (!pid) return;
  if (IS_WIN) {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Run a command to completion.
 *
 *   const run = runProcess({cmd, args, env, timeoutMs, onStdoutLine, collectStdout, maxStdoutBytes});
 *   run.cancel();            // SIGTERM the group, SIGKILL after `killGraceMs`
 *   const r = await run.done // {code, signal, tail, stdout, timedOut, cancelled, spawnError}
 *
 * `tail` is the last 3 non-empty stderr lines joined " · " (the Rust format).
 * Never rejects.
 */
export function runProcess({
  cmd,
  args = [],
  env = process.env,
  cwd,
  timeoutMs = 0,
  killGraceMs = 5000,
  onStdoutLine = null,
  collectStdout = false,
  maxStdoutBytes = 64 * 1024 * 1024,
}) {
  let child;
  let cancelled = false;
  let timedOut = false;
  let overflow = false;
  let killTimer = null;
  let deadline = null;
  const tail = [];
  let stderrText = "";
  const chunks = [];
  let stdoutBytes = 0;

  const terminate = () => {
    killTree(child, "SIGTERM");
    if (!killTimer) {
      killTimer = setTimeout(() => killTree(child, "SIGKILL"), killGraceMs);
      killTimer.unref?.();
    }
  };

  const done = new Promise((resolve) => {
    try {
      child = spawn(cmd, args, {
        env,
        cwd,
        detached: !IS_WIN,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ code: -1, signal: null, tail: "", stdout: "", timedOut, cancelled, spawnError: e });
      return;
    }

    let spawnError = null;
    let settled = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(killTimer);
      resolve({
        code: code ?? -1,
        signal: signal ?? null,
        tail: tail.join(" · "),
        stderr: stderrText,
        stdout: collectStdout ? Buffer.concat(chunks).toString("utf8") : "",
        stdoutOverflow: overflow,
        timedOut,
        cancelled,
        spawnError,
      });
    };
    child.on("error", (e) => {
      spawnError = e;
      // A failed spawn may or may not be followed by 'close'.
      if (!child.pid) setTimeout(() => finish(-1, null), 50);
    });

    if (collectStdout) {
      child.stdout.on("data", (buf) => {
        if (overflow) return;
        stdoutBytes += buf.length;
        if (stdoutBytes > maxStdoutBytes) {
          overflow = true;
          chunks.length = 0;
          terminate();
          return;
        }
        chunks.push(buf);
      });
    } else if (onStdoutLine) {
      const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      rl.on("line", (line) => {
        try {
          onStdoutLine(line);
        } catch {
          /* a progress callback must never kill the run */
        }
      });
    } else {
      child.stdout.resume();
    }

    const errRl = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
    errRl.on("line", (line) => {
      pushTailLine(tail, line);
      // Whole stderr (bounded) for callers that grep it, like the probe's
      // lost-formats check.
      stderrText += line + "\n";
      if (stderrText.length > STDERR_KEEP) stderrText = stderrText.slice(-STDERR_KEEP);
    });

    if (timeoutMs > 0) {
      deadline = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
      deadline.unref?.();
    }

    child.on("close", (code, signal) => finish(code, signal));
  });

  return {
    get pid() {
      return child?.pid ?? null;
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      terminate();
    },
    done,
  };
}
