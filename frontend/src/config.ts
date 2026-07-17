// ─── src/config.ts ────────────────────────────────────────────────────────────
// Single place for environment-dependent settings.
//
// __DEV__ is set by Metro: true for debug builds, false for release builds.
//
// Dev:  10.0.2.2 is the Android emulator's alias for the host machine's
//       localhost — change the port if your ASP.NET launch profile differs.
// Prod: the URL is injected at bundle time from the CITYSHIELD_API_URL env
//       var (inlined by babel-plugin-transform-inline-environment-variables,
//       see babel.config.js). It must be HTTPS; Android release builds block
//       cleartext HTTP unless explicitly allowed. A release bundle built
//       without it fails immediately at startup instead of shipping a
//       placeholder URL.

declare const process: {env: {[key: string]: string | undefined}};

const PROD_API_URL = process.env.CITYSHIELD_API_URL;

if (!__DEV__ && !PROD_API_URL) {
  throw new Error(
    'CITYSHIELD_API_URL was not set when this release bundle was built. ' +
      'Export it before bundling, e.g. CITYSHIELD_API_URL=https://api.example.com',
  );
}

export const API_BASE_URL = __DEV__ ? 'http://10.0.2.2:5276' : PROD_API_URL!;

// Public privacy policy (required by Google Play and GDPR). Overridable at
// bundle time so the hosted URL can change without a code edit.
export const PRIVACY_POLICY_URL =
  process.env.CITYSHIELD_PRIVACY_POLICY_URL ??
  'https://stunnybg.github.io/CityShield/privacy-policy';
