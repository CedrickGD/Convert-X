# convertx-api: the downloader on the NAS

This service lets the **web build** download from URLs. It runs yt-dlp on the UGREEN NAS at home, and
the internet reaches it only through the gateway Worker (`packages/gateway`) over **Workers VPC**. There
is no public hostname, no open router port and no published container port.

```
browser (convert-x-online.pages.dev)
   │ fetch + CORS, "Authorization: Bearer <access key>"
   ▼
Worker convertx-api.rr-admin-panel.workers.dev      (packages/gateway)
   │ env.NAS.fetch("http://convertx-api:8080/…") + X-ConvertX-Origin-Key
   ▼  Workers VPC service → Cloudflare Tunnel (outbound from the NAS)
NAS: compose project "convertx"
   ├─ cloudflared  (TUNNEL_TOKEN, no public hostname)      networks: internal + outbound
   ├─ api          (Node 22 + yt-dlp + ffmpeg, alias convertx-api:8080)  network: internal ONLY
   └─ egress       (same image; the forward proxy, :8899)  networks: internal + outbound
```

Inside the NAS the containers sit on two networks:

```
                 Cloudflare                     internet (public addresses, ports 80/443/8080/8443)
                     ▲                                  ▲
 outbound ───────────┼──────────────────────────────────┼──────────  ordinary bridge with NAT
                cloudflared                       egress :8899
 internal ───────────┼──────────────────────────────────┼──────────  internal: true — no gateway, no
                     ▼ convertx-api:8080                │             route to the LAN or the internet
                 api :8080 ──── all outbound traffic ───┘
                               (proxy + EGRESS_TOKEN)
```

- **api** is attached to the `internal` network only. It can talk to `egress:8899` and be reached by
  cloudflared, and nothing else: no LAN (Home Assistant, the router, IP cameras), no internet. Every
  outbound request it makes — yt-dlp, the ffmpeg/Node helpers yt-dlp starts, `pip` for engine updates,
  and its own `/http`, `/direct` and `/image` fetches — goes through the egress proxy and carries
  `EGRESS_TOKEN`.
- **egress** runs the same image with `node src/egressMain.mjs`. It is the only container with a way
  out, and it only speaks HTTP proxy (CONNECT for https, absolute-URI for http). It resolves every
  destination itself and refuses anything that isn't a public address on an allowed port.
- **cloudflared** joins `internal` to reach `convertx-api:8080` and `outbound` to reach Cloudflare.

The Discord sticker stealer does **not** use this. It works on the web without an access key, through
the gateway's public `/v1/media` and `/v1/resolve/klipy` routes.

This project is **completely separate** from the RazorReaper stack on the same NAS. It has its own
compose project (`convertx`), its own tunnel, its own directories and its own keys. Nothing here
touches `/volume1/docker/razorreaper`.

---

## Layout on the NAS

```
/volume1/docker/convertx/
├── src/Convert-X/                 git clone (only packages/server is needed)
│   └── packages/server/           compose project dir: compose.yml, .env
├── data/                          → /data in the api container (uid 1000)
│   ├── jobs/<id>/{out,tmp}        per-job staging, wiped at start, swept after JOB_TTL_MIN
│   └── cookies.txt                optional
└── env/                           secrets, chmod 600
    ├── api.env                    ORIGIN_KEY (+ optional tuning)
    ├── egress.env                 EGRESS_TOKEN (read by api AND egress)
    └── tunnel.env                 TUNNEL_TOKEN
```

---

## First-time setup

You need SSH access to the NAS (`cedrick.grabe@192.168.2.201`), the Cloudflare account that owns
`rr-admin-panel.workers.dev`, and `npx wrangler` on your workstation (logged in with `npx wrangler login`).

### 1. Directories and code (NAS)

```bash
ssh cedrick.grabe@192.168.2.201
sudo mkdir -p /volume1/docker/convertx/{src,data,env}
sudo chown -R 1000:1000 /volume1/docker/convertx/data    # the container runs as uid 1000 (node)
sudo chown "$USER" /volume1/docker/convertx/src /volume1/docker/convertx/env
chmod 700 /volume1/docker/convertx/env

cd /volume1/docker/convertx/src
# Only packages/server is needed, so a sparse clone keeps the NAS copy small.
git clone --filter=blob:none --sparse https://github.com/CedrickGD/Convert-X.git
cd Convert-X && git sparse-checkout set packages/server
cd packages/server && cp .env.example .env          # paths only, no secrets
docker compose version                              # needs Compose v2
```

