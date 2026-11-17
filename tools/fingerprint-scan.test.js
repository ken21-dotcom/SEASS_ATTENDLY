/* Tests for the fingerprint kiosk pipeline.
 *
 * The kiosk reads a fingerprint sample from the DigitalPersona U.are.U
 * 4500 through the Web SDK and its local agent, sends the captured template
 * to the server, and keeps acquisition running across scans. The Web SDK
 * pauses scanning when the page loses focus; the kiosk restarts it on focus,
 * visibilitychange, AcquisitionStopped, and DeviceDisconnected followed by
 * DeviceConnected. Enrollment uses the same Web SDK capture path, one
 * placement at a time, and never stores samples.
 *
 * These assertions pin the parts that can be proven without the physical
 * scanner: the SDK capture seam, the capture-only boundary, the removed
 * QR/camera path, and the backend/migration wiring used by enrollment.
 *
 * Run: node tools/fingerprint-scan.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const kioskHtml = read('student-attendance-system/pages/kiosk.html');
const kioskSrc = read('student-attendance-system/js/kiosk.js');
const kioskCss = read('student-attendance-system/css/kiosk.css');
const apiSrc = read('student-attendance-system/js/api.js');
const enrollmentSrc = read('student-attendance-system/js/fingerprint-enrollment.js');
const routesSrc = read('attendly-backend/src/routes.php');
const repositorySrc = read('attendly-backend/src/Repository.php');
const matchingSrc = read('tools/matching-service/src/main/java/local/attendly/matching/Main.java');
const migrationSrc = read('attendly-backend/db/migrations/042_fingerprint_attendance.sql');
const adminHtml = read('student-attendance-system/pages/administrator/admin-manage-students.html');
const sscHtml = read('student-attendance-system/pages/ssc-officer/ssc-manage-students.html');
const adminJs = read('student-attendance-system/js/administrator-panel.js');
const sscJs = read('student-attendance-system/js/ssc.js');

let pass = 0;
const failures = [];

function ok(name, condition, detail) {
  if (condition) pass++;
  else failures.push(name + (detail !== undefined ? ' -> ' + detail : ''));
}

/* ── Kiosk markup ──────────────────────────────────────────────── */

ok('kiosk has a large fingerprint scan button',
  /<button[^>]*id="kioskScanBtn"/.test(kioskHtml) &&
  />Scan Fingerprint</.test(kioskHtml));
ok('kiosk labels the sensor for assistive technology',
  /aria-describedby="kioskScanHint"/.test(kioskHtml) &&
  /id="kioskFingerprintState"/.test(kioskHtml));
ok('kiosk no longer mounts a QR camera region', !/qrRegion/.test(kioskHtml));
ok('kiosk no longer references the camera element',
  !/kioskCamera|kioskCameraPlaceholder/.test(kioskHtml));
ok('kiosk no longer loads html5-qrcode', !/html5-qrcode/.test(kioskHtml));
ok('kiosk loads the DigitalPersona Web SDK before kiosk.js',
  kioskHtml.indexOf('@digitalpersona/websdk') !== -1 &&
  kioskHtml.indexOf('@digitalpersona/core') !== -1 &&
  kioskHtml.indexOf('@digitalpersona/devices') !== -1 &&
  kioskHtml.indexOf('@digitalpersona/websdk') < kioskHtml.indexOf('@digitalpersona/core') &&
  kioskHtml.indexOf('@digitalpersona/core') < kioskHtml.indexOf('@digitalpersona/devices') &&
  kioskHtml.indexOf('@digitalpersona/devices') < kioskHtml.indexOf('js/kiosk.js'));
ok('kiosk no longer loads the WebUSB adapter',
  kioskHtml.indexOf('js/fingerprint-webusb.js') === -1);
