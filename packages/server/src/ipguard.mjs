// Egress guard: decides which addresses this service may ever connect to.
//
// The NAS sits on a home LAN, and every URL we fetch comes from a stranger on
// the internet (or from a page yt-dlp parsed on their behalf). Without this
// gate a request for http://192.168.2.1/ — or a public hostname whose DNS
// answer points there — would turn the downloader into a LAN scanner. So:
//
//  - classifyAddress() puts every IPv4/IPv6 literal into "public" or one of
//    the blocked buckets (private, loopback, link-local, CGNAT, multicast,
//    reserved, documentation, …). IPv6 is allowlisted to global unicast
//    (2000::/3) minus the special-purpose blocks; v4-mapped / NAT64 forms are
//    judged by the IPv4 address they carry.
//  - resolvePublic() resolves a host ONCE (dns.lookup, all addresses) and
//    rejects when ANY answer is blocked — a mixed answer is how DNS rebinding
//    attacks start. Callers then connect to the vetted addresses through
//    pinnedLookup(), so nothing re-resolves between the check and the connect.

import dns from "node:dns";
import net from "node:net";

export class EgressBlockedError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = "EgressBlockedError";
    this.code = "EGRESS_BLOCKED";
    this.reason = reason;
  }
}

// ── IPv4 ────────────────────────────────────────────────────────────────────

