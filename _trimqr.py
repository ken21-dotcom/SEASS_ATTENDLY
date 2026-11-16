p = 'tools/attendance-checkin.api.test.php'
s = open(p, encoding='utf-8').read()

# 1. Replace header + requires + qrSecret block
old_header = """/**
 * End-to-end tests for the server-verified kiosk QR check-in,
 * plus the user token-exposure and sanction-review route contracts.
 *
 * Proves the whole path against a real PHP server and MySQL:
 * a student requests an event-scoped token -> an officer scans it at that
 * event -> attendance row; duplicate/window/inactive/wrong-event guards.
 * Anonymous and student sessions must never be able to record a QR check-in.
 * Staff listings and profile updates must never carry QR tokens, and the
 * sanction review route accepts only integer ids.
 *
 * Run: php tools/qr-check-in.api.test.php
 */

require __DIR__ . '/../attendly-backend/config/db.php';
require __DIR__ . '/../attendly-backend/src/PublicIdGenerator.php';
require __DIR__ . '/../attendly-backend/src/QrToken.php';

error_reporting(E_ALL);
set_error_handler(static function (int $severity, string $message, string $file, int $line): void {
    throw new ErrorException($message, 0, $severity, $file, $line);
});

use Attendly\\PublicIdGenerator;
use Attendly\\QrToken;

$root = dirname(__DIR__);
$backend = $root . '/attendly-backend';
$config = require $backend . '/config/config.php';
$qrSecret = (string) ($config['qr_hmac_secret'] ?? '');
if (strlen($qrSecret) < 32) {
    fwrite(STDERR, "config/config.php is missing a 32+ character qr_hmac_secret.\\n");
    exit(1);
}

$db = get_db();"""

new_header = """/**
 * End-to-end tests for the kiosk check-in paths (manual entry and
 * fingerprint) plus the user token-exposure and sanction-review route
 * contracts.
 *
 * Proves the whole path against a real PHP server and MySQL:
 * an officer records manual attendance; the local matching service turns
 * captured images into templates and identifies students at an event;
 * duplicate/window/inactive/wrong-event guards hold. Anonymous and student
 * sessions must never be able to record a check-in. Staff listings and
 * profile updates must never carry fingerprint templates, and the sanction
 * review route accepts only integer ids.
 *
 * Run: php tools/attendance-checkin.api.test.php
 */

require __DIR__ . '/../attendly-backend/config/db.php';
require __DIR__ . '/../attendly-backend/src/PublicIdGenerator.php';

error_reporting(E_ALL);
set_error_handler(static function (int $severity, string $message, string $file, int $line): void {
    throw new ErrorException($message, 0, $severity, $file, $line);
});

use Attendly\\PublicIdGenerator;

$root = dirname(__DIR__);
$backend = $root . '/attendly-backend';
$config = require $backend . '/config/config.php';

$db = get_db();"""

assert old_header in s, "header block not found"
s = s.replace(old_header, new_header)

# 2. Remove the qr_token_for() helper
helper = """
function qr_token_for(int $studentId, int $eventId): string
{
    global $qrSecret;
    return QrToken::generateEventToken($studentId, $eventId, $qrSecret);
}

"""
assert helper in s, "helper not found"
s = s.replace(helper, "")

# 3. Remove the QrToken unit-level block
unit_start = "    // ─ Unit-level checks on event-scoped QrToken before HTTP wiring ──\n"
unit_end = "    }\n\n    // ─ Seed accounts through the real registration endpoint so the\n"
i = s.index(unit_start)
j = s.index(unit_end, i)
s = s[:i] + s[j:]

# 4. Remove the qr-token route tests + login qrToken exposure test
qr_route_start = "    test('student can request an event-scoped QR token', function () use ($studentA, $studentAId, $openEventId, $qrSecret): void {\n"
qr_route_end = "    test('login and /auth/me expose the student public id', function () use ($studentA): void {\n"
i = s.index(qr_route_start)
j = s.index(qr_route_end, i)
s = s[:i] + s[j:]

# 5. Remove the /auth/me qrToken exposure test
me_start = "    test('/auth/me does not expose a permanent qrToken', function () use ($studentA): void {\n"
me_end = "    test('student profile save treats contactNumber as optional', function () use ($studentA, $suffix): void {\n"
i = s.index(me_start)
j = s.index(me_end, i)
s = s[:i] + s[j:]

# 6. Remove the two qrToken-leak tests
leak1_start = "    test('staff listing other students does not leak qr tokens', function () use ($db, $officer): void {\n"
leak2_end = "    test('sanction report endpoint returns the semester matrix', function () use ($admin): void {\n"
i = s.index(leak1_start)
j = s.index(leak2_end, i)
s = s[:i] + s[j:]

# 7. Update stdout banner
s = s.replace('    fwrite(STDOUT, "qr-check-in.api.test.php\\n");',
              '    fwrite(STDOUT, "attendance-checkin.api.test.php\\n");')

open(p, 'w', encoding='utf-8').write(s)
print("done")