### 2. Secrets (NAS)

```bash
cd /volume1/docker/convertx/src/Convert-X/packages/server
cp api.env.example    /volume1/docker/convertx/env/api.env
cp egress.env.example /volume1/docker/convertx/env/egress.env
cp tunnel.env.example /volume1/docker/convertx/env/tunnel.env
chmod 600 /volume1/docker/convertx/env/*.env
openssl rand -hex 32        # → ORIGIN_KEY. Keep it: the Worker needs the same value (step 6)
nano /volume1/docker/convertx/env/api.env           # ORIGIN_KEY=<that value>
# EGRESS_TOKEN: a second, different random value. Only the two containers ever see it.
sed -i "s/^EGRESS_TOKEN=.*/EGRESS_TOKEN=$(openssl rand -hex 32)/" /volume1/docker/convertx/env/egress.env
```

### 3. Create the tunnel (Cloudflare dashboard)

1. Cloudflare dashboard → **Workers VPC** (in the Compute / Workers section of the sidebar) →
   **Tunnels** → **Create**. The same tunnel also shows under *Zero Trust → Networks → Tunnels*.
2. Name it `convertx-nas` and pick **Docker** as the environment.
3. From the shown `docker run … --token <TOKEN>` command, copy **only the token**. Put it in
   `/volume1/docker/convertx/env/tunnel.env` as `TUNNEL_TOKEN=<TOKEN>`.
4. **Do not add a public hostname or route.** Workers VPC reaches the service privately through the
   tunnel, and a public hostname would expose the API to the internet.
5. Copy the tunnel's **ID** (a UUID). You need it in step 5.

### 4. Start it (NAS)

```bash
cd /volume1/docker/convertx/src/Convert-X/packages/server
YTDLP_REFRESH=$(date +%F) docker compose up -d --build    # builds convertx-api:local once, for api + egress
docker compose ps                                   # egress: healthy, api: healthy, cloudflared: running
docker compose logs -f cloudflared                  # expect "Registered tunnel connection" ×4
docker compose exec api node -e "fetch('http://127.0.0.1:8080/health').then(r=>r.text()).then(console.log)"
# → {"ok":true,"service":"convertx-api","ytdlp":"2026.xx.xx","running":0,"queued":0}
docker compose logs api | grep listening            # … "egress":"remote egress:8899","egressToken":"set"
docker compose logs egress | grep listening         # … "token":"required"
```

Check that the segmentation is real (both must fail — the api container has no route out):

```bash
docker compose exec api node -e "require('net').connect(443,'1.1.1.1').on('connect',()=>{console.log('OPEN — WRONG');process.exit(1)}).on('error',e=>console.log('blocked:',e.code))"
docker compose exec api node -e "require('net').connect(80,'192.168.2.1').on('connect',()=>{console.log('OPEN — WRONG');process.exit(1)}).on('error',e=>console.log('blocked:',e.code))"
# → blocked: ENETUNREACH (or EHOSTUNREACH / ETIMEDOUT)
```

### 5. Create the VPC service (Cloudflare dashboard or wrangler)

The service tells Workers VPC what to connect to **behind** the tunnel. `convertx-api` is resolved by
cloudflared, which uses Docker's DNS on the `internal` compose network.

*Dashboard:* **Workers VPC → VPC Services → Create**
- Service name: `convertx-api`
- Tunnel: `convertx-nas`
- Host or IP address: **hostname** `convertx-api`
- Ports: **HTTP 8080** (no HTTPS)
- DNS resolver: the tunnel's (default)
- **Create service**, then copy the **Service ID**.

*Or wrangler (workstation):*

```bash
npx wrangler vpc service create convertx-api --type http --http-port 8080 \
  --hostname convertx-api --tunnel-id <TUNNEL_ID>
# prints the service id
```

Never point a VPC service at `egress`: it would turn the proxy into an internet proxy for whoever can use
the binding (the token would still be required, but there is no reason to expose it).

### 6. Deploy the gateway Worker (workstation)

Full details are in [`packages/gateway/README.md`](../gateway/README.md). In short:

