-- Email verification + password reset (see src/core/auth-tokens.ts).
--
-- Existing accounts stay NULL = unverified: enforcement is soft (the app
-- nudges, login still works), so back-filling would be a lie about which
-- addresses were ever confirmed.
ALTER TABLE users ADD COLUMN email_verified_at TEXT;

-- One table for both link types; `purpose` keeps them from being interchangeable.
-- Only the SHA-256 of the token is stored, so a database leak cannot be replayed
-- into account takeovers — same reasoning as password_hash.
CREATE TABLE auth_tokens (
    token_hash TEXT PRIMARY KEY,                                    -- sha256 hex
    user_id    TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    purpose    TEXT NOT NULL,                                       -- verify_email | reset_password
    expires_at TEXT NOT NULL,                                       -- ISO-8601 UTC
    used_at    TEXT,                                                -- NULL = still redeemable
    created_at TEXT NOT NULL
);
-- Issuing a token first deletes the user's older ones of the same purpose.
CREATE INDEX ix_auth_tokens_user_purpose ON auth_tokens(user_id, purpose);
-- Daily cleanup sweeps by expiry.
CREATE INDEX ix_auth_tokens_expires ON auth_tokens(expires_at);
