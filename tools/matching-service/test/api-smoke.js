#!/usr/bin/env node
/*
 * Smoke test for tools/matching-service. No dependencies.
 *
 * Starts the built jar, checks auth and garbage-input handling, and — when real
 * fingerprint PNGs are present in tools/matching-service/samples/ — checks the
 * actual scores:
 *
 *   samples/same-a.png   same finger as same-b.png
 *   samples/same-b.png
 *   samples/other.png    a different finger
 *
 * Run:  node tools/matching-service/test/api-smoke.js
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const serviceDir = path.resolve(__dirname, '..');
const jar = path.join(serviceDir, 'target', 'matching-service.jar');
const samplesDir = path.join(serviceDir, 'samples');
const base = 'http://127.0.0.1:8090';
const KEY = 'smoke-test-key';

let passed = 0;
let failed = 0;

function ok(name, condition, detail) {
  if (condition) {
    passed++;
    console.log('  ok   ' + name);
  } else {
    failed++;
    console.log('  FAIL ' + name + (detail === undefined ? '' : ' — ' + detail));
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function call(method, route, body, headers) {
  const response = await fetch(base + route, {
    method,
    headers: Object.assign(
      body === undefined ? {} : { 'Content-Type': 'application/json' },
      headers || {}
    ),
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* non-JSON is a failure the caller checks */ }
  return { status: response.status, json, text };
}

function sample(name) {
  const file = path.join(samplesDir, name);
  return fs.existsSync(file) ? fs.readFileSync(file).toString('base64') : null;
}

async function waitForHealth(child) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    try {
      const response = await fetch(base + '/health');
      if (response.ok) return true;
    } catch (e) { /* not up yet */ }
    await sleep(300);
  }
  return false;
}

