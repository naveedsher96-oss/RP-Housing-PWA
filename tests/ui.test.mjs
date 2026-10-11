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
  const filesBefore = await page.evaluate(() => (window.__mockStore.proofs || new Map()).size);
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
  assert(r.files === filesBefore + 1, `expected 1 new stored proof file, found ${r.files - filesBefore}`);
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

// ---------- complaints: photos, timeline, rating ----------
const PNG1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('resident: lodging a complaint with a photo stores the photo separately and starts the timeline', async page => {
  await page.evaluate(() => { selectTab('tickets'); });
  await settle(page);
  const before = await page.evaluate(() => ({ tickets: window.__mockStore.tickets.size, proofs: window.__mockStore.proofs.size }));
  await page.evaluate(() => openNewTicketModal());
  await page.waitForSelector('#ticket-form', { timeout: 5000 });
  await page.selectOption('#ticket-category', 'Water Supply');
  await page.fill('#ticket-desc', 'No water in Block B since morning.');
  await page.setInputFiles('#ticket-photo-file', { name: 'tap.png', mimeType: 'image/png', buffer: PNG1 });
  await page.waitForSelector('#ticket-photo-preview .ticket-photo', { timeout: 5000 });
  await page.click('#ticket-form button[type=submit]');
  await page.waitForFunction(n => window.__mockStore.tickets.size === n + 1, before.tickets, { timeout: 8000 })
    .catch(() => { throw new Error('ticket was not created'); });
  const r = await page.evaluate(() => {
    const t = [...window.__mockStore.tickets.values()].find(x => x.description === 'No water in Block B since morning.');
    return { photos: (t.photoIds || []).length, inline: JSON.stringify(t).includes('base64'), history: (t.history || []).length, proofs: window.__mockStore.proofs.size, status: t.status };
  });
  assert(r.photos === 1, `expected 1 photo id, got ${r.photos}`);
  assert(!r.inline, 'photo data was stored inside the ticket');
  assert(r.proofs === before.proofs + 1, 'photo was not stored in proofs');
  assert(r.history === 1 && r.status === 'pending', 'timeline should start with one "lodged" entry');
  await settle(page);
  const card = await page.evaluate(() => document.getElementById('tickets-list').innerText);
  assert(/1 photo/.test(card), 'card should show the photo count');
  noErrors(page);
}, 'resident');

test('admin: status update with a note appends to the timeline and notifies the resident', async page => {
  await page.evaluate(() => { selectTab('tickets'); });
  await settle(page);
  const summary = await page.evaluate(() => document.getElementById('ticket-filter-summary').innerText);
  assert(/Over 7 days: 2/.test(summary), `admin summary should flag complaints open over 7 days, got: ${summary}`);
  const list = await page.evaluate(() => document.getElementById('tickets-list').innerText);
  assert(/⚠ Open 25 days/.test(list), 'card for the 25-day-old complaint should carry the SLA flag');
  await page.evaluate(() => openTicketDetailModal('t1'));
  await page.waitForSelector('#admin-ticket-form', { timeout: 5000 });
  await page.waitForSelector('#ticket-photos .ticket-photo img', { timeout: 5000 }).catch(() => { throw new Error('detail should show the attached photo'); });
  assert(await page.locator('#ticket-photos .ticket-photo img').count() === 1, 'detail should show exactly one attached photo');
  await page.selectOption('#admin-ticket-status', 'in-progress');
  await page.fill('#admin-ticket-dept', 'Electrical');
  await page.fill('#admin-ticket-note', 'Electrician visiting tomorrow');
  await page.click('#admin-ticket-form button[type=submit]');
  await page.waitForFunction(() => window.__mockStore.tickets.get('t1').status === 'in-progress', null, { timeout: 8000 })
    .catch(() => { throw new Error('status did not change'); });
  await page.waitForFunction(() => [...(window.__mockStore['users/u_res1/notifications'] || new Map()).values()].some(n => /Electrician/.test(n.body)), null, { timeout: 8000 })
    .catch(() => {});
  const r = await page.evaluate(() => {
    const t = window.__mockStore.tickets.get('t1');
    const notifs = [...(window.__mockStore['users/u_res1/notifications'] || new Map()).values()];
    return { history: t.history.map(h => h.status), note: t.history[t.history.length - 1].note, notified: notifs.some(n => /RPHS|TKT-4821/.test(n.title) && /Electrician/.test(n.body)) };
  });
  assert(r.history.join(',') === 'pending,in-progress', `timeline is ${r.history.join(',')}`);
  assert(r.note === 'Electrician visiting tomorrow', 'note was not kept in the timeline');
  assert(r.notified, 'resident did not get the note in a notification');
  noErrors(page);
}, 'admin');

