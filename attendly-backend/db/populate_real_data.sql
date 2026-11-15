-- ============================================================
-- ATTENDLY — Realistic reporting data
-- ------------------------------------------------------------
-- Run this in phpMyAdmin (SQL tab) against attendly_seass_db
-- AFTER the migrations and after scripts/reset-for-defense.php
-- have created the staff accounts.
--
-- What this inserts:
--   * 20 student accounts across BSIT, BSEntrep, BSHM, BSN
--     and all four year levels (users -> students)
--   * 5 completed events across 1st Semester (events)
--   * 67 attendance rows, 12-15 students per event
--     (attendance_records)
--
-- Sanctions in this schema are derived, not stored: a student is
-- flagged when their absences exceed 3. The attendance below is
-- arranged so exactly THREE students cross that threshold:
--   Trinidad Tecson   (attended 1 of 5 -> 4 absences)
--   Graciano Lopez Jaena (attended 1 of 5 -> 4 absences)
--   Leona Florentino  (attended 0 of 5 -> 5 absences)
-- The verification query at the end prints the absence counts.
--
-- All student accounts share the password: Student@123
-- The script is re-runnable (public IDs and emails are fixed).
-- ============================================================

USE attendly_seass_db;

START TRANSACTION;

-- ------------------------------------------------------------
-- 0. Event creator
-- events.created_by references users(id), so an administrator
-- (or, failing that, an SSC officer) must already exist.
-- ------------------------------------------------------------
SET @creator_id = COALESCE(
  (SELECT id FROM users WHERE role = 'administrator' ORDER BY id LIMIT 1),
  (SELECT id FROM users WHERE role = 'ssc_officer' ORDER BY id LIMIT 1)
);

SET @student_password_hash = '$2y$10$indgQ9KBTdnLc15Jy2CkeeafKucpC9DyJ2gi4mdQKJM7naSEk9JBS';