```bash
cd packages/gateway
# wrangler.toml: uncomment [[vpc_services]], set service_id = "<SERVICE_ID>"
npx wrangler secret put ORIGIN_KEY      # same value as in api.env
npx wrangler secret put ACCESS_KEYS     # e.g. cedrick:<openssl rand -hex 24>,friend:<…>
npx wrangler secret put KLIPY_API_KEY   # optional (Discord GIF picker links)
npx wrangler deploy
```

### 7. Verify end to end

```bash
G=https://convertx-api.rr-admin-panel.workers.dev
curl -s $G/v1/health                     # "downloader": true
curl -s -H "Authorization: Bearer <access key>" $G/v1/dl/health
curl -s -H "Authorization: Bearer <access key>" -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=jNQXAC9IVRw"}' $G/v1/dl/probe
```

In the web app, paste the access key in the Download tab. A probe and a download should then work.

---

## Day-to-day

### Updating the code

```bash
cd /volume1/docker/convertx/src/Convert-X && git pull
cd packages/server && YTDLP_REFRESH=$(date +%F) docker compose up -d --build
```

`api` and `egress` share the `convertx-api:local` image, so always rebuild with plain
`docker compose up -d --build` (not `… api`): both containers are recreated on the new image.
`cloudflared` is left alone.

### Updating yt-dlp

Sites break yt-dlp every few weeks. There are three ways to get a newer version:

- **Automatic.** Once a day, starting 5 minutes after boot, the api container runs
  `pip install -U "yt-dlp[default]"` into its venv, through the egress proxy
  (`YTDLP_AUTO_UPDATE_HOURS`, `0` turns it off).
- **On demand.** `POST /v1/dl/engine/update` with an access key returns
  `{"status":"DONE"|"ALREADY_UP_TO_DATE","version":"…"}`. The web app's "Update engine" button does
  this.
- **Rebuild.** `YTDLP_REFRESH=$(date +%F) docker compose up -d --build`. The build arg busts the
  cached pip layer, so the new image ships the newest yt-dlp. A recreated container otherwise falls
  back to the version baked into the image until the next automatic update.

New jobs and probes wait while an update runs. Jobs that are already running finish normally.

### Rotating keys

**Access keys** (users) are the `ACCESS_KEYS` secret on the Worker, written as `name:key,name2:key2`
with every key at least 16 characters long. To rotate, add the new pair, run
`npx wrangler secret put ACCESS_KEYS`, hand out the new key, then remove the old pair and put the
secret again. Each key's name shows up in the NAS logs as `keyId`, and the hourly job budget is counted
per name.

**ORIGIN_KEY** (Worker ↔ NAS) can be rotated with no downtime:

1. Set `ORIGIN_KEY=<new>,<old>` in `env/api.env`, then run `docker compose up -d api`. The NAS now
   accepts both keys.
2. `npx wrangler secret put ORIGIN_KEY` with `<new>`.
3. Set `ORIGIN_KEY=<new>` in `env/api.env` and run `docker compose up -d api`.

**EGRESS_TOKEN** (api ↔ egress) lives in one file both containers read. Put a new value in
`env/egress.env`, then `docker compose up -d --force-recreate api egress`. Downloads are interrupted for
the few seconds the two containers restart.

**TUNNEL_TOKEN**: in the dashboard, open the tunnel and choose *Refresh token*. Put the new token in
`env/tunnel.env`, then run `docker compose up -d cloudflared`.

### Cookies (optional)

Some content needs a login, for example age-restricted YouTube or private posts. For those, put a
Netscape `cookies.txt` at `/volume1/docker/convertx/data/cookies.txt`, owned by uid 1000 and mode 600.
Every job gets a private copy of the file, so concurrent jobs never corrupt it. If YouTube refuses a
stale jar ("Requested format is not available"), the job retries once without cookies, the same way the
desktop app does.

---

## Security model

- **No inbound path except the tunnel.** Compose publishes no ports. Workers VPC is the only client, and
  the Worker is the only holder of the VPC binding.
- **Two keys.** Users present an *access key* to the Worker. The Worker then presents `ORIGIN_KEY`
  (`X-ConvertX-Origin-Key`, compared in constant time) to the NAS. Every route needs it except
  `GET /health` and `GET /jobs/:id/file?t=<token>`, where the token is 32 random bytes per job and is
  also compared in constant time.
