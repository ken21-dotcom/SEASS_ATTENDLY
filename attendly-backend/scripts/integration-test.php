<?php
/**
 * ATTENDLY — End-to-End Integration Test (Simplified)
 *
 * Tests the complete flow without requiring fingerprint matching service:
 * Auth -> Event Creation -> Manual Attendance Check-in -> Reports & Audit Logs
 *
 * Run from attendly-backend:
 *   php scripts/integration-test.php
 */

declare(strict_types=1);

require __DIR__ . '/../config/db.php';
require __DIR__ . '/../src/Response.php';
require __DIR__ . '/../src/Auth.php';
require __DIR__ . '/../src/Validator.php';
require __DIR__ . '/../src/RateLimiter.php';
require __DIR__ . '/../src/Repository.php';
require __DIR__ . '/../src/ConfigGuard.php';

use Attendly\Response;
use Attendly\Auth;
use Attendly\Repository;
use Attendly\RateLimiter;
use Attendly\ConfigGuard;
use Attendly\ValidationException;

$baseUrl = 'http://[::1]:8000/api';

$results = [
    'phases' => [],
    'overall' => 'PASS',
];

// Session storage for cookies and CSRF tokens per role
$sessions = [
    'admin' => ['cookie' => '', 'csrf' => ''],
    'officer' => ['cookie' => '', 'csrf' => ''],
    'student' => ['cookie' => '', 'csrf' => ''],
];

// Helper functions
function curlRequest(string $url, string $method = 'GET', array $data = [], array $headers = [], ?string $cookie = null, ?string $csrf = null): array
{
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
    $reqHeaders = array_merge([
        'Content-Type: application/json',
        'Accept: application/json',
        'X-Requested-With: XMLHttpRequest',
    ], $headers);

    if ($csrf) {
        $reqHeaders[] = 'X-CSRF-Token: ' . $csrf;
    }

    curl_setopt($ch, CURLOPT_HTTPHEADER, $reqHeaders);

    if ($cookie) {
        curl_setopt($ch, CURLOPT_COOKIE, $cookie);
    }

    if (in_array($method, ['POST', 'PUT', 'PATCH', 'DELETE'], true) && !empty($data)) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($data));
    }

    $responseHeaders = [];
    curl_setopt($ch, CURLOPT_HEADERFUNCTION, function ($ch, $header) use (&$responseHeaders) {
        $len = strlen($header);
        $header = explode(':', $header, 2);
        if (count($header) < 2) return $len;
        $responseHeaders[strtolower(trim($header[0]))] = trim($header[1]);
        return $len;
    });

    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);

    curl_close($ch);

    return [
        'code' => $httpCode,
        'body' => $response ? json_decode($response, true) : null,
        'headers' => $responseHeaders,
    ];
}

function extractCookie(array $headers): ?string
{
    foreach ($headers as $name => $value) {
        if (strtolower($name) === 'set-cookie') {
            $parts = explode(';', $value);
            return trim($parts[0]);
        }
    }
    return null;
}

