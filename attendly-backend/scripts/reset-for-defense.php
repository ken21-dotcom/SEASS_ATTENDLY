<?php
/**
 * ATTENDLY — Defense Reset Script
 *
 * Run from attendly-backend:
 *   php scripts/reset-for-defense.php
 *
 * This permanently removes application data while preserving the database
 * schema and migration history. It then seeds exactly three demo accounts:
 * an administrator, an SSC officer, and a student (all with password "attendly123").
 */

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    fwrite(STDERR, "This script may only run from the command line.\n");
    exit(1);
}

require __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../src/ProgramCatalog.php';

use Attendly\ProgramCatalog;

/** Quote a MySQL identifier obtained from SHOW FULL TABLES. */
function quoteIdentifier(string $identifier): string
{
    return '`' . str_replace('`', '``', $identifier) . '`';
}

/** @param array<string,int> $counts */
function printCounts(string $heading, array $counts): void
{
    fwrite(STDOUT, $heading . PHP_EOL);
    foreach ($counts as $table => $count) {
        fwrite(STDOUT, "  {$table}: {$count}" . PHP_EOL);
    }
}

try {
    $mysql = get_db();
    $mysql->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

    fwrite(STDOUT, "=== ATTENDLY Defense Reset ===\n");
    fwrite(STDOUT, "Disabling MySQL foreign-key checks...\n");
    $mysql->exec('SET FOREIGN_KEY_CHECKS = 0;');

    try {
        $tables = $mysql->query(
            "SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'"
        )->fetchAll(PDO::FETCH_NUM);

        $truncated = [];
        foreach ($tables as $row) {
            $table = (string) ($row[0] ?? '');
            // Migration history is schema metadata, not application data.
            if ($table === '' || $table === 'schema_migrations') {
                continue;
            }
            $mysql->exec('TRUNCATE TABLE ' . quoteIdentifier($table));
            $truncated[] = $table;
        }
    } finally {
        $mysql->exec('SET FOREIGN_KEY_CHECKS = 1;');
    }

    fwrite(STDOUT, "Truncated " . count($truncated) . " MySQL data tables.\n");
    foreach ($truncated as $table) {
        $remaining = (int) $mysql->query(
            'SELECT COUNT(*) FROM ' . quoteIdentifier($table)
        )->fetchColumn();
        if ($remaining !== 0) {
            throw new RuntimeException("Table {$table} still contains {$remaining} row(s) after truncation.");
        }
    }
    fwrite(STDOUT, "Verified all truncated MySQL tables are empty.\n");

    $queuePath = __DIR__ . '/../queue.sqlite';
    $queueCount = 0;
    if (is_file($queuePath)) {
        $queue = new PDO('sqlite:' . $queuePath, null, null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        ]);
        $hasQueue = (int) $queue->query(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'job_queue'"
        )->fetchColumn();
        if ($hasQueue === 1) {
            $queue->exec('DELETE FROM job_queue');
            $queueCount = (int) $queue->query('SELECT COUNT(*) FROM job_queue')->fetchColumn();
        }
    }
    fwrite(STDOUT, "SQLite job_queue rows remaining: {$queueCount}\n");

    $password = 'attendly123';
    $hash = password_hash($password, PASSWORD_DEFAULT);
    if ($hash === false) {
        throw new RuntimeException('Could not hash the demo account password.');
    }

    $department = ProgramCatalog::departmentForProgram('BSIT') ?? 'School of Computer Studies';

    $mysql->beginTransaction();
    try {
        $insertUser = $mysql->prepare(
            "INSERT INTO users
                (public_id, role, email, display_name, password_hash, status, must_change_password)
             VALUES
                (:public_id, :role, :email, :display_name, :password_hash, 'active', 0)"
        );

        // 1. Admin account
        $insertUser->execute([
            'public_id' => 'ADM_001',
            'role' => 'administrator',
            'email' => 'admin@attendly.test',
            'display_name' => 'System Administrator',
            'password_hash' => $hash,
        ]);
        $adminId = (int) $mysql->lastInsertId();

        $mysql->prepare('INSERT INTO administrators (user_id) VALUES (:user_id)')
            ->execute(['user_id' => $adminId]);

        // 2. Officer account
        $insertUser->execute([
            'public_id' => 'SSC_001',
            'role' => 'ssc_officer',
            'email' => 'officer@attendly.test',
            'display_name' => 'SSC Officer',
            'password_hash' => $hash,
        ]);
        $officerId = (int) $mysql->lastInsertId();

        $mysql->prepare(
            "INSERT INTO ssc_officers (user_id, position, approved_by, approved_at, status)
             VALUES (:user_id, 'SSC Officer', :approved_by, NOW(), 'approved')"
        )->execute([
            'user_id' => $officerId,
            'approved_by' => $adminId,
        ]);

        // 3. Student account
        $insertUser->execute([
            'public_id' => 'STUD_001',
            'role' => 'student',
            'email' => 'student@attendly.test',
            'display_name' => 'Test Student',
            'password_hash' => $hash,
        ]);
        $studentId = (int) $mysql->lastInsertId();

        $mysql->prepare(
            "INSERT INTO students
                (user_id, student_id_number, first_name, last_name, department, program, year_level, block, approved_by, approved_at)
             VALUES
                (:user_id, '2026-00001', 'Test', 'Student', :department, 'BSIT', '3rd Year', '1-A', :approved_by, NOW())"
        )->execute([
            'user_id' => $studentId,
            'department' => $department,
            'approved_by' => $adminId,
        ]);

        $mysql->commit();
    } catch (Throwable $error) {
        if ($mysql->inTransaction()) {
            $mysql->rollBack();
        }
        throw $error;
    }

    $verification = [
        'users' => (int) $mysql->query('SELECT COUNT(*) FROM users')->fetchColumn(),
        'administrators' => (int) $mysql->query('SELECT COUNT(*) FROM administrators')->fetchColumn(),
        'ssc_officers' => (int) $mysql->query('SELECT COUNT(*) FROM ssc_officers')->fetchColumn(),
        'students' => (int) $mysql->query('SELECT COUNT(*) FROM students')->fetchColumn(),
        'events' => (int) $mysql->query('SELECT COUNT(*) FROM events')->fetchColumn(),
        'attendance_records' => (int) $mysql->query('SELECT COUNT(*) FROM attendance_records')->fetchColumn(),
    ];
    printCounts('Verification Table Counts:', $verification);

    if ($verification !== [
        'users' => 3,
        'administrators' => 1,
        'ssc_officers' => 1,
        'students' => 1,
        'events' => 0,
        'attendance_records' => 0,
    ]) {
        throw new RuntimeException('Table count verification failed: expected exactly 3 users.');
    }

    // Verify all 3 users exist and passwords verify correctly
    $userStmt = $mysql->prepare(
        "SELECT u.id, u.public_id, u.role, u.email, u.display_name, u.status, u.password_hash,
                a.user_id AS is_admin,
                o.position AS officer_position, o.status AS officer_status,
                s.student_id_number, s.first_name, s.last_name, s.department, s.program, s.year_level
         FROM users u
         LEFT JOIN administrators a ON a.user_id = u.id
         LEFT JOIN ssc_officers o ON o.user_id = u.id
         LEFT JOIN students s ON s.user_id = u.id
         ORDER BY u.id ASC"
    );
    $userStmt->execute();
    $seededUsers = $userStmt->fetchAll(PDO::FETCH_ASSOC);

    fwrite(STDOUT, "\nSeeded Users Details:\n");
    foreach ($seededUsers as $u) {
        $validPass = password_verify($password, (string) $u['password_hash']);
        if (!$validPass) {
            throw new RuntimeException("Password verification failed for user {$u['email']}.");
        }
        fwrite(STDOUT, "  - [{$u['role']}] {$u['email']} | Public ID: {$u['public_id']} | Status: {$u['status']} | Password: Valid\n");
        if ($u['role'] === 'ssc_officer') {
            fwrite(STDOUT, "    Position: {$u['officer_position']} | Officer Status: {$u['officer_status']}\n");
            if ($u['officer_status'] !== 'approved') {
                throw new RuntimeException("Officer status is not 'approved'.");
            }
        } elseif ($u['role'] === 'student') {
            fwrite(STDOUT, "    Student ID: {$u['student_id_number']} | Name: {$u['first_name']} {$u['last_name']} | Dept: {$u['department']} | Program: {$u['program']} | Year: {$u['year_level']}\n");
        }
    }

    fwrite(STDOUT, "\nDefense reset complete. Exactly 3 demo accounts are active and ready.\n");
} catch (Throwable $error) {
    fwrite(STDERR, 'RESET FAILED: ' . $error->getMessage() . PHP_EOL);
    exit(1);
}