test('resident: can rate a closed complaint once and reopen it', async page => {
  await page.evaluate(() => { selectTab('tickets'); });
  await settle(page);
  await page.evaluate(() => openTicketDetailModal('t4'));
  await page.waitForSelector('#ticket-rate-form', { timeout: 5000 });
  await page.click('#ticket-stars .star-btn[data-n="4"]');
  await page.fill('#ticket-rate-comment', 'Guard was posted the same week.');
  await page.click('#ticket-rate-form button[type=submit]');
  await page.waitForFunction(() => (window.__mockStore.tickets.get('t4').rating || {}).stars === 4, null, { timeout: 8000 })
    .catch(() => { throw new Error('rating was not saved'); });
  await settle(page);
  await page.evaluate(() => openTicketDetailModal('t4'));
  await page.waitForSelector('#modal-view.active', { timeout: 5000 });
  assert(await page.locator('#ticket-rate-form').count() === 0, 'rating form should disappear once rated');
  await callLater(page, "reopenTicket('t4')");
  await page.waitForSelector('#ui-sheet-input', { timeout: 5000 });
  await page.fill('#ui-sheet-input', 'The motorbike is back again.');
  await page.click('#ui-sheet-form button[type=submit]');
  await page.waitForFunction(() => window.__mockStore.tickets.get('t4').status === 'pending', null, { timeout: 8000 })
    .catch(() => { throw new Error('complaint was not reopened'); });
  const h = await page.evaluate(() => window.__mockStore.tickets.get('t4').history.map(x => x.status).join(','));
  assert(/pending$/.test(h), `timeline after reopen is ${h}`);
  noErrors(page);
}, 'resident');

// ---------- documents vault & meetings (C3) ----------
test('resident: sees shared documents, opens an image, and suggests an agenda item', async page => {
  await page.evaluate(() => selectTab('documents'));
  await settle(page);
  let text = await page.evaluate(() => document.getElementById('documents-body').innerText);
  assert(/Society Bylaws/.test(text) && /Approved Budget/.test(text) && /Gate Pass/.test(text), 'seeded documents should be listed');
  assert(!/Old parking policy/.test(text), 'archived document must not be shown');
  assert(await page.locator('#documents-body .dots-btn').count() === 0, 'residents must not get document menus');
  await page.evaluate(() => setDocCategory('Forms'));
  text = await page.evaluate(() => document.getElementById('documents-body').innerText);
  assert(/Gate Pass/.test(text) && !/Society Bylaws/.test(text), 'category chip should filter the list');
  await page.evaluate(() => openDocument('doc2'));
  await page.waitForSelector('#ui-sheet img', { timeout: 5000 }).catch(() => { throw new Error('image document should open in a sheet'); });
  await page.evaluate(() => goBack()); // closes the sheet

  await page.evaluate(() => setDocsView('meetings'));
  await settle(page);
  text = await page.evaluate(() => document.getElementById('documents-body').innerText);
  assert(/Upcoming · 1/i.test(text) && /Minutes of past meetings · 1/i.test(text), `meetings should be grouped, got: ${text.slice(0, 120)}`);
  assert(/Suggested by Muhammad Usman Khan/.test(text), 'resident suggestions should be credited');
  assert(/CCTV quotation from SafeVision reviewed/.test(text) && /Approved/.test(text), 'held meeting should show minutes and decision outcomes');
  assert(await page.locator('#documents-body .agenda-x').count() === 0, 'residents must not be able to remove agenda items');
  callLater(page, "suggestAgendaItem('m1')");
  await page.waitForSelector('#ui-sheet-input', { timeout: 5000 });
  await page.fill('#ui-sheet-input', 'Fix the street lights in Block B');
  await page.click('#ui-sheet-form button[type=submit]');
  await page.waitForFunction(() => window.__mockStore.meetings.get('m1').agenda.length === 4, null, { timeout: 8000 })
    .catch(() => { throw new Error('suggestion was not added to the agenda'); });
  const last = await page.evaluate(() => window.__mockStore.meetings.get('m1').agenda[3]);
  assert(last.source === 'resident' && last.byUid === 'u_res1' && last.text === 'Fix the street lights in Block B', `suggestion stored wrongly: ${JSON.stringify(last)}`);
  await settle(page);
  text = await page.evaluate(() => document.getElementById('documents-body').innerText);
  assert(/Fix the street lights in Block B/.test(text) && /\(you\)/.test(text), 'card should show the new suggestion as yours');
  noErrors(page);
}, 'resident');

