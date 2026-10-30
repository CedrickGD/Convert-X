# Convert-X Android — Resume Plan

Snapshot of where we left off, written to drop back in with zero ramp-up.

---

## v0.9.2 — logged-in stories via the web app's GraphQL queries

Live on the S26U with v0.9.1 (2026-10-30): public posts worked end-to-end,
but stories failed although Credits showed Instagram "Connected". The
cookied `/api/v1/` REST endpoints (`feed/reels_media`, `media/<pk>/info`,
`web/search/topsearch`, `users/web_profile_info`) now answer web sessions
with a generic error ("Da ist leider etwas schiefgelaufen"), `401
require_login` or a `/accounts/login/` redirect even when the session is
valid. The anonymous post path survived only because it was already GraphQL.

Fix (`src/lib/instagramStories.ts`): stories run the exact queries
instagram.com runs, POSTed to `/api/graphql` through the WebView bridge by
`igGraphqlSession` (session cookies + `fb_dtsg` + `lsd` + csrf + `av`,
tokens scraped from the logged-in homepage by `sessionGraphqlTokens`):

- owner id: `PolarisAPITopsearchQuery` (doc_id `40560838120170065`,
  variables `{data:{context:'blended', include_reel:'true', query,
  rank_token, search_session_id, search_surface:'web_top_search'}}`, root
  `xdt_api__v1__fbsearch__topsearch_connection.users[].user.pk`), matched
  on the exact username. Legacy REST `resolveUserId` is the fallback.
- story: `PolarisStoriesV3ReelPageStandaloneQuery` (doc_id
  `29170422829314651`, root `xdt_api__v1__feed__reels_media.reels_media[0]
  .items`) with `{media_id, reel_ids_arr:[ownerId], is_highlight}` — the
  web app's route entrypoint sends both; `media_id` alone yields
  `field_exception` and no items (that was beta.1). Empty answer → one
  retry without `media_id`. Highlights use `reel_ids_arr:['highlight:<id>']`.
- The REST `reels_media` path stays as a fallback; every GraphQL miss is
  logged with the error and the response shape.

Doc ids come from the logged-in story-page JS bundles: search
`<Name>_instagramRelayOperation` → `exports="<id>"`, and the route
entrypoint (`PolarisStoriesV3Root.entrypoint`) shows the variables. Public
bundles are fetchable anonymously; the logged-out pages themselves only
render `PolarisErrorRoot` for non-browser clients.

Verified live on the S26U (release APK `v0.9.2-beta.2`, same commit as the
`v0.9.2` tag): `/stories/lifewit.gaja/4019330390749362563/` probes to all 4
reel items (3 photos + 1 video, including the item that failed that
morning) and all 4 land in the gallery; public reel `/reel/Chunk8-jurw/`
still probes fine.

Still open: logged-in PRIVATE posts use REST `media/<pk>/info` and will
fail the same way (public posts are covered by the anonymous GraphQL).
The logged-in post query is `PolarisPostRootQuery` (doc_id not yet
extracted); needs a private post to test against.

---

## v0.9.1 — Instagram through a real browser + a rate-limit-free engine updater

User report (2026-10-29): logged into Instagram in the app, login succeeds,
every post download still errors; "Update" on the yt-dlp engine card fails
intermittently.

**Root cause 1 — Instagram fingerprints the HTTP client.** Verified from this
PC: curl with a Chrome UA gets a 509 KB JS shell for `/p/<sc>/` (no
`xig_polaris_media`), and `/api/graphql` answers with the homepage HTML
instead of JSON; the identical requests from a real Chromium (the in-app
browser) return the full post JSON. yt-dlp master added `impersonate=` to
every Instagram call for exactly this reason — curl_cffi impersonation,
which does not exist on Android. So React Native's fetch (OkHttp) in the JS
probers AND the bundled yt-dlp both got the bot treatment even with a valid
`sessionid`; the only transport on the phone Instagram accepts is the System
WebView, i.e. the same engine the login happened in.

- `ConvertXDownloaderModule.kt` — **`webFetch` bridge**: one hidden WebView
  (created lazily on the main thread, destroyed in `OnDestroy`). A blank
  document is served by `shouldInterceptRequest` under the target origin
  (`https://www.instagram.com/__convertx_bridge__`), so a `fetch()` run via
  `evaluateJavascript` is same-origin: cookies attach, Origin/Referer/
  Sec-Fetch-* come from Chromium, responses are readable without CORS.
  Results come back through a `@JavascriptInterface` (`ConvertXBridge`).
  Requests are serialized through a queue; `cookieMode: "replace"` installs
  exactly the caller's cookies into `CookieManager` (expiring everything else
  the jar holds for the origin), `"keep"` sends the jar as-is; the jar string
  for the origin is returned with every response. Rejects
  `WEBVIEW_UNAVAILABLE` when the device has no usable WebView.
