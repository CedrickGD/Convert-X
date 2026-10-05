// One JSON line per event on stdout/stderr — `docker compose logs api` reads
// fine and anything can parse it. Never log keys, tokens or full URLs with
// query strings (signed CDN links carry credentials).

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger({ level = process.env.LOG_LEVEL || "info", sink = null } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  function log(lvl, msg, fields = {}) {
    if ((LEVELS[lvl] ?? LEVELS.info) < min) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level: lvl, msg, ...fields });
    if (sink) sink(line);
    else if (lvl === "error" || lvl === "warn") process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
  }
  return {
    debug: (m, f) => log("debug", m, f),
    info: (m, f) => log("info", m, f),
    warn: (m, f) => log("warn", m, f),
    error: (m, f) => log("error", m, f),
  };
}

/** Logger that drops everything (tests). */
export const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** scheme://host/path — no query, no fragment, no userinfo. */
export function redactUrl(raw) {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "(invalid url)";
  }
}
