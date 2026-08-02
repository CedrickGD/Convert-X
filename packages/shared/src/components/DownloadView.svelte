<script>
  import { onMount, onDestroy } from "svelte";
  import { getPlatform } from "../platform.js";
  import { settingsStore, downloadOp, downloaderSettings } from "../stores/fileStore.js";
  import {
    probeUrl as routerProbeUrl,
    downloadBatch,
    cancelActiveBatch,
    isDownloading,
    getPendingBatch,
    clearPendingBatch,
    updateYtDlpDeduped,
  } from "../lib/downloadQueue.js";
  import { importCookiesText, mergePlatformCookies, resolveCookiesPath } from "../lib/cookies.js";
  import { invalidateInstagramSessionCache } from "../lib/instagramStories.js";
  import { platformByKey, LOGIN_USER_AGENT } from "../lib/loginPlatforms.js";
  import { addHistoryEntry } from "../lib/history.js";
  import { getRecentUrls, addRecentUrl } from "../lib/recentUrls.js";
  import { logError } from "../lib/errorLog.js";
  import { toast } from "../lib/feedback.js";
  import { loadJson, saveJson } from "../lib/storage.js";
  import DesktopDownload from "./DesktopDownload.svelte";

  const platform = getPlatform();
  let isDesktop = platform.platformType === "desktop"; // TEMP-DEBUG was const

  const VIDEO_FORMATS = ["mp4", "mkv", "webm", "avi", "mov"];
  const AUDIO_FORMATS = ["mp3", "m4a", "wav", "flac", "ogg", "opus"];
  const CONNECTED_PLATFORMS_KEY = "convertx.connectedPlatforms.v1";

  let url = "";
  let detectedSite = "";
  let category = "video";       // "video" | "audio"
  let format = "mp4";           // any value from VIDEO_FORMATS or AUDIO_FORMATS
  let quality = "best";
  let outputDir = "";

  // Persisted settings (Spotify credentials + the LEGACY cookies path,
  // which a one-time boot migration folds into the canonical store).
  let dlSettings = { spotifyClientId: "", spotifyClientSecret: "", cookiesPath: "" };
  let settingsOpen = false;
  downloaderSettings.subscribe((v) => { dlSettings = v; });

  function updateDlSettings(patch) {
    downloaderSettings.update((s) => ({ ...s, ...patch }));
  }

  // States: idle | probing | preview | downloading | done | error
  let state = "idle";
  let progress = 0;
  let errorMessage = "";

  let probe = null;            // router ProbeResult ({ kind, title, uploader, thumbnail, entries })
  let selected = new Set();    // entry ids selected for download
  let currentItemTitle = "";
  let totalItems = 0;
  let completedCount = 0;

  // The URL the current entries came from — the batch layer needs the REAL
  // source (not the editable field) to refresh expired CDN URLs and to
  // persist the resume descriptor. Only set for single-URL sessions.
  let probedSourceUrl = null;

  // Finished-batch state. doneResults accumulates successes ACROSS a
  // retry-failed rerun so prior successes stay listed.
  let doneInfo = null;         // { completed, total, errors: [{id,title,message}] }
  let doneResults = [];        // [{ id, title, outputPath }]

  // Per-URL probe failures for multi-URL input — ALL of them, not just the
  // first, so a 5-URL paste with 2 dead links names both.
  let probeFailures = [];      // [{ url, message }]

  let recent = [];             // recent-URL MRU chips (F1)
  let pendingResume = null;    // interrupted-batch descriptor (F7)

  let engineUpdating = false;
  let loginBusy = false;
  let cookiesBusy = false;
  let hasCanonicalCookies = false;

  // Progress bookkeeping. The shared batch runner reports a mean pct over
  // its own items; the Spotify lane (short-circuited BEFORE the router)
  // tracks per-item pcts from download-progress events keyed by file_id.
  let batchMeanPct = 0;
  let batchTotal = 0;
  let batchCompleted = 0;
  let spotPct = [];
  let spotCompleted = 0;
  let spotifySlotByFileId = new Map();
  let spotifyCancelRequested = false;
  let downloadActive = false;

  let unlistenProgress = null;

  function updateOverall() {
    if (totalItems <= 0) return;
    const spotSum = spotPct.reduce((a, b) => a + (b || 0), 0);
    progress = Math.min(100, Math.round((batchMeanPct * batchTotal + spotSum) / totalItems));
    completedCount = batchCompleted + spotCompleted;
  }

  // Proxied thumbnail blob URLs keyed by entry id. CDN-hotlink-blocked images
  // (Instagram especially) won't load from a remote <img src>, so we fetch via
  // a Tauri command and turn the bytes into a blob URL.
  let thumbBlobs = {}; // record { [entryId]: blobUrl }

  function clearThumbBlobs() {
    for (const k of Object.keys(thumbBlobs)) {
      try { URL.revokeObjectURL(thumbBlobs[k]); } catch {}
    }
    thumbBlobs = {};
  }

  async function loadThumbnails(list) {
    // Fire all fetches in parallel, ignore failures — placeholder will show.
    await Promise.all(list.map(async (e) => {
      const thumbUrl = e.thumbnail;
      if (!thumbUrl) return;
      try {
        const bytes = await platform.fetchRemoteImage(thumbUrl);
        const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        const blob = new Blob([buf], { type: "image/jpeg" });
        thumbBlobs = { ...thumbBlobs, [e.id]: URL.createObjectURL(blob) };
      } catch (_) {
        // Leave entry without a thumb — UI shows placeholder.
      }
    }));
  }

  settingsStore.subscribe((s) => {
    outputDir = s.outputDir || "";
  });

  async function refreshCookiesStatus() {
    try {
      hasCanonicalCookies = !!(await resolveCookiesPath());
    } catch {
      hasCanonicalCookies = false;
    }
  }

  onMount(() => {
    if (typeof platform.onDownloadProgress === "function") {
      unlistenProgress = platform.onDownloadProgress((payload) => {
        // Spotify-lane items only — the shared batch runner tracks its own
        // per-item progress and reports via onProgress.
        const slot = spotifySlotByFileId.get(payload?.file_id);
        if (slot === undefined) return;
        const pct = typeof payload.progress === "number" ? payload.progress : -1;
        // -1 = unknown length — don't knock the bar backwards.
        if (pct >= 0) {
          spotPct[slot] = Math.min(100, Math.round(pct));
          updateOverall();
        }
      });
    }
    // TEMP-DEBUG ── layout harness (?dbg=<state>). Remove before commit.
    {
      const q = new URLSearchParams(location.search);
      if (q.has("dbg")) {
        isDesktop = q.get("web") !== "1";
        const n = parseInt(q.get("n") || "9", 10);
        const list = Array.from({ length: n }, (_, i) => ({
          id: "dbg" + i,
          title: "Sample media item " + (i + 1) + " with a fairly long descriptive title",
          url: "https://example.com/" + i,
          sourceUrl: "https://example.com/" + i,
          mediaType: i % 4 === 0 ? "image" : i % 5 === 0 ? "audio" : "video",
          thumbnail: null,
          directUrl: null,
          variants: null,
          duration: 31 + i * 47,
          uploader: "Example Channel",
          partialCarousel: false,
        }));
        const st = q.get("dbg");
        url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
        recent = [
          "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
          "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
          "https://www.instagram.com/p/Cabcdefghij/",
          "https://x.com/someone/status/1234567890",
        ];
        if (st === "idle") url = "";
        if (st === "resume") {
          url = "";
          pendingResume = { sourceUrl: "https://example.com/x", remainingIds: ["a", "b"], items: ["a", "b", "c", "d", "e"] };
        }
        if (st === "error") {
          state = "error";
          errorMessage = "ERROR: [Instagram] Cabcdefghij: Requested content is not available, login required. Use --cookies-from-browser or --cookies for the authentication.";
        }
        if (st === "probing") state = "probing";
        if (st === "preview" || st === "single") {
          const entriesList = st === "single" ? list.slice(0, 1) : list;
          probe = {
            kind: st === "single" ? "single" : "multi",
            title: "Example post — a reasonably long playlist or carousel title",
            uploader: "Example Channel",
            thumbnail: null,
            entries: entriesList,
          };
          selected = new Set(entriesList.map((e) => e.id));
          state = "preview";
        }
        if (st === "downloading") {
          state = "downloading";
          progress = 42;
          totalItems = 9;
          completedCount = 3;
          currentItemTitle = "Sample media item 4 with a fairly long descriptive title";
        }
        if (st === "done") {
          probe = { kind: "multi", title: "Example post", uploader: "Example Channel", thumbnail: null, entries: list };
          doneResults = list.slice(0, 7).map((e) => ({ id: e.id, title: e.title, outputPath: "C:/Users/me/Downloads/" + e.id + ".mp4" }));
          doneInfo = {
            completed: 7,
            total: 9,
            errors: [
              { id: "dbg7", title: "Sample media item 8", message: "HTTP Error 403: Forbidden" },
              { id: "dbg8", title: "Sample media item 9", message: "Video unavailable in your country" },
            ],
          };
          state = "done";
        }
        return;
      }
    }
    // TEMP-DEBUG end
    recent = getRecentUrls();
    if (isDesktop) {
      const p = getPendingBatch();
      if (p && Array.isArray(p.remainingIds) && p.remainingIds.length > 0) pendingResume = p;
      // The legacy cookies-path migration runs once at app boot (App.svelte);
      // here we only reflect the canonical store's current state.
      refreshCookiesStatus();
    }
  });

  onDestroy(() => {
    if (typeof unlistenProgress === "function") unlistenProgress();
  });

  // Site detection — used for the chip and for switching the format default
  // (Spotify is always audio-only).
  const SITE_PATTERNS = [
    { match: /open\.spotify\.com|^spotify:/i, name: "Spotify", audioOnly: true },
    { match: /youtube\.com|youtu\.be/i, name: "YouTube" },
    { match: /(twitter\.com|x\.com)/i, name: "X / Twitter" },
    { match: /instagram\.com/i, name: "Instagram" },
    { match: /snapchat\.com/i, name: "Snapchat" },
    { match: /tiktok\.com/i, name: "TikTok" },
    { match: /reddit\.com/i, name: "Reddit" },
    { match: /vimeo\.com/i, name: "Vimeo" },
    { match: /facebook\.com|fb\.watch/i, name: "Facebook" },
    { match: /soundcloud\.com/i, name: "SoundCloud", audioOnly: true },
    { match: /twitch\.tv/i, name: "Twitch" },
    { match: /pornhub\.com|phncdn\.com/i, name: "Pornhub" },
    { match: /xvideos\.com/i, name: "XVideos" },
    { match: /xhamster\.com/i, name: "xHamster" },
    { match: /redgifs\.com/i, name: "RedGIFs" },
    { match: /streamable\.com/i, name: "Streamable" },
    { match: /dailymotion\.com/i, name: "Dailymotion" },
    { match: /bilibili\.com/i, name: "Bilibili" },
    { match: /(cdn\.discordapp\.com|media\.discordapp\.net)/i, name: "Discord CDN" },
  ];

  $: detectedHit = url.trim() ? SITE_PATTERNS.find((p) => p.match.test(url)) : null;
  $: detectedSite = !url.trim() ? "" : (detectedHit?.name || "Unknown source");
  $: isSpotify = detectedHit?.name === "Spotify";
  // Audio-only is a property of EVERY pasted URL, not of the first pattern
  // that matches the textarea: a Spotify link next to a YouTube link must
  // not strip the video off the YouTube one. (Identical to the old
  // whole-field test for the single-URL case.)
  $: audioForced =
    validUrls.length > 0 &&
    validUrls.every((u) => !!SITE_PATTERNS.find((p) => p.match.test(u))?.audioOnly);
  $: if (audioForced && format !== "mp3") format = "mp3";

  // Parse multi-URL input: one URL per line, blanks ignored.
  $: urlList = url.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  $: validUrls = urlList.filter((u) => /^https?:\/\//i.test(u) || /^spotify:/i.test(u));
  $: isValidUrl = validUrls.length > 0;
  // "error" is retryable, not terminal: the one-tap fixes below (Instagram
  // login, engine update) are worthless if the user can't re-probe after
  // applying them. handlePreview resets every probe-derived field itself.
  $: canPreview = isDesktop && isValidUrl && (state === "idle" || state === "error");
  $: multiUrlInput = urlList.length > 1;

  // Preview-derived flags
  $: entries = probe?.entries || [];
  $: isMulti = entries.length > 1;
  $: selectedCount = selected.size;
  $: selectedEntries = entries.filter((e) => selected.has(e.id));
  $: partialCarousel = entries.some((e) => e.partialCarousel);

  // Adaptive options derive from the SELECTION (falling back to all
  // entries): a photo-only pick must never offer a video/audio choice, and
  // an audio-only source must never offer a quality ladder (F3).
  $: selectionForKinds = selectedEntries.length > 0 ? selectedEntries : entries;
  $: hasVideo = selectionForKinds.some((e) => (e.mediaType ?? "video") === "video");
  $: hasAudioSource = selectionForKinds.some((e) => e.mediaType === "audio");
  $: allImages =
    selectionForKinds.length > 0 && selectionForKinds.every((e) => e.mediaType === "image");
  $: anyImages = selectionForKinds.some((e) => e.mediaType === "image");
  // Drives the Spotify-flavoured CTA. Selection-based, not URL-based, so a
  // mixed paste labels the button generically.
  $: allSpotify = selectionForKinds.length > 0 && selectionForKinds.every((e) => e.spotify);
  // Photos are "saved", media is "downloaded".
  $: actionVerb = allImages ? "Save" : "Download";

  // Force audio category for Spotify/SoundCloud and for audio-only picks.
  $: if (audioForced && category !== "audio") category = "audio";
  $: if (state === "preview" && !hasVideo && hasAudioSource && category !== "audio")
    category = "audio";
  // Keep `format` in sync with the chosen category.
  $: if (category === "video" && !VIDEO_FORMATS.includes(format)) format = "mp4";
  $: if (category === "audio" && !AUDIO_FORMATS.includes(format)) format = "mp3";

  $: probeFailureText = probeFailures
    .map((f) => (validUrls.length > 1 || probeFailures.length > 1 ? `${f.url} — ${f.message}` : f.message))
    .join("\n");

  // Route the two recoverable failures to their in-app fixes (F8).
  $: needsLogin =
    state === "error" &&
    !!errorMessage &&
    isDesktop &&
    typeof platform.openLoginWindow === "function" &&
    (detectedSite === "Instagram" || /instagram/i.test(errorMessage)) &&
    /login required|require login|cookies|empty media response|restricted|private|rate.?limit/i.test(
      errorMessage
    );
  $: suggestsEngineUpdate =
    state === "error" &&
    !!errorMessage &&
    isDesktop &&
    typeof platform.updateYtdlp === "function" &&
    /yt-dlp -U|latest version|unsupported url|confirm you are on/i.test(errorMessage);

  async function pickOutputDir() {
    try {
      const dir = await platform.pickFolder?.();
      if (dir) {
        outputDir = dir;
        settingsStore.update((s) => ({ ...s, outputDir: dir }));
      }
    } catch (_) {}
  }

  /** Strip scheme/www and truncate for a compact recent-URL chip. */
  function shortUrl(u) {
    return u.replace(/^https?:\/\/(www\.)?/, "").slice(0, 26);
  }

  function isSpotifyUrl(u) {
    return /open\.spotify\.com|^spotify:/i.test(u);
  }

  /** Pull { kind, id } out of any Spotify reference: web links with locale
   *  prefixes (/intl-de/) and query strings (?si=…), and spotify: URIs.
   *  Returns null for anything unrecognised. */
  function parseSpotifyRef(u) {
    const s = String(u ?? "").trim();
    let m = s.match(/^spotify:(track|album|playlist):([A-Za-z0-9]+)/i);
    if (!m) {
      // The id charset stops at "?" / "/", so query strings need no stripping.
      m = s.match(
        /open\.spotify\.com\/(?:intl-[A-Za-z-]+\/)?(track|album|playlist)\/([A-Za-z0-9]+)/i
      );
    }
    return m ? { kind: m[1].toLowerCase(), id: m[2] } : null;
  }

  /** Shape the Rust Spotify probe into DownloadEntry-shaped objects. Spotify
   *  never touches the shared router — spotdl handles the download, so these
   *  entries are tagged for the spotdl lane.
   *
   *  Rust enumerates real tracks (Spotify Web API → spotdl metadata → the
   *  legacy single stub as a last resort). Each entry carries its OWN
   *  https://open.spotify.com/track/<id> url, which is what buys per-track
   *  progress, one history row per track, and per-item cancel. */
  function entriesFromSpotifyProbe(raw, sourceUrl) {
    const rawEntries = Array.isArray(raw?.entries) ? raw.entries : [];
    const srcRef = parseSpotifyRef(sourceUrl);
    const out = [];
    const seenIds = new Set();
    rawEntries.forEach((e, i) => {
      const idx = typeof e?.index === "number" ? e.index : i + 1;
      const ownUrl = e?.url || e?.webpage_url || null;
      const trackUrl = ownUrl || sourceUrl;
      const ref = parseSpotifyRef(trackUrl);
      // Ids drive selection, retry-failed and dedupe — derive them from the
      // track URL, NEVER from the array position.
      const id =
        ref?.kind === "track" && ref.id
          ? `spotify:${ref.id}`
          : `spotify:${srcRef?.id ?? sourceUrl}#${idx}`;
      // A playlist may list the same track twice; the keyed {#each} would
      // blow up and the track would download twice.
      if (seenIds.has(id)) return;
      seenIds.add(id);
      out.push({
        id,
        title: e?.title || raw?.title || "Spotify track",
        url: trackUrl,
        // Each track downloads via its own url. Only the degraded case where
        // the probe gave no per-track urls still needs --playlist-items to
        // pick a track out of the source link.
        sourceUrl: trackUrl,
        playlistIndex: !ownUrl && rawEntries.length > 1 ? idx : null,
        mediaType: "audio",
        thumbnail: e?.thumbnail ?? raw?.thumbnail ?? null,
        directUrl: null,
        variants: null,
        duration: typeof e?.duration === "number" ? e.duration : null,
        uploader: raw?.uploader ?? null,
        partialCarousel: false,
        spotify: true,
      });
    });
    return out;
  }

  /** Probe one URL: Spotify short-circuits BEFORE the shared router;
   *  everything else goes through it (Twitter/IG probers → yt-dlp). */
  async function probeOne(u) {
    if (isSpotifyUrl(u)) {
      // Credentials are optional — Rust degrades to spotdl enumeration and
      // then to the stub entry, so a blank pair is never an error.
      const raw = await platform.probeUrl(u, {
        spotifyClientId: dlSettings.spotifyClientId || null,
        spotifyClientSecret: dlSettings.spotifyClientSecret || null,
      });
      const list = entriesFromSpotifyProbe(raw, u);
      return {
        kind: list.length > 1 ? "multi" : "single",
        title: raw?.title ?? "Spotify",
        uploader: raw?.uploader ?? null,
        thumbnail: raw?.thumbnail ?? null,
        entries: list,
      };
    }
    return routerProbeUrl(u);
  }

  async function handlePreview() {
    if (!canPreview) return;
    state = "probing";
    errorMessage = "";
    probe = null;
    probedSourceUrl = null;
    selected = new Set();
    probeFailures = [];
    doneInfo = null;
    doneResults = [];

    clearThumbBlobs();
    const settled = await Promise.allSettled(
      validUrls.map((u) => probeOne(u).then((r) => ({ u, r })))
    );

    const flat = [];
    const failures = [];
    const preselect = new Set();
    // Entry ids are canonicalised, so two pasted variants of the same link
    // (…/p/ABC/?igsh=… vs …/p/ABC/, or /p/ABC vs /reel/ABC) resolve to the
    // SAME id. Duplicates would blow up the keyed {#each} and download the
    // item twice, so aggregate on first-seen id.
    const seenIds = new Set();
    let okCount = 0;
    let firstResult = null;
    settled.forEach((s, i) => {
      const u = validUrls[i];
      if (s.status === "fulfilled") {
        okCount += 1;
        if (!firstResult) firstResult = s.value.r;
        const list = (s.value.r.entries || []).filter((e) => {
          if (seenIds.has(e.id)) return false;
          seenIds.add(e.id);
          return true;
        });
        flat.push(...list);
        addRecentUrl(u); // F1: a successful probe remembers the URL
        // F2: "?img_index=N" targets one carousel item — default the
        // selection to JUST that item; "Select all" promotes to the post.
        // Instagram's img_index is 1-based ("?img_index=1" = first item).
        const hint = u.match(/[?&]img_index=(\d+)/);
        const hintIdx = hint ? parseInt(hint[1], 10) - 1 : -1;
        if (hintIdx >= 0 && hintIdx < list.length) {
          preselect.add(list[hintIdx].id);
        } else {
          for (const e of list) preselect.add(e.id);
        }
      } else {
        // Surface EVERY failed URL, and leave a diagnostic trail per URL.
        failures.push({ url: u, message: `${s.reason?.message || s.reason}` });
        logError("probe", s.reason, u);
      }
    });
    recent = getRecentUrls();
    probeFailures = failures;

    if (flat.length === 0) {
      errorMessage =
        failures.length > 0
          ? failures
              .map((f) => (validUrls.length > 1 ? `${f.url} — ${f.message}` : f.message))
              .join("\n")
          : "Nothing found at that URL.";
      state = "error";
      return;
    }

    if (validUrls.length === 1 && okCount === 1) {
      // `flat` is firstResult.entries minus duplicate ids — the grid is
      // keyed by id, so it must never see the raw list.
      probe = { ...firstResult, entries: flat };
      probedSourceUrl = validUrls[0];
    } else {
      // Multi-URL: aggregate entries into one synthetic multi ProbeResult
      // so the grid UI just works. No single sourceUrl → no resume
      // descriptor for this batch.
      probe = {
        kind: "multi",
        title: `${okCount} URL${okCount !== 1 ? "s" : ""} · ${flat.length} item${flat.length !== 1 ? "s" : ""}`,
        uploader: null,
        thumbnail: null,
        entries: flat,
      };
    }
    selected = preselect;
    loadThumbnails(flat); // background fetch, doesn't block transition
    state = "preview";
  }

  function backToIdle() {
    state = "idle";
    probe = null;
    probedSourceUrl = null;
    selected = new Set();
    progress = 0;
    errorMessage = "";
    probeFailures = [];
    doneInfo = null;
    doneResults = [];
    clearThumbBlobs();
    downloadOp.set("idle");
  }

  function toggleEntry(id) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selected = next;
  }

  function selectAll() {
    selected = new Set(entries.map((e) => e.id));
  }

  function clearSelection() {
    selected = new Set();
  }

  function formatDuration(secs) {
    if (!secs || !isFinite(secs)) return "";
    const s = Math.round(secs);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, "0")}`;
  }

  /** Sequential spotdl lane for Spotify entries. Mirrors the batch runner's
   *  result shape so the done view is uniform. Cancel is typed — a killed
   *  spotdl resolves { status: 'cancelled' }, never an error. */
  async function runSpotifyLane(items, opts) {
    const results = [];
    const errors = [];
    const laneId = `sp-${Date.now().toString(36)}`;
    const spotFormat = AUDIO_FORMATS.includes(String(opts.format ?? "").toLowerCase())
      ? opts.format
      : "mp3";
    // Keep-awake for pure-Spotify batches; when the shared runner is also
    // active it manages the flag itself.
    const soloLane = batchTotal === 0;
    const keepAwake = (on) => {
      try {
        const r = platform.setKeepAwake?.(on);
        if (r && typeof r.catch === "function") r.catch(() => {});
      } catch {}
    };
    if (soloLane) keepAwake(true);
    try {
      for (let i = 0; i < items.length; i += 1) {
        if (spotifyCancelRequested) return { results, errors, cancelled: true };
        const entry = items[i];
        currentItemTitle = entry.title;
        const fid = `${laneId}-${i}`;
        spotifySlotByFileId.set(fid, i);
        // Each track has its OWN /track/<id> url, so this is one spotdl
        // invocation per track — real per-item progress and cancel.
        const trackUrl = entry.url || entry.sourceUrl;
        try {
          const r = await platform.downloadFromUrl({
            fileId: fid,
            url: trackUrl,
            format: spotFormat,
            quality: opts.quality || "best",
            outputDir: outputDir || null,
            playlistItems: entry.playlistIndex != null ? String(entry.playlistIndex) : null,
            spotifyClientId: dlSettings.spotifyClientId || null,
            spotifyClientSecret: dlSettings.spotifyClientSecret || null,
          });
          if (r?.status === "cancelled") return { results, errors, cancelled: true };
          spotPct[i] = 100;
          spotCompleted += 1;
          const outputPath = r?.outputPath ?? null;
          const title = r?.title || entry.title;
          results.push({ id: entry.id, title, outputPath });
          if (outputPath) {
            // One history row per track, keyed by the stable track id.
            addHistoryEntry({
              id: entry.id,
              title,
              outputPath,
              sourceUrl: trackUrl,
              mediaType: "audio",
            });
          }
        } catch (e) {
          // Count the failed slot as complete so the bar can reach 100%.
          spotPct[i] = 100;
          logError("download", e, entry.title);
          errors.push({
            id: entry.id,
            title: entry.title,
            message: e instanceof Error ? e.message : String(e),
          });
        }
        updateOverall();
      }
      return { results, errors, cancelled: false };
    } finally {
      if (soloLane) keepAwake(false);
    }
  }

  /** Run a batch of entries: shared two-lane runner for router entries,
   *  spotdl lane for Spotify entries. `settingsOverride` lets a resumed
   *  batch run with the settings it was STARTED with; `retainResults`
   *  keeps prior successes listed across a retry-failed rerun (D6). */
  async function runDownload(toDownload, settingsOverride = null, retainResults = false) {
    if (toDownload.length === 0) return;
    // Cancel flips the view back while the native process is still dying —
    // this guard stops a quick re-click starting a second concurrent batch.
    if (isDownloading() || downloadActive) return;
    pendingResume = null;

    const audioOnly = settingsOverride ? settingsOverride.audioOnly : category === "audio";
    const dlFormat = settingsOverride ? settingsOverride.format : format;
    const dlQuality = settingsOverride ? settingsOverride.quality : quality;

    const priorSuccess = retainResults ? doneResults.length : 0;
    if (!retainResults) doneResults = [];
    errorMessage = "";
    doneInfo = null;
    state = "downloading";
    downloadOp.set("downloading");
    totalItems = toDownload.length;
    completedCount = 0;
    progress = 0;
    currentItemTitle = toDownload[0]?.title ?? "";

    const spotItems = toDownload.filter((e) => e.spotify);
    const batchItems = toDownload.filter((e) => !e.spotify);
    batchMeanPct = 0;
    batchTotal = batchItems.length;
    batchCompleted = 0;
    spotPct = new Array(spotItems.length).fill(0);
    spotCompleted = 0;
    spotifySlotByFileId = new Map();
    spotifyCancelRequested = false;
    downloadActive = true;

    try {
      let batchResult = { results: [], errors: [], cancelled: false };
      let spotResult = { results: [], errors: [], cancelled: false };

      await Promise.all([
        (async () => {
          if (batchItems.length === 0) return;
          batchResult = await downloadBatch({
            entries: batchItems,
            audioOnly,
            format: dlFormat,
            quality: dlQuality,
            outputDir: outputDir || null,
            sourceUrl: probedSourceUrl || undefined,
            onProgress: ({ overallPct, completed, currentTitle: t }) => {
              batchMeanPct = overallPct;
              batchCompleted = completed;
              if (t) currentItemTitle = t;
              updateOverall();
            },
            onItemDone: (entry, r) => {
              if (r?.outputPath) {
                addHistoryEntry({
                  id: entry.id,
                  title: entry.title,
                  outputPath: r.outputPath,
                  sourceUrl: entry.sourceUrl ?? null,
                  mediaType: entry.mediaType ?? null,
                });
              }
            },
          });
        })(),
        (async () => {
          if (spotItems.length === 0) return;
          spotResult = await runSpotifyLane(spotItems, { format: dlFormat, quality: dlQuality });
        })(),
      ]);

      const cancelled = batchResult.cancelled || spotResult.cancelled;
      doneResults = [...doneResults, ...batchResult.results, ...spotResult.results];

      if (cancelled) {
        // A cancel is NEVER an error — back to the preview, selection intact.
        state = probe ? "preview" : "idle";
        progress = 0;
        downloadOp.set("idle");
        return;
      }

      doneInfo = {
        completed: doneResults.length,
        total: priorSuccess + toDownload.length,
        errors: [...batchResult.errors, ...spotResult.errors],
      };
      state = "done";
      progress = 100;
      downloadOp.set("done");
    } catch (err) {
      logError("download", err, probedSourceUrl ?? undefined);
      errorMessage = `${err?.message || err}`;
      state = "error";
      downloadOp.set("idle");
    } finally {
      downloadActive = false;
    }
  }

  function handleDownload() {
    if (state !== "preview" || selectedCount === 0) return;
    runDownload(selectedEntries);
  }

  // Re-run only the items that failed last time, preserving prior
  // successes. Match on entry id — carousel children share one title, so a
  // title match would re-download every succeeded sibling (D6).
  function handleRetryFailed() {
    const failedIds = new Set((doneInfo?.errors ?? []).map((e) => e.id));
    const failed = entries.filter((e) => failedIds.has(e.id));
    if (failed.length > 0) runDownload(failed, null, true);
  }

  // Resume a batch a killed app left behind: re-probe the source (direct
  // CDN URLs are long stale), then download only what never finished, with
  // the PERSISTED batch options (F7).
  async function handleResume() {
    const p = pendingResume;
    if (!p) return;
    pendingResume = null;
    url = p.sourceUrl;
    state = "probing";
    errorMessage = "";
    try {
      const result = await probeOne(p.sourceUrl);
      probedSourceUrl = p.sourceUrl;
      const remaining = new Set(p.remainingIds);
      const toDownload = result.entries.filter((e) => remaining.has(e.id));
      if (toDownload.length === 0) {
        clearPendingBatch();
        toast("Nothing left to resume — the interrupted items are no longer available.", "info");
        state = "idle";
        return;
      }
      probe = result;
      selected = new Set(toDownload.map((e) => e.id));
      clearThumbBlobs();
      loadThumbnails(result.entries);
      await runDownload(toDownload, {
        audioOnly: p.audioOnly,
        format: p.format,
        quality: p.quality,
      });
    } catch (e) {
      logError("probe", e, p.sourceUrl);
      errorMessage = `${e?.message || e}`;
      state = "error";
    }
  }

  function handleDismissResume() {
    pendingResume = null;
    clearPendingBatch();
  }

  function handleCancel() {
    // Flags both lanes AND kills every in-flight native transfer. Typed
    // { status: 'cancelled' } results unwind cleanly — no error banner.
    spotifyCancelRequested = true;
    cancelActiveBatch();
  }

  function handleReset() {
    url = "";
    backToIdle();
  }

  // One-tap fix: open the Instagram login window, merge harvested cookies
  // into the canonical store, invalidate the session cache (F8).
  async function handleLoginInstagram() {
    if (loginBusy) return;
    const reg = platformByKey("instagram");
    if (!reg || typeof platform.openLoginWindow !== "function") return;
    loginBusy = true;
    try {
      const res = await platform.openLoginWindow({
        platformKey: reg.key,
        loginUrl: reg.loginUrl,
        cookieOrigins: [reg.cookieOrigin],
        requiredCookies: reg.requiredCookies,
        userAgent: LOGIN_USER_AGENT,
      });
      if (res?.status === "ok") {
        await mergePlatformCookies(reg.cookieDomain, res.cookies ?? []);
        invalidateInstagramSessionCache();
        const stored = loadJson(CONNECTED_PLATFORMS_KEY, []);
        const list = Array.isArray(stored) ? stored : [];
        if (!list.includes("instagram")) saveJson(CONNECTED_PLATFORMS_KEY, [...list, "instagram"]);
        await refreshCookiesStatus();
        toast("Instagram connected — hit Preview to retry.", "success");
      }
    } catch (e) {
      logError("error", e, "instagram login");
      toast(e instanceof Error ? e.message : "Login failed.", "error");
    } finally {
      loginBusy = false;
    }
  }

  // One-tap fix: update the yt-dlp engine (extractor rot) (F8).
  async function handleEngineUpdate() {
    if (engineUpdating) return;
    engineUpdating = true;
    try {
      const result = await updateYtDlpDeduped();
      if (result.ok) {
        const version = result.version ? ` (${result.version})` : "";
        toast(
          result.status === "ALREADY_UP_TO_DATE"
            ? `Engine already up to date${version}`
            : `Engine updated${version} — hit Preview to retry`,
          result.status === "ALREADY_UP_TO_DATE" ? "info" : "success"
        );
      } else {
        toast(result.error ?? "Could not update the download engine.", "error");
      }
    } finally {
      engineUpdating = false;
    }
  }

  // Advanced-field cookies import: replaces the canonical store with a
  // user-exported cookies.txt (the manual escape hatch when in-app login
  // is refused — e.g. Google).
  async function handleImportCookies() {
    if (cookiesBusy) return;
    cookiesBusy = true;
    try {
      const picked = await platform.pickFiles?.({
        multiple: false,
        extensions: ["txt"],
        filterName: "cookies.txt",
      });
      const path = picked && picked[0]?.path;
      if (!path) return;
      const bytes = await platform.readFileBinary(path);
      const text = new TextDecoder().decode(
        bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
      );
      if (!text.trim()) {
        toast("That file is empty.", "error");
        return;
      }
      await importCookiesText(text);
      // A whole-file import replaces every platform's login state — the
      // per-platform "Connected" chips can no longer be trusted.
      saveJson(CONNECTED_PLATFORMS_KEY, []);
      invalidateInstagramSessionCache();
      await refreshCookiesStatus();
      toast("Cookies imported.", "success");
    } catch (e) {
      logError("error", e, "cookies import");
      toast(e instanceof Error ? e.message : "Could not import cookies.", "error");
    } finally {
      cookiesBusy = false;
    }
  }

  async function handleOpenFile(path) {
    if (path) {
      try { await platform.openFile?.(path); } catch (_) {}
    }
  }

  async function handleOpenFolder(path) {
    if (path) {
      try { await platform.openInFolder?.(path); } catch (_) {}
    }
  }
</script>

<!-- `vcenter`: the short states (entry, error, probing, downloading, results)
     sit in the middle of a tall window instead of clinging to the navbar with
     half a screen of void underneath. Preview is excluded — it is the one
     state that reliably overflows. `safe center` degrades to top-alignment
     the moment content is taller than the viewport, so nothing scrolls out
     of reach. -->
<div class="download-view" class:web={!isDesktop}>
  <div class="hero">
    <div class="icon">
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    </div>
    <h2>Download from URL</h2>
    <p class="sub">YouTube, Spotify, X, Instagram, TikTok, Snapchat, Reddit, Vimeo, Facebook, SoundCloud, Twitch — and 1800+ more sites.</p>
  </div>

  {#if state === "idle" || state === "error"}
  <!-- Wide layout: URL entry on the left, output/advanced options on the
       right. Below the split breakpoint the wrappers collapse to the same
       single flow the narrow desktop window and mobile always had. -->
  <div class="pane split entry-pane">
    {#if isDesktop && pendingResume && state === "idle"}
      <div class="resume-card pane-full">
        <div class="resume-label">Interrupted download</div>
        <p class="resume-text">
          {pendingResume.remainingIds.length} of {pendingResume.items.length} items never finished.
          Resume where it left off?
        </p>
        <div class="resume-actions">
          <button class="btn ghost small" on:click={handleDismissResume}>Dismiss</button>
          <button class="btn primary" on:click={handleResume}>Resume</button>
        </div>
      </div>
    {/if}

    <div class="pane-main">
    <div class="url-box" class:multi={multiUrlInput}>
      <textarea
        class="url-input"
        class:multi={multiUrlInput}
        placeholder="Paste a link — one per line for several"
        bind:value={url}
        rows={multiUrlInput ? Math.min(8, urlList.length + 1) : 1}
        autocomplete="off"
        spellcheck="false"
      ></textarea>
      {#if detectedSite && !multiUrlInput}
        <span class="site-chip" class:unknown={detectedSite === "Unknown source"} class:spotify={isSpotify}>
          {detectedSite}
        </span>
      {:else if multiUrlInput}
        <span class="site-chip multi-chip">{validUrls.length} URLs</span>
      {/if}
    </div>

    {#if isDesktop && recent.length > 0 && !url.trim()}
      <div class="recent-row">
        {#each recent as u (u)}
          <button type="button" class="recent-chip" title={u} on:click={() => (url = u)}>
            {shortUrl(u)}
          </button>
        {/each}
      </div>
    {/if}

    {#if state === "error"}
      <div class="error">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span class="prewrap">{errorMessage}</span>
      </div>
      {#if needsLogin || suggestsEngineUpdate}
        <div class="actions error-fixes">
          {#if needsLogin}
            <button class="btn primary" disabled={loginBusy} on:click={handleLoginInstagram}>
              {loginBusy ? "Waiting for login…" : "Log in to Instagram"}
            </button>
          {/if}
          {#if suggestsEngineUpdate}
            <button class="btn primary" disabled={engineUpdating} on:click={handleEngineUpdate}>
              {engineUpdating ? "Updating…" : "Update download engine"}
            </button>
          {/if}
        </div>
      {/if}
    {/if}

    {#if isDesktop}
      <div class="actions">
        <button class="btn primary" disabled={!canPreview} on:click={handlePreview}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          Preview
        </button>
      </div>
    {/if}
    </div><!-- /.pane-main -->

    {#if isDesktop}
      <div class="pane-side">
      <div class="options compact">
        <div class="field">
          <span class="field-label">Save to</span>
          <div class="dir-row">
            <input
              type="text"
              class="dir-input"
              placeholder="Downloads folder"
              bind:value={outputDir}
              readonly
              on:click={pickOutputDir}
            />
            <button class="btn ghost small" on:click={pickOutputDir}>Choose…</button>
          </div>
        </div>
      </div>

      <!-- Optional Settings panel: Spotify creds + cookies import -->
      <button
        class="settings-toggle"
        on:click={() => {
          settingsOpen = !settingsOpen;
          // Re-check on open: the boot migration may have populated the
          // canonical store after this view first mounted.
          if (settingsOpen && isDesktop) refreshCookiesStatus();
        }}
        type="button"
      >
        <svg class="chevron" class:open={settingsOpen} width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><polyline points="9 18 15 12 9 6"/></svg>
        Advanced settings (Spotify credentials, cookies)
        {#if dlSettings.spotifyClientId || hasCanonicalCookies}
          <span class="settings-tag">Configured</span>
        {/if}
      </button>
      {#if settingsOpen}
        <div class="settings-panel">
          <div class="settings-section">
            <div class="settings-title">Spotify API credentials</div>
            <p class="settings-help">
              Bypasses spotdl's shared API quota (which is rate-limited globally for everyone).
              Free, 5 minutes:
              <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener noreferrer">developer.spotify.com/dashboard</a>
              → Create app → copy Client ID + Secret.
            </p>
            <div class="settings-field">
              <label for="sp-id">Client ID</label>
              <input
                id="sp-id"
                type="text"
                class="settings-input"
                placeholder="32-char hex"
                value={dlSettings.spotifyClientId}
                on:input={(e) => updateDlSettings({ spotifyClientId: e.target.value.trim() })}
                spellcheck="false"
                autocomplete="off"
              />
            </div>
            <div class="settings-field">
              <label for="sp-secret">Client Secret</label>
              <input
                id="sp-secret"
                type="password"
                class="settings-input"
                placeholder="32-char hex"
                value={dlSettings.spotifyClientSecret}
                on:input={(e) => updateDlSettings({ spotifyClientSecret: e.target.value.trim() })}
                spellcheck="false"
                autocomplete="off"
              />
            </div>
          </div>

          <div class="settings-section">
            <div class="settings-title">Cookies (logins)</div>
            <p class="settings-help">
              Netscape-format cookies.txt exported from a logged-in browser session.
              Unlocks private Instagram posts, age-restricted YouTube, paywalled stuff you have access to.
              Importing replaces the app's shared cookie store — the same one Platform logins write to.
            </p>
            <div class="settings-field">
              <div class="dir-row">
                <button class="btn ghost small" disabled={cookiesBusy} on:click={handleImportCookies}>
                  {cookiesBusy ? "Importing…" : "Import cookies.txt…"}
                </button>
                {#if hasCanonicalCookies}
                  <span class="settings-tag">Cookies on file</span>
                {/if}
              </div>
            </div>
          </div>

          <p class="settings-note">Settings are stored locally (browser localStorage / app data). Not shared.</p>
        </div>
      {/if}
      </div><!-- /.pane-side -->
    {:else}
      <div class="web-notice">
        <DesktopDownload variant="card" />
        <p class="web-explainer">
          URL downloads need the desktop app — they require a local yt-dlp binary that can't run in a browser sandbox.
          The web version is great for converting and editing files you already have on disk.
        </p>
      </div>
    {/if}
  </div><!-- /.pane.entry-pane -->

  {:else if state === "probing"}
    <div class="pane narrow-pane">
    <div class="progress-panel">
      <div class="progress-top">
        <span class="stage-label">Fetching info…</span>
        <span class="progress-num">{detectedSite || ""}</span>
      </div>
      <div class="bar-track indeterminate">
        <div class="bar-fill bar-pulse"></div>
      </div>
      <p class="progress-note">Reading the URL — usually 1–5 seconds.</p>
    </div>
    </div>

  {:else if state === "preview"}
    <div class="pane split preview-pane">
    <div class="pane-main">
    <div class="preview-header">
      <button class="btn link" on:click={backToIdle}>← Edit URL</button>
      {#if probe?.uploader}
        <span class="uploader">{probe.uploader}</span>
      {/if}
    </div>

    {#if probeFailures.length > 0}
      <div class="error">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span class="prewrap">{probeFailures.length} URL{probeFailures.length !== 1 ? "s" : ""} failed:
{probeFailureText}</span>
      </div>
    {/if}

    {#if partialCarousel}
      <div class="carousel-notice">
        Only the first item is available without login. Connect Instagram (Credits → Platform logins)
        to get the full carousel.
      </div>
    {/if}

    {#if !isMulti}
      <!-- Single item card -->
      <div class="single-card">
        <div class="single-thumb">
          {#if entries[0] && (thumbBlobs[entries[0].id] || entries[0].thumbnail || probe?.thumbnail)}
            <img src={thumbBlobs[entries[0].id] || entries[0].thumbnail || probe?.thumbnail} alt="" referrerpolicy="no-referrer" on:error={(e) => e.currentTarget.style.display = 'none'} />
          {:else}
            <div class="thumb-placeholder">
              {entries[0]?.mediaType === "image" ? "IMG" : entries[0]?.mediaType === "audio" ? "AUD" : "VID"}
            </div>
          {/if}
          {#if entries[0]?.mediaType === "image"}
            <span class="kind-chip image">Image</span>
          {:else if entries[0]?.mediaType === "audio"}
            <span class="kind-chip audio">Audio</span>
          {:else if entries[0]?.duration}
            <span class="duration-chip">{formatDuration(entries[0].duration)}</span>
          {/if}
        </div>
        <div class="single-meta">
          <div class="single-title">{probe?.title || entries[0]?.title || "Untitled"}</div>
          {#if probe?.uploader}
            <div class="single-sub">{probe.uploader}</div>
          {/if}
        </div>
      </div>
    {:else}
      <!-- Multi-item grid -->
      <div class="multi-toolbar">
        <div class="multi-title">
          <strong>{probe?.title || "Multi-item post"}</strong>
          <span class="multi-count">{entries.length} items · {selectedCount} selected</span>
        </div>
        <div class="multi-actions">
          <button class="btn ghost small" on:click={selectAll} disabled={selectedCount === entries.length}>Select all</button>
          <button class="btn ghost small" on:click={clearSelection} disabled={selectedCount === 0}>Clear</button>
        </div>
      </div>
      <div class="grid">
        {#each entries as entry (entry.id)}
          <button
            type="button"
            class="grid-card"
            class:selected={selected.has(entry.id)}
            on:click={() => toggleEntry(entry.id)}
          >
            <div class="grid-thumb">
              {#if thumbBlobs[entry.id] || entry.thumbnail}
                <img src={thumbBlobs[entry.id] || entry.thumbnail} alt="" referrerpolicy="no-referrer" on:error={(e) => e.currentTarget.style.display = 'none'} />
              {:else}
                <div class="thumb-placeholder">
                  {entry.mediaType === "image" ? "IMG" : entry.mediaType === "audio" ? "AUD" : "VID"}
                </div>
              {/if}
              <span class="check" class:on={selected.has(entry.id)}>
                {#if selected.has(entry.id)}
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                {/if}
              </span>
              {#if entry.mediaType === "image"}
                <span class="kind-chip image small">Image</span>
              {:else if entry.mediaType === "audio"}
                <span class="kind-chip audio small">Audio</span>
              {:else if entry.duration}
                <span class="duration-chip small">{formatDuration(entry.duration)}</span>
              {/if}
            </div>
            <div class="grid-title">{entry.title}</div>
          </button>
        {/each}
      </div>
    {/if}
    </div><!-- /.pane-main -->

    <div class="pane-side">
    <div class="options">
      {#if hasVideo}
        <div class="field">
          <span class="field-label">Type</span>
          <div class="seg" role="group" aria-label="Type">
            <button class:active={category === "video"} on:click={() => (category = "video")} disabled={audioForced}>Video</button>
            <button class:active={category === "audio"} on:click={() => (category = "audio")}>Audio</button>
          </div>
          {#if audioForced}
            <span class="field-hint">{detectedSite} only supports audio downloads.</span>
          {:else if anyImages}
            <span class="field-hint">Images are downloaded as-is (jpg/png/webp).</span>
          {/if}
        </div>

        <div class="field">
          <span class="field-label">Format</span>
          <select class="select" bind:value={format} aria-label="Output format">
            {#each (category === "video" ? VIDEO_FORMATS : AUDIO_FORMATS) as f}
              <option value={f}>{f.toUpperCase()}</option>
            {/each}
          </select>
        </div>

        {#if category === "video"}
          <div class="field">
            <span class="field-label">Quality</span>
            <div class="seg" role="group" aria-label="Quality">
              <button class:active={quality === "best"} on:click={() => (quality = "best")}>Best</button>
              <button class:active={quality === "1080"} on:click={() => (quality = "1080")}>1080p</button>
              <button class:active={quality === "720"} on:click={() => (quality = "720")}>720p</button>
              <button class:active={quality === "480"} on:click={() => (quality = "480")}>480p</button>
            </div>
          </div>
        {/if}
      {:else if hasAudioSource}
        <div class="field">
          <span class="field-label">Audio format</span>
          <select class="select" bind:value={format} aria-label="Audio format">
            {#each AUDIO_FORMATS as f}
              <option value={f}>{f.toUpperCase()}</option>
            {/each}
          </select>
        </div>
      {:else}
        <div class="field">
          <span class="field-hint">
            {selectionForKinds.length > 1
              ? "Photos download at full resolution — original format (.jpg / .png / .webp)."
              : "Photo downloads at full resolution — original format (.jpg / .png / .webp)."}
          </span>
        </div>
      {/if}

      {#if isDesktop}
        <div class="field">
          <span class="field-label">Save to</span>
          <div class="dir-row">
            <input
              type="text"
              class="dir-input"
              placeholder="Downloads folder"
              bind:value={outputDir}
              readonly
              on:click={pickOutputDir}
            />
            <button class="btn ghost small" on:click={pickOutputDir}>Choose…</button>
          </div>
        </div>
      {/if}
    </div>

    <div class="actions">
      <button class="btn primary" disabled={selectedCount === 0} on:click={handleDownload}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        {#if allSpotify}
          Download from Spotify{selectedCount > 1 ? ` (${selectedCount})` : ""}
        {:else}
          {actionVerb}{selectedCount > 1 ? ` ${selectedCount}` : ""}
        {/if}
      </button>
    </div>
    </div><!-- /.pane-side -->
  </div><!-- /.pane.preview-pane -->

  {:else if state === "downloading"}
    <div class="pane narrow-pane">
    <div class="progress-panel">
      <div class="progress-top">
        <span class="stage-label">Downloading…</span>
        <span class="progress-num">{progress}%</span>
      </div>
      <div class="bar-track">
        <div class="bar-fill" style="width: {progress}%"></div>
      </div>
      <p class="progress-note">
        {#if totalItems > 1}
          <!-- Completed count, not "current index" — items download
               CONCURRENTLY, so there is no single current item. -->
          {completedCount} of {totalItems} done{currentItemTitle ? ` — ${currentItemTitle}` : ""}
        {:else if currentItemTitle}
          {currentItemTitle}
        {:else if detectedSite && detectedSite !== "Unknown source"}
          From {detectedSite}
        {:else}
          From {url.substring(0, 60)}{url.length > 60 ? "…" : ""}
        {/if}
      </p>
    </div>

    <div class="actions">
      <button class="btn ghost" on:click={handleCancel}>Cancel</button>
    </div>
    </div><!-- /.pane.narrow-pane -->

  {:else if state === "done"}
    <div class="pane done-pane">
    <div class="done-panel">
      <div class="done-icon">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>
      <div class="done-title">
        {#if doneInfo && doneInfo.total > 1}
          {doneInfo.completed} of {doneInfo.total} downloaded
        {:else if doneResults.length > 0}
          Download complete
        {:else}
          Nothing downloaded
        {/if}
      </div>

      {#if doneResults.length === 1 && doneInfo && doneInfo.total <= 1}
        <div class="done-file">{doneResults[0]?.title || "Saved"}</div>
      {:else if doneResults.length > 0}
        <ul class="done-list">
          {#each doneResults as r (r.id)}
            <li class="done-item">
              <div class="done-item-meta">
                <div class="done-item-title">{r.title || "Saved"}</div>
              </div>
              <div class="done-item-actions">
                <button class="btn ghost small" on:click={() => handleOpenFolder(r.outputPath)}>Folder</button>
                <button class="btn ghost small" on:click={() => handleOpenFile(r.outputPath)}>Open</button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}

      {#if doneInfo && doneInfo.errors.length > 0}
        <div class="done-errors">
          <div class="done-errors-label">{doneInfo.errors.length} failed</div>
          {#each doneInfo.errors.slice(0, 3) as err (err.id)}
            <div class="done-error-item">{err.title}: {err.message}</div>
          {/each}
        </div>
      {/if}
    </div>

    {#if doneResults.length === 1 && doneInfo && doneInfo.total <= 1}
      <div class="actions done-actions">
        <button class="btn ghost" on:click={() => handleOpenFolder(doneResults[0]?.outputPath)}>Open folder</button>
        <button class="btn primary" on:click={() => handleOpenFile(doneResults[0]?.outputPath)}>Open file</button>
      </div>
    {/if}
    <div class="actions">
      {#if doneInfo && doneInfo.errors.length > 0}
        <button class="btn ghost" on:click={handleRetryFailed}>Retry failed ({doneInfo.errors.length})</button>
      {/if}
      <button class="btn link" on:click={handleReset}>Download another</button>
    </div>
    </div><!-- /.pane.done-pane -->
  {/if}
</div>

<style>
  /* Narrow is the base case (500–600px desktop window, mobile web): one
     column, exactly as before. Everything wide lives behind --split below. */
  .download-view { display: flex; flex-direction: column; gap: 14px; padding-bottom: 20px; animation: fadeUp 0.35s ease-out; max-width: 620px; margin: 0 auto; width: 100%; }

  /* State wrappers. At narrow widths they are transparent flex columns with
     the same 14px rhythm the children used to get from .download-view, so
     the narrow layout is byte-for-byte the old one. */
  .pane { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
  .pane-main, .pane-side { display: flex; flex-direction: column; gap: 14px; min-width: 0; }

  .hero { text-align: center; padding: 8px 0 4px; }
  .icon { width: 56px; height: 56px; border-radius: 14px; background: var(--bg-card); border: 1px solid var(--border); color: var(--accent); display: inline-flex; align-items: center; justify-content: center; margin-bottom: 10px; }
  h2 { font-size: 1.1rem; font-weight: 700; margin: 0 0 4px 0; letter-spacing: -0.02em; }
  .sub { font-size: 0.78rem; color: var(--text-muted); margin: 0; line-height: 1.45; }

  .url-box { position: relative; display: flex; }
  .url-input { flex: 1; padding: 12px 88px 12px 14px; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 0.88rem; font-family: inherit; outline: none; transition: border-color var(--transition-fast); resize: vertical; min-height: 44px; line-height: 1.45; }
  .url-input.multi { padding: 10px 14px 10px 14px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.78rem; }
  .multi-chip { background: var(--accent-dim) !important; color: var(--accent) !important; }
  .url-input:focus { border-color: var(--accent-dim); box-shadow: 0 0 0 3px var(--accent-glow, rgba(0,0,0,0.05)); }

  .site-chip { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); padding: 3px 9px; border-radius: 100px; background: var(--accent-dim, var(--bg-secondary)); color: var(--accent); font-size: 0.68rem; font-weight: 600; pointer-events: none; }
  .site-chip.unknown { background: var(--bg-secondary); color: var(--text-muted); }
  .site-chip.spotify { background: rgba(30,215,96,0.15); color: rgb(30,215,96); }

  .recent-row { display: flex; flex-wrap: wrap; gap: 6px; }
  .recent-chip { max-width: 100%; padding: 5px 11px; border-radius: 100px; background: var(--bg-card); border: 1px solid var(--border); color: var(--text-muted); font-size: 0.7rem; font-weight: 500; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; transition: all var(--transition-fast); }
  .recent-chip:hover { color: var(--text-primary); border-color: var(--accent-dim); }

  .resume-card { display: flex; flex-direction: column; gap: 8px; padding: 14px; background: var(--bg-card); border: 1px solid var(--accent); border-radius: var(--radius-sm); }
  .resume-label { font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-muted); }
  .resume-text { font-size: 0.8rem; color: var(--text-secondary); line-height: 1.45; margin: 0; }
  .resume-actions { display: flex; gap: 8px; justify-content: flex-end; }

  .carousel-notice { padding: 10px 12px; background: rgba(234,179,8,0.08); border: 1px solid rgba(234,179,8,0.35); border-radius: var(--radius-sm); color: rgb(202,138,4); font-size: 0.76rem; line-height: 1.45; }

  .options { display: flex; flex-direction: column; gap: 12px; padding: 14px; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .options.compact { padding: 12px; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field-label { font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); }
  .field-hint { font-size: 0.7rem; color: var(--text-muted); }

  .seg { display: flex; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 3px; gap: 2px; }
  .seg button { flex: 1; padding: 7px 10px; border-radius: calc(var(--radius-sm) - 3px); font-size: 0.78rem; font-weight: 600; color: var(--text-muted); background: transparent; transition: all var(--transition-fast); }
  .seg button:hover:not(:disabled):not(.active) { color: var(--text-secondary); background: var(--bg-hover); }
  .seg button.active { background: var(--bg-card); color: var(--text-primary); box-shadow: 0 1px 4px rgba(0,0,0,0.12); }
  .seg button:disabled { opacity: 0.4; cursor: not-allowed; }

  .dir-row { display: flex; gap: 6px; align-items: center; }
  .dir-input { flex: 1; padding: 8px 10px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 0.78rem; font-family: inherit; cursor: pointer; }
  .select { padding: 8px 12px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 0.82rem; font-family: inherit; font-weight: 600; outline: none; cursor: pointer; }
  .select:hover { border-color: var(--accent-dim); }
  .select:focus { border-color: var(--accent-dim); box-shadow: 0 0 0 3px var(--accent-glow, rgba(0,0,0,0.05)); }

  .actions { display: flex; gap: 10px; justify-content: center; padding: 4px 0 2px; flex-wrap: wrap; }
  .actions.done-actions { padding-top: 8px; }
  .actions.error-fixes { padding-top: 0; }

  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 10px 24px; border-radius: var(--radius-sm); font-weight: 600; font-size: 0.85rem; letter-spacing: -0.01em; }
  .btn.primary { background: var(--accent); color: var(--btn-primary-text); padding: 11px 32px; }
  .btn.primary:hover:not(:disabled) { background: var(--accent-hover); box-shadow: 0 0 18px var(--accent-glow), 0 4px 10px rgba(0,0,0,0.25); }
  .btn.primary:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn.ghost { background: transparent; color: var(--text-secondary); border: 1px solid var(--border); }
  .btn.ghost:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
  .btn.ghost.small { padding: 7px 12px; font-size: 0.76rem; }
  .btn.ghost:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn.link { background: transparent; color: var(--text-muted); padding: 6px 12px; font-size: 0.78rem; text-decoration: underline; text-decoration-color: var(--border); text-underline-offset: 3px; }
  .btn.link:hover { color: var(--accent); }

  .error { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.3); border-radius: var(--radius-sm); color: rgb(239,68,68); font-size: 0.78rem; line-height: 1.4; }
  .error svg { flex-shrink: 0; margin-top: 1px; }
  .error .prewrap { white-space: pre-line; word-break: break-word; min-width: 0; }

  .web-notice { display: flex; flex-direction: column; gap: 10px; }
  .web-explainer { font-size: 0.74rem; color: var(--text-muted); line-height: 1.5; margin: 0; text-align: center; }

  .settings-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    background: transparent;
    border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-size: 0.78rem;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
    transition: all var(--transition-fast);
  }
  .settings-toggle:hover { color: var(--text-secondary); border-color: var(--accent-dim); }
  .settings-toggle .chevron { transition: transform 0.15s ease; }
  .settings-toggle .chevron.open { transform: rotate(90deg); }
  .settings-tag {
    margin-left: auto;
    padding: 2px 8px;
    background: var(--accent-dim);
    color: var(--accent);
    border-radius: 100px;
    font-size: 0.62rem;
    font-weight: 700;
  }
  .settings-panel {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 14px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .settings-section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .settings-section + .settings-section {
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  .settings-title {
    font-size: 0.78rem;
    font-weight: 700;
    color: var(--text-primary);
  }
  .settings-help {
    font-size: 0.72rem;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0;
  }
  .settings-help a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
  .settings-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .settings-field label {
    font-size: 0.68rem;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .settings-input {
    padding: 8px 10px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.78rem;
    outline: none;
    transition: border-color var(--transition-fast);
  }
  .settings-input:focus { border-color: var(--accent-dim); }
  .settings-note {
    font-size: 0.68rem;
    color: var(--text-muted);
    margin: 0;
    text-align: center;
  }

  .progress-panel { padding: 18px; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-sm); display: flex; flex-direction: column; gap: 10px; }
  .progress-top { display: flex; justify-content: space-between; align-items: baseline; }
  .stage-label { font-size: 0.85rem; font-weight: 600; color: var(--text-primary); }
  .progress-num { font-size: 0.78rem; color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .bar-track { width: 100%; height: 6px; background: var(--bg-secondary); border-radius: 3px; overflow: hidden; position: relative; }
  .bar-fill { height: 100%; background: var(--accent); transition: width 0.2s ease; box-shadow: 0 0 8px var(--accent-glow, var(--accent)); }
  .bar-track.indeterminate .bar-pulse { width: 30%; animation: probePulse 1.2s ease-in-out infinite; }
  @keyframes probePulse { 0% { transform: translateX(-100%); } 50% { transform: translateX(150%); } 100% { transform: translateX(350%); } }
  .progress-note { font-size: 0.74rem; color: var(--text-muted); margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .done-panel { text-align: center; padding: 20px 14px 14px; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .done-icon { width: 48px; height: 48px; border-radius: 50%; background: rgba(34,197,94,0.12); color: rgb(34,197,94); margin: 0 auto 10px; display: flex; align-items: center; justify-content: center; }
  .done-title { font-size: 1rem; font-weight: 700; margin-bottom: 4px; }
  .done-file { font-size: 0.85rem; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 8px; }
  .done-list { list-style: none; margin: 12px 0 0; padding: 0; text-align: left; display: flex; flex-direction: column; gap: 6px; max-height: 260px; overflow-y: auto; }
  .done-item { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 10px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .done-item-meta { min-width: 0; flex: 1; }
  .done-item-title { font-size: 0.8rem; font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .done-item-actions { display: flex; gap: 6px; flex-shrink: 0; }

  .done-errors { margin-top: 12px; padding: 10px 12px; background: rgba(239,68,68,0.06); border: 1px solid rgba(239,68,68,0.25); border-radius: var(--radius-sm); text-align: left; display: flex; flex-direction: column; gap: 4px; }
  .done-errors-label { font-size: 0.74rem; font-weight: 700; color: rgb(239,68,68); }
  .done-error-item { font-size: 0.7rem; color: var(--text-muted); line-height: 1.4; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }

  /* Preview view */
  .preview-header { display: flex; align-items: center; justify-content: space-between; padding: 0 4px; }
  .uploader { font-size: 0.74rem; color: var(--text-muted); }

  .single-card { display: flex; gap: 14px; padding: 14px; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-sm); align-items: center; }
  .single-thumb { position: relative; width: 140px; height: 90px; flex-shrink: 0; border-radius: calc(var(--radius-sm) - 2px); overflow: hidden; background: var(--bg-secondary); }
  .single-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .single-meta { min-width: 0; flex: 1; }
  .single-title { font-size: 0.92rem; font-weight: 700; line-height: 1.3; color: var(--text-primary); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .single-sub { font-size: 0.74rem; color: var(--text-muted); margin-top: 4px; }

  .multi-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .multi-title { display: flex; flex-direction: column; min-width: 0; }
  .multi-title strong { font-size: 0.86rem; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .multi-count { font-size: 0.7rem; color: var(--text-muted); margin-top: 2px; }
  .multi-actions { display: flex; gap: 6px; flex-shrink: 0; }

  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
  @media (max-width: 540px) { .grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); } }
  .grid-card { display: flex; flex-direction: column; gap: 8px; padding: 8px; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; text-align: left; transition: border-color var(--transition-fast), box-shadow var(--transition-fast); }
  .grid-card:hover { border-color: var(--accent-dim, var(--border)); }
  .grid-card.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .grid-thumb { position: relative; width: 100%; aspect-ratio: 1 / 1; border-radius: calc(var(--radius-sm) - 2px); overflow: hidden; background: var(--bg-secondary); }
  .grid-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .thumb-placeholder { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; font-size: 0.7rem; font-weight: 700; color: var(--text-muted); letter-spacing: 0.08em; }
  .check { position: absolute; top: 6px; left: 6px; width: 22px; height: 22px; border-radius: 50%; background: rgba(0,0,0,0.55); border: 1px solid rgba(255,255,255,0.55); color: white; display: flex; align-items: center; justify-content: center; }
  .check.on { background: var(--accent); border-color: var(--accent); }
  .grid-title { font-size: 0.74rem; color: var(--text-secondary); line-height: 1.3; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }

  .duration-chip, .kind-chip { position: absolute; bottom: 6px; right: 6px; padding: 2px 6px; border-radius: 4px; background: rgba(0,0,0,0.65); color: white; font-size: 0.68rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  .duration-chip.small, .kind-chip.small { font-size: 0.62rem; padding: 1px 5px; }
  .kind-chip.image { background: rgba(168,85,247,0.85); }
  .kind-chip.audio { background: rgba(30,215,96,0.85); }

  /* ── Wide layout ────────────────────────────────────────────────────
     The Tauri window opens at 600x700 with a 500x600 minimum, so the
     single column above is the COMMON desktop case; everything below is
     for the web page and for a window the user has actually widened.
     Nothing here applies under 900px. */
  @media (min-width: 900px) {
    .download-view:not(.web) { max-width: 1120px; gap: 18px; }

    /* Content starts at the top. Vertically centring the short states left
       the hero floating in the middle of the window while the column beside
       it started at the top — the two never lined up. */

    /* A centred 56px badge over two centred lines burns vertical space the
       populated states need — fold the hero into a header row instead. */
    .download-view:not(.web) .hero {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      grid-template-areas: "icon title" "icon sub";
      column-gap: 16px;
      align-items: center;
      text-align: left;
      padding: 2px 2px 0;
    }
    .download-view:not(.web) .hero .icon { grid-area: icon; margin-bottom: 0; }
    .download-view:not(.web) .hero h2 { grid-area: title; align-self: end; font-size: 1.25rem; }
    .download-view:not(.web) .hero .sub { grid-area: sub; align-self: start; }

    /* Two columns: the thing you act on, then the settings for it. */
    .download-view:not(.web) .pane.split {
      display: grid;
      grid-template-columns: minmax(0, 1.4fr) minmax(288px, 0.9fr);
      align-items: start;
      gap: 18px;
    }
    .download-view:not(.web) .pane-full { grid-column: 1 / -1; }

    /* Entry state — the CTA belongs under the field it submits, not
       centred across a column it has nothing to do with. */
    .entry-pane .pane-main .actions { justify-content: flex-start; padding-top: 2px; }
    .entry-pane .pane-side { position: sticky; top: 2px; }

    /* Preview state — options + Download ride along beside the picker. */
    .preview-pane .pane-side { position: sticky; top: 2px; }
    .preview-pane .pane-side .actions .btn.primary { flex: 1 1 auto; justify-content: center; }

    /* Spend the extra width on MORE thumbnails, not wider ones. */
    .grid { grid-template-columns: repeat(auto-fill, minmax(158px, 1fr)); gap: 10px; }

    /* Transient states keep a readable measure instead of stretching a
       6px progress bar across 1120px. */
    .narrow-pane { max-width: 620px; margin-inline: auto; width: 100%; }

    /* Results: one panel, but the file list flows into columns. */
    .done-pane { max-width: 900px; margin-inline: auto; width: 100%; }
    .done-list {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 8px;
      max-height: 420px;
    }

    /* Web variant: this is a short linear pitch, not a dashboard. Splitting
       it into columns put the hero and the card on different baselines and
       read as broken — keep one centred column and just let it breathe. */
    .download-view.web { max-width: 560px; }
    .download-view.web .hero .icon { width: 64px; height: 64px; border-radius: 16px; }
    .download-view.web .hero h2 { font-size: 1.5rem; }
  }
</style>
