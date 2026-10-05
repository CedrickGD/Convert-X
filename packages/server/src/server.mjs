// convertx-api wiring: config → (in-process egress proxy) → engine → jobs → HTTP.
// `src/main.mjs` runs it; tests import start() to run the real thing in-process.
//
// EGRESS_MODE=remote (compose): the proxy is the separate `egress` container
// and this process only ever talks to it. EGRESS_MODE=inprocess (dev, the
// default): the same proxy runs here on 127.0.0.1. Either way every
// outbound request — yt-dlp, ffmpeg, pip, safeFetch — goes through it.

import fsp from "node:fs/promises";
import http from "node:http";
import { createApp } from "./app.mjs";
import { egressProxyUrl, loadConfig } from "./config.mjs";
import { createEgressProxy } from "./egressProxy.mjs";
import { createEngine } from "./engine.mjs";
import { createGuard } from "./ipguard.mjs";
import { JobManager } from "./jobs.mjs";
import { createLogger } from "./log.mjs";
import { createProber } from "./probe.mjs";
import { createSafeFetcher } from "./safeFetch.mjs";

/**
 * Start everything. Returns handles so the integration smoke test can run
 * the real thing in-process and stop it again.
 */
export async function start({ env = process.env, log = createLogger() } = {}) {
  const config = loadConfig(env);
  await fsp.mkdir(config.jobsDir, { recursive: true });

  let proxy = null;
  if (config.egressMode === "inprocess") {
    proxy = createEgressProxy({
      guard: createGuard(),
      allowedPorts: config.egressAllowedPorts,
      token: config.egressToken,
      log,
    });
    const addr = await proxy.listen(config.egressProxyPort, "127.0.0.1");
    config.egressProxyPort = addr.port;
    config.egressProxyUrl = egressProxyUrl({ host: config.egressHost, port: addr.port, token: config.egressToken });
  }
  const fetcher = createSafeFetcher({
    proxy: { host: config.egressHost, port: config.egressProxyPort, token: config.egressToken },
  });

  const engine = createEngine({ config, log });
  await engine.refreshVersion();
  if (!engine.version) log.warn("yt-dlp is not runnable — downloads will fail", { ytdlp: config.ytdlp.cmd });

  const jobs = new JobManager({ config, log, engine });
  await jobs.wipe();
  jobs.startSweeper();
  await fsp.rm(`${config.dataDir}/probe`, { recursive: true, force: true });

  const prober = createProber({ config, log, engine });
  const handler = createApp({ config, log, jobs, engine, prober, fetcher });

  const server = http.createServer(handler);
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  engine.startAutoUpdate();
  log.info("listening", {
    port: server.address().port,
    ytdlp: engine.version,
    maxConcurrentJobs: config.maxConcurrentJobs,
    egress: `${config.egressMode} ${config.egressHost}:${config.egressProxyPort}`,
    egressToken: config.egressToken ? "set" : "none",
  });
  if (config.egressMode === "remote" && !config.egressToken) {
    log.warn("EGRESS_TOKEN is not set — the egress proxy can't tell this service from anything else on its network");
  }

  let stopping = null;
  async function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      log.info("shutting down");
      engine.stop();
      const closed = new Promise((resolve) => server.close(() => resolve()));
      server.closeIdleConnections?.();
      await jobs.shutdown();
      server.closeAllConnections?.();
      await closed;
      await proxy?.close();
    })();
    return stopping;
  }

  return { config, server, proxy, engine, jobs, stop };
}