test('admin: adds a document by link and residents are notified', async page => {
  await page.evaluate(() => selectTab('documents'));
  await settle(page);
  const before = await page.evaluate(() => window.__mockStore.documents.size);
  await page.evaluate(() => openAddDocumentModal());
  await page.waitForSelector('#doc-form', { timeout: 5000 });
  await page.fill('#doc-title', 'Water Tanker Rate Card');
  await page.selectOption('#doc-category', 'Notices & Circulars');
  await page.fill('#doc-link', 'https://drive.google.com/file/d/tanker/view');
  await page.click('#doc-form button[type=submit]');
  await page.waitForFunction(n => window.__mockStore.documents.size === n + 1, before, { timeout: 8000 })
    .catch(() => { throw new Error('document was not created'); });
  await page.waitForFunction(() => [...(window.__mockStore['users/u_res1/notifications'] || new Map()).values()].some(n => /Water Tanker Rate Card/.test(n.title)), null, { timeout: 8000 })
    .catch(() => { throw new Error('residents were not notified about the new document'); });
  const d = await page.evaluate(() => [...window.__mockStore.documents.values()].find(x => x.title === 'Water Tanker Rate Card'));
  assert(d.link === 'https://drive.google.com/file/d/tanker/view' && d.category === 'Notices & Circulars' && d.createdBy === 'u_admin', `document stored wrongly: ${JSON.stringify(d)}`);
  await settle(page);
  const text = await page.evaluate(() => document.getElementById('documents-body').innerText);
  assert(/Water Tanker Rate Card/.test(text) && /Open link/.test(text), 'new document should appear with an Open link button');
  noErrors(page);
}, 'admin');

test('admin: publishes minutes with linked decisions; meeting moves to past and residents are notified', async page => {
  await page.evaluate(() => { setDocsView('meetings'); selectTab('documents'); });
  await settle(page);
  assert(await page.locator('#documents-body .agenda-x').count() === 3, 'admin should be able to remove each agenda item');
  await page.evaluate(() => openPublishMinutesModal('m1'));
  await page.waitForSelector('#minutes-form', { timeout: 5000 });
  await page.click('#minutes-form button.btn.sm.secondary'); // "Start from the agenda"
  const prefilled = await page.inputValue('#mn-text');
  assert(/1\. Approve September accounts/.test(prefilled), 'minutes should prefill from the agenda');
  await page.fill('#mn-text', prefilled + '\nAccounts approved unanimously.');
  await page.fill('#mn-attendees', 'Tariq Mehmood, Hina Shahid');
  await page.check('.mn-dec[value="d1"]');
  await page.click('#minutes-form button[type=submit]');
  await page.waitForFunction(() => window.__mockStore.meetings.get('m1').status === 'held', null, { timeout: 8000 })
    .catch(() => { throw new Error('meeting did not move to held'); });
  await page.waitForFunction(() => [...(window.__mockStore['users/u_res1/notifications'] || new Map()).values()].some(n => /Minutes published/.test(n.title)), null, { timeout: 8000 })
    .catch(() => { throw new Error('residents were not notified about the minutes'); });
  const m = await page.evaluate(() => window.__mockStore.meetings.get('m1'));
  assert(/Accounts approved unanimously/.test(m.minutes), 'minutes text was not saved');
  assert(m.decisions.length === 1 && m.decisions[0].id === 'd1' && m.decisions[0].title.includes('CCTV'), `linked decisions wrong: ${JSON.stringify(m.decisions)}`);
  assert(m.suggestionsOpen === false && m.minutesPublishedAt, 'publishing should close suggestions and stamp the time');
  await settle(page);
  const text = await page.evaluate(() => document.getElementById('documents-body').innerText);
  assert(/Upcoming · 0/i.test(text) && /Minutes of past meetings · 2/i.test(text), `meeting should now be listed under past, got: ${text.slice(0, 160)}`);
  assert(/Present: Tariq Mehmood, Hina Shahid/.test(text), 'attendees should be shown');
  noErrors(page);
}, 'admin');