- **Network segmentation.** The api container is on an `internal: true` network with no gateway, so
  nothing it runs can open a connection to the LAN, the NAS's other services or the internet directly —
  not yt-dlp, not ffmpeg, not a protocol nobody thought of. The only thing it can reach is the egress
  proxy (and cloudflared, whose metrics endpoint is bound to its own loopback).
- **Egress proxy (SSRF guard).** One proxy, one policy, used by everything:
  - It accepts only proxy requests — CONNECT `host:port` for https, absolute-URI `GET`/`HEAD`/`POST`
    for http — and, with `EGRESS_TOKEN` set, only from clients that send it
    (`Proxy-Authorization: Basic`, the token as password; everything else gets `407`).
  - For each request it resolves the host once and **refuses if any address is private, loopback,
    link-local, CGNAT, multicast, documentation or otherwise reserved**. That covers IPv4 and IPv6,
    including v4-mapped, NAT64 and 6to4 addresses. It then connects to exactly the vetted address, so
    DNS rebinding can't swap it. Only ports in `EGRESS_ALLOWED_PORTS` are allowed. This classification
    lives only here (`src/ipguard.mjs`, used by `src/egressProxy.mjs`).
  - yt-dlp gets it via `--proxy http://convertx:<token>@egress:8899`; ffmpeg, Node and pip via
    `HTTP(S)_PROXY`. ffmpeg answers the proxy's `407` challenge with the same credentials.
  - The api's own fetches (`/http`, `/direct`, `/image`) tunnel through it too: https as CONNECT, then
    TLS over the tunnel with SNI and certificate verification against the real host name; http as an
    absolute-URI request. The api keeps the per-request policy: http/https only, ports 80/443, no
    credentials in URLs, redirects followed by hand (at most 5, each hop re-checked, https → http
    refused, cookies/authorization dropped on a host change), and for `/http` and `/direct` a host
    allowlist (Twitter/X syndication and twimg, Instagram/cdninstagram/fbcdn, the Discord CDNs, Tenor,
    Giphy, and Klipy static).
- **Only HTTP(S) media.** yt-dlp hands ffmpeg some downloads (non-native HLS, section downloads,
  RTMP), and ffmpeg's rtsp/rtmp/mms/udp clients ignore HTTP proxies. Every job therefore passes
  `--downloader-args "ffmpeg_i:-protocol_whitelist crypto,data,http,https,tcp,tls,httpproxy
  -format_whitelist hls,dash,mpegts,mov,matroska,flv,aac,mp3,ac3,eac3,webvtt,ogg,wav,flac"`, which
  yt-dlp puts in front of every `-i` it gives ffmpeg. Both lists are needed: `rtmp://`, `mms…`, `udp://`
  and `file:` are protocols and fall to the first, but ffmpeg implements RTSP as a *demuxer* that opens
  a raw `tcp` connection itself (and `tcp` must stay allowed for http), so only the second stops
  `rtsp://`. Tested with real yt-dlp + ffmpeg: rtsp/rtmp inputs are refused before any connection, while
  https HLS (MPEG-TS, fMP4 and audio renditions) and YouTube section downloads still work through the
  proxy. yt-dlp itself refuses non-HTTP schemes, the image ships no rtmpdump, and `POST /jobs` /
  `/probe` only take http(s) URLs. The whitelist is not airtight on its own: `tcp` and `httpproxy`
  must stay allowed (they carry http and the CONNECT tunnel), so an input — or an HLS segment —
  written as `tcp://host:port` or `httpproxy://host:port/…` still makes ffmpeg dial that host
  directly, past the proxy. On the NAS that connection dies on the `internal` network (the real
  containment); with `EGRESS_MODE=inprocess` (local dev) nothing stops it.
- **Disk.** `/data` lives on the pool the NAS shares with everything else, so:
  - `--max-filesize MAX_FILESIZE` stops downloads whose size is known up front;
  - a watchdog sums each running job's staging dir every 2 s and stops the job past
    `MAX_FILESIZE × 2` (video and audio before the merge) — this covers live/HLS/chunked streams whose
    size yt-dlp can't know;
  - a finished file bigger than `MAX_FILESIZE` is refused;
  - `--match-filters "!is_live"` skips live streams altogether;
  - no job starts while `/data` has less than `MIN_FREE_GB` (default 20) free; `POST /jobs` answers 503.
