// App-screen smoke + regression tests. Runs the real index.html (built into
// tests/.out/t.html by build-harness.mjs) against the in-memory Firebase mock.
// Run: npm run ui   (from tests/).  Screenshots of failures land in tests/.out/shots/.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PAGE = pathToFileURL(join(here, '.out', 't.html')).href;
const SHOTS = join(here, '.out', 'shots');
mkdirSync(SHOTS, { recursive: true });
const VIEWPORT = { width: 360, height: 780 };
const ROLES = ['resident', 'admin', 'board', 'superadmin'];
const ERROR_TEXT = /Could not|Error|\bundefined\b|\bNaN\b/;

// ---------- tiny runner ----------
const tests = [];
const test = (name, fn, role) => tests.push({ name, fn, role });

// CI installs Chromium with `npx playwright install`; set PLAYWRIGHT_BROWSERS_PATH
// (or CHROMIUM_PATH) to use a browser that is already on your machine.
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

// A failed external load (fonts, cdnjs, certificates) is tolerated; any page
// error or other console error fails the test.
const IGNORABLE = /Failed to load resource|net::ERR_|ERR_CERT|fonts\.g|cdnjs|ERR_NAME_NOT_RESOLVED/i;

async function open(role) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    if (m.type() === 'error' && !IGNORABLE.test(m.text())) page.errors.push('console.error: ' + m.text().slice(0, 300));
  });
  page.on('dialog', d => { page.errors.push('native dialog: ' + d.message().slice(0, 120)); d.dismiss().catch(() => {}); });
  await page.goto(`${PAGE}?role=${role}`);
  await page.waitForSelector('main', { timeout: 15000 });
  await settle(page);
  return page;
}

