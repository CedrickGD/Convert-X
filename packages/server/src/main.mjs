// `node src/main.mjs` — run convertx-api until SIGTERM/SIGINT (tini forwards
// docker's stop signal), then drain: kill running yt-dlp groups, close sockets.

import { createLogger } from "./log.mjs";
import { start } from "./server.mjs";

const log = createLogger();
process.on("unhandledRejection", (e) => log.error("unhandled rejection", { detail: e?.stack || String(e) }));

try {
  const { stop } = await start({ log });
  const onSignal = (sig) => {
    log.info("signal", { sig });
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
} catch (e) {
  log.error("startup failed", { detail: e?.message || String(e) });
  process.exit(1);
}
