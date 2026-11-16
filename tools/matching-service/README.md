# ATTENDLY local fingerprint matching service

Standalone 1:N fingerprint matcher for ATTENDLY. It turns the DigitalPersona
U.are.U 4500 PNG captures (Web SDK `SampleFormat.PngImage`) into SourceAFIS
templates and identifies which enrolled student a probe image belongs to.

It is a self-contained Java process: JDK's `com.sun.net.httpserver` only, no web
framework, and one dependency — [SourceAFIS for Java](https://sourceafis.machinezoo.com/java).
Nothing from the frontend, backend or database is used or modified, and the
service has no database of its own.

## What the official docs say (checked 2026-11)

- Maven coordinates: `com.machinezoo.sourceafis:sourceafis:3.18.1`
  (latest release; requires Java 11+, last Java 8 release was 3.13.0).
- Licence: **Apache License 2.0**.
- API: `new FingerprintImage(bytes, new FingerprintImageOptions().dpi(500))` →
  `new FingerprintTemplate(image)` → `new FingerprintMatcher(probe)` →
  `matcher.match(candidate)` returns a `double` similarity score. Templates
  serialize with `toByteArray()` and deserialize with `new FingerprintTemplate(byte[])`.
- DPI: SourceAFIS is *not* scale-invariant and **ignores DPI stored in images**,
  so it must be told the sensor resolution. The docs say "500 dpi is the most
  common resolution". DigitalPersona datasheets disagree slightly: the HID
  DigitalPersona 4500 datasheet says 500 dpi, older U.are.U 4500 datasheets say
  512 dpi. This service defaults to **500** (override with `MATCHING_DPI=512` if
  your reader's datasheet says 512).
- Threshold: threshold 40 corresponds to **FMR 0.01 %** (threshold 30 ≈ 0.1 %,
  20 ≈ 1 %, 10 ≈ 10 %); 40 is the documented recommended starting point. The
  service compares `score >= MATCHING_THRESHOLD` and defaults to 40.

## Endpoints

All API calls must send `X-Matching-Key: <MATCHING_KEY>`; otherwise `401`.

### `POST /template`

```json
{ "image": "<base64 or base64url PNG>" }
```

```json
{ "template": "<base64 SourceAFIS template>" }
```

### `POST /identify`

```json
{
  "image": "<base64 PNG probe>",
  "candidates": [
    { "id": 12, "templates": ["<base64>", "<base64>"] },
    { "id": 15, "templates": ["<base64>"] }
  ]
}
```

Every template of every candidate is compared; the highest score per candidate
is kept, and the best candidate overall wins.

```json
{ "match": { "id": 12, "score": 67.3 } }
```

or, when the best score is below the threshold:

```json
{ "match": null, "bestScore": 21.4 }
```

### `GET /health`

No key required: `{"status":"ok"}`. Intended for readiness checks and the smoke test.

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
| `MATCHING_THRESHOLD` | `40` | Minimum score for a match (~FMR 0.01 %). |
| `MATCHING_DPI` | `500` | Sensor DPI used for image decoding (use `512` for 512 dpi datasheets). |

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

The test starts the jar with its own key, checks `/health`, 401 for a missing or
wrong key, clean 400s for invalid JSON, missing image, non-PNG bytes, garbage
identify bodies and invalid templates, 405 for a wrong method and 404 for an
unknown path. It expects **10 passed, 0 failed** with no samples present.

### Adding the real score check

Drop three PNGs captured with `SampleFormat.PngImage` into
`tools/matching-service/samples/`:

- `same-a.png` and `same-b.png` — two captures of the **same** finger
- `other.png` — a capture of a **different** finger

Rerun the test and it also enrolls them and asserts that the same finger matches
its enrolled id with `score >= 40`, that the different finger lands below the
threshold with `match: null`, and that the same-finger score is higher. It prints
the two scores. No samples are shipped, so the real-scoring half is skipped by
default; the same three files can be used with the curl example above.

## Privacy and logging

- Images and templates live in memory for the duration of one request. They are
  never written to disk, and never put in logs.
- Logs contain only the endpoint, HTTP status, duration in ms, and counts/scores,
  for example `[identify] 200 41ms candidates=12 templates=14 best=67.3 match=12`.
- The service has no persistence; enrolled templates must be stored by the PHP
  backend and sent in each `/identify` request.
- Binding to `127.0.0.1` is deliberate: only local processes can call it.

## Notes for later integration

The PHP backend currently returns a placeholder from `matchingServiceEnroll()`
and does not call this service. Wiring it up means: `POST /template` per capture,
store the base64 template instead of the image, and `POST /identify` with the
probe plus the enrolled templates — none of which is done here.
