// Runs before the RPHS web app inside the Android app only (never on the website).
// The web app is written for Chrome; this fills the gaps of Android's WebView
// with native code: the share sheet, file downloads, opening PDFs, outside links
// and push alerts.
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
  // ---- Push alerts -------------------------------------------------------
  // Chrome's web push doesn't exist in the WebView, so the web app sees no
  // firebase messaging. Instead: a Notification stand-in (so "Turn on alerts"
  // and the alerts banner work as in Chrome), and the phone's native FCM token
  // saved under fcm_tokens/{uid}.tokens exactly like a browser token, so the
  // existing Cloud Functions reach this phone with no changes.
  var push = { permission: '__RPHS_PUSH_PERMISSION__', token: '', savedFor: '' };
  if (!/^(granted|denied|default)$/.test(push.permission)) push.permission = 'default';

  function toPermission(r) {
    var s = r && r.receive;
    return s === 'granted' ? 'granted' : s === 'denied' ? 'denied' : 'default';
  }

  function RphsNotification() {}
  Object.defineProperty(RphsNotification, 'permission', { get: function () { return push.permission; } });
  RphsNotification.requestPermission = function (callback) {
    return bridgeReady().then(function () {
      return native('PushNotifications', 'requestPermissions');
    }).then(toPermission, function () { return push.permission; }).then(function (p) {
      push.permission = p;
      if (p === 'granted') native('PushNotifications', 'register').catch(function () {});
      if (typeof callback === 'function') callback(p);
      return p;
    });
  };
  window.Notification = RphsNotification;

  function waitFor(check, everyMs, maxMs) {
    return new Promise(function (resolve, reject) {
      var waited = 0;
      (function poll() {
        var v;
        try { v = check(); } catch (e) { v = null; }
        if (v) return resolve(v);
        if ((waited += everyMs) > maxMs) return reject(new Error('timed out'));
        setTimeout(poll, everyMs);
      })();
    });
  }
  function bridgeReady() {
    return waitFor(function () { var c = window.Capacitor; return c && c.addListener && c.nativePromise && c; }, 50, 15000);
  }
  function firebaseReady() {
    return waitFor(function () { var f = window.firebase; return f && f.apps && f.apps.length && f.auth && f.firestore && f; }, 300, 120000);
  }

  function saveToken() {
    var fb = window.firebase;
    var user = fb && fb.apps && fb.apps.length && fb.auth().currentUser;
    if (!user || !push.token || push.permission !== 'granted') return;
    var key = user.uid + '|' + push.token;
    if (push.savedFor === key) return;
    push.savedFor = key;
    var now = fb.firestore.FieldValue.serverTimestamp();
    var tokens = {};
    tokens[push.token] = { updatedAt: now, device: 'Android (app)' };
    fb.firestore().collection('fcm_tokens').doc(user.uid)
      .set({ token: push.token, tokens: tokens, uid: user.uid, updatedAt: now }, { merge: true })
      .catch(function (e) { push.savedFor = ''; console.warn('RPHS push token save failed', e); });
  }

  // Signing out stops this phone getting the previous member's alerts.
  function forgetToken(fb, user) {
    var token = push.token;
    if (!user || !token) return Promise.resolve();
    push.savedFor = '';
    var fs = fb.firestore;
    var ref = fb.firestore().collection('fcm_tokens').doc(user.uid);
    var drop = ref.get().then(function (snap) {
      if (!snap.exists) return;
      var args = [new fs.FieldPath('tokens', token), fs.FieldValue.delete()];
      if (snap.data().token === token) args.push('token', fs.FieldValue.delete());
      return ref.update.apply(ref, args);
    }).catch(function () {});
    return Promise.race([drop, new Promise(function (r) { setTimeout(r, 2500); })]);
  }

  bridgeReady().then(function (cap) {
    cap.addListener('PushNotifications', 'registration', function (t) {
      push.token = (t && t.value) || '';
      saveToken();
    });
    cap.addListener('PushNotifications', 'registrationError', function (e) {
      console.warn('RPHS push registration failed', e && e.error);
    });
    return native('PushNotifications', 'checkPermissions').then(function (r) {
      push.permission = toPermission(r);
      if (push.permission === 'granted') return native('PushNotifications', 'register');
    });
  }).catch(function (e) { console.warn('RPHS push setup failed', e); });

  firebaseReady().then(function (fb) {
    var auth = fb.auth();
    auth.onAuthStateChanged(function () { saveToken(); });
    var signOut = auth.signOut;
    auth.signOut = function () {
      var self = this, args = arguments;
      return forgetToken(fb, auth.currentUser).then(function () { return signOut.apply(self, args); });
    };
  }).catch(function () {});
})();
