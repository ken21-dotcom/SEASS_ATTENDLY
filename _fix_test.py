s = open('tools/attendance-checkin.api.test.php', 'r', encoding='utf-8').read()
# Fix the migration block
old = """    $db->exec('ALTER TABLE students ADD COLUMN fingerprint_template LONGTEXT NULL AFTER block');
}
$verificationColumn = $db->query("SHOW COLUMNS FROM attendance_records LIKE 'verification_method'")->fetch();"""

new = """$fingerprintColumns = $db->query("SHOW COLUMNS FROM students LIKE 'fingerprint_template'")->fetchAll();
if (!$fingerprintColumns) {
    $db->exec('ALTER TABLE students ADD COLUMN fingerprint_template LONGTEXT NULL AFTER block');
}
$verificationColumn = $db->query("SHOW COLUMNS FROM attendance_records LIKE 'verification_method'")->fetch();"""

assert old in s, "block not found"
s = s.replace(old, new)

# Also remove duplicate comment
old2 = """// matching verification_method enum value. The suite runs against the
// developer database, which may predate a migration, so make the two schema
// pieces idempotent here rather than failing every request that lists users.
// developer database, which may predate a migration, so make the two schema
// pieces idempotent here rather than failing every request that lists users."""

new2 = """// matching verification_method enum value. The suite runs against the
// developer database, which may predate a migration, so make the two schema
// pieces idempotent here rather than failing every request that lists users."""

assert old2 in s, "comment block not found"
s = s.replace(old2, new2)

open('tools/attendance-checkin.api.test.php', 'w', encoding='utf-8').write(s)
print("Fixed")