<?php
/**
 * ATTENDLY — Front Controller
 *
 * Single entry point for the JSON API. Routed by method + path so the
 * API can live behind one URL instead of a directory of PHP files.
 *
 * Every response is JSON. Errors use a stable envelope:
 *   { "error": { "code": "...", "message": "..." } }
 *
 */

declare(strict_types=1);

require __DIR__ . '/../config/db.php';
require __DIR__ . '/../config/session.php';
require __DIR__ . '/../src/Response.php';
require __DIR__ . '/../src/Auth.php';
require __DIR__ . '/../src/Validator.php';
require __DIR__ . '/../src/RateLimiter.php';
require __DIR__ . '/../src/Repository.php';
require __DIR__ . '/../src/ConfigGuard.php';
require __DIR__ . '/../src/routes.php';

use Attendly\Response;
use Attendly\Auth;
use Attendly\Repository;
use Attendly\RateLimiter;
use Attendly\ConfigGuard;
use Attendly\ValidationException;

/**
 * Whether a browser Origin may call the API.
 *
 * Configured origins always pass. In development, a localhost origin or any
 * RFC1918 LAN address is also accepted, so a phone can reach the API after
 * DHCP hands the laptop a new address without editing config.php each time.
 */
function attendly_origin_allowed(string $origin, array $allowedOrigins, bool $devMode): bool
{
    if ($origin === '') {
        return true;
    }
    foreach ($allowedOrigins as $allowedOrigin) {
        if (is_string($allowedOrigin) && hash_equals($allowedOrigin, $origin)) {
            return true;
        }
    }
    if (!$devMode) {
        return false;
    }

    $parts = parse_url($origin);
    if (!is_array($parts)) {
        return false;
    }
    $scheme = strtolower((string) ($parts['scheme'] ?? ''));
    if ($scheme !== 'http' && $scheme !== 'https') {
        return false;
    }
    $host = strtolower((string) ($parts['host'] ?? ''));
    if ($host === 'localhost' || $host === '127.0.0.1' || $host === '::1') {
        return true;
    }
    if (filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) === false) {
        return false;
    }
    return str_starts_with($host, '10.')
        || str_starts_with($host, '192.168.')
        || preg_match('/^172\.(1[6-9]|2\d|3[01])\./', $host) === 1;
}

// ── CORS (config-driven; credentials require an allowed origin) ──
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: strict-origin-when-cross-origin');
header('Permissions-Policy: camera=(self), microphone=()');
// These responses carry PII, QR tokens and face photos; never let a browser
// or proxy keep a copy on disk.
header('Cache-Control: no-store');

$configFile = __DIR__ . '/../config/config.php';
if (!is_file($configFile)) {
    Response::fail('config_missing', 'config/config.php is missing.', 500);
}
$config = require $configFile;

// Security-critical settings must not still hold a public development
// default. A missing environment variable would otherwise leave the
// fingerprint matching service accepting the published key.
try {
    ConfigGuard::assertSecure($config);
} catch (\RuntimeException $e) {
    error_log('[attendly] ' . $e->getMessage());
    Response::fail('insecure_config', $e->getMessage(), 500);
}

$allowedOrigins = (array) ($config['cors']['allowed_origins'] ?? []);
$devCors = ($config['cors']['dev_allow_cors'] ?? false) === true;

// Reject an oversized body from its declared length before json_decode()
// copies it. 4 MB leaves room for a 2 MB proof image plus the JSON envelope.
if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 4 * 1024 * 1024) {
    Response::fail('payload_too_large', 'Request body is too large.', 413);
}

// Session-cookie mutations require an explicit API header. Browser forms
// cannot set it, which blocks CSRF from other origins, including sibling ports.
if (in_array($_SERVER['REQUEST_METHOD'] ?? 'GET', ['POST', 'PUT', 'PATCH', 'DELETE'], true)) {
    if (($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '') !== 'XMLHttpRequest') {
        Response::fail('csrf_rejected', 'Request verification failed.', 403);
    }
    $requestOrigin = (string) ($_SERVER['HTTP_ORIGIN'] ?? '');
    if ($requestOrigin !== '' && !attendly_origin_allowed($requestOrigin, $allowedOrigins, $devCors)) {
        Response::fail('csrf_rejected', 'Request origin is not allowed.', 403);
    }
}

