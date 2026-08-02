/**
 * Recently-probed download URLs — a small persisted MRU list so the most
 * repetitive flow (paste → find → download) can refill the field with one
 * click. Web-safe: pure localStorage, no platform adapter calls.
 */
import { loadJson, saveJson } from "./storage.js";

const KEY = "convertx.recentUrls.v1";
const MAX = 6;

export function getRecentUrls() {
  const list = loadJson(KEY, []);
  return Array.isArray(list) ? list.filter((u) => typeof u === "string") : [];
}

/** Add a URL to the front (deduped, capped). Returns the new list. */
export function addRecentUrl(url) {
  const trimmed = String(url ?? "").trim();
  if (!trimmed) return getRecentUrls();
  const list = getRecentUrls();
  const next = [trimmed, ...list.filter((u) => u !== trimmed)].slice(0, MAX);
  saveJson(KEY, next);
  return next;
}