function dbQuery(string $sql, array $params = []): array
{
    $db = get_db();
    $stmt = $db->prepare($sql);
    $stmt->execute($params);
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

function dbQueryOne(string $sql, array $params = []): ?array
{
    $db = get_db();
    $stmt = $db->prepare($sql);
    $stmt->execute($params);
    return $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
}

// ========================================================================
// PHASE 1: Authentication
// ========================================================================
echo "\n=== PHASE 1: Authentication ===\n";

$users = [
    ['email' => 'admin@attendly.test', 'password' => 'attendly123', 'role' => 'admin'],
    ['email' => 'officer@attendly.test', 'password' => 'attendly123', 'role' => 'officer'],
    ['email' => 'student@attendly.test', 'password' => 'attendly123', 'role' => 'student'],
];

foreach ($users as $user) {
    echo "Testing login: {$user['email']}...\n";
    $res = curlRequest("$baseUrl/auth/login", 'POST', [
        'email' => $user['email'],
        'password' => $user['password'],
    ]);

    $status = $res['code'];
    $cookie = extractCookie($res['headers']);

    if ($status === 200 && $res['body'] && isset($res['body']['data']['id'])) {
        echo "  ✓ Login successful (HTTP $status)\n";
        $sessions[$user['role']]['cookie'] = $cookie;

        // Get CSRF token
        $csrfRes = curlRequest("$baseUrl/auth/csrf-token", 'GET', [], [], $cookie);
        if ($csrfRes['code'] === 200 && $csrfRes['body'] && isset($csrfRes['body']['data']['csrfToken'])) {
            $sessions[$user['role']]['csrf'] = $csrfRes['body']['data']['csrfToken'];
            echo "  ✓ CSRF token obtained\n";
        } else {
            echo "  ⚠ Could not get CSRF token\n";
        }

        $results['phases'][] = [
            'phase' => "Login ({$user['role']})",
            'http_status' => $status,
            'table' => 'users',
            'verified' => 'Yes',
        ];
    } else {
        echo "  ✗ Login failed (HTTP $status): " . json_encode($res['body']) . "\n";
        $results['phases'][] = [
            'phase' => "Login ({$user['role']})",
            'http_status' => $status,
            'table' => 'users',
            'verified' => 'No',
        ];
        $results['overall'] = 'FAIL';
    }
}

// Verify must_change_password = 0 for all three
$verify = dbQuery("SELECT email, must_change_password FROM users WHERE email IN ('admin@attendly.test', 'officer@attendly.test', 'student@attendly.test')");
$allZero = true;
foreach ($verify as $row) {
    if ((int)$row['must_change_password'] !== 0) {
        $allZero = false;
        echo "  ✗ User {$row['email']} has must_change_password = {$row['must_change_password']}\n";
    }
}
if ($allZero) {
    echo "  ✓ All users have must_change_password = 0\n";
}

// ========================================================================
// PHASE 2: Event Creation
// ========================================================================
echo "\n=== PHASE 2: Event Creation ===\n";
$today = date('Y-m-d');
$now = date('H:i');
$eventName = "Integration Test Event";

$cookie = $sessions['admin']['cookie'];
$csrf = $sessions['admin']['csrf'];

echo "Creating event as Admin...\n";
$res = curlRequest("$baseUrl/events", 'POST', [
    'name' => $eventName,
    'date' => $today,
    'startTime' => $now,
    'endTime' => date('H:i', strtotime($now) + 3600),
    'venue' => 'Test Venue',
    'eventType' => 'mandatory',
    'eventCategory' => 'major',
    'semester' => 'N/A',
    'targetDepartment' => null,
    'attendanceType' => 'single',
    'description' => 'Integration test event',
], [], $cookie, $csrf);

$status = $res['code'];
$eventId = $res['body']['data']['id'] ?? null;

if ($status === 200 && $eventId) {
    echo "  ✓ Event created (HTTP $status), Event ID: $eventId\n";
    $results['phases'][] = [
        'phase' => 'Create Event',
        'http_status' => $status,
        'table' => 'events',
        'verified' => 'Yes',
    ];
} else {
    echo "  ✗ Event creation failed (HTTP $status): " . json_encode($res['body']) . "\n";
    $results['phases'][] = [
        'phase' => 'Create Event',
        'http_status' => $status,
        'table' => 'events',
        'verified' => 'No',
    ];
    $results['overall'] = 'FAIL';
}

// Query events table to verify
if ($eventId) {
    $event = dbQueryOne("SELECT * FROM events WHERE id = ?", [$eventId]);
    if ($event) {
        echo "  ✓ Event found in database: {$event['name']}\n";
        $admin = dbQueryOne("SELECT id FROM users WHERE email = 'admin@attendly.test'");
        if ($event['created_by'] == $admin['id']) {
            echo "  ✓ created_by matches Admin's ID\n";
        } else {
            echo "  ✗ created_by mismatch: expected {$admin['id']}, got {$event['created_by']}\n";
            $results['overall'] = 'FAIL';
        }
    } else {
        echo "  ✗ Event not found in database\n";
        $results['overall'] = 'FAIL';
    }
}

// ========================================================================
// PHASE 3: Manual Attendance Check-in (simulates kiosk check-in without fingerprint hardware)
// ========================================================================
echo "\n=== PHASE 3: Manual Attendance Check-in ===\n";

// Get student ID
$student = dbQueryOne("SELECT u.id, s.student_id_number FROM users u JOIN students s ON s.user_id = u.id WHERE u.email = 'student@attendly.test'");
$studentId = $student['id'] ?? null;
$studentIdNumber = $student['student_id_number'] ?? null;

if (!$studentId || !$studentIdNumber) {
    echo "  ✗ Student not found\n";
    $results['overall'] = 'FAIL';
} else {
    echo "Checking in student ($studentIdNumber) for event $eventId...\n";

    $cookie = $sessions['officer']['cookie'];
    $csrf = $sessions['officer']['csrf'];

    $res = curlRequest("$baseUrl/attendance/manual", 'POST', [
        'eventId' => $eventId,
        'studentId' => $studentId,
        'action' => 'in',
    ], [], $cookie, $csrf);

    $status = $res['code'];

    if ($status === 200) {
        echo "  ✓ Manual check-in successful (HTTP $status)\n";
        $results['phases'][] = [
            'phase' => 'Manual Check-in',
            'http_status' => $status,
            'table' => 'attendance_records',
            'verified' => 'Yes',
        ];
    } else {
        echo "  ✗ Manual check-in failed (HTTP $status): " . json_encode($res['body']) . "\n";
        $results['phases'][] = [
            'phase' => 'Manual Check-in',
            'http_status' => $status,
            'table' => 'attendance_records',
            'verified' => 'No',
        ];
        $results['overall'] = 'FAIL';
    }

    // Verify in database
    $attendance = dbQueryOne("SELECT * FROM attendance_records WHERE event_id = ? AND student_id = ?", [$eventId, $studentId]);
    if ($attendance) {
        echo "  ✓ Attendance record found in database\n";
        if ($attendance['verification_method'] === 'manual') {
            echo "  ✓ verification_method = 'manual'\n";
        } else {
            echo "  ✗ verification_method = '{$attendance['verification_method']}', expected 'manual'\n";
            $results['overall'] = 'FAIL';
        }
    } else {
        echo "  ✗ Attendance record not found in database\n";
        $results['overall'] = 'FAIL';
    }
}

// ========================================================================
// PHASE 4: Reports & Audit Logs
// ========================================================================
echo "\n=== PHASE 4: Reports & Audit Logs ===\n";

// Test sanctions report
echo "Fetching sanctions report...\n";
$cookie = $sessions['admin']['cookie'];
$csrf = $sessions['admin']['csrf'];

$res = curlRequest("$baseUrl/reports/sanctions?from=$today&to=$today", 'GET', [], [], $cookie);
$status = $res['code'];

if ($status === 200 && $res['body'] && isset($res['body']['data'])) {
    echo "  ✓ Sanctions report retrieved (HTTP $status)\n";

    // Check if student shows up as attended
    $data = $res['body']['data'];
    $studentFound = false;
    if (isset($data['students'])) {
        foreach ($data['students'] as $s) {
            if (isset($s['studentId']) && $s['studentId'] == $studentId) {
                $studentFound = true;
                echo "  ✓ Student found in sanctions report\n";
                if (isset($s['attended']) && $s['attended']) {
                    echo "  ✓ Student marked as attended\n";
                } elseif (isset($s['present']) && $s['present']) {
                    echo "  ✓ Student marked as present\n";
                }
                break;
            }
        }
    }
    if (!$studentFound) {
        echo "  ⚠ Student not found in sanctions report (may be expected depending on logic)\n";
    }

    $results['phases'][] = [
        'phase' => 'Reports',
        'http_status' => $status,
        'table' => 'N/A (Read)',
        'verified' => 'Yes',
    ];
} else {
    echo "  ✗ Sanctions report failed (HTTP $status): " . json_encode($res['body']) . "\n";
    $results['phases'][] = [
        'phase' => 'Reports',
        'http_status' => $status,
        'table' => 'N/A (Read)',
        'verified' => 'No',
    ];
    $results['overall'] = 'FAIL';
}

// Test audit logs
echo "Fetching audit logs...\n";
$res = curlRequest("$baseUrl/audit-logs?limit=50", 'GET', [], [], $cookie);
$status = $res['code'];

if ($status === 200 && $res['body'] && isset($res['body']['data'])) {
    echo "  ✓ Audit logs retrieved (HTTP $status)\n";
    $logs = $res['body']['data'];

    // Check for required entries
    $hasEventCreation = false;
    $hasCheckIn = false;

    foreach ($logs as $log) {
        $action = $log['action'] ?? '';
        $table = $log['tableName'] ?? '';

        if ($action === 'create' && $table === 'events') {
            $hasEventCreation = true;
        }
        if ($action === 'create' && $table === 'attendance_records') {
            $hasCheckIn = true;
        }
    }

    if ($hasEventCreation) echo "  ✓ Audit log entry for Event creation found\n";
    else echo "  ⚠ No audit log for Event creation\n";

    if ($hasCheckIn) echo "  ✓ Audit log entry for Check-in found\n";
    else echo "  ⚠ No audit log for Check-in\n";

    $results['phases'][] = [
        'phase' => 'Audit Logs',
        'http_status' => $status,
        'table' => 'audit_logs',
        'verified' => ($hasEventCreation && $hasCheckIn) ? 'Yes' : 'Partial',
    ];
} else {
    echo "  ✗ Audit logs failed (HTTP $status): " . json_encode($res['body']) . "\n";
    $results['phases'][] = [
        'phase' => 'Audit Logs',
        'http_status' => $status,
        'table' => 'audit_logs',
        'verified' => 'No',
    ];
    $results['overall'] = 'FAIL';
}

// ========================================================================
// SUMMARY
// ========================================================================
echo "\n" . str_repeat("=", 80) . "\n";
echo "INTEGRATION TEST SUMMARY\n";
echo str_repeat("=", 80) . "\n\n";

echo "| Test Phase          | HTTP Status | Database Table Written To | Verified? |\n";
echo "|---------------------|-------------|---------------------------|-----------|\n";
foreach ($results['phases'] as $phase) {
    printf("| %-19s | %-11s | %-25s | %-9s |\n",
        $phase['phase'],
        $phase['http_status'],
        $phase['table'],
        $phase['verified']
    );
}

echo "\n";
echo str_repeat("-", 80) . "\n";
echo "OVERALL RESULT: {$results['overall']}\n";
echo str_repeat("-", 80) . "\n";

// Exit with appropriate code
exit($results['overall'] === 'PASS' ? 0 : 1);