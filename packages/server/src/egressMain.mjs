// `node src/egressMain.mjs` — the egress proxy container's entry point (same
// image as the API, different command). Runs until SIGTERM/SIGINT.

import { startEgress } from "./egressServer.mjs";
import { createLogger } from "./log.mjs";

const log = createLogger();
process.on("unhandledRejection", (e) => log.error("unhandled rejection", { detail: e?.stack || String(e) }));

try {
  const { stop } = await startEgress({ log });
  const onSignal = (sig) => {
    log.info("signal", { sig });
    const force = setTimeout(() => process.exit(1), 10_000);
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
