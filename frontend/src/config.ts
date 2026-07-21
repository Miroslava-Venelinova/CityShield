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

// OneSignal app id (dashboard → Settings → Keys & IDs). Inlined at bundle time
// like the API URL above. Not a secret — it identifies the app, and the REST
// API key that can actually send is backend-only. A release build without it
// would install fine and then never receive a push, so fail loudly instead.
const ONESIGNAL_ID = process.env.ONESIGNAL_APP_ID;

if (!__DEV__ && !ONESIGNAL_ID) {
  throw new Error(
    'ONESIGNAL_APP_ID was not set when this release bundle was built. ' +
      'Export it before bundling, e.g. ONESIGNAL_APP_ID=00000000-0000-0000-0000-000000000000',
  );
}

export const ONESIGNAL_APP_ID = ONESIGNAL_ID ?? '';