// Wait until the main screen has finished its "Loading…" placeholders.
async function settle(page, scope = 'main') {
  await page.waitForFunction(sel => {
    const el = document.querySelector(sel);
    return el && !/Loading/.test(el.innerText);
  }, scope, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(150);
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function noErrors(page) { assert(!page.errors.length, page.errors.join('\n      ')); }

// Fire-and-forget: functions that await an in-app confirm sheet would hang evaluate().
const callLater = (page, expr) => page.evaluate(e => { setTimeout(() => (0, eval)(e), 0); }, expr);

// ---------- per-role smoke ----------
for (const role of ROLES) {
  test(`${role}: loads, every More tab renders, no sideways scroll`, async page => {
    noErrors(page);
    await page.evaluate(() => openMoreSheet());
    await page.waitForSelector('.more-grid button', { timeout: 5000 });
    const tabs = await page.$$eval('.more-grid button', bs => bs.map(b => (b.getAttribute('onclick').match(/selectTab\('(\w+)'\)/) || [])[1]).filter(Boolean));
    assert(tabs.length > 0, 'More sheet has no tabs');
    const problems = [];
    for (const tab of new Set(['dashboard', ...tabs])) {
      await page.evaluate(t => selectTab(t), tab);
      await settle(page);
      const r = await page.evaluate(re => {
        const text = document.querySelector('main').innerText;
        const m = text.match(new RegExp('.{0,40}(' + re + ').{0,40}'));
        // html/body use overflow-x:hidden, so also measure body (which clips wide content).
        return { bad: m && m[0], sw: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), iw: window.innerWidth };
      }, ERROR_TEXT.source);
      if (r.bad) problems.push(`${tab}: shows "${r.bad.replace(/\s+/g, ' ')}"`);
      if (r.sw > r.iw + 1) problems.push(`${tab}: page scrolls sideways (${r.sw}px > ${r.iw}px)`);
    }
    await page.evaluate(() => openNotificationsModal());
    await page.waitForTimeout(400);
    assert(!problems.length, problems.join('\n      '));
    noErrors(page);
  }, role);
}

// ---------- regression scenarios ----------
const bill = (page, pred) => page.evaluate(p => {
  const f = new Function('b', 'return ' + p);
  for (const [id, b] of window.__mockStore.bills) if (!b.isDeleted && f(b)) return { id, ...b };
  return null;
}, pred);

test('admin: Defaulters reads fresh bills (not a stale cache)', async page => {
  // Pick an overdue house and mark all its overdue bills submitted after login.
  const target = await bill(page, `b.status === 'unpaid' && b.dueDate < new Date().toISOString().slice(0, 10) && b.name`);
  assert(target, 'no overdue bill in mock data');
  // Each defaulter card ends "· overdue since <date>" when it has an overdue bill.
  const isOverdue = () => page.evaluate(name => [...document.querySelectorAll('#modal-body .card')]
    .some(c => c.innerText.includes(name) && /overdue since/.test(c.innerText)), target.name);
  // Load the bills once so the app has a cache, then change the data behind it.
  await page.evaluate(() => openDefaultersModal());
  await page.waitForFunction(() => /Defaulters/.test(document.getElementById('modal-body').innerText), null, { timeout: 8000 });
  assert(await isOverdue(), `${target.name} not listed as overdue to begin with`);
  await page.evaluate(() => closeModal());
  await page.evaluate(uid => {
    const today = new Date().toISOString().slice(0, 10);
    // Replace the docs (not mutate them) so objects the app already holds stay stale.
    for (const [id, b] of window.__mockStore.bills) if (b.uid === uid && b.status === 'unpaid' && b.dueDate < today) window.__mockStore.bills.set(id, { ...b, status: 'submitted' });
  }, target.uid);
  await page.evaluate(() => openDefaultersModal());
  await page.waitForFunction(() => /Defaulters/.test(document.getElementById('modal-body').innerText), null, { timeout: 8000 });
  assert(!(await isOverdue()), `${target.name} still listed as overdue after their bills were submitted`);
  noErrors(page);
}, 'admin');

test('admin: approving a proof marks the bill paid and updates the dashboard tiles', async page => {
  await page.waitForSelector('.need-tiles', { timeout: 8000 });
  const before = await page.$eval('.need-tiles', el => el.innerText);
  await page.evaluate(() => openNextProof());
  const approve = page.locator('#modal-body button', { hasText: 'Approve' }).first();
  await approve.waitFor({ timeout: 8000 });
  const billNo = await page.evaluate(() => (document.getElementById('modal-body').innerText.match(/BILL-\d+/) || [])[0]);
  assert(billNo, 'bill number not shown in the proof sheet');
  await approve.click();
  await page.locator('[data-ui=ok]').click({ timeout: 5000 });
  await page.waitForFunction(no => [...window.__mockStore.bills.values()].some(b => b.billNo === no && b.status === 'paid'), billNo, { timeout: 8000 })
    .catch(() => { throw new Error(`${billNo} not marked paid in the store`); });
  await page.waitForFunction(b => { const el = document.querySelector('.need-tiles'); return el && el.innerText !== b; }, before, { timeout: 8000 })
    .catch(() => { throw new Error(`dashboard tiles did not update after approval (still "${before.replace(/\s+/g, ' ')}")`); });
  noErrors(page);
}, 'admin');

test('admin: tapping the current tab reloads it', async page => {
  await page.evaluate(() => selectTab('tickets'));
  await settle(page);
  await page.evaluate(() => window.__mockStore.tickets.set('t_ci', {
    ticketNo: 'TKT-9876', category: 'Other', subject: 'CI check', description: 'Added by the UI test',
    uid: 'u_res1', name: 'Ayesha Siddiqui', house: 'House 14, Block B', status: 'pending',
    createdAt: firebase.firestore.Timestamp.now()
  }));
  await page.evaluate(() => selectTab('tickets'));
  await page.waitForFunction(() => document.querySelector('main').innerText.includes('TKT-9876'), null, { timeout: 8000 })
    .catch(() => { throw new Error('new ticket TKT-9876 not shown after re-selecting the Complaints tab'); });
  noErrors(page);
}, 'admin');

test('board: residents directory shows the ⋮ menu buttons', async page => {
  await page.evaluate(() => selectTab('biodata'));
  await page.waitForSelector('#residents-list .dots-btn', { timeout: 8000 })
    .catch(() => { throw new Error('no ⋮ buttons in #residents-list for the board role'); });
  noErrors(page);
}, 'board');

test('resident: one proof covers two bills and is stored once', async page => {
  await page.evaluate(() => openUploadProofModal('b302114'));
  await page.waitForSelector('.proof-bill', { timeout: 5000 });
  await page.evaluate(() => {
    const cb = [...document.querySelectorAll('.proof-bill')].find(c => c.value === 'bx1');
    cb.checked = true; cb.dispatchEvent(new Event('change'));
  });
  await page.setInputFiles('#proof-file', { name: 'proof.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') });
  await page.click('#proof-form button[type=submit]');
  await page.waitForFunction(() => ['b302114', 'bx1'].every(k => window.__mockStore.bills.get(k).status === 'submitted'), null, { timeout: 8000 })
    .catch(() => { throw new Error('both ticked bills should be in review'); });
  const r = await page.evaluate(() => {
    const a = window.__mockStore.bills.get('b302114'), b = window.__mockStore.bills.get('bx1');
    return { same: a.proofId && a.proofId === b.proofId && a.proofBatch === b.proofBatch, inline: !!(a.proofData || b.proofData), files: window.__mockStore.proofs.size };
  });
  assert(r.same, 'bills do not share one proof');
  assert(!r.inline, 'proof photo was stored inside the bill');
  assert(r.files === 1, `expected 1 stored proof file, found ${r.files}`);
  noErrors(page);
}, 'resident');

test('admin: approving a shared proof marks every bill in it paid', async page => {
  await page.evaluate(async () => {
    const ref = await firebase.firestore().collection('proofs').add({ uid: 'u_res1', kind: 'bill', data: 'data:image/png;base64,AA==', type: 'image' });
    ['b302114', 'bx1'].forEach(k => Object.assign(window.__mockStore.bills.get(k), { status: 'submitted', proofId: ref.id, proofBatch: ref.id, proofType: 'image', proofData: '' }));
    selectTab('bills');
  });
  await settle(page);
  await callLater(page, "approveBillProof('bx1')");
  await page.locator('[data-ui=ok]').click({ timeout: 5000 });
  await page.waitForFunction(() => ['b302114', 'bx1'].every(k => window.__mockStore.bills.get(k).status === 'paid'), null, { timeout: 8000 })
    .catch(() => { throw new Error('both bills in the shared proof should be paid'); });
  noErrors(page);
}, 'admin');

// ---------- run ----------
let passed = 0, failed = 0;
for (const t of tests) {
  const role = t.role;
  let page;
  try {
    page = await open(role);
    await t.fn(page);
    passed++; console.log(`ok    ${t.name}`);
  } catch (e) {
    failed++; console.log(`FAIL  ${t.name}\n      ${e.message.split('\n').join('\n      ')}`);
    if (page) await page.screenshot({ path: join(SHOTS, t.name.replace(/[^\w-]+/g, '_').slice(0, 80) + '.png') }).catch(() => {});
  } finally {
    if (page) await page.context().close();
  }
}
await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
