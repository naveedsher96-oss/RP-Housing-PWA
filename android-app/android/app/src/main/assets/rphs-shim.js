// Runs before the RPHS web app inside the Android app only (never on the website).
// The web app is written for Chrome; this fills the gaps of Android's WebView
// with native code: the share sheet, file downloads, opening PDFs and outside links.
(function () {
  'use strict';
  if (window.__rphsNative) return;
  window.__rphsNative = true;

  var APP_ORIGIN = location.origin;

  function native(plugin, method, options) {
    var cap = window.Capacitor;
    if (!cap || !cap.nativePromise) return Promise.reject(new Error('App bridge not ready'));
    return cap.nativePromise(plugin, method, options || {});
  }

  function abortError() {
    try { return new DOMException('Share canceled', 'AbortError'); }
    catch (e) { var err = new Error('Share canceled'); err.name = 'AbortError'; return err; }
  }

  function isCancel(e) {
    return /cancel/i.test(String((e && (e.message || e.errorMessage)) || e));
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(',')[1] || ''); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(blob);
    });
  }

  var EXT = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'text/csv': 'csv',
    'application/json': 'json', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx' };

  function fileName(name, mime) {
    var clean = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 120);
    if (!clean) clean = 'RPHS_' + Date.now();
    var ext = EXT[String(mime || '').split(';')[0]];
    if (ext && !/\.[A-Za-z0-9]{2,5}$/.test(clean)) clean += '.' + ext;
    return clean;
  }

  // Saves a Blob/File into the app's cache folder and returns its file:// address.
  function saveToCache(blob, name) {
    return blobToBase64(blob).then(function (data) {
      return native('Filesystem', 'writeFile', {
        path: 'shared/' + fileName(name || blob.name, blob.type),
        data: data,
        directory: 'CACHE',
        recursive: true
      });
    }).then(function (res) { return res.uri; });
  }

  function shareFiles(blobs, title, text) {
    return Promise.all(blobs.map(function (b) { return saveToCache(b, b.name); })).then(function (uris) {
      return native('Share', 'share', { title: title, text: text, files: uris, dialogTitle: title || 'Share' });
    });
  }

  // navigator.share / canShare (missing in WebView): use Android's share sheet.
  navigator.canShare = function (data) {
    return !!data && !!(data.text || data.url || data.title || (data.files && data.files.length));
  };
  navigator.share = function (data) {
    data = data || {};
    var job = data.files && data.files.length
      ? shareFiles(Array.prototype.slice.call(data.files), data.title, data.text)
      : native('Share', 'share', { title: data.title, text: data.text, url: data.url, dialogTitle: data.title || 'Share' });
    return job.then(function () {}, function (e) { throw isCancel(e) ? abortError() : e; });
  };

  function fetchBlob(url) {
    return fetch(url).then(function (r) { return r.blob(); });
  }

  // <a download href="blob:..."> (CSV, Excel, PDF, backups): WebView can't save
  // these, so hand the file to the share sheet (Save to Files/Drive, WhatsApp, email).
  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (a.hasAttribute('download') && /^(blob|data):/i.test(href)) {
      ev.preventDefault();
      var name = a.getAttribute('download');
      fetchBlob(a.href).then(function (blob) {
        return shareFiles([new File([blob], fileName(name, blob.type), { type: blob.type })], name);
      }).catch(function (e) { if (!isCancel(e)) console.warn('RPHS download failed', e); });
    }
  }, true);

  // window.open: PDFs/images open in a viewer app; outside links open in their app
  // (WhatsApp, maps, browser) instead of replacing the RPHS screen.
  var originalOpen = window.open;
  function fakeWindow() { return { closed: false, close: function () {}, focus: function () {}, location: {} }; }
  window.open = function (url, target, features) {
    var href = String(url || '');
    if (/^(blob|data):/i.test(href)) {
      fetchBlob(href).then(function (blob) {
        return saveToCache(blob, '').then(function (uri) {
          return native('RphsBridge', 'openFile', { uri: uri, mime: blob.type || '*/*' }).catch(function () {
            return native('Share', 'share', { files: [uri], dialogTitle: 'Open with' });
          });
        });
      }).catch(function (e) { if (!isCancel(e)) console.warn('RPHS open file failed', e); });
      return fakeWindow();
    }
    var abs;
    try { abs = new URL(href, location.href); } catch (e) { abs = null; }
    if (abs && abs.origin !== APP_ORIGIN) {
      native('RphsBridge', 'openUrl', { url: abs.href }).catch(function (e) { console.warn('RPHS open link failed', e); });
      return fakeWindow();
    }
    return originalOpen.call(window, url, target, features);
  };
})();
