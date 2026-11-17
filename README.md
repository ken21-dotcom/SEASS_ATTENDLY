# ATTENDLY — SEASS Student Attendance System

ATTENDLY is a modern, secure web application for tracking student attendance at campus events, managing student records, and disciplinary sanctions.

**Fingerprint attendance rule:** A student must have an active account and all
10 fingers enrolled before using fingerprint attendance. Students with
incomplete enrollment can still be checked in manually by an officer.

## Architecture

- **Backend**: PHP 8 (custom front-controller architecture routing through `attendly-backend/public/index.php`), PDO with MySQL / MariaDB (`attendly_seass_db`), robust migration runner (`php db/migrate.php`), session cookie authentication with CSRF protection and rate limiting.
- **Frontend**: Bootstrap 5.3 + vanilla JavaScript static frontend with dark/light theme support (`student-attendance-system/`). Kiosk attendance uses fingerprint matching or officer entry.
- **Database**: MySQL database named `attendly_seass_db`.

## Quick Start

1. **Database**: Run `scripts/init-db.sql` in MySQL / phpMyAdmin to create the `attendly_seass_db` database and users.
2. **Backend Config**: Copy `attendly-backend/config/config.example.php` to `attendly-backend/config/config.php` and configure your database credentials.
3. **Run Migrations**: `cd attendly-backend && php db/migrate.php`
4. **Start Backend** (from the repository root): `php -S localhost:8000 -t attendly-backend/public attendly-backend/router.php`
5. **Start Frontend** (from the repository root, not inside `student-attendance-system/`): `npm install` then `npm run serve`. The static server serves the repository root on <http://localhost:5173>, so open <http://localhost:5173/index.html> (or a page under `student-attendance-system/pages/`).

## Known Limitations (Future Work)

Deliberate scope limits of the current build, recorded for review. They are not
defects in the implemented feature set:

- **Report scaling.** `GET /attendance` and `GET /reports/attendance` return every
  matching row with no `LIMIT` or cursor. A full semester with a large roster
  loads the whole result set into PHP memory and into the browser. Cursor
  pagination (`?limit=` / `?cursor=`) is the next step before a production
  deployment.
- **SOAP integration hardening.** `public/soap-server.php` authenticates one
  shared bearer token and returns any student's attendance history. It has no
  rate limiting and no per-caller scoping; production should issue one token per
  integration, add a scope/audience column, and throttle by token.
- **Event edit atomicity.** `updateEvent()` writes the event row and its
  announcement rows as separate statements, so a failure between them can leave
  stale announcement text. `createEvent()` and `deleteEvent()` are transactional.
- **Secrets.** `config/config.php` is gitignored but holds the email provider key in plaintext. Rotate it before any demo or deployment.

## Tests

Run `npm test` from the repository root. It executes the static/JS checks plus the PHP suites, including `tools/attendance-checkin.api.test.php`. The API suites require a configured database and `attendly-backend/config/config.php`.