if (($config['cors']['dev_allow_cors'] ?? false) === true) {
    $origin = (string) ($_SERVER['HTTP_ORIGIN'] ?? '');
    if ($origin !== '' && attendly_origin_allowed($origin, $allowedOrigins, true)) {
        header('Access-Control-Allow-Origin: ' . $origin);
        header('Access-Control-Allow-Credentials: true');
        header('Vary: Origin');
    }
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
        header('Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS');
        header('Access-Control-Allow-Headers: Content-Type, X-Requested-With');
        header('Access-Control-Max-Age: 86400');
        http_response_code(204);
        exit;
    }
}

// ── Route table ───────────────────────────────────────────────────
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path   = rtrim(parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/', '/');
if ($path === '') {
    $path = '/';
}

// Strip the mount prefix so the app works from a subdirectory or via
// the PHP built-in server at /index.php.
$prefix = (string) ($config['app']['api_prefix'] ?? '/api');
// Require a path boundary: "/apifoo" must not be read as prefix "/api".
if ($prefix !== '' && $prefix !== '/' && ($path === $prefix || str_starts_with($path, $prefix . '/'))) {
    $path = substr($path, strlen($prefix));
}
$path = '/' . ltrim($path, '/');

/**
 * Block a session that still owes a password change.
 *
 * Anything not on this list answers 403, so the forced-change screen cannot
 * be skipped by calling another endpoint directly. The flag used to be
 * checked only inside Auth::requireRole(), which read-only routes that call
 * currentUser() never reach.
 */
function attendly_enforce_password_change(string $method, string $path, Auth $auth, array $config): void
{
    // Without a session cookie there is no session to gate; skipping the
    // lookup also keeps anonymous traffic from creating a session file.
    $sessionCookie = (string) ($config['session']['cookie_name'] ?? 'attendly_sid');
    if (!isset($_COOKIE[$sessionCookie])) {
        return;
    }

    $user = $auth->currentUser();
    if ($user === null || ($user['mustChangePassword'] ?? false) !== true) {
        return;
    }

    $allowed = [
        'GET /auth/me',
        'POST /auth/logout',
        'GET /auth/csrf-token',
        'GET /auth/csrf-pre-auth',
        'POST /auth/password',
        'GET /health',
    ];
    if (!in_array($method . ' ' . $path, $allowed, true)) {
        Response::fail(
            'must_change_password',
            'Change your temporary password before continuing.',
            403
        );
    }
}

try {
    $db    = get_db();
    $repo  = new Repository($db, $config);
    $auth  = new Auth($db);
    $limiter = new RateLimiter($db);
    $ctx   = ['repo' => $repo, 'auth' => $auth, 'limiter' => $limiter, 'method' => $method, 'config' => $config];

    // Synchronizer-token check. Routes that cannot yet hold a session token
    // (registration, OTP, password reset) are exempt. Everything else,
    // including /auth/login, must echo the token issued by
    // GET /auth/csrf-pre-auth or GET /auth/csrf-token.
    if (in_array($method, ['POST', 'PUT', 'PATCH', 'DELETE'], true)) {
        $csrfExempt = [
            '/auth/register',
            '/auth/verify-otp',
            '/auth/forgot-password',
            '/auth/reset-password',
        ];
        if (!in_array($path, $csrfExempt, true)) {
            // A request with no session cookie carries no ambient authority,
            // so there is nothing to forge and the route should answer 401
            // itself. Login is the exception: a forged login would install
            // the attacker's session in the victim's browser, so it always
            // requires a token issued before the password is sent.
            $sessionCookie = (string) ($config['session']['cookie_name'] ?? 'attendly_sid');
            if ($path === '/auth/login' || isset($_COOKIE[$sessionCookie])) {
                $auth->requireCsrfToken();
            }
        }
    }

    attendly_enforce_password_change($method, $path, $auth, $config);

    respond(attendly_route($path, $method, $ctx));
} catch (ValidationException $e) {
    Response::fail($e->errorCode, $e->getMessage(), $e->status);
} catch (Throwable $e) {
    // Never leak a stack trace or SQL fragment to the client.
    error_log('[attendly] ' . $e->getMessage());
    Response::fail('server_error', 'An unexpected error occurred.', 500);
}
