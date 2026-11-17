/* ============================================================
   Fingerprint enrollment — Admin / SSC Manage Students
   ------------------------------------------------------------
   The "Enroll Fingerprint" action on a student row opens this
   modal. The officer ticks the consent box, then the student
   chooses one finger and scans once. Each accepted placement is
   a template from the DigitalPersona Web SDK — the same capture
   path and ?format= handling as js/kiosk.js — and poor
   placements are re-prompted instead of counted.

   The four templates live in memory only. Nothing is written to
   storage, nothing is logged, and only sizes and formats ever
   reach the console. After the fourth good scan they are sent
   together to POST /users/enroll-fingerprint through
   api.enrollFingerprint().

   Depends on:
     node_modules/@digitalpersona/*  WebSdk + dp.devices (page tags)
     api.js                          api.extractFingerprintTemplate,
                                     api.enrollFingerprint, isApiEnabled
     ui.js                           showToast, refreshGroupedStudentList
     data.js                         getUsers, setUsers, sameId
   ============================================================ */

(function (global) {
  'use strict';

  var SCANS_PER_FINGER = 1;
  var FINGERS = [
    { key: 'left-thumb', hand: 'Left hand', label: 'Thumb' },
    { key: 'left-index', hand: 'Left hand', label: 'Index' },
    { key: 'left-middle', hand: 'Left hand', label: 'Middle' },
    { key: 'left-ring', hand: 'Left hand', label: 'Ring' },
    { key: 'left-little', hand: 'Left hand', label: 'Little' },
    { key: 'right-thumb', hand: 'Right hand', label: 'Thumb' },
    { key: 'right-index', hand: 'Right hand', label: 'Index' },
    { key: 'right-middle', hand: 'Right hand', label: 'Middle' },
    { key: 'right-ring', hand: 'Right hand', label: 'Ring' },
    { key: 'right-little', hand: 'Right hand', label: 'Little' },
  ];
  var SCAN_COOLDOWN_MS = 900;   // one placement must not count twice
  var RESTART_GAP_MS = 2000;    // spacing for an automatic restart
  var QUALITY_WAIT_MS = 600;    // wait for this placement's QualityReported
  var LOCK_NAME = 'attendly-fingerprint-acquisition';
  var CONSENT_TEXT = 'The student agrees to enroll all ten fingers for event attendance. '
    + 'Each scan image is sent only to this laptop\'s matching service to create a template, '
    + 'then discarded. Only templates are stored; scans are never saved as images.';

  var FORMAT_MODE = readFormatMode();
  var DEBUG = readDebugMode();

  var state = {
    studentId: null,
    studentName: '',
    selectedFinger: null,
    enrolledFingers: [],
    modal: null,
    els: null,
    reader: null,
    handlersBound: false,
    sessionActive: false,
    acquisitionActive: false,
    starting: false,
    submitting: false,
    restartInFlight: false,
    restartTimer: null,
    samples: [],            // in-memory base64 images, discarded after submit
    lastStartAt: 0,
    cooldownUntil: 0,
    lastQuality: null,      // quality of the last QualityReported event
    pendingQuality: null,   // quality waiting for its own placement
    pendingQualityAt: 0,
    qualityWaiters: [],
    lastEventName: '',
    lastRejectReason: '',
    sampleBusy: false,
    releaseReaderLock: null,
  };

  /* ── Capture configuration (mirrors js/kiosk.js) ─────────────── */

  function searchParams() {
    try {
      return new URLSearchParams(global.location.search || '');
    } catch (error) {
      return new URLSearchParams('');
    }
  }

  function readFormatMode() {
    var value = String(searchParams().get('format') || '').toLowerCase();
    return value === 'intermediate' || value === 'raw' || value === 'png' ? value : 'png';
  }

  /** ?debug=1 shows the SDK diagnostics line in the modal. */
  function readDebugMode() {
    return String(searchParams().get('debug') || '') === '1';
  }

  /**
   * Map ?format= to a SampleFormat value. PNG is the default because the
   * matching service consumes image samples; ?format=intermediate and
   * ?format=raw stay optional diagnostics overrides.
   */
  function fingerprintSampleFormatValue() {
    var formats = (global.dp && global.dp.devices && global.dp.devices.SampleFormat) || {};
    var candidates = {
      png: ['PngImage'],
      intermediate: ['Intermediate', 'IntermediateImage'],
      raw: ['Raw', 'RawImage'],
    }[FORMAT_MODE] || ['PngImage'];
    for (var i = 0; i < candidates.length; i += 1) {
      if (formats[candidates[i]] != null) return formats[candidates[i]];
    }
    return formats.PngImage != null ? formats.PngImage : formats.Intermediate;
  }

  function sdkReady() {
    return Boolean(
      global.WebSdk &&
      typeof global.WebSdk.WebChannelOptions === 'function' &&
      global.dp &&
      global.dp.devices &&
      typeof global.dp.devices.FingerprintReader === 'function' &&
      global.dp.devices.SampleFormat &&
      (global.dp.devices.SampleFormat.Intermediate != null ||
        global.dp.devices.SampleFormat.PngImage != null)
    );
  }

  function createReader() {
    if (state.reader) return state.reader;
    var options = new global.WebSdk.WebChannelOptions({ debug: false });
    state.reader = new global.dp.devices.FingerprintReader(options);
    return state.reader;
  }

  function captureError(code, message) {
    var error = new Error(message || code);
    error.code = code;
    return error;
  }

  /** Name, message and HRESULT-style code — never sample data. */
  function describeError(error) {
    if (!error) return 'unknown error (the SDK sent no details)';
    var name = error.name || 'Error';
    var message = String(error.message || error);
    var code = error.code != null ? error.code : error.errorCode;
    var suffix = '';
    if (typeof code === 'number') suffix = ' [0x' + code.toString(16).toUpperCase() + ']';
    else if (typeof code === 'string' && code) suffix = ' [' + code + ']';
    return name + ': ' + message + suffix;
  }

  /* ── Quality gate ────────────────────────────────────────────── */

  /** The installed SDK's quality enum — QualityCode.Good is 0. */
  function qualityCodes() {
    return (global.dp && global.dp.devices && global.dp.devices.QualityCode) || null;
  }

  function goodQualityCode() {
    var codes = qualityCodes();
    return codes && typeof codes.Good === 'number' ? codes.Good : 0;
  }

  function qualityCodeName(value) {
    var codes = qualityCodes();
    if (!codes || value == null) return null;
    for (var name in codes) {
      if (Object.prototype.hasOwnProperty.call(codes, name) && codes[name] === value) return name;
    }
    return null;
  }

  function qualityIsKnown(value) {
    if (value === null || value === undefined) return false;
    if (typeof value === 'number') return true;
    return String(value).trim() !== '';
  }

  /**
   * Only QualityCode.Good counts as a good placement. QualityCode.Good is 0,
   * not 100, so the comparison is against the enum itself and never against
   * a percentage. Agents that send the enum as a numeric string still match.
   */
  function qualityIsGood(value) {
    if (!qualityIsKnown(value)) return false;
    var good = goodQualityCode();
    if (typeof value === 'number') return value === good;
    var text = String(value).trim();
    if (/^-?\d+$/.test(text)) return Number(text) === good;
    return /^good$/i.test(text);
  }

  /** A sample's own quality field, when the agent sends one. */
  function sampleQuality(sample) {
    if (!sample) return null;
    if (sample.Quality != null) return sample.Quality;
    if (sample.quality != null) return sample.quality;
    return null;
  }

  /* Each placement owns exactly one quality value: QualityReported normally
     fires just before SamplesAcquired, but some agents deliver it after. The
     value is consumed by the first sample that needs it and never reused, so
     a rejection can never be judged by an earlier placement's quality. */

  function takePendingQuality() {
    var quality = state.pendingQuality;
    var at = state.pendingQualityAt;
    state.pendingQuality = null;
    state.pendingQualityAt = 0;
    // A value left over from an earlier placement is not this one's.
    if (quality == null || Date.now() - at > 1500) return null;
    return quality;
  }

  function deliverQuality(quality) {
    var waiters = state.qualityWaiters;
    state.qualityWaiters = [];
    if (waiters.length) {
      waiters.forEach(function (resolve) { resolve(quality); });
      return;
    }
    state.pendingQuality = quality;
    state.pendingQualityAt = Date.now();
  }

  function waitForQuality(ms) {
    return new Promise(function (resolve) {
      var timer = global.setTimeout(function () { resolve(null); }, ms);
      state.qualityWaiters.push(function (quality) {
        global.clearTimeout(timer);
        resolve(quality);
      });
    });
  }

  /* ── Modal ───────────────────────────────────────────────────── */

  function fingerButtons(hand) {
    return FINGERS.filter(function (finger) { return finger.hand === hand; })
      .map(function (finger) {
        return '<button type="button" class="finger-enroll-choice" data-finger="' + finger.key + '" ' +
          'aria-pressed="false"><span>' + finger.label + '</span>' +
          '<small data-finger-state>Not enrolled</small></button>';
      }).join('');
  }

  function ensureModal() {
    if (state.modal) return state.modal;
    if (!global.bootstrap || typeof global.bootstrap.Modal !== 'function') {
      return null;
    }

    var wrapper = document.createElement('div');
    wrapper.innerHTML =
      '<div class="modal fade" id="fingerprintEnrollModal" tabindex="-1" ' +
        'aria-labelledby="fingerprintEnrollTitle" aria-hidden="true">' +
        '<div class="modal-dialog modal-dialog-centered">' +
          '<div class="modal-content">' +
            '<div class="modal-header">' +
              '<h5 class="modal-title" id="fingerprintEnrollTitle">Enroll fingerprints</h5>' +
              '<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>' +
            '</div>' +
            '<div class="modal-body fingerprint-enroll-body">' +
              '<div class="fingerprint-enroll-visual" aria-hidden="true"><i class="bi bi-fingerprint"></i></div>' +
              '<p class="fingerprint-enroll-student" id="fingerprintEnrollStudent">Student</p>' +
              '<label class="form-check fingerprint-enroll-consent" for="fingerprintEnrollConsent">' +
                '<input class="form-check-input" type="checkbox" id="fingerprintEnrollConsent">' +
                '<span class="form-check-label" id="fingerprintEnrollConsentText"></span>' +
              '</label>' +
              '<div class="finger-enroll-picker" id="fingerEnrollPicker" role="group" aria-label="Choose a finger">' +
                '<section class="finger-enroll-hand" aria-label="Left hand"><h6>Left hand</h6>' + fingerButtons('Left hand') + '</section>' +
                '<section class="finger-enroll-hand" aria-label="Right hand"><h6>Right hand</h6>' + fingerButtons('Right hand') + '</section>' +
              '</div>' +
              '<p class="finger-enroll-count" id="fingerEnrollCount" role="status" aria-live="polite">0/10 fingers</p>' +
              '<div class="progress fingerprint-enroll-progress" id="fingerprintEnrollProgress" ' +
                'role="progressbar" aria-valuemin="0" aria-valuemax="' + SCANS_PER_FINGER + '" ' +
                'aria-valuenow="0" aria-label="Fingerprint captures" style="height:6px">' +
                '<div class="progress-bar" id="fingerprintEnrollProgressBar" style="width:0%"></div>' +
              '</div>' +
              '<p class="fingerprint-enroll-progress-text" id="fingerprintEnrollProgressText" role="status">' +
                'Choose one finger to begin.' +
              '</p>' +
              '<p class="fingerprint-enroll-status" id="fingerprintEnrollStatus" role="status">' +
                'Tick the consent box, then press Start scanning.</p>' +
              '<p class="fingerprint-enroll-help">Choose a finger, then place it on the U.are.U 4500 sensor ' + SCANS_PER_FINGER + ' time(s). ' +
                'Only QualityCode.Good scans count. Only captured templates are sent to the server; ' +
                'the image is sent only to this laptop\'s matching service, used to create a template, then discarded.</p>' +
              '<p class="fingerprint-enroll-error" id="fingerprintEnrollError" role="alert" hidden></p>' +
              '<p class="fingerprint-enroll-debug" id="fingerprintEnrollDebug" hidden></p>' +
            '</div>' +
            '<div class="modal-footer">' +
              '<button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancel</button>' +
              '<button type="button" class="btn btn-success" id="fingerprintEnrollStart" disabled>' +
                '<i class="bi bi-fingerprint"></i> Start scanning' +
              '</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    var modalEl = wrapper.firstElementChild;
    document.body.appendChild(modalEl);

    state.els = {
      modalEl: modalEl,
      student: document.getElementById('fingerprintEnrollStudent'),
      fingerPicker: document.getElementById('fingerEnrollPicker'),
      fingerCount: document.getElementById('fingerEnrollCount'),
      consentText: document.getElementById('fingerprintEnrollConsentText'),
      consent: document.getElementById('fingerprintEnrollConsent'),
      progress: document.getElementById('fingerprintEnrollProgress'),
      progressBar: document.getElementById('fingerprintEnrollProgressBar'),
      progressText: document.getElementById('fingerprintEnrollProgressText'),
      status: document.getElementById('fingerprintEnrollStatus'),
      error: document.getElementById('fingerprintEnrollError'),
      debug: document.getElementById('fingerprintEnrollDebug'),
      start: document.getElementById('fingerprintEnrollStart'),
    };
    state.els.consentText.textContent = CONSENT_TEXT;

    state.els.consent.addEventListener('change', function () {
      setError('');
      if (!state.els.consent.checked) {
        stopSession();
        setStatus('Consent is required before scanning. Tick the box to continue.');
      } else {
        setStatus('Consent recorded. Press Start scanning.');
      }
      updateStartButton();
      updateDebug();
    });

    state.els.start.addEventListener('click', function () {
      startSession();
    });

    state.els.fingerPicker.addEventListener('click', function (event) {
      var button = event.target.closest('[data-finger]');
      if (!button || state.sessionActive || state.submitting || state.starting) return;
      state.selectedFinger = button.getAttribute('data-finger');
      clearSamples();
      setError('');
      var selected = FINGERS.find(function (finger) { return finger.key === state.selectedFinger; });
      setStatus('Place your ' + (selected ? selected.label.toLowerCase() : 'finger') +
        ' on the sensor, then press Start scanning.');
      renderFingerPicker();
      updateStartButton();
      updateDebug();
    });

    modalEl.addEventListener('hidden.bs.modal', function () {
      stopSession();
      clearSamples();
      state.studentId = null;
      state.selectedFinger = null;
      state.enrolledFingers = [];
      state.lastQuality = null;
      state.lastRejectReason = '';
      setError('');
      setStatus('Tick the consent box, then press Start scanning.');
      renderProgress();
      updateDebug();
    });

    modalEl.addEventListener('hide.bs.modal', function (event) {
      var missing = FINGERS.filter(function (finger) {
        return state.enrolledFingers.indexOf(finger.key) === -1;
      }).map(function (finger) {
        return finger.hand.replace(' hand', '') + ' ' + finger.label.toLowerCase();
      });
      if (missing.length === 0) return;
      var warning = 'Enrollment incomplete (' + state.enrolledFingers.length + '/10 fingers). Missing: ' +
        missing.join(', ') + '. Saved fingers will be kept. Close now and resume later?';
      if (!global.confirm(warning)) event.preventDefault();
    });

    state.modal = new global.bootstrap.Modal(modalEl);
    return state.modal;
  }

  function setStatus(message, enrollmentState) {
    if (!state.els) return;
    state.els.status.textContent = message;
    state.els.status.classList.toggle('is-incomplete', enrollmentState === 'incomplete');
    state.els.status.classList.toggle('is-complete', enrollmentState === 'complete');
  }

  function setError(message) {
    if (!state.els) return;
    state.els.error.textContent = message || '';
    state.els.error.hidden = !message;
  }

  function updateStartButton() {
    if (!state.els || !state.els.start) return;
    var consented = Boolean(state.els.consent && state.els.consent.checked);
    state.els.start.disabled = !consented || !state.selectedFinger || state.starting || state.submitting || state.sessionActive;
  }

  function renderFingerPicker() {
    if (!state.els || !state.els.fingerPicker) return;
    state.els.fingerPicker.querySelectorAll('[data-finger]').forEach(function (button) {
      var finger = button.getAttribute('data-finger');
      var done = state.enrolledFingers.indexOf(finger) !== -1;
      var selected = finger === state.selectedFinger;
      button.disabled = state.sessionActive || state.starting || state.submitting;
      button.classList.toggle('is-done', done);
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
      button.querySelector('[data-finger-state]').textContent = done ? 'Done · re-do' : 'Not enrolled';
    });
    state.els.fingerCount.textContent = state.enrolledFingers.length + '/10 fingers';
  }

  function renderProgress() {
    var done = state.samples.length;
    var current = Math.min(done + 1, SCANS_PER_FINGER);
    if (!state.els) return;
    state.els.progressText.textContent = state.selectedFinger
      ? 'Scan ' + current + ' of ' + SCANS_PER_FINGER + ' for ' + state.selectedFinger.replace('-', ' ')
      : 'Choose one finger to begin.';
    state.els.progressBar.style.width = Math.round((done / SCANS_PER_FINGER) * 100) + '%';
    state.els.progress.setAttribute('aria-valuenow', String(done));
  }

  /** Diagnostics for ?debug=1 only — event names, quality, counts. No data. */
  function updateDebug() {
    if (!state.els || !state.els.debug) return;
    if (!DEBUG) {
      state.els.debug.hidden = true;
      return;
    }
    var quality = state.lastQuality;
    var qualityLabel = quality == null
      ? '—'
      : String(quality) + ' (' + (qualityCodeName(quality) || typeof quality) + ')';
    state.els.debug.hidden = false;
    state.els.debug.textContent =
      'debug · last event: ' + (state.lastEventName || '—') +
      ' · quality: ' + qualityLabel +
      ' · accepted: ' + state.samples.length + '/' + SCANS_PER_FINGER +
      ' · rejected: ' + (state.lastRejectReason || 'none');
  }

  /* ── Cross-tab / cross-page exclusion ─────────────────────────
   * A Web Lock keeps a second dashboard tab from opening the same
   * reader while this modal is scanning. The kiosk does not take
   * this lock, so a kiosk that already holds the agent surfaces as
   * a reader-busy error instead.
   * ─────────────────────────────────────────────────────────── */

  function acquireReaderLock() {
    var locks = global.navigator && global.navigator.locks;
    if (!locks || typeof locks.request !== 'function') return Promise.resolve(true);
    return new Promise(function (resolve) {
      var request = locks.request(LOCK_NAME, { ifAvailable: true }, function (lock) {
        if (!lock) {
          resolve(false);
          return undefined;
        }
        resolve(true);
        return new Promise(function (release) {
          state.releaseReaderLock = release;
        });
      });
      if (request && typeof request.then === 'function') {
        request.catch(function () {
          resolve(false);
        });
      }
    });
  }

  function releaseReaderLock() {
    var release = state.releaseReaderLock;
    state.releaseReaderLock = null;
    if (typeof release === 'function') release();
  }

  /* ── Acquisition ─────────────────────────────────────────────── */

  function stopAcquisition(reader) {
    state.acquisitionActive = false;
    var active = reader || state.reader;
    if (!active || typeof active.stopAcquisition !== 'function') return Promise.resolve();
    try {
      var stopping = active.stopAcquisition();
      return stopping && typeof stopping.then === 'function'
        ? stopping.catch(function () {})
        : Promise.resolve();
    } catch (error) {
      return Promise.resolve();
    }
  }

  function startAcquisition(reader) {
    if (!reader) return Promise.reject(captureError('scanner_not_found'));
    if (state.acquisitionActive) return Promise.resolve();

    var sampleFormat = fingerprintSampleFormatValue();
    state.acquisitionActive = true;
    state.lastStartAt = Date.now();

    try {
      var starting = reader.startAcquisition(sampleFormat);
      if (starting && typeof starting.then === 'function') {
        return starting.then(function () {
          state.acquisitionActive = true;
        }).catch(function (error) {
          state.acquisitionActive = false;
          // Real rejection only: name, message and HRESULT. No sample data.
          if (global.console && typeof global.console.warn === 'function') {
            global.console.warn(
              '[enrollment] startAcquisition rejected — ' + describeError(error) +
              ' (format ' + FORMAT_MODE + ')'
            );
          }
          throw captureError('scanner_unavailable', describeError(error));
        });
      }
      return Promise.resolve();
    } catch (error) {
      state.acquisitionActive = false;
      if (global.console && typeof global.console.warn === 'function') {
        global.console.warn(
          '[enrollment] startAcquisition rejected — ' + describeError(error) +
          ' (format ' + FORMAT_MODE + ')'
        );
      }
      return Promise.reject(captureError('scanner_unavailable', describeError(error)));
    }
  }

  /** Stop, wait out the restart gap, then start again — one at a time. */
  async function restartAcquisition() {
    if (!state.sessionActive || state.submitting || state.restartInFlight) return;
    state.restartInFlight = true;
    if (state.restartTimer) {
      global.clearTimeout(state.restartTimer);
      state.restartTimer = null;
    }
    try {
      var wait = Math.max(0, RESTART_GAP_MS - (Date.now() - state.lastStartAt));
      if (wait > 0) {
        await new Promise(function (resolve) { global.setTimeout(resolve, wait); });
      }
      if (!state.sessionActive || state.submitting) return;
      await stopAcquisition();
      if (!state.sessionActive || state.submitting) return;
      await startAcquisition(state.reader);
    } catch (error) {
      stopSession();
      setStatus('Scanning stopped.');
      fail(error);
    } finally {
      state.restartInFlight = false;
      updateStartButton();
      updateDebug();
    }
  }

  /** Queue one deferred restart; extra calls collapse into it. */
  function scheduleRestart() {
    if (state.restartTimer) return;
    if (!state.sessionActive || state.submitting || state.starting) return;
    if (state.acquisitionActive || state.restartInFlight) return;
    var wait = Math.max(0, RESTART_GAP_MS - (Date.now() - state.lastStartAt));
    state.restartTimer = global.setTimeout(function () {
      state.restartTimer = null;
      if (!state.sessionActive || state.restartInFlight || state.acquisitionActive) return;
      state.restartInFlight = true;
      stopAcquisition()
        .then(function () {
          if (!state.sessionActive) return undefined;
          return startAcquisition(state.reader);
        })
        .catch(function () {})
        .then(function () {
          state.restartInFlight = false;
        });
    }, wait);
  }

  /** Handler binding is once per reader; the reader is a singleton. */
  function bindHandlers(reader) {
    if (state.handlersBound) return;
    state.handlersBound = true;

    reader.on('SamplesAcquired', function (event) {
      state.lastEventName = 'SamplesAcquired';
      updateDebug();
      handleSample(event).catch(function () {});
    });

    reader.on('QualityReported', function (event) {
      var quality = event && (event.quality !== undefined ? event.quality : event.Quality);
      state.lastEventName = 'QualityReported';
      state.lastQuality = quality == null ? null : quality;

      // Diagnostics only: the value, its type, the enum name it matches and
      // the Good code being compared against. The event carries no sample.
      if (global.console && typeof global.console.warn === 'function') {
        global.console.warn(
          '[enrollment] QualityReported quality=' + String(quality) +
          ' type=' + (typeof quality) +
          ' name=' + (qualityCodeName(quality) || 'unknown') +
          ' goodCode=' + String(goodQualityCode()) + ' (' + (typeof goodQualityCode()) + ')' +
          ' good=' + qualityIsGood(quality)
        );
      }

      deliverQuality(quality);
      updateDebug();
    });

    reader.on('AcquisitionStopped', function () {
      state.acquisitionActive = false;
      if (!state.sessionActive || state.submitting) return;
      // The SDK pauses acquisition on focus loss; restart once, spaced out.
      scheduleRestart();
    });

    reader.on('DeviceDisconnected', function () {
      state.acquisitionActive = false;
      stopSession();
      setStatus('Reader disconnected.');
      setError('The fingerprint reader was disconnected. Reconnect the U.are.U 4500, then press Start scanning.');
    });

    ['ErrorOccurred', 'CommunicationFailed'].forEach(function (name) {
      try {
        reader.on(name, function (event) {
          if (global.console && typeof global.console.warn === 'function') {
            global.console.warn('[enrollment] SDK ' + name + ' — ' + describeError(event));
          }
        });
      } catch (error) {
        // Agents that do not know an event name must not break the modal.
      }
    });
  }

  async function startSession() {
    if (state.starting || state.sessionActive || state.submitting) return;
    if (!state.studentId) return;
    if (!state.selectedFinger) {
      setError('Choose a finger before scanning.');
      return;
    }

    if (!state.els || !state.els.consent.checked) {
      setError('Tick the consent box before scanning.');
      return;
    }

    clearSamples();
    setError('');
    setStatus('Opening the fingerprint reader…');
    state.starting = true;
    state.lastQuality = null;
    state.lastEventName = '';
    state.lastRejectReason = '';
    state.pendingQuality = null;
    state.pendingQualityAt = 0;
    state.sampleBusy = false;
    updateStartButton();
    updateDebug();

    try {
      if (typeof isApiEnabled === 'function' && !isApiEnabled()) {
        throw captureError('api_not_configured', 'The API is not configured. Set API_BASE_URL before enrolling.');
      }
      if (!sdkReady()) {
        throw captureError('sdk_missing', 'The DigitalPersona Web SDK is not loaded on this page.');
      }
      if (!(await acquireReaderLock())) {
        throw captureError('scanner_busy', 'The fingerprint reader is already in use in another tab.');
      }

      var reader = createReader();
      var devices;
      try {
        devices = await reader.enumerateDevices();
      } catch (error) {
        throw captureError('scanner_unavailable', describeError(error));
      }
      if (!Array.isArray(devices) || devices.length === 0) {
        throw captureError('scanner_not_found', 'No fingerprint reader is connected.');
      }

      bindHandlers(reader);
      state.sessionActive = true;
      renderFingerPicker();
      // One acquisition at a time: stop any run before starting a new one.
      await stopAcquisition(reader);
      await startAcquisition(reader);

      renderProgress();
      var selected = FINGERS.find(function (finger) { return finger.key === state.selectedFinger; });
      setStatus('Place the ' + (selected ? selected.label.toLowerCase() : 'finger') + ' on the sensor. ' + progressLabel());
    } catch (error) {
      state.sessionActive = false;
      releaseReaderLock();
      setStatus('Scanning did not start.');
      fail(error);
    } finally {
      state.starting = false;
      updateStartButton();
    }
  }

  function progressLabel() {
    return 'Scan ' + Math.min(state.samples.length + 1, SCANS_PER_FINGER) + ' of ' + SCANS_PER_FINGER;
  }

  function stopSession() {
    state.sessionActive = false;
    if (state.restartTimer) {
      global.clearTimeout(state.restartTimer);
      state.restartTimer = null;
    }
    state.restartInFlight = false;
    stopAcquisition();
    releaseReaderLock();
    renderFingerPicker();
    updateStartButton();
  }

  function clearSamples() {
    state.samples = [];
    state.cooldownUntil = 0;
    renderProgress();
  }

  /* ── One placement ───────────────────────────────────────────── */

  async function handleSample(event) {
    if (!state.sessionActive || state.submitting) return;
    // A cooldown stops one placement from delivering two counted samples.
    if (Date.now() < state.cooldownUntil) return;
    if (state.sampleBusy) return;

    var samples = event && Array.isArray(event.samples) ? event.samples : [];
    if (samples.length === 0) return;
    var sample = samples[0];

    state.sampleBusy = true;
    updateStartButton();
    var accepted = false;

    try {
      // The sample's own quality wins; otherwise take the value reported for
      // this same placement, and wait briefly if it has not arrived yet.
      var quality = sampleQuality(sample);
      if (qualityIsKnown(quality)) {
        takePendingQuality();
      } else {
        quality = takePendingQuality();
      }
      if (!qualityIsKnown(quality)) {
        quality = await waitForQuality(QUALITY_WAIT_MS);
      }

      if (!qualityIsKnown(quality)) {
        rejectSample('no quality reported for this placement');
        setStatus('Scan quality was not reported. Keep your finger on the sensor and try again. ' + progressLabel());
        return;
      }
      if (!qualityIsGood(quality)) {
        rejectSample(
          'quality ' + String(quality) +
          ' (' + (qualityCodeName(quality) || typeof quality) + ') is not QualityCode.Good'
        );
        return;
      }

      state.lastRejectReason = '';

      var image = api.encodeFingerprintSample(sample);
      if (!image) {
        state.cooldownUntil = Date.now() + SCAN_COOLDOWN_MS;
        state.lastRejectReason = 'the SDK returned an empty sample';
        setStatus('Fingerprint not read — place the same finger again. ' + progressLabel());
        updateDebug();
        return;
      }

      state.samples.push(image);
      state.cooldownUntil = Date.now() + SCAN_COOLDOWN_MS;
      accepted = true;

      // Sizes and formats only; the image data itself is never logged.
      if (global.console && typeof global.console.info === 'function') {
        global.console.info(
          '[enrollment] capture ' + state.samples.length + '/' + SCANS_PER_FINGER +
          ' accepted — ' + image.length + ' base64 chars, format ' + FORMAT_MODE
        );
      }

      renderProgress();
      updateDebug();
      if (state.samples.length >= SCANS_PER_FINGER) {
        await submit();
        return;
      }
      setStatus('Good scan. ' + progressLabel());
    } catch (error) {
      state.cooldownUntil = Date.now() + SCAN_COOLDOWN_MS;
      state.lastRejectReason = 'capture error: ' + describeError(error);
      setStatus('Place the same finger again. ' + progressLabel());
      if (global.console && typeof global.console.warn === 'function') {
        global.console.warn('[enrollment] capture failed — ' + describeError(error));
      }
    } finally {
      state.sampleBusy = false;
      updateStartButton();
      updateDebug();
    }

    // One acquisition at a time: the next placement has to be able to count.
    if (state.sessionActive && !state.submitting) {
      await restartAcquisition();
      if (state.sessionActive && !state.submitting) {
        setStatus((accepted ? 'Good scan. ' : '') + 'Place the same finger again. ' + progressLabel());
      }
    }
  }

  /** A rejected placement is never counted and never leaves the modal busy. */
  function rejectSample(reason) {
    state.cooldownUntil = Date.now() + SCAN_COOLDOWN_MS;
    state.lastRejectReason = reason;
    setStatus('Poor scan — place the same finger again. ' + progressLabel());
    updateDebug();
  }

  /* ── Submission ─────────────────────────────────────────────── */

  async function submit() {
    if (state.submitting) return;
    state.submitting = true;
    updateStartButton();
    setError('');
    setStatus('Good scan captured. Saving this finger…');

    // No acquisition while the server call runs.
    stopSession();

    var images = state.samples.slice();
    try {
      var result = await api.enrollFingerprint(state.studentId, state.selectedFinger, images);
      markEnrolled(state.studentId, result);
      var complete = result.fingerprintEnrolled === true && state.enrolledFingers.length === 10;
      var finger = FINGERS.find(function (item) { return item.key === state.selectedFinger; });
      state.selectedFinger = null;
      renderFingerPicker();
      renderProgress();
      if (complete) {
        setStatus('All 10 fingers are enrolled. Fingerprint attendance is enabled.', 'complete');
        if (typeof showToast === 'function') showToast('success', result.message || 'All 10 fingers enrolled.');
      } else {
        var missing = FINGERS.filter(function (item) {
          return state.enrolledFingers.indexOf(item.key) === -1;
        }).map(function (item) {
          return item.hand.replace(' hand', '') + ' ' + item.label.toLowerCase();
        });
        setStatus((finger ? finger.hand + ' ' + finger.label.toLowerCase() : 'Finger') +
          ' saved. Incomplete: ' + state.enrolledFingers.length + '/10 fingers. Continue with: ' + missing.join(', ') + '.', 'incomplete');
        if (typeof showToast === 'function') {
          showToast('warning', 'Enrollment incomplete: ' + state.enrolledFingers.length + '/10 fingers.');
        }
      }
    } catch (error) {
      setStatus('Enrollment did not finish.');
      fail(error);
    } finally {
      state.submitting = false;
      clearSamples();
      renderFingerPicker();
      updateStartButton();
      updateDebug();
    }
  }

  function errorMessage(error) {
    if (!error) return 'The fingerprint could not be enrolled.';
    var code = error.code || '';
    var map = {
      'api_not_configured': 'The API is not configured. Set API_BASE_URL before enrolling.',
      'sdk_missing': 'The DigitalPersona Web SDK is not loaded on this page. Reload the dashboard.',
      'scanner_not_found': 'No U.are.U 4500 reader was found. Plug it in, then press Start scanning.',
      'scanner_unavailable': 'The fingerprint reader could not be opened. Close any other page or scanner application using it, then retry.',
      'scanner_busy': 'The fingerprint reader is already in use in another tab (for example the kiosk). Close that tab and retry.',
      'matching_service_not_configured': 'Fingerprint matching is not configured on the server yet, so these scans were not saved. Ask the administrator to configure the matching service.',
      'matching_service_unavailable': 'The fingerprint matching service is not running on this laptop, so these scans were not saved.',
      'fingerprint_already_enrolled': 'This fingerprint is already enrolled to another student.',
      'student_not_found': 'This student record no longer exists.',
      'invalid_field': 'The captured image was rejected. Scan the same finger again.',
      'network_error': 'The attendance server did not respond. Check the connection and retry.',
    };
    return map[code] || error.message || 'The fingerprint could not be enrolled.';
  }

  function fail(error) {
    var message = errorMessage(error);
    setError(message);
    if (typeof showToast === 'function') {
      showToast('error', message);
    }
  }

  function markEnrolled(studentId, result) {
    if (typeof getUsers !== 'function' || typeof setUsers !== 'function') return;
    var users = getUsers().map(function (user) {
      if (!sameId(user.id, studentId)) return user;
      state.enrolledFingers = Array.isArray(result.enrolledFingers)
        ? result.enrolledFingers.slice()
        : state.enrolledFingers;
      return Object.assign({}, user, {
        fingerprintEnrolled: result.fingerprintEnrolled === true,
        fingerprintFingersCompleted: Number(result.fingerprintFingersCompleted) || state.enrolledFingers.length,
        enrolledFingers: state.enrolledFingers.slice(),
      });
    });
    setUsers(users);
    if (typeof refreshGroupedStudentList === 'function') {
      refreshGroupedStudentList();
    }
  }

  /* ── Entry point ─────────────────────────────────────────────── */

  /**
   * Called by the row button:
   *   enrollStudentFingerprint('<student user id>')
   */
  function enrollStudentFingerprint(studentId) {
    var student = (typeof getUsers === 'function' ? getUsers() : []).find(function (user) {
      return sameId(user.id, studentId);
    });

    state.studentId = studentId;
    state.studentName = student ? (student.name || student.email || 'Student') : 'Student';
    state.selectedFinger = null;
    state.enrolledFingers = student && Array.isArray(student.enrolledFingers)
      ? student.enrolledFingers.filter(function (finger) {
          return FINGERS.some(function (item) { return item.key === finger; });
        })
      : [];

    var modal = ensureModal();
    if (!modal) {
      if (typeof showToast === 'function') {
        showToast('error', 'The enrollment dialog could not open on this page.');
      }
      return;
    }

    stopSession();
    clearSamples();
    state.lastQuality = null;
    state.lastEventName = '';
    state.lastRejectReason = '';
    state.pendingQuality = null;
    state.pendingQualityAt = 0;
    state.sampleBusy = false;
    state.els.student.textContent = state.studentName;
    renderFingerPicker();
    state.els.consent.checked = false;
    state.els.consent.disabled = false;
    setError('');
    setStatus('Tick the consent box, choose a finger, then press Start scanning.');
    updateStartButton();
    updateDebug();
    modal.show();
  }

  // Never leave acquisition running after the dashboard goes away.
  global.addEventListener('pagehide', function () {
    stopSession();
    clearSamples();
  });
  global.addEventListener('beforeunload', function () {
    stopSession();
    clearSamples();
  });

  global.enrollStudentFingerprint = enrollStudentFingerprint;
})(window);
