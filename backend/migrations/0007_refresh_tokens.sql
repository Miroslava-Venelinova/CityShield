-- Long-lived sessions (see src/core/refresh-tokens.ts).
--
-- Access tokens stay short-lived (JWT_EXPIRE_MINUTES, 60), because an HS256 JWT
-- cannot be revoked once signed. The session that outlives them lives here, in
-- a row we can delete: logout, password reset and theft detection all work by
-- removing rows rather than by hoping a token expires.
--
-- Separate from auth_tokens even though both store a SHA-256 of a mailed-or-held
-- secret: auth_tokens keeps at most one live row per (user, purpose) and issuing
-- deletes the previous one, while a user has one refresh token *per device* and
-- they must not evict each other.
CREATE TABLE refresh_tokens (
    token_hash TEXT NOT NULL PRIMARY KEY,                           -- sha256 hex
    user_id    TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    -- One family per device, preserved across rotations. Rotation replaces the
    -- row but keeps the family, so detecting a replayed token lets us kill that
    -- device's whole chain without touching the user's other devices.
    family_id  TEXT NOT NULL,
    expires_at TEXT NOT NULL,                                       -- ISO-8601 UTC
    used_at    TEXT,                                                -- non-NULL = already rotated
    created_at TEXT NOT NULL
);
-- Logout-everywhere, account deletion and password reset all sweep by user.
CREATE INDEX ix_refresh_tokens_user ON refresh_tokens(user_id);
-- Reuse detection revokes by family.
CREATE INDEX ix_refresh_tokens_family ON refresh_tokens(family_id);
-- Daily cleanup sweeps by expiry.
CREATE INDEX ix_refresh_tokens_expires ON refresh_tokens(expires_at);
