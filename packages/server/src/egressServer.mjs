// The `egress` container: just the egress proxy (src/egressProxy.mjs),
// listening on its internal-network address. It is the only container of the
// project with a route to the internet, and it only ever connects to public
// addresses on the allowed ports. `src/egressMain.mjs` runs it; tests import
// startEgress() to run it in-process.

import { loadEgressConfig } from "./config.mjs";
import { createEgressProxy } from "./egressProxy.mjs";
import { createGuard } from "./ipguard.mjs";
import { createLogger } from "./log.mjs";

export async function startEgress({ env = process.env, log = createLogger(), guard = createGuard() } = {}) {
  const config = loadEgressConfig(env);
  const proxy = createEgressProxy({ guard, allowedPorts: config.allowedPorts, token: config.token, log });
  const addr = await proxy.listen(config.port, config.listenHost);
  log.info("egress listening", {
    host: addr.address,
    port: addr.port,
    allowedPorts: config.allowedPorts.join(","),
    token: config.token ? "required" : "none",
  });
  if (!config.token) {
    log.warn("EGRESS_TOKEN is not set — anything that can reach this proxy can use it");
  }
  return { config, proxy, address: addr, stop: () => proxy.close() };
}
