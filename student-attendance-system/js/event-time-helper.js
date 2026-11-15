/* ============================================================
   Event Time Helper
   ------------------------------------------------------------
   Renders and reads the dynamic time inputs inside the Add and
   Edit event modals. The inputs change with the Attendance Type
   dropdown:

     single       one Start Time field (one scan)
     in_out       Time In + Time Out (two scans)
     four_point   AM Time In / AM Time Out / PM Time In / PM Time Out

   Loaded by ssc-manage-events.html and admin-manage-events.html
   after api.js, so it is independent of that file.
   ============================================================ */

(function (window) {
  'use strict';

  // Field definitions per attendance type. The Add modal uses the
  // `event*` ids; the Edit modal uses `editEvent*` ids so the existing
  // editEvent() populate code can still find the single Start Time field.
  var TEMPLATES = {
    add: {
      single: [
        { id: 'eventTime',        label: 'Start Time' },
      ],
      in_out: [
        { id: 'eventTimeIn',      label: 'Time In' },
        { id: 'eventTimeOut',     label: 'Time Out' },
      ],
      four_point: [
        { id: 'eventAmTimeIn',    label: 'AM Time In' },
        { id: 'eventAmTimeOut',   label: 'AM Time Out' },
        { id: 'eventPmTimeIn',    label: 'PM Time In' },
        { id: 'eventPmTimeOut',   label: 'PM Time Out' },
      ],
    },
    edit: {
      single: [
        { id: 'editEventTime',        label: 'Start Time' },
      ],
      in_out: [
        { id: 'editEventTimeIn',      label: 'Time In' },
        { id: 'editEventTimeOut',     label: 'Time Out' },
      ],
      four_point: [
        { id: 'editEventAmTimeIn',    label: 'AM Time In' },
        { id: 'editEventAmTimeOut',   label: 'AM Time Out' },
        { id: 'editEventPmTimeIn',    label: 'PM Time In' },
        { id: 'editEventPmTimeOut',   label: 'PM Time Out' },
      ],
    },
  };

  var DEFAULT_TYPE = 'single';

  function isEditContainer(container) {
    return !!(container && container.id === 'editDynamicTimeInputs');
  }

  function templateFor(container, type) {
    var key = isEditContainer(container) ? 'edit' : 'add';
    var set = TEMPLATES[key];
    return (set && set[type]) || (set && set[DEFAULT_TYPE]);
  }

  /**
   * Canonical 'HH:MM' from a time input, or false when blank/invalid.
   * @param {HTMLInputElement} input
   * @returns {string|boolean}
   */
  function readTimeValue(input) {
    if (!input) return false;
    var v = String(input.value || '').trim();
    if (!v || !/^\d{1,2}:\d{2}$/.test(v)) return false;
    var m = /^(\d{1,2}):(\d{2})$/.exec(v);
    var h = Number(m[1]);
    var mn = Number(m[2]);
    if (h > 23 || mn > 59) return false;
    return String(h).padStart(2, '0') + ':' + String(mn).padStart(2, '0');
  }

  /**
   * Replace the time inputs inside the container with the fields that
   * match the chosen attendance type. Existing values are dropped; the
   * caller repopulates the new fields when reopening an edit.
   *
   * @param {HTMLDivElement} container  #dynamicTimeInputs or #editDynamicTimeInputs
   * @param {string}         type       'single' | 'in_out' | 'four_point'
   */
  function renderDynamicTimeInputs(container, type) {
    if (!container) return;
    var fields = templateFor(container, type);
    if (!fields) return;

    var html = fields.map(function (field) {
      return '<div class="time-input">' +
        '<label for="' + field.id + '" class="form-label mb-1">' + field.label + '</label>' +
        '<input type="time" class="form-control" id="' + field.id + '">' +
        '</div>';
    }).join('');

    container.innerHTML = html;
  }

  /**
   * Read the times the user entered through the dynamic container and
   * map them to the backend's startTime / endTime fields.
   *
   *   single       start = end = the single Start Time value (one scan)
   *   in_out       start = Time In,  end = Time Out
   *   four_point   start = AM Time In, end = PM Time Out (the kiosk
   *                handles the four-scan window internally from this)
   *
   * @param {HTMLDivElement} container
   * @param {string}         type
   * @returns {{startTime: string|boolean, endTime: string|boolean}}
   */
  function readDynamicTimeInputs(container, type) {
    if (!container) return { startTime: false, endTime: false };

    var inputs = container.querySelectorAll('input[type="time"]');
    var fields = Array.prototype.map.call(inputs, readTimeValue);
    var startTime = false;
    var endTime = false;

    if (type === 'single') {
      startTime = fields[0];
      endTime = startTime;
    } else if (type === 'in_out') {
      startTime = fields[0];
      endTime = fields[1];
    } else if (type === 'four_point') {
      startTime = fields[0];
      endTime = fields[3];
    }

    return { startTime: startTime, endTime: endTime };
  }

  window.EventTimeHelper = {
    renderDynamicTimeInputs: renderDynamicTimeInputs,
    readDynamicTimeInputs: readDynamicTimeInputs,
  };
})(window);