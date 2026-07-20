// ─── src/services/errors.ts ──────────────────────────────────────────────────
// Maps a thrown API error onto a user-facing translation key.
//
// Screens must never render `err.message` directly: those strings are
// developer-facing, always English, and for HTTP failures they used to carry
// the raw server response body straight into an alert dialog.

import {ApiError, NetworkError} from './api';
import type {TranslationKey} from '../i18n/translations';

/**
 * Translation key describing `err` to the user.
 *
 * `fallback` lets a screen supply a more specific message for the common case
 * — e.g. the Login screen prefers "Invalid credentials" over the generic
 * message for a 401, since on that screen a 401 means a bad password rather
 * than an expired session.
 */
export function errorMessageKey(
  err: unknown,
  fallback: TranslationKey = 'error.generic',
): TranslationKey {
  if (err instanceof NetworkError) { return 'error.network'; }

  if (err instanceof ApiError) {
    switch (err.status) {
      // Server-side rate limiting (per-IP, per-email, and per-user limiters).
      case 429: return 'error.rateLimited';
      case 401: return fallback === 'error.generic' ? 'error.session' : fallback;
      case 409: return 'error.duplicateEmail';
      default:  return err.status >= 500 ? 'error.server' : fallback;
    }
  }

  return fallback;
}