test('admin: can lodge a complaint of their own', async page => {
  await page.evaluate(() => selectTab('tickets'));
  await settle(page);
  const hasBtn = await page.evaluate(() => /Lodge Ticket/.test(document.querySelector('main .section-title').innerText));
  assert(hasBtn, 'staff should see the Lodge Ticket button');
  const before = await page.evaluate(() => window.__mockStore.tickets.size);
  await page.evaluate(() => openNewTicketModal());
  await page.waitForSelector('#ticket-form', { timeout: 5000 });
  await page.selectOption('#ticket-category', 'Security & Gate');
  await page.fill('#ticket-desc', 'Back gate lock is broken.');
  await page.click('#ticket-form button[type=submit]');
  await page.waitForFunction(n => window.__mockStore.tickets.size === n + 1, before, { timeout: 8000 })
    .catch(() => { throw new Error('staff complaint was not created'); });
  const t = await page.evaluate(() => [...window.__mockStore.tickets.values()].find(x => x.description === 'Back gate lock is broken.'));
  assert(t.uid === 'u_admin' && t.status === 'pending', `ticket stored wrongly: ${JSON.stringify(t)}`);
  await settle(page);
  assert(/Back gate lock is broken/.test(await page.evaluate(() => document.getElementById('tickets-list').innerText)), 'new complaint should appear in the staff list');
  noErrors(page);
}, 'admin');

test('resident: active emergency is pinned on the dashboard with contacts; no broadcast controls', async page => {
  const text = await page.evaluate(() => document.getElementById('dashboard-body').innerText);
  assert(/Gas leak near House 24/.test(text) && /EMERGENCY · GAS LEAK/i.test(text), `active emergency should be pinned on top, got: ${text.slice(0, 160)}`);
  assert(!/Stray dog pack/.test(text), 'resolved emergency must not be pinned');
  assert(/Emergency Contacts/.test(text) && /Main gate security/.test(text), 'emergency contacts card should list society contacts');
  const tel = await page.$eval('#emg-contacts-card .contact-call', a => a.getAttribute('href'));
  assert(tel === 'tel:03001112233', `Call button should dial the number, got ${tel}`);
  assert(await page.locator('.emg-btn').count() === 0, 'residents must not see the broadcast button');
  assert(!/Mark resolved/.test(text), 'residents must not be able to resolve emergencies');
  assert(await page.locator('#emg-contacts-card .btn:has-text("Edit")').count() === 0, 'residents must not edit contacts');
  await page.evaluate(() => openEmergencyContactsModal());
  await page.waitForSelector('#emg-contacts-all', { timeout: 5000 });
  assert(await page.locator('#emg-contacts-all .contact-row').count() === 7, 'all 7 contacts should be listed in the sheet');
  await page.evaluate(() => closeModal());
  await page.evaluate(() => selectTab('notices'));
  await settle(page);
  const notices = await page.evaluate(() => document.getElementById('notices-list').innerText);
  assert(/Gas leak near House 24/.test(notices) && /Resolved/i.test(notices), 'announcements should show both the active and the resolved emergency');
  noErrors(page);
}, 'resident');

