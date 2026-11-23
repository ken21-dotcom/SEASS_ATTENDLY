-- Migration 043: restore the fingerprint enrollment flag
--
-- Migration 008 renamed students.fingerprint_enrolled to face_enrolled when
-- the project briefly switched to face recognition. Migration 042 added the
-- fingerprint template store again but never restored the flag, so every
-- syncFingerprintEnrolledFlag() write silently failed on migrated databases.
-- Add the column back and backfill it from the stored finger set.

ALTER TABLE students
    ADD COLUMN IF NOT EXISTS fingerprint_enrolled BOOLEAN NOT NULL DEFAULT FALSE AFTER fingerprint_template;

-- A complete enrollment has exactly ten named finger entries, each with two
-- templates. Anything else stays false until an administrator finishes it.
UPDATE students
SET fingerprint_enrolled = CASE
    WHEN fingerprint_template IS NOT NULL
         AND JSON_VALID(fingerprint_template)
         AND JSON_LENGTH(fingerprint_template) = 10 THEN 1
    ELSE 0
END;
