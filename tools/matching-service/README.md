# ATTENDLY local fingerprint matching service

Standalone fingerprint matcher for ATTENDLY. It turns the DigitalPersona
U.are.U 4500 PNG captures (Web SDK `SampleFormat.PngImage`) into SourceAFIS
templates. `POST /verify` is the fast 1:1 check used by the kiosk for the
student whose ID was typed first; `POST /identify` remains the 1:N comparison
used by enrollment duplicate checks.

It is a self-contained Java process: JDK's `com.sun.net.httpserver` only, no web
framework, and one dependency — [SourceAFIS for Java](https://sourceafis.machinezoo.com/java).
Nothing from the frontend, backend or database is used or modified, and the
service has no database of its own.

## What the official docs say (checked 2026-11)

- Maven coordinates: `com.machinezoo.sourceafis:sourceafis:3.18.1`
  (latest release; requires Java 11+, last Java 8 release was 3.13.0).
- Licence: **Apache License 2.0**.
- API: `new FingerprintImage(bytes, new FingerprintImageOptions().dpi(512))` →
  `new FingerprintTemplate(image)` → `new FingerprintMatcher(probe)` →
  `matcher.match(candidate)` returns a `double` similarity score. Templates
  serialize with `toByteArray()` and deserialize with `new FingerprintTemplate(byte[])`.
- DPI: SourceAFIS is *not* scale-invariant and **ignores DPI stored in images**,
  so it must be told the sensor resolution. The docs say "500 dpi is the most
  common resolution". DigitalPersona datasheets disagree slightly: the HID
  DigitalPersona 4500 datasheet says 500 dpi, older U.are.U 4500 datasheets say
  512 dpi. The U.are.U 4500 captures at about 512 dpi, so this service defaults
  to **512**. Override with `MATCHING_DPI=500` only if your reader really is
  500 dpi. The setting applies to both template creation and probe images, so
  changing it requires re-enrolling templates at the new DPI.
- Threshold: threshold 40 corresponds to **FMR 0.01 %** (threshold 30 ≈ 0.1 %,
  20 ≈ 1 %, 10 ≈ 10 %); 40 is the documented recommended starting point for
  1:N identification. `/identify` compares `score >= MATCHING_THRESHOLD`
  (default 40), while `/verify` uses `threshold` from the request and falls
  back to `MATCHING_VERIFY_THRESHOLD` (default 30). Because the kiosk already
  knows the student ID, 1:1 verification can safely use the lower value of 30.

## Endpoints

All API calls must send `X-Matching-Key: <MATCHING_KEY>`; otherwise `401`.

### `POST /template`

```json
{ "image": "<base64 or base64url PNG>" }
```

```json
{ "template": "<base64 SourceAFIS template>" }
```

### `POST /verify`

```json
{
  "image": "<base64 PNG probe>",
  "candidate": {
    "id": 12,
    "templates": ["<base64>", "<base64>"],
    "fingers": ["left-thumb", "left-thumb"]
  },
  "threshold": 30
}
```

`candidate` is one student's stored templates, already selected in PHP by the
typed `studentIdNumber`. `threshold` is optional: PHP sends
`matching.threshold` from `config.php` (30 by default) on every kiosk check-in,
and the service falls back to `MATCHING_VERIFY_THRESHOLD` when it is absent.
No Java restart is needed after changing the PHP config.

The response has the same shape as `/identify`:

```json
{
  "match": { "id": 12, "score": 67.3, "finger": "left-thumb" },
  "bestScore": 67.3,
  "threshold": 30
}
```

or `{ "match": null, "bestScore": 21.4, "threshold": 30 }` below the threshold.

### `POST /identify`

```json
{
  "image": "<base64 PNG probe>",
  "candidates": [
    { "id": 12, "templates": ["<base64>", "<base64>"], "fingers": ["left-thumb", "left-thumb"] },
    { "id": 15, "templates": ["<base64>"], "fingers": ["right-index"] }
  ]
}
```

Every template of every candidate is compared; the highest score per candidate
is kept, and the best candidate overall wins. `fingers` is optional, but when
present it must have one entry per template (use `null` for a legacy template
whose finger is unknown). The winning template's finger is echoed back.

```json
{
  "match": { "id": 12, "score": 67.3, "finger": "left-thumb" },
  "bestScore": 67.3,
  "threshold": 40
}
```

or, when the best score is below the threshold:

```json
{ "match": null, "bestScore": 21.4, "threshold": 40 }
```

`bestScore` and `threshold` are always present, so the kiosk's `?debug=1` line
can show the score for every attempt even when the finger is not recognised.

### `GET /health`

No key required:
`{"status":"ok","dpi":512,"threshold":40,"verifyThreshold":30}`. Intended for
readiness checks and the smoke test; it reports the values the process actually
started with.

Errors are always JSON: `{"error":"..."}` with `400` (bad input), `401` (key),
`404` (path), `405` (method), `413` (body over 8 MB), `415` (not JSON).

## Build and run on Windows

Requires JDK 17+ (tested with JDK 21) and Maven (3.9.9). Maven downloads
SourceAFIS and the shade plugin on the first build.

Command Prompt (cmd):

```bat
cd tools\matching-service
mvn -B package
set MATCHING_KEY=attendly-dev-key
set MATCHING_THRESHOLD=40
java -jar target\matching-service.jar
```

PowerShell:

```powershell
cd tools\matching-service
mvn -B package
$env:MATCHING_KEY = "attendly-dev-key"
$env:MATCHING_THRESHOLD = "40"
java -jar target\matching-service.jar
```

Git Bash:

```bash
cd tools/matching-service
mvn -B package
MATCHING_KEY=attendly-dev-key MATCHING_THRESHOLD=40 java -jar target/matching-service.jar
```

The process binds **127.0.0.1:8090 only** (not reachable from the LAN) and
prints `matching service listening on http://127.0.0.1:8090`. Stop it with Ctrl+C.

| Variable | Default | Meaning |
| --- | --- | --- |
| `MATCHING_KEY` | *(required)* | Shared secret expected in `X-Matching-Key`. |
| `MATCHING_THRESHOLD` | `40` | Minimum score for `/identify` (1:N enrollment duplicate check, ~FMR 0.01 %). |
| `MATCHING_VERIFY_THRESHOLD` | `30` | Fallback score for `/verify`; PHP normally sends the threshold per request. |
| `MATCHING_DPI` | `512` | Sensor DPI used for template and probe decoding. The U.are.U 4500 is ~512 dpi; use `500` only if the datasheet says so. Changing DPI requires re-enrolling templates. |

### Tuning the thresholds from debug scores

The kiosk's 1:1 threshold is `matching.threshold` in the PHP config (30 by
default) and is sent on each `/verify` request. `MATCHING_VERIFY_THRESHOLD` is
only the Java fallback. `MATCHING_THRESHOLD` stays at 40 for enrollment's 1:N
duplicate check; do not lower it to make kiosk scans work.

