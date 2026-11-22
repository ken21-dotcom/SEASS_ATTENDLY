# ATTENDLY — Security Notes

Status of the known security limitations in this build, recorded honestly for
review. Items marked **deferred** are accepted risks for the demo, not
oversights.

## Biometric templates are stored unencrypted (deferred)

`students.fingerprint_template` is a `LONGTEXT` column (migration 042) holding
**plaintext base64** SourceAFIS templates, two per enrolled finger. Anyone with
read access to the `students` table — a database dump, a backup, a second
application sharing the account — can read every enrolled student's biometric
template.

Encryption at rest (AES-256-GCM with a key from `FP_ENC_KEY`) is **deferred as a
post-defense enhancement**. It would not break the matching service: templates
are decrypted in memory before being POSTed to SourceAFIS and encrypted in
memory before the SQL write. It is deferred for time, not for compatibility.

## Fingerprint check-in is staff-only

`POST /attendance/fingerprint` requires an authenticated `admin` or
`ssc-officer` session. A student does not trigger it directly; an officer runs
the kiosk on their behalf. A dedicated low-privilege kiosk session is not
implemented in this build.

## Configuration must come from the environment

`attendly-backend/config/config.php` is gitignored but supplies public
development defaults when an environment variable is missing. At bootstrap,
`Attendly\ConfigGuard` refuses to serve a request when:

- `MATCHING_KEY` is unset or still the public default `attendly-dev-key`;
- `QR_HMAC_SECRET` is unset;
- `SMTP_PASS` is unset while `app.env` is not `development`.

Set these before starting the API:

```
export MATCHING_KEY='<long-random-value>'
export QR_HMAC_SECRET='<long-random-value>'
export SMTP_PASS='<provider-app-password>'
```

`MATCHING_KEY` must match the value the matching service was started with.
`config/config.php` also currently contains a real-looking SMTP provider key and
a long hex QR secret as fallbacks; both should be rotated and moved fully to the
environment.

## CSRF

Every authenticated state-changing request must carry `X-CSRF-Token` matching
the token in the server-side session, issued by `GET /auth/csrf-token` (which
requires a signed-in session). `POST /auth/login` is exempt, as are
registration, OTP verification and password reset, because they run before a
usable token exists.

**Login CSRF is therefore an accepted risk in this build.** A forged login can
install the attacker's session in a victim's browser, so the victim then records
attendance, profile changes or password changes inside the attacker's account.
Closing it requires issuing a token before authentication, which is a
post-defense change.

## Four-point attendance data model

`four_point` events store **two rows** per student/event: one for the AM pair and
one for the PM pair, distinguished by `scan_number` (2 and 4) under the unique
key `(event_id, student_id, scan_number)`. AM and PM timestamps are therefore
both retained. Reports that read a single row per student must merge the pair —
`listSanctionMatrix()` already does this.
