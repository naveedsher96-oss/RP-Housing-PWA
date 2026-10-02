# Automated checks (run on every pull request by `.github/workflows/checks.yml`)

- **App screens** (`ui.test.mjs`): opens the real `index.html` with a fake Firebase (`firebase-mock.js`, sample society data) as resident, admin, board and super admin on a 360px phone screen. Fails on any JavaScript error, a tab showing "Could not / Error / undefined / NaN", sideways scrolling, or a return of fixed bugs (stale Defaulters, proof approval, tab reload, board ⋮ menu).
- **Firebase rules** (`rules.test.mjs`): checks `../firestore.rules` in the Firestore emulator; who may read/write what. Add a case by appending one line to `CASES`.

Run locally from this folder (Node 20+; Java 11+ for rules):
`npm ci && npx playwright install chromium`, then `npm run ui` and `npm run rules`.
Failure screenshots go to `tests/.out/shots/`.
