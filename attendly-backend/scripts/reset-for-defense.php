<?php
/**
 * ATTENDLY — Defense Reset Script
 *
 * CLI:  php scripts/reset-for-defense.php
 *
 * Creates a completely clean database with:
 *   - 3 test accounts (admin, officer, student@example.com)
 *   - 20 Filipino students across 5 programs × 4 year levels
 *   - 5 events with realistic categories
 *   - Attendance records + correction requests for demo
 *
 * Usage:
 *   php scripts/reset-for-defense.php
 */

declare(strict_types=1);

if (php_sapi_name() !== 'cli' || getenv('APP_ENV') === 'production') {
    die("Forbidden.\n");
}

use Attendly\PublicIdGenerator;

require __DIR__ . '/../config/db.php';
require __DIR__ . '/../config/config.php';
require __DIR__ . '/../src/PublicIdGenerator.php';

$defensePassword = 'password123';
$hash = password_hash($defensePassword, PASSWORD_DEFAULT);

function out(string $message): void
{
    fwrite(STDOUT, $message . PHP_EOL);
}

function err(string $message): void
{
    fwrite(STDERR, $message . PHP_EOL);
}

try {
    out('=== ATTENDLY Defense Reset ===');
    out('');

    // ────────────────────────────────────────────────────────────────
    // 1. MySQL DATABASE WIPE
    // ────────────────────────────────────────────────────────────────
    out('[1/5] Wiping MySQL database...');
    $mysql = get_db();

    // Disable foreign key checks
    $mysql->exec('SET FOREIGN_KEY_CHECKS = 0;');

    // Fetch all BASE TABLES (skip views)
    $tables = $mysql->query("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'")->fetchAll(PDO::FETCH_COLUMN);

    foreach ($tables as $table) {
        if ($table === 'schema_migrations') {
            out("  - Skipping 'schema_migrations' (preserving migration history)");
            continue;
        }
        $mysql->exec("TRUNCATE TABLE `$table`");
        out("  - Truncated: $table");
    }

    // Re-enable foreign key checks
    $mysql->exec('SET FOREIGN_KEY_CHECKS = 1;');
    out('  MySQL wipe complete.');

    // ────────────────────────────────────────────────────────────────
    // 2. CLEAR SQLITE QUEUE
    // ────────────────────────────────────────────────────────────────
    out('');
    out('[2/5] Clearing SQLite queue...');
    $sqlitePath = __DIR__ . '/../queue.sqlite';
    if (file_exists($sqlitePath)) {
        $sqlite = new PDO('sqlite:' . $sqlitePath);
        $sqlite->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $sqlite->exec('DROP TABLE IF EXISTS job_queue;');
        out('  Dropped job_queue table (will be recreated by worker on next run).');
    } else {
        out('  queue.sqlite not found (worker will create it on first run).');
    }
    out('  SQLite queue clear complete.');

    // ────────────────────────────────────────────────────────────────
    // 3. CREATE THE 3 DEFENSE ACCOUNTS (IDs 1, 2, 3)
    // ────────────────────────────────────────────────────────────────
    out('');
    out('[3/5] Creating 3 defense accounts...');

    $mysql->beginTransaction();

    try {
        // ── Admin (ID 1) ───────────────────────────────────────────────
        $adminPublicId = 'USR_001';
        $mysql->prepare(
            'INSERT INTO users
                (public_id, role, email, display_name, password_hash, status, must_change_password)
             VALUES
                (:public_id, \'administrator\', :email, :display_name, :hash, \'active\', 0)'
        )->execute([
            'public_id'    => $adminPublicId,
            'email'        => 'admin@example.com',
            'display_name' => 'System Administrator',
            'hash'         => $hash,
        ]);
        $adminId = (int) $mysql->lastInsertId();

        $mysql->prepare(
            'INSERT INTO administrators (user_id) VALUES (:uid)'
        )->execute(['uid' => $adminId]);

        out("  ✓ Created admin: admin@example.com (Public ID: $adminPublicId)");

        // ── SSC Officer (ID 2) ─────────────────────────────────────────
        $officerPublicId = 'SSC_001';
        $mysql->prepare(
            'INSERT INTO users
                (public_id, role, email, display_name, password_hash, status, must_change_password)
             VALUES
                (:public_id, \'ssc_officer\', :email, :display_name, :hash, \'active\', 0)'
        )->execute([
            'public_id'    => $officerPublicId,
            'email'        => 'officer@example.com',
            'display_name' => 'SSC Officer',
            'hash'         => $hash,
        ]);
        $officerId = (int) $mysql->lastInsertId();

        $mysql->prepare(
            'INSERT INTO ssc_officers
                (user_id, position, approved_by, approved_at, status)
             VALUES
                (:uid, :position, :approved_by, NOW(), \'approved\')'
        )->execute([
            'uid'         => $officerId,
            'position'    => 'Secretary',
            'approved_by' => $adminId,
        ]);

        out("  ✓ Created SSC officer: officer@example.com (Public ID: $officerPublicId)");

        // ── Student (ID 3) ─────────────────────────────────────────────
        $studentPublicId = 'STUD_001';
        $studentIdNumber = '2024-00001';

        $mysql->prepare(
            'INSERT INTO users
                (public_id, role, email, display_name, password_hash, status, must_change_password)
             VALUES
                (:public_id, \'student\', :email, :display_name, :hash, \'active\', 0)'
        )->execute([
            'public_id'    => $studentPublicId,
            'email'        => 'student@example.com',
            'display_name' => 'Test Student',
            'hash'         => $hash,
        ]);
        $studentId = (int) $mysql->lastInsertId();

        $mysql->prepare(
            'INSERT INTO students
                (user_id, student_id_number, first_name, last_name, department,
                 program, year_level, block)
             VALUES
                (:uid, :idnum, :first, :last, :department,
                 :program, :year, :block)'
        )->execute([
            'uid'        => $studentId,
            'idnum'      => $studentIdNumber,
            'first'      => 'Test',
            'last'       => 'Student',
            'department' => 'School of Computer Studies',
            'program'    => 'BSIT',
            'year'       => '4',
            'block'      => 'A',
        ]);

        out("  ✓ Created student: student@example.com (Public ID: $studentPublicId)");

        $mysql->commit();
    } catch (Throwable $e) {
        if ($mysql->inTransaction()) {
            $mysql->rollBack();
        }
        throw $e;
    }

    // ────────────────────────────────────────────────────────────────
    // 4. CREATE 20 FILIPINO STUDENTS (IDs 4 through 23)
    // ────────────────────────────────────────────────────────────────
    out('');
    out('[4/5] Creating 20 Filipino students...');

    $students = [
        // BSIT — School of Computer Studies
        ['first' => 'Juan', 'last' => 'Dela Cruz', 'program' => 'BSIT', 'department' => 'School of Computer Studies', 'year' => '1', 'block' => 'A', 'email' => 'juan.delacruz@example.com', 'student_id' => '2024-0002', 'public_id' => 'STUD_002'],
        ['first' => 'Andres', 'last' => 'Bonifacio', 'program' => 'BSIT', 'department' => 'School of Computer Studies', 'year' => '2', 'block' => 'A', 'email' => 'andres.bonifacio@example.com', 'student_id' => '2024-0003', 'public_id' => 'STUD_003'],
        ['first' => 'Marcelo', 'last' => 'del Pilar', 'program' => 'BSIT', 'department' => 'School of Computer Studies', 'year' => '3', 'block' => 'A', 'email' => 'marcelo.delpilar@example.com', 'student_id' => '2024-0004', 'public_id' => 'STUD_004'],
        ['first' => 'Francisco', 'last' => 'Balagtas', 'program' => 'BSIT', 'department' => 'School of Computer Studies', 'year' => '4', 'block' => 'A', 'email' => 'francisco.balagtas@example.com', 'student_id' => '2024-0005', 'public_id' => 'STUD_005'],

        // BSEntrep — School of Business and Management
        ['first' => 'Jose', 'last' => 'Rizal', 'program' => 'BSEntrep', 'department' => 'School of Business and Management', 'year' => '1', 'block' => 'A', 'email' => 'jose.rizal@example.com', 'student_id' => '2024-0006', 'public_id' => 'STUD_006'],
        ['first' => 'Melchora', 'last' => 'Aquino', 'program' => 'BSEntrep', 'department' => 'School of Business and Management', 'year' => '2', 'block' => 'A', 'email' => 'melchora.aquino@example.com', 'student_id' => '2024-0007', 'public_id' => 'STUD_007'],
        ['first' => 'Trinidad', 'last' => 'Tecson', 'program' => 'BSEntrep', 'department' => 'School of Business and Management', 'year' => '3', 'block' => 'A', 'email' => 'trinidad.tecson@example.com', 'student_id' => '2024-0008', 'public_id' => 'STUD_008'],
        ['first' => 'Ramon', 'last' => 'Magsaysay', 'program' => 'BSEntrep', 'department' => 'School of Business and Management', 'year' => '4', 'block' => 'A', 'email' => 'ramon.magsaysay@example.com', 'student_id' => '2024-0009', 'public_id' => 'STUD_009'],

        // BSHM — School of Business and Management
        ['first' => 'Gabriela', 'last' => 'Silang', 'program' => 'BSHM', 'department' => 'School of Business and Management', 'year' => '1', 'block' => 'A', 'email' => 'gabriela.silang@example.com', 'student_id' => '2024-0010', 'public_id' => 'STUD_010'],
        ['first' => 'Graciano', 'last' => 'Lopez Jaena', 'program' => 'BSHM', 'department' => 'School of Business and Management', 'year' => '2', 'block' => 'A', 'email' => 'graciano.lopezjaena@example.com', 'student_id' => '2024-0011', 'public_id' => 'STUD_011'],
        ['first' => 'Gregoria', 'last' => 'de Jesus', 'program' => 'BSHM', 'department' => 'School of Business and Management', 'year' => '3', 'block' => 'A', 'email' => 'gregoria.dejesus@example.com', 'student_id' => '2024-0012', 'public_id' => 'STUD_012'],
        ['first' => 'Corazon', 'last' => 'Aquino', 'program' => 'BSHM', 'department' => 'School of Business and Management', 'year' => '4', 'block' => 'A', 'email' => 'corazon.aquino@example.com', 'student_id' => '2024-0013', 'public_id' => 'STUD_013'],

        // BSTM — School of Business and Management
        ['first' => 'Diego', 'last' => 'Silang', 'program' => 'BSTM', 'department' => 'School of Business and Management', 'year' => '1', 'block' => 'A', 'email' => 'diego.silang@example.com', 'student_id' => '2024-0014', 'public_id' => 'STUD_014'],
        ['first' => 'Apolinario', 'last' => 'Mabini', 'program' => 'BSTM', 'department' => 'School of Business and Management', 'year' => '2', 'block' => 'A', 'email' => 'apolinario.mabini@example.com', 'student_id' => '2024-0015', 'public_id' => 'STUD_015'],
        ['first' => 'Josefa', 'last' => 'Llanes Escoda', 'program' => 'BSTM', 'department' => 'School of Business and Management', 'year' => '3', 'block' => 'A', 'email' => 'josefa.llanesescoda@example.com', 'student_id' => '2024-0016', 'public_id' => 'STUD_016'],
        ['first' => 'Antonio', 'last' => 'Luna', 'program' => 'BSTM', 'department' => 'School of Business and Management', 'year' => '4', 'block' => 'A', 'email' => 'antonio.luna@example.com', 'student_id' => '2024-0017', 'public_id' => 'STUD_017'],

        // BSN — School of Nursing
        ['first' => 'Emilio', 'last' => 'Aguinaldo', 'program' => 'BSN', 'department' => 'School of Nursing', 'year' => '1', 'block' => 'A', 'email' => 'emilio.aguinaldo@example.com', 'student_id' => '2024-0018', 'public_id' => 'STUD_018'],
        ['first' => 'Benigno', 'last' => 'Aquino', 'program' => 'BSN', 'department' => 'School of Nursing', 'year' => '2', 'block' => 'A', 'email' => 'benigno.aquino@example.com', 'student_id' => '2024-0019', 'public_id' => 'STUD_019'],
        ['first' => 'Leona', 'last' => 'Florentino', 'program' => 'BSN', 'department' => 'School of Nursing', 'year' => '3', 'block' => 'A', 'email' => 'leona.florentino@example.com', 'student_id' => '2024-0020', 'public_id' => 'STUD_020'],
        ['first' => 'Jose', 'last' => 'Abad Santos', 'program' => 'BSN', 'department' => 'School of Nursing', 'year' => '4', 'block' => 'A', 'email' => 'jose.abad.santos@example.com', 'student_id' => '2024-0021', 'public_id' => 'STUD_021'],
    ];

    $mysql->beginTransaction();
    try {
        foreach ($students as $s) {
            $displayName = $s['first'] . ' ' . $s['last'];
            $mysql->prepare(
                'INSERT INTO users
                    (public_id, role, email, display_name, password_hash, status, must_change_password)
                 VALUES
                    (:public_id, \'student\', :email, :display_name, :hash, \'active\', 0)'
            )->execute([
                'public_id'    => $s['public_id'],
                'email'        => $s['email'],
                'display_name' => $displayName,
                'hash'         => $hash,
            ]);
            $uid = (int) $mysql->lastInsertId();

            $mysql->prepare(
                'INSERT INTO students
                    (user_id, student_id_number, first_name, last_name, department,
                     program, year_level, block)
                 VALUES
                    (:uid, :idnum, :first, :last, :department,
                     :program, :year, :block)'
            )->execute([
                'uid'        => $uid,
                'idnum'      => $s['student_id'],
                'first'      => $s['first'],
                'last'       => $s['last'],
                'department' => $s['department'],
                'program'    => $s['program'],
                'year'       => $s['year'],
                'block'      => $s['block'],
            ]);
            out("  ✓ Created: {$displayName} ({$s['program']}, Year {$s['year']})");
        }
        $mysql->commit();
    } catch (Throwable $e) {
        if ($mysql->inTransaction()) {
            $mysql->rollBack();
        }
        throw $e;
    }

    // ────────────────────────────────────────────────────────────────
    // 5. CREATE 5 EVENTS + ATTENDANCE RECORDS + CORRECTION REQUESTS
    // ────────────────────────────────────────────────────────────────
    out('');
    out('[5/5] Creating 5 events, attendance records, and correction requests...');

    $mysql->beginTransaction();
    try {
        // Get all student user_ids for attendance
        $allStudentIds = $mysql->query("SELECT user_id FROM students ORDER BY user_id")->fetchAll(PDO::FETCH_COLUMN);
        // We'll use first 10 students for attendance (IDs 3 through 12)
        $attendanceStudentIds = array_slice($allStudentIds, 0, 10);

        // Events data
        $events = [
            [
                'public_id' => 'EVNT_001',
                'name' => 'Intramurals 2026',
                'description' => 'Annual university-wide sports competition opening and team events.',
                'event_date' => '2026-09-14',
                'start_time' => '08:00:00',
                'end_time' => '17:00:00',
                'venue' => 'University Gymnasium',
                'event_type' => 'mandatory',
                'event_category' => 'major',
                'semester' => '1st Semester',
                'target_department' => null,
                'attendance_type' => 'in_out',
                'checkout_open_minutes' => 60,
                'checkout_close_minutes' => 60,
            ],
            [
                'public_id' => 'EVNT_002',
                'name' => 'IT Week',
                'description' => 'Technology talks, hackathon and project exhibits by computing students.',
                'event_date' => '2026-10-19',
                'start_time' => '08:00:00',
                'end_time' => '17:00:00',
                'venue' => 'SCS Auditorium',
                'event_type' => 'mandatory',
                'event_category' => 'major',
                'semester' => '1st Semester',
                'target_department' => null,
                'attendance_type' => 'in_out',
                'checkout_open_minutes' => 60,
                'checkout_close_minutes' => 60,
            ],
            [
                'public_id' => 'EVNT_003',
                'name' => 'General Assembly',
                'description' => 'Student council assembly on plans, budget and second-semester activities.',
                'event_date' => '2026-11-06',
                'start_time' => '09:00:00',
                'end_time' => '15:00:00',
                'venue' => 'University Theater',
                'event_type' => 'mandatory',
                'event_category' => 'minor',
                'semester' => '1st Semester',
                'target_department' => null,
                'attendance_type' => 'single',
                'checkout_open_minutes' => 60,
                'checkout_close_minutes' => 60,
            ],
            [
                'public_id' => 'EVNT_004',
                'name' => 'Flag Ceremony',
                'description' => 'Weekly flag-raising ceremony for the university community.',
                'event_date' => '2026-08-23',
                'start_time' => '07:00:00',
                'end_time' => '08:00:00',
                'venue' => 'Main Quadrangle',
                'event_type' => 'mandatory',
                'event_category' => 'minor',
                'semester' => '1st Semester',
                'target_department' => null,
                'attendance_type' => 'single',
                'checkout_open_minutes' => 60,
                'checkout_close_minutes' => 60,
            ],
            [
                'public_id' => 'EVNT_005',
                'name' => 'Foundation Day',
                'description' => 'Institutional anniversary program, alumni homecoming and awarding.',
                'event_date' => '2026-09-30',
                'start_time' => '09:00:00',
                'end_time' => '16:00:00',
                'venue' => 'Main Auditorium',
                'event_type' => 'mandatory',
                'event_category' => 'major',
                'semester' => '1st Semester',
                'target_department' => null,
                'attendance_type' => 'in_out',
                'checkout_open_minutes' => 60,
                'checkout_close_minutes' => 60,
            ],
        ];

        $eventIds = [];
        foreach ($events as $evt) {
            $mysql->prepare(
                'INSERT INTO events
                    (public_id, name, description, event_date, start_time, end_time, venue,
                     event_type, event_category, semester, target_department,
                     attendance_type, checkout_open_minutes, checkout_close_minutes,
                     status, created_by, created_at, updated_at)
                 VALUES
                    (:public_id, :name, :description, :event_date, :start_time, :end_time, :venue,
                     :event_type, :event_category, :semester, :target_department,
                     :attendance_type, :checkout_open, :checkout_close,
                     \'scheduled\', :created_by, NOW(), NOW())'
            )->execute([
                'public_id'         => $evt['public_id'],
                'name'              => $evt['name'],
                'description'       => $evt['description'],
                'event_date'        => $evt['event_date'],
                'start_time'        => $evt['start_time'],
                'end_time'          => $evt['end_time'],
                'venue'             => $evt['venue'],
                'event_type'        => $evt['event_type'],
                'event_category'    => $evt['event_category'],
                'semester'          => $evt['semester'],
                'target_department' => $evt['target_department'],
                'attendance_type'   => $evt['attendance_type'],
                'checkout_open'     => $evt['checkout_open_minutes'],
                'checkout_close'    => $evt['checkout_close_minutes'],
                'created_by'        => $adminId,
            ]);
            $eid = (int) $mysql->lastInsertId();
            $eventIds[] = $eid;
            out("  ✓ Created event: {$evt['name']} (ID: $eid)");
        }

        // Attendance records: first 10 students attend first 2 events
        // Use manual verification, scan_number = 1 for in_out events (check-in)
        $attendanceCount = 0;
        foreach ($attendanceStudentIds as $sid) {
            // Event 1 (Intramurals 2026) - in_out, scan 1 = check-in
            $mysql->prepare(
                'INSERT INTO attendance_records
                    (event_id, student_id, check_in_time, verification_method, scan_number)
                 VALUES
                    (:eid, :sid, :checkin, \'manual\', 1)'
            )->execute([
                'eid'      => $eventIds[0],
                'sid'      => $sid,
                'checkin'  => date('Y-m-d H:i:s', strtotime($events[0]['event_date'] . ' ' . $events[0]['start_time'] . ' +8 minutes')),
            ]);
            $attendanceCount++;

            // Event 2 (IT Week) - in_out, scan 1 = check-in
            $mysql->prepare(
                'INSERT INTO attendance_records
                    (event_id, student_id, check_in_time, verification_method, scan_number)
                 VALUES
                    (:eid, :sid, :checkin, \'manual\', 1)'
            )->execute([
                'eid'      => $eventIds[1],
                'sid'      => $sid,
                'checkin'  => date('Y-m-d H:i:s', strtotime($events[1]['event_date'] . ' ' . $events[1]['start_time'] . ' +8 minutes')),
            ]);
            $attendanceCount++;
        }
        out("  ✓ Inserted $attendanceCount attendance records (10 students × 2 events)");

        // Add check-out times for some students (scan 2 for in_out events)
        // Let's add check-out for first 5 students on both events
        $checkoutStudentIds = array_slice($attendanceStudentIds, 0, 5);
        foreach ($checkoutStudentIds as $sid) {
            // Event 1 check-out
            $mysql->prepare(
                'UPDATE attendance_records
                 SET check_out_time = :checkout
                 WHERE event_id = :eid AND student_id = :sid AND scan_number = 1'
            )->execute([
                'eid'     => $eventIds[0],
                'sid'     => $sid,
                'checkout' => date('Y-m-d H:i:s', strtotime($events[0]['event_date'] . ' ' . $events[0]['end_time'] . ' -10 minutes')),
            ]);

            // Event 2 check-out
            $mysql->prepare(
                'UPDATE attendance_records
                 SET check_out_time = :checkout
                 WHERE event_id = :eid AND student_id = :sid AND scan_number = 1'
            )->execute([
                'eid'     => $eventIds[1],
                'sid'     => $sid,
                'checkout' => date('Y-m-d H:i:s', strtotime($events[1]['event_date'] . ' ' . $events[1]['end_time'] . ' -10 minutes')),
            ]);
        }
        out("  ✓ Added check-out times for 5 students on 2 events");

        // 2 attendance correction requests
        // Request 1: Student ID 3 (Andres Bonifacio) for Event 1 (Intramurals)
        // Request 2: Student ID 4 (Marcelo del Pilar) for Event 2 (IT Week)
        $correctionRequests = [
            [
                'student_id' => $allStudentIds[1], // Andres Bonifacio (index 1 = ID 4)
                'event_id' => $eventIds[0],
                'requested_check_in_time' => date('Y-m-d H:i:s', strtotime($events[0]['event_date'] . ' ' . $events[0]['start_time'] . ' +15 minutes')),
                'reason' => 'Forgot to scan during check-in window due to long queue at the gate.',
                'proof_image' => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
            ],
            [
                'student_id' => $allStudentIds[2], // Marcelo del Pilar (index 2 = ID 5)
                'event_id' => $eventIds[1],
                'requested_check_in_time' => date('Y-m-d H:i:s', strtotime($events[1]['event_date'] . ' ' . $events[1]['start_time'] . ' +20 minutes')),
                'reason' => 'Arrived late because of traffic, security guard can verify.',
                'proof_image' => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
            ],
        ];

        foreach ($correctionRequests as $cr) {
            $mysql->prepare(
                'INSERT INTO attendance_correction_requests
                    (student_id, event_id, requested_check_in_time, reason, proof_image, status, created_at)
                 VALUES
                    (:sid, :eid, :reqtime, :reason, :proof, \'pending\', NOW())'
            )->execute([
                'sid'      => $cr['student_id'],
                'eid'      => $cr['event_id'],
                'reqtime'  => $cr['requested_check_in_time'],
                'reason'   => $cr['reason'],
                'proof'    => $cr['proof_image'],
            ]);
            out("  ✓ Created correction request for student {$cr['student_id']} on event {$cr['event_id']}");
        }

        $mysql->commit();
    } catch (Throwable $e) {
        if ($mysql->inTransaction()) {
            $mysql->rollBack();
        }
        throw $e;
    }

    // ────────────────────────────────────────────────────────────────
    // SUMMARY
    // ────────────────────────────────────────────────────────────────
    out('');
    out('=== DEFENSE RESET COMPLETE ===');
    out('');

    $userCount = $mysql->query("SELECT COUNT(*) FROM users")->fetchColumn();
    $eventCount = $mysql->query("SELECT COUNT(*) FROM events")->fetchColumn();
    $attCount = $mysql->query("SELECT COUNT(*) FROM attendance_records")->fetchColumn();
    $crCount = $mysql->query("SELECT COUNT(*) FROM attendance_correction_requests")->fetchColumn();

    out('Database state:');
    out('  • MySQL: All tables truncated (except schema_migrations)');
    out('  • SQLite: job_queue dropped (fresh on next worker start)');
    out("  • Users created: $userCount (3 testers + 20 students)");
    out("  • Events created: $eventCount");
    out("  • Attendance records: $attCount");
    out("  • Correction requests: $crCount");
    out('');
    out('All accounts use password: password123');
    out('Ready for defense demonstration.');

} catch (Throwable $e) {
    err('');
    err('ERROR: ' . $e->getMessage());
    err($e->getTraceAsString());
    exit(1);
}