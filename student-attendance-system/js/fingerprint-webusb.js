/* ============================================================
   FingerprintScanner — WebUSB transport for the attendance kiosk
   ------------------------------------------------------------
   The scanner is a DigitalPersona U.are.U 4500 (USB vendor
   0x05ba). The browser is the only thing that talks to it: no
   local service, no installed helper, no camera.

   WebUSB grants the page a USBDevice handle. Turning raw USB
   packets into a fingerprint template is vendor-specific, so the
   actual capture step lives behind a small provider seam:

       window.FingerprintScanner.registerProvider({
         captureTemplate: function (usbDevice) {
           return Promise.resolve('template-string');
         }
       });

   A vendor bundle can register itself as
   window.FingerprintWebUse / FingerprintWebUse / FingerprintWebUsb
   before this file loads, and it is discovered automatically.
   The prototype deliberately throws a clear "bridge missing"
   error instead of pretending a scan succeeded when no capture
   implementation is present.

   Requires a secure context: https:// or http://localhost.
   Chrome and Edge are the browsers with WebUSB support.
   ============================================================ */

(function (global) {
  'use strict';

  var VENDOR_ID = 0x05ba;  // DigitalPersona
  var PRODUCT_ID = 0x000a; // U.are.U 4500
  var PROVIDER_NAMES = [
    'FingerprintWebUse',
    'FingerprintWebUSE',
    'FingerprintWebUsb',
    'DigitalPersonaWebUsb',
    'AttendlyFingerprintBridge',
  ];

  var provider = null;
  var device = null;

  function scannerError(code, message, cause) {
    var error = new Error(message);
    error.code = code;
    if (cause) error.cause = cause;
    return error;
  }

  function isSupported() {
    return !!global.navigator
      && !!global.navigator.usb
      && typeof global.navigator.usb.requestDevice === 'function';
  }

  function isSecure() {
    // localhost is a secure context even over plain HTTP, so the kiosk
    // works with `npm run serve` during development.
    return typeof global.isSecureContext === 'boolean'
      ? global.isSecureContext
      : /^(https:|localhost$|127\.0\.0\.1$)/.test(
        String(global.location && global.location.protocol || '') +
        String(global.location && global.location.hostname || '')
      );
  }

  function providerLooksUsable(candidate) {
    return !!candidate && (
      typeof candidate.captureTemplate === 'function'
      || typeof candidate.capture === 'function'
      || typeof candidate.readTemplate === 'function'
    );
  }

  function registerProvider(candidate) {
    if (candidate !== null && !providerLooksUsable(candidate)) {
      throw new Error(
        'Fingerprint provider must expose captureTemplate(), capture(), or readTemplate().'
      );
    }
    provider = candidate;
  }

  /**
   * Find a vendor bundle loaded before this script. The first match wins;
   * no provider is required until the operator actually scans.
   */
  function discoverProvider() {
    if (provider) return provider;
    for (var i = 0; i < PROVIDER_NAMES.length; i++) {
      var candidate = global[PROVIDER_NAMES[i]];
      if (providerLooksUsable(candidate)) {
        provider = candidate;
        return provider;
      }
    }
    return null;
  }

  /**
   * Reuse a device the operator already authorised, otherwise show the
   * browser's USB picker filtered to the DigitalPersona vendor id.
   *
   * @returns {Promise<USBDevice>}
   */
  async function requestDevice() {
    if (!isSupported()) {
      throw scannerError(
        'webusb_unsupported',
        'This browser does not support WebUSB. Use Chrome or Edge on localhost or HTTPS.'
      );
    }
    if (!isSecure()) {
      throw scannerError(
        'webusb_insecure',
        'WebUSB needs a secure page. Open the kiosk on localhost or HTTPS.'
      );
    }

    var usb = global.navigator.usb;
    var granted = [];
    try {
      granted = await usb.getDevices();
    } catch (error) {
      // A browser that supports requestDevice() but not getDevices() is
      // vanishingly rare; the picker below still works.
      granted = [];
    }

    device = granted.find(function (candidate) {
      return candidate.vendorId === VENDOR_ID;
    }) || null;

    if (!device) {
      try {
        device = await usb.requestDevice({
          filters: [{ vendorId: VENDOR_ID }],
        });
      } catch (error) {
        if (error && error.name === 'NotFoundError') {
          throw scannerError(
            'usb_no_device',
            'No fingerprint scanner was selected. Plug in the U.are.U 4500 and try again.',
            error
          );
        }
        if (error && error.name === 'SecurityError') {
          throw scannerError(
            'usb_permission_denied',
            'USB access was blocked. Allow the device in the browser prompt and try again.',
            error
          );
        }
        throw scannerError(
          'usb_no_device',
          'The fingerprint scanner could not be opened. Reconnect it and try again.',
          error
        );
      }
    }

    if (!device) {
      throw scannerError('usb_no_device', 'No fingerprint scanner is connected.');
    }

    if (!device.opened) {
      try {
        await device.open();
      } catch (error) {
        throw scannerError(
          'usb_open_failed',
          'The scanner is in use by another application. Close it and try again.',
          error
        );
      }
    }

    // A device may expose no configurations until opened. Selecting the
    // first one is required before any transfer; the capture provider may
    // still claim whichever interface its protocol uses.
    if (!device.configuration && device.configurations && device.configurations.length) {
      try {
        await device.selectConfiguration(device.configurations[0].configurationNumber);
      } catch (error) {
        throw scannerError(
          'usb_open_failed',
          'The scanner configuration could not be selected. Reconnect it and try again.',
          error
        );
      }
    }

    return device;
  }

  /**
   * Ask the registered provider for one fingerprint template.
   *
   * @returns {Promise<string>} opaque template string
   */
  async function captureTemplate() {
    var activeProvider = discoverProvider();
    if (!activeProvider) {
      throw scannerError(
        'fingerprint_bridge_missing',
        'No fingerprint capture bridge is loaded. The DigitalPersona WebUSB bundle must '
          + 'call FingerprintScanner.registerProvider() before scanning.'
      );
    }

    var usbDevice = await requestDevice();
    var result;

    try {
      if (typeof activeProvider.captureTemplate === 'function') {
        result = await activeProvider.captureTemplate(usbDevice);
      } else if (typeof activeProvider.readTemplate === 'function') {
        result = await activeProvider.readTemplate(usbDevice);
      } else {
        result = await activeProvider.capture(usbDevice);
      }
    } catch (error) {
      if (error && error.code) throw error;
      throw scannerError(
        'fingerprint_capture_failed',
        'The scanner could not read a fingerprint. Clean the sensor and try again.',
        error
      );
    }

    // Providers may return either the template string or an object that
    // carries it alongside metadata.
    if (result && typeof result === 'object') {
      result = result.template || result.fmd || result.sample || result.data || '';
    }

    var template = String(result == null ? '' : result).trim();
    if (template === '' || template.length < 8) {
      throw scannerError(
        'fingerprint_capture_failed',
        'The scan was empty. Keep your finger on the sensor until it beeps.'
      );
    }
    if (template.length > 65535) {
      throw scannerError(
        'fingerprint_capture_failed',
        'The scanner returned a template that is too large to store.'
      );
    }

    return template;
  }

  async function disconnect() {
    if (provider && typeof provider.disconnect === 'function') {
      try {
        await provider.disconnect(device);
      } catch (error) {
        // Best effort: closing the USB handle below is what matters.
      }
    }
    if (device && device.opened) {
      try {
        await device.close();
      } catch (error) {
        // The device may already have been unplugged.
      }
    }
    device = null;
  }

  global.FingerprintScanner = {
    VENDOR_ID: VENDOR_ID,
    PRODUCT_ID: PRODUCT_ID,
    isSupported: isSupported,
    isSecure: isSecure,
    requestDevice: requestDevice,
    captureTemplate: captureTemplate,
    disconnect: disconnect,
    registerProvider: registerProvider,
    getProvider: discoverProvider,
    getDevice: function () { return device; },
  };
})(window);
