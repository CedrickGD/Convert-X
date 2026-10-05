// yt-dlp version + self-update.
//
// Sites break yt-dlp every few weeks, so the image's copy must be able to
// move forward without a rebuild: POST /engine/update (and a timer, once per
// day) runs `pip install -U "yt-dlp[default]"` inside the /opt/ytdlp venv.
// While an update runs, new jobs and probes wait (whenIdle) so nothing starts
// against a half-replaced package; running jobs keep the modules they have
// already imported.

import { childEnv, redactEgressToken } from "./egressClient.mjs";
import { runProcess } from "./proc.mjs";

export function createEngine({ config, log }) {
  let version = null;
  let updating = null;
  let timer = null;
  const idleListeners = new Set();

  async function refreshVersion() {
    const run = runProcess({
      cmd: config.ytdlp.cmd,
      args: [...config.ytdlp.prefixArgs, "--version"],
      timeoutMs: 30_000,
      collectStdout: true,
      maxStdoutBytes: 64 * 1024,
    });
    const r = await run.done;
    if (r.spawnError || r.code !== 0) {
      log.warn("yt-dlp --version failed", { code: r.code, detail: r.spawnError?.message || r.tail });
      return version;
    }
    const v = r.stdout.trim().split(/\r?\n/).pop()?.trim() || null;
    version = v;
    return version;
  }

  function update() {
    if (updating) return updating;
    updating = (async () => {
      const before = version ?? (await refreshVersion());
      const run = runProcess({
        cmd: config.pip.cmd,
        args: [
          ...config.pip.prefixArgs,
          "install",
          "--upgrade",
          "--disable-pip-version-check",
          "--no-input",
          "--quiet",
          "yt-dlp[default]",
        ],
        // pip reaches PyPI through the egress proxy like everything else.
        env: childEnv(config),
        timeoutMs: 10 * 60_000,
      });
      const r = await run.done;
      if (r.spawnError) throw new Error(`Couldn't start pip: ${r.spawnError.message}`);
      if (r.timedOut) throw new Error("The yt-dlp update took longer than 10 minutes and was stopped.");
      if (r.code !== 0) {
        const why = r.tail ? redactEgressToken(r.tail, config) : `pip exited with code ${r.code}`;
        throw new Error(`The yt-dlp update failed: ${why}`);
      }
      const after = await refreshVersion();
      const status = after && after !== before ? "DONE" : "ALREADY_UP_TO_DATE";
      log.info("yt-dlp update", { status, before, after });
      return { status, version: after };
    })().finally(() => {
      updating = null;
      for (const fn of idleListeners) {
        try {
          fn();
        } catch {
          /* listener errors never break the update */
        }
      }
    });
    return updating;
  }

  function startAutoUpdate() {
    if (!config.autoUpdateHours) return;
    const every = config.autoUpdateHours * 3600_000;
    const tick = () =>
      update().catch((e) => log.warn("scheduled yt-dlp update failed", { detail: e.message }));
    // First run a few minutes after boot, not during it.
    timer = setTimeout(function loop() {
      tick();
      timer = setTimeout(loop, every);
      timer.unref?.();
    }, 5 * 60_000);
    timer.unref?.();
  }

  return {
    get version() {
      return version;
    },
    get isUpdating() {
      return updating !== null;
    },
    refreshVersion,
    update,
    /** Resolves once no update is running (never rejects). */
    whenIdle() {
      return updating ? updating.then(() => {}, () => {}) : Promise.resolve();
    },
    onIdle(fn) {
      idleListeners.add(fn);
      return () => idleListeners.delete(fn);
    },
    startAutoUpdate,
    stop() {
      clearTimeout(timer);
    },
  };
}