- **Limits.** `MAX_CONCURRENT_JOBS`, `MAX_QUEUE`, `JOBS_PER_KEY_PER_HOUR`, a 30-minute hard stop per
  job, a 1 GB memory / 2 CPU / 256-process cap on the api container (256 MB / 1 CPU / 64 on egress),
  `no-new-privileges`, all capabilities dropped, a non-root user, root-owned code, and a read-only
  egress container.
- **Cleanup.** Cancelling a job kills yt-dlp's whole process group (SIGTERM, then SIGKILL after 5 s)
  and deletes its staging directory. Finished files are deleted after `JOB_TTL_MIN`, and `/data/jobs`
  is wiped at every start.
- **What is left.** Depending on the Docker version, a container on an internal network may still reach
  the Docker host's own address on that bridge. Nothing in the api container speaks to it on purpose
  (all HTTP goes to the proxy), but a host firewall rule
  dropping traffic from the `convertx_internal` subnet to the host is cheap belt and braces. Public
  hostnames that resolve to your own WAN address reach whatever the router port-forwards — the same
  services the internet already reaches.

---

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Gateway `/v1/health` says `"downloader": false` | The `[[vpc_services]]` block is still commented out, or the Worker was deployed before you added it. Fix `wrangler.toml` and redeploy. |
| `503 {"error":"Downloader offline"}` | The tunnel is down, or the VPC service points at the wrong host/port. Run `docker compose ps` (is `cloudflared` running?) and `docker compose logs --tail=50 cloudflared`. The dashboard's VPC service must be `convertx-api` / HTTP **8080** on tunnel `convertx-nas`. |
| `401 {"error":"Unauthorized"}` from `/v1/dl/*` | `ORIGIN_KEY` differs between `env/api.env` and the Worker secret. Set both to the same value, then run `docker compose up -d api`. |
| `401 {"error":"Invalid access key"}` | The key is not in the Worker's `ACCESS_KEYS`, is shorter than 16 characters, or the pair is malformed. `npx wrangler tail` shows a warning for ignored entries. |
| `api` restarts with `startup failed … ORIGIN_KEY` / `EGRESS_TOKEN` | `env/api.env` is missing the key or a key is shorter than 16 characters; or `env/egress.env` has a token with characters other than `A-Z a-z 0-9 . _ ~ -`. |
| `api` stays `Created` / waits | `egress` isn't healthy yet: `docker compose logs egress`. |
| Errors "The downloader can't reach its egress proxy" / `Request failed: Can't reach the egress proxy` | `egress` is down or restarting: `docker compose ps egress`, `docker compose up -d egress`. |
| Error "…its egress proxy refused it (EGRESS_TOKEN differs…)" | The two containers run with different tokens — usually one was recreated after `env/egress.env` changed and the other wasn't. `docker compose up -d --force-recreate api egress`. `docker compose logs egress \| grep "auth failed"` shows the attempts. |
| `EACCES … /data/jobs` in `docker compose logs api` | The data dir isn't owned by uid 1000: `sudo chown -R 1000:1000 /volume1/docker/convertx/data`. |
| Job error "That link leads to a private or local network address…" | The egress guard did its job: the URL, or a URL the site redirected to, points into a private range. `docker compose logs egress \| grep "egress blocked"` shows the host and the reason. |
| Job error "…streams over a protocol the web downloader doesn't fetch" | The site handed yt-dlp an RTSP/RTMP/MMS (or other non-HTTP) stream. Use the desktop app for those. |
| Job error "This download is bigger than the server's size limit" | It passed `MAX_FILESIZE` (or twice that while downloading). Raise `MAX_FILESIZE` in `env/api.env` if the disk allows. |
| Job error "This is a live stream…" | Live streams are skipped on purpose. Try again once the stream has ended and is a normal video. |
| `503 The downloader is low on disk space` | `/data` has less than `MIN_FREE_GB` free. Free space on the volume (`df -h /volume1`), or lower `MIN_FREE_GB`. |
| Job error "requires sign-in" or "Sign in to confirm you're not a bot" | Add `cookies.txt` (see above), or wait. YouTube rate-limits per IP. |
| Many sites fail with "Unable to extract …" | yt-dlp is out of date: `POST /v1/dl/engine/update`, or rebuild with `YTDLP_REFRESH`. |
| `503 The downloader is busy` / `429 Hourly download limit reached` | Queue or per-key budget is full. Raise `MAX_QUEUE` / `JOBS_PER_KEY_PER_HOUR` in `api.env` if needed. |
| Health check `unhealthy` | `docker compose logs --tail=100 api` (or `egress`). Both log one JSON line per event, and never log keys, tokens or query strings. |

