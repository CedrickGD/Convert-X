# convertx-api gateway (Cloudflare Worker)

`https://convertx-api.rr-admin-panel.workers.dev` is the only public entry point for the Convert-X web
build's network needs:

- **Discord / GIF stealing on the web (public, no key).** Browsers can't read some media hosts
  (no CORS) and can't set the headers some pages need. The Worker fetches allowlisted Discord, Tenor,
  Giphy and Klipy media for them, and resolves Klipy page links through the Klipy API.
- **URL downloader on the web (keyed).** `/v1/dl/*` checks the user's access key and forwards the
  request to the NAS (`packages/server`) over a **Workers VPC** binding. The NAS has no public
  hostname, so this Worker is its only way in.

It has no npm dependencies. Wrangler bundles `src/index.js` together with the shared allowlist from
`packages/shared/src/core/discordMedia.js`.

## Routes

| Route | Auth | What it does |
|---|---|---|
| `GET /v1/health` | none | `{ok, service:"convertx-gateway", downloader, klipy}`. Shows whether the VPC binding and the Klipy key are set. |
| `GET\|HEAD /v1/media?url=` | none | Fetches an allowlisted media URL (`isAllowedMediaHost`: https only, Discord CDN/media/images-ext, Tenor media + view/short/oEmbed pages, Giphy, Klipy static; no userinfo, no ports, no IP literals). Redirects are followed only while they stay on the allowlist (max 5). The upstream status is passed through, files are capped at 50 MB, edge-cached for a day on 2xx, and the reply carries `X-Final-Url`. |
| `GET /v1/resolve/klipy?type=&slug=` | none | `type` ∈ `gifs\|stickers\|clips\|memes`. Returns `{title, files:{hd\|md\|sm\|xs:{gif\|webp\|mp4\|webm\|jpg:{url,width,height,size}}}}`, or `501` when `KLIPY_API_KEY` isn't set. |
| `GET /v1/file/:jobId?t=` | job token | Streams a finished download from the NAS (`/jobs/:id/file`). Range requests are passed through. |
| `* /v1/dl/<path>` | `Authorization: Bearer <access key>` | Forwarded to `http://convertx-api:8080/<path>?<query>` through `env.NAS`, with `X-ConvertX-Origin-Key`, `X-ConvertX-Key-Id` (the key's name) and `X-ConvertX-Client-IP` (from `CF-Connecting-IP`). The user's key never reaches the NAS. If there is no binding or the tunnel is down, the answer is `503 {"error":"Downloader offline"}`. |

**CORS.** Public routes answer `Access-Control-Allow-Origin: *`. `/v1/dl/*` and `/v1/file/*` reflect
the `Origin` only if it appears in `ALLOWED_ORIGINS` or is a Pages preview
(`https://<branch>.convert-x-online.pages.dev`), and add `Vary: Origin`. Preflight (`OPTIONS`) answers
`204` and allows `Authorization, Content-Type, Range` and `GET, HEAD, POST, DELETE, OPTIONS` for one
day. Every `/v1/*` response carries `Cross-Origin-Resource-Policy: cross-origin`, because the site runs
with COEP `require-corp`.

## Configuration

`wrangler.toml` holds the name, the `ALLOWED_ORIGINS` var, and a **commented** `[[vpc_services]]`
block. Secrets are set with `npx wrangler secret put <NAME>`:

| Secret | Value |
|---|---|
| `ACCESS_KEYS` | `name:key,name2:key2`. Each key must be at least 16 characters (`openssl rand -hex 24`). Entries that don't parse are ignored, with a warning in `wrangler tail`. |
| `ORIGIN_KEY` | Identical to `ORIGIN_KEY` in the NAS `env/api.env`. |
| `KLIPY_API_KEY` | Optional. A free key from partner.klipy.com. Without it, Klipy *page* links can't be resolved (direct `static.klipy.com` links still work). |

## Deploy

Before you start, follow steps 1–5 of [`packages/server/README.md`](../server/README.md): the NAS
running, the tunnel `convertx-nas` connected, and the VPC service `convertx-api` (HTTP 8080, hostname
`convertx-api`) created, with its service ID copied.

```bash
cd packages/gateway
npx wrangler login                      # once, in a browser; pick the rr-admin-panel account
npm test                                # 30 node:test cases, no network
npm run check                           # wrangler deploy --dry-run: bundles, lists bindings

# 1. Bind the NAS: in wrangler.toml uncomment the block and paste the id
#    [[vpc_services]]
#    binding = "NAS"
#    service_id = "<SERVICE_ID>"
#    `npm run check` must now list "env.NAS (…) VPC Service".

# 2. Secrets
npx wrangler secret put ORIGIN_KEY
npx wrangler secret put ACCESS_KEYS
npx wrangler secret put KLIPY_API_KEY   # optional

# 3. Ship
npx wrangler deploy                     # → https://convertx-api.rr-admin-panel.workers.dev
curl -s https://convertx-api.rr-admin-panel.workers.dev/v1/health
# {"ok":true,"service":"convertx-gateway","downloader":true,"klipy":true}
```

If your login can see more than one Cloudflare account, set `CLOUDFLARE_ACCOUNT_ID` (the account that
owns the `rr-admin-panel.workers.dev` subdomain) before `wrangler deploy`.

The web build defaults to this URL. A different gateway can be set at build time with
`VITE_CONVERTX_GATEWAY`. To let another site origin use the keyed routes, add it to `ALLOWED_ORIGINS`
in `wrangler.toml` and redeploy.

## Operating it

- **Logs**: `npx wrangler tail convertx-api`. Workers Logs (observability) is enabled in
  `wrangler.toml`.
- **Rotate an access key**: add the new pair to `ACCESS_KEYS` and put the secret, then remove the old
  pair and put it again. A secret change takes effect within seconds and needs no redeploy.
- **Rotate `ORIGIN_KEY`**: see *Rotating keys* in the server README. The NAS briefly accepts
  `new,old`, so there's no downtime.
- **Downloader offline (503)**: check the tunnel first (`docker compose ps` on the NAS), then the VPC
  service's host and port. `/v1/health` → `"downloader": false` means the binding isn't deployed.
- **Abuse of `/v1/media`**: it only reaches the allowlisted media hosts, is capped at 50 MB, and is
  cached at the edge. If it is ever abused, add a Cloudflare rate-limiting rule for `/v1/media` on the
  Worker route, or a `[[ratelimits]]` binding.

## Tests

`npm test` imports the Worker's default export and calls `fetch(request, env)` in Node 22, with a fake
`env.NAS` and a stubbed global `fetch`. The tests cover CORS reflection and preflight, access-key
checks (constant-time, every key compared), media allowlist rejections (private hosts, wrong hosts,
userinfo, ports, http, path tricks), redirect re-validation, the 50 MB cap, status passthrough, HEAD,
Klipy (501, normalisation, error mapping without leaking the key), `/v1/file` passthrough, and
`/v1/dl` forwarding headers, plus the 503 when the NAS is missing or unreachable.
