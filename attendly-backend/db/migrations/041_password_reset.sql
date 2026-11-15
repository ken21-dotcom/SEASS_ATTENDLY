-- Migration 041: password reset flow
--
-- The forgot-password flow needs a one-time, time-boxed token stored on the
-- user row so a stateless link can be validated at reset time. Both columns
-- are nullable: existing accounts have no pending reset and the token is
-- cleared the moment a reset succeeds.

ALTER TABLE users
    ADD COLUMN password_reset_token VARCHAR(64) NULL AFTER otp_expires_at,
    ADD COLUMN password_reset_expires TIMESTAMP NULL AFTER password_reset_token;

CREATE INDEX idx_users_reset_token ON users (password_reset_token);