Useful commands:

```bash
docker compose logs -f api egress | grep -E '"level":"(warn|error)"'
docker compose exec api /opt/ytdlp/bin/yt-dlp --version
docker compose exec api du -sh /data/jobs
docker compose logs egress | grep -E '"egress (blocked|auth failed)"'
docker compose restart api
```

To see every destination egress lets through, add `- LOG_LEVEL=debug` to the `egress` service's
`environment:` in `compose.yml` and run `docker compose up -d egress` (not in `egress.env`: the api reads
that file too).

---

## Configuration

### `env/api.env` (api container)

| Variable | Default | Meaning |
|---|---|---|
| `ORIGIN_KEY` | **required** | Worker ↔ NAS secret. Every key must be at least 16 characters; `new,old` is allowed during a rotation. |
| `PORT` | `8080` | Listen port inside the container (compose sets it). |
| `DATA_DIR` | `/data` | Staging + cookies (compose sets it). |
| `MAX_CONCURRENT_JOBS` | `2` | yt-dlp downloads at once. |
| `MAX_QUEUE` | `20` | Waiting jobs before `503`. |
| `JOBS_PER_KEY_PER_HOUR` | `40` | Per access-key name, sliding hour. |
| `JOB_TTL_MIN` | `30` | Finished files are deleted after this. |
| `JOB_TIMEOUT_MIN` | `30` | Hard stop per download. |
| `MAX_FILESIZE` | `2G` | yt-dlp `--max-filesize`, the `/direct` cap and the finished-file cap. A running job stops past twice this. |
| `MIN_FREE_GB` | `20` | No new jobs while `/data` has less free space (`0` = off). |
| `MAX_CONCURRENT_PROBES` | `4` | Concurrent `POST /probe`s (4× that may wait). |
| `PROBE_TIMEOUT_SEC` | `90` | A probe is stopped after this. |
| `YTDLP` / `PIP` | `/opt/ytdlp/bin/yt-dlp` / `…/pip` | Binaries (set by the image). |
| `FFMPEG_DIR` | `/usr/bin` | Passed as `--ffmpeg-location`. |
| `EGRESS_MODE` | `inprocess` | `remote` in compose: use the `egress` container. `inprocess` starts the proxy inside this process on `127.0.0.1` (local development). |
| `EGRESS_HOST` | `egress` | Proxy host in `remote` mode (compose sets it). |
| `EGRESS_PROXY_PORT` | `8899` | Proxy port (compose sets it). |
| `EGRESS_TOKEN` | *(none)* | From `env/egress.env`. Sent to the proxy as `Proxy-Authorization: Basic`. |
| `EGRESS_ALLOWED_PORTS` | `80,443,8080,8443` | Only used in `inprocess` mode. |
| `COOKIES_FILE` | `/data/cookies.txt` | Used when it exists and isn't empty. |
| `YTDLP_AUTO_UPDATE_HOURS` | `24` | `0` turns the automatic update off. |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error`. |

### `env/egress.env` (egress container, and api for the token)

| Variable | Default | Meaning |
|---|---|---|
| `EGRESS_TOKEN` | *(none, warns)* | Shared secret; requests without it get `407`. 16–256 of `A-Z a-z 0-9 . _ ~ -` (`openssl rand -hex 32`). |
| `EGRESS_ALLOWED_PORTS` | `80,443,8080,8443` | Destination ports the proxy may connect to. |
| `EGRESS_LISTEN_HOST` | `0.0.0.0` | Listen address inside the container (compose sets it; nothing is published). That covers both of its networks; the only other member of `outbound` is cloudflared, and the token is required either way. |
| `EGRESS_PROXY_PORT` | `8899` | Listen port (compose sets it). |

Keep only `EGRESS_*` settings in `egress.env`: the api reads the file too.

---

## API (behind the gateway)

All routes except the first and the file download need `X-ConvertX-Origin-Key`. The gateway exposes
them as `/v1/dl/<route>`, except the file download, which is `/v1/file/:id?t=`.

| Route | Answer |
|---|---|
| `GET /health` | `{ok, service:"convertx-api", ytdlp, running, queued}` |
| `POST /probe {url}` | The desktop `ProbeResult` (`kind`, `title`, `uploader`, `thumbnail`, `entries[{index,title,thumbnail,duration,kind,url,webpage_url}]`), or `4xx/5xx {error}`. |
| `POST /http {url,method?,headers?,body?,timeoutMs?}` | `{status, body, headers}` like the desktop `http_request`. Any upstream status resolves; on timeout the reply is `504 {error:"Request timed out after Nms"}`. |
| `GET /direct?url=&name=` | Upstream bytes with `Content-Disposition`. An upstream non-2xx comes back with the **same status** and an `X-Upstream-Status` header; this service's own errors have no such header. |
| `GET /image?url=` | An image from any public host, up to 10 MB. Non-images get `415`. |
| `POST /jobs {url,format,quality,playlistItems?,noPlaylist?,dedupeNames?}` | `202 {jobId, token}`. `429` when the per-key budget is used up, `503` when the queue is full or `/data` is low on space. |
| `GET /jobs/:id` | `{jobId, state:"queued"\|"running"\|"done"\|"error"\|"cancelled", progress, stage, elapsed:"MM:SS", error, fileName, size, title}` |
| `GET /jobs/:id/file?t=` | The file, with `Content-Disposition`, `Content-Length` and Range support. No origin key needed. |
| `DELETE /jobs/:id` | Cancels a queued or running job, or deletes a finished one (`removed: true`). |
| `POST /engine/update` | `{status:"DONE"\|"ALREADY_UP_TO_DATE", version}` |

The yt-dlp arguments, format selectors, primary-file pick, progress parsing, error wording and
YouTube cookie retry are a line-for-line port of `packages/desktop/src-tauri/src/downloader.rs`, so the
web build gets what the desktop gets. The server adds a few things on top: `--proxy` (the egress proxy),
`--max-filesize`, `--match-filters "!is_live"`, the ffmpeg `--downloader-args` protocol and format whitelists,
`--js-runtimes node` for YouTube, and a 180-byte cap on the title in the output template (Linux file
names are limited to 255 bytes).

---

## Local development

No npm install is needed (there are zero dependencies). Node 22 and a yt-dlp binary are enough:

```bash
cd packages/server
npm test                                    # node:test, no network, fake yt-dlp, real local proxies