test('board: sees the emergency banner but cannot broadcast or edit contacts', async page => {
  const text = await page.evaluate(() => document.getElementById('dashboard-body').innerText);
  assert(/Gas leak near House 24/.test(text), 'board should see the pinned emergency');
  assert(await page.locator('.emg-btn').count() === 0 && !/Mark resolved/.test(text), 'board must not get broadcast/resolve controls');
  noErrors(page);
}, 'board');

test('admin: sends an emergency broadcast (two-step confirm), everyone is alerted, then resolves it', async page => {
  assert(await page.locator('.emg-btn').count() === 1, 'admin should see the Send Emergency Alert button');
  const before = await page.evaluate(() => window.__mockStore.announcements.size);
  await page.evaluate(() => openEmergencyModal());
  await page.waitForSelector('#emg-form', { timeout: 5000 });
  await page.click('#emg-types .chip[data-type="fire"]');
  await page.fill('#emg-title', 'Fire at the community hall');
  await page.fill('#emg-content', 'Keep away from the hall. Rescue 1122 is on the way.');
  await page.evaluate(() => { document.getElementById('emg-share-wa').checked = false; });
  await page.click('#emg-send');
  await page.waitForSelector('#emg-confirm:visible', { timeout: 3000 });
  assert(await page.evaluate(n => window.__mockStore.announcements.size === n, before), 'first tap must only ask for confirmation');
  await page.click('#emg-send');
  await page.waitForFunction(n => window.__mockStore.announcements.size === n + 1, before, { timeout: 8000 })
    .catch(() => { throw new Error('emergency announcement was not created'); });
  const a = await page.evaluate(() => [...window.__mockStore.announcements.entries()].map(([id, x]) => ({ id, ...x })).find(x => x.title === 'Fire at the community hall'));
  assert(a.emergency === true && a.emergencyType === 'fire' && a.createdBy === 'u_admin' && a.allowComments === false, `stored wrongly: ${JSON.stringify(a)}`);
  await page.waitForFunction(() => [...(window.__mockStore['users/u_res1/notifications'] || new Map()).values()].some(n => /EMERGENCY: Fire at the community hall/.test(n.title) && n.category === 'emergency' && n.type === 'error'), null, { timeout: 8000 })
    .catch(() => { throw new Error('residents did not get the emergency notification'); });
  await settle(page);
  let text = await page.evaluate(() => document.getElementById('dashboard-body').innerText);
  assert(/Fire at the community hall/.test(text) && /Mark resolved/.test(text), 'new emergency should be pinned with a resolve button');

  callLater(page, `resolveEmergency('${a.id}')`);
  await page.waitForSelector('#ui-sheet [data-ui="ok"]', { timeout: 5000 });
  await page.click('#ui-sheet [data-ui="ok"]');
  await page.waitForFunction(id => !!window.__mockStore.announcements.get(id).resolvedAt, a.id, { timeout: 8000 })
    .catch(() => { throw new Error('emergency was not marked resolved'); });
  await page.waitForFunction(() => [...(window.__mockStore['users/u_res1/notifications'] || new Map()).values()].some(n => /All clear: Fire at the community hall/.test(n.title)), null, { timeout: 8000 })
    .catch(() => { throw new Error('residents did not get the all-clear'); });
  await settle(page);
  text = await page.evaluate(() => document.getElementById('dashboard-body').innerText);
  assert(!/Fire at the community hall/.test(text), 'resolved emergency should leave the dashboard');
  noErrors(page);
}, 'admin');