Open the kiosk with `?debug=1`; every attempt shows `score`, `threshold`, and
the matched finger (or `none`).

1. Confirm the matching service was built and started with `MATCHING_DPI=512`
   (the `/health` response shows both thresholds and the DPI in use) and
   re-enroll fingers if the DPI changed.
2. Collect genuine scores from several students and fingers. Genuine 1:1
   attempts should sit comfortably above 30. If they do not, fix capture
   quality or re-enroll two templates per finger before changing the threshold.
3. Collect impostor scores by placing a different finger under the same typed
   ID. Impostors should stay below 30. If they approach 30, raise
   `matching.threshold` in PHP; if genuine scans are consistently just below 30
   after clean re-enrollment, lower it one step at a time and re-check both sets.
4. Record the old and new values. Changing the PHP threshold takes effect on
   the next request; changing `MATCHING_VERIFY_THRESHOLD` requires a Java
   restart. Neither threshold change requires re-enrollment; a DPI change does.

## Test with curl

cmd (single lines so you can paste them as-is):

```bat
curl -s http://127.0.0.1:8090/health

curl -s -H "X-Matching-Key: attendly-dev-key" -H "Content-Type: application/json" -d "{\"image\":\"AAAA\"}" http://127.0.0.1:8090/template

curl -s -o NUL -w "%%{http_code}\n" -H "Content-Type: application/json" -d "{\"image\":\"AAAA\"}" http://127.0.0.1:8090/template
```

