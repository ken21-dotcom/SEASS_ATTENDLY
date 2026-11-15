-- Migration 042: fingerprint templates for kiosk attendance
--
-- The kiosk pivots from QR codes to the DigitalPersona U.are.U 4500.
-- A fingerprint template is an opaque string produced by the scanner
-- capture bridge; the prototype stores it as-is and matches it with a
-- direct string comparison. QR token columns are intentionally untouched
-- during the transition.
--
-- attendance_records.verification_method gains 'fingerprint' so a scan
-- can be told apart from the legacy QR and manual paths in reports.

ALTER TABLE students
    ADD COLUMN fingerprint_template LONGTEXT NULL AFTER block;

ALTER TABLE attendance_records
    MODIFY COLUMN verification_method ENUM('face', 'manual', 'qr', 'fingerprint') NOT NULL;
