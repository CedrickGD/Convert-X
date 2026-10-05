/**
 * Convert-X gateway (Cloudflare Worker) base URL.
 *
 * The app does its own networking for everything except Klipy, whose
 * page→media lookup needs a server-side API key. `discordNet.klipyResolve`
 * is the only call that touches the gateway from Android — emoji, sticker,
 * attachment, Tenor and Giphy all resolve over plain HTTPS on device.
 */
export const GATEWAY_BASE = 'https://convertx-api.rr-admin-panel.workers.dev';