async function main() {
  if (!fs.existsSync(jar)) {
    console.error('Build the service first: cd tools/matching-service && mvn -q package');
    process.exit(1);
  }

  const child = spawn('java', ['-jar', jar], {
    cwd: serviceDir,
    env: Object.assign({}, process.env, {
      MATCHING_KEY: KEY,
      MATCHING_THRESHOLD: '40',
      MATCHING_VERIFY_THRESHOLD: '30',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });

  try {
    const up = await waitForHealth(child);
    ok('service starts and answers GET /health', up, output.trim().split('\n').slice(-3).join(' | '));
    if (!up) return;

    let response = await call('GET', '/health');
    ok('health reports the 512 dpi default',
      response.status === 200 && response.json && response.json.dpi === 512,
      response.text);
    ok('health reports the 1:N threshold',
      response.status === 200 && response.json && response.json.threshold === 40,
      response.text);
    ok('health reports the 1:1 verify threshold',
      response.status === 200 && response.json && response.json.verifyThreshold === 30,
      response.text);

    response = await call('POST', '/template', { image: 'AAAA' });
    ok('missing key is rejected with 401', response.status === 401, response.status);

    response = await call('POST', '/template', { image: 'AAAA' }, { 'X-Matching-Key': 'wrong' });
    ok('wrong key is rejected with 401', response.status === 401, response.status);

    response = await call('POST', '/template', '{not json', { 'X-Matching-Key': KEY });
    ok('invalid JSON is a clean 400', response.status === 400 && response.json && typeof response.json.error === 'string', response.status);

    response = await call('POST', '/template', {}, { 'X-Matching-Key': KEY });
    ok('missing image is a clean 400', response.status === 400 && /image/.test(response.json.error), response.text);

    response = await call('POST', '/template', { image: 'bm90IGEgcG5n' }, { 'X-Matching-Key': KEY });
    ok('non-PNG bytes are a clean 400', response.status === 400 && !/\bat 0x|java\./.test(response.text), response.text);

    response = await call('POST', '/identify', { image: 'bm90IGEgcG5n', candidates: [] }, { 'X-Matching-Key': KEY });
    ok('garbage identify is a clean 400', response.status === 400, response.status);

    response = await call('POST', '/identify', { image: 'AAAA', candidates: [{ id: 1, templates: ['AAAA'] }] }, { 'X-Matching-Key': KEY });
    ok('invalid templates in candidates are a clean 400', response.status === 400, response.status);

    response = await call('POST', '/verify', { image: 'AAAA', candidate: { id: 1, templates: ['AAAA'] } }, { 'X-Matching-Key': KEY });
    ok('invalid templates in verify candidate are a clean 400', response.status === 400, response.status);

    response = await call('POST', '/verify', { image: 'AAAA' }, { 'X-Matching-Key': KEY });
    ok('verify requires a candidate object', response.status === 400, response.status);

    response = await call('GET', '/template', undefined, { 'X-Matching-Key': KEY });
    ok('wrong method is 405', response.status === 405, response.status);

    response = await call('GET', '/nope');
    ok('unknown path is 404', response.status === 404, response.status);

    const sameA = sample('same-a.png');
    const sameB = sample('same-b.png');
    const other = sample('other.png');
    if (sameA && sameB && other) {
      const templateA = await call('POST', '/template', { image: sameA }, { 'X-Matching-Key': KEY });
      const templateB = await call('POST', '/template', { image: sameB }, { 'X-Matching-Key': KEY });
      const templateOther = await call('POST', '/template', { image: other }, { 'X-Matching-Key': KEY });
      ok('real PNGs produce templates',
        templateA.status === 200 && templateB.status === 200 && templateOther.status === 200,
        [templateA.status, templateB.status, templateOther.status].join('/'));

      const same = await call('POST', '/identify', {
        image: sameB,
        candidates: [
          { id: 7, templates: [templateA.json.template], fingers: ['left-thumb'] },
          { id: 9, templates: [templateOther.json.template], fingers: ['right-index'] },
        ],
      }, { 'X-Matching-Key': KEY });
      ok('same finger matches the enrolled student', same.json && same.json.match && same.json.match.id === 7, same.text);
      ok('same-finger score clears the 40 threshold', same.json && same.json.match && same.json.match.score >= 40, same.text);
      ok('identify reports the matched finger', same.json && same.json.match && same.json.match.finger === 'left-thumb', same.text);
      ok('identify always reports bestScore and threshold',
        same.json && typeof same.json.bestScore === 'number' && same.json.threshold === 40,
        same.text);

      const impostor = await call('POST', '/identify', {
        image: other,
        candidates: [{ id: 7, templates: [templateA.json.template], fingers: ['left-thumb'] }],
      }, { 'X-Matching-Key': KEY });
      ok('different finger stays below the threshold', impostor.json && impostor.json.match === null && impostor.json.bestScore < 40, impostor.text);
      ok('no-match response keeps the threshold for debug mode',
        impostor.json && impostor.json.threshold === 40,
        impostor.text);
      ok('same finger scores higher than a different finger',
        same.json.match.score > (impostor.json.bestScore || 0),
        same.json.match.score + ' vs ' + impostor.json.bestScore);

      const verify = await call('POST', '/verify', {
        image: sameB,
        candidate: { id: 12, templates: [templateA.json.template], fingers: ['left-thumb'] },
        threshold: 30,
      }, { 'X-Matching-Key': KEY });
      ok('1:1 /verify matches the enrolled student',
        verify.json && verify.json.match && verify.json.match.id === 12, verify.text);
      ok('1:1 verification clears the lowered threshold of 30',
        verify.json && verify.json.match && verify.json.match.score >= 30 && verify.json.threshold === 30, verify.text);
      ok('/verify reports the matched finger',
        verify.json && verify.json.match && verify.json.match.finger === 'left-thumb', verify.text);

      const verifyImpostor = await call('POST', '/verify', {
        image: other,
        candidate: { id: 12, templates: [templateA.json.template], fingers: ['left-thumb'] },
        threshold: 30,
      }, { 'X-Matching-Key': KEY });
      ok('1:1 /verify rejects a different finger',
        verifyImpostor.json && verifyImpostor.json.match === null, verifyImpostor.text);
      ok('/verify no-match keeps the threshold for debug mode',
        verifyImpostor.json && verifyImpostor.json.threshold === 30, verifyImpostor.text);

      const customThreshold = await call('POST', '/verify', {
        image: sameB,
        candidate: { id: 12, templates: [templateA.json.template], fingers: ['left-thumb'] },
        threshold: 35,
      }, { 'X-Matching-Key': KEY });
      ok('/verify applies the threshold sent by PHP',
        customThreshold.json && customThreshold.json.threshold === 35, customThreshold.text);

      console.log('  scores: same=' + same.json.match.score + ' other=' + impostor.json.bestScore);
    } else {
      console.log('  skip real-score checks (no samples/same-a.png, same-b.png, other.png)');
    }
  } finally {
    child.kill();
  }

  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
