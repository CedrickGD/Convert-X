# Convert-X Desktop — Resume Plan

Snapshot of where the desktop app stands, written to drop back in with zero
ramp-up. Mirrors `packages/android/RESUME.md`.

---

## Current state

**Desktop was brought to Android v0.8.0 feature parity** in one session
(uncommitted at time of writing). Before this, desktop had a solid convert
pipeline and a basic yt-dlp downloader; it had none of Android's resilience
layer, platform probers, login UI, resume, or error log.

The work was driven by a generated gap matrix + interface contract (see
"Process" below), implemented in two waves, then reviewed by a 5-lens
adversarial workflow that confirmed 16 defects — all fixed.

### What landed — download engine (Rust)

- **Per-job process registry** `active_jobs: HashMap<file_id, pid>` +
  `cancelled` set replacing the single shared PID slot. `cancel_download(fileId?)`
  kills one or all. Cancel now **resolves** as `{status:'cancelled'}` and never
  rejects — cancel is never an error, never an error-log entry.
  Jobs register BEFORE the first await and re-check the flag immediately before
  spawning, so a cancel-all can't miss a job inside its registration window
  (that produced ghost downloads + history rows).
- **Deterministic outputs**: per-job staging dirs
  (`%TEMP%\convertx-{ytdlp,spotdl,direct}\<id>\`) via `--paths home:/temp:`, then
  move to the output dir with a ` (2)` collision suffix. The old
  `newest_file_since()` mtime scan is gone — it was the one thing hard-requiring
  sequential downloads. Stale staging dirs are swept (24h age filter) on a
  background thread at startup.
- **`download_direct`**: streaming direct-CDN downloads with progress events,
  typed `http_error` (a 403 body is never saved as media), 0-byte rejection,
  partial-file cleanup, a 60s read timeout, and a 2s cancel-poll so a stalled
  socket can't hang the batch.
- **`http_request`**: prober transport (reqwest, **no cookie jar** — cookies.txt
  is the single source of truth, headers set explicitly). Timeout errors contain
  the literal "timed out" because the shared probers regex it.
- **yt-dlp format ladder** ported from Android's `buildVideoFormat`
  (`vcodec!=none` guards, any-size-with-audio rung before audio-less, trailing
  `bv*` for genuinely soundless clips).
- `update_ytdlp`, `set_keep_awake`, `file_exists`, cookies file IO commands.

### What landed — shared JS (`packages/shared/src/lib/`, 11 new modules)

Platform-agnostic ports of the Android libs, coded against the adapter contract
and feature-detected so the **web build is unaffected**:

- `downloadQueue.js` — the core. Probe **router** (Twitter → IG profile → IG
  story → IG post → yt-dlp), `canonical()` URL compare, **two-lane parallel
  batch** (3-wide direct-CDN + sequential yt-dlp), per-item progress and errors
  without aborting the batch, **self-healing** expired-CDN retry (one memoized
  re-probe on 401/403/404/410/429, matched by stable id), **kill-proof resume**
  (PendingBatch, 24h TTL), quality-cap variant selection, keep-awake.
- `twitterScraper.js` — syndication CDN prober (photos at `name=orig`, mp4
  variants, dims from the `/WxH/` path, tombstone → cookied yt-dlp fallthrough).
- `instagramStories.js` / `instagramScraper.js` — cookied web-API probers
  (`feed/reels_media` stories, `media/<pk>/info` posts with BigInt
  shortcode→pk, profile→active-stories), anonymous embed prober with
  `partialCarousel`, plus `checkInstagramSession` (15-min cache).
- `cookies.js`, `loginPlatforms.js`, `errorLog.js`, `history.js`,
  `recentUrls.js`, `storage.js`, `feedback.js`.

### What landed — UI (shared Svelte, all desktop-gated)

DownloadView rewired onto the router + batch runner: mean progress bar with
"N of M done", done view that survives failures with **Retry failed (N)** by id,
**resume banner**, adaptive type-aware options, recent-URL chips, `img_index`
preselect, partial-carousel notice, and one-tap error fixes ("Log in to
Instagram" / "Update download engine").
New Credits cards: **PlatformLogins** (7 platforms, session-expired badge),
**ErrorLogCard** (copy/clear), **EngineUpdateCard**. New **History** tab.
Toast + themed Confirm replace silent failures.

### What landed — convert side

Per-file trim on the file entry (was one global trim applied to every file in
the batch — a trim set on clip A silently truncated B..N), selectable rows when
2+ videos, stale-trim clamping, video→audio targets, **target-size export**
(`-b:v/-maxrate/-bufsize` with Android's exact math), `+faststart`, no `-ss/-t`
on images, 0-byte detection, filename sanitization, reset preserves encode
settings, per-row error text, cancel preserves the done summary.

---

## Load-bearing facts

- **`cookies.txt` lives at `%LOCALAPPDATA%\com.convertx.app\cookies.txt`** and is
  the single source of truth for login state. One bundle identifier is used by
  `tauri dev` AND `tauri build`, so **dev and release share it** (unlike Android,
  where `.dev` has its own app data). yt-dlp reads it via `--cookies`; the JS
  probers parse the same text into `Cookie` headers.
- **Login windows get a fresh WebView2 profile** under `login-profiles/` per
  sign-in, so you get an account chooser instead of being auto-locked to the
  previous account. Only the browser scratch space is per-login; harvested
  cookies go into the one shared cookies.txt.
- **The app ACL is ON.** `build.rs` declares an app manifest listing all 24
  commands and `capabilities/default.json` scopes them to `windows: ["main"]`.
  This exists because the login window loads a **remote origin** (Instagram,
  Google) which would otherwise be able to call every command, including the
  cookie and file-read ones. `src/acl_test.rs` asserts every registered command
  resolves for `main` and is denied for the login window — **it fails the build
  if a new command is added without updating build.rs + capabilities**, because
  a missing command breaks the main window silently at runtime.
- `open_login_window` pins the URL to a Rust copy of the `loginPlatforms.js`
  registry. Editing a `loginUrl` in JS without updating `login.rs` breaks that
  platform's login.
- `build.rs` generates `permissions/autogenerated/*.toml` (24 files, currently
  untracked) — decide whether to commit (repo convention commits `gen/schemas`)
  or gitignore.

---

## Round 2 — theming, navbar, icon, and live testing

**Accent colour system ported** (was wrongly deferred as "orthogonal"): new
`shared/src/lib/color.js` is a verbatim port of Android's `lib/color.ts`, so both
apps derive identical hover/dim/glow shades from a hex. `themeStore` gained an
`accent` store (`convertx.accent.v1`) writing `--accent{,-hover,-dim,-glow,-subtle,-border}`
and `--btn-primary-text` (= `readableOn(accent)`, so bright accents don't ship
illegible buttons) as inline `:root` properties, which outrank both `[data-theme]`
blocks. New `ColorPicker.svelte` + `AccentColorCard.svelte`. Un-gated — web gets it too.

**Navbar**: was **54px**, not by padding but because "Credits & App" wrapped to two
lines at the 600px default width and flex stretched every tab. Now 39px, via tighter
padding + `nowrap` + renaming the tab to **"Credits"** (Android's own label; the long
one cannot fit at the 500px minimum width). Added the sliding active-tab indicator.
The dead animation was **Convert ↔ Resize** — they render the same view block, so
switching never remounted or toggled display; a `paneEnter` counter alternating two
identically-shaped keyframes now drives every pane without remounting DownloadView
(whose always-mounted `.tab-pane` is what keeps a running batch cancellable).

**Contrast**: `--text-muted` was #4a4a4a dark (~2.2:1) / #999 light. Android had
already been fixed; desktop hadn't. Now #7a7a7a / #6b6b6b.

**App icon**: replaced the simple X with an interlocking `Cx` monogram.
Sources: `icons/source-cx.svg` (full, with plate) and `icons/source-cx-fg.svg`
(Android adaptive foreground — glyph on transparency, knockout painted in the
layer's background colour). Regenerate every size with:
`npx tauri icon src-tauri/icons/icon-manifest.json`. Distributed to desktop
ico/icns/PNGs, web `favicon.svg`/`.ico`, all 5 Android mipmap densities and the
Expo asset set. **Do NOT copy the generated `mipmap-anydpi-v26` XML** — it
references `@color/ic_launcher_background`, which does not exist here.

> **Recoloured 2026-08-02 (Android v0.8.2):** the monogram is now flat
> **`#ffffff` on flat `#000000`**, not the silver gradient on `#2a2a2e`. The
> silver only reached ~4:1 contrast and read as washed out at launcher size;
> white on black is ~21:1. `bg_color` in `icon-manifest.json` is the single
> place that colour is declared for the icon pipeline, and the desktop set has
> been regenerated from it (commit `824570a`). Android's rasters come from
> `packages/android/scripts/gen-icons.js`, which reads the SAME manifest —
> `npm run icons:check` there fails on drift.

## Live testing (2026-08-01) — three bugs only real runs caught

Verified against REAL private Instagram content using the actual cookies:
session check `ok`; a 7-item private story downloaded with a **2.66× parallel
speedup**, quality cap honoured (h264 720×1280); a private post image downloaded
as a valid 1608×2144 JPEG (the cookied-post path Android's RESUME still lists as
never verified live). Test files were deleted afterwards.

1. **Duplicated ids in filenames** — the direct lane appended `entry.id` although
   the probers already end titles with it. Android only does that for its yt-dlp
   template. Fixed; `dedupe_names` now flows to Rust to pick
   `%(title)s-%(id)s.%(ext)s` for the yt-dlp lane instead.
2. **cookies.txt was invalid Netscape format** — the writer emitted the harvested
   dot-less domain with `includeSubdomains = TRUE`. Python's `http.cookiejar`
   asserts these agree, so **yt-dlp rejected the whole file**: every cookie-gated
   download would have failed. `mergePlatformCookies` now promotes host-only
   domains to dotted form. Existing files on disk need the same repair (add the
   leading dot on rows whose flag is TRUE).
3. **YouTube + cookies = no formats at all.** With a signed-in jar, yt-dlp gets
   back only storyboards, for every video, on every player_client. This is
   YouTube invalidating cookies harvested from a still-open session — it hits
   **Android identically**. Both `run_ytdlp` and `probe_url` now retry once
   without the jar (`ytdlp_lost_formats` + `is_youtube_url`), so public videos
   keep working after a user signs in.

## Still missing vs Android (15 items, swept 2026-08-01)

Highest value: image crop in Resize mode (Android has a full crop editor;
`resize_image` has no crop param at all), History covering convert/resize outputs
rather than downloads only, an error boundary, Resize opening at 100% instead of
silently halving, and video edits when the target is GIF (Rust already supports
it — `ffmpeg.rs:272,288` — the UI just hides them).
Polish: indicator label cross-fade, format pre-selected from source, download
settings persistence, app version in header, reduced-motion, `:focus-visible`
(the stylesheet strips outlines and never restores them).
Needs a decision: Android keeps Convert and Resize on independent file lists and
settings; desktop shares one store, so files dropped for one mode appear in the
other. Fixing it touches every consumer of those stores.
Excluded as mobile-only: haptics, share sheet, save-to-gallery, runtime
permissions, safe-area insets.

## Verified / not verified

**Verified:** `cargo check --all-targets` and `cargo test --lib` clean; web and
desktop Vite builds clean with byte-identical warning sets vs baseline; web
runtime smoke (tab set unchanged, no desktop-only cards leak, desktop-promo link
resolves to a desktop release). Empirically proven with real binaries: the
yt-dlp filename fix (`--print filename` before/after), direct-lane stall +
cancel behavior against local stall servers, and ACL resolution for both windows.

**NOT verified live** — this is the honest gap. Nothing download-side has been
exercised in the running desktop app: the login window (WebView2 profile dir,
cookie harvesting incl. HttpOnly), the Twitter/Instagram probers against live
endpoints, parallel batch downloads, self-heal, resume after a kill, and the
convert-side per-file trim / target-size UX. First-run checklist:

1. Credits → platform cards visible (proves the adapter methods landed) → log
   into Instagram → row shows Connected with a green session badge.
2. Paste a 2-item IG story and a photo carousel → both items probe → both
   download in parallel → distinct files.
3. Cancel mid-batch → no error banner, no error-log entry, no ghost files.
4. Kill the app mid-batch → relaunch → resume banner → only remaining items.
5. Convert 2 videos with different trims → each file honors its own trim.

---

## Process artifacts

The gap matrix (feature contract, with Android file:line refs), the interface
contract (adapter/command signatures), and the confirmed-findings list live in
the session scratchpad. If they're gone, they are regenerable: deep-read both
stacks in parallel, synthesize a gap matrix, then run a multi-lens find →
adversarial-verify review over the diff. That review is what caught the
yt-dlp filename bug, the cancel-as-success bug, and the remote-origin ACL hole.

## Known cross-platform bug fixed in BOTH apps

Instagram's `?img_index=` is **1-based**, but both apps treated it as 0-based, so
pasting a link to a specific carousel photo preselected the wrong item. Fixed on
desktop and in `packages/android/src/screens/DownloadScreen.tsx`. ~~Android needs
a release to ship it~~ — **shipped in Android v0.8.1** (2026-08-02). The desktop
half is still uncommitted/unreleased along with the rest of this wave.

---

## Environment

- Build: `packages/desktop/build.bat` (portable exe + NSIS installer into
  `packages/desktop/release/`). It ends in `pause` + `explorer`, so for automated
  runs source `VsDevCmd.bat -arch=x64` and call `npx tauri build` directly.
- MSVC: `C:\Program Files\Microsoft Visual Studio\18\Insiders` (via vswhere).
- Bundled tools: `src-tauri/bin/{ffmpeg,ffprobe,yt-dlp,spotdl}.exe`.
- Version drift to resolve: `tauri.conf.json` 0.2.2 vs `Cargo.toml` 0.1.0.
