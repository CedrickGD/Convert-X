/**
 * React Native `net` implementation for the Discord media resolver
 * (discordMedia.ts). Android talks to the CDNs directly — no CORS, no
 * gateway — so this is a thin wrapper over the platform's HTTP stack.
 *
 * Byte fetches use XMLHttpRequest with responseType='arraybuffer'. In
 * RN 0.81 that is the one reliable binary path: the native side returns
 * the body as base64 and XMLHttpRequest decodes it to an ArrayBuffer via
 * the bundled base64-js (react-native/Libraries/Network/XMLHttpRequest.js
 * line ~276). `fetch(url).then(r => r.arrayBuffer())` is NOT reliable here
 * — whatwg-fetch implements Response.arrayBuffer() on top of
 * FileReader.readAsArrayBuffer over a Blob, which depends on the native
 * Blob module and fetch blob support; on a text response the bytes get
 * mangled. Text and HEAD requests use fetch (it follows redirects and
 * exposes the final URL via response.url, which the Tenor short-code
 * resolver needs).
 */

import type { Net, NetBytes, NetHead, NetKlipy, NetText } from './discordMedia';
import { GATEWAY_BASE } from './gateway';

// A desktop Chrome UA keeps picky CDNs (Tenor/Giphy edge) from serving a
// mobile or bot variant; the CORS-safe Discord/Tenor/Giphy hosts don't
// require it, but it never hurts.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const BYTES_TIMEOUT_MS = 20000;
const TEXT_TIMEOUT_MS = 15000;
// Absolute ceiling so a mislabelled giant file can't exhaust memory even
// when a caller forgets maxBytes. Sticker PNGs are the largest expected
// payload (8 MiB cap in the resolver), so 32 MiB is comfortable headroom.
const HARD_MAX_BYTES = 32 * 1024 * 1024;

function getBytes(
  url: string,
  opts?: { maxBytes?: number; headers?: Record<string, string> }
): Promise<NetBytes> {
  return new Promise<NetBytes>((resolve, reject) => {
    const cap = Math.min(opts?.maxBytes ?? HARD_MAX_BYTES, HARD_MAX_BYTES);
    let settled = false;
    let xhr: XMLHttpRequest;
    try {
      xhr = new XMLHttpRequest();
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        try {
          xhr.abort();
        } catch {
          /* ignore */
        }
        reject(new Error('Request timed out.'));
      });
    }, BYTES_TIMEOUT_MS);

    try {
      xhr.open('GET', url, true);
      xhr.responseType = 'arraybuffer';
      const headers: Record<string, string> = { 'User-Agent': BROWSER_UA, ...(opts?.headers ?? {}) };
      for (const key of Object.keys(headers)) {
        try {
          xhr.setRequestHeader(key, headers[key]);
        } catch {
          // RN rejects a few forbidden headers (e.g. User-Agent on some
          // platforms) — skip those rather than failing the whole request.
        }
      }
    } catch (e) {
      finish(() => reject(e instanceof Error ? e : new Error(String(e))));
      return;
    }

    xhr.onload = () => {
      finish(() => {
        let bytes: Uint8Array;
        const resp = xhr.response as unknown;
        if (resp instanceof ArrayBuffer) {
          const full = new Uint8Array(resp);
          bytes = full.length > cap ? full.slice(0, cap) : full;
        } else if (resp && ArrayBuffer.isView(resp as ArrayBufferView)) {
          const view = resp as ArrayBufferView;
          const full = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
          bytes = full.length > cap ? full.slice(0, cap) : full;
        } else {
          bytes = new Uint8Array(0);
        }
        resolve({
          status: xhr.status,
          contentType: xhr.getResponseHeader('content-type'),
          bytes,
          finalUrl: xhr.responseURL || url,
        });
      });
    };
    xhr.onerror = () => finish(() => reject(new Error('Network request failed.')));
    xhr.onabort = () => finish(() => reject(new Error('Request aborted.')));
    xhr.ontimeout = () => finish(() => reject(new Error('Request timed out.')));

    try {
      xhr.send();
    } catch (e) {
      finish(() => reject(e instanceof Error ? e : new Error(String(e))));
    }
  });
}

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } catch (e) {
    if (controller.signal.aborted) throw new Error('Request timed out.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function getText(url: string, opts?: { headers?: Record<string, string> }): Promise<NetText> {
  return withTimeout(TEXT_TIMEOUT_MS, async (signal) => {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(opts?.headers ?? {}),
      },
      signal,
    });
    const text = await resp.text();
    return {
      status: resp.status,
      contentType: resp.headers.get('content-type'),
      text,
      finalUrl: resp.url || url,
    };
  });
}

async function head(url: string): Promise<NetHead> {
  return withTimeout(TEXT_TIMEOUT_MS, async (signal) => {
    const resp = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': BROWSER_UA },
      signal,
    });
    return { status: resp.status, contentType: resp.headers.get('content-type') };
  });
}

async function klipyResolve(type: string, slug: string): Promise<NetKlipy> {
  const u = `${GATEWAY_BASE}/v1/resolve/klipy?type=${encodeURIComponent(type)}&slug=${encodeURIComponent(slug)}`;
  return withTimeout(TEXT_TIMEOUT_MS, async (signal) => {
    const resp = await fetch(u, {
      headers: { Accept: 'application/json' },
      signal,
    });
    let json: unknown = null;
    try {
      json = await resp.json();
    } catch {
      json = null;
    }
    return { status: resp.status, json };
  });
}

export const discordNet: Net = { getBytes, getText, head, klipyResolve };
