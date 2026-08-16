---
name: testing-rphs-pwa
description: How to run and test the Roshan Pakistan Housing Society PWA (single-file index.html) locally in Chrome without real Firebase credentials, using an in-memory firebase compat stub.
---

# Testing the RPHS PWA locally

The app is a single-file PWA: `index.html` with all vanilla JS in one IIFE. It loads Firebase
compat (Auth + Firestore) and jsPDF from CDNs. There is **no build, no dev server and no test
suite** — you just open the file in Chrome (`file://` works fine).

## Problem: no Firebase credentials

Without real credentials nothing renders past the login screen. Instead of asking for secrets,
stub the Firebase compat surface. A working stub lives at `/home/ubuntu/firebase-mock.js`
(recreate it if missing). It must expose `window.firebase` with:

- `initializeApp`, `apps`
- `auth()` → `{ currentUser, onAuthStateChanged(cb), signOut, signInWithEmailAndPassword, createUserWithEmailAndPassword }`
  (call `cb(user)` asynchronously; `user.emailVerified` must be `true`, and `reload`/`sendEmailVerification` must resolve)
- `firestore()` → `{ collection(name), batch(), runTransaction(fn) }` where collections support
  chained `.where().orderBy().limit().get()`, `.doc(id)` (`get/set/update/delete/collection`) and `.add()`.
  Snapshots need `{ id, exists, data() }`; query snapshots need `{ docs, empty, size }`.
- `firestore.FieldValue.serverTimestamp()` returning a `{ toDate(), seconds }` shaped object
  (the app calls `toDate()` on stored timestamps).
- `messaging.isSupported()` → `Promise.resolve(false)` so push setup is skipped.

Seed `users`, `tickets` and `bills` collections in memory. Pick the logged-in identity from the
query string, e.g. `?role=admin` → an admin user doc, `?role=resident` → an approved resident.
This makes role separation trivially testable by just changing the URL.

## Generating the test copy of index.html

Do not edit `index.html`. Generate a sibling copy with the CDN Firebase tags swapped for the stub:

```python
import re
src = open('repos/RP-Housing-PWA/index.html', encoding='utf-8').read()
out = re.sub(r'\s*<script src="https://www\.gstatic\.com[^"]*"></script>', '', src)
out = re.sub(r'\s*<link rel="manifest"[^>]*>', '', out)          # avoid file:// manifest errors
out = out.replace('<!-- jsPDF', '<script src="firebase-mock.js"></script>\n\n<!-- jsPDF', 1)
out = out.replace('<img src="icon-192.png"', '<img src="repos/RP-Housing-PWA/icon-192.png"')
open('rph-local-test.html', 'w', encoding='utf-8').write(out)
```

Keep the generated file and `firebase-mock.js` in the **same directory** (e.g. `/home/ubuntu`),
and regenerate whenever `index.html` changes — a stale copy silently tests old code.

Open `file:///home/ubuntu/rph-local-test.html?role=admin` (and `?role=resident`).
Google Fonts/CDN requests work if the box has network; jsPDF must load or PDF export will fail.

## Notes for UI testing

- Maximize the window with `wmctrl -i -r <win-id> -b add,maximized_vert,maximized_horz`; the app
  is a narrow mobile-width column centered in the viewport.
- Navigation is the bottom tab bar. Tabs differ by role: admin gets Residents + Approvals and the
  admin-only complaint filter bar / Export PDF buttons; residents get Profile and none of those.
- Money is rendered by `formatMoney()` as `PKR n,nnn` (`toLocaleString('en-PK')`). When verifying
  currency, zoom into the stat strip rather than trusting DOM text.
- Bill "overdue" is derived at render time from `dueDate < today` for unpaid bills — it is not a
  stored status, so seed data must use dates relative to the box's current date (check with `date`).
- PDF exports (jsPDF `doc.save`) land in `~/Downloads`. Verify contents with
  `pdftotext -layout <file> -` (poppler-utils). This is the only reliable way to assert PDF text.
- Alerts/confirms are native dialogs — click through them with computer use, and after a
  `confirm()`-driven mutation re-check the list/totals to prove the state actually changed.
- Stub state is in memory only: reloading the page resets all data, which is handy for isolating
  tests but means totals restart from the seeded baseline.

## Devin Secrets Needed

None. Real Firebase credentials are NOT required (and were not available) for local UI testing;
anything that requires real Firestore persistence or real auth cannot be covered by this approach.