# One process (EGRESS_MODE=inprocess, the default): the proxy runs inside the API on 127.0.0.1.
# Run against a real yt-dlp (e.g. a venv: python -m venv .venv && .venv/bin/pip install "yt-dlp[default]")
ORIGIN_KEY=dev-origin-key-0123456789 DATA_DIR=./.data PORT=8080 HOST=127.0.0.1 \
YTDLP=.venv/bin/yt-dlp PIP=.venv/bin/pip FFMPEG_DIR=/usr/bin YTDLP_AUTO_UPDATE_HOURS=0 MIN_FREE_GB=0 \
npm start
curl -s -H "X-ConvertX-Origin-Key: dev-origin-key-0123456789" -H "Content-Type: application/json" \
  -d '{"url":"https://www.youtube.com/watch?v=jNQXAC9IVRw","format":"mp4","quality":"480"}' localhost:8080/jobs

# Or the production split, as two processes:
EGRESS_LISTEN_HOST=127.0.0.1 EGRESS_TOKEN=dev-egress-token-0123456789 node src/egressMain.mjs &
EGRESS_MODE=remote EGRESS_HOST=127.0.0.1 EGRESS_TOKEN=dev-egress-token-0123456789 \
ORIGIN_KEY=dev-origin-key-0123456789 DATA_DIR=./.data PORT=8080 HOST=127.0.0.1 \
YTDLP=.venv/bin/yt-dlp PIP=.venv/bin/pip YTDLP_AUTO_UPDATE_HOURS=0 MIN_FREE_GB=0 node src/main.mjs
```

It runs on Windows too (yt-dlp.exe from a venv, ffmpeg from winget). There, process trees are ended
with `taskkill /T` instead of process groups. Outside Docker nothing takes the API's own route away,
so locally the proxy is the only guard; the compose networks add the hard boundary on the NAS.
