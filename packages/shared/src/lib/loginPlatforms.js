/**
 * Platforms Convert-X can authenticate to for downloads.
 *
 * yt-dlp reads a single Netscape cookies.txt and picks the cookies whose
 * domain matches the URL being downloaded, so several platforms can share
 * one file — see cookies.js for the per-domain merge that keeps them from
 * clobbering each other.
 *
 * All platforms use the in-app login window (a dedicated webview opened by
 * the desktop side). Social "Sign in with Google" buttons open a popup
 * window and Google refuses embedded webviews — email/password is the
 * reliable path (and Google-account sign-in, incl. YouTube, may still be
 * refused by Google). The cookies.txt import in Credits is the fallback.
 *
 * Registry entry shape:
 *   key            stable identifier ('instagram', …)
 *   label          display name
 *   method         'webview'
 *   loginUrl       login window entry URL
 *   cookieOrigin   origin polled for cookies while the login window is open
 *   cookieDomain   Netscape cookie domain (leading dot) written to cookies.txt
 *   requiredCookies  cookie names whose presence means the login completed
 *   blurb          one-line reason a user would sign in
 *   note           optional extra hint (e.g. Google-block caveat)
 */

export const LOGIN_PLATFORMS = [
  {
    key: "instagram",
    label: "Instagram",
    method: "webview",
    loginUrl: "https://www.instagram.com/accounts/login/",
    cookieOrigin: "https://www.instagram.com/",
    cookieDomain: ".instagram.com",
    requiredCookies: ["sessionid"],
    blurb: "Private posts, stories & full carousels.",
  },
  {
    key: "youtube",
    label: "YouTube",
    method: "webview",
    // Land back on youtube.com after the Google login so the .youtube.com
    // cookie jar (SAPISID/SID/…) is populated for us to harvest.
    loginUrl: "https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fwww.youtube.com%2F",
    cookieOrigin: "https://www.youtube.com/",
    cookieDomain: ".youtube.com",
    requiredCookies: ["SAPISID"],
    blurb: "Age-restricted & members-only videos.",
    note: 'Google may refuse in-app sign-in. If it blocks you, use "Import cookies.txt" in Credits instead.',
  },
  {
    key: "tiktok",
    label: "TikTok",
    method: "webview",
    loginUrl: "https://www.tiktok.com/login",
    cookieOrigin: "https://www.tiktok.com/",
    cookieDomain: ".tiktok.com",
    requiredCookies: ["sessionid"],
    blurb: "Age-restricted or region-locked videos.",
  },
  {
    key: "twitter",
    label: "X / Twitter",
    method: "webview",
    loginUrl: "https://x.com/i/flow/login",
    cookieOrigin: "https://x.com/",
    cookieDomain: ".x.com",
    requiredCookies: ["auth_token"],
    blurb: "Sensitive or protected posts.",
    note: 'Email/password works best. "Sign in with Google" may be refused by Google.',
  },
  {
    key: "reddit",
    label: "Reddit",
    method: "webview",
    loginUrl: "https://www.reddit.com/login/",
    cookieOrigin: "https://www.reddit.com/",
    cookieDomain: ".reddit.com",
    requiredCookies: ["reddit_session"],
    blurb: "NSFW or quarantined posts.",
    note: 'Email/password works best. "Sign in with Google" may be refused by Google.',
  },
  {
    key: "facebook",
    label: "Facebook",
    method: "webview",
    loginUrl: "https://www.facebook.com/login/",
    cookieOrigin: "https://www.facebook.com/",
    cookieDomain: ".facebook.com",
    requiredCookies: ["c_user"],
    blurb: "Private or friends-only videos.",
  },
  {
    key: "linkedin",
    label: "LinkedIn",
    method: "webview",
    loginUrl: "https://www.linkedin.com/login",
    cookieOrigin: "https://www.linkedin.com/",
    cookieDomain: ".linkedin.com",
    requiredCookies: ["li_at"],
    blurb: "Videos & documents from posts.",
  },
];

/**
 * A recent desktop-Chrome user agent for the login window. Presenting a
 * real browser UA is what makes several providers — Google especially —
 * willing to render their login. The SAME constant is used by the
 * Instagram API prober (igApiFetch): cookies minted under this UA must be
 * probed under it, or Instagram rejects the session with a "useragent
 * mismatch".
 */
export const LOGIN_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export function platformByKey(key) {
  return LOGIN_PLATFORMS.find((p) => p.key === key);
}