- `src/lib/instagramNet.ts` (new) — `igRequest(url, {mode})`: `session` mode
  installs the cookies.txt Instagram cookies (deduped per name, apex-domain
  line wins), `anonymous` guarantees no session cookie rides along. The jar is
  only re-synced when cookies.txt changed (fingerprint) or the mode flipped;
  after a logged-in response the jar is written BACK into cookies.txt (only
  while it still carries `sessionid` — a jar that lost it means the server
  logged us out, and persisting that would silently delete the user's login).
  `transportEpoch` bumps on every jar replace so anonymous tokens (LSD) can't
  outlive their jar. Falls back to plain `fetch` + manual `Cookie` header when
  the bridge is unavailable or absent (old native build under new JS).
- `src/lib/instagramStories.ts` — all API calls via `igApiJson`, which
  classifies every refusal shape into `InstagramError.kind`: login-wall
  redirect (`/accounts/login`, `/challenge`), 401/403, HTML-where-JSON,
  `{"message": "login_required|checkpoint_required|feedback_required|…"}`.
  Messages are user-actionable ("login has expired — sign in again under
  Credits", "confirm it's you in the Instagram app", "rate-limiting this
  device"). New **`probeInstagramPostAnonymous`**: the web app's own
  logged-out GraphQL query (`doc_id 27130156389949648`,
  `PolarisLoggedOutDesktopWWWPostRootContentQuery`, LSD token from the
  homepage, csrftoken from the jar after `get_ruling_for_content`) — full
  carousels + videos for public posts with NO login; verified live in a real
  browser: 3-video carousel + muted reel both return `video_versions`.
  `resolveUserId` now re-throws an auth failure instead of "Could not resolve
  user" when all three endpoints refused for auth reasons.
- `src/lib/instagramScraper.ts` — embed prober rewritten around the page's
  `contextJSON` → `gql_data.shortcode_media` (every carousel child, real
  `video_url`s). A video post whose embed only carries the poster
  (`is_video` true, no `video_url` — copyright-blocked reels) now throws
  `login_required` instead of handing back a JPG for a video.
- `src/lib/downloadQueue.ts` — **post chain** `probeInstagramPostChain`:
  cookied API (logged in) → logged-out GraphQL → embed → cookied yt-dlp. When
  all fail, `composeInstagramError` surfaces the most actionable classified
  error (checkpoint > expired > rate-limited > login-required > not-found)
  instead of yt-dlp's "exited 1". Instagram gates now use
  `hasLoginCookiesForDomain('instagram.com', ['sessionid'])` — "some cookie
  line exists" is no longer "logged in" (an anonymous visit writes
  csrftoken/mid too). Story/profile probers re-throw `expired`/`checkpoint`
  rather than falling to yt-dlp with the same dead cookies.
- `DownloadScreen` `needsLogin` regex extended to the new messages so the
  one-tap "Log in to Instagram" button shows for them.

**Root cause 2 — youtubedl-android's updater uses the GitHub REST API**
(`api.github.com/repos/yt-dlp/yt-dlp/releases/latest`), limited to 60
requests/hour per IP; on carrier NAT that is HTTP 403 much of the time.

- `ConvertXDownloaderModule.kt` `updateYtDlp` rewritten: latest tag from the
  `/releases/latest` → `/releases/tag/<ver>` redirect (no API), asset from
  `/releases/download/<tag>/yt-dlp`, SHA-256 checked against the release's
  `SHA2-256SUMS` (when fetchable) plus a `ZipFile` open test
  (`yt_dlp/__init__.py` present), staged in the SAME dir and swapped in with
  `renameTo` — atomic, so a killed app can never leave a torn zipapp (the old
  in-place `FileUtils.copyFile` was the source of the "bad local file header"
  corruption). Writes the library's own prefs keys (`dlpVersion`,
  `dlpVersionName`) so `YoutubeDL.version()` stays truthful, plus
  `convertxDlpUpdatedAt`. `getYtDlpVersion` reads `yt_dlp/version.py` out of
  the zipapp on disk (the prefs don't know the bundled build's version).
  `{force, checkOnly}` options; `ALREADY_UP_TO_DATE` only when the tag
  matches AND the on-disk zip is loadable.
