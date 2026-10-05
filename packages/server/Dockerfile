# convertx-api — the Convert-X downloader for the NAS (yt-dlp + ffmpeg + Node 22).
# Build context = this directory (compose.yml builds it once as convertx-api:local):
#   docker build -t convertx-api .
# No npm dependencies: only src/ and package.json are copied.
#
# One image, two containers (compose.yml):
#   api     node src/main.mjs        (default CMD)  — internal network only
#   egress  node src/egressMain.mjs                  — the only way out

FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1

# python3-venv for the yt-dlp venv, ffmpeg for merges/audio extraction,
# tini as PID 1 (forwards SIGTERM, reaps the yt-dlp process groups).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp in its own venv, owned by the runtime user so POST /engine/update (and
# the daily auto-update) can upgrade it in place. "[default]" brings yt-dlp-ejs,
# which runs YouTube's player challenges on the image's own Node.
# YTDLP_REFRESH only busts this layer's cache: pass a date to pull a fresh
# yt-dlp on rebuild (README → "Updating yt-dlp").
ARG YTDLP_REFRESH=
RUN echo "yt-dlp refresh: ${YTDLP_REFRESH:-none}" \
 && python3 -m venv /opt/ytdlp \
 && /opt/ytdlp/bin/pip install "yt-dlp[default]" \
 && /opt/ytdlp/bin/yt-dlp --version \
 && chown -R node:node /opt/ytdlp \
 && mkdir -p /data \
 && chown node:node /data

# The code stays root-owned: the runtime user can read it, not rewrite it.
WORKDIR /app
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    YTDLP=/opt/ytdlp/bin/yt-dlp \
    PIP=/opt/ytdlp/bin/pip \
    FFMPEG_DIR=/usr/bin \
    EGRESS_PROXY_PORT=8899

USER node
EXPOSE 8080
# No VOLUME: compose mounts /data into api only; egress runs read-only.
# The api's check; compose overrides it for egress (a TCP connect to :8899).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["tini", "--"]
CMD ["node", "src/main.mjs"]
