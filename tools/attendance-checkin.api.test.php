<?php

declare(strict_types=1);

/**
 * End-to-end tests for fingerprint/manual kiosk attendance,
 * plus student profile and sanction-review route contracts.
 *
 * Proves the whole path against a real PHP server and MySQL:
 * Fingerprint matching and manual entry must record attendance with the
 * expected duplicate/window guards. The sanction review route accepts only
 * integer ids.
 *
 * Run: php tools/attendance-checkin.api.test.php
 */

require __DIR__ . '/../attendly-backend/config/db.php';
require __DIR__ . '/../attendly-backend/src/PublicIdGenerator.php';

error_reporting(E_ALL);
set_error_handler(static function (int $severity, string $message, string $file, int $line): void {
    throw new ErrorException($message, 0, $severity, $file, $line);
});

use Attendly\PublicIdGenerator;

$root = dirname(__DIR__);
$backend = $root . '/attendly-backend';
$config = require $backend . '/config/config.php';

$db = get_db();

// Migration 042 adds the fingerprint template used by the kiosk and the
// matching verification_method enum value. The suite runs against the
// developer database, which may predate a migration, so make the two schema
// pieces idempotent here rather than failing every request that lists users.
$fingerprintColumns = $db->query("SHOW COLUMNS FROM students LIKE 'fingerprint_template'")->fetchAll();
if (!$fingerprintColumns) {
    $db->exec('ALTER TABLE students ADD COLUMN fingerprint_template LONGTEXT NULL AFTER block');
}
$verificationColumn = $db->query("SHOW COLUMNS FROM attendance_records LIKE 'verification_method'")->fetch();
if ($verificationColumn && !str_contains((string) ($verificationColumn['Type'] ?? ''), "'fingerprint'")) {
    $db->exec("ALTER TABLE attendance_records MODIFY COLUMN verification_method ENUM('face', 'manual', 'qr', 'fingerprint') NOT NULL");
}

// The login and registration limiters are per-IP. Clear only this suite's
// loopback buckets so running the tests repeatedly inside one rate-limit
// window does not fail with 429s unrelated to the code under test.
foreach (['login-ip', 'registration-ip'] as $limitedScope) {
    $clearBucket = $db->prepare('DELETE FROM api_rate_limits WHERE bucket_hash = :bucket');
    $clearBucket->execute(['bucket' => hash('sha256', $limitedScope . "\0" . '127.0.0.1')]);
}

$baseUrl = '';
$server = null;
$matchingServer = null;
$serverLog = tempnam(sys_get_temp_dir(), 'attendly-attendance-checkin-log-');
$matchingLog = tempnam(sys_get_temp_dir(), 'attendly-synthetic-matching-log-');
$userIds = [];
$eventIds = [];
$cookieJars = [];
$correctionRequestIds = [];
$correctionProof = '';
$passed = 0;
$failed = 0;

function test(string $name, callable $fn): void
{
    global $passed, $failed;

    try {
        $fn();
        $passed++;
        fwrite(STDOUT, "  ok    {$name}\n");
    } catch (Throwable $e) {
        $failed++;
        fwrite(STDOUT, "  FAIL  {$name} -> {$e->getMessage()}\n");
    }
}

function same(mixed $expected, mixed $actual): void
{
    if ($expected !== $actual) {
        throw new RuntimeException(
            'expected ' . var_export($expected, true) . ', got ' . var_export($actual, true)
        );
    }
}

