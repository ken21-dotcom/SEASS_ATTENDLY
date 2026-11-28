/* ============================================================
   Fingerprint enrollment — Administrator-only Manage Students
   ------------------------------------------------------------
   The "Manage Fingerprints" action on an admin student row opens
   this modal. The administrator ticks the consent box, then the student
   chooses one finger and scans twice. Each accepted placement
   is a template from the DigitalPersona Web SDK — the same capture
   path and ?format= handling as js/kiosk.js. Blank or badly blurred
   placements are re-prompted; other imperfect captures are accepted with a warning.

   Two accepted captures per finger are sent to the server in scan order. Those
   templates live in memory only. Nothing is written to storage,
   nothing is logged, and only sizes and formats ever reach the
   console. The two accepted captures are sent together to
   POST /users/enroll-fingerprint through api.enrollFingerprint().

   Depends on:
     node_modules/@digitalpersona/*  WebSdk + dp.devices (page tags)
     api.js                          api.extractFingerprintTemplate,
                                     api.enrollFingerprint, isApiEnabled
     ui.js                           showToast, refreshGroupedStudentList
     data.js                         getUsers, setUsers, sameId
   ============================================================ */

(function (global) {
  'use strict';

  var SCANS_PER_FINGER = 2;
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

  /**
   * Guided enrollment sequence. The student is told which finger to place
   * next instead of choosing one from the picker. Right hand first, thumb
   * to pinky, then left — the order the server's FINGERPRINT_FINGERS list
   * in Repository.php expects, so the 10/10 count lines up exactly.
   *
   * To enroll fewer fingers, keep the same array but stop after the last
   * desired entry; the guided prompt and auto-advance logic are unchanged.
   */
  var GUIDED_FINGERS = [
    { key: 'right-thumb',   hand: 'Right hand', label: 'Thumb' },
    { key: 'right-index',   hand: 'Right hand', label: 'Index' },
    { key: 'right-middle',  hand: 'Right hand', label: 'Middle' },
    { key: 'right-ring',    hand: 'Right hand', label: 'Ring' },
    { key: 'right-little',  hand: 'Right hand', label: 'Pinky' },
    { key: 'left-thumb',    hand: 'Left hand',  label: 'Thumb' },
    { key: 'left-index',    hand: 'Left hand',  label: 'Index' },
    { key: 'left-middle',   hand: 'Left hand',  label: 'Middle' },
    { key: 'left-ring',     hand: 'Left hand',  label: 'Ring' },
    { key: 'left-little',   hand: 'Left hand',  label: 'Pinky' },
  ];

  /** The next finger the student should place, per the guided sequence. */
  function nextGuidedFinger() {
    for (var i = 0; i < GUIDED_FINGERS.length; i += 1) {
      if (state.enrolledFingers.indexOf(GUIDED_FINGERS[i].key) === -1) {
        return GUIDED_FINGERS[i];
      }
    }
    return null;
  }

  var SCAN_COOLDOWN_MS = 600;   // one placement must not count twice
  var RESTART_GAP_MS = 700;     // settle time before an automatic restart
  var AUTO_ADVANCE_MS = 1000;   // 1-second delay between save and next finger auto-advance
  var STOP_ECHO_MS = 2000;      // how long a stop's notification may trail a start
  var QUALITY_WAIT_MS = 350;    // wait for this placement's QualityReported
  var LOCK_NAME = 'attendly-fingerprint-acquisition';
  var CONSENT_TEXT = 'The student agrees to enroll all ten fingers for event attendance. '
    + 'Each scan image is sent only to this laptop\'s matching service to create a template, '
    + 'then discarded. Only templates are stored; scans are never saved as images.';
  var LOW_QUALITY_WARNING = 'Scan accepted, but quality is low. Please press slightly harder for the next scan.';
  var WIPE_SUCCESS_MESSAGE = 'Enrollment incomplete. All partial fingers have been erased to ensure data integrity. Please try again.';
  var WIPE_FAILURE_MESSAGE = 'Enrollment incomplete. The partial fingerprints could not be erased. Please try again.';

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
    opening: false,
    restartInFlight: false,
    restartTimer: null,
    autoAdvanceTimer: null,
    stopRequestedAt: 0,     // when we last asked the agent to stop
    samples: [],            // in-memory accepted image strings; submitted in scan order
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
    allowIncompleteClose: false,
    cancelDialog: null,
    cancelDialogReturnFocus: null,
    cancelDialogWasScanning: false,
  };

  // One in-flight wipe per student. Reopening must never race a DELETE issued
  // by the previous modal close, or a late wipe can erase a fresh 10/10 set.
  var pendingResets = Object.create(null);

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
   * True only for a perfect placement (QualityCode.Good). Good is 0, not 100,
   * so the comparison is against the enum itself and never a percentage.
   * Agents that send the enum as a numeric string still match. This is used to
   * classify a scan for diagnostics — acceptance is decided by qualityIsUsable.
   */
  function qualityIsGood(value) {
    if (!qualityIsKnown(value)) return false;
    var good = goodQualityCode();
    if (typeof value === 'number') return value === good;
    var text = String(value).trim();
    if (/^-?\d+$/.test(text)) return Number(text) === good;
    return /^good$/i.test(text);
  }

  /**
   * Hard reject only blank, fake, rushed, reversed, or otherwise strange
   * captures. TooShort and TooSmall are accepted because smaller fingers may
   * not cover the sensor; SourceAFIS decides whether their images are usable.
   * Other imperfect but readable prints are accepted with a quality warning.
   */
  var UNUSABLE_QUALITY_CODES = [
    'NoImage', 'FakeFinger', 'TooFast', 'TooSlow', 'ReverseMotion', 'TooStrange',
  ];

  /**
   * True when a quality value can still produce a template. Unknown and
   * unenumerated values pass: an agent's own code is not ours to refuse, and
   * the matching service answers for the image either way.
   */
  function qualityIsUsable(value) {
    if (!qualityIsKnown(value)) return true;
    var name = qualityCodeName(value);
    if (!name) return true;
    var wanted = String(name).toLowerCase();
    for (var i = 0; i < UNUSABLE_QUALITY_CODES.length; i += 1) {
      if (UNUSABLE_QUALITY_CODES[i].toLowerCase() === wanted) return false;
    }
    return true;
  }

  /** One console line per rejected placement: raw value plus the human reason. */
  function logRejection(quality, reason) {
    if (!global.console || typeof global.console.log !== 'function') return;
    global.console.log(
      'Scan rejected. Quality:', quality == null ? 'unknown' : quality,
      'Reason:', reason
    );
  }

  /** A scan that is usable but not perfect still gets a console breadcrumb. */
  function logAcceptance(quality, reason) {
    if (!global.console || typeof global.console.info !== 'function') return;
    global.console.info(
      '[enrollment] scan accepted — quality ' +
      (quality == null ? 'unknown' : String(quality)) +
      ' (' + (qualityCodeName(quality) || 'unreported') + '): ' + reason
    );
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
              '<p class="fingerprint-enroll-error" id="fingerprintEnrollError" role="alert" hidden></p>' +
              '<div class="finger-enroll-picker" id="fingerEnrollPicker" role="group" aria-label="Choose a finger">' +
                '<section class="finger-enroll-hand" aria-label="Left hand"><h6>Left hand</h6>' + fingerButtons('Left hand') + '</section>' +
                '<section class="finger-enroll-hand" aria-label="Right hand"><h6>Right hand</h6>' + fingerButtons('Right hand') + '</section>' +
              '</div>' +
              '<p class="finger-enroll-count" id="fingerEnrollCount" role="status" aria-live="polite">0/10 fingers</p>' +
              '<div class="fingerprint-enroll-success" id="fingerprintEnrollSuccess" role="status" aria-live="polite" hidden>' +
                '<i class="bi bi-check-circle-fill" aria-hidden="true"></i>' +
                '<span><strong>All 10 fingers enrolled</strong>Fingerprint attendance is now enabled for this student.</span>' +
              '</div>' +
              '<div class="progress fingerprint-enroll-progress" id="fingerprintEnrollProgress" ' +
                'role="progressbar" aria-valuemin="0" aria-valuemax="' + SCANS_PER_FINGER + '" ' +
                'aria-valuenow="0" aria-label="Fingerprint captures" style="height:6px">' +
                '<div class="progress-bar" id="fingerprintEnrollProgressBar" style="width:0%"></div>' +
              '</div>' +
              '<p class="fingerprint-enroll-guided" id="fingerprintEnrollGuided" role="status" hidden>' +
                '<span class="fingerprint-enroll-guided-finger"></span> &middot; ' +
                '<span class="fingerprint-enroll-guided-count"></span></p>' +
              '<p class="fingerprint-enroll-progress-text" id="fingerprintEnrollProgressText" role="status">' +
                'Choose one finger to begin.' +
              '</p>' +
              '<p class="fingerprint-enroll-status" id="fingerprintEnrollStatus" role="status">' +
                'Tick the consent box, then press Start scanning.</p>' +
              '<p class="fingerprint-enroll-help">Choose a finger, then place it on the U.are.U 4500 sensor 2 times. ' +
                'Keep the same finger for both placements, varying the position slightly. A scan is refused only when the sensor reports a blank, fake, or badly blurred capture. ' +
                'Only captured templates are sent to the server; the image is sent only to this laptop\'s matching service, ' +
                'used to create a template, then discarded.</p>' +
              '<label class="form-check fingerprint-enroll-consent" for="fingerprintEnrollConsent">' +
                '<input class="form-check-input fingerprint-consent-checkbox" type="checkbox" id="fingerprintEnrollConsent">' +
                '<span class="form-check-label" id="fingerprintEnrollConsentText"></span>' +
              '</label>' +
              '<p class="fingerprint-enroll-debug" id="fingerprintEnrollDebug" hidden></p>' +
            '</div>' +
            '<div class="modal-footer">' +
              '<button type="button" class="btn btn-outline-danger" id="fingerprintEnrollClose" data-bs-dismiss="modal">' +
                'Continue Later / Cancel Enrollment' +
              '</button>' +
              '<button type="button" class="btn btn-success" id="fingerprintEnrollConfirm" disabled>' +
                '<i class="bi bi-check2-circle"></i> Confirm and finish' +
              '</button>' +
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
      guided: document.getElementById('fingerprintEnrollGuided'),
      guidedFinger: document.querySelector('#fingerprintEnrollGuided .fingerprint-enroll-guided-finger'),
      guidedCount: document.querySelector('#fingerprintEnrollGuided .fingerprint-enroll-guided-count'),
      status: document.getElementById('fingerprintEnrollStatus'),
      error: document.getElementById('fingerprintEnrollError'),
      debug: document.getElementById('fingerprintEnrollDebug'),
      success: document.getElementById('fingerprintEnrollSuccess'),
      close: document.getElementById('fingerprintEnrollClose'),
      confirm: document.getElementById('fingerprintEnrollConfirm'),
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

    state.els.confirm.addEventListener('click', function () {
      if (state.enrolledFingers.length !== FINGERS.length) return;
      // The list was refreshed after the final save; refresh once more so the
      // row shows "Enrolled" the moment the modal closes.
      if (typeof refreshGroupedStudentList === 'function') {
        refreshGroupedStudentList();
      }
      if (state.modal) state.modal.hide();
    });

    state.els.fingerPicker.addEventListener('click', function (event) {
      var button = event.target.closest('[data-finger]');
      // In guided mode the sequence owns the finger choice; ignore clicks so
      // the student cannot skip ahead or repeat a finger out of order.
      if (!button || state.useGuided || state.sessionActive || state.submitting || state.starting) return;
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

    modalEl.addEventListener('hidden.bs.modal', async function () {
      var studentIdToWipe = (state.enrolledFingers.length > 0 && state.enrolledFingers.length < FINGERS.length)
        ? state.studentId
        : null;

      stopSession();
      clearSamples();
      state.studentId = null;
      state.selectedFinger = null;
      state.enrolledFingers = [];
      state.useGuided = false;
      state.lastQuality = null;
      state.lastRejectReason = '';
      setError('');
      setStatus('Tick the consent box, then press Start scanning.');
      renderFingerPicker();
      renderProgress();
      updateDebug();

      if (studentIdToWipe && typeof api !== 'undefined' && typeof api.resetStudentFingerprint === 'function') {
        // Await the queued DELETE. It marks local data wiped only after the API
        // confirms success; a later reopen joins this same in-flight reset.
        await queueFingerprintReset(studentIdToWipe, true);
      }
    });

    modalEl.addEventListener('hide.bs.modal', function (event) {
      if (state.allowIncompleteClose) {
        state.allowIncompleteClose = false;
        return;
      }
      var missing = FINGERS.filter(function (finger) {
        return state.enrolledFingers.indexOf(finger.key) === -1;
      }).map(function (finger) {
        return finger.hand.replace(' hand', '') + ' ' + finger.label.toLowerCase();
      });
      if (missing.length === 0 || state.enrolledFingers.length === 0) return;
      event.preventDefault();
      showIncompleteEnrollmentConfirm(missing);
    });

    // The cancel button is the same control from open to close, so it needs
    // no special wiring: data-bs-dismiss="modal" closes the sheet, which
    // fires hide.bs.modal (the incomplete-enrollment guard) and then
    // hidden.bs.modal (stopSession + releaseReaderLock). The reader stream
    // is released in stopSession() — the same path the lock and pagehide
    // handlers use — so canceling always frees the hardware.

    state.modal = new global.bootstrap.Modal(modalEl);
    return state.modal;
  }

  function showIncompleteEnrollmentConfirm(missing) {
    var dialog = state.cancelDialog;
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.className = 'fingerprint-cancel-dialog';
      dialog.setAttribute('aria-labelledby', 'fingerprintCancelTitle');
      dialog.setAttribute('aria-describedby', 'fingerprintCancelDescription');
      dialog.innerHTML =
        '<div class="fingerprint-cancel-dialog__content">' +
          '<div class="fingerprint-cancel-dialog__icon" aria-hidden="true"><i class="bi bi-fingerprint"></i></div>' +
          '<p class="fingerprint-cancel-dialog__eyebrow">Enrollment in progress</p>' +
          '<h2 id="fingerprintCancelTitle">Cancel enrollment?</h2>' +
          '<p class="fingerprint-cancel-dialog__description" id="fingerprintCancelDescription"></p>' +
          '<div class="fingerprint-cancel-dialog__progress">' +
            '<div class="fingerprint-cancel-dialog__progress-copy"><span>Progress</span><strong id="fingerprintCancelProgress"></strong></div>' +
            '<div class="fingerprint-cancel-dialog__track"><span id="fingerprintCancelProgressBar"></span></div>' +
          '</div>' +
          '<div class="fingerprint-cancel-dialog__missing">' +
            '<span class="fingerprint-cancel-dialog__missing-label">Still to scan</span>' +
            '<ul id="fingerprintCancelMissing"></ul>' +
          '</div>' +
          '<div class="fingerprint-cancel-dialog__actions">' +
            '<button type="button" class="fingerprint-cancel-dialog__keep" data-cancel-enrollment="keep">Keep enrolling</button>' +
            '<button type="button" class="fingerprint-cancel-dialog__wipe" data-cancel-enrollment="wipe">Cancel and wipe</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(dialog);
      dialog.querySelector('[data-cancel-enrollment="keep"]').addEventListener('click', function () {
        dialog.close('keep');
      });
      dialog.querySelector('[data-cancel-enrollment="wipe"]').addEventListener('click', function () {
        state.allowIncompleteClose = true;
        state.cancelDialogWasScanning = false;
        dialog.close('wipe');
        if (state.modal) state.modal.hide();
      });
      dialog.addEventListener('cancel', function (event) {
        // Escape keeps the student in the enrollment flow; only the explicit
        // destructive action below is allowed to close and wipe the partial set.
        event.preventDefault();
        dialog.close('keep');
      });
      dialog.addEventListener('close', function () {
        if (dialog.returnValue !== 'wipe' && state.cancelDialogReturnFocus &&
            state.cancelDialogReturnFocus.isConnected) {
          state.cancelDialogReturnFocus.focus();
        }
        if (dialog.returnValue !== 'wipe' && state.cancelDialogWasScanning && state.studentId) {
          // The reader was paused while the decision was open. Resume on the
          // current finger when the administrator chooses to keep enrolling.
          startSession();
        }
        state.cancelDialogWasScanning = false;
        state.cancelDialogReturnFocus = null;
      });
      state.cancelDialog = dialog;
    }

    var count = state.enrolledFingers.length;
    dialog.querySelector('#fingerprintCancelDescription').textContent =
      'Closing will cancel enrollment and wipe all saved fingers. You will need to start again.';
    dialog.querySelector('#fingerprintCancelProgress').textContent = count + ' of 10 fingers';
    dialog.querySelector('#fingerprintCancelProgressBar').style.width = (count * 10) + '%';

    var missingList = dialog.querySelector('#fingerprintCancelMissing');
    missingList.textContent = '';
    missing.forEach(function (fingerName) {
      var item = document.createElement('li');
      item.textContent = fingerName;
      missingList.appendChild(item);
    });

    if (!dialog.open) {
      state.cancelDialogReturnFocus = document.activeElement;
      state.cancelDialogWasScanning = state.sessionActive;
      if (state.cancelDialogWasScanning) {
        stopSession();
        setStatus('Scanning paused while you decide.');
      }
      dialog.showModal();
    }
  }

  function setStatus(message, enrollmentState) {
    if (!state.els) return;
    state.els.status.textContent = message;
    state.els.status.classList.toggle('is-incomplete', enrollmentState === 'incomplete');
    state.els.status.classList.toggle('is-warning', enrollmentState === 'warning');
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
    state.els.start.disabled = !consented || !state.selectedFinger ||
      state.starting || state.submitting || state.sessionActive;
  }

  function fingerprintComplete() {
    return state.enrolledFingers.length === FINGERS.length;
  }

  /**
   * The footer carries one primary decision at a time: while fingers are still
   * missing it offers Continue Later / Cancel Enrollment, and once all ten are
   * stored that action is replaced by Confirm and finish. Showing both at once
   * let the student "confirm" an enrollment that was not actually complete.
   */
  function renderCompletionState() {
    if (!state.els) return;
    var complete = fingerprintComplete();
    if (state.els.success) state.els.success.hidden = !complete;
    if (state.els.close) {
      // Cancel/resume is only meaningful while some finger still has no
      // template. It steps aside for the confirm action on completion.
      state.els.close.hidden = complete;
      // The label is fixed: the button is always the cancel/resume action,
      // so it never needs to announce a changing count.
      state.els.close.textContent = 'Continue Later / Cancel Enrollment';
    }
    if (state.els.confirm) {
      // Confirm and finish exists only when every finger is saved; before that
      // it stays out of the footer instead of sitting there greyed out.
      state.els.confirm.hidden = !complete;
      state.els.confirm.disabled = !complete;
      state.els.confirm.setAttribute('aria-disabled', complete ? 'false' : 'true');
    }
    if (state.els.start) {
      state.els.start.hidden = false;
      state.els.start.classList.toggle('btn-outline-success', complete);
      state.els.start.classList.toggle('btn-success', !complete);
    }
  }

  function renderFingerPicker() {
    if (!state.els || !state.els.fingerPicker) return;
    // In guided mode the sequence chooses the finger, so the picker is
    // disabled and only shows progress; the student cannot deviate.
    var guidedActive = state.useGuided && !fingerprintComplete();
    state.els.fingerPicker.querySelectorAll('[data-finger]').forEach(function (button) {
      var finger = button.getAttribute('data-finger');
      var done = state.enrolledFingers.indexOf(finger) !== -1;
      var selected = finger === state.selectedFinger;
      button.disabled = guidedActive || state.sessionActive || state.starting || state.submitting;
      button.classList.toggle('is-done', done);
      button.classList.toggle('is-selected', selected);
      button.classList.toggle('is-guided', guidedActive);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
      button.querySelector('[data-finger-state]').textContent = done ? 'Done · re-do' : 'Not enrolled';
    });
    state.els.fingerCount.textContent = state.enrolledFingers.length + '/10 fingers';
    renderCompletionState();
  }

  /** The exact prompt for the placement the student should make next. */
  function scanPrompt() {
    if (state.samples.length === 0) {
      return 'Scan 1 of ' + SCANS_PER_FINGER + '.';
    }
    return 'Lift your finger and place it again, slightly differently — scan ' +
      Math.min(state.samples.length + 1, SCANS_PER_FINGER) + ' of ' + SCANS_PER_FINGER + '.';
  }

  function fingerDisplayName(finger) {
    if (!finger) return 'finger';
    var hand = finger.hand ? finger.hand.replace(' hand', '') : '';
    return (hand ? hand + ' ' : '') + finger.label;
  }

  /**
   * Render the guided-finger prompt: "Please scan your Right Thumb
   * (Sample 1 of 3)". Hidden when no guided finger is active, so the
   * layout does not jump when the student is choosing a finger manually.
   */
  function renderGuidedPrompt() {
    if (!state.els || !state.els.guided) return;
    var finger = state.selectedFinger
      ? FINGERS.find(function (item) { return item.key === state.selectedFinger; })
      : null;
    if (!finger) {
      state.els.guided.hidden = true;
      return;
    }
    state.els.guided.hidden = false;
    var guided = GUIDED_FINGERS.find(function (item) { return item.key === finger.key; }) || finger;
    state.els.guidedFinger.textContent = 'Please scan your ' + fingerDisplayName(guided);
    state.els.guidedCount.textContent =
      '(Sample ' + Math.min(state.samples.length + 1, SCANS_PER_FINGER) +
      ' of ' + SCANS_PER_FINGER + ')';
  }

  function renderProgress() {
    var done = state.samples.length;
    if (!state.els) return;
    state.els.progressText.textContent = state.selectedFinger
      ? scanPrompt()
      : (fingerprintComplete() ? 'All 10 fingers enrolled.' : 'Choose one finger to begin.');
    state.els.progressBar.style.width = Math.round((done / SCANS_PER_FINGER) * 100) + '%';
    state.els.progress.setAttribute('aria-valuenow', String(done));
    renderGuidedPrompt();
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
    // The agent's Stopped notification can arrive after the next start, so the
    // request time lets that echo be told apart from a real pause.
    state.stopRequestedAt = Date.now();
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
      // Our own stop echoes here too. When a newer run started after the stop
      // was requested, this notification belongs to the old one: restarting on
      // it would stop the run the student has just begun.
      if (state.lastStartAt > state.stopRequestedAt &&
          Date.now() - state.lastStartAt < STOP_ECHO_MS) {
        return;
      }
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
      var next = nextGuidedFinger();
      if (!next) {
        setStatus('All fingers in the sequence are enrolled.', 'complete');
        return;
      }
      state.selectedFinger = next.key;
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
      // One acquisition at a time: stop a run that is still going before
      // starting a new one. An idle reader gets no redundant StopAcquisition,
      // because the agent can apply that stop after the new start and go
      // silent while the modal still waits for a finger.
      if (state.acquisitionActive) await stopAcquisition(reader);
      await startAcquisition(reader);

      renderProgress();
      var selected = FINGERS.find(function (finger) { return finger.key === state.selectedFinger; })
        || GUIDED_FINGERS.find(function (finger) { return finger.key === state.selectedFinger; });
      var selectedName = fingerDisplayName(selected);
      setStatus('Please scan your ' + selectedName + '. ' + scanPrompt());
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
    return 'Scan ' + Math.min(state.samples.length + 1, SCANS_PER_FINGER) + ' of ' + SCANS_PER_FINGER + '.';
  }

  /** Ends the session and resolves once the agent has released the reader. */
  function stopSession() {
    state.sessionActive = false;
    if (state.restartTimer) {
      global.clearTimeout(state.restartTimer);
      state.restartTimer = null;
    }
    if (state.autoAdvanceTimer) {
      global.clearTimeout(state.autoAdvanceTimer);
      state.autoAdvanceTimer = null;
    }
    state.restartInFlight = false;
    var stopped = stopAcquisition();
    releaseReaderLock();
    renderFingerPicker();
    updateStartButton();
    return stopped;
  }

  /**
   * Auto-advance: after a finger is saved the picker already points at the
   * next one that needs a template, so reopen acquisition instead of making
   * the student press Start scanning again. Any close, cancel or new save
   * clears the timer, so a stale advance can never start a hidden scan.
   */
  function scheduleAutoAdvance() {
    if (state.autoAdvanceTimer) {
      global.clearTimeout(state.autoAdvanceTimer);
      state.autoAdvanceTimer = null;
    }
    if (!state.els || !state.els.consent.checked) return;
    state.autoAdvanceTimer = global.setTimeout(function () {
      state.autoAdvanceTimer = null;
      if (state.sessionActive || state.submitting || state.starting) return;
      if (!state.selectedFinger) return;
      startSession();
    }, AUTO_ADVANCE_MS);
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
    if (samples.length === 0) {
      // The reader can emit an empty SamplesAcquired event after a rejected
      // placement. Restart explicitly so acquisition does not remain stopped.
      state.lastRejectReason = 'the SDK returned no samples';
      setStatus('Fingerprint not read — place the same finger again. ' + progressLabel());
      updateDebug();
      if (state.sessionActive && !state.submitting) await restartAcquisition();
      return;
    }
    var sample = samples[0];

    state.sampleBusy = true;
    updateStartButton();
    var accepted = false;
    var lowQualityAccepted = false;
    var acceptedStatus = '';
    var acceptedState;

    try {
      sampleFlow: {
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
        // Some agents never report quality. The image is still a real capture
        // and the matching service decides whether it yields a template, so a
        // missing report is not a reason to reject it locally.
        logAcceptance(quality, 'quality was not reported for this placement');
      } else if (!qualityIsUsable(quality)) {
        rejectSample(
          'quality ' + String(quality) + ' (' +
          (qualityCodeName(quality) || typeof quality) + ') has no usable print',
          quality
        );
        break sampleFlow;
      } else if (!qualityIsGood(quality)) {
        // Too light, too dark, low contrast, off-centre, pressure, noise: all
        // still carry a readable print, and SourceAFIS tolerates them far
        // better than a student tolerates rescanning. Keep a visible warning
        // so the student knows a better placement would help.
        lowQualityAccepted = true;
        logAcceptance(quality, 'usable, below QualityCode.Good');
      }

      state.lastRejectReason = '';

      var image = api.encodeFingerprintSample(sample);
      if (!image) {
        state.cooldownUntil = Date.now() + SCAN_COOLDOWN_MS;
        state.lastRejectReason = 'the SDK returned an empty sample';
        logRejection(quality, 'the SDK returned an empty sample');
        setStatus('Fingerprint not read — place the same finger again. ' + progressLabel());
        updateDebug();
        break sampleFlow;
      }

      // A finger left on the sensor can deliver the same frame again after the
      // automatic restart; sending it twice would merge a duplicate template.
      if (state.samples.indexOf(image) !== -1) {
        state.cooldownUntil = Date.now() + SCAN_COOLDOWN_MS;
        state.lastRejectReason = 'the same image was delivered twice';
        logRejection(quality, 'the same image was delivered twice');
        setStatus('That scan was already captured — lift your finger, then place it again. ' + progressLabel());
        updateDebug();
        break sampleFlow;
      }

      state.samples.push(image);
      state.cooldownUntil = Date.now() + SCAN_COOLDOWN_MS;
      accepted = true;
      acceptedStatus = lowQualityAccepted
        ? LOW_QUALITY_WARNING + ' ' + scanPrompt()
        : 'Good scan. ' + scanPrompt();
      acceptedState = lowQualityAccepted ? 'warning' : undefined;

      // Sizes and formats only; the image data itself is never logged.
      if (global.console && typeof global.console.info === 'function') {
        global.console.info(
          '[enrollment] capture ' + state.samples.length + '/' + SCANS_PER_FINGER +
          ' accepted — ' + image.length + ' base64 chars, format ' + FORMAT_MODE +
          ' (quality ' + (quality == null ? 'unknown' : String(quality)) + ')'
        );
      }

      renderProgress();
      updateDebug();
      if (state.samples.length >= SCANS_PER_FINGER) {
        await submit(lowQualityAccepted);
        return;
      }
      setStatus(acceptedStatus, acceptedState);
      }
    } catch (error) {
      state.cooldownUntil = Date.now() + SCAN_COOLDOWN_MS;
      state.lastRejectReason = 'capture error: ' + describeError(error);
      logRejection(null, 'capture error: ' + describeError(error));
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
        setStatus(
          accepted ? acceptedStatus : 'Place the same finger again. ' + progressLabel(),
          accepted ? acceptedState : undefined
        );
      }
    }
  }

  /** A rejected placement is never counted and never leaves the modal busy. */
  function rejectSample(reason, quality) {
    state.cooldownUntil = Date.now() + SCAN_COOLDOWN_MS;
    state.lastRejectReason = reason;
    logRejection(quality, reason);
    setStatus('Poor scan — place the same finger again. ' + progressLabel());
    updateDebug();
  }

  /* ── Submission ─────────────────────────────────────────────── */

  async function submit(lowQualityOnFinalScan) {
    if (state.submitting) return;
    state.submitting = true;
    updateStartButton();
    setError('');
    setStatus(
      lowQualityOnFinalScan
        ? LOW_QUALITY_WARNING + ' Saving this finger…'
        : 'Good scan captured. Saving this finger…',
      lowQualityOnFinalScan ? 'warning' : undefined
    );

    // No acquisition while the server call runs, and the hardware has to be
    // free for the next finger: wait for the agent to confirm the stop rather
    // than leaving a stop notification to overtake the next start.
    await stopSession();

    var images = state.samples.slice();
    var finger = FINGERS.find(function (item) { return item.key === state.selectedFinger; });
    try {
      var result = await api.enrollFingerprint(state.studentId, state.selectedFinger, images);
      markEnrolled(state.studentId, result);
      var complete = result.fingerprintEnrolled === true && fingerprintComplete();
      state.selectedFinger = null;
      renderFingerPicker();
      renderProgress();
      if (complete) {
        setStatus('All 10 fingers are enrolled. Fingerprint attendance is enabled.', 'complete');
        if (typeof clearPersistentToast === 'function') clearPersistentToast();
        if (typeof showToast === 'function') showToast('success', result.message || 'All 10 fingers enrolled.');
      } else {
        var upcoming = nextGuidedFinger();
        if (upcoming) {
          state.selectedFinger = upcoming.key;
          var nextName = fingerDisplayName(upcoming);
          setStatus('Please scan your ' + nextName + '.', 'incomplete');
          if (typeof showToast === 'function') {
            showToast('info', 'Enrollment incomplete: ' + state.enrolledFingers.length + '/10 fingers. Next: scan your ' + nextName);
          }
          renderFingerPicker();
          renderProgress();
          scheduleAutoAdvance();
        } else {
          setStatus('All fingers in the sequence are enrolled.', 'complete');
        }
      }
    } catch (error) {
      if (error && error.code === 'fingerprint_already_enrolled') {
        setStatus('Enrollment rejected — this fingerprint is already enrolled to another student.');
      } else {
        setStatus('Enrollment did not finish — the scans were not saved. Press Start scanning to try again.');
      }
      fail(error, true);
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

  function fail(error, persistent) {
    var message = errorMessage(error);
    setError(message);
    if (typeof showToast === 'function') {
      // Every enrollment failure must survive navigation. Only an explicit
      // false can opt out (nothing currently does).
      showToast('error', message, { persistent: persistent !== false });
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

  function pendingResetFor(studentId) {
    return pendingResets[String(studentId)] || null;
  }

  /**
   * Serialize partial-enrollment wipes per student. The returned promise
   * resolves to true only after the backend confirmed the DELETE, so callers
   * can refuse to open the modal when the old partial set is still there.
   */
  function queueFingerprintReset(studentId, announceSuccess) {
    var key = String(studentId);
    var previous = pendingResets[key] || Promise.resolve();
    var current = previous
      .catch(function () {})
      .then(async function () {
        try {
          await api.resetStudentFingerprint(studentId);
        } catch (error) {
          if (typeof showToast === 'function') {
            showToast('error', WIPE_FAILURE_MESSAGE, { persistent: true });
          }
          return false;
        }
        markWiped(studentId);
        if (announceSuccess && typeof showToast === 'function') {
          showToast('error', WIPE_SUCCESS_MESSAGE, { persistent: true });
        }
        return true;
      })
      .catch(function () { return false; });

    pendingResets[key] = current;
    return current.then(function (wiped) {
      if (pendingResets[key] === current) delete pendingResets[key];
      return wiped;
    });
  }

  function markWiped(studentId) {
    if (typeof getUsers !== 'function' || typeof setUsers !== 'function') return;
    var users = getUsers().map(function (user) {
      if (!sameId(user.id, studentId)) return user;
      return Object.assign({}, user, {
        fingerprintEnrolled: false,
        fingerprintFingersCompleted: 0,
        enrolledFingers: [],
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
  async function enrollStudentFingerprint(studentId, options) {
    if (state.opening) return;
    state.opening = true;
    try {
      var student = (typeof getUsers === 'function' ? getUsers() : []).find(function (user) {
        return sameId(user.id, studentId);
      });

      state.studentId = studentId;
      state.studentName = student ? (student.name || student.email || 'Student') : 'Student';
      state.selectedFinger = null;
      state.useGuided = !!(options && options.guided);
      var initialEnrolled = student && Array.isArray(student.enrolledFingers)
        ? student.enrolledFingers.filter(function (finger) {
            return FINGERS.some(function (item) { return item.key === finger; });
          })
        : [];

      // Build the modal first: there is no reason to wipe data when this page
      // cannot show the enrollment dialog in the first place.
      var modal = ensureModal();
      if (!modal) {
        if (typeof showToast === 'function') {
          showToast('error', 'The enrollment dialog could not open on this page.');
        }
        return;
      }

      var needsReset = initialEnrolled.length > 0 && initialEnrolled.length < FINGERS.length;
      var apiAvailable = typeof api !== 'undefined' && typeof api.resetStudentFingerprint === 'function';
      // A close from the previous modal may still be wiping in the background.
      // Join that DELETE instead of queueing a second one and a duplicate toast.
      var inflight = pendingResetFor(studentId);
      if (needsReset) {
        if (!apiAvailable && !inflight) {
          if (typeof showToast === 'function') {
            showToast('error', WIPE_FAILURE_MESSAGE, { persistent: true });
          }
          return;
        }
        setStatus('Clearing an incomplete enrollment before starting again…', 'warning');
        // Only markWiped() and the success toast after a confirmed DELETE.
        var wiped = inflight ? await inflight : await queueFingerprintReset(studentId, true);
        if (wiped !== true) return;
        state.enrolledFingers = [];
      } else {
        state.enrolledFingers = initialEnrolled;
      }

      // Never start a new enrollment on top of a DELETE that is still running.
      if (inflight && (await inflight) !== true) return;

      stopSession();
      clearSamples();
      state.lastQuality = null;
      state.lastEventName = '';
      state.lastRejectReason = '';
      state.pendingQuality = null;
      state.pendingQualityAt = 0;
      state.sampleBusy = false;
      state.els.student.textContent = state.studentName;

      var firstUpcoming = nextGuidedFinger();
      if (firstUpcoming && !fingerprintComplete()) {
        state.selectedFinger = firstUpcoming.key;
      }

      renderFingerPicker();
      state.els.consent.checked = false;
      state.els.consent.disabled = false;
      setError('');
      if (fingerprintComplete()) {
        setStatus('All 10 fingers are enrolled. Fingerprint attendance is enabled.', 'complete');
      } else {
        var nextFinger = nextGuidedFinger();
        var nextName = fingerDisplayName(nextFinger);
        setStatus('Tick the consent box, then press Start scanning. Please scan your ' + nextName + ' first.');
      }
      updateStartButton();
      updateDebug();
      modal.show();
    } finally {
      state.opening = false;
    }
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
