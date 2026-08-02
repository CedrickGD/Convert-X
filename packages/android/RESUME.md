# Convert-X Android — Resume Plan

Snapshot of where we left off, written to drop back in with zero ramp-up.

---

## Current state

**Latest release:** v0.8.1 (tag `v0.8.1`) — icon pipeline repair.

The new silver-CX icon had been rendered into `assets/` and `res/mipmap-*`
by hand, and that ad-hoc process left two real defects in the shipped APK:

- **The splash screen was still the old green X.** `values/styles.xml` points
  `windowSplashScreenAnimatedIcon` at `@drawable/splashscreen_logo`, and those
  five PNGs had not been touched since **v0.6.16** — they survived *two*
  subsequent icon redesigns untouched, so the launcher and the splash showed
  different brands.
- **`mipmap-hdpi/ic_launcher.png` / `_round.png` were 49x49** instead of
  72x72, i.e. a broken resize that Android then upscaled on every hdpi device.
- **The adaptive foreground was drawn far too large and got clipped.** The
  glyph's circumscribed diameter was ~84% of the 108dp canvas, but a launcher
  only guarantees the inner 66dp circle (61.1%) survives masking — and One UI
  masks to an aggressive squircle. On the S26 the C's top-left corner and the
  x's lower-right arm were sliced flat. `icon-manifest.json` had *already*
  declared the right value (`android_fg_scale: 62`); it simply was never
  applied to the render. The generator now measures the visible silver art's
  circumscribed circle (ignoring the knockout, which is painted in the
  background colour and is therefore invisible when clipped) and fits it to
  that 62%. Verified on-device before/after.

Root cause was that nothing derived the rasters from the vector source, so
drift was invisible. Fixed by adding **`scripts/gen-icons.js`** (`npm run
icons`, `npm run icons:check`) — the single generator for every Android
raster, driven by the SVG source of truth in
`../desktop/src-tauri/icons/` (`source-cx.svg`, `source-cx-fg.svg`,
`icon-manifest.json`). It emits, all from those SVGs:

- `mipmap-<dpi>/ic_launcher.png` (48/72/96/144/192, full plate)
- `mipmap-<dpi>/ic_launcher_round.png` (same sizes, circle-masked)
- `mipmap-<dpi>/ic_launcher_foreground.png` (108/162/216/324/432, glyph with
  the knockout gap painted `#2a2a2e` to match `@color/iconBackground`)
- `drawable-<dpi>/splashscreen_logo.png` (288/432/576/864/1152, glyph at 52%
  coverage so the Android-12 circular splash mask can't clip it, knockout
  repainted `#0a0a0a` to match `@color/splashscreen_background`)
- `assets/{icon,adaptive-icon,splash-icon}.png` at 1024 + `favicon.png` at 48
  — these are the `expo prebuild` inputs, previously only 256/432 px.

`npm run icons:check` exits non-zero on drift, so this can't silently rot again.

Also fixed while in here:

- **`scripts/bump-version.js` now syncs `app.json`'s `expo.android.versionCode`**
  alongside build.gradle's. It had drifted to 37 while gradle was at 46 —
  since `expo prebuild` regenerates build.gradle *from* app.json, the next
  prebuild would have rolled the shipped versionCode backwards and Android
  would have rejected the install-over as a downgrade.
- **`build:apk*` now call `.\gradlew.bat`**; the bare `gradlew` did not resolve
  from cmd's working directory and the script failed instantly.
- **Windows MAX_PATH broke the native build** once `.cxx` had to be rebuilt
  from scratch. New-Arch codegen writes object paths that embed the ABSOLUTE
  source path, landing ~360 chars, and `LongPathsEnabled=1` is NOT enough on
  its own: the ninja shipped with SDK cmake 3.22.1 is 1.10.2, predating the
  `longPathAware` manifest (ninja 1.11). `app/build.gradle` now accepts
  `-PCONVERT_X_NINJA=<path to ninja>=1.11>` and passes it as
  `CMAKE_MAKE_PROGRAM`. Visual Studio ships a usable one:
  `C:/Program Files (x86)/Microsoft Visual Studio/18/BuildTools/Common7/IDE/CommonExtensions/Microsoft/CMake/Ninja/ninja.exe`
  Put it in `~/.gradle/gradle.properties` to make it automatic.

## Cutting a release