function assert_true(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

function http_client(string $method, string $path, ?array $body = null, ?string $cookieJar = null): array
{
    global $baseUrl;

    $ch = curl_init($baseUrl . $path);
    $options = [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HEADER         => true,
        CURLOPT_CUSTOMREQUEST  => $method,
        CURLOPT_TIMEOUT        => 15,
        CURLOPT_HTTPHEADER     => [
            'Content-Type: application/json',
            'X-Requested-With: XMLHttpRequest',
        ],
    ];

    if ($cookieJar !== null) {
        $options[CURLOPT_COOKIEJAR] = $cookieJar;
        $options[CURLOPT_COOKIEFILE] = $cookieJar;
    }
    if ($body !== null) {
        $options[CURLOPT_POSTFIELDS] = json_encode($body, JSON_THROW_ON_ERROR);
    }

    curl_setopt_array($ch, $options);
    $raw = curl_exec($ch);
    if ($raw === false) {
        $error = curl_error($ch);
        curl_close($ch);
        throw new RuntimeException('HTTP request failed: ' . $error);
    }

    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $headerSize = (int) curl_getinfo($ch, CURLINFO_HEADER_SIZE);
    curl_close($ch);

    $bodyText = substr($raw, $headerSize);
    $decoded = json_decode($bodyText, true);

    return [
        'status' => $status,
        'body'   => is_array($decoded) ? $decoded : null,
        'raw'    => $bodyText,
    ];
}

function free_port(): int
{
    $socket = stream_socket_server('tcp://127.0.0.1:0', $errno, $errstr);
    if ($socket === false) {
        throw new RuntimeException('Unable to reserve a local port: ' . $errstr);
    }
    $name = stream_socket_get_name($socket, false);
    fclose($socket);

    return (int) substr((string) strrchr((string) $name, ':'), 1);
}

function png_chunk(string $type, string $data): string
{
    $payload = $type . $data;
    return pack('N', strlen($data)) . $payload . hash('crc32b', $payload, true);
}

/** Generate a small deterministic ridge-pattern PNG for the mock matcher. */
function synthetic_fingerprint_image(int $seed): string
{
    $width = 128;
    $height = 128;
    $scanlines = '';
    for ($y = 0; $y < $height; $y++) {
        $scanlines .= "\0"; // PNG filter: None
        for ($x = 0; $x < $width; $x++) {
            $phase = ($y + 4.2 * sin(($x + $seed * 7) / 11) + 2.1 * sin(($x + $seed) / 23)) / 5.2;
            $ridge = (sin($phase) + 1) / 2;
            $scanlines .= chr($ridge > 0.5 ? 28 : 238);
        }
    }
    $header = pack('NNCCCCC', $width, $height, 8, 0, 0, 0, 0); // 8-bit grayscale
    $png = "\x89PNG\r\n\x1a\n" . png_chunk('IHDR', $header)
        . png_chunk('IDAT', gzcompress($scanlines, 9)) . png_chunk('IEND', '');
    return base64_encode($png);
}

function enroll_finger(int $studentId, string $finger, string $image, string $cookieJar): array
{
    // The enrollment UI sends two good placements per finger. The synthetic
    // matcher treats both as the same finger, so reusing one image is enough
    // to exercise the two-template path.
    return http_client('POST', '/users/enroll-fingerprint', [
        'studentId' => $studentId,
        'finger' => $finger,
        'images' => [$image, $image],
    ], $cookieJar);
}

function unused_student_suffix(PDO $db): string
{
    do {
        $suffix = str_pad((string) random_int(0, 99999), 5, '0', STR_PAD_LEFT);
        $stmt = $db->prepare(
            "SELECT COUNT(*) FROM students
             WHERE student_id_number = :plain
                OR RIGHT(student_id_number, 6) = CONCAT('-', :suffix)"
        );
        $stmt->execute(['plain' => $suffix, 'suffix' => $suffix]);
    } while ((int) $stmt->fetchColumn() > 0);
    return $suffix;
}

function create_officer(PDO $db, string $suffix, string $password): int
{
    $email = 'officer.' . $suffix . '@example.test';
    $stmt = $db->prepare(
        'INSERT INTO users
            (public_id, role, email, display_name, password_hash, status, must_change_password)
         VALUES
            (:public_id, \'ssc_officer\', :email, \'Test Officer\', :hash, \'active\', 0)'
    );
    $stmt->execute([
        'public_id' => PublicIdGenerator::nextForUser($db, 'ssc_officer'),
        'email' => $email,
        'hash'  => password_hash($password, PASSWORD_DEFAULT),
    ]);
    $userId = (int) $db->lastInsertId();

    $officer = $db->prepare(
        'INSERT INTO ssc_officers (user_id, position, approved_by, approved_at, status)
         VALUES (:uid, \'Test Officer\', NULL, NOW(), \'approved\')'
    );
    $officer->execute(['uid' => $userId]);

    return $userId;
}

function create_admin(PDO $db, string $suffix, string $password): int
{
    $email = 'admin.' . $suffix . '@example.test';
    $stmt = $db->prepare(
        'INSERT INTO users
            (public_id, role, email, display_name, password_hash, status, must_change_password)
         VALUES
            (:public_id, \'administrator\', :email, \'Test Admin\', :hash, \'active\', 0)'
    );
    $stmt->execute([
        'public_id' => PublicIdGenerator::nextForUser($db, 'administrator'),
        'email' => $email,
        'hash'  => password_hash($password, PASSWORD_DEFAULT),
    ]);
    $userId = (int) $db->lastInsertId();

    $admin = $db->prepare('INSERT INTO administrators (user_id) VALUES (:uid)');
    $admin->execute(['uid' => $userId]);

    return $userId;
}

function create_event(PDO $db, int $createdBy, string $name, DateTimeImmutable $start, string $status = 'scheduled'): int
{
    // Ensure the attendance_type column exists (migration 038).
    $columns = $db->query("SHOW COLUMNS FROM events LIKE 'attendance_type'")->fetchAll();
    if (!$columns) {
        $db->exec("ALTER TABLE events ADD COLUMN attendance_type ENUM('single','in_out','four_point') NOT NULL DEFAULT 'single' AFTER target_department");
    }
    // Ensure scan_number exists on attendance_records (migration 038).
    $scanCols = $db->query("SHOW COLUMNS FROM attendance_records LIKE 'scan_number'")->fetchAll();
    if (!$scanCols) {
        $db->exec("ALTER TABLE attendance_records ADD COLUMN scan_number TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER check_out_time");
    }

    $stmt = $db->prepare(
        'INSERT INTO events
            (public_id, name, description, event_date, start_time, end_time, venue, event_type, status, created_by, attendance_type)
         VALUES
            (:public_id, :name, :description, :event_date, :start_time, :end_time, :venue, \'mandatory\', :status, :created_by, \'single\')'
    );
    $stmt->execute([
        'public_id'   => PublicIdGenerator::nextForEvent($db),
        'name'        => $name,
        'description' => 'Integration test event',
        'event_date'  => $start->format('Y-m-d'),
        'start_time'  => $start->format('H:i:s'),
        'end_time'    => $start->modify('+1 hour')->format('H:i:s'),
        'venue'       => 'Test Venue',
        'status'      => $status,
        'created_by'  => $createdBy,
    ]);

    return (int) $db->lastInsertId();
}

function login(string $email, string $password, array &$cookieJars): array
{
    $jar = tempnam(sys_get_temp_dir(), 'attendly-cookie-');
    if ($jar === false) {
        throw new RuntimeException('Unable to create a cookie jar.');
    }
    $cookieJars[] = $jar;

    $response = http_client('POST', '/auth/login', [
        'email'    => $email,
        'password' => $password,
    ], $jar);

    same(200, $response['status']);
    if (!isset($response['body']['data']['id'])) {
        throw new RuntimeException('Login response did not include a user.');
    }

    return [
        'id'   => (int) $response['body']['data']['id'],
        'user' => $response['body']['data'],
        'jar'  => $jar,
    ];
}

function response_data(array $response): array
{
    if (!isset($response['body']['data']) || !is_array($response['body']['data'])) {
        throw new RuntimeException('Response did not include a data payload: ' . $response['raw']);
    }

    return $response['body']['data'];
}

function response_error(array $response, string $code): void
{
    same($code, $response['body']['error']['code'] ?? null);
}

function attendance_row(PDO $db, int $eventId, int $studentId): array|false
{
    $stmt = $db->prepare(
        'SELECT id, event_id, student_id, check_in_time, check_out_time, verification_method
         FROM attendance_records
         WHERE event_id = :event_id AND student_id = :student_id'
    );
    $stmt->execute(['event_id' => $eventId, 'student_id' => $studentId]);

    return $stmt->fetch();
}

function attendance_count(PDO $db, int $eventId, int $studentId): int
{
    $stmt = $db->prepare(
        'SELECT COUNT(*) FROM attendance_records
         WHERE event_id = :event_id AND student_id = :student_id'
    );
    $stmt->execute(['event_id' => $eventId, 'student_id' => $studentId]);

    return (int) $stmt->fetchColumn();
}

$suffix = bin2hex(random_bytes(4));
$password = 'TestPass123!';
$timezone = new DateTimeZone((string) ($config['tunables']['timezone'] ?? 'Asia/Manila'));

try {
    // ── Seed accounts through the real registration endpoint so the
    //    token comes from registerStudent(), not hand-written SQL. ──
    $adminId = create_admin($db, $suffix, $password);
    $userIds[] = $adminId;
    $officerId = create_officer($db, $suffix, $password);
    $userIds[] = $officerId;

    $now = new DateTimeImmutable('now', $timezone);
    $openEventId = create_event($db, $officerId, 'Attendance Check-in Open ' . $suffix, $now->modify('-5 minutes'));
    $eventIds[] = $openEventId;
    $fingerprintEventId = create_event($db, $officerId, 'Fingerprint Check-in ' . $suffix, $now->modify('-5 minutes'));
    $eventIds[] = $fingerprintEventId;
    $fingerprintFullEventId = create_event($db, $officerId, 'Fingerprint Full Enrollment ' . $suffix, $now->modify('-5 minutes'));
    $eventIds[] = $fingerprintFullEventId;
    $fingerprintRedoEventId = create_event($db, $officerId, 'Fingerprint Redo ' . $suffix, $now->modify('-5 minutes'));
    $eventIds[] = $fingerprintRedoEventId;
    $fingerprintWrongEventId = create_event($db, $officerId, 'Fingerprint Wrong Student ' . $suffix, $now->modify('-5 minutes'));
    $eventIds[] = $fingerprintWrongEventId;
    $fingerprintCollisionEventId = create_event($db, $officerId, 'Fingerprint ID Collision ' . $suffix, $now->modify('-5 minutes'));
    $eventIds[] = $fingerprintCollisionEventId;
    $correctionEventId = create_event($db, $officerId, 'Correction Proof ' . $suffix, $now->modify('-1 day'));
    $eventIds[] = $correctionEventId;

    $port = free_port();
    $baseUrl = 'http://127.0.0.1:' . $port . '/api';

    $matchingPort = free_port();
    $matchingUrl = 'http://127.0.0.1:' . $matchingPort;
    $matchingDescriptors = [
        0 => ['pipe', 'r'],
        1 => ['file', $matchingLog, 'a'],
        2 => ['file', $matchingLog, 'a'],
    ];
    $matchingServer = proc_open(
        [PHP_BINARY, '-S', '127.0.0.1:' . $matchingPort, $root . '/tools/matching-service/test/mock-router.php'],
        $matchingDescriptors,
        $matchingPipes,
        $root
    );
    if (!is_resource($matchingServer)) {
        throw new RuntimeException('Unable to start the synthetic matching service.');
    }
    fclose($matchingPipes[0]);
    $matchingReady = false;
    for ($attempt = 0; $attempt < 50; $attempt++) {
        usleep(100000);
        try {
            $health = file_get_contents($matchingUrl . '/health');
            if (is_string($health) && str_contains($health, '"status":"ok"')) {
                $matchingReady = true;
                break;
            }
        } catch (Throwable) {
        }
    }
    if (!$matchingReady) {
        throw new RuntimeException('Synthetic matching service did not become ready.');
    }

    $descriptors = [
        0 => ['pipe', 'r'],
        1 => ['file', $serverLog, 'a'],
        2 => ['file', $serverLog, 'a'],
    ];
    // The PHP built-in server resolves the router script relative to its
    // working directory, so the path must work from the backend folder.
    $routerScript = is_file($backend . '/public/router.php')
        ? 'public/router.php'
        : 'router.php';
    $tempDir = sys_get_temp_dir();
    $server = proc_open(
        [PHP_BINARY, '-d', 'post_max_size=40M', '-d', 'upload_tmp_dir=' . $tempDir, '-S', '127.0.0.1:' . $port, '-t', 'public', $routerScript],
        $descriptors,
        $pipes,
        $backend,
        array_merge(getenv(), [
            'MATCHING_URL' => $matchingUrl,
            'MATCHING_KEY' => 'attendly-synthetic-test-key',
        ])
    );

    if (!is_resource($server)) {
        throw new RuntimeException('Unable to start the PHP development server.');
    }
    fclose($pipes[0]);

    $ready = false;
    for ($attempt = 0; $attempt < 50; $attempt++) {
        usleep(100000);
        try {
            if (http_client('GET', '/health')['status'] === 200) {
                $ready = true;
                break;
            }
        } catch (Throwable) {
        }
    }
    if (!$ready) {
        throw new RuntimeException('API server did not become ready: ' . file_get_contents($serverLog));
    }

    fwrite(STDOUT, "attendance-checkin.api.test.php\n");

    // Register two students through POST /auth/register. Accounts land in
    // 'pending'; the admin approves them so they can sign in.
    $regA = http_client('POST', '/auth/register', [
        'firstName' => 'Alpha', 'lastName' => 'Student',
        'studentIdNumber' => '2026-' . str_pad((string) mt_rand(10000, 99999), 5, '0', STR_PAD_LEFT),
        'email' => 'alpha.' . $suffix . '@example.test',
        'password' => $password,
        'department' => 'Computer Studies', 'program' => 'BSIT',
        'yearLevel' => '1', 'block' => 'A',
    ]);
    same(200, $regA['status']);
    $studentAId = (int) response_data($regA)['id'];
    $userIds[] = $studentAId;

    $regB = http_client('POST', '/auth/register', [
        'firstName' => 'Beta', 'lastName' => 'Student',
        'studentIdNumber' => '2026-' . str_pad((string) mt_rand(10000, 99999), 5, '0', STR_PAD_LEFT),
        'email' => 'beta.' . $suffix . '@example.test',
        'password' => $password,
        'department' => 'Computer Studies', 'program' => 'BSIT',
        'yearLevel' => '2', 'block' => 'B',
    ]);
    same(200, $regB['status']);
    $studentBId = (int) response_data($regB)['id'];
    $userIds[] = $studentBId;

    test('registration creates student accounts', function () use ($studentAId, $studentBId): void {
        assert_true((int) $studentAId > 0 && (int) $studentBId > 0, 'student accounts were not created');
    });

    test('registration issues a sequential STUD public id', function () use ($db, $regA, $regB, $studentAId, $studentBId): void {
        $publicA = (string) (response_data($regA)['publicId'] ?? '');
        $publicB = (string) (response_data($regB)['publicId'] ?? '');
        assert_true(preg_match('/^STUD_\d{3,}$/', $publicA) === 1, "bad publicId: {$publicA}");
        assert_true(preg_match('/^STUD_\d{3,}$/', $publicB) === 1, "bad publicId: {$publicB}");
        assert_true($publicA !== $publicB, 'two students share a public id');
        $stored = $db->prepare('SELECT public_id FROM users WHERE id = :id');
        $stored->execute(['id' => $studentAId]);
        same($publicA, (string) $stored->fetchColumn());
    });

    $admin = login('admin.' . $suffix . '@example.test', $password, $cookieJars);
    $approveA = http_client('PATCH', "/users/{$studentAId}/status", ['status' => 'active'], $admin['jar']);
    same(200, $approveA['status']);
    $approveB = http_client('PATCH', "/users/{$studentBId}/status", ['status' => 'active'], $admin['jar']);
    same(200, $approveB['status']);

    $officer = login('officer.' . $suffix . '@example.test', $password, $cookieJars);
    $studentA = login('alpha.' . $suffix . '@example.test', $password, $cookieJars);
    $studentB = login('beta.' . $suffix . '@example.test', $password, $cookieJars);

    // Fingerprint enrollment: all ten fingers are required before kiosk access.
    $studentNumberQuery = $db->prepare('SELECT student_id_number FROM students WHERE user_id = :id');
    $studentNumberQuery->execute(['id' => $studentAId]);
    $studentAIdNumber = (string) $studentNumberQuery->fetchColumn();
    $studentNumberQuery->execute(['id' => $studentBId]);
    $studentBIdNumber = (string) $studentNumberQuery->fetchColumn();
    $imageA = synthetic_fingerprint_image(7);
    $imageB = synthetic_fingerprint_image(31);
    $imageRedo = synthetic_fingerprint_image(57);
    $fingerKeys = [
        'left-thumb', 'left-index', 'left-middle', 'left-ring', 'left-little',
        'right-thumb', 'right-index', 'right-middle', 'right-ring', 'right-little',
    ];

    test('anonymous cannot enroll a fingerprint', function () use ($studentAId, $imageA): void {
        $response = http_client('POST', '/users/enroll-fingerprint', [
            'studentId' => $studentAId, 'finger' => 'left-thumb', 'images' => [$imageA],
        ]);
        same(401, $response['status']);
        response_error($response, 'unauthenticated');
    });

    test('a student cannot enroll a fingerprint', function () use ($studentA, $studentAId, $imageA): void {
        $response = http_client('POST', '/users/enroll-fingerprint', [
            'studentId' => $studentAId, 'finger' => 'left-thumb', 'images' => [$imageA],
        ], $studentA['jar']);
        same(403, $response['status']);
        response_error($response, 'forbidden');
    });

    test('9 of 10 fingers remains incomplete in the backend status', function () use ($officer, $studentAId, $fingerKeys, $imageA): void {
        $result = null;
        foreach (array_slice($fingerKeys, 0, 9) as $finger) {
            $response = enroll_finger($studentAId, $finger, $imageA, $officer['jar']);
            same(200, $response['status']);
            $result = response_data($response);
        }
        same(false, $result['fingerprintEnrolled'] ?? null);
        same(9, (int) ($result['fingerprintFingersCompleted'] ?? -1));
        same(9, count($result['enrolledFingers'] ?? []));
    });

    test('9/10 fingerprint check-in is rejected and does not record attendance', function () use ($db, $officer, $fingerprintEventId, $studentAId, $studentAIdNumber, $imageA): void {
        $response = http_client('POST', '/attendance/fingerprint', [
            'eventId' => $fingerprintEventId, 'studentIdNumber' => $studentAIdNumber, 'image' => $imageA,
        ], $officer['jar']);
        same(409, $response['status']);
        response_error($response, 'fingerprint_enrollment_incomplete');
        assert_true(str_contains((string) ($response['body']['error']['message'] ?? ''), 'Enrollment incomplete (9/10 fingers)'), 'incomplete count missing from kiosk error');
        same(false, attendance_row($db, $fingerprintEventId, $studentAId));
    });

    test('manual attendance still works for a 9/10 student', function () use ($db, $officer, $fingerprintEventId, $studentAId): void {
        $response = http_client('POST', '/attendance/manual', [
            'eventId' => $fingerprintEventId, 'studentId' => $studentAId, 'action' => 'in',
        ], $officer['jar']);
        if ($response['status'] !== 200) {
            throw new RuntimeException('manual check-in for partial student: ' . $response['raw']);
        }
        same('manual', response_data($response)['verificationMethod'] ?? null);
        same('manual', attendance_row($db, $fingerprintEventId, $studentAId)['verification_method'] ?? null);
    });

    test('adding the tenth finger marks the student complete', function () use ($officer, $studentAId, $fingerKeys, $imageA): void {
        $response = enroll_finger($studentAId, $fingerKeys[9], $imageA, $officer['jar']);
        same(200, $response['status']);
        $data = response_data($response);
        same(true, $data['fingerprintEnrolled'] ?? null);
        same(10, (int) ($data['fingerprintFingersCompleted'] ?? -1));
    });

    test('10/10 means ten fingers with two templates each', function () use ($db, $studentAId): void {
        $stmt = $db->prepare('SELECT fingerprint_template FROM students WHERE user_id = :id');
        $stmt->execute(['id' => $studentAId]);
        $entries = json_decode((string) $stmt->fetchColumn(), true);
        same(10, is_array($entries) ? count($entries) : -1);
        if (!is_array($entries)) {
            return;
        }
        foreach ($entries as $entry) {
            same(2, is_array($entry['templates'] ?? null) ? count($entry['templates']) : -1);
        }
    });

    test('a 10/10 student can check in by fingerprint', function () use ($db, $officer, $fingerprintFullEventId, $studentAId, $studentAIdNumber, $imageA): void {
        $response = http_client('POST', '/attendance/fingerprint', [
            'eventId' => $fingerprintFullEventId, 'studentIdNumber' => $studentAIdNumber, 'image' => $imageA,
        ], $officer['jar']);
        same(200, $response['status']);
        $data = response_data($response);
        same($studentAId, (int) ($data['studentId'] ?? 0));
        same('fingerprint', $data['verificationMethod'] ?? null);
        assert_true(isset($data['fingerprintScore']), 'matching score missing from check-in response');
        assert_true(isset($data['fingerprintThreshold']), 'matching threshold missing from check-in response');
        same('left-thumb', $data['fingerprintFinger'] ?? null);
        same('fingerprint', attendance_row($db, $fingerprintFullEventId, $studentAId)['verification_method'] ?? null);
    });

    test('duplicate fingerprint attendance is still rejected', function () use ($officer, $fingerprintFullEventId, $studentAIdNumber, $imageA): void {
        $response = http_client('POST', '/attendance/fingerprint', [
            'eventId' => $fingerprintFullEventId, 'studentIdNumber' => $studentAIdNumber, 'image' => $imageA,
        ], $officer['jar']);
        same(409, $response['status']);
        response_error($response, 'duplicate_checkin');
    });

    test('re-enrolling one finger preserves 10/10 and remains usable', function () use ($officer, $fingerprintRedoEventId, $studentAId, $studentAIdNumber, $fingerKeys, $imageRedo): void {
        $enroll = enroll_finger($studentAId, $fingerKeys[0], $imageRedo, $officer['jar']);
        same(200, $enroll['status']);
        same(true, response_data($enroll)['fingerprintEnrolled'] ?? null);
        same(10, (int) (response_data($enroll)['fingerprintFingersCompleted'] ?? -1));
        $scan = http_client('POST', '/attendance/fingerprint', [
            'eventId' => $fingerprintRedoEventId, 'studentIdNumber' => $studentAIdNumber, 'image' => $imageRedo,
        ], $officer['jar']);
        same(200, $scan['status']);
    });

    test('legacy flat templates count as 0/10 until named fingers are enrolled', function () use ($db, $officer, $studentBId, $studentBIdNumber, $fingerprintWrongEventId, $imageB): void {
        $legacy = json_encode([base64_encode('legacy-synthetic-template')], JSON_THROW_ON_ERROR);
        $store = $db->prepare('UPDATE students SET fingerprint_template = :templates WHERE user_id = :id');
        $store->execute(['templates' => $legacy, 'id' => $studentBId]);
        $blocked = http_client('POST', '/attendance/fingerprint', [
            'eventId' => $fingerprintWrongEventId, 'studentIdNumber' => $studentBIdNumber, 'image' => $imageB,
        ], $officer['jar']);
        same(409, $blocked['status']);
        response_error($blocked, 'fingerprint_enrollment_incomplete');
        assert_true(str_contains((string) ($blocked['body']['error']['message'] ?? ''), 'Enrollment incomplete (0/10 fingers)'), 'legacy status should be 0/10');
    });

    test('legacy templates stay unknown while named fingers complete the enrollment', function () use ($db, $officer, $studentBId, $fingerKeys, $imageB): void {
        $result = null;
        foreach ($fingerKeys as $finger) {
            $response = enroll_finger($studentBId, $finger, $imageB, $officer['jar']);
            same(200, $response['status']);
            $result = response_data($response);
        }
        same(true, $result['fingerprintEnrolled'] ?? null);
        same(10, (int) ($result['fingerprintFingersCompleted'] ?? -1));
        $stored = $db->prepare('SELECT fingerprint_template FROM students WHERE user_id = :id');
        $stored->execute(['id' => $studentBId]);
        $entries = json_decode((string) $stored->fetchColumn(), true);
        assert_true(is_array($entries) && count($entries) === 11 && array_key_exists('finger', $entries[0]) && $entries[0]['finger'] === null, 'legacy template was not preserved as unknown');
    });

    test('another fully enrolled student fingerprint is rejected for the typed ID', function () use ($db, $officer, $fingerprintWrongEventId, $studentAId, $studentAIdNumber, $imageB): void {
        $response = http_client('POST', '/attendance/fingerprint', [
            'eventId' => $fingerprintWrongEventId, 'studentIdNumber' => $studentAIdNumber, 'image' => $imageB,
        ], $officer['jar']);
        same(404, $response['status']);
        response_error($response, 'fingerprint_not_recognized');
        $details = $response['body']['error']['details'] ?? null;
        assert_true(is_array($details), 'no-match debug details missing');
        same(0.0, (float) ($details['score'] ?? -1));
        same(40.0, (float) ($details['threshold'] ?? -1));
        same(null, $details['finger'] ?? null);
        same(false, attendance_row($db, $fingerprintWrongEventId, $studentAId));
    });

    test('suffix collision resolves against both students by fingerprint', function () use ($db, $officer, $fingerprintCollisionEventId, $studentBId, $studentAIdNumber, $imageB): void {
        $suffix = substr($studentAIdNumber, -5);
        $year = 2025;
        do {
            $alternateId = $year++ . '-' . $suffix;
            $check = $db->prepare('SELECT COUNT(*) FROM students WHERE student_id_number = :number AND user_id <> :id');
            $check->execute(['number' => $alternateId, 'id' => $studentBId]);
        } while ((int) $check->fetchColumn() > 0);
        $update = $db->prepare('UPDATE students SET student_id_number = :number WHERE user_id = :id');
        $update->execute(['number' => $alternateId, 'id' => $studentBId]);
        $response = http_client('POST', '/attendance/fingerprint', [
            'eventId' => $fingerprintCollisionEventId,
            'studentIdNumber' => $suffix,
            'image' => $imageB,
        ], $officer['jar']);
        same(200, $response['status']);
        same($studentBId, (int) (response_data($response)['studentId'] ?? 0));
    });

    test('five-digit lookup with no matching student returns ID not found', function () use ($db, $officer, $fingerprintCollisionEventId, $imageA): void {
        $missing = unused_student_suffix($db);
        $response = http_client('POST', '/attendance/fingerprint', [
            'eventId' => $fingerprintCollisionEventId, 'studentIdNumber' => $missing, 'image' => $imageA,
        ], $officer['jar']);
        same(404, $response['status']);
        response_error($response, 'student_id_not_found');
    });

    test('staff listing reports 10/10 without exposing fingerprint templates', function () use ($officer, $studentAId, $studentBId): void {
        $response = http_client('GET', '/users', null, $officer['jar']);
        same(200, $response['status']);
        foreach ([$studentAId, $studentBId] as $id) {
            $match = null;
            foreach (response_data($response) as $row) if ((int) ($row['id'] ?? 0) === $id) { $match = $row; break; }
            assert_true(is_array($match), 'student missing from /users');
            same(true, $match['fingerprintEnrolled'] ?? null);
            same(10, (int) ($match['fingerprintFingersCompleted'] ?? -1));
            assert_true(!array_key_exists('fingerprintTemplate', $match), 'user listing exposed templates');
        }
    });

    test('events expose EVNT public ids', function () use ($db, $officer, $openEventId): void {
        $stored = $db->prepare('SELECT public_id FROM events WHERE id = :id');
        $stored->execute(['id' => $openEventId]);
        $publicId = (string) $stored->fetchColumn();
        assert_true(preg_match('/^EVNT_\d{3,}$/', $publicId) === 1, "bad event publicId: {$publicId}");

        $list = http_client('GET', '/events', null, $officer['jar']);
        same(200, $list['status']);
        $match = null;
        foreach (response_data($list) as $row) {
            if ((int) ($row['id'] ?? 0) === $openEventId) { $match = $row; break; }
        }
        assert_true(is_array($match), 'event missing from /events');
        same($publicId, (string) ($match['publicId'] ?? ''));
    });

    test('login and /auth/me expose the student public id', function () use ($studentA): void {
        $publicId = (string) ($studentA['user']['publicId'] ?? '');
        assert_true(preg_match('/^STUD_\d{3,}$/', $publicId) === 1, "login publicId: {$publicId}");

        $me = http_client('GET', '/auth/me', null, $studentA['jar']);
        same(200, $me['status']);
        same($publicId, (string) (response_data($me)['publicId'] ?? ''));
    });

    test('student profile save treats contactNumber as optional', function () use ($studentA, $suffix): void {
        $email = 'alpha.' . $suffix . '@example.test';

        $blank = http_client('PATCH', '/users/me/profile', [
            'email' => $email,
            'contactNumber' => '',
        ], $studentA['jar']);
        same(200, $blank['status']);
        $blankData = response_data($blank);
        same($email, (string) ($blankData['email'] ?? ''));
        assert_true(
            ($blankData['contactNumber'] ?? null) === null,
            'a blank contact number should clear the stored value'
        );

        $null = http_client('PATCH', '/users/me/profile', [
            'email' => $email,
            'contactNumber' => null,
        ], $studentA['jar']);
        same(200, $null['status']);

        $valid = http_client('PATCH', '/users/me/profile', [
            'email' => $email,
            'contactNumber' => '+63 917 123 4567',
        ], $studentA['jar']);
        same(200, $valid['status']);
        same('+63 917 123 4567', (string) (response_data($valid)['contactNumber'] ?? ''));

        $tooLong = http_client('PATCH', '/users/me/profile', [
            'email' => $email,
            'contactNumber' => str_repeat('9', 21),
        ], $studentA['jar']);
        same(422, $tooLong['status']);
    });

    test('student profile save rejects an email or phone owned by another user', function () use ($db, $studentA, $studentB, $suffix): void {
        $emailA = 'alpha.' . $suffix . '@example.test';
        $emailB = 'beta.' . $suffix . '@example.test';
        $phoneB = '+63 918 555 0101';

        // Give Beta a contact number so the phone conflict check has real data.
        $setB = http_client('PATCH', '/users/me/profile', [
            'email' => $emailB,
            'contactNumber' => $phoneB,
        ], $studentB['jar']);
        same(200, $setB['status']);

        $duplicateEmail = http_client('PATCH', '/users/me/profile', [
            'email' => $emailB,
            'contactNumber' => '+63 917 123 4567',
        ], $studentA['jar']);
        same(409, $duplicateEmail['status']);
        response_error($duplicateEmail, 'email_taken');
        same('This email is already in use.', (string) ($duplicateEmail['body']['error']['message'] ?? ''));

        $duplicatePhone = http_client('PATCH', '/users/me/profile', [
            'email' => $emailA,
            'contactNumber' => $phoneB,
        ], $studentA['jar']);
        same(409, $duplicatePhone['status']);
        response_error($duplicatePhone, 'phone_taken');
        same('This contact number is already in use.', (string) ($duplicatePhone['body']['error']['message'] ?? ''));

        // A rejected save must leave Alpha's stored row untouched.
        $stored = $db->prepare('SELECT email, contact_number FROM users WHERE id = :id');
        $stored->execute(['id' => $studentA['id']]);
        $row = $stored->fetch();
        same($emailA, (string) ($row['email'] ?? ''));
        same('+63 917 123 4567', (string) ($row['contact_number'] ?? ''));
    });

    test('correction requests require a real proof image', function () use ($studentA, $correctionEventId, $now): void {
        $time = $now->modify('-1 day')->format('Y-m-d H:i');
        $base = [
            'eventId' => $correctionEventId,
            'checkInTime' => $time,
            'reason' => 'The kiosk did not record my attendance.',
        ];

        $missing = http_client('POST', '/attendance-corrections', $base, $studentA['jar']);
        same(422, $missing['status']);
        response_error($missing, 'invalid_field');

        $notImage = http_client('POST', '/attendance-corrections', $base + [
            'proofImage' => 'data:image/png;base64,' . base64_encode(str_repeat('not-an-image', 40)),
        ], $studentA['jar']);
        same(422, $notImage['status']);
        response_error($notImage, 'invalid_field');

        $svg = http_client('POST', '/attendance-corrections', $base + [
            'proofImage' => 'data:image/svg+xml;base64,' . base64_encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        ], $studentA['jar']);
        same(422, $svg['status']);
        response_error($svg, 'invalid_field');
    });

    test('correction request stores proof and hides the image from list responses', function () use ($db, $studentA, $officer, $correctionEventId, $now, &$correctionRequestIds, &$correctionProof): void {
        $proof = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
        $correctionProof = $proof;
        $created = http_client('POST', '/attendance-corrections', [
            'eventId' => $correctionEventId,
            'checkInTime' => $now->modify('-1 day')->format('Y-m-d H:i'),
            'reason' => 'The kiosk did not record my attendance.',
            'proofImage' => $proof,
        ], $studentA['jar']);
        same(200, $created['status']);
        $row = response_data($created);
        $requestId = (int) ($row['id'] ?? 0);
        assert_true($requestId > 0, 'correction response did not include an id');
        same(true, (bool) ($row['hasProof'] ?? false));
        assert_true(!array_key_exists('proofImage', $row), 'create response leaked the proof image');
        $correctionRequestIds[] = $requestId;

        $stored = $db->prepare('SELECT proof_image FROM attendance_correction_requests WHERE id = :id');
        $stored->execute(['id' => $requestId]);
        same($proof, (string) $stored->fetchColumn());

        $ownerList = http_client('GET', '/attendance-corrections', null, $studentA['jar']);
        same(200, $ownerList['status']);
        $ownerRow = null;
        foreach (response_data($ownerList) as $candidate) {
            if ((int) ($candidate['id'] ?? 0) === $requestId) { $ownerRow = $candidate; break; }
        }
        assert_true(is_array($ownerRow), 'owner could not see their correction request');
        same(true, (bool) ($ownerRow['hasProof'] ?? false));
        assert_true(!array_key_exists('proofImage', $ownerRow), 'owner list leaked the proof image');

        $staffList = http_client('GET', '/attendance-corrections', null, $officer['jar']);
        same(200, $staffList['status']);
        $staffRow = null;
        foreach (response_data($staffList) as $candidate) {
            if ((int) ($candidate['id'] ?? 0) === $requestId) { $staffRow = $candidate; break; }
        }
        assert_true(is_array($staffRow), 'staff could not see the correction request');
        same(true, (bool) ($staffRow['hasProof'] ?? false));
        assert_true(!array_key_exists('proofImage', $staffRow), 'staff list leaked the proof image');
    });

    test('proof endpoint returns the image to the owner and staff only', function () use ($studentA, $studentB, $officer, &$correctionRequestIds, &$correctionProof): void {
        $requestId = (int) ($correctionRequestIds[0] ?? 0);
        assert_true($requestId > 0, 'no correction request to read');

        $owner = http_client('GET', "/attendance-corrections/{$requestId}/proof", null, $studentA['jar']);
        same(200, $owner['status']);
        same($correctionProof, (string) (response_data($owner)['proofImage'] ?? ''));

        $staff = http_client('GET', "/attendance-corrections/{$requestId}/proof", null, $officer['jar']);
        same(200, $staff['status']);
        same($correctionProof, (string) (response_data($staff)['proofImage'] ?? ''));

        $foreign = http_client('GET', "/attendance-corrections/{$requestId}/proof", null, $studentB['jar']);
        same(404, $foreign['status']);
        response_error($foreign, 'not_found');
    });

    test('oversized proof images are rejected before decoding', function () use ($studentA, $correctionEventId, $now): void {
        $oversized = http_client('POST', '/attendance-corrections', [
            'eventId' => $correctionEventId,
            'checkInTime' => $now->modify('-1 day')->format('Y-m-d H:i'),
            'reason' => 'Oversized proof payload test.',
            'proofImage' => 'data:image/png;base64,' . str_repeat('A', 2800001),
        ], $studentA['jar']);
        same(422, $oversized['status']);
        response_error($oversized, 'invalid_field');
    });

    test('correction requests reject a null or empty proof image', function () use ($studentA, $correctionEventId, $now): void {
        $nullProof = http_client('POST', '/attendance-corrections', [
            'eventId' => $correctionEventId,
            'checkInTime' => $now->modify('-1 day')->format('Y-m-d H:i'),
            'reason' => 'Null proof payload test.',
            'proofImage' => null,
        ], $studentA['jar']);
        same(422, $nullProof['status']);
        response_error($nullProof, 'invalid_field');

        $emptyProof = http_client('POST', '/attendance-corrections', [
            'eventId' => $correctionEventId,
            'checkInTime' => $now->modify('-1 day')->format('Y-m-d H:i'),
            'reason' => 'Empty proof payload test.',
            'proofImage' => '',
        ], $studentA['jar']);
        same(422, $emptyProof['status']);
        response_error($emptyProof, 'invalid_field');
    });

    test('a student cannot view another student proof image', function () use ($studentA, $studentB, $officer, &$correctionRequestIds, &$correctionProof): void {
        $requestId = (int) ($correctionRequestIds[0] ?? 0);
        assert_true($requestId > 0, 'no correction request to read');

        $foreign = http_client('GET', "/attendance-corrections/{$requestId}/proof", null, $studentB['jar']);
        same(404, $foreign['status']);
        response_error($foreign, 'not_found');
    });

    test('a student cannot review a correction request', function () use ($studentA, &$correctionRequestIds): void {
        $requestId = (int) ($correctionRequestIds[0] ?? 0);
        assert_true($requestId > 0, 'no correction request to review');

        $denied = http_client('PATCH', "/attendance-corrections/{$requestId}/review", [
            'decision' => 'denied',
            'notes' => 'Should not be allowed.',
        ], $studentA['jar']);
        same(403, $denied['status']);
        response_error($denied, 'forbidden');
    });

    test('sanction report endpoint returns the semester matrix', function () use ($admin): void {
        $response = http_client('GET', '/reports/sanctions', null, $admin['jar']);
        same(200, $response['status']);
        $data = response_data($response);
        assert_true(is_array($data['events'] ?? null), 'sanction report events are missing');
        assert_true(is_array($data['students'] ?? null), 'sanction report students are missing');
        $range = $data['range'] ?? [];
        assert_true(array_key_exists('department', $range) && array_key_exists('program', $range),
            'sanction report range is missing the department/program scope');
    });

    test('student can read only their own absence-based sanction status', function () use ($studentA, $studentB, $studentBId): void {
        $own = http_client('GET', '/users/me/sanctions', null, $studentA['jar']);
        same(200, $own['status']);
        $data = response_data($own);

        same(['totalAbsences', 'status'], array_keys($data));
        assert_true(is_int($data['totalAbsences']), 'totalAbsences must be a number');
        assert_true($data['totalAbsences'] >= 0, 'totalAbsences must not be negative');
        assert_true(
            is_string($data['status']) && in_array($data['status'], ['Good Standing', 'Flagged for Sanction'], true),
            'unexpected status: ' . var_export($data['status'], true)
        );
        same($data['totalAbsences'] > 3, $data['status'] === 'Flagged for Sanction');

        // Query parameters must not widen the scope: naming another student's
        // id returns the caller's own summary, unchanged.
        $forced = http_client(
            'GET',
            '/users/me/sanctions?student_id=' . $studentBId . '&studentId=' . $studentBId,
            null,
            $studentA['jar']
        );
        same(200, $forced['status']);
        same($data, response_data($forced));

        // The summary also never carries another student's identity.
        $ownB = http_client('GET', '/users/me/sanctions', null, $studentB['jar']);
        same(200, $ownB['status']);
        assert_true(!array_key_exists('studentId', response_data($ownB)), 'response exposed a student id');
    });

    test('manual check-in fallback still works', function () use ($db, $admin, $officer, $fingerprintWrongEventId, $studentBId): void {
        $response = http_client('POST', '/attendance/manual', [
            'eventId' => $fingerprintWrongEventId,
            'studentId' => $studentBId,
            'action' => 'in',
        ], $officer['jar']);
        if ($response['status'] !== 200) {
            throw new RuntimeException('manual fallback response: ' . $response['raw']);
        }
        $data = response_data($response);
        same($studentBId, (int) $data['studentId']);
        same('manual', $data['verificationMethod']);
        assert_true(attendance_row($db, $fingerprintWrongEventId, $studentBId) !== false, 'manual attendance row was not created');
    });
} catch (Throwable $e) {
    $failed++;
    fwrite(STDERR, "FATAL: {$e->getMessage()}\n");
} finally {
    if (is_resource($server)) {
        $status = proc_get_status($server);
        if ($status['running']) {
            proc_terminate($server);
        }
        proc_close($server);
    }
    if (is_resource($matchingServer)) {
        $status = proc_get_status($matchingServer);
        if ($status['running']) {
            proc_terminate($matchingServer);
        }
        proc_close($matchingServer);
    }

    foreach ($cookieJars as $jar) {
        if (is_file($jar)) {
            unlink($jar);
        }
    }

    if ($correctionRequestIds !== []) {
        $placeholders = implode(',', array_fill(0, count($correctionRequestIds), '?'));
        try {
            $cleanup = $db->prepare('DELETE FROM attendance_correction_requests WHERE id IN (' . $placeholders . ')');
            $cleanup->execute($correctionRequestIds);
        } catch (Throwable $e) {
            fwrite(STDERR, 'cleanup warning: ' . $e->getMessage() . "\n");
        }
    }

    if ($eventIds !== []) {
        $placeholders = implode(',', array_fill(0, count($eventIds), '?'));
        try {
            $cleanup = $db->prepare('DELETE FROM attendance_records WHERE event_id IN (' . $placeholders . ')');
            $cleanup->execute($eventIds);
            $cleanup = $db->prepare('DELETE FROM events WHERE id IN (' . $placeholders . ')');
            $cleanup->execute($eventIds);
        } catch (Throwable $e) {
            fwrite(STDERR, 'cleanup warning: ' . $e->getMessage() . "\n");
        }
    }

    if ($userIds !== []) {
        $placeholders = implode(',', array_fill(0, count($userIds), '?'));
        try {
            $cleanup = $db->prepare('DELETE FROM users WHERE id IN (' . $placeholders . ')');
            $cleanup->execute($userIds);
        } catch (Throwable $e) {
            fwrite(STDERR, 'cleanup warning: ' . $e->getMessage() . "\n");
        }
    }

    if ($failed > 0 && is_file($serverLog)) {
        $lines = file($serverLog, FILE_IGNORE_NEW_LINES);
        if ($lines !== false && $lines !== []) {
            fwrite(STDERR, "server log:\n" . implode("\n", array_slice($lines, -20)) . "\n");
        }
    }
    if (is_file($serverLog)) {
        unlink($serverLog);
    }
    if (is_file($matchingLog)) {
        unlink($matchingLog);
    }
}

fwrite(STDOUT, "\n{$passed} API assertions passed.\n");

if ($failed > 0) {
    fwrite(STDERR, "{$failed} API assertion(s) failed.\n");
    exit(1);
}