- `downloadQueue.ts` — `runPeriodicYtDlpUpdate` (daily, silent; replaces the
  once-a-calendar-month check); `refreshEngineAfterFailure`: a yt-dlp probe
  failing with an extractor-rot signature (`unable to extract`, `yt-dlp -U`,
  `Confirm you are on`, 403, …) triggers one engine refresh (hourly throttle)
  and ONE retry when a newer build was actually installed. Credits engine
  card shows the installed yt-dlp version and says it checks daily.

**Found on the emulator / in the adversarial review (fixed before the final tag):**
Android's `java.util.zip.ZipFile` cannot open the shebang-prefixed zipapp
(the updater rejected every download as "not a loadable zipapp" and the
version reader returned nothing) — now read with `ZipInputStream` from the
first `PK`. The engine is never swapped under a running yt-dlp
process (lazy imports would read the new archive at old offsets, and the
corruption recovery would then wipe it): probe/download count processes,
an update that lands mid-run is parked as `yt-dlp.pending` (status
`DEFERRED`) and installed by `beginEngineProcess()` before the next spawn.
`instagramNet` records the jar state BEFORE the native call (the Kotlin
side replaces the jar at dequeue even if the fetch then fails), clears it on
failure or when a logged-in response comes back without `sessionid`, and
the bridge-unavailable latch is a 2-minute back-off instead of permanent;
`PlatformLoginScreen` resets the transport after its `clearAll`. Share-sheet
links (`instagram.com/share/…`) are resolved through the bridge first;
`reels/audio/` is not a post. `composeInstagramError` weights the cookied
API's verdict above the anonymous steps for a logged-in user. The app
updater's feed fallback throws on transport errors instead of reporting "up
to date". GraphQL `data: null` / Relay errors classify as `other`, not
`login_required`.

Verification: `npx tsc --noEmit` clean; `:convert-x-downloader:compileDebugKotlin`
compiles locally (needs `android/local.properties` with
`sdk.dir=C:/Users/cedri/AppData/Local/Android/Sdk` — forward slashes, the file
is gitignored). Request recipes verified in a real browser against public
posts. On-device (emulator `ConvertX_Test`, port 5562, release APK
`v0.9.1-beta.2`): daily check installed yt-dlp 2026.10.26 on launch (file +
prefs verified), the Credits card reports "Already up to date (2026.10.26)";
anonymous carousel `/p/BQ0eAlwhDrw/` probes to 3 video entries in ~9 s and all
three download into the gallery; reel `/reel/Chunk8-jurw/` probes to a video
entry. `v0.9.1` is tagged on the same commit (9a7c128).

Not verified: a LOGGED-IN run (no test account on this machine) — the
transport is identical for anonymous and session mode, so the bridge test
covers the mechanism; the session-specific parts (cookie install/write-back)
are reviewed, not exercised.

---

## Old-Android compatibility (armv7 + API 24 hardening)

The friend's phone couldn't install the APK. Root cause was almost certainly
the ABI: we only shipped `arm64-v8a`, and many budget/older phones run a 32-bit
userspace (armeabi-v7a) even on a 64-bit SoC, so the arm64 APK fails with *"App
not installed — isn't compatible with your phone"*. Everything below landed to
fix that and to harden the app down to its real floor, **Android 7.0 (API 24)**.
API 24 is the hard floor of the stack (RN 0.81 / Expo 54 / ffmpeg-kit fork /
youtubedl-android 0.18 all declare minSdk 24); Android 6 and older cannot be
supported.

- **Ship two per-ABI APKs.** `app/build.gradle` `splits.abi` now defaults to
  `arm64-v8a,armeabi-v7a` via a `-Pconvertx.splitAbis` property;
  `gradle.properties` sets `reactNativeArchitectures=armeabi-v7a,arm64-v8a`
  (dropped x86/x86_64) and **pins `android.minSdkVersion=24`** so a dependency
  bump can't silently raise the floor. For an x86_64 API-24 emulator pass
  `-PreactNativeArchitectures=x86_64 -Pconvertx.splitAbis=x86_64`.
- **Updater ABI picker rewritten** (`src/lib/updater.ts`). `pickAssetForAbi` now
  matches **exact asset names** in `Build.SUPPORTED_ABIS` **preference order**
  (never re-sorted). A 64-bit phone always gets arm64 (and self-heals a mistaken
  32-bit install); a 32-bit-userspace phone (no arm64-v8a in its list) only ever
  gets armv7. **The 32-bit asset is published as `app-armv7-release.apk`** — the
  substring "armeabi" is kept OUT of the name on purpose, because clients up to
  v0.8.2 sort ABIs longest-first and would otherwise pull `armeabi-v7a` (11
  chars) ahead of `arm64-v8a` (9) and move every arm64 phone to the 32-bit build.
  `ASSETS_FOR_ABI` still accepts the Gradle default `app-armeabi-v7a-release.apk`
  as a fallback for locally-built releases.
