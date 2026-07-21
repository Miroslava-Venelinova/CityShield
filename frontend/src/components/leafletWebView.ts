// ─── src/components/leafletWebView.ts ────────────────────────────────────────
// Shared, hardened setup for the two Leaflet-in-a-WebView maps (AlertMap and
// LocationPickerMap).
//
// Both render inside a `javaScriptEnabled` WebView that holds a postMessage
// bridge into the app, and AlertMap additionally renders scraped,
// LLM-processed third-party data. That combination is why the settings below
// are deliberately restrictive rather than the react-native-webview defaults.

import type {WebViewProps} from 'react-native-webview';

/** Pinned Leaflet release. Bumping this REQUIRES recomputing both SRI hashes:
 *    curl -sL https://unpkg.com/leaflet@<ver>/dist/leaflet.js \
 *      | openssl dgst -sha512 -binary | openssl base64 -A
 *  A stale hash fails closed — the map will not render at all.
 */
export const LEAFLET_VERSION = '1.9.4';

const LEAFLET_JS_SRI =
  'sha512-BwHfrr4c9kmRkLw6iXFdzcdWV/PGkVgiIyIWLLlTSXzWQzxuSg4DiQUCpauz/EWjgk5TYQqX/kvn9pG1NpYfqg==';
const LEAFLET_CSS_SRI =
  'sha512-Zcn6bjR/8RZbLEpLIeOwNtzREBAJnUKESxces60Mpoj+2okopSAcSUIUOseddDm0cxnGQzxIR7vJgsLZbdLE3w==';

/**
 * `<head>` contents: viewport, a locked-down CSP, and Leaflet loaded with
 * Subresource Integrity.
 *
 * SRI is the important part. Without it, a CDN compromise or a
 * TLS-intercepting proxy could serve arbitrary JavaScript straight into a
 * WebView that can post messages back into the app.
 *
 * `'unsafe-inline'` for script-src is unavoidable: the map bootstrap runs as an
 * inline script and RN's `injectJavaScript` bridge also evaluates inline. The
 * origin allowlist is what carries the value here — `default-src 'none'` means
 * anything not named below cannot load at all.
 */
export const LEAFLET_HEAD = `
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"/>
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  script-src https://unpkg.com 'unsafe-inline';
  style-src https://unpkg.com 'unsafe-inline';
  img-src https://tile.openstreetmap.org https://*.tile.openstreetmap.org https://unpkg.com data:;
  connect-src 'none';
  form-action 'none';
  base-uri 'none';
  frame-ancestors 'none';
"/>
<link rel="stylesheet"
      href="https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.css"
      integrity="${LEAFLET_CSS_SRI}"
      crossorigin="anonymous"/>
<script src="https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.js"
        integrity="${LEAFLET_JS_SRI}"
        crossorigin="anonymous"></script>`;

/**
 * Page-side half of the "map inside a ScrollView" fix, injected into both map
 * documents (they define `post` before including it).
 *
 * The problem: on Android the parent ScrollView claims a vertical drag that
 * started inside the WebView, so trying to pan the map scrolled the whole
 * Home screen instead. The RN side reacts by disabling the ScrollView for the
 * duration of the gesture — but it can only put scrolling *back* once it knows
 * the touch is over, and a native child swallows the touch-end that the
 * responder system would otherwise report. So the page tells us directly.
 *
 * `touchcancel` matters as much as `touchend`: it is what fires if the
 * platform tears the gesture away mid-pan, and without it the ScrollView would
 * stay disabled for good.
 */
export const MAP_GESTURE_SCRIPT = `
  (function () {
    var active = false;
    function start() {
      if (active) { return; }
      active = true;
      post({ type: 'gestureStart' });
    }
    function end(e) {
      // Multi-touch pinch: only release once the last finger is up.
      if (!active || (e && e.touches && e.touches.length > 0)) { return; }
      active = false;
      post({ type: 'gestureEnd' });
    }
    document.addEventListener('touchstart', start, { passive: true });
    document.addEventListener('touchend', end, { passive: true });
    document.addEventListener('touchcancel', end, { passive: true });
  })();`;

/**
 * Security props shared by both maps.
 *
 * Neither page ever legitimately navigates: they are fixed local documents.
 * The previous `originWhitelist={['*']}` with no load guard meant any link —
 * including one reachable through injected content — could navigate the
 * WebView to an arbitrary origin while keeping the RN bridge attached.
 */
export const hardenedWebViewProps: Partial<WebViewProps> = {
  originWhitelist: ['about:blank'],
  onShouldStartLoadWithRequest: req => {
    // Only the initial in-place load of our own HTML is permitted. The OSM
    // attribution link is the one thing a user might plausibly tap; dropping
    // it is better than opening it inside a privileged WebView.
    const allowed =
      req.url === 'about:blank' || req.url.startsWith('data:text/html');
    if (!allowed) {
      console.warn(`Map WebView: blocked navigation to ${req.url}`);
    }
    return allowed;
  },
  javaScriptEnabled: true,
  // Neither map persists anything, so storage and filesystem reach are pure
  // attack surface here.
  domStorageEnabled: false,
  allowFileAccess: false,
  allowFileAccessFromFileURLs: false,
  allowUniversalAccessFromFileURLs: false,
  javaScriptCanOpenWindowsAutomatically: false,
  // Tiles and Leaflet are HTTPS; refuse any downgrade.
  mixedContentMode: 'never',
  setSupportMultipleWindows: false,
  overScrollMode: 'never',
  // Android: let the WebView win the drag against an enclosing ScrollView
  // instead of forwarding it upward the moment it moves vertically.
  nestedScrollEnabled: true,
};

/**
 * Guards a number before it is interpolated into generated page JavaScript.
 * Rejects NaN/Infinity, which would otherwise reach `setView` and leave the
 * map blank with no error.
 */
export function safeCoord(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