-- ------------------------------------------------------------
-- 1. Students (staging table -> users -> students)
-- ------------------------------------------------------------
DROP TEMPORARY TABLE IF EXISTS seed_students;
CREATE TEMPORARY TABLE seed_students (
  public_id         VARCHAR(20)  NOT NULL PRIMARY KEY,
  email             VARCHAR(190) NOT NULL UNIQUE,
  student_id_number VARCHAR(30)  NOT NULL UNIQUE,
  first_name        VARCHAR(100) NOT NULL,
  last_name         VARCHAR(100) NOT NULL,
  department        VARCHAR(100) NOT NULL,
  program           VARCHAR(100) NOT NULL,
  year_level        VARCHAR(20)  NOT NULL,
  block             VARCHAR(30)  NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO seed_students
  (public_id, email, student_id_number, first_name, last_name, department, program, year_level, block)
VALUES
  ('STUD_101', 'juan.delacruz@attendly.edu',        '2026-01001', 'Juan',       'Dela Cruz',           'School of Computer Studies',   'BSIT', '1', 'A'),
  ('STUD_102', 'maria.santos@attendly.edu',         '2026-01002', 'Maria',      'Santos',              'School of Computer Studies',   'BSIT', '1', 'B'),
  ('STUD_103', 'jose.rizal@attendly.edu',           '2026-01003', 'Jose',       'Rizal',               'School of Business Management','BSEntrep', '1', 'A'),
  ('STUD_104', 'andres.bonifacio@attendly.edu',     '2026-01004', 'Andres',     'Bonifacio',           'School of Computer Studies',   'BSIT', '2', 'A'),
  ('STUD_105', 'gabriela.silang@attendly.edu',      '2026-01005', 'Gabriela',   'Silang',              'School of Business Management','BSHM', '2', 'B'),
  ('STUD_106', 'emilio.aguinaldo@attendly.edu',     '2026-01006', 'Emilio',     'Aguinaldo',           'School of Nursing',            'BSN',  '2', 'A'),
  ('STUD_107', 'apolinario.mabini@attendly.edu',    '2026-01007', 'Apolinario', 'Mabini',              'School of Computer Studies',   'BSIT', '2', 'A'),
  ('STUD_108', 'melchora.aquino@attendly.edu',      '2026-01008', 'Melchora',   'Aquino',              'School of Business Management','BSEntrep', '2', 'B'),
  ('STUD_109', 'marcelo.delpilar@attendly.edu',     '2026-01009', 'Marcelo',    'del Pilar',           'School of Computer Studies',   'BSIT', '3', 'A'),
  ('STUD_110', 'gregoria.dejesus@attendly.edu',     '2026-01010', 'Gregoria',   'de Jesus',            'School of Business Management','BSHM', '3', 'A'),
  ('STUD_111', 'antonio.luna@attendly.edu',         '2026-01011', 'Antonio',    'Luna',                'School of Nursing',            'BSN',  '3', 'B'),
  ('STUD_112', 'josefa.escoda@attendly.edu',        '2026-01012', 'Josefa',     'Llanes Escoda',       'School of Computer Studies',   'BSIT', '3', 'A'),
  ('STUD_113', 'ramon.magsaysay@attendly.edu',      '2026-01013', 'Ramon',      'Magsaysay',           'School of Business Management','BSHM', '4', 'A'),
  ('STUD_114', 'corazon.aquino@attendly.edu',       '2026-01014', 'Corazon',    'Aquino',              'School of Nursing',            'BSN',  '4', 'A'),
  ('STUD_115', 'benigno.aquino@attendly.edu',       '2026-01015', 'Benigno',    'Aquino',              'School of Nursing',            'BSN',  '4', 'B'),
  ('STUD_116', 'francisco.balagtas@attendly.edu',   '2026-01016', 'Francisco',  'Balagtas',            'School of Computer Studies',   'BSIT', '4', 'A'),
  ('STUD_117', 'trinidad.tecson@attendly.edu',      '2026-01017', 'Trinidad',   'Tecson',              'School of Business Management','BSEntrep', '3', 'A'),
  ('STUD_118', 'graciano.lopezjaena@attendly.edu',  '2026-01018', 'Graciano',   'Lopez Jaena',         'School of Business Management','BSHM', '2', 'B'),
  ('STUD_119', 'leona.florentino@attendly.edu',     '2026-01019', 'Leona',      'Florentino',          'School of Computer Studies',   'BSIT', '4', 'A'),
  ('STUD_120', 'diego.silang@attendly.edu',         '2026-01020', 'Diego',      'Silang',              'School of Business Management','BSEntrep', '1', 'B');

INSERT INTO users
  (public_id, role, email, display_name, password_hash, status, must_change_password)
SELECT public_id, 'student', email, CONCAT(first_name, ' ', last_name),
       @student_password_hash, 'active', 0
FROM seed_students
ON DUPLICATE KEY UPDATE
  public_id     = VALUES(public_id),
  role          = 'student',
  display_name  = VALUES(display_name),
  password_hash = VALUES(password_hash),
  status        = 'active';

INSERT INTO students
  (user_id, student_id_number, first_name, last_name, department,
   program, year_level, block, approved_by, approved_at)
SELECT u.id, t.student_id_number, t.first_name, t.last_name, t.department,
       t.program, t.year_level, t.block, @creator_id, NOW()
FROM seed_students t
JOIN users u ON u.email = t.email
ON DUPLICATE KEY UPDATE
  first_name    = VALUES(first_name),
  last_name     = VALUES(last_name),
  department    = VALUES(department),
  program       = VALUES(program),
  year_level    = VALUES(year_level),
  block         = VALUES(block),
  approved_by   = VALUES(approved_by),
  approved_at   = VALUES(approved_at);

-- ------------------------------------------------------------
-- 2. Events (staging table -> events)
-- All events are completed and in the past so they count towards
-- absence totals (repository: mandatory + ended + not cancelled).
-- ------------------------------------------------------------
DROP TEMPORARY TABLE IF EXISTS seed_events;
CREATE TEMPORARY TABLE seed_events (
  public_id       VARCHAR(20)  NOT NULL PRIMARY KEY,
  name            VARCHAR(150) NOT NULL,
  description     TEXT         NULL,
  event_date      DATE         NOT NULL,
  start_time      TIME         NOT NULL,
  end_time        TIME         NOT NULL,
  venue           VARCHAR(150) NOT NULL,
  event_type      ENUM('mandatory','optional') NOT NULL,
  event_category  ENUM('major','minor') NOT NULL,
  semester        ENUM('1st Semester','2nd Semester','Summer','N/A') NOT NULL,
  attendance_type ENUM('single','in_out','four_point') NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO seed_events
  (public_id, name, description, event_date, start_time, end_time, venue,
   event_type, event_category, semester, attendance_type)
VALUES
  ('EVNT_101', 'Intramurals 2026',
   'Annual university-wide sports competition opening and team events.',
   '2026-09-14', '08:00:00', '17:00:00', 'University Gymnasium',
   'mandatory', 'major', '1st Semester', 'in_out'),
  ('EVNT_102', 'Founders Day',
   'Institutional anniversary program, alumni homecoming and awarding.',
   '2026-09-30', '09:00:00', '16:00:00', 'Main Auditorium',
   'mandatory', 'major', '1st Semester', 'in_out'),
  ('EVNT_103', 'IT Week',
   'Technology talks, hackathon and project exhibits by computing students.',
   '2026-10-19', '08:00:00', '17:00:00', 'SCS Auditorium',
   'mandatory', 'major', '1st Semester', 'in_out'),
  ('EVNT_104', 'Research Colloquium 2026',
   'Undergraduate research presentations for the first semester.',
   '2026-10-28', '08:00:00', '12:00:00', 'Graduate School Hall',
   'mandatory', 'minor', '1st Semester', 'single'),
  ('EVNT_105', 'SSC General Assembly',
   'Student council assembly on plans, budget and second-semester activities.',
   '2026-11-06', '09:00:00', '15:00:00', 'University Theater',
   'mandatory', 'minor', '1st Semester', 'single');

INSERT INTO events
  (public_id, name, description, event_date, start_time, end_time, venue,
   event_type, event_category, semester, target_department, attendance_type,
   status, created_by)
SELECT public_id, name, description, event_date, start_time, end_time, venue,
       event_type, event_category, semester, NULL, attendance_type,
       'completed', @creator_id
FROM seed_events
ON DUPLICATE KEY UPDATE
  name            = VALUES(name),
  description     = VALUES(description),
  event_date      = VALUES(event_date),
  start_time      = VALUES(start_time),
  end_time        = VALUES(end_time),
  venue           = VALUES(venue),
  event_type      = VALUES(event_type),
  event_category  = VALUES(event_category),
  semester        = VALUES(semester),
  attendance_type = VALUES(attendance_type),
  status          = 'completed',
  created_by      = VALUES(created_by);

-- ------------------------------------------------------------
-- 3. Attendance (staging table -> attendance_records)
-- 67 rows: 15, 14, 14, 12 and 12 students per event.
-- ------------------------------------------------------------
DROP TEMPORARY TABLE IF EXISTS seed_attendance;
CREATE TEMPORARY TABLE seed_attendance (
  email            VARCHAR(190) NOT NULL,
  event_public_id  VARCHAR(20)  NOT NULL,
  PRIMARY KEY (email, event_public_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO seed_attendance (email, event_public_id) VALUES
  -- Intramurals 2026 — 15 students
  ('juan.delacruz@attendly.edu',      'EVNT_101'),
  ('maria.santos@attendly.edu',       'EVNT_101'),
  ('jose.rizal@attendly.edu',         'EVNT_101'),
  ('andres.bonifacio@attendly.edu',   'EVNT_101'),
  ('gabriela.silang@attendly.edu',    'EVNT_101'),
  ('emilio.aguinaldo@attendly.edu',   'EVNT_101'),
  ('apolinario.mabini@attendly.edu',  'EVNT_101'),
  ('melchora.aquino@attendly.edu',    'EVNT_101'),
  ('marcelo.delpilar@attendly.edu',   'EVNT_101'),
  ('gregoria.dejesus@attendly.edu',   'EVNT_101'),
  ('antonio.luna@attendly.edu',       'EVNT_101'),
  ('josefa.escoda@attendly.edu',      'EVNT_101'),
  ('ramon.magsaysay@attendly.edu',    'EVNT_101'),
  ('diego.silang@attendly.edu',       'EVNT_101'),
  ('trinidad.tecson@attendly.edu',    'EVNT_101'),

  -- Founders Day — 14 students
  ('juan.delacruz@attendly.edu',      'EVNT_102'),
  ('maria.santos@attendly.edu',       'EVNT_102'),
  ('jose.rizal@attendly.edu',         'EVNT_102'),
  ('andres.bonifacio@attendly.edu',   'EVNT_102'),
  ('gabriela.silang@attendly.edu',    'EVNT_102'),
  ('emilio.aguinaldo@attendly.edu',   'EVNT_102'),
  ('apolinario.mabini@attendly.edu',  'EVNT_102'),
  ('melchora.aquino@attendly.edu',    'EVNT_102'),
  ('marcelo.delpilar@attendly.edu',   'EVNT_102'),
  ('gregoria.dejesus@attendly.edu',   'EVNT_102'),
  ('antonio.luna@attendly.edu',       'EVNT_102'),
  ('corazon.aquino@attendly.edu',     'EVNT_102'),
  ('diego.silang@attendly.edu',       'EVNT_102'),
  ('graciano.lopezjaena@attendly.edu','EVNT_102'),

  -- IT Week — 14 students
  ('juan.delacruz@attendly.edu',      'EVNT_103'),
  ('maria.santos@attendly.edu',       'EVNT_103'),
  ('jose.rizal@attendly.edu',         'EVNT_103'),
  ('andres.bonifacio@attendly.edu',   'EVNT_103'),
  ('gabriela.silang@attendly.edu',    'EVNT_103'),
  ('apolinario.mabini@attendly.edu',  'EVNT_103'),
  ('marcelo.delpilar@attendly.edu',   'EVNT_103'),
  ('antonio.luna@attendly.edu',       'EVNT_103'),
  ('josefa.escoda@attendly.edu',      'EVNT_103'),
  ('ramon.magsaysay@attendly.edu',    'EVNT_103'),
  ('corazon.aquino@attendly.edu',     'EVNT_103'),
  ('francisco.balagtas@attendly.edu', 'EVNT_103'),
  ('diego.silang@attendly.edu',       'EVNT_103'),
  ('gregoria.dejesus@attendly.edu',   'EVNT_103'),

  -- Research Colloquium 2026 — 12 students
  ('juan.delacruz@attendly.edu',      'EVNT_104'),
  ('maria.santos@attendly.edu',       'EVNT_104'),
  ('jose.rizal@attendly.edu',         'EVNT_104'),
  ('andres.bonifacio@attendly.edu',   'EVNT_104'),
  ('gabriela.silang@attendly.edu',    'EVNT_104'),
  ('emilio.aguinaldo@attendly.edu',   'EVNT_104'),
  ('apolinario.mabini@attendly.edu',  'EVNT_104'),
  ('melchora.aquino@attendly.edu',    'EVNT_104'),
  ('marcelo.delpilar@attendly.edu',   'EVNT_104'),
  ('gregoria.dejesus@attendly.edu',   'EVNT_104'),
  ('josefa.escoda@attendly.edu',      'EVNT_104'),
  ('benigno.aquino@attendly.edu',     'EVNT_104'),

  -- SSC General Assembly — 12 students
  ('juan.delacruz@attendly.edu',      'EVNT_105'),
  ('maria.santos@attendly.edu',       'EVNT_105'),
  ('jose.rizal@attendly.edu',         'EVNT_105'),
  ('andres.bonifacio@attendly.edu',   'EVNT_105'),
  ('gabriela.silang@attendly.edu',    'EVNT_105'),
  ('emilio.aguinaldo@attendly.edu',   'EVNT_105'),
  ('apolinario.mabini@attendly.edu',  'EVNT_105'),
  ('melchora.aquino@attendly.edu',    'EVNT_105'),
  ('marcelo.delpilar@attendly.edu',   'EVNT_105'),
  ('gregoria.dejesus@attendly.edu',   'EVNT_105'),
  ('francisco.balagtas@attendly.edu', 'EVNT_105'),
  ('benigno.aquino@attendly.edu',     'EVNT_105');

INSERT INTO attendance_records
  (event_id, student_id, check_in_time, check_out_time, scan_number, verification_method)
SELECT e.id,
       u.id,
       DATE_ADD(TIMESTAMP(e.event_date, e.start_time), INTERVAL 8 MINUTE),
       CASE
         WHEN e.attendance_type IN ('in_out', 'four_point')
           THEN DATE_SUB(TIMESTAMP(e.event_date, e.end_time), INTERVAL 10 MINUTE)
         ELSE NULL
       END,
       1,
       'manual'
FROM seed_attendance a
JOIN users u  ON u.email = a.email
JOIN events e ON e.public_id = a.event_public_id
ON DUPLICATE KEY UPDATE
  check_in_time       = VALUES(check_in_time),
  check_out_time      = VALUES(check_out_time),
  verification_method = VALUES(verification_method);

COMMIT;

-- ------------------------------------------------------------
-- 4. Verification
-- Mirrors Repository::listSanctionMatrix(): an absence is a
-- mandatory, ended, non-cancelled event with no attendance row.
-- Expect 20 students and exactly 3 rows with FOR SANCTION.
-- ------------------------------------------------------------
SELECT
  s.student_id_number,
  CONCAT(s.first_name, ' ', s.last_name) AS student_name,
  s.program,
  s.year_level,
  COUNT(DISTINCT a.event_id) AS events_attended,
  (
    SELECT COUNT(*)
    FROM events e
    WHERE e.status <> 'cancelled'
      AND e.event_type = 'mandatory'
      AND TIMESTAMP(e.event_date, e.end_time) < NOW()
  ) - COUNT(DISTINCT a.event_id) AS total_absences,
  CASE
    WHEN (
      (SELECT COUNT(*)
       FROM events e
       WHERE e.status <> 'cancelled'
         AND e.event_type = 'mandatory'
         AND TIMESTAMP(e.event_date, e.end_time) < NOW())
      - COUNT(DISTINCT a.event_id)
    ) > 3 THEN 'FOR SANCTION'
    ELSE 'Good Standing'
  END AS standing
FROM students s
JOIN users u ON u.id = s.user_id
JOIN seed_students t ON t.email = u.email
LEFT JOIN attendance_records a ON a.student_id = s.user_id
GROUP BY s.user_id, s.student_id_number, s.first_name, s.last_name,
         s.program, s.year_level
ORDER BY total_absences DESC, s.last_name, s.first_name;

DROP TEMPORARY TABLE IF EXISTS seed_attendance;
DROP TEMPORARY TABLE IF EXISTS seed_events;
DROP TEMPORARY TABLE IF EXISTS seed_students;