test('superadmin: edits the emergency contacts list', async page => {
  await page.evaluate(() => openEditEmergencyContactsModal());
  await page.waitForSelector('#emg-contacts-form', { timeout: 5000 });
  assert(await page.locator('#emg-contact-rows .contact-edit').count() === 7, 'editor should start from the saved contacts');
  await page.click('#emg-contact-rows .contact-edit:first-child .dots-btn');
  await page.evaluate(() => addEmergencyContactRow());
  await page.fill('#emg-contact-rows .contact-edit:last-child .ce-label', 'Plumber – Akram');
  await page.fill('#emg-contact-rows .contact-edit:last-child .ce-phone', '0301-5556677');
  await page.click('#emg-contacts-form button[type=submit]');
  await page.waitForFunction(() => { const s = window.__mockStore.settings.get('emergencyContacts'); return s && s.contacts.length === 7 && s.contacts[6].label === 'Plumber – Akram'; }, null, { timeout: 8000 })
    .catch(() => { throw new Error('contacts were not saved'); });
  const saved = await page.evaluate(() => window.__mockStore.settings.get('emergencyContacts').contacts);
  assert(saved[0].label !== 'Main gate security (24h)' && saved[6].phone === '0301-5556677', `saved wrongly: ${JSON.stringify(saved.map(c => c.label))}`);
  await settle(page);
  await page.evaluate(() => openEmergencyContactsModal());
  await page.waitForSelector('#emg-contacts-all', { timeout: 5000 });
  const text = await page.evaluate(() => document.getElementById('emg-contacts-all').innerText);
  assert(/Plumber – Akram/.test(text) && !/Main gate security/.test(text), 'sheet should show the updated list');
  noErrors(page);
}, 'superadmin');

test('admin: saving an old View bill screen never undoes a payment', async page => {
  await page.evaluate(() => selectTab('bills'));
  await settle(page);
  const id = await page.evaluate(() => {
    const [id] = [...window.__mockStore.bills.entries()].find(([, v]) => v.status === 'unpaid' && v.uid !== 'u_admin');
    openBillDetailModal(id);
    Object.assign(window.__mockStore.bills.get(id), { status: 'paid' }); // another admin approves meanwhile
    return id;
  });
  await page.fill('#admin-bill-ref', 'HBL 123');
  await page.click('#admin-bill-form button[type=submit]');
  await page.waitForFunction(id => window.__mockStore.bills.get(id).paymentRef === 'HBL 123', id, { timeout: 8000 })
    .catch(() => { throw new Error('payment reference was not saved'); });
  const st = await page.evaluate(id => window.__mockStore.bills.get(id).status, id);
  assert(st === 'paid', `bill went back to "${st}" after saving an old screen`);
  noErrors(page);
}, 'admin');

test('admin: issuing a bill never doubles up the same month', async page => {
  await page.evaluate(() => selectTab('bills'));
  await settle(page);
  const fill = async who => {
    await page.evaluate(() => openIssueBillModal());
    await page.waitForSelector('#bill-form');
    await page.evaluate(who => {
      document.getElementById('bill-resident').value = who;
      document.getElementById('bill-category').value = 'Monthly Maintenance';
      document.getElementById('bill-period').value = 'September 2026';
    }, who);
    await page.fill('#bill-amount', '2500');
    await page.click('#bill-form button[type=submit]');
  };
  const count = () => page.evaluate(() => window.__mockStore.bills.size);
  const before = await count();
  await fill('u_res1'); // already has a September bill
  await page.waitForSelector('text=Already billed for this month', { timeout: 8000 });
  await page.click("text=Don't issue");
  await page.waitForTimeout(500);
  assert(await count() === before, 'a second September bill was issued after "Don\'t issue"');
  await page.evaluate(() => closeModal());
  await fill('__all__');
  await page.waitForSelector('text=/skipped \\d+ already billed|Everyone already has/', { timeout: 8000 })
    .catch(() => { throw new Error('bulk issue did not skip residents already billed'); });
  const dupes = await page.evaluate(() => {
    const seen = {}; let d = 0;
    for (const b of window.__mockStore.bills.values()) {
      if (b.isDeleted || b.status === 'cancelled' || b.period !== 'September 2026' || b.category !== 'Monthly Maintenance') continue;
      if (seen[b.uid]) d++; seen[b.uid] = 1;
    }
    return d;
  });
  assert(dupes === 0, `${dupes} resident(s) got two September bills`);
  noErrors(page);
}, 'admin');

