/**
 * Platforms Convert-X can authenticate to for downloads.
 *
 * yt-dlp reads a single Netscape cookies.txt and picks the cookies whose
 * domain matches the URL being downloaded, so several platforms can share
 * one file — see cookies.ts for the per-domain merge that keeps them from
 * clobbering each other.
 *
 * All platforms use an in-app WebView login. Social "Sign in with Google"
 * buttons open a popup window and Google refuses embedded webviews — the
 * login screen sets a real browser user-agent and routes popups into the
 * main frame to give those the best chance, but email/password is the
 * reliable path (and Google-account sign-in, incl. YouTube, may still be
 * refused by Google). The cookies.txt import in Credits is the fallback.
 */

export type LoginMethod = 'webview';

export type LoginPlatform = {
  key: string;
  label: string;
  method: LoginMethod;
  /** WebView entry URL. */
  loginUrl: string;
  /** Origin handed to CookieManager.get when harvesting. */
  cookieOrigin: string;
  /** Netscape cookie domain (leading dot) written to cookies.txt. */
  cookieDomain: string;
  /** Cookie names whose presence means the login completed (all required). */
  requiredCookies: string[];
  /** One-line reason a user would sign in, shown under the platform name. */
  blurb: string;
  /** Extra hint shown on the login screen (e.g. Google-block caveat). */
  note?: string;
};

export const LOGIN_PLATFORMS: LoginPlatform[] = [
  {
    key: 'instagram',
    label: 'Instagram',
    method: 'webview',
    loginUrl: 'https://www.instagram.com/accounts/login/',
    cookieOrigin: 'https://www.instagram.com/',
    cookieDomain: '.instagram.com',
    requiredCookies: ['sessionid'],
    blurb: 'Private posts, stories & full carousels.',
  },
  {
    key: 'youtube',
    label: 'YouTube',
    method: 'webview',
    // Land back on youtube.com after the Google login so the .youtube.com
    // cookie jar (SAPISID/SID/…) is populated for us to harvest.
    loginUrl: 'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fwww.youtube.com%2F',
    cookieOrigin: 'https://www.youtube.com/',
    cookieDomain: '.youtube.com',
    requiredCookies: ['SAPISID'],
    blurb: 'Age-restricted & members-only videos.',
    note: 'Google may refuse in-app sign-in. If it blocks you, use "Import cookies.txt" in Credits instead.',
  },
  {
    key: 'tiktok',
    label: 'TikTok',
    method: 'webview',
    loginUrl: 'https://www.tiktok.com/login',
    cookieOrigin: 'https://www.tiktok.com/',
    cookieDomain: '.tiktok.com',
    requiredCookies: ['sessionid'],
    blurb: 'Age-restricted or region-locked videos.',
  },
  {
    key: 'twitter',
    label: 'X / Twitter',
    method: 'webview',
    loginUrl: 'https://x.com/i/flow/login',
    cookieOrigin: 'https://x.com/',
    cookieDomain: '.x.com',
    requiredCookies: ['auth_token'],
    blurb: 'Sensitive or protected posts.',
    note: 'Email/password works best. "Sign in with Google" may be refused by Google.',
  },
  {
    key: 'reddit',
    label: 'Reddit',
    method: 'webview',
    loginUrl: 'https://www.reddit.com/login/',
    cookieOrigin: 'https://www.reddit.com/',
    cookieDomain: '.reddit.com',
    requiredCookies: ['reddit_session'],
    blurb: 'NSFW or quarantined posts.',
    note: 'Email/password works best. "Sign in with Google" may be refused by Google.',
  },
  {
    key: 'facebook',
    label: 'Facebook',
    method: 'webview',
    loginUrl: 'https://www.facebook.com/login/',
    cookieOrigin: 'https://www.facebook.com/',
    cookieDomain: '.facebook.com',
    requiredCookies: ['c_user'],
    blurb: 'Private or friends-only videos.',
  },
  {
    key: 'linkedin',
    label: 'LinkedIn',
    method: 'webview',
    loginUrl: 'https://www.linkedin.com/login',
    cookieOrigin: 'https://www.linkedin.com/',
    cookieDomain: '.linkedin.com',
    requiredCookies: ['li_at'],
    blurb: 'Videos & documents from posts.',
  },
];

/**
 * A recent mobile-Chrome user agent for the login WebView. Presenting a
 * real browser UA (instead of the Android WebView default) is what makes
 * several providers — Google especially — willing to render their login.
 */
export const LOGIN_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; SM-S948B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

export function platformByKey(key: string): LoginPlatform | undefined {
  return LOGIN_PLATFORMS.find((p) => p.key === key);
}
