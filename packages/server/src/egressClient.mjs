// How the API's children reach the egress proxy.
//
// yt-dlp gets --proxy explicitly (ytdlp.mjs); everything it or the engine
// spawns (ffmpeg, pip, Node for YouTube challenges) gets the same URL via
// the proxy environment variables. In production that URL is the `egress`
// container — the API container has no other route out, so a helper that
// ignored these variables would simply fail to connect.

/** Env for every yt-dlp / pip child. */
export function childEnv(config) {
  const proxy = config.egressProxyUrl;
  return {
    ...process.env,
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    ALL_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    all_proxy: proxy,
    NO_PROXY: "",
    no_proxy: "",
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
  };
}

/**
 * The proxy URL carries EGRESS_TOKEN as credentials; never let it reach a
 * client through a yt-dlp/pip error line.
 */
export function redactEgressToken(text, config) {
  const s = String(text ?? "");
  const token = config?.egressToken;
  return token ? s.split(token).join("***") : s;
}
