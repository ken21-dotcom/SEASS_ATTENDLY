/* ============================================================
   Fingerprint enrollment — Admin / SSC Manage Students
   ------------------------------------------------------------
   The "Enroll Fingerprint" button on a student row opens this
   modal and immediately starts a WebUSB capture. The template
   is sent to POST /users/enroll-fingerprint; no image and no
   student name are sent with it.

   Depends on:
     fingerprint-webusb.js  (window.FingerprintScanner)
     api.js                 (api.enrollFingerprint)
     ui.js                  (showToast, refreshGroupedStudentList)
     data.js                (getUsers, setUsers, sameId)
   ============================================================ */

(function (global) {
  'use strict';

  var state = {
    studentId: null,
    studentName: '',
    busy: false,
    modal: null,
    els: null,
  };

  function errorMessage(error) {
    if (!error) return 'The fingerprint could not be enrolled.';
    var code = error.code || '';
    var map = {
      'webusb_unsupported': 'This browser does not support WebUSB. Use Chrome or Edge on localhost or HTTPS.',
      'webusb_insecure': 'WebUSB needs a secure page. Open this dashboard on localhost or HTTPS.',
      'usb_no_device': 'No fingerprint scanner was selected. Plug in the U.are.U 4500 and try again.',
      'usb_permission_denied': 'USB access was blocked. Allow the device in the browser prompt.',
      'usb_open_failed': 'The scanner is busy. Close any other scanner application and retry.',
      'fingerprint_bridge_missing': 'No fingerprint capture bridge is loaded. Add the DigitalPersona WebUSB bundle before scanning.',
      'fingerprint_capture_failed': 'The scanner could not read a fingerprint. Clean the sensor and try again.',
      'fingerprint_already_enrolled': 'This fingerprint is already enrolled to another student.',
      'student_not_found': 'This student record no longer exists.',
      'invalid_field': 'The captured template was rejected. Try the scan again.',
      'network_error': 'The attendance server did not respond. Check the connection and retry.',
    };
    return map[code] || error.message || 'The fingerprint could not be enrolled.';
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
              '<h5 class="modal-title" id="fingerprintEnrollTitle">Enroll fingerprint</h5>' +
              '<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>' +
            '</div>' +
            '<div class="modal-body fingerprint-enroll-body">' +
              '<div class="fingerprint-enroll-visual" aria-hidden="true"><i class="bi bi-fingerprint"></i></div>' +
              '<p class="fingerprint-enroll-student" id="fingerprintEnrollStudent">Student</p>' +
              '<p class="fingerprint-enroll-status" id="fingerprintEnrollStatus" role="status">Starting the scanner…</p>' +
              '<p class="fingerprint-enroll-help">Place the student\'s finger on the U.are.U 4500 sensor. ' +
                'Only the template is sent to the server; the fingerprint image stays on this laptop.</p>' +
              '<p class="fingerprint-enroll-error" id="fingerprintEnrollError" role="alert" hidden></p>' +
            '</div>' +
            '<div class="modal-footer">' +
              '<button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancel</button>' +
              '<button type="button" class="btn btn-success" id="fingerprintEnrollRetry">' +
                '<i class="bi bi-fingerprint"></i> Scan again' +
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
      status: document.getElementById('fingerprintEnrollStatus'),
      error: document.getElementById('fingerprintEnrollError'),
      retry: document.getElementById('fingerprintEnrollRetry'),
    };
    state.els.retry.addEventListener('click', function () {
      scan();
    });
    state.modal = new global.bootstrap.Modal(modalEl);
    return state.modal;
  }

  function setStatus(message) {
    if (!state.els) return;
    state.els.status.textContent = message;
  }

  function setError(message) {
    if (!state.els) return;
    state.els.error.textContent = message || '';
    state.els.error.hidden = !message;
  }

  function markEnrolled(studentId) {
    if (typeof getUsers !== 'function' || typeof setUsers !== 'function') return;
    var users = getUsers().map(function (user) {
      if (!sameId(user.id, studentId)) return user;
      return Object.assign({}, user, { fingerprintEnrolled: true });
    });
    setUsers(users);
    if (typeof refreshGroupedStudentList === 'function') {
      refreshGroupedStudentList();
    }
  }

  async function scan() {
    if (state.busy || !state.studentId) return;

    state.busy = true;
    setError('');
    if (state.els && state.els.retry) state.els.retry.disabled = true;

    try {
      if (!isApiEnabled()) {
        throw new Error('The API is not configured. Set API_BASE_URL before enrolling.');
      }
      if (!global.FingerprintScanner) {
        var missing = new Error('The fingerprint scanner module is not loaded.');
        missing.code = 'fingerprint_bridge_missing';
        throw missing;
      }

      setStatus('Waiting for the scanner. Place the finger on the sensor…');
      var template = await global.FingerprintScanner.captureTemplate();

      setStatus('Fingerprint captured. Saving the template…');
      var result = await api.enrollFingerprint(state.studentId, template);

      markEnrolled(state.studentId);
      if (typeof showToast === 'function') {
        showToast('success', result.message || (state.studentName + ' fingerprint enrolled.'));
      }
      if (state.modal) state.modal.hide();
    } catch (error) {
      setStatus('Enrollment did not finish.');
      setError(errorMessage(error));
      if (typeof showToast === 'function') {
        showToast('error', errorMessage(error));
      }
    } finally {
      state.busy = false;
      if (state.els && state.els.retry) state.els.retry.disabled = false;
    }
  }

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
    state.busy = false;

    var modal = ensureModal();
    if (!modal) {
      if (typeof showToast === 'function') {
        showToast('error', 'The enrollment dialog could not open on this page.');
      }
      return;
    }

    if (state.els) {
      state.els.student.textContent = state.studentName;
      setError('');
      setStatus('Starting the scanner…');
      state.els.retry.disabled = true;
    }
    modal.show();

    // Start synchronously with the click so the browser still treats
    // requestDevice() as a user gesture.
    scan();
  }

  global.enrollStudentFingerprint = enrollStudentFingerprint;
})(window);