Bash/PowerShell equivalent (PowerShell 5 needs `curl.exe` to avoid the `curl` alias):

```bash
curl -s http://127.0.0.1:8090/health

curl -s -H "X-Matching-Key: attendly-dev-key" -H "Content-Type: application/json" \
  -d '{"image":"AAAA"}' http://127.0.0.1:8090/template

curl -s -o /dev/null -w "%{http_code}\n" -H "Content-Type: application/json" \
  -d '{"image":"AAAA"}' http://127.0.0.1:8090/template
```

A real round trip with a PNG file (`probe.png` next to the prompt):

```bash
curl -s -H "X-Matching-Key: attendly-dev-key" -H "Content-Type: application/json" \
  -d "{\"image\":\"$(base64 -w0 probe.png)\"}" http://127.0.0.1:8090/template > template.json
```

`base64 -w0` exists in Git Bash; on cmd use PowerShell
`[Convert]::ToBase64String([IO.File]::ReadAllBytes("probe.png"))`.

## Automated test

```bat
cd tools\matching-service
mvn -B package
node test\api-smoke.js
```

The test starts the jar with its own key, checks `/health` (including the 512
DPI default, the 40 1:N threshold and the 30 1:1 threshold), 401 for a missing
or wrong key, clean 400s for invalid JSON, missing image, non-PNG bytes, garbage
`/identify` and `/verify` bodies and invalid templates, 405 for a wrong method
and 404 for an unknown path. It expects all checks to pass with no samples
present.

### Adding the real score check

Drop three PNGs captured with `SampleFormat.PngImage` into
`tools/matching-service/samples/`:

- `same-a.png` and `same-b.png` — two captures of the **same** finger
- `other.png` — a capture of a **different** finger

Rerun the test and it also enrolls them and asserts that the same finger matches
its enrolled id with `score >= 40` on `/identify` and `score >= 30` on `/verify`,
that the matched finger is echoed back, that a different finger lands below the
1:1 threshold with `match: null`, that the threshold sent by PHP is echoed in
the response, and that the same-finger score is higher. It prints the scores. No
samples are shipped, so the real-scoring half is skipped by default; the same
three files can be used with the curl example above.

## Privacy and logging

- Images and templates live in memory for the duration of one request. They are
  never written to disk, and never put in logs.
- Logs contain only the endpoint, HTTP status, duration in ms, and counts/scores,
  for example `[verify] 200 8ms templates=2 best=67.3 threshold=30 match=12`
  or `[identify] 200 41ms candidates=12 templates=14 best=67.3 match=12`.
- The service has no persistence; enrolled templates must be stored by the PHP
  backend and sent in each `/verify` (kiosk) or `/identify` (enrollment) request.
- Binding to `127.0.0.1` is deliberate: only local processes can call it.

## ATTENDLY integration

The PHP backend calls `POST /template` for enrollment images and stores only
the returned base64 templates in `students.fingerprint_template`. The enrollment
UI captures two placements per finger, so each named finger normally holds two
templates. Enrollment duplicate checks use `POST /identify` (1:N) at threshold
40.

At kiosk check-in the typed `studentIdNumber` is used to load only the matching
student row(s), and the backend calls `POST /verify` (1:1) with that student's
templates at threshold 30. A five-digit suffix can match several stored IDs, so
each eligible student is verified separately instead of sending a database-wide
fan-out. Images remain in memory for the request and are discarded.
