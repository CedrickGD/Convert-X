/**
 * Platforms Convert-X can authenticate to for downloads.
 *
 * yt-dlp reads a single Netscape cookies.txt and picks the cookies whose
 * domain matches the URL being downloaded, so several platforms can share
 * one file — see cookies.ts for the per-domain merge that keeps them from
 * clobbering each other.
 *
 * Most platforms allow signing in inside an embedded WebView. YouTube is
 * the exception: Google actively blocks embedded-webview sign-in ("this
 * browser or app may not be secure"), so it's import-only.
 */

export type LoginMethod = 'webview' | 'cookies';

export type LoginPlatform = {
  key: string;
  label: string;
  method: LoginMethod;
  /** WebView entry URL (webview method only). */
  loginUrl?: string;
  /** Origin handed to CookieManager.get when harvesting (webview only). */
  cookieOrigin?: string;
  /** Netscape cookie domain (leading dot) written to cookies.txt. */
  cookieDomain: string;
  /** Cookie names whose presence means the login completed. */
  requiredCookies: string[];
  /** One-line reason a user would sign in, shown under the platform name. */
  blurb: string;
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
    key: 'youtube',
    label: 'YouTube',
    method: 'cookies',
    cookieDomain: '.youtube.com',
    requiredCookies: [],
    blurb: 'Age-restricted / members-only — import cookies.txt (Google blocks in-app login).',
  },
];

export function platformByKey(key: string): LoginPlatform | undefined {
  return LOGIN_PLATFORMS.find((p) => p.key === key);
}