test('admin: duplicate bills are listed and the extras removed, keeping the paid one', async page => {
  const ids = await page.evaluate(() => {
    const s = window.__mockStore.bills;
    const [paidId, b] = [...s.entries()].find(([, v]) => v.status === 'paid' && v.period === 'September 2026');
    s.set('dupA', Object.assign({}, b, { billNo: 'BILL-DUP001', status: 'unpaid', paidAt: null }));
    selectTab('bills');
    return { paidId };
  });
  await settle(page);
  await page.waitForSelector('#dup-bills-banner >> text=1 duplicate bill', { timeout: 8000 });
  await page.evaluate(() => openDuplicateBillsModal());
  await page.click('#dup-remove-btn');
  await page.click('[data-ui="ok"]');
  await page.waitForFunction(() => window.__mockStore.bills.get('dupA').isDeleted === true, null, { timeout: 8000 })
    .catch(() => { throw new Error('the duplicate bill was not removed'); });
  const kept = await page.evaluate(id => window.__mockStore.bills.get(id), ids.paidId);
  assert(!kept.isDeleted && kept.status === 'paid', 'the paid bill was removed instead of the duplicate');
  noErrors(page);
}, 'admin');

test('admin: a September bill due in October stays under September', async page => {
  await page.evaluate(() => {
    const s = window.__mockStore.bills;
    const [, b] = [...s.entries()].find(([, v]) => v.status === 'paid' && v.period === 'September 2026');
    s.set('lateSep', Object.assign({}, b, { billNo: 'BILL-LATESEP', name: 'Zed Latesep', dueDate: '2026-10-20' }));
    selectTab('bills');
  });
  await settle(page);
  await page.evaluate(() => { setBillFilter('paid'); setBillMonth('2026-10'); });
  await page.waitForTimeout(500);
  assert(!(await page.locator('#bills-list').innerText()).includes('Zed Latesep'), 'September bill shows under October');
  await page.evaluate(() => setBillMonth('2026-09'));
  await page.waitForTimeout(500);
  assert((await page.locator('#bills-list').innerText()).includes('Zed Latesep'), 'September bill missing under September');
  noErrors(page);
}, 'admin');

test('admin: bulk issue leaves out members exempt from the monthly bill', async page => {
  await page.evaluate(() => {
    window.__mockStore.users.get('u_res1').billExempt = true;
    selectTab('bills');
  });
  await settle(page);
  await page.evaluate(() => openIssueBillModal());
  await page.waitForSelector('#bill-form');
  await page.evaluate(() => {
    document.getElementById('bill-resident').value = '__all__';
    document.getElementById('bill-category').value = 'Monthly Maintenance';
    document.getElementById('bill-period').value = 'December 2026';
  });
  await page.fill('#bill-amount', '500');
  await page.click('#bill-form button[type=submit]');
  await page.waitForSelector('text=/Issued \\d+ bill/', { timeout: 8000 });
  const r = await page.evaluate(() => {
    const dec = [...window.__mockStore.bills.values()].filter(b => b.period === 'December 2026');
    return { n: dec.length, exempt: dec.some(b => b.uid === 'u_res1') };
  });
  assert(r.n > 0, 'no December bills were issued');
  assert(!r.exempt, 'an exempt member was billed by the bulk issue');
  noErrors(page);
}, 'admin');