function parseIPv4(str) {
  if (!net.isIPv4(str)) return null;
  const parts = str.split(".").map((p) => Number(p));
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function v4(cidr) {
  const [addr, bits] = cidr.split("/");
  const base = parseIPv4(addr);
  const len = Number(bits);
  const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
  return { base: (base & mask) >>> 0, mask, len, cidr };
}

// RFC 6890 special-purpose registry + multicast/reserved. Order is only for
// the reported reason; any hit blocks.
const V4_BLOCKS = [
  [v4("0.0.0.0/8"), "unspecified"],
  [v4("10.0.0.0/8"), "private"],
  [v4("100.64.0.0/10"), "cgnat"],
  [v4("127.0.0.0/8"), "loopback"],
  [v4("169.254.0.0/16"), "link-local"],
  [v4("172.16.0.0/12"), "private"],
  [v4("192.0.0.0/24"), "reserved"],
  [v4("192.0.2.0/24"), "documentation"],
  [v4("192.88.99.0/24"), "reserved"],
  [v4("192.168.0.0/16"), "private"],
  [v4("198.18.0.0/15"), "benchmarking"],
  [v4("198.51.100.0/24"), "documentation"],
  [v4("203.0.113.0/24"), "documentation"],
  [v4("224.0.0.0/4"), "multicast"],
  [v4("240.0.0.0/4"), "reserved"],
];

function classifyV4Int(n) {
  for (const [block, reason] of V4_BLOCKS) {
    if (((n & block.mask) >>> 0) === block.base) return reason;
  }
  return "public";
}

// ── IPv6 ────────────────────────────────────────────────────────────────────

/** Parse an IPv6 literal into 8 16-bit groups. Zone ids are rejected. */
export function parseIPv6(input) {
  let str = String(input || "");
  if (str.startsWith("[") && str.endsWith("]")) str = str.slice(1, -1);
  if (str.includes("%") || !net.isIPv6(str)) return null;

  // Embedded dotted quad in the last 32 bits (::ffff:1.2.3.4, 64:ff9b::1.2.3.4):
  // peel it off as two trailing groups and parse the rest as plain hex groups.
  let tail = [];
  const lastColon = str.lastIndexOf(":");
  const last = str.slice(lastColon + 1);
  if (last.includes(".")) {
    const n = parseIPv4(last);
    if (n === null) return null;
    tail = [(n >>> 16) & 0xffff, n & 0xffff];
    str = str.slice(0, lastColon + 1);
    if (!str.endsWith("::")) str = str.slice(0, -1);
  }

  const want = 8 - tail.length;
  let groups;
  const dbl = str.indexOf("::");
  if (dbl >= 0) {
    const head = str.slice(0, dbl);
    const rest = str.slice(dbl + 2);
    const h = head ? head.split(":") : [];
    const r = rest ? rest.split(":") : [];
    const fill = want - h.length - r.length;
    if (fill < 0) return null;
    groups = [...h, ...Array(fill).fill("0"), ...r];
  } else {
    groups = str ? str.split(":") : [];
  }
  if (groups.length !== want) return null;
  const out = groups.map((g) => parseInt(g, 16));
  if (out.some((g) => !Number.isFinite(g) || g < 0 || g > 0xffff)) return null;
  return [...out, ...tail];
}

function v6(prefix, len) {
  return { groups: parseIPv6(prefix), len };
}

function v6Match(groups, block) {
  let bits = block.len;
  for (let i = 0; i < 8 && bits > 0; i++) {
    const take = Math.min(16, bits);
    const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff;
    if ((groups[i] & mask) !== (block.groups[i] & mask)) return false;
    bits -= take;
  }
  return true;
}

// Prefixes inside 2000::/3 (global unicast) that are still not routable
// destinations for us.
const V6_BLOCKS_IN_GLOBAL = [
  [v6("2001::", 23), "reserved"], // IETF protocol assignments (Teredo, ORCHID, benchmarking …)
  [v6("2001:db8::", 32), "documentation"],
  [v6("2002::", 16), "reserved"], // 6to4 — tunnels to an arbitrary IPv4
  [v6("3fff::", 20), "documentation"],
];

const V6_MAPPED = v6("::ffff:0:0", 96);
const V6_NAT64 = v6("64:ff9b::", 96);
const V6_COMPAT = v6("::", 96); // deprecated v4-compatible + :: + ::1

function classifyV6Groups(g) {
  if (v6Match(g, V6_MAPPED) || v6Match(g, V6_NAT64)) {
    const n = (((g[6] << 16) >>> 0) + g[7]) >>> 0;
    const inner = classifyV4Int(n);
    return inner === "public" ? "public" : inner;
  }
  if (g.every((x) => x === 0)) return "unspecified";
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback";
  if (v6Match(g, V6_COMPAT)) return "reserved";
  const first = g[0];
  if ((first & 0xfe00) === 0xfc00) return "private"; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return "link-local"; // fe80::/10
  if ((first & 0xffc0) === 0xfec0) return "private"; // fec0::/10 site-local (deprecated)
  if ((first & 0xff00) === 0xff00) return "multicast";
  if ((first & 0xe000) !== 0x2000) return "reserved"; // everything outside 2000::/3
  for (const [block, reason] of V6_BLOCKS_IN_GLOBAL) {
    if (v6Match(g, block)) return reason;
  }
  return "public";
}

/**
 * Classify an IP literal. Returns "public" or the blocked reason
 * ("private", "loopback", "link-local", "cgnat", "multicast", "reserved",
 * "documentation", "benchmarking", "unspecified", "invalid").
 */
export function classifyAddress(address) {
  const s = String(address || "").trim();
  const n4 = parseIPv4(s);
  if (n4 !== null) return classifyV4Int(n4);
  const g = parseIPv6(s);
  if (g) return classifyV6Groups(g);
  return "invalid";
}

export function isPublicAddress(address) {
  return classifyAddress(address) === "public";
}

// ── resolution + pinning ────────────────────────────────────────────────────

function defaultResolver(host) {
  return new Promise((resolve, reject) => {
    dns.lookup(host, { all: true, verbatim: true }, (err, addrs) => {
      if (err) reject(err);
      else resolve(addrs);
    });
  });
}

/**
 * Build a guard. Every dependency is injectable so tests can drive DNS
 * answers (rebinding) and treat a loopback test server as "public".
 */
export function createGuard({ resolver = defaultResolver, classify = classifyAddress } = {}) {
  /**
   * Resolve `host` once and vet every answer. Resolves to the vetted
   * `[{address, family}]` list; rejects with EgressBlockedError when any
   * answer is not public (or the host is a blocked literal).
   */
  async function resolvePublic(host) {
    let h = String(host || "").trim();
    if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
    if (!h) throw new EgressBlockedError("Missing host", "invalid");
    if (h.includes("%")) throw new EgressBlockedError("Scoped IPv6 addresses are not allowed", "invalid");

    const family = net.isIP(h);
    let addrs;
    if (family) {
      addrs = [{ address: h, family }];
    } else {
      try {
        addrs = await resolver(h);
      } catch (e) {
        const err = new Error(`Could not resolve ${h}: ${e.code || e.message}`);
        err.code = e.code || "ENOTFOUND";
        throw err;
      }
    }
    if (!Array.isArray(addrs) || addrs.length === 0) {
      const err = new Error(`Could not resolve ${h}`);
      err.code = "ENOTFOUND";
      throw err;
    }
    for (const a of addrs) {
      const reason = classify(a.address);
      if (reason !== "public") {
        throw new EgressBlockedError(`Blocked destination ${h} (${reason} address)`, reason);
      }
    }
    return addrs.map((a) => ({ address: a.address, family: a.family || net.isIP(a.address) }));
  }

  return { resolvePublic, classify };
}

/**
 * A `lookup` for net/http/https that only ever answers with the already
 * vetted addresses — the connect can't drift to a different DNS answer.
 */
export function pinnedLookup(vetted) {
  return function lookup(hostname, options, callback) {
    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "object" && options ? options : {};
    const list = opts.family ? vetted.filter((a) => a.family === opts.family) : vetted;
    const pick = list.length ? list : vetted;
    if (opts.all) cb(null, pick.map((a) => ({ address: a.address, family: a.family })));
    else cb(null, pick[0].address, pick[0].family);
  };
}
