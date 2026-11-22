/* CSRF token recovery in the API client.
 *
 * The synchronizer token is kept in memory only, so a page reload or a new
 * tab starts with none. Without recovery, every write from a freshly loaded
 * page answered 403 csrf_rejected — fingerprint enrollment failed from
 * Manage Students for exactly that reason.
 *
 * These assertions load api.js in a fresh VM context, which is what a reload
 * gives the frontend: module-level state, including the token, starts empty.
 * fetch is stubbed, so the request sequence the client actually produces is
 * visible without a browser or a running backend.
 *
 * Run: node tools/api-csrf.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const API_SRC = fs.readFileSync(
  path.join(ROOT, 'student-attendance-system', 'js', 'api.js'),
  'utf8'
);

let pass = 0;
const failures = [];

function ok(name, condition, detail) {
  if (condition) pass++;
  else failures.push(name + (detail !== undefined ? ' -> ' + detail : ''));
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    json: async function () { return body; },
  };
}

/**
 * Boot api.js as a freshly loaded page.
 *
 * @param {Object} server mutable fake server: {calls, currentToken}
 * @returns {Object} the VM global, carrying api.js's top-level bindings
 */
function bootPage(server) {
  const window = {
    location: { hostname: 'localhost', search: '', href: '' },
    ATTENDLY_API_BASE_URL: 'http://localhost:8000/api',
  };
  const sandbox = { window, console, setTimeout, clearTimeout, URLSearchParams, btoa: () => '' };

  sandbox.fetch = async function (url, init) {
    const method = (init && init.method) || 'GET';
    const headers = (init && init.headers) || {};
    server.calls.push({ method: method, url: url, csrf: headers['X-CSRF-Token'] || null });

    if (url.endsWith('/auth/login')) {
      return jsonResponse(200, { data: { id: 1, role: 'admin', name: 'Admin' } });
    }
    if (url.endsWith('/auth/me')) {
      return jsonResponse(200, { data: { user: { id: 1, role: 'admin', name: 'Admin' } } });
    }
    if (url.endsWith('/auth/csrf-token')) {
      server.tokenFetches++;
      return jsonResponse(200, { data: { csrfToken: server.currentToken } });
    }
    if (url.endsWith('/users/enroll-fingerprint')) {
      if (headers['X-CSRF-Token'] !== server.currentToken) {
        return jsonResponse(403, {
          error: { code: 'csrf_rejected', message: 'Request verification failed.' },
        });
      }
      return jsonResponse(200, {
        data: { ok: true, studentId: 2, fingerprintFingersCompleted: 2 },
      });
    }
    throw new Error('unexpected request ' + method + ' ' + url);
  };

  vm.createContext(sandbox);
  vm.runInContext(API_SRC, sandbox, { filename: 'api.js' });
  return sandbox;
}

/** Request path without the API mount point, for readable assertions. */
function trail(server) {
  return server.calls.map(function (call) {
    return call.method + ' ' + call.url.replace('http://localhost:8000/api', '');
  });
}

function posts(server, suffix) {
  return server.calls.filter(function (call) { return call.url.endsWith(suffix); });
}

/**
 * Run one scenario. A rejected promise is recorded as a failing assertion
 * instead of aborting the run, so a regression names the step it broke
 * rather than printing a bare stack trace.
 */
async function step(name, fn) {
  try {
    await fn();
  } catch (error) {
    const reason = error && (error.code || error.message) ? (error.code || error.message) : String(error);
    ok(name + ' ran without throwing', false, reason);
  }
}

