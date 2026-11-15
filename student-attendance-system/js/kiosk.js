/* ============================================================
   Kiosk — officer-operated fingerprint event check-in
   ------------------------------------------------------------
   The station is locked until an SSC officer or administrator
   signs in. After unlock it hydrates events, students, attendance
   and roster metadata from the server, then reads a fingerprint
   sample from the DigitalPersona U.are.U 4500 through the HID
   DigitalPersona Web SDK and its local agent.

   State machine: locked → idle → scanning → (success | error) → idle

   Acquisition is persistent: the kiosk keeps one scanner session
   running from the moment the officer opens an event until the event
   ends. Each time a finger is placed the SDK fires SamplesAcquired; the
   kiosk sends the captured template to the server, shows the result for
   a few seconds, then returns to "Place your finger" without stopping
   the scanner. A short cooldown ignores a second placement immediately
   after a scan so one placement cannot register twice.

   The Web SDK pauses scanning when the page loses focus. The kiosk
   restarts acquisition on window focus, visibilitychange, the
   AcquisitionStopped event, and DeviceConnected after a
   DeviceDisconnected. A watchdog retries startAcquisition for a few
   seconds if it stops unexpectedly, then reports an error.

   The raw sample is never stored, displayed, or logged — only its size
   and format leave the page. Matching happens server-side.

   Security: all user-supplied strings are escaped via escapeHtml()
   before being injected into innerHTML.
   ============================================================ */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // Kiosk UI element references
  let els = {};
  let currentEventId = null;
  let busy = false; // true while a scan is in flight — blocks input
  let unlocked = false;
  let viewer = null;
  let idleTimer = null;
  let stationHeartbeatTimer = null;
  let fingerprintReader = null;
  let fingerprintFocusGuard = null;
  let fingerprintAcquisitionActive = false; // true while startAcquisition is running
  let fingerprintWatchdogTimer = null;
  let fingerprintWatchdogAttempts = 0;
  const FINGERPRINT_WATCHDOG_MAX_ATTEMPTS = 4;
  const FINGERPRINT_WATCHDOG_INTERVAL_MS = 2500;
  const FINGERPRINT_RESULT_HOLD_MS = 3000;
  const FINGERPRINT_COOLDOWN_MS = 1500; // ignore a placement right after a scan
  let fingerprintCooldownTimer = null;
  let fingerprintResultTimer = null; // holds a scan result on screen between samples
  let fingerprintHandlersBound = false; // the reader's session handlers are registered once
  let fingerprintSessionStarting = false; // a session start is in flight
  // Auto-start is attempted once per event + scan mode; the Scan Fingerprint
  // button is the manual retry when it fails.
  const fingerprintAutoStartAttempts = new Set();
  let fingerprintWakeLock = null;
  let fingerprintSessionActive = false; // true while an event is open and scanning is live
  let scanMode = 'in'; // 'in' = check-in, 'out' = check-out
  let CHECKIN_EARLY_MS = 30 * 60 * 1000;
  let CHECKIN_WINDOW_MS = 6 * 60 * 60 * 1000;
  let CHECKOUT_OPEN_MINUTES = 60;  // fallback when an event omits the offset
  let CHECKOUT_CLOSE_MINUTES = 60;
  const AUTO_LOCK_MS = 5 * 60 * 1000; // five minutes of inactivity
  const API_REQUIRED_MESSAGE =
    'Kiosk requires the API. Set API_BASE_URL in js/api.js to the local PHP endpoint ' +
    '(e.g. http://localhost:8000/api), then reload this page.';

  // Event ids are strings locally and numbers after API hydration, while
  // <select> values are always strings. Compare by text, then keep the
  // canonical id from the event object.
  const sameId = (a, b) => a != null && b != null && String(a) === String(b);

  const isOfficerRole = (role) => role === 'admin' || role === 'ssc-officer';

  const actionWord = (mode) => (mode === 'out' ? 'check-out' : 'check-in');
  const actionTitle = (mode) => (mode === 'out' ? 'Check-out' : 'Check-in');

  function checkoutWindow(event) {
    const start = parseEventDateTime(event.date, event.time);
    const hasEnd = typeof event.endTime === 'string' && event.endTime !== '';
    let end = hasEnd ? parseEventDateTime(event.date, event.endTime) : start;
    // An end time earlier than the start time runs past midnight.
    if (hasEnd && end.getTime() <= start.getTime()) {
      end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
    }
    const openValue = Number(event.checkoutOpenMinutes);
    const closeValue = Number(event.checkoutCloseMinutes);
    const open = Number.isFinite(openValue) && event.checkoutOpenMinutes != null
      ? Math.max(0, openValue)
      : CHECKOUT_OPEN_MINUTES;
    const close = Number.isFinite(closeValue) && event.checkoutCloseMinutes != null
      ? Math.max(0, closeValue)
      : CHECKOUT_CLOSE_MINUTES;
    return {
      opensAt: end.getTime() - open * 60 * 1000,
      closesAt: end.getTime() + close * 60 * 1000,
    };
  }

  function initials(name) {
    return String(name || 'Officer')
      .trim()
      .split(/\s+/)
      .map((part) => part[0])
      .slice(0, 2)
      .join('')
      .toUpperCase() || 'OF';
  }

  // ── Lock / unlock ──────────────────────────────────────────────
  function setLockMessage(message) {
    if (!els.lockError) return;
    els.lockError.textContent = message || '';
    els.lockError.hidden = !message;
  }

  function setLockBusy(isBusy) {
    if (els.lockForm) els.lockForm.setAttribute('aria-busy', String(isBusy));
    if (els.lockEmail) els.lockEmail.disabled = isBusy;
    if (els.lockPassword) els.lockPassword.disabled = isBusy;
    if (els.lockSubmit) {
      els.lockSubmit.disabled = isBusy;
      els.lockSubmit.innerHTML = isBusy
        ? '<i class="bi bi-hourglass-split"></i> Unlocking…'
        : '<i class="bi bi-unlock"></i> Unlock station';
    }
  }

  function resetIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (!unlocked) return;
    idleTimer = setTimeout(function () {
      // A slow finger read must not lock the station out from under the
      // operator while the scanner is still waiting for a sample.
      if (busy) {
        resetIdleTimer();
        return;
      }
      lockStation('Station locked after five minutes of inactivity.', { endSession: true });
    }, AUTO_LOCK_MS);
  }

  /**
   * Steps are gated: only the active step is highlighted and every step
   * after it is visually disabled until its precondition is met. The kiosk
   * starts on Step 1 (select an event) and only advances to Step 2 once the
   * selected event actually accepts scans.
   */
  function setStepState(activeStep) {
    const steps = els.steps || [];
    const active = Math.min(3, Math.max(1, Number(activeStep) || 1));
    Array.prototype.forEach.call(steps, function (step, index) {
      const stepNumber = index + 1;
      const isCurrent = stepNumber === active;
      const isDisabled = stepNumber > active;
      step.classList.toggle('is-current', isCurrent);
      step.classList.toggle('is-disabled', isDisabled);
      if (isCurrent) step.setAttribute('aria-current', 'step');
      else step.removeAttribute('aria-current');
      if (isDisabled) step.setAttribute('aria-disabled', 'true');
      else step.removeAttribute('aria-disabled');
      // kiosk.css has no .is-disabled rule, so grey the locked steps inline.
      step.style.opacity = isCurrent ? '1' : (isDisabled ? '.42' : '.78');
      step.style.filter = isDisabled ? 'grayscale(1)' : '';
    });
  }

  function showLock(message) {
    unlocked = false;
    viewer = null;
    currentEventId = null;
    busy = false;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (stationHeartbeatTimer) {
      clearInterval(stationHeartbeatTimer);
      stationHeartbeatTimer = null;
    }

    stopFingerprintSession();
    // A fresh officer session may attempt the automatic start again.
    fingerprintAutoStartAttempts.clear();

    if (els.resultOverlay) els.resultOverlay.hidden = true;
    if (els.operator) els.operator.hidden = true;
    if (els.lock) els.lock.hidden = false;
    setLockMessage(message || '');
    setLockBusy(false);

    // Clear the previous officer's hydrated view so it cannot flash for
    // the next person who walks up to the station.
    setEvents([]);
    setUsers([]);
    setAttendance([]);
    scanMode = 'in';
    syncModeButtons();
    setModeButtonsEnabled(false);
    if (els.event) els.event.innerHTML = '<option value="">Station locked</option>';
    if (els.eventName) els.eventName.textContent = 'Station locked';
    if (els.eventMeta) els.eventMeta.textContent = 'Sign in to choose an event and start recording attendance.';
    if (els.statusChip) {
      els.statusChip.textContent = 'Locked';
      els.statusChip.className = 'kiosk-status-badge is-closed';
    }
    hideCountdown();
    setScanAvailability(false, 'Station locked', 'Sign in to unlock the fingerprint scanner.');
    setStatus('idle', 'Station locked', 'Sign in to unlock the scanner.');
    setStationState(false, 'Station locked');
    setStepState(1);

    setTimeout(function () {
      if (els.lockEmail) els.lockEmail.focus();
    }, 50);
  }

  function unlockUi(user) {
    viewer = user;
    unlocked = true;
    setSession(user);
    setLockMessage('');
    if (els.lock) els.lock.hidden = true;
    if (els.lockPassword) els.lockPassword.value = '';
    if (els.operator) els.operator.hidden = false;
    if (els.operatorName) els.operatorName.textContent = user.name || user.email || 'Officer';
    if (els.operatorAvatar) els.operatorAvatar.textContent = initials(user.name || user.email);
    setModeButtonsEnabled(true);
    syncModeButtons();
    setStepState(1);
    setStationState(true, 'Scanner ready');
    setStatus('idle', 'Select an event', 'Choose an event to enable the fingerprint scanner.');
    resetIdleTimer();
    startStationHeartbeat();
  }

  function startStationHeartbeat() {
    const stationId = new URLSearchParams(window.location.search).get('station');
    if (!stationId || !/^\d+$/.test(stationId)) return;
    const sendHeartbeat = () => {
      if (!unlocked) return;
      api.heartbeatStation(stationId).catch(() => {});
    };
    sendHeartbeat();
    if (stationHeartbeatTimer) clearInterval(stationHeartbeatTimer);
    stationHeartbeatTimer = setInterval(sendHeartbeat, 60000);
  }

  function lockStation(message, options) {
    const opts = options || {};
    showLock(message);
    if (opts.endSession && isApiEnabled()) {
      // Best effort: the UI is already locked even if the server is down.
      api.logout().catch(function () {});
    }
  }

  async function signIn(rawEmail, password) {
    if (!isApiEnabled()) {
      setLockMessage(API_REQUIRED_MESSAGE);
      return;
    }

    setLockBusy(true);
    setLockMessage('');

    try {
      const user = await api.login(String(rawEmail || '').trim(), password);

      if (!isOfficerRole(user.role)) {
        await api.logout().catch(function () {});
        setLockMessage('Only SSC officers and administrators can unlock this station.');
        return;
      }
      if (user.mustChangePassword === true) {
        await api.logout().catch(function () {});
        setLockMessage('Change your temporary password in the dashboard before using this station.');
        return;
      }

      await startStation(user);
    } catch (err) {
      if (unlocked) {
        lockStation('Station locked. Sign in to resume.', { endSession: true });
      }
      setLockMessage(err && err.message ? err.message : 'Could not unlock the station. Try again.');
    } finally {
      setLockBusy(false);
      if (unlocked) setLockMessage('');
    }
  }

  async function restoreSession() {
    try {
      const result = await api.me();
      const user = result && Object.prototype.hasOwnProperty.call(result, 'user')
        ? result.user
        : result;

      if (user && isOfficerRole(user.role) && user.mustChangePassword !== true) {
        await startStation(user);
        return;
      }

      if (user) await api.logout().catch(function () {});
      showLock(user && user.role === 'student'
        ? 'Only SSC officers and administrators can unlock this station.'
        : user && user.mustChangePassword === true
          ? 'Change your temporary password in the dashboard before using this station.'
          : '');
    } catch (err) {
      showLock(err && err.code === 'network_error'
        ? 'Cannot reach the attendance server. Check the backend and try again.'
        : 'Sign in to unlock this check-in station.');
    }
  }

  // ── Server hydration ──────────────────────────────────────────
  async function hydrateKioskData() {
    // Sequential: these share one PHP session, and a 401 mid-run should
    // surface as one clean lock instead of three competing failures.
    setEvents(await api.listEvents());
    setUsers(await api.listUsers());
    setAttendance(await api.listAttendance());
  }

  async function loadHealthSettings() {
    try {
      const settings = await request('/health', { anonymous: true });
      if (Number.isFinite(settings.checkinOpenMinutesBefore)) {
        CHECKIN_EARLY_MS = Math.max(0, settings.checkinOpenMinutesBefore) * 60 * 1000;
      }
      if (Number.isFinite(settings.checkinCloseMinutesAfter)) {
        CHECKIN_WINDOW_MS = Math.max(0, settings.checkinCloseMinutesAfter) * 60 * 1000;
      }
      if (Number.isFinite(settings.checkoutOpenMinutesBeforeEnd)) {
        CHECKOUT_OPEN_MINUTES = Math.max(0, settings.checkoutOpenMinutesBeforeEnd);
      }
      if (Number.isFinite(settings.checkoutCloseMinutesAfterEnd)) {
        CHECKOUT_CLOSE_MINUTES = Math.max(0, settings.checkoutCloseMinutesAfterEnd);
      }
    } catch {
      // Keep the documented defaults when the health probe fails.
    }
  }

  async function startStation(user) {
    unlockUi(user);
    try {
      await hydrateKioskData();
      await loadHealthSettings();
      loadKioskEvents();
    } catch (err) {
      lockStation('Could not load station data. Sign in again.', { endSession: true });
      throw err;
    }
  }

  // ── Event loading ──
  function loadKioskEvents() {
    const events = (getEvents() || []).filter((e) => (e.status || 'scheduled') !== 'cancelled');
    const select = els.event;
    select.innerHTML = events.length
      ? '<option value="">Select an event</option>' + events.map((event) =>
          `<option value="${escapeHtml(event.id)}">${escapeHtml(event.name)} · ${formatDate(event.date)} · ${escapeHtml(event.time)}${event.endTime ? '–' + escapeHtml(event.endTime) : ''}</option>`
        ).join('')
      : '<option value="">No events available</option>';

    // Never auto-select an event: the officer must choose one before the
    // scanner is allowed to accept fingerprints. Keep a previous choice only
    // if it still exists in the refreshed list.
    const previous = events.find((e) => sameId(e.id, currentEventId));
    currentEventId = previous ? previous.id : null;
    select.value = currentEventId != null ? String(currentEventId) : '';

    syncModeButtons();
    renderEventHeader();
    updateCounts();
    renderTicker();
  }

  function renderEventHeader() {
    const event = getEvents().find((e) => sameId(e.id, currentEventId));
    if (!event) {
      els.eventName.textContent = 'Select an event to begin';
      els.eventMeta.textContent = 'Choose an event above to start scanning.';
      els.statusChip.textContent = 'No event';
      els.statusChip.className = 'kiosk-status-badge is-closed';
      stopFingerprintSession();
      hideCountdown();
      setStatus('idle', 'Select an event', 'Choose an event above to enable the fingerprint scanner.');
      if (!busy) {
        setScanAvailability(false, 'Select an event', 'Choose an active event first.');
        setStepState(1);
      }
      return;
    }

    const phase = getEventPhase(event, scanMode);
    const modeTitle = actionTitle(scanMode);
    const modeWord = actionWord(scanMode);
    els.eventName.textContent = event.name;

    const parts = [];
    parts.push(`${formatDate(event.date)} · ${event.time}${event.endTime ? '–' + event.endTime : ''}`);
    if (event.location) parts.push(event.location);
    if (event.mandatory) parts.push('Mandatory');
    else parts.push('Optional');
    els.eventMeta.textContent = parts.join(' · ');

    const statusChip = els.statusChip;
    statusChip.className = 'kiosk-status-badge is-' + phase;
    statusChip.textContent = phase === 'live' ? `${modeTitle} open`
      : phase === 'upcoming' ? `${modeTitle} soon`
      : phase === 'cancelled' ? 'Cancelled'
      : `${modeTitle} closed`;

    if (!busy) {
      const overlayOpen = els.resultOverlay && !els.resultOverlay.hidden;
      if (overlayOpen) {
        // Keep the scanner disabled while a result is on screen. The Done
        // button clears the overlay and re-runs this renderer.
        els.scanBtn.disabled = true;
        setStepState(3);
      } else if (phase === 'live') {
        setScanAvailability(
          true,
          fingerprintSessionActive ? 'Scanner active' : 'Scan Fingerprint',
          fingerprintSessionActive
            ? 'Place your finger on the sensor; the reader stays on until the event ends.'
            : 'Tap to wake the scanner, then rest your finger on the sensor.'
        );
        setStepState(2);
        if (fingerprintSessionActive) {
          setStatus(
            'scanning',
            'Place your finger',
            'Rest your finger on the U.are.U 4500 sensor.'
          );
        } else {
          setStatus(
            'idle',
            `Ready for ${modeWord}`,
            'Tap Scan Fingerprint, then rest your finger on the sensor.'
          );
        }
        // An event that just became live opens the scanner without a tap;
        // the button only needs pressing if that automatic start fails.
        maybeAutoStartFingerprintSession();
      } else {
        stopFingerprintSession();
        setScanAvailability(
          false,
          phase === 'upcoming' ? `${modeTitle} opens soon` : `${modeTitle} unavailable`,
          phase === 'upcoming'
            ? `This station will unlock when ${modeWord} opens.`
            : 'Choose another active event or scan mode.'
        );
        setStepState(1);
        setStatus(
          'idle',
          phase === 'upcoming' ? `${modeTitle} not open yet` : `${modeTitle} unavailable`,
          phase === 'upcoming' ? `This station will unlock when ${modeWord} opens.`
            : 'Choose another active event or scan mode.'
        );
      }
    }
    renderCountdown(event, phase);
  }

  // ── Live countdown (updates every 20s) ──
  function hideCountdown() {
    els.countdown.hidden = true;
    els.countdown.innerHTML = '';
  }

  function getEventPhase(event, mode) {
    const action = mode === 'out' ? 'out' : 'in';
    if (!event || event.status === 'cancelled') return 'cancelled';
    if (event.status === 'completed') return 'closed';
    const now = new Date();
    if (action === 'out') {
      const { opensAt, closesAt } = checkoutWindow(event);
      if (now.getTime() < opensAt) return 'upcoming';
      if (now.getTime() > closesAt) return 'closed';
      return 'live';
    }
    const start = parseEventDateTime(event.date, event.time);
    if (now.getTime() < start.getTime() - CHECKIN_EARLY_MS) return 'upcoming';
    if (now.getTime() > start.getTime() + CHECKIN_WINDOW_MS) return 'closed';
    return 'live';
  }

  function setScanAvailability(enabled, title, detail) {
    const usable = enabled === true && unlocked === true;
    els.scanBtn.disabled = !usable;
    els.scanBtn.classList.toggle('is-inactive', !usable);
    els.scanBtn.setAttribute('aria-label', title);
    if (els.scanCtaTitle) els.scanCtaTitle.textContent = title;
    if (els.scanCtaDetail) els.scanCtaDetail.textContent = detail;
    if (els.manualInput) els.manualInput.disabled = !usable;
    if (els.manualSubmit) els.manualSubmit.disabled = !usable;
  }

  function syncModeButtons() {
    [[els.modeIn, 'in'], [els.modeOut, 'out']].forEach(([button, mode]) => {
      if (!button) return;
      const active = scanMode === mode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function setModeButtonsEnabled(enabled) {
    [els.modeIn, els.modeOut].forEach((button) => {
      if (button) button.disabled = !enabled;
    });
  }

  /** Switch the station between recording arrivals and departures. */
  function setScanMode(mode) {
    if (busy) return;
    scanMode = mode === 'out' ? 'out' : 'in';
    syncModeButtons();
    if (unlocked) {
      renderEventHeader();
      resetIdleTimer();
    }
  }

  function renderCountdown(event, phase) {
    const el = els.countdown;
    el.hidden = false;
    el.dataset.phase = phase;
    const now = new Date();
    const modeTitle = actionTitle(scanMode);
    const start = parseEventDateTime(event.date, event.time);
    const window = scanMode === 'out' ? checkoutWindow(event) : null;

    if (phase === 'cancelled') {
      el.innerHTML = '<i class="bi bi-x-circle"></i> This event has been cancelled';
    } else if (phase === 'closed') {
      el.innerHTML = `<i class="bi bi-lock"></i> ${modeTitle} window has closed`;
    } else if (phase === 'upcoming') {
      const opensAt = window ? window.opensAt : start.getTime() - CHECKIN_EARLY_MS;
      const diff = Math.max(0, opensAt - now.getTime());
      const days = Math.ceil(diff / 86400000);
      const label = diff > 86400000 ? (days + (days === 1 ? ' day' : ' days')) : formatCountdown(diff);
      el.innerHTML = `<i class="bi bi-hourglass-split"></i> ${modeTitle} opens in ${label}`;
    } else {
      const closesAt = window ? window.closesAt : start.getTime() + CHECKIN_WINDOW_MS;
      const remaining = closesAt - now.getTime();
      el.innerHTML = `<i class="bi bi-broadcast"></i> ${modeTitle} open now · closes in ${formatCountdown(remaining)}`;
    }
  }

  /** "HH:MM" (local) + "YYYY-MM-DD" -> Date */
  function parseEventDateTime(dateStr, timeStr) {
    const d = new Date(dateStr + 'T' + timeStr);
    return isNaN(d.getTime()) ? new Date() : d;
  }

  function formatCountdown(ms) {
    const mins = Math.max(1, Math.round(ms / 60000));
    if (mins < 60) return `${mins} min`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  // ── Live counts — checked-in / enrolled / attendance % ──
  function updateCounts() {
    const attendance = getAttendance();
    const checkedIn = currentEventId
      ? attendance.filter((a) => sameId(a.eventId, currentEventId) && (a.status === 'present' || a.status === 'late')).length
      : 0;

    els.count.textContent = checkedIn;

    // Every active student can scan a fingerprint, so the roster count is
    // the number of active student accounts returned by the server.
    const roster = (getUsers() || []).filter((u) =>
      u.role === 'student' && (u.status === undefined || u.status === 'active')
    ).length;
    els.listCount.textContent = roster;

    // Attendance % = checked-in / active students (manual entries can
    // exceed the roster count, so cap the display at 100%).
    const denom = roster || 1;
    els.attendancePct.textContent = Math.min(100, Math.round((checkedIn / denom) * 100)) + '%';
  }

  // ── Recent attendance ticker (last N successful scans for this event) ──
  const TICKER_MAX = 4;

  function renderTicker() {
    if (!els.ticker) return;
    const attendance = getAttendance();
    const recent = currentEventId
      ? attendance.filter((a) => sameId(a.eventId, currentEventId) && (a.status === 'present' || a.status === 'late'))
      : [];
    // Seed data may have no time; newest first.
    const sorted = recent.slice().sort((a, b) => (b.time || '').localeCompare(a.time || ''));
    const latest = sorted.slice(0, TICKER_MAX);

    if (!latest.length) {
      els.ticker.hidden = true;
      return;
    }
    els.ticker.hidden = false;

    const users = getUsers();
    els.tickerList.innerHTML = latest.map((a) => {
      const student = users.find((u) => String(u.id) === String(a.studentId));
      const name = a.studentName || (student ? student.name : 'Student');
      const initialsText = name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
      const firstName = name.split(' ')[0];
      const wentOut = a.checkedOut === true;
      return (
        `<div class="kiosk-ticker-item">` +
          `<span class="kiosk-ticker-avatar">${escapeHtml(initialsText)}</span>` +
          `<span class="kiosk-ticker-info">` +
            `<span class="kiosk-ticker-name">${escapeHtml(firstName)} checked ${wentOut ? 'out' : 'in'}</span>` +
            `<span class="kiosk-ticker-time">${escapeHtml(wentOut ? (a.checkOutTimeLabel || a.time) : (a.time || 'now'))}</span>` +
          `</span>` +
          `<i class="bi bi-check-circle-fill kiosk-ticker-check" aria-hidden="true"></i>` +
        `</div>`
      );
    }).join('');
  }

  // ── Status rendering — drives the kiosk scan panel ──
  function setStatus(state, text, hint, stateLabelText) {
    const scanner = els.scanner;
    scanner.dataset.state = state;
    scanner.setAttribute('aria-busy', String(state === 'scanning' || state === 'processing'));
    if (text !== undefined) els.statusText.textContent = text;
    if (hint !== undefined) els.scanHint.textContent = hint;

    // Reflect the same state in the sensor's little status pill and the
    // station chip so the screen reads the same from across the room.
    // A caller can override the label for states whose meaning differs
    // (for example a captured sample that was not saved as attendance).
    const stateLabel = stateLabelText || {
      idle: 'Scanner ready',
      scanning: 'Reading fingerprint',
      processing: 'Verifying identity',
      success: 'Attendance saved',
      attention: 'Check the sensor',
      error: 'Scan failed',
    }[state] || 'Scanner ready';
    if (els.fingerprintState) els.fingerprintState.textContent = stateLabel;
    if (els.stationState && unlocked) {
      els.stationState.textContent = state === 'idle' ? 'Scanner ready' : stateLabel;
    }
  }

  /**
   * Append the server's attendance row to the local cache used by the
   * counters and ticker. The server row is authoritative; we only add
   * presentation flags the reports expect.
   */
  function addServerRecord(record, eventId) {
    const attendance = getAttendance().filter((a) =>
      !(sameId(a.eventId, eventId) && String(a.studentId) === String(record.studentId))
    );
    attendance.push(Object.assign({ excused: false, excuseReason: '' }, record, {
      eventId: eventId,
      method: record.verificationMethod || 'fingerprint',
    }));
    setAttendance(attendance);
    updateCounts();
    renderTicker();
  }

  function isSessionError(err) {
    if (!err) return false;
    return err.status === 401 ||
      err.status === 403 ||
      err.code === 'unauthenticated' ||
      err.code === 'forbidden' ||
      err.code === 'password_change_required';
  }

  // ── Result overlay (success / error) ──
  const RESULT_ICONS = {
    success:            'check-circle-fill',
    'already':          'exclamation-triangle-fill',
    'no-match':         'fingerprint',
    'no-event':         'info-circle-fill',
    'permission-denied': 'shield-lock-fill',
    'device-error':     'usb-drive-fill',
    'model-error':      'exclamation-triangle-fill',
    'server-error':     'x-circle-fill',
    'invalid-field':    'fingerprint',
  };

  function showResult(type, title, message, meta) {
    // Set the state class on the wrapper (drives gradient disc colors)
    // and a stable icon class on the inner <i> (drives glyph + white text).
    const wrap = els.resultIconWrap || els.resultIcon.parentElement;
    wrap.className = `kiosk-result-icon-wrap is-${type}`;
    els.resultIcon.className = `bi bi-${RESULT_ICONS[type] || 'info-circle-fill'} kiosk-result-icon`;
    els.resultTitle.textContent = title;
    els.resultMessage.textContent = message;
    // meta is controlled HTML from our code — safe to use innerHTML
    els.resultMeta.innerHTML = meta || '';
    els.resultOverlay.hidden = false;
    els.scanBtn.disabled = true;
    els.resultDone.focus();
  }

  // ── Scanner station indicator ──
  function setStationState(online, label) {
    if (els.stationState) els.stationState.textContent = label;
    if (els.stationDot) els.stationDot.classList.toggle('is-offline', !online);
  }

  /**
   * Error copy for the fingerprint capture path and the attendance endpoint.
   * The shape is [result type, title, message, hint].
   */
  const FINGERPRINT_ERRORS = {
    'sdk_missing': [
      'model-error',
      'Scanner module missing',
      'The DigitalPersona Web SDK did not load on this station.',
      'Reload the kiosk. If it still fails, check the SDK script files.',
    ],
    'scanner_not_found': [
      'device-error',
      'Scanner not found',
      'The DigitalPersona agent did not report a fingerprint reader.',
      'Plug in the U.are.U 4500, make sure the agent is running, then retry.',
    ],
    'scanner_unavailable': [
      'device-error',
      'Scanner unavailable',
      'The DigitalPersona agent could not start the fingerprint reader.',
      'Check that the HID agent is running and no other scanner app is open, then retry.',
    ],
    'scanner_disconnected': [
      'device-error',
      'Scanner disconnected',
      'The fingerprint reader was disconnected during the scan.',
      'Reconnect the U.are.U 4500, then try again.',
    ],
    'fingerprint_capture_failed': [
      'no-match',
      'Fingerprint not captured',
      'The scanner could not read a fingerprint. Clean the sensor and place your finger flat.',
      'Keep your finger on the sensor until the scanner beeps, then try again.',
    ],
    'fingerprint_not_recognized': [
      'no-match',
      'Fingerprint not recognised',
      'This fingerprint is not enrolled to an active student.',
      'Ask the SSC officer to enroll your fingerprint, or use manual entry.',
    ],
    'fingerprint_already_enrolled': [
      'already',
      'Fingerprint already enrolled',
      'This fingerprint is already linked to another student.',
      'Ask the SSC officer to check the enrollment.',
    ],
    'invalid_field': [
      'invalid-field',
      'Scan rejected',
      'The fingerprint template could not be verified by the server.',
      'Try the scan again. If it keeps failing, ask the SSC officer for help.',
    ],
    'rate_limited': [
      'server-error',
      'Please wait',
      'Too many scans were sent at once.',
      'Try again in a moment.',
    ],
    'network_error': [
      'server-error',
      'Server unreachable',
      'The attendance server did not respond.',
      'Check the connection and try again, or use manual entry.',
    ],
    'duplicate_checkin': [
      'already',
      'Already checked in',
      'This student is already checked in for this event.',
      'No action needed.',
    ],
    'duplicate_checkout': [
      'already',
      'Already checked out',
      'This student has already checked out for this event.',
      'No action needed.',
    ],
    'not_checked_in': [
      'already',
      'Not checked in',
      'This student has no check-in for this event, so there is nothing to check out.',
      'Scan for check-in first.',
    ],
    'checkin_closed': [
      'no-event',
      'Check-in closed',
      'This event is outside its check-in window.',
      'Choose another event or scan mode, or ask the SSC officer.',
    ],
    'checkout_closed': [
      'no-event',
      'Check-out closed',
      'This event is outside its check-out window.',
      'Choose another event or scan mode, or ask the SSC officer.',
    ],
    'event_unavailable': [
      'no-event',
      'Attendance unavailable',
      'This event is not accepting attendance right now.',
      'Choose another event or ask the SSC officer.',
    ],
    'event_not_found': [
      'no-event',
      'Event not found',
      'The selected event no longer exists.',
      'Refresh the event list and choose another event.',
    ],
    'not_eligible': [
      'no-event',
      'Not eligible',
      'This event is not open to the student’s department.',
      'Choose another event or ask the SSC officer.',
    ],
    'invalid_action': [
      'no-event',
      'Scan not allowed',
      'This event does not use that scan point yet.',
      'Check the event instructions or ask the SSC officer.',
    ],
  };

  // ── Fingerprint capture (DigitalPersona Web SDK, capture-only) ──

  function fingerprintError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }

  function fingerprintSdkReady() {
    return Boolean(
      window.WebSdk &&
      typeof window.WebSdk.WebChannelOptions === 'function' &&
      window.dp &&
      window.dp.devices &&
      typeof window.dp.devices.FingerprintReader === 'function' &&
      window.dp.devices.SampleFormat &&
      window.dp.devices.SampleFormat.PngImage != null
    );
  }

  function createFingerprintReader() {
    if (fingerprintReader) return fingerprintReader;
    const options = new window.WebSdk.WebChannelOptions({ debug: false });
    fingerprintReader = new window.dp.devices.FingerprintReader(options);
    return fingerprintReader;
  }

  // The Web SDK pauses scanning when the page loses focus. Hold the page
  // focused for the short capture window, then release these listeners.
  function startFingerprintFocusGuard() {
    if (fingerprintFocusGuard) return;
    const refocus = () => {
      if (!fingerprintFocusGuard) return;
      try {
        window.focus();
      } catch (error) {
        // Focus is best effort; the status hint asks the operator to click back in.
      }
    };
    const onVisibilityChange = () => {
      if (!document.hidden) refocus();
    };
    fingerprintFocusGuard = {
      refocus: refocus,
      onVisibilityChange: onVisibilityChange,
      timer: setInterval(refocus, 1000),
    };
    window.addEventListener('blur', refocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    refocus();
  }

  function stopFingerprintFocusGuard() {
    if (!fingerprintFocusGuard) return;
    clearInterval(fingerprintFocusGuard.timer);
    window.removeEventListener('blur', fingerprintFocusGuard.refocus);
    document.removeEventListener('visibilitychange', fingerprintFocusGuard.onVisibilityChange);
    fingerprintFocusGuard = null;
  }

  function fingerprintSampleSize(sample) {
    const data = sample && sample.Data;
    if (typeof data === 'string') return data.length;
    if (data && typeof data.length === 'number') return data.length;
    if (data && typeof data.byteLength === 'number') return data.byteLength;
    return 0;
  }

  function fingerprintSampleFormatName(value) {
    const formats = window.dp && window.dp.devices ? window.dp.devices.SampleFormat : null;
    return formats && formats[value] ? formats[value] : String(value);
  }

  function stopFingerprintAcquisition(reader) {
    fingerprintAcquisitionActive = false;
    try {
      const stopping = reader.stopAcquisition();
      if (stopping && typeof stopping.catch === 'function') {
        stopping.catch(() => {});
      }
    } catch (error) {
      // Acquisition may never have started; nothing else to do.
    }
  }

  // ── Persistent acquisition (one session per open event) ──────────

  /**
   * Request a Screen Wake Lock so the browser does not dim or lock the
   * screen while the station is staffed. Fail quietly — some browsers and
   * some contexts do not support it, and a missing lock must never block
   * scanning.
   */
  function requestFingerprintWakeLock() {
    if (fingerprintWakeLock) return;
    const nav = navigator || {};
    if (!nav.wakeLock || typeof nav.wakeLock.request !== 'function') return;
    try {
      nav.wakeLock.request('screen').then((lock) => {
        fingerprintWakeLock = lock;
      }).catch(() => {
        fingerprintWakeLock = null;
      });
    } catch (error) {
      fingerprintWakeLock = null;
    }
  }

  function releaseFingerprintWakeLock() {
    if (!fingerprintWakeLock) return;
    try {
      const released = fingerprintWakeLock.release();
      if (released && typeof released.catch === 'function') released.catch(() => {});
    } catch (error) {
      // best effort
    }
    fingerprintWakeLock = null;
  }

  /**
   * Restart acquisition after the SDK pauses it (focus loss, tab switch,
   * the AcquisitionStopped event, or a reconnected reader). The reader
   * is the same one that fired the event, so the caller passes it in.
   */
  function restartFingerprintAcquisition(reader) {
    if (!unlocked || !fingerprintSessionActive) return;
    if (!fingerprintSdkReady()) return;
    const activeReader = reader || fingerprintReader;
    if (!activeReader) return;
    fingerprintAcquisitionActive = false;
    stopFingerprintWatchdog();
    setStatus('scanning', 'Reading fingerprint', 'Place your finger on the sensor.');
    startAcquisitionOnce(activeReader).catch(() => {
      startFingerprintWatchdog(activeReader);
    });
  }

  /**
   * Start acquisition once. The SDK pauses scanning when the page loses
   * focus, so this is also bound to window focus and visibilitychange.
   */
  function startAcquisitionOnce(reader) {
    if (!fingerprintSdkReady()) return Promise.reject(fingerprintError('sdk_missing'));
    if (!reader) return Promise.reject(fingerprintError('scanner_not_found'));
    if (fingerprintAcquisitionActive) return Promise.resolve();

    fingerprintAcquisitionActive = true;
    fingerprintWatchdogAttempts = 0;
    stopFingerprintWatchdog();

    const SampleFormat = window.dp.devices.SampleFormat;
    try {
      const starting = reader.startAcquisition(SampleFormat.PngImage);
      if (starting && typeof starting.then === 'function') {
        return starting.then(() => {
          fingerprintAcquisitionActive = true;
          fingerprintWatchdogAttempts = 0;
        }).catch(() => {
          fingerprintAcquisitionActive = false;
          throw fingerprintError('scanner_unavailable');
        });
      }
      fingerprintAcquisitionActive = true;
      return Promise.resolve();
    } catch (error) {
      fingerprintAcquisitionActive = false;
      throw fingerprintError('scanner_unavailable');
    }
  }

  /**
   * The Web SDK can stop acquisition for reasons the kiosk does not
   * observe directly (a driver hiccup, a transient comms loss). Retry
   * startAcquisition for a few seconds; if it still will not start, show
   * an error instead of silently leaving the scanner dead.
   */
  function startFingerprintWatchdog(reader) {
    stopFingerprintWatchdog();
    const activeReader = reader || fingerprintReader;
    if (!activeReader || !fingerprintSessionActive) return;
    fingerprintWatchdogTimer = setInterval(() => {
      if (!fingerprintSessionActive || fingerprintAcquisitionActive) {
        stopFingerprintWatchdog();
        return;
      }
      fingerprintWatchdogAttempts += 1;
      if (fingerprintWatchdogAttempts > FINGERPRINT_WATCHDOG_MAX_ATTEMPTS) {
        stopFingerprintWatchdog();
        setStatus('error', 'Scanner stopped', 'The fingerprint scanner will not restart. Reload the kiosk.');
        showResult(
          'device-error',
          'Scanner stopped',
          'The fingerprint reader stopped and the kiosk could not restart it.',
          'Reload the kiosk. If it still fails, check the U.are.U 4500 and the HID agent.'
        );
        return;
      }
      setStatus('scanning', 'Reconnecting scanner', 'The fingerprint reader paused; retrying acquisition.');
      startAcquisitionOnce(activeReader).catch(() => {});
    }, FINGERPRINT_WATCHDOG_INTERVAL_MS);
  }

  function stopFingerprintWatchdog() {
    if (fingerprintWatchdogTimer) {
      clearInterval(fingerprintWatchdogTimer);
      fingerprintWatchdogTimer = null;
    }
    fingerprintWatchdogAttempts = 0;
  }

  function clearFingerprintCooldown() {
    if (fingerprintCooldownTimer) {
      clearTimeout(fingerprintCooldownTimer);
      fingerprintCooldownTimer = null;
    }
  }

  function fingerprintCaptureAllowed() {
    if (busy) return false;
    if (fingerprintCooldownTimer) return false;
    return true;
  }

  /**
   * Register the session handlers on the reader exactly once. The kiosk
   * keeps a single reader for the life of the page, so binding again would
   * double every handler.
   */
  function bindFingerprintSessionHandlers(reader) {
    reader.on('SamplesAcquired', (event) => {
      handleFingerprintSample(event).catch(() => {});
    });
    reader.on('AcquisitionStopped', () => {
      if (!fingerprintSessionActive) return;
      restartFingerprintAcquisition(reader);
    });
    reader.on('DeviceConnected', () => {
      if (!fingerprintSessionActive) return;
      restartFingerprintAcquisition(reader);
    });
    reader.on('DeviceDisconnected', () => {
      fingerprintAcquisitionActive = false;
      if (!fingerprintSessionActive) return;
      stopFingerprintWatchdog();
      setStationState(false, 'Reader disconnected');
      setStatus('error', 'Reader disconnected', 'Reconnect the scanner, then place your finger again.');
      showResult(
        'device-error',
        'Reader disconnected',
        'Reader disconnected, reconnect the scanner.',
        'Reconnect the U.are.U 4500; the kiosk resumes scanning automatically.'
      );
    });
  }

  /**
   * Open the persistent scanner session for the selected event: one reader,
   * one acquisition run, and a wake lock until the event ends.
   */
  async function startFingerprintSession() {
    if (fingerprintSessionStarting) return;
    fingerprintSessionStarting = true;
    try {
      if (!fingerprintSdkReady()) throw fingerprintError('sdk_missing');

      const reader = createFingerprintReader();

      let devices;
      try {
        devices = await reader.enumerateDevices();
      } catch (error) {
        throw fingerprintError('scanner_unavailable');
      }
      if (!Array.isArray(devices) || devices.length === 0) {
        throw fingerprintError('scanner_not_found');
      }

      fingerprintSessionActive = true;
      requestFingerprintWakeLock();
      startFingerprintFocusGuard();
      if (!fingerprintHandlersBound) {
        fingerprintHandlersBound = true;
        bindFingerprintSessionHandlers(reader);
      }

      try {
        await startAcquisitionOnce(reader);
      } catch (error) {
        stopFingerprintSession();
        throw error;
      }
    } finally {
      fingerprintSessionStarting = false;
    }
  }

  /**
   * End the persistent session: stop acquisition, stop the watchdog, and
   * release the wake lock. Called when the event ends, the station locks,
   * another event is chosen, or the page is unloaded.
   */
  function stopFingerprintSession() {
    fingerprintSessionActive = false;
    if (fingerprintResultTimer) {
      clearTimeout(fingerprintResultTimer);
      fingerprintResultTimer = null;
      busy = false;
    }
    clearFingerprintCooldown();
    if (fingerprintReader) stopFingerprintAcquisition(fingerprintReader);
    stopFingerprintWatchdog();
    releaseFingerprintWakeLock();
    stopFingerprintFocusGuard();
  }

  function startFingerprintCooldown() {
    clearFingerprintCooldown();
    fingerprintCooldownTimer = setTimeout(() => {
      fingerprintCooldownTimer = null;
    }, FINGERPRINT_COOLDOWN_MS);
  }

  /**
   * Open the scanner as soon as the selected event enters its live window.
   * One attempt is made per event and scan mode, so a failure (unplugged
   * reader, missing device) leaves the Scan Fingerprint button as the
   * manual retry instead of retrying on every render.
   */
  function maybeAutoStartFingerprintSession() {
    if (!unlocked || !isApiEnabled()) return;
    if (busy || fingerprintSessionActive || fingerprintSessionStarting) return;
    if (!fingerprintSdkReady()) return;

    const key = `${currentEventId}:${scanMode}`;
    if (fingerprintAutoStartAttempts.has(key)) return;
    fingerprintAutoStartAttempts.add(key);

    setStepState(3);
    setStatus('scanning', 'Starting scanner', 'Opening the fingerprint reader for this event.');

    startFingerprintSession()
      .then(() => {
        if (!unlocked || !fingerprintSessionActive) return;
        setScanAvailability(
          true,
          'Scanner active',
          'Place your finger on the sensor; the reader stays on until the event ends.'
        );
        setStationState(true, 'Scanner ready');
        setStepState(2);
        setStatus('scanning', 'Place your finger', 'Rest your finger on the U.are.U 4500 sensor.');
        resetIdleTimer();
      })
      .catch((err) => {
        if (!unlocked) return;
        // Leave the button usable so the officer can retry by hand.
        const code = err && err.code ? err.code : 'scanner_unavailable';
        const detail = FINGERPRINT_ERRORS[code] || FINGERPRINT_ERRORS['scanner_unavailable'];
        setScanAvailability(
          true,
          'Scan Fingerprint',
          'Tap to wake the scanner, then rest your finger on the sensor.'
        );
        setStepState(2);
        setStationState(false, 'Scanner offline');
        setStatus(detail[0] === 'no-match' ? 'attention' : 'error', detail[1], detail[3]);
      });
  }

  /**
   * One placement while the session is live. The sample goes to the server,
   * the result stays on screen for three seconds, then the sensor invites
   * the next finger. Acquisition is never stopped after a sample.
   */
  async function handleFingerprintSample(event) {
    if (!fingerprintSessionActive) return;
    // A cooldown ignores the second placement of one gesture, and busy
    // means a check-in is in flight (or its result is still showing).
    if (!fingerprintCaptureAllowed()) return;

    const samples = event && Array.isArray(event.samples) ? event.samples : [];
    const template = api.extractFingerprintTemplate(samples[0]);
    if (!template) {
      setStatus('attention', 'Fingerprint not read', 'Place your finger flat on the sensor and try again.');
      return;
    }

    const eventRow = getEvents().find((e) => sameId(e.id, currentEventId));
    if (!eventRow) {
      stopFingerprintSession();
      showResult('no-event', 'No event selected', 'Choose an event before scanning.', '');
      return;
    }

    busy = true;
    resetIdleTimer();
    setStatus('processing', 'Verifying identity', 'The server is matching the fingerprint.');

    try {
      const record = await api.fingerprintCheckIn(eventRow.id, template, scanMode);
      const action = record.action === 'out' ? 'out' : 'in';
      const stamp = action === 'out'
        ? (record.checkOutTimeLabel || record.time)
        : record.time;
      const studentName = record.studentName || 'Student';
      addServerRecord(record, eventRow.id);
      showResult(
        'success',
        action === 'out' ? `Goodbye, ${studentName}!` : `Welcome, ${studentName}!`,
        action === 'out' ? 'Check-out recorded for this event.' : 'Attendance recorded for this event.',
        `<strong>${escapeHtml(eventRow.name)}</strong> · ${escapeHtml(stamp || new Date().toLocaleTimeString())}`
      );
      setStatus('success', `Checked ${action}`, `${studentName} checked ${action}.`);
    } catch (err) {
      if (isSessionError(err)) {
        lockStation('Station locked. Officer session expired — sign in again.', { endSession: true });
        return;
      }
      const code = err && err.code ? err.code : 'fingerprint_capture_failed';
      const detail = FINGERPRINT_ERRORS[code] || FINGERPRINT_ERRORS['fingerprint_capture_failed'];
      showResult(detail[0], detail[1], detail[2], '');
      setStatus(detail[0] === 'no-match' ? 'attention' : 'error', detail[1], detail[3]);
    }

    if (!fingerprintSessionActive) {
      busy = false;
      return;
    }

    // Show the result for three seconds, then cool down and invite the next
    // finger. The reader keeps running the whole time.
    fingerprintResultTimer = setTimeout(() => {
      fingerprintResultTimer = null;
      busy = false;
      if (!fingerprintSessionActive) return;
      if (els.resultOverlay) els.resultOverlay.hidden = true;
      startFingerprintCooldown();
      setScanAvailability(
        true,
        'Scanner active',
        'Place your finger on the sensor; the reader stays on until the event ends.'
      );
      setStatus('scanning', 'Place your finger', 'Rest your finger on the U.are.U 4500 sensor.');
      resetIdleTimer();
    }, FINGERPRINT_RESULT_HOLD_MS);
  }

  async function runFingerprintScan() {
    if (!isApiEnabled()) {
      showApiRequired();
      return;
    }
    if (!unlocked) {
      showLock('Sign in to unlock this station.');
      return;
    }
    if (busy) return;

    const event = getEvents().find((e) => sameId(e.id, currentEventId));
    if (!event) {
      showResult('no-event', 'No event selected', 'Choose an event before scanning.', '');
      return;
    }
    const modeTitle = actionTitle(scanMode);
    const modeWord = actionWord(scanMode);
    if (getEventPhase(event, scanMode) !== 'live') {
      showResult(
        'no-event',
        `${modeTitle} unavailable`,
        `This event is not accepting ${modeWord}s right now.`,
        `Choose an event or mode marked “${modeTitle} open”.`
      );
      return;
    }

    if (!fingerprintSdkReady()) {
      showResult(
        'model-error',
        'Scanner module missing',
        'The DigitalPersona Web SDK did not load on this station.',
        'Reload the kiosk. If it still fails, check the SDK script files.'
      );
      setStatus('error', 'Scanner module missing', 'Reload the kiosk to load the fingerprint SDK.');
      return;
    }

    // One session per open event: the first tap wakes the reader and every
    // later placement arrives through the SamplesAcquired handler, so the
    // scanner stays live until the event ends.
    if (fingerprintSessionActive) {
      restartFingerprintAcquisition(fingerprintReader);
      return;
    }

    resetIdleTimer();
    if (els.resultOverlay) els.resultOverlay.hidden = true;
    setStepState(3);
    els.scanBtn.disabled = true;
    setStatus('scanning', 'Reading fingerprint', 'Place your finger on the U.are.U 4500 sensor.');

    try {
      await startFingerprintSession();
      setScanAvailability(
        true,
        'Scanner active',
        'Place your finger on the sensor; the reader stays on until the event ends.'
      );
      setStationState(true, 'Scanner ready');
      setStatus('scanning', 'Place your finger', 'Rest your finger on the U.are.U 4500 sensor.');
    } catch (err) {
      const code = err && err.code ? err.code : 'scanner_unavailable';
      const detail = FINGERPRINT_ERRORS[code] || FINGERPRINT_ERRORS['scanner_unavailable'];
      showResult(detail[0], detail[1], detail[2], '');
      setStatus(
        detail[0] === 'no-match' ? 'attention' : 'error',
        detail[1],
        detail[3]
      );
      if (code === 'scanner_not_found' || code === 'scanner_unavailable' || code === 'scanner_disconnected') {
        setStationState(false, 'Scanner offline');
      }
    }
    resetIdleTimer();
  }

  // ── Manual fallback (server-authorized override) ──
  async function runManualEntry(rawId) {
    if (!isApiEnabled()) {
      showApiRequired();
      return;
    }
    if (!unlocked) {
      showLock('Sign in to unlock this station.');
      return;
    }
    const id = (rawId || '').trim();
    const event = getEvents().find((e) => sameId(e.id, currentEventId));
    if (!event || !id) return;
    const modeTitle = actionTitle(scanMode);
    const modeWord = actionWord(scanMode);
    if (getEventPhase(event, scanMode) !== 'live') {
      showToast('warning', `This event is not accepting ${modeWord}s right now.`);
      return;
    }

    const needle = id.toLowerCase();
    const student = getUsers().find((u) =>
      u.role === 'student' && (
        String(u.id) === id ||
        String(u.studentIdNumber || '').toLowerCase() === needle ||
        String(u.email || '').toLowerCase() === needle
      )
    );
    if (!student) {
      showToast('error', 'Student not found.');
      return;
    }

    const studentName = student.name || 'Student';
    busy = true;
    resetIdleTimer();
    try {
      const record = await api.manualCheckIn(event.id, student.id, scanMode);
      const action = record.action === 'out' ? 'out' : 'in';
      addServerRecord(record, event.id);
      const stamp = action === 'out'
        ? (record.checkOutTimeLabel || record.time)
        : record.time;
      showResult(
        'success',
        action === 'out' ? `Goodbye, ${studentName}!` : `Welcome, ${studentName}!`,
        action === 'out' ? 'Manual check-out recorded.' : 'Manual attendance recorded.',
        `<strong>${escapeHtml(event.name)}</strong> · ${escapeHtml(stamp || new Date().toLocaleTimeString())}`
      );
      showToast(
        'success',
        action === 'out' ? `${studentName} checked out.` : `${studentName} checked in.`
      );
    } catch (err) {
      if (isSessionError(err)) {
        lockStation('Station locked. Officer session expired — sign in again.', { endSession: true });
        return;
      }
      if (err.code === 'duplicate_checkin' || err.code === 'duplicate_checkout') {
        const already = err.code === 'duplicate_checkout' ? 'checked out' : 'checked in';
        showToast('warning', `${studentName} is already ${already}.`);
        showResult('already', `Already ${already}`, `${studentName} is already ${already} for this event.`, '');
        return;
      }
      if (err.code === 'not_checked_in') {
        showToast('warning', `${studentName} has not checked in yet.`);
        showResult('already', 'Not checked in', `${studentName} has no check-in for this event, so there is nothing to check out.`, '');
        return;
      }
      showToast('error', `The server did not record this ${modeWord}. Please retry.`);
      showResult('server-error', 'Server unreachable', `The attendance server did not accept this ${modeWord}. Please retry, or see the SSC booth.`, '');
    } finally {
      busy = false;
      resetIdleTimer();
    }
  }

  // ── Clock ──
  function tickClock() {
    const now = new Date();
    els.clockTime.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    els.clockDate.textContent = now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function showApiRequired() {
    els.event.innerHTML = '<option value="">API required</option>';
    els.event.disabled = true;
    els.eventName.textContent = 'Kiosk API not configured';
    els.eventMeta.textContent = API_REQUIRED_MESSAGE;
    els.statusChip.textContent = 'API required';
    els.statusChip.className = 'kiosk-status-badge is-closed';
    hideCountdown();
    setScanAvailability(false, 'API required', 'Set API_BASE_URL in js/api.js, then reload.');
    setModeButtonsEnabled(false);
    setStatus('error', 'API required', 'Set API_BASE_URL in js/api.js, then reload this page.');
    setStationState(false, 'API required');
    if (els.manualToggle) {
      els.manualToggle.disabled = true;
      els.manualToggle.setAttribute('aria-expanded', 'false');
    }
    if (els.manualBody) els.manualBody.hidden = true;
    if (els.manualId) els.manualId.placeholder = 'API required';
    setLockMessage(API_REQUIRED_MESSAGE);
    setLockBusy(true);
  }

  // ── Boot ──
  function init() {
    els = {
      event:        $('kioskEvent'),
      eventName:    $('kioskEventName'),
      eventMeta:    $('kioskEventMeta'),
      countdown:    $('kioskCountdown'),
      statusChip:   $('kioskStatusBadge'),
      modeIn:       $('kioskModeIn'),
      modeOut:      $('kioskModeOut'),
      scanner:      $('kioskScanner'),
      statusText:   $('kioskStatusText'),
      scanHint:     $('kioskScanHint'),
      steps:        document.querySelectorAll('.kiosk-steps li'),
      scanBtn:      $('kioskScanBtn'),
      scanCtaTitle: $('kioskScanCtaTitle'),
      scanCtaDetail: $('kioskScanCtaDetail'),
      fingerprintState: $('kioskFingerprintState'),
      count:        $('kioskCount'),
      listCount:    $('kioskListCount'),
      attendancePct: $('kioskAttendancePct'),
      ticker:       $('kioskTicker'),
      tickerList:   $('kioskTickerList'),
      resultOverlay: $('resultOverlay'),
      resultIconWrap: $('resultIconWrap'),
      resultIcon:   $('resultIcon'),
      resultTitle:  $('resultTitle'),
      resultMessage: $('resultMessage'),
      resultMeta:   $('resultMeta'),
      resultDone:   $('resultDone'),
      manualToggle: $('manualToggle'),
      manualBody:   $('manualBody'),
      manualForm:   $('kioskManualForm'),
      manualId:     $('manualStudentId'),
      manualInput:  $('manualStudentId'),
      manualSubmit: document.querySelector('#kioskManualForm button[type="submit"]'),
      stationState: $('kioskStationState'),
      stationDot:   $('kioskStationDot'),
      clockTime:    $('kioskClockTime'),
      clockDate:    $('kioskClockDate'),
      lock:         $('kioskLock'),
      lockForm:     $('kioskLockForm'),
      lockEmail:    $('kioskLockEmail'),
      lockPassword: $('kioskLockPassword'),
      lockSubmit:   $('kioskLockSubmit'),
      lockError:    $('kioskLockError'),
      operator:     $('kioskOperator'),
      operatorName: $('kioskOperatorName'),
      operatorAvatar: $('kioskOperatorAvatar'),
      lockNow:      $('kioskLockNow'),
    };

    tickClock();
    setInterval(tickClock, 1000);

    if (!isApiEnabled()) {
      showApiRequired();
      return;
    }

    // Lock-screen sign-in.
    els.lockForm.addEventListener('submit', (e) => {
      e.preventDefault();
      signIn(els.lockEmail.value, els.lockPassword.value);
    });

    if (els.lockNow) {
      els.lockNow.addEventListener('click', () => {
        lockStation('Station locked by the officer.', { endSession: true });
      });
    }

    // Any deliberate interaction postpones the inactivity lock.
    ['pointerdown', 'keydown', 'touchstart'].forEach((eventName) => {
      document.addEventListener(eventName, () => {
        if (unlocked && !busy) resetIdleTimer();
      }, { passive: true });
    });

    els.event.addEventListener('change', () => {
      stopFingerprintSession();
      const chosen = getEvents().find((e) => sameId(e.id, els.event.value));
      currentEventId = chosen ? chosen.id : null;
      renderEventHeader();
      updateCounts();
      renderTicker();
      resetIdleTimer();
    });

    [[els.modeIn, 'in'], [els.modeOut, 'out']].forEach(([button, mode]) => {
      if (!button) return;
      button.addEventListener('click', () => setScanMode(mode));
    });

    // Capture starts from this click, and the kiosk holds page focus while
    // it waits because the Web SDK pauses scanning when the page blurs.
    els.scanBtn.addEventListener('click', () => {
      runFingerprintScan().catch(() => {
        showToast('error', 'The scan did not finish. Please try again.');
        showResult('server-error', 'Scan failed', 'The fingerprint scan did not finish. Please try again.', '');
      });
    });

    // The Web SDK pauses scanning when the page loses focus, so resume the
    // live session whenever the station is focused again.
    window.addEventListener('focus', () => {
      if (fingerprintSessionActive) restartFingerprintAcquisition(fingerprintReader);
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && fingerprintSessionActive) restartFingerprintAcquisition(fingerprintReader);
    });
    window.addEventListener('pagehide', () => {
      stopFingerprintSession();
    });

    // Manual entry collapse
    if (els.manualToggle) {
      els.manualToggle.addEventListener('click', () => {
        const expanded = els.manualToggle.getAttribute('aria-expanded') === 'true';
        els.manualToggle.setAttribute('aria-expanded', String(!expanded));
        els.manualBody.hidden = expanded;
        resetIdleTimer();
      });
    }

    if (els.manualForm) {
      els.manualForm.addEventListener('submit', (e) => {
        e.preventDefault();
        // Awaited via .catch so a rejected server call surfaces on the
        // kiosk rather than as an unhandled promise rejection.
        runManualEntry(els.manualId.value).catch(() => {
          showToast('error', `The server did not record this ${actionWord(scanMode)}. Please retry.`);
          showResult('server-error', 'Server unreachable', `The attendance server did not accept this ${actionWord(scanMode)}. Please retry, or see the SSC booth.`, '');
        });
        els.manualId.value = '';
      });
    }

    if (els.resultDone) {
      els.resultDone.addEventListener('click', () => {
        els.resultOverlay.hidden = true;
        // Returning the station to the current event re-enables the
        // fingerprint button and resets the instruction state.
        renderEventHeader();
        setStationState(true, 'Scanner ready');
        resetIdleTimer();
      });
    }

    showLock('Sign in to unlock this check-in station.');
    restoreSession();

    // Refresh the countdown and event window periodically once unlocked.
    // Never while a capture is in flight, so the button cannot re-enable
    // halfway through a scan.
    setInterval(() => {
      if (unlocked && !busy) renderEventHeader();
    }, 20000);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