ok('kiosk no longer loads qr-scanner.js', !/js\/qr-scanner\.js/.test(kioskHtml));
ok('kiosk privacy note explains the local matching boundary',
  /sent only to this laptop's matching service/.test(kioskHtml) &&
  /used to create or compare a template, and then discarded/.test(kioskHtml) &&
  /Only the template is stored/.test(kioskHtml));

/* ── Kiosk flow ────────────────────────────────────────────────── */

ok('kiosk captures through the DigitalPersona Web SDK',
  /new window\.dp\.devices\.FingerprintReader\(/.test(kioskSrc) &&
  /const sampleFormat = fingerprintSampleFormatValue\(\)/.test(kioskSrc) &&
  /\.startAcquisition\(sampleFormat\)/.test(kioskSrc) &&
  /function readKioskFormatMode\(\)[\s\S]{0,220}\?\s*value\s*:\s*'png'/.test(kioskSrc) &&
  /SamplesAcquired/.test(kioskSrc));
ok('kiosk keeps acquisition running across scans',
  /'SamplesAcquired'/.test(kioskSrc) &&
  /startAcquisition\(/.test(kioskSrc) &&
  /restartFingerprintAcquisition\(/.test(kioskSrc));
ok('kiosk requires an ID before sending one PNG sample to the server',
  /api\.encodeFingerprintSample\(samples\[0\]\)/.test(kioskSrc) &&
  /api\.fingerprintCheckIn\(eventRow\.id, studentIdentifier, image, scanMode\)/.test(kioskSrc) &&
  /function validateStudentIdentifier\(/.test(kioskSrc) &&
  !/captureTemplate\(\)/.test(kioskSrc));
ok('kiosk ID accepts five digits or the complete stored ID',
  /Enter your 5-digit ID/.test(kioskHtml) &&
  /Full IDs like 2025-12345 also work/.test(kioskHtml) &&
  /const validStudentIdentifier = \(value\) =>/.test(kioskSrc) &&
  /\\d\{5\}\|\\d\{4\}-\\d\{5\}/.test(kioskSrc));
ok('backend keeps full IDs and resolves all suffix candidates before matching',
  /kioskStudentIdentifier\(/.test(repositorySrc) &&
  /RIGHT\(s\.student_id_number, 6\) = CONCAT\(\\'\-\\', :student_id_suffix\)/.test(repositorySrc) &&
  /\$service->identifyDetailed\(\$fingerprintImage, \$candidates\)/.test(repositorySrc) &&
  /student_id_not_found/.test(repositorySrc));
ok('fingerprint check-in rejects enrollment below ten before recording attendance',
  /fingerprint_enrollment_incomplete/.test(repositorySrc) &&
  /\$completedCount < 10/.test(repositorySrc) &&
  /Enrollment incomplete \(\{\$completedCount\}\/10 fingers\)/.test(repositorySrc) &&
  /if \(\$completedCount < 10\)[\s\S]{0,300}recordScannedAttendance/.test(repositorySrc));
ok('manual check-in remains available independently of fingerprint enrollment',
  /\['POST', '\/attendance\/manual'/.test(routesSrc) &&
  /return \$repo->checkInManual\(/.test(routesSrc) &&
  /'manual'/.test(repositorySrc));
ok('re-enrolling a finger replaces that entry and preserves the 10-finger count',
  /replaceFingerprintEntry\(\$entries, \$finger, \$templates\)/.test(repositorySrc) &&
  /if \(\$entry\['finger'\] === \$finger\)/.test(repositorySrc) &&
  /return \$entries;/.test(repositorySrc) &&
  /count\(\$completed\) === count\(self::FINGERPRINT_FINGERS\)/.test(repositorySrc));
ok('legacy flat templates remain usable but do not count as enrolled fingers',
  /\['finger' => null, 'templates' => \$templates\]/.test(repositorySrc) &&
  /if \(\$entry\['finger'\] !== null && \$entry\['templates'\] !== \[\]\)/.test(repositorySrc));
ok('kiosk unique five-digit lookup keeps the matching student candidate',
  /\$matchedStudents = \$studentStmt->fetchAll\(\)/.test(repositorySrc) &&
  /\$students\[\$id\] = \$row/.test(repositorySrc) &&
  /\$candidates\[\] = \['id' => \$id, 'templates' => \$templates, 'fingers' => \$fingers\]/.test(repositorySrc));
ok('kiosk full-format lookup uses exact stored-ID equality',
  repositorySrc.includes(String.raw`preg_match('/^\d{4}-\d{5}$/D', $studentIdentifier)`) &&
  /s\.student_id_number = :student_id_number/.test(repositorySrc));
ok('kiosk reports no active student for an unmatched ID',
  /if \(\$matchedStudents === \[\]\) \{\s*Response::fail\('student_id_not_found'/.test(repositorySrc));
ok('suffix collisions are resolved by matching among every enrolled candidate',
  /foreach \(\$matchedStudents as \$row\)/.test(repositorySrc) &&
  /\$service->identifyDetailed\(\$fingerprintImage, \$candidates\)/.test(repositorySrc) &&
  /\$matchedId === null \|\| !isset\(\$students\[\$matchedId\]\)/.test(repositorySrc));
ok('department audience uses the existing normalized department policy',
  /eventTargetsDepartment\(\$targetDepartment, \(string\) \(\$row\['department'\] \?\? ''\)\)/.test(repositorySrc));
ok('kiosk logs nothing about the fingerprint sample',
  !/console\.(log|info|debug|warn|error)\([^)]*(sample|Data|template)/i.test(kioskSrc) &&
  !/(localStorage|sessionStorage)/.test(kioskSrc));
ok('kiosk restarts the live session on focus loss',
  /window\.addEventListener\('focus',\s*\(\)\s*=>\s*\{[^}]{0,120}if \(fingerprintSessionActive\) restartFingerprintAcquisition\(/.test(kioskSrc) &&
  /document\.addEventListener\('visibilitychange',\s*\(\)\s*=>\s*\{[^}]{0,160}if \(!document\.hidden && fingerprintSessionActive\)[\s\S]{0,40}restartFingerprintAcquisition\(/.test(kioskSrc) &&
  /reader\.on\('AcquisitionStopped',\s*\(\)\s*=>\s*\{[^}]{0,120}restartFingerprintAcquisition\(/.test(kioskSrc) &&
  /reader\.on\('DeviceDisconnected',\s*\(\)\s*=>\s*\{[\s\S]{0,260}Reader disconnected/.test(kioskSrc));
ok('kiosk manual entry shows the welcome result with the server name',
  /`Welcome, \$\{studentName\}!`/.test(kioskSrc));
ok('kiosk stays gated on the API',
  /async function runFingerprintScan\(\) \{\s*if \(!isApiEnabled\(\)\)/.test(kioskSrc));
ok('kiosk manual entry keeps the server attendance row',
  /addServerRecord\(record, event\.id\)/.test(kioskSrc));
ok('kiosk maps an unrecognised fingerprint',
  /fingerprint_not_recognized/.test(kioskSrc) &&
  /Fingerprint not recognised/.test(kioskSrc));
ok('kiosk explains a missing SDK',
  /sdk_missing/.test(kioskSrc) &&
  /Scanner module missing/.test(kioskSrc));
ok('kiosk maps reader and agent failures',
  /scanner_not_found/.test(kioskSrc) &&
  /scanner_unavailable/.test(kioskSrc));
ok('kiosk no longer runs the QR scanner',
  !/QrScanner|qrCheckIn|analyzeQrText|handleContinuousQrScan/.test(kioskSrc));
ok('kiosk never matches templates locally',
  !/\.identify\(/.test(kioskSrc) && !/findBestMatch/.test(kioskSrc));
ok('kiosk never invents an offline attendance row',
  !/generateId\('att'\)/.test(kioskSrc) && !/record \|\| \{/.test(kioskSrc));
ok('kiosk keeps manual entry as a server call',
  /api\.manualCheckIn\(/.test(kioskSrc) && /runManualEntry/.test(kioskSrc));

/* ── Enrollment capture (same Web SDK path as the kiosk) ───────── */

ok('no page loads the retired WebUSB adapter',
  !/js\/fingerprint-webusb\.js/.test(adminHtml) &&
  !/js\/fingerprint-webusb\.js/.test(sscHtml) &&
  !/js\/fingerprint-webusb\.js/.test(kioskHtml) &&
  !fs.existsSync(path.join(ROOT, 'student-attendance-system/js/fingerprint-webusb.js')));
ok('enrollment pages load the Web SDK before the modal script',
  [adminHtml, sscHtml].every((html) =>
    html.indexOf('@digitalpersona/websdk') !== -1 &&
    html.indexOf('@digitalpersona/core') !== -1 &&
    html.indexOf('@digitalpersona/devices') !== -1 &&
    html.indexOf('@digitalpersona/devices') < html.indexOf('js/fingerprint-enrollment.js')));
ok('enrollment uses the kiosk capture seam and PNG default',
  /new global\.dp\.devices\.FingerprintReader\(/.test(enrollmentSrc) &&
  /\.startAcquisition\(sampleFormat\)/.test(enrollmentSrc) &&
  /function readFormatMode\(\)[\s\S]{0,220}\?\s*value\s*:\s*'png'/.test(enrollmentSrc) &&
  /'intermediate'[\s\S]{0,80}'raw'[\s\S]{0,80}'png'/.test(enrollmentSrc));

/* ── API client, routes, storage ───────────────────────────────── */

ok('API client posts one fingerprint image for check-in',
  /request\('\/attendance\/fingerprint'/.test(apiSrc) &&
  /image:\s*fingerprintImage/.test(apiSrc));
ok('API client sends a selected finger and its image list',
  /enrollFingerprint:\s*function \(studentId, finger, fingerprintImages\)/.test(apiSrc) &&
  /finger:\s*finger/.test(apiSrc) &&
  /images:\s*fingerprintImages/.test(apiSrc) &&
  /request\('\/users\/enroll-fingerprint'/.test(apiSrc));
ok('API client has a chunked PNG base64 encoder',
  /encodeFingerprintSample:\s*function \(sample\)/.test(apiSrc) &&
  /chunkSize = 0x8000/.test(apiSrc) &&
  /btoa\(chunks\.join\(''\)\)/.test(apiSrc) &&
  !/String\.fromCharCode\.apply\(null, new Uint8Array\(data\)\)/.test(apiSrc));
ok('fingerprint kiosk route exists', /\['POST', '\/attendance\/fingerprint'/.test(routesSrc));
ok('fingerprint enrollment route exists', /\['POST', '\/users\/enroll-fingerprint'/.test(routesSrc));
ok('fingerprint route is officer-gated',
  /\$fingerprintCheckIn = function \(\) use \(\$repo, \$auth, \$ctx\): array \{[\s\S]*?requireRole\(\['admin', 'ssc-officer'\]\)/.test(routesSrc));
ok('enrollment route is staff-gated',
  /enroll-fingerprint[\s\S]{0,220}?requireRole\(\['admin', 'ssc-officer'\]\)/.test(routesSrc));
ok('matching service client is local, keyed and fails with 503',
  /curl_init\(\$this->baseUrl \. \$path\)/.test(fs.readFileSync(path.join(ROOT, 'attendly-backend/src/MatchingService.php'), 'utf8')) &&
  /CURLOPT_CONNECTTIMEOUT => 2/.test(fs.readFileSync(path.join(ROOT, 'attendly-backend/src/MatchingService.php'), 'utf8')) &&
  /Matching service is not running\./.test(fs.readFileSync(path.join(ROOT, 'attendly-backend/src/MatchingService.php'), 'utf8')) &&
  /matching_service_unavailable/.test(repositorySrc));
ok('enrollment templates one image at a time and stores a JSON array',
  /require_once __DIR__ \. '\/MatchingService\.php'/.test(repositorySrc) &&
  /\$service->template\(\$image\)/.test(repositorySrc) &&
  /\['finger' => \$finger, 'templates' => \$templates\]/.test(repositorySrc) &&
  /json_encode\(\$entries, JSON_THROW_ON_ERROR\)/.test(repositorySrc) &&
  /UPDATE students SET fingerprint_template = :templates WHERE user_id = :student_id/.test(repositorySrc) &&
  !/function matchingServiceEnroll/.test(repositorySrc));
ok('enrollment stores both scans for a finger as two templates',
  /foreach \(\$images as \$image\)[\s\S]{0,120}\$templates\[\] = \$service->template\(\$image\)/.test(repositorySrc) &&
  /'templates' => array_values\(\$templates\)/.test(repositorySrc));
ok('matching service defaults to 512 dpi and exposes it on health',
  /numberEnv\("MATCHING_DPI", 512\)/.test(matchingSrc) &&
  /\\"dpi\\":/.test(matchingSrc) &&
  /\\"threshold\\":/.test(matchingSrc));
ok('matching service returns best score, threshold and matched finger',
  /\\"bestScore\\":/.test(matchingSrc) &&
  /\\"finger\\":/.test(matchingSrc) &&
  /candidate\.fingers/.test(matchingSrc));
ok('kiosk debug shows score, threshold and matched finger',
  /debugLastMatch/.test(kioskSrc) &&
  /last match score/.test(kioskSrc) &&
  /threshold \$\{number\(debugLastMatch\.threshold\)\}/.test(kioskSrc) &&
  /finger \$\{debugLastMatch\.finger\}/.test(kioskSrc));
ok('enrollment rejects a finger enrolled to another student with 409',
  /assertFingerprintNotEnrolledToAnotherStudent/.test(repositorySrc) &&
  /\$service->identify\(\$image, \$candidates\) !== null/.test(repositorySrc) &&
  /'fingerprint_already_enrolled'[\s\S]{0,160}?409/.test(repositorySrc));
ok('repository identifies with the matching service instead of BINARY compare',
  /\$service->identifyDetailed\(\$fingerprintImage, \$candidates\)/.test(repositorySrc) &&
  !/BINARY s\.fingerprint_template = BINARY :template/.test(repositorySrc));
ok('repository reuses the shared attendance policy',
  /private function recordScannedAttendance\(/.test(repositorySrc) &&
  /checkInByFingerprint\([\s\S]*?recordScannedAttendance\([\s\S]*?'fingerprint'/.test(repositorySrc));
ok('manual and QR methods remain available',
  /in_array\(\$input\['verificationMethod'\] \?\? '', \['manual', 'qr', 'fingerprint'\]/.test(repositorySrc));

/* ── Migration ─────────────────────────────────────────────────── */

ok('migration adds the nullable template column',
  /ALTER TABLE students\s+ADD COLUMN fingerprint_template LONGTEXT NULL/.test(migrationSrc));
ok('migration preserves the QR token columns',
  !/qr_token|DROP COLUMN/i.test(migrationSrc));
ok('migration adds the fingerprint verification method',
  /verification_method ENUM\('face', 'manual', 'qr', 'fingerprint'\)/.test(migrationSrc));

/* ── Enrollment UI ─────────────────────────────────────────────── */

ok('admin manage students offers fingerprint enrollment',
  /enrollStudentFingerprint/.test(adminJs) &&
  /js\/fingerprint-enrollment\.js/.test(adminHtml));
ok('SSC manage students offers fingerprint enrollment',
  /enrollStudentFingerprint/.test(sscJs) &&
  /js\/fingerprint-enrollment\.js/.test(sscHtml));
ok('admin student list shows full or partial finger enrollment state',
  /studentFingerprintFingersCompleted\(student\)/.test(adminJs) &&
  /'Incomplete: ' \+ fingersDone \+ '\/10 fingers'/.test(adminJs) &&
  /text-warning fw-semibold/.test(adminJs) &&
  /filterFingerprintEnrollment/.test(adminJs));
ok('SSC student list shows full or partial finger enrollment state',
  /studentFingerprintFingersCompleted\(student\)/.test(sscJs) &&
  /'Incomplete: ' \+ fingersDone \+ '\/10 fingers'/.test(sscJs) &&
  /text-warning fw-semibold/.test(sscJs) &&
  /filterFingerprintEnrollment/.test(sscJs));
ok('admin and SSC lists expose the incomplete-enrollment filter',
  /filterFingerprintEnrollment/.test(adminHtml) &&
  /filterFingerprintEnrollment/.test(sscHtml) &&
  /Incomplete enrollment/.test(fs.readFileSync(path.join(ROOT, 'student-attendance-system/js/ui.js'), 'utf8')) &&
  /enrollment === 'incomplete'/.test(fs.readFileSync(path.join(ROOT, 'student-attendance-system/js/data.js'), 'utf8')));
ok('README documents active account and all ten fingers as the attendance requirement',
  /A student must have an active account and all[\s\S]{0,80}10 fingers enrolled before using fingerprint attendance/.test(
    read('README.md')));
ok('manage-students action column keeps the enroll button visible',
  /tr\[data-kind="student"\] > td:last-child \{[\s\S]{0,200}?max-width: none/.test(
    fs.readFileSync(path.join(ROOT, 'student-attendance-system/css/role-dashboard.css'), 'utf8')));
ok('enrollment requires consent before scanning',
  /enroll all ten fingers/.test(enrollmentSrc) &&
  /then discarded/.test(enrollmentSrc) &&
  /Only templates are stored; scans are never saved as images/.test(enrollmentSrc) &&
  /id="fingerprintEnrollConsent"/.test(enrollmentSrc) &&
  /state\.els\.consent\.checked/.test(enrollmentSrc) &&
  /Consent is required before scanning/.test(enrollmentSrc));
ok('partial enrollment warns before closing and lists missing fingers',
  /hide\.bs\.modal/.test(enrollmentSrc) &&
  /Missing: ' \+\s*missing\.join\(', '\)/.test(enrollmentSrc) &&
  /Saved fingers will be kept\. Close now and resume later\?/.test(enrollmentSrc));
ok('enrollment shows a success state only after all ten fingers are saved',
  /result\.fingerprintEnrolled === true && fingerprintComplete\(\)/.test(enrollmentSrc) &&
  /All 10 fingers are enrolled/.test(enrollmentSrc) &&
  /Enrollment incomplete: ' \+ state\.enrolledFingers\.length/.test(enrollmentSrc));
ok('enrollment offers confirm-and-finish when all ten fingers are saved',
  /id="fingerprintEnrollConfirm"/.test(enrollmentSrc) &&
  /Confirm and finish/.test(enrollmentSrc) &&
  /function renderCompletionState\(/.test(enrollmentSrc) &&
  /state\.modal\.hide\(\)/.test(enrollmentSrc) &&
  /refreshGroupedStudentList\(\)/.test(enrollmentSrc));
ok('enrollment always shows a close button with progress before completion',
  /id="fingerprintEnrollClose"/.test(enrollmentSrc) &&
  /Close \(' \+ state\.enrolledFingers\.length \+ '\/10 done, resume later\)/.test(enrollmentSrc) &&
  /state\.els\.close\.hidden = complete/.test(enrollmentSrc) &&
  /state\.els\.confirm\.hidden = !complete/.test(enrollmentSrc));
ok('enrollment collects two good scans per selected finger with progress',
  /SCANS_PER_FINGER = 2/.test(enrollmentSrc) &&
  /FINGERS = \[/.test(enrollmentSrc) &&
  /Lift your finger and place it again, slightly differently/.test(enrollmentSrc) &&
  /QualityReported/.test(enrollmentSrc) &&
  /qualityIsGood/.test(enrollmentSrc) &&
  /Poor scan/.test(enrollmentSrc));
ok('quality gate compares against the installed QualityCode enum',
  /global\.dp\.devices\.QualityCode/.test(enrollmentSrc) &&
  /typeof codes\.Good === 'number'/.test(enrollmentSrc) &&
  /return value === good/.test(enrollmentSrc) &&
  !/value >= 90/.test(enrollmentSrc));
ok('each placement is judged by its own quality value',
  /function takePendingQuality\(/.test(enrollmentSrc) &&
  /function deliverQuality\(/.test(enrollmentSrc) &&
  /function waitForQuality\(/.test(enrollmentSrc) &&
  !/return state\.lastQuality;/.test(enrollmentSrc));
ok('a rejected scan restarts acquisition after the two-second gap',
  /async function restartAcquisition\(/.test(enrollmentSrc) &&
  /RESTART_GAP_MS - \(Date\.now\(\) - state\.lastStartAt\)/.test(enrollmentSrc) &&
  /await stopAcquisition\(\);/.test(enrollmentSrc) &&
  /state\.sampleBusy = false;/.test(enrollmentSrc));
ok('debug line is opt-in and shows counts, not samples',
  /function readDebugMode\(/.test(enrollmentSrc) &&
  /get\('debug'\)/.test(enrollmentSrc) &&
  /lastEventName/.test(enrollmentSrc) &&
  /id="fingerprintEnrollDebug"/.test(enrollmentSrc) &&
  !/(localStorage|sessionStorage)/.test(enrollmentSrc));
ok('enrollment submits the in-memory images through the API',
  /api\.encodeFingerprintSample\(sample\)/.test(enrollmentSrc) &&
  /var images = state\.samples\.slice\(\)/.test(enrollmentSrc) &&
  /api\.enrollFingerprint\(state\.studentId, state\.selectedFinger, images\)/.test(enrollmentSrc) &&
  /state\.samples\.push\(image\)/.test(enrollmentSrc) &&
  /clearSamples\(\)/.test(enrollmentSrc));
ok('enrollment stops acquisition and keeps samples out of storage',
  /stopAcquisition/.test(enrollmentSrc) &&
  /pagehide/.test(enrollmentSrc) &&
  /DeviceDisconnected/.test(enrollmentSrc) &&
  /navigator\.locks/.test(enrollmentSrc) &&
  !/(localStorage|sessionStorage)/.test(enrollmentSrc));
ok('enrollment logs only sizes and formats',
  /\[enrollment\] capture ' \+ state\.samples\.length/.test(enrollmentSrc) &&
  /image\.length \+ ' base64 chars, format ' \+ FORMAT_MODE/.test(enrollmentSrc) &&
  !/console\.(log|info|debug)\([^)]*state\.samples\[/.test(enrollmentSrc) &&
  !/(localStorage|sessionStorage)/.test(enrollmentSrc));

/* ── Styling ───────────────────────────────────────────────────── */

ok('kiosk styles the fingerprint sensor',
  /\.kiosk-fingerprint-frame/.test(kioskCss) &&
  /\.kiosk-fingerprint-sensor/.test(kioskCss) &&
  /\.kiosk-fingerprint-scanline/.test(kioskCss));
ok('kiosk honours reduced motion for the scan animation',
  /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?kioskFingerprintScanline/.test(kioskCss));
ok('kiosk has no webcam preview styles left',
  !/kiosk-camera|kiosk-qr-region/.test(kioskCss));

/* ── Report ────────────────────────────────────────────────────── */

if (failures.length === 0) {
  console.log(`  ${pass} fingerprint scan assertions passed`);
  process.exit(0);
}
console.log(`  ${pass} passed, ${failures.length} FAILED:`);
for (const f of failures) console.log('    - ' + f);
process.exit(1);
