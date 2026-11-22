# ATTENDLY — Release Notes

## Security hardening pass (2026-11-23, `main`)

Scope: close the gaps found in the pre-defense review, and fix the frontend
CSRF regression that the hardening introduced. No database migrations; no change
to the attendance data model.

### Backend

- **Configuration is checked at boot.** `Attendly\ConfigGuard` refuses to serve
  any request when `MATCHING_KEY` is still the published development default,
  `QR_HMAC_SECRET` is unset, or `SMTP_PASS` is missing outside `development`.
  Previously those values silently fell back to defaults checked into
  `config/config.php`. A rejected boot answers `500 insecure_config` rather than
  serving with a known key.
- **CSRF protection on state-changing requests.** `GET /auth/csrf-token` issues
  a 32-byte hex token into the server-side session (it requires a signed-in
  user). `POST`, `PUT`, `PATCH` and `DELETE` must return it in `X-CSRF-Token`,
  compared with `hash_equals`; a mismatch answers `403 csrf_rejected`.
  Login, registration, OTP verification and password reset are exempt because
  they run before a usable token exists — which leaves login CSRF as an accepted
  risk, recorded in `SECURITY.md`.
- **A temporary password now gates every route.** A session with
  `mustChangePassword` is limited to `/auth/me`, `/auth/logout`,
  `/auth/csrf-token` and `/auth/password`; everything else answers
  `403 password_change_required`. The earlier check only covered routes calling
  `requireRole()`, so plain-read routes such as `GET /events` slipped through.

### Frontend

- **The API client recovers its CSRF token after a reload.** The token is held
  in memory only, so navigating to Manage Students wiped it and the first write
  from that page — fingerprint enrollment — was rejected with
  `403 csrf_rejected`. `request()` now fetches the token before sending a
  state-changing call that has none, replays the write once if the server still
  rejects it (a rotated token), and `api.me()` warms the token as soon as a page
  confirms its session. Exempt routes are skipped, so login never asks for a
  token ahead of the session it is about to create. Backend enforcement is
  unchanged.

### Audited, no change required

- **Timezone.** Bare `date()` and `strtotime()` calls inherit the configured
  zone: `date_default_timezone_set()` runs at bootstrap from
  `tunables.timezone` (`config/db.php:28`). No call site needed a fix.
- **Kiosk authentication.** `POST /attendance/fingerprint` stays
  `admin`/`ssc-officer` only; the terminal runs under an officer session.
- **Biometric storage.** Templates remain plaintext base64; encryption at rest
  is deferred post-defense. See `SECURITY.md`.
- **`four_point` AM/PM.** Closed as a false positive. Scan 3 inserts a second
  row, so AM in/out stays in row 1 and PM in/out in row 2, and the sanction
  matrix merges the pair. No migration and no `Repository.php` change.

### Verification

`npm test` — exit 0. 101 PHP assertions (52 validator, 10 enrollment state, 34
API, 5 announcement sync) and the full static/behavioural JS suite.

New: `tools/api-csrf.test.js`, 15 assertions. It loads `api.js` in a fresh VM
context — the empty token state a reload produces — behind a stubbed `fetch`,
and covers token-before-write, single replay on rotation, login deferring its
fetch, and a permanent rejection not looping. Run against the previous `api.js`
it reports 4 failures, so it does catch the regression it was written for.

### Before running the demo

The API will not boot without these, by design:

```
export MATCHING_KEY='<long-random-value>'   # must match the matching service
export QR_HMAC_SECRET='<long-random-value>'
export SMTP_PASS='<provider-app-password>'
```

`config/config.php` still contains a real-looking SMTP provider key and a long
hex QR secret as fallbacks; rotate both and move them fully to the environment.
