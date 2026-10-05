// Shared test plumbing: throwaway HTTP servers and a guard whose DNS answers
// the test controls. Loopback is "public" ONLY when a test opts in, so the
// real classifier still guards everything else.

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEgressProxy } from "../src/egressProxy.mjs";
import { classifyAddress, createGuard } from "../src/ipguard.mjs";

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

export function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), "utf8");
}

/** Start an HTTP(S) server on 127.0.0.1:0. Returns {port, close, server}. */
export async function startServer(handler, { tls = false } = {}) {
  const server = tls
    ? https.createServer({ key: fixture("test-tls.key"), cert: fixture("test-tls.crt") }, handler)
    : http.createServer(handler);
  const sockets = new Set();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    server,
    port: server.address().port,
    close: () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

/** Plain TCP server on 127.0.0.1:0. */
export async function startTcpServer(onSocket) {
  const server = net.createServer(onSocket);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: server.address().port, close: () => new Promise((r) => server.close(() => r())) };
}

/**
 * Guard with scripted DNS. `answers[host]` is a list of addresses or a
 * function (callIndex) → list. 127.0.0.1 counts as public; everything else
 * goes through the real classifier.
 */
export function testGuard(answers) {
  const calls = [];
  const resolver = async (host) => {
    const n = calls.filter((c) => c === host).length;
    calls.push(host);
    const a = answers[host];
    if (!a) {
      const e = new Error(`getaddrinfo ENOTFOUND ${host}`);
      e.code = "ENOTFOUND";
      throw e;
    }
    const list = typeof a === "function" ? a(n) : a;
    return list.map((address) => ({ address, family: net.isIP(address) }));
  };
  const classify = (a) => (a === "127.0.0.1" ? "public" : classifyAddress(a));
  return { guard: createGuard({ resolver, classify }), calls };
}

/**
 * A real egress proxy on 127.0.0.1:0 whose DNS is scripted like testGuard.
 * `allowed` / `blocked` / `authFailures` record what it let through or
 * refused, so a test can prove a request went through it.
 */
export async function startProxy(answers, { token = "", allowedPorts = [80, 443] } = {}) {
  const { guard, calls } = testGuard(answers);
  const allowed = [];
  const blocked = [];
  const authFailures = [];
  const log = {
    debug: (m, f) => m === "egress allowed" && allowed.push(f),
    info() {},
    warn: (m, f) => {
      if (m === "egress blocked") blocked.push(f);
      if (m === "egress auth failed") authFailures.push(f);
    },
    error() {},
  };
  const proxy = createEgressProxy({ guard, allowedPorts, token, log });
  const { port } = await proxy.listen(0, "127.0.0.1");
  return { proxy, port, calls, allowed, blocked, authFailures, close: () => proxy.close() };
}

/** A port nothing listens on (bound, then released). */
export async function deadPort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

export function tmpDir(prefix = "convertx-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns truthy or the timeout passes. */
export async function waitFor(fn, { timeoutMs = 10_000, everyMs = 50 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("waitFor timed out");
    await sleep(everyMs);
  }
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