Release signing is NOT in the repo. The keystore lives at
`C:/Users/cedri/keys/convert-x-android-release.jks` (password in
`convert-x-android-release.password.txt` beside it, alias `convert-x-release`),
and `android/gradle.properties.local` does not exist — so a plain
`assembleRelease` silently falls back to the DEBUG keystore and the resulting
APK cannot install over an existing install (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`).
Pass the signing config via `ORG_GRADLE_PROJECT_*` env vars (keeps it off disk
and out of git):

    ORG_GRADLE_PROJECT_CONVERT_X_KEYSTORE_FILE / _KEYSTORE_PASSWORD /
    _KEY_PASSWORD / _KEY_ALIAS

Verify with `apksigner verify --print-certs` — the release cert is
`CN=CedrickGD, O=Personal`, SHA-256 `4b946b51…`. A debug-signed APK shows
`CN=Android Debug` instead.

**Upload the GitHub asset as `app-arm64-v8a-release.apk`**, not the friendly
`Convert-X-Android-<ver>.apk` that `copy-apk.js` produces: `updater.ts`'s
`pickAssetForAbi` matches assets by the `arm64-v8a` substring, so the friendly
name makes the update invisible to every installed client.

Note: build with **`npm run build:apk:fast`**. The `build:apk` script runs
`expo prebuild` first, which re-templates the committed native project and
would clobber the hand-maintained parts of it (`splits.abi`, `signingConfigs`,
the `.dev` applicationIdSuffix, `modules/`).

Also carries the **`img_index` off-by-one fix**: Instagram's `?img_index=` is
1-based but the entries array is 0-based, so a link to carousel item N
preselected item N+1.

**Previous release v0.8.0** (tag `v0.8.0`) — the feature wave on top of
v0.7.6, all requested by the user in one "do all of em" session:

- **Parallel downloads**: direct-CDN entries run 3-wide alongside a
  sequential yt-dlp lane (`downloadBatch` worker pool); the old single
  `inflight` slot became an `inflightCancels` Map so Cancel aborts every
  concurrent transfer; progress = per-item pct array, label = "N of M done".
- **Self-healing URLs**: expired signed CDN URL (401/403/404/410/429 via
  `HttpStatusError`) triggers ONE memoized re-probe of `sourceUrl`; fresh
  URLs matched by entry id, item retried; cancel-checked between attempts.
- **Kill-proof batches**: `PendingBatch` descriptor persisted per item;
  next launch shows a Resume banner (re-probes, downloads only remaining
  ids, uses the PERSISTED audioOnly/format/quality). Keep-awake held for
  the batch duration (expo-keep-awake, ships inside every expo build).
- **Error log + crash capture** (`src/lib/errorLog.ts`): AsyncStorage ring
  buffer; explicit logError at probe/download catch sites; ErrorUtils
  crash hook; Hermes-native promise-rejection tracker (the npm `promise`
  polyfill hook is a no-op on Hermes — fallback only). Credits →
  collapsible "Error log" card with Copy/Clear. Fatal-crash persistence is
  best-effort (AsyncStorage is async; process may die first).
- **Session health**: `checkInstagramSession` (topsearch, 15-min cache,
  invalidated on login/import/logout via
  `invalidateInstagramSessionCache`); Credits shows "Session expired —
  sign in again" on the Instagram row.
- **Twitter/X images+videos** (`src/lib/twitterScraper.ts`): anonymous
  syndication-CDN prober (photos at `name=orig`, videos with mp4
  variants + dims parsed from the `/WxH/` URL path, playlistIndex for
  yt-dlp fallbacks). Live-tested: single/multi photo, multi-video,
  mixed, GIF, tombstone, 404, text-only. Tombstoned (NSFW/protected)
  tweets fall through to cookied yt-dlp.
- **Profile links** → active stories (host-anchored regex, reserved
  segments excluded); **quality cap honored** for direct video entries
  via `DownloadEntry.variants`.
- **Per-file trim** (convert): trim lives on `FileEntry`, ClipEditor
  binds the selected video (FileList rows selectable when 2+ videos),
  clamps stale trim, reports duration (>0 guard). **Target-size export**:
  `targetSizeMb` setting → `-b:v/-maxrate/-bufsize` bitrate mode
  (speed-adjusted duration, 128k audio, silent quality-mode fallback
  when duration unknown).

Verified live on the S26 dev build: Twitter photo end-to-end (probe →
gallery save), story 2-item batch downloading IN PARALLEL, Error log card,
green session badge. Verified by typecheck+bundle+adversarial review only:
resume flow, convert-side per-file trim / target size. A 3-lens regression
review of the diff raised 16 issues (2 major: cancel-ignoring 4xx retry,
Twitter quality cap) — all fixed except two accepted nits (fatal-crash
persistence best-effort; ErrorLogCard could paginate past 20).

**Previous release v0.7.6:**

v0.7.6 = the Instagram-story fix plus 10 adversarially-verified audit fixes.
The story bug (user report: 2-item story, only the second downloaded):
yt-dlp's instagram:story extractor keeps only items with `formats` built
from `video_versions` — photo story items are silently dropped — AND
`buildVideoFormat`'s chain required an audio stream in every term, so MUTED
story videos failed with "Requested format is not available". Fixes:
(1) NEW `src/lib/instagramStories.ts` — cookied JS probers hitting
Instagram's own web API: stories via `feed/reels_media` (user-id chain:
topsearch → media/<storyPk>/info → web_profile_info; the last one
intermittently 400s with "Asset … laser.provider … has been deleted", and
story-page HTML parsing is deliberately NOT used — browser UAs get a React
shell with no reel data, plus wrong-account risk), and POSTS via
`media/<pk>/info` with the shortcode→pk base-64 decode — needed because a
LOGGED-IN user skips the anonymous embed prober and cookied yt-dlp drops
every IMAGE item (a 4-photo carousel probed to nothing). All items (photos
included) become direct-CDN entries for downloadDirect; Audio-toggle on a
direct video entry falls back to yt-dlp so `-x` still works;
(2) trailing `bv*` audio-less fallbacks in buildVideoFormat (bv* still
requires a video codec, so the audio-only-file regression cannot return);
(3) canonical URL compare (strip query/hash) for playlist-children routing —
pasted share links carry ?utm_source/?igsh params that made every carousel
child look "self-contained". Verified live end-to-end on the S26: probe
lists both story items, both download, both in Movies/Convert-X.

Audit fixes (workflow: 4 find-lenses → adversarial verify, 11 confirmed →
deduped to 10): single-entry probe now uses webpage_url not yt-dlp's signed
CDN `url` (broke TikTok/Twitter single videos on re-download); cancelActive
invokes the registered closure (direct-CDN downloads were uncancellable);
downloadDirect checks HTTP status (a 403 body was saved to the gallery as
"media" and reported success) and reports real `cancelled`; batch errors
carry entry `id` and Retry-failed matches by id (titles collide across
carousel children); isDownloading() re-entrancy guard + inflight ownership
checks; retry progress label uses the active batch length; GIF-chip peek no
longer permanently mutes video exports (pre-GIF stripAudio stashed in a
ref); ClipEditor binds the first VIDEO file (not files[0]) and clamps stale
trim on load; ConvertContext clears trim on addFiles/removeFile; ColorPicker
preview throttled to ~30 Hz (every preview re-renders all four mounted mode
screens); history prune recomputes from live cache (race dropped fresh
entries); PlatformLoginScreen clears its goBack timer + isFocused guard.

Releases: https://github.com/CedrickGD/Convert-X/releases
Release flow: bump (`node scripts/bump-version.js <ver>`) → commit to `main`
→ push tag `v*` → the "Release Android APKs" workflow builds
`app-arm64-v8a-release.apk`. CI runs the gradle build only (no tsc/lint), so
**typecheck locally** (`npx tsc --noEmit` in `packages/android`) before
tagging. Local release gradle build fails on this machine (CMake 260-char
Windows path limit) — CI is the build path. The native `android/` project is
committed and CI does NOT run `expo prebuild`, so launcher-icon changes must
edit the committed `android/app/src/main/res/mipmap-*` PNGs directly (not
just `assets/`).

---

## Everything verified live on the S26 (v0.7.0 → v0.7.4)

Core (v0.7.0): dialog-free gallery save (native MediaStore insert, clean
names, routed by type), theme-toggle fix, download progress moves,
per-carousel-item `--playlist-items`, working yt-dlp updater.

v0.7.1: type-aware download options (probe → detect video/audio/image →
adaptive options); multi-platform login card + per-domain cookies.txt merge.

v0.7.2: YouTube + LinkedIn logins; real-UA + popup handling for social
logins; collapsible/editable accent-color card with merged quick picks.

v0.7.3: no double-save (removed redundant save button; done row shows
"Saved to gallery" + Share); Instagram first-attempt-while-logged-in fix
(on-disk cookies.txt is the source of truth — see `resolveCookiesPath`);
custom app-styled Toast + Confirm dialog (FeedbackProvider) replacing every
Alert.alert; permissions via OS Photo Picker (no custom nag); animated
sliding tab indicator; new silver-X-on-dark-grey launcher icon.

v0.7.4: account switching — every login wipes the WebView cookie store
first (`CookieManager.clearAll` gated behind a ready spinner), so logout →
login shows a fresh account chooser instead of auto-locking to the previous
(esp. Google) account. Downloads unaffected (they read cookies.txt).

**Live end-to-end proof (2026-07-16):** logged into Instagram/YouTube/
TikTok/X/LinkedIn; account-switch verified (logout → empty login form →
re-login → Connected); a **private Instagram story** probed on the FIRST
attempt, downloaded, and saved as a SINGLE file in Movies/Convert-X (no
duplicate).

---

## Open / not yet verified

- Reddit + Facebook logins (WebView built, user hasn't signed in).
- Google-based logins (YouTube worked live; "Sign in with Google" on X/
  Reddit may still be refused by Google — email/password is reliable).
- v0.7.6 audit fixes verified by typecheck + adversarial diff review (which
  itself caught 3 majors in the first draft: whole-query canonical() would
  have collapsed YouTube watch?v=X&list=Y playlists — now only tracking
  params are stripped; HTML user-id parse could resolve the VIEWER's id —
  removed; isDownloading() guard was defeated by cancelActive nulling
  inflight — now a batchActive flag spans the whole downloadBatch call).
- The cookied POST prober (image carousels while logged in) is implemented
  + typechecked + bundle-compiled but NOT yet verified live — user hit the
  4-image-post error right at session end; retest with a /p/ carousel.
- Convert-side audit fixes (GIF stripAudio stash, trim clamp, first-video
  ClipEditor) not hand-exercised on-device yet.
- Dev-build note: `com.cedrickgd.convertx.dev` has its own app data — its
  logins/cookies.txt are separate from the release app's. Metro loop:
  `npx expo start --dev-client --port 8081` in packages/android +
  `adb reverse tcp:8081 tcp:8081`, launch via
  `adb shell am start -a android.intent.action.VIEW -d
  "convertx://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"
  com.cedrickgd.convertx.dev`.

---

## Key files (Download / login / save / feedback)

```
src/lib/downloadQueue.ts     — probeUrl (detectMediaType, resolveCookiesPath),
                                downloadEntry/Batch, --playlist-items, updateYtDlp
src/lib/instagramStories.ts  — cookied story prober (reels_media, direct-CDN entries)
src/lib/cookies.ts           — per-domain cookies.txt merge/remove + resolveCookiesPath
                                + getCookieHeaderForDomain (JS API probers)
src/lib/loginPlatforms.ts    — platform registry + LOGIN_USER_AGENT
src/components/Feedback.tsx   — Toast + Confirm dialog (useFeedback)
src/components/Navbar.tsx      — sliding animated tab indicator
src/screens/DownloadScreen.tsx        — URL form + adaptive options + preview + done
src/screens/PlatformLoginScreen.tsx   — generic WebView login (clears session first)
src/screens/CreditsScreen.tsx         — PlatformLoginsCard, collapsible AccentColorCard
src/theme/ThemeProvider.tsx           — accent + quickPicks (editable, auto-add)
modules/convert-x-downloader/android/.../ConvertXDownloaderModule.kt
                              — Kotlin: probe/download/saveToGallery/updateYtDlp
```

Native module unchanged since v0.7.0 (v0.7.1–v0.7.4 are JS-only).
youtubedl-android 0.18.1 internals confirmed against the AAR bytecode.

---

## Device / environment

- S26 reconnect + ADB quirks (port rotates on wireless-debug toggle): see
  the `s26-wireless-adb-reconnect` memory.
- Java: `C:\Program Files\Android\openjdk\jdk-21.0.8`
- Android SDK: `C:\Users\cedri\AppData\Local\Android\Sdk`
