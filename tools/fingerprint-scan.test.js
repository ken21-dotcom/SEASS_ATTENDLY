/* Tests for the fingerprint kiosk pipeline.
 *
 * The kiosk reads a fingerprint sample from the DigitalPersona U.are.U
 * 4500 through the Web SDK and its local agent, sends the captured template
 * to the server, and keeps acquisition running across scans. The Web SDK
 * pauses scanning when the page loses focus; the kiosk restarts it on focus,
 * visibilitychange, AcquisitionStopped, and DeviceDisconnected followed by
 * DeviceConnected. Enrollment still uses the WebUSB adapter.
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
const scannerSrc = read('student-attendance-system/js/fingerprint-webusb.js');
const kioskCss = read('student-attendance-system/css/kiosk.css');
const apiSrc = read('student-attendance-system/js/api.js');
const enrollmentSrc = read('student-attendance-system/js/fingerprint-enrollment.js');
const routesSrc = read('attendly-backend/src/routes.php');
const repositorySrc = read('attendly-backend/src/Repository.php');
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
ok('kiosk privacy note explains the template boundary',
  /No fingerprint image is uploaded or stored/.test(kioskHtml) &&
  /template is sent to the server/.test(kioskHtml));

/* ── Kiosk flow ────────────────────────────────────────────────── */

ok('kiosk captures through the DigitalPersona Web SDK',
  /new window\.dp\.devices\.FingerprintReader\(/.test(kioskSrc) &&
  /\.startAcquisition\(SampleFormat\.PngImage\)/.test(kioskSrc) &&
  /SamplesAcquired/.test(kioskSrc));
ok('kiosk keeps acquisition running across scans',
  /'SamplesAcquired'/.test(kioskSrc) &&
  /startAcquisition\(/.test(kioskSrc) &&
  /restartFingerprintAcquisition\(/.test(kioskSrc));
ok('kiosk sends the template to the server',
  /api\.fingerprintCheckIn\(/.test(kioskSrc) &&
  !/captureTemplate\(\)/.test(kioskSrc));
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

/* ── WebUSB adapter ────────────────────────────────────────────── */

ok('adapter uses the DigitalPersona vendor id', /VENDOR_ID\s*=\s*0x05ba/i.test(scannerSrc));
ok('adapter requests a vendor-filtered USB device',
  /requestDevice\(\{[\s\S]*?filters:\s*\[\{\s*vendorId:\s*VENDOR_ID\s*\}\]/.test(scannerSrc));
ok('adapter reuses an already-authorised device',
  /getDevices\(\)/.test(scannerSrc) && /candidate\.vendorId === VENDOR_ID/.test(scannerSrc));
ok('adapter exposes a capture provider seam',
  /function registerProvider\(/.test(scannerSrc) &&
  /captureTemplate/.test(scannerSrc));
ok('adapter refuses to fake a capture without a bridge',
  /fingerprint_bridge_missing/.test(scannerSrc));
ok('adapter checks WebUSB support and secure context',
  /function isSupported\(/.test(scannerSrc) &&
  /function isSecure\(/.test(scannerSrc));
ok('adapter has no dependency on the nonexistent CDN package',
  !/fingerprint-webuse|cdn\.jsdelivr.*fingerprint/i.test(scannerSrc));

/* ── API client, routes, storage ───────────────────────────────── */

ok('API client posts fingerprint check-ins',
  /request\('\/attendance\/fingerprint'/.test(apiSrc) &&
  /fingerprintTemplate:\s*fingerprintTemplate/.test(apiSrc));
ok('API client exposes enrollment',
  /enrollFingerprint:\s*function \(studentId, fingerprintTemplate\)/.test(apiSrc) &&
  /request\('\/users\/enroll-fingerprint'/.test(apiSrc));
ok('fingerprint kiosk route exists', /\['POST', '\/attendance\/fingerprint'/.test(routesSrc));
ok('fingerprint enrollment route exists', /\['POST', '\/users\/enroll-fingerprint'/.test(routesSrc));
ok('fingerprint route is officer-gated',
  /\$fingerprintCheckIn = function \(\) use \(\$repo, \$auth, \$ctx\): array \{[\s\S]*?requireRole\(\['admin', 'ssc-officer'\]\)/.test(routesSrc));
ok('enrollment route is staff-gated',
  /enroll-fingerprint[\s\S]{0,220}?requireRole\(\['admin', 'ssc-officer'\]\)/.test(routesSrc));
ok('repository stores the fingerprint template',
  /UPDATE students SET fingerprint_template = :template WHERE user_id = :student_id/.test(repositorySrc));
ok('repository matches with a case-sensitive template compare',
  /BINARY s\.fingerprint_template = BINARY :template/.test(repositorySrc));
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
  /js\/fingerprint-enrollment\.js/.test(adminHtml) &&
  /js\/fingerprint-webusb\.js/.test(adminHtml));
ok('SSC manage students offers fingerprint enrollment',
  /enrollStudentFingerprint/.test(sscJs) &&
  /js\/fingerprint-enrollment\.js/.test(sscHtml) &&
  /js\/fingerprint-webusb\.js/.test(sscHtml));
ok('enrollment modal starts capture from the click',
  /global\.FingerprintScanner\.captureTemplate\(\)/.test(enrollmentSrc) &&
  /api\.enrollFingerprint\(state\.studentId, template\)/.test(enrollmentSrc));
ok('enrollment never logs or displays the template',
  !/console\.(log|info|debug)\([^)]*template/i.test(enrollmentSrc));

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