(async function main() {
  /* ── A reload must not block the first write ───────────────────── */

  await step('reload', async function () {
    const reload = { calls: [], tokenFetches: 0, currentToken: 'token-1' };
    const page = bootPage(reload);
    ok('a freshly loaded page has no token', page.getCsrfToken() === null);

    const enrolled = await page.api.enrollFingerprint(2, 'right-thumb', ['a', 'b']);
    const sequence = trail(reload);
    ok('enrollment fetches the token before writing',
      sequence[0] === 'GET /auth/csrf-token' &&
      sequence[1] === 'POST /users/enroll-fingerprint', JSON.stringify(sequence));
    ok('the write carries the fetched token', reload.calls[1].csrf === 'token-1',
      String(reload.calls[1].csrf));
    ok('enrollment resolves with the server result',
      !!enrolled && enrolled.fingerprintFingersCompleted === 2);
    ok('the token is fetched once, not per request', reload.tokenFetches === 1,
      'fetches=' + reload.tokenFetches);
  });

  /* ── A session probe warms the token, and a rotated one replays ── */

  await step('warm and replay', async function () {
    const warm = { calls: [], tokenFetches: 0, currentToken: 'token-1' };
    const warmed = bootPage(warm);
    await warmed.api.me();
    await new Promise(function (resolve) { setImmediate(resolve); });
    ok('a session probe warms the token', warmed.getCsrfToken() === 'token-1',
      String(warmed.getCsrfToken()));

    warm.currentToken = 'token-2';         // server-side rotation
    const replayed = await warmed.api.enrollFingerprint(2, 'right-index', ['a', 'b']);
    const attempts = posts(warm, '/users/enroll-fingerprint');
    ok('a rejected token is retried exactly once', attempts.length === 2,
      'attempts=' + attempts.length);
    ok('the first attempt uses the stale token', attempts[0].csrf === 'token-1');
    ok('the replay uses the refreshed token', attempts[1].csrf === 'token-2');
    ok('the replay resolves with the server result',
      !!replayed && replayed.ok === true);
    ok('the refreshed token replaces the stale one', warmed.getCsrfToken() === 'token-2',
      String(warmed.getCsrfToken()));
  });

  /* ── Login asks for a token only once it has a session ─────────── */

  await step('login', async function () {
    const signedOut = { calls: [], tokenFetches: 0, currentToken: 'token-3' };
    const loginPage = bootPage(signedOut);
    await loginPage.api.login('admin@attendly.test', 'secret');
    const loginSequence = trail(signedOut);
    ok('login posts before fetching a token',
      loginSequence[0] === 'POST /auth/login' &&
      loginSequence[1] === 'GET /auth/csrf-token', JSON.stringify(loginSequence));
    ok('login leaves a usable token behind', loginPage.getCsrfToken() === 'token-3',
      String(loginPage.getCsrfToken()));
  });

  /* ── A permanent rejection must not loop ───────────────────────── */

  await step('permanent rejection', async function () {
    const hostile = { calls: [], tokenFetches: 0, currentToken: 'x' };
    const hostilePage = bootPage(hostile);
    hostilePage.fetch = async function (url, init) {
      hostile.calls.push({
        method: init.method,
        url: url,
        csrf: (init.headers || {})['X-CSRF-Token'] || null,
      });
      if (url.endsWith('/auth/csrf-token')) {
        return jsonResponse(200, { data: { csrfToken: 'always-wrong' } });
      }
      return jsonResponse(403, {
        error: { code: 'csrf_rejected', message: 'Request verification failed.' },
      });
    };

    let thrown = null;
    try {
      await hostilePage.api.enrollFingerprint(2, 'left-thumb', ['a', 'b']);
    } catch (error) {
      thrown = error;
    }
    ok('a permanent rejection surfaces the server error',
      !!thrown && thrown.code === 'csrf_rejected', thrown && thrown.code);
    ok('a permanent rejection stops after one retry',
      posts(hostile, '/users/enroll-fingerprint').length === 2,
      'attempts=' + posts(hostile, '/users/enroll-fingerprint').length);
  });

  /* ── Report ────────────────────────────────────────────────────── */

  if (failures.length === 0) {
    console.log(`  ${pass} CSRF recovery assertions passed`);
    process.exit(0);
  }
  console.log(`  ${pass} passed, ${failures.length} FAILED:`);
  for (const f of failures) console.log('    - ' + f);
  process.exit(1);
})();