test('resident: Lost & Found board lists open posts, opens a detail sheet with Call/WhatsApp, and can post a lost item', async page => {
  await page.evaluate(() => selectTab('market'));
  await settle(page);
  let text = await page.evaluate(() => document.getElementById('listings-body').innerText);
  assert(/Milo/.test(text) && /Honda CD70/.test(text) && /PKR 95,000/.test(text) && /Found: bunch of keys/.test(text), `open posts should be listed, got: ${text.slice(0, 200)}`);
  assert(!/Baby cot/.test(text) && !/Old spam post/.test(text), 'closed and removed posts must not be in the open list');
  await page.evaluate(() => setListingFilter('closed'));
  text = await page.evaluate(() => document.getElementById('listings-body').innerText);
  assert(/Baby cot/.test(text) && /Sold \/ gone/i.test(text), 'Resolved chip should show the closed post');
  await page.evaluate(() => setListingFilter('all'));
  await page.evaluate(() => openListingDetail('l2'));
  await page.waitForSelector('#listing-detail', { timeout: 5000 });
  const hrefs = await page.$$eval('#listing-detail a', as => as.map(a => a.getAttribute('href')));
  assert(hrefs.some(h => h === 'tel:0321-7654321') && hrefs.some(h => /wa\.me\/923217654321/.test(h)), `detail should offer Call and WhatsApp, got ${hrefs}`);
  assert(await page.locator('#listing-detail button:has-text("moderation")').count() === 0, 'residents must not get moderation controls');
  await page.evaluate(() => goBack());

  await page.evaluate(() => openNewListingModal());
  await page.waitForSelector('#listing-form', { timeout: 5000 });
  await page.evaluate(() => pickListingKind('lost'));
  await page.fill('#listing-title', 'Blue school bag with books');
  await page.fill('#listing-desc', 'Left in the park on Monday.');
  await page.fill('#listing-location', 'Park, Block B');
  await page.click('#listing-form button[type=submit]');
  await page.waitForFunction(() => [...window.__mockStore.listings.values()].some(l => l.title === 'Blue school bag with books'), null, { timeout: 8000 });
  const stored = await page.evaluate(() => [...window.__mockStore.listings.values()].find(l => l.title === 'Blue school bag with books'));
  assert(stored.kind === 'lost' && stored.createdBy === 'u_res1' && stored.status === 'open' && stored.createdByHouse, `listing stored wrongly: ${JSON.stringify(stored)}`);
  await page.waitForFunction(() => [...(window.__mockStore['users/u_r2/notifications'] || new Map()).values()].some(n => /Blue school bag/.test(n.title)), null, { timeout: 8000 })
    .catch(() => { throw new Error('other residents should be alerted about a lost item'); });
  await settle(page);
  text = await page.evaluate(() => document.getElementById('listings-body').innerText);
  assert(/Blue school bag/.test(text), 'new post should appear on the board');
  noErrors(page);
}, 'resident');

test('resident: marks own post as sold and it moves to Resolved', async page => {
  await page.evaluate(() => selectTab('market'));
  await settle(page);
  await page.evaluate(() => openListingDetail('l1'));
  await page.waitForSelector('#listing-detail', { timeout: 5000 });
  const btns = await page.$$eval('#listing-detail button', bs => bs.map(b => b.textContent.trim()));
  assert(btns.some(b => /Mark as returned/i.test(b)) && btns.some(b => /Edit/.test(b)) && btns.some(b => /Delete my post/.test(b)), `owner should get Mark/Edit/Delete, got ${btns}`);
  await page.evaluate(() => closeListing('l1'));
  await page.waitForFunction(() => window.__mockStore.listings.get('l1').status === 'closed', null, { timeout: 8000 });
  await settle(page);
  let text = await page.evaluate(() => document.getElementById('listings-body').innerText);
  assert(!/Milo/.test(text), 'closed post should leave the open list');
  await page.evaluate(() => setListingFilter('closed'));
  text = await page.evaluate(() => document.getElementById('listings-body').innerText);
  assert(/Milo/.test(text) && /Returned/i.test(text), 'closed post should be under Resolved with a Returned tag');
  noErrors(page);
}, 'resident');

test('admin: can moderate (remove) a resident post and the poster is told', async page => {
  await page.evaluate(() => selectTab('market'));
  await settle(page);
  await page.evaluate(() => openListingDetail('l4'));
  await page.waitForSelector('#listing-detail', { timeout: 5000 });
  assert(await page.locator('#listing-detail button:has-text("moderation")').count() === 1, 'staff should get the moderation remove button');
  callLater(page, "removeListing('l4')");
  await page.waitForSelector('#ui-sheet [data-ui="ok"]', { timeout: 5000 });
  await page.click('#ui-sheet [data-ui="ok"]');
  await page.waitForFunction(() => window.__mockStore.listings.get('l4').isDeleted === true, null, { timeout: 8000 });
  await page.waitForFunction(() => [...(window.__mockStore['users/u_r3/notifications'] || new Map()).values()].some(n => /post was removed/i.test(n.title)), null, { timeout: 8000 })
    .catch(() => { throw new Error('poster should be notified of the removal'); });
  await settle(page);
  const text = await page.evaluate(() => document.getElementById('listings-body').innerText);
  assert(!/Home tuition/.test(text), 'removed post should leave the board');
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