- **Gallery saves on Android 7–9 (API 24–28).** The pre-scoped-storage copy
  path needs a runtime `WRITE_EXTERNAL_STORAGE` grant that was never requested.
  The JS wrapper (`modules/convert-x-downloader/src/index.ts`, owned by the
  Android-feature unit) requests it; `ConvertXDownloaderModule.kt` now guards the
  `< 29` branch and throws a clear `NO_STORAGE_PERMISSION` / `MKDIR_FAILED`
  instead of a buried EACCES.
- **TLS on Android 7.0.** API 24 predates ISRG Root X1 in the system trust
  store, so GitHub release-asset downloads (Let's Encrypt chain) and any
  Let's-Encrypt backend fail the handshake. Added a network security config
  (`res/xml/network_security_config.xml`) trusting the system store **plus the
  bundled ISRG Root X1 and X2** (`res/raw/isrg_root_x{1,2}.pem`, SHA-256-verified
  against letsencrypt.org before committing). `cleartextTrafficPermitted="false"`
  matches the release default; identical `src/debug` + `src/debugOptimized`
  copies permit cleartext so Metro over http still works (a net-sec config
  disables `usesCleartextTraffic` on API 24+).
- **h264_mediacodec fallback (H3).** `src/lib/conversionQueue.ts` retries a
  failed hardware-H.264 encode once with the software `mpeg4` encoder — old or
  32-bit vendor MediaCodec stacks can have no working H.264 encoder and
  ffmpeg-kit has no automatic fallback.
- **Release pipeline.** `android-release.yml` fails fast if either per-ABI APK
  is missing, renames the 32-bit one to `app-armv7-release.apk`, and lists both
  (plus a "Requires Android 7.0+" note) in the Downloads table.
  `desktop-release.yml` links the armv7 asset too; `dev-build.yml` stays
  arm64-only via `-P` flags.

Not yet verified on a real 32-bit / API-24 device — no local Android toolchain
on this machine (CI is the build path). Typecheck + the updater-matcher unit
test pass.

---

## Current state

**Latest release:** v0.8.2 (tag `v0.8.2`) — icon recolour: **white on black**.

v0.8.1's silver gradient (`#f2f4f7` → `#9aa1ab`) on a `#2a2a2e` plate topped out
around 4:1 contrast and read as washed out at launcher size. Now flat
`#ffffff` on flat `#000000` (~21:1). Changed in the SVG sources, not the
rasters — `source-cx.svg` / `source-cx-fg.svg` in
`../desktop/src-tauri/icons/` — then regenerated via `npm run icons`.

The background colour is declared in THREE places that must agree:
`icon-manifest.json` `bg_color` (tints the knockout gap baked into the
foreground PNGs), `res/values/colors.xml` `@iconBackground` (what the launcher
paints), and `app.json` `adaptiveIcon.backgroundColor` (what `expo prebuild`
would regenerate colors.xml from). If they drift, the knockout stops matching
the background and a visible seam appears through the glyph, so
`gen-icons.js` now asserts all three match and exits non-zero if not.

Known trade-off, accepted deliberately: a pure-black plate has no silhouette
on pure-dark surfaces (the Settings app-info screen, a black wallpaper) — only
the white glyph shows. It looks right in the app drawer over a wallpaper,
which is where it actually gets launched from. If that ever grates, bump
`bg_color` to `#0d0d0f` and re-run `npm run icons`; nothing else needs to change.

> NOTE: the SVG sources are shared with the DESKTOP Tauri icon set, so
> `packages/desktop/src-tauri/icons/*.png` are now stale relative to them.
> Regenerate the desktop set before the next desktop release.

**Previous release v0.8.1** (tag `v0.8.1`) — icon pipeline repair.

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

**Upload the GitHub assets as `app-arm64-v8a-release.apk` and
`app-armv7-release.apk`** (CI renames Gradle's `app-armeabi-v7a-release.apk` to
the latter), not the friendly `Convert-X-Android-<ver>.apk` that `copy-apk.js`
produces: `updater.ts`'s `pickAssetForAbi` now matches assets by **exact name**
(`ASSETS_FOR_ABI`), so a differently-named asset is invisible to every installed
client. The 32-bit name deliberately omits "armeabi" — see the compat section
at the top for why.

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
`app-arm64-v8a-release.apk` + `app-armv7-release.apk`. CI runs the gradle build only (no tsc/lint), so
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
