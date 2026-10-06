/* In-memory Firebase compat stub for RPHS PWA screenshots.
 * ?role=admin | ?role=resident | ?role=none (login screen) */
(function () {
  'use strict';
  const params = new URLSearchParams(location.search);
  const ROLE = params.get('role') || (location.hash || '').slice(1) || 'none';

  // ---------- Timestamp ----------
  class Timestamp {
    constructor(seconds, nanoseconds) { this.seconds = seconds; this.nanoseconds = nanoseconds || 0; }
    toDate() { return new Date(this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6)); }
    toMillis() { return this.seconds * 1000; }
    isEqual(o) { return o && o.seconds === this.seconds; }
    valueOf() { return String(this.seconds).padStart(12, '0'); }
    static fromDate(d) { return new Timestamp(Math.floor(d.getTime() / 1000), 0); }
    static fromMillis(ms) { return new Timestamp(Math.floor(ms / 1000), 0); }
    static now() { return Timestamp.fromDate(new Date()); }
  }
  const NOW = new Date();
  const ts = (d) => Timestamp.fromDate(typeof d === 'string' ? new Date(d) : d);
  const daysAgo = (n, h) => { const d = new Date(NOW.getTime() - n * 86400000); if (h != null) d.setHours(h, 15, 0, 0); return ts(d); };

  // ---------- FieldValue sentinels ----------
  const SENT = Symbol('fv');
  const FieldValue = {
    serverTimestamp: () => ({ [SENT]: 'ts' }),
    increment: (n) => ({ [SENT]: 'inc', n }),
    arrayUnion: (...v) => ({ [SENT]: 'union', v }),
    arrayRemove: (...v) => ({ [SENT]: 'remove', v }),
    delete: () => ({ [SENT]: 'del' })
  };
  function applyFields(target, data) {
    Object.keys(data).forEach(k => {
      const v = data[k];
      const path = k.split('.');
      let obj = target;
      for (let i = 0; i < path.length - 1; i++) { obj[path[i]] = obj[path[i]] && typeof obj[path[i]] === 'object' ? obj[path[i]] : {}; obj = obj[path[i]]; }
      const key = path[path.length - 1];
      if (v && typeof v === 'object' && v[SENT]) {
        const t = v[SENT];
        if (t === 'ts') obj[key] = Timestamp.now();
        else if (t === 'inc') obj[key] = (Number(obj[key]) || 0) + v.n;
        else if (t === 'union') { const a = Array.isArray(obj[key]) ? obj[key].slice() : []; v.v.forEach(x => { if (!a.some(y => JSON.stringify(y) === JSON.stringify(x))) a.push(x); }); obj[key] = a; }
        else if (t === 'remove') { obj[key] = (Array.isArray(obj[key]) ? obj[key] : []).filter(y => !v.v.some(x => JSON.stringify(x) === JSON.stringify(y))); }
        else if (t === 'del') delete obj[key];
      } else obj[key] = v;
    });
    return target;
  }

  // ---------- Seed data ----------
  const store = {}; // path -> Map(id -> data)
  function coll(path) { if (!store[path]) store[path] = new Map(); return store[path]; }
  let autoId = 1000;
  const newId = () => 'm' + (autoId++).toString(36) + Math.random().toString(36).slice(2, 8);

  const U = [
    // uid, name, house, phone, role, extra
    ['u_admin', 'Tariq Mehmood', 'House 1, Block A', '0300-4521876', 'admin', { boardMember: true, cnic: '35202-4567812-3', bloodGroup: 'B+', occupancyType: 'Owner' }],
    ['u_res1', 'Ayesha Siddiqui', 'House 14, Block B', '0321-7788123', 'resident', { cnic: '35201-9876543-2', bloodGroup: 'O+', occupancyType: 'Owner', familyDetails: 'Spouse: Imran Siddiqui (A+), CNIC 35201-1122334-5\nSon 1: Hamza Siddiqui (O+)\nDaughter 1: Zainab Siddiqui (O+)' }],
    ['u_r2', 'Muhammad Usman Khan', 'House 3, Block A', '0333-5123498', 'resident', { cnic: '35202-1234567-1', bloodGroup: 'A+', occupancyType: 'Owner' }],
    ['u_r3', 'Fatima Zahra', 'House 7, Block A', '0345-2219087', 'resident', { cnic: '35202-7654321-8', bloodGroup: 'AB+', occupancyType: 'Tenant' }],
    ['u_r4', 'Bilal Ahmed Chaudhry', 'House 9, Block A', '0301-6655443', 'board', { cnic: '35202-3344556-7', bloodGroup: 'B-', occupancyType: 'Owner' }],
    ['u_r5', 'Sana Rafiq', 'House 11, Block B', '0322-9081726', 'resident', { cnic: '35201-5566778-4', bloodGroup: 'O-', occupancyType: 'Owner', billExempt: true, billExemptReason: 'Widow – welfare case' }],
    ['u_r6', 'Hassan Raza', 'Street 22 house number C 589 E 16 Roshan Pakistan', '0312-4455667', 'resident', { cnic: '35201-8899001-2', bloodGroup: 'A-', occupancyType: 'Tenant' }],
    ['u_r7', 'Nadia Hussain', 'House 18, Block B', '0336-1122998', 'resident', { cnic: '35201-2233445-6', bloodGroup: 'B+', occupancyType: 'Owner' }],
    ['u_r8', 'Kamran Akmal Butt', 'House 21, Block C', '0300-8877665', 'resident', { cnic: '35203-6677889-0', bloodGroup: 'O+', occupancyType: 'Owner', suspended: true, statusReason: 'Unpaid dues for 6 months' }],
    ['u_r9', 'Rabia Nawaz', 'House 24, Block C', '0341-5566001', 'resident', { cnic: '35203-1029384-7', bloodGroup: 'AB-', occupancyType: 'Tenant' }],
    ['u_r10', 'Shahid Iqbal', 'House 27, Block C', '0302-3344112', 'board', { cnic: '35203-5647382-9', bloodGroup: 'A+', occupancyType: 'Owner' }],
    ['u_r11', 'Zubair Anwar', 'House 30, Block C', '0315-7766554', 'resident', { cnic: '35203-9988776-5', bloodGroup: 'B+', occupancyType: 'Owner' }],
    ['u_r12', 'Mehwish Tariq', 'House 33, Block D', '0323-1199228', 'resident', { cnic: '35204-1357924-6', bloodGroup: 'O+', occupancyType: 'Tenant' }],
    ['u_sa', 'Javed Iqbal', '', '0300-1112223', 'superadmin', { cnic: '35202-0000000-1' }]
  ];
  const users = coll('users');
  U.forEach(([uid, name, house, phone, role, extra], i) => {
    users.set(uid, Object.assign({
      name, house, phone, role, email: name.toLowerCase().split(' ')[0] + '.' + (name.split(' ').slice(-1)[0] || '').toLowerCase() + '@gmail.com',
      approved: true, membershipStatus: 'approved', biodataSubmitted: true, createdAt: daysAgo(300 - i * 9)
    }, extra || {}));
  });
  [['u_p1', 'Asad Farooq', 'House 36, Block D', '0304-2211443', true], ['u_p2', 'Hira Javed', 'House 38, Block D', '0335-6677112', true], ['u_p3', 'Waqas Ali Shah', 'House 40, Block D', '0311-9900887', false]]
    .forEach(([uid, name, house, phone, bio], i) => users.set(uid, { name, house, phone, role: 'resident', email: name.toLowerCase().replace(/ /g, '.') + '@yahoo.com', approved: false, membershipStatus: 'pending', biodataSubmitted: bio, createdAt: daysAgo(3 - i) }));

  const byUid = Object.fromEntries([...users.entries()]);

  // announcements
  const ann = coll('announcements');
  [
    ['a1', 'Water Supply Suspension – Saturday', 'Dear residents, WASA will carry out main-line repairs on Saturday 3rd October from 9:00 AM to 4:00 PM. Please store sufficient water in advance. The tanker service will be available at the main gate for emergencies.', 1],
    ['a2', 'September 2026 Financial Summary', 'The monthly financial summary for September 2026 has been posted. Total in: PKR 96,500 · Total out: PKR 61,200 · Net +PKR 35,300.\n\nTap Breakdown for the full statement.', 0, { summaryMonth: '2026-09' }],
    ['a3', 'Jashn-e-Azadi Mehfil Postponed', 'Due to the weather forecast, the community mehfil scheduled for this Friday is postponed to next Friday after Maghrib. Children\'s milli naghma competition will be held at the same time.', 6],
    ['a4', 'New Security Guard Shift Timings', 'From 1st October, night-shift guards will be on duty from 10 PM to 6 AM. Visitors after 11 PM must be registered at the gate with CNIC.', 10, { allowComments: false }],
    ['a5', 'Dengue Spray Campaign', 'The society will carry out fumigation in all blocks on Sunday morning. Please keep windows closed between 7 and 9 AM and remove stagnant water from pots and coolers.', 18]
  ].forEach(([id, title, content, d, extra]) => ann.set(id, Object.assign({ title, content, createdAt: daysAgo(d, 10), createdBy: 'u_admin', createdByName: 'Tariq Mehmood', createdByRole: id === 'a3' ? 'board' : 'management' }, extra || {})));
  coll('announcements/a1/comments').set('c1', { uid: 'u_r3', name: 'Fatima Zahra', role: 'resident', text: 'Will the tanker be free of charge?', createdAt: daysAgo(1, 12) });
  coll('announcements/a1/comments').set('c2', { uid: 'u_admin', name: 'Tariq Mehmood', role: 'management', text: 'Yes, one tanker per house is free on Saturday.', createdAt: daysAgo(1, 13) });
  coll('announcements/a3/comments').set('c3', { uid: 'u_r2', name: 'Muhammad Usman Khan', role: 'resident', text: 'JazakAllah for the update.', createdAt: daysAgo(5, 9) });

  // polls
  const polls = coll('polls');
  polls.set('p1', { question: 'Should we install CCTV cameras at all three gates?', options: ['Yes, from the welfare fund', 'Yes, with a one-time levy', 'No, not needed now'], votes: { u_r2: 0, u_r3: 0, u_r4: 1, u_r6: 0, u_r7: 2, u_r9: 0, u_admin: 0 }, createdAt: daysAgo(2, 11), createdBy: 'u_admin', createdByRole: 'management' });
  polls.set('p2', { question: 'Preferred day for monthly community clean-up drive?', options: ['Saturday morning', 'Sunday morning', 'Sunday evening'], votes: { u_res1: 1, u_r2: 1, u_r5: 0, u_r10: 1, u_r11: 2 }, createdAt: daysAgo(9, 11), createdBy: 'u_r4', createdByRole: 'board' });
  polls.set('p3', { question: 'Increase monthly maintenance from PKR 2,500 to PKR 3,000 from January?', options: ['Agree', 'Disagree', 'Need more details'], votes: {}, createdAt: daysAgo(0, 8), createdBy: 'u_admin', createdByRole: 'management' });

  // tickets
  const tickets = coll('tickets');
  [
    ['t1', 'TKT-4821', 'Street Lights', 'Street light outside House 14 has not been working for a week. The lane is completely dark at night.', 'u_res1', 'pending', 1, ''],
    ['t2', 'TKT-4799', 'Water Supply', 'Low water pressure in Block B since Monday. Upper floors are not getting water at all.', 'u_r6', 'in-progress', 4, 'Plumbing'],
    ['t3', 'TKT-4750', 'Sanitation', 'Garbage has not been collected from Block C for 3 days.', 'u_r9', 'resolved', 9, 'Sanitation'],
    ['t4', 'TKT-4702', 'Security', 'Unknown motorbike seen parked at back gate repeatedly late at night.', 'u_res1', 'closed', 21, 'Security'],
    ['t5', 'TKT-4688', 'Suggestion', 'Please plant more trees in the park and install a few benches for elderly residents.', 'u_r7', 'pending', 25, ''],
    ['t6', 'TKT-4650', 'Electricity', 'Transformer near the mosque makes loud noise and sparks during rain.', 'u_r2', 'in-progress', 33, 'Electrical']
  ].forEach(([id, no, cat, desc, uid, status, d, dept]) => tickets.set(id, { ticketNo: no, category: cat, subject: cat, description: desc, uid, name: byUid[uid].name, house: byUid[uid].house, status, department: dept, createdAt: daysAgo(d, 9) }));
  // complaint photos (proofs kind 'ticket'), progress history and a rating
  const ticketProofs = coll('proofs');
  ticketProofs.set('ph_t1', { uid: 'u_res1', kind: 'ticket', type: 'image', name: 'light.jpg', data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', createdAt: daysAgo(1, 9) });
  tickets.get('t1').photoIds = ['ph_t1'];
  tickets.get('t1').history = [{ status: 'pending', note: 'Complaint lodged', by: 'Ayesha Siddiqui', at: daysAgo(1, 9).toDate().getTime() }];
  tickets.get('t2').history = [
    { status: 'pending', note: 'Complaint lodged', by: 'Hina Shahid', at: daysAgo(4, 9).toDate().getTime() },
    { status: 'in-progress', note: 'Plumber visiting Monday morning', by: 'Tariq Mehmood', at: daysAgo(3, 11).toDate().getTime() }
  ];
  tickets.get('t3').history = [
    { status: 'pending', note: 'Complaint lodged', by: 'Bilal Hussain', at: daysAgo(9, 9).toDate().getTime() },
    { status: 'resolved', note: 'Collection resumed; contractor warned', by: 'Tariq Mehmood', at: daysAgo(7, 16).toDate().getTime() }
  ];
  tickets.get('t3').rating = { stars: 4, comment: 'Fixed quickly, thanks.', at: daysAgo(6, 10).toDate().getTime() };
  tickets.set('t7', { ticketNo: 'TKT-4600', category: 'Other', subject: 'Duplicate', description: 'Duplicate entry', uid: 'u_r3', name: 'Fatima Zahra', house: 'House 7, Block A', status: 'closed', createdAt: daysAgo(40), isDeleted: true, deletedAt: daysAgo(38), deletedBy: 'Tariq Mehmood' });

  // bills: Aug (mostly paid), Sep (mix: paid/unpaid overdue (due 20 Sep)/submitted), Oct (unpaid, due 20 Oct)
  const bills = coll('bills');
  let bn = 302110;
  const approvedRes = U.map(u => u[0]);
  approvedRes.forEach((uid, i) => {
    const u = byUid[uid];
    if (u.billExempt) return;
    const mk = (period, due, status, issuedDaysAgo, paidDaysAgo, extra) => bills.set('b' + (bn), Object.assign({
      billNo: 'BILL-' + (bn++), uid, name: u.name, house: u.house, category: 'Monthly Maintenance', period, amount: 2500, currency: 'PKR',
      dueDate: due, status, issuedBy: 'Tariq Mehmood', createdAt: daysAgo(issuedDaysAgo, 9),
      paidAt: status === 'paid' ? daysAgo(paidDaysAgo, 14) : null
    }, extra || {}));
    // August
    mk('August 2026', '2026-08-20', (i === 8 ? 'unpaid' : 'paid'), 61, 50 - (i % 10));
    // September
    const sepStatus = [ 'paid', 'unpaid', 'paid', 'paid', 'submitted', 'paid', 'unpaid', 'paid', 'unpaid', 'paid', 'submitted', 'unpaid', 'paid' ][i] || 'paid';
    mk('September 2026', '2026-09-20', sepStatus, 30, 20 - (i % 8), sepStatus === 'unpaid' && uid === 'u_res1' ? { proofRejectedReason: 'Screenshot was unreadable' } : {});
    // October
    mk('October 2026', '2026-10-20', 'unpaid', 0);
  });
  // one-off special bill
  bills.set('bx1', { billNo: 'BILL-309001', uid: 'u_res1', name: 'Ayesha Siddiqui', house: 'House 14, Block B', category: 'Gate Pass Card', period: 'One-time', amount: 750, dueDate: '2026-09-28', status: 'unpaid', issuedBy: 'Tariq Mehmood', createdAt: daysAgo(12, 9) });
  bills.set('bx2', { billNo: 'BILL-300555', uid: 'u_r6', name: 'Hassan Raza', house: 'House 16, Block B', category: 'Monthly Maintenance', period: 'July 2026', amount: 2500, dueDate: '2026-07-20', status: 'cancelled', createdAt: daysAgo(90), isDeleted: true, deletedAt: daysAgo(80), deletedBy: 'Tariq Mehmood' });

  // funds & contributions
  const funds = coll('funds');
  funds.set('f1', { title: 'Mosque Roof Repair', purpose: 'Waterproofing and repair of the Jamia Masjid roof before winter rains. Includes labour and material (bitumen sheets, cement).', category: 'Mosque', targetAmount: 250000, status: 'active', deadline: '2026-11-15', createdAt: daysAgo(40), createdBy: 'Tariq Mehmood' });
  funds.set('f2', { title: 'Flood Relief 2026', purpose: 'Ration bags and clean water for flood-affected families in Rajanpur, distributed through volunteers.', category: 'Welfare', targetAmount: 150000, status: 'active', createdAt: daysAgo(25), createdBy: 'Tariq Mehmood' });
  funds.set('f3', { title: 'Zakat Collection – Ramadan', purpose: 'Zakat pooled for deserving staff (guards, sweepers) and their families.', category: 'Zakat', targetAmount: 0, status: 'closed', createdAt: daysAgo(200), createdBy: 'Tariq Mehmood' });
  funds.set('f4', { title: 'Park Development', purpose: 'Walking track, benches and lighting in the central park.', category: 'Development', targetAmount: 400000, status: 'active', deadline: '2027-01-31', createdAt: daysAgo(12), createdBy: 'Tariq Mehmood' });
  const contribs = coll('fund_contributions');
  const fundTitle = { f1: 'Mosque Roof Repair', f2: 'Flood Relief 2026', f3: 'Zakat Collection – Ramadan', f4: 'Park Development' };
  const fundCat = { f1: 'Mosque', f2: 'Welfare', f3: 'Zakat', f4: 'Development' };
  [
    ['f1', 'u_r2', 25000, 'verified', 38], ['f1', 'u_r4', 50000, 'verified', 35], ['f1', 'u_res1', 10000, 'verified', 30], ['f1', 'u_r7', 15000, 'verified', 20], ['f1', 'u_r11', 20000, 'submitted', 2],
    ['f2', 'u_r3', 5000, 'verified', 22], ['f2', 'u_r10', 30000, 'verified', 18], ['f2', 'u_r6', 3000, 'verified', 15], ['f2', 'u_res1', 5000, 'submitted', 1], ['f2', 'u_r9', 2000, 'rejected', 10],
    ['f3', 'u_r2', 40000, 'verified', 190], ['f3', 'u_r4', 60000, 'verified', 188], ['f3', 'u_r12', 15000, 'verified', 185],
    ['f4', 'u_admin', 20000, 'verified', 10], ['f4', 'u_r10', 10000, 'verified', 6]
  ].forEach(([f, uid, amount, status, d], i) => contribs.set('fc' + i, {
    fundId: f, fundTitle: fundTitle[f], category: fundCat[f], uid, name: byUid[uid].name, house: byUid[uid].house, amount, status,
    paymentMethod: ['Bank Transfer', 'EasyPaisa', 'JazzCash', 'Cash'][i % 4], paymentRef: 'TRX' + (88123400 + i * 37),
    paymentDate: new Date(NOW.getTime() - d * 86400000).toISOString().slice(0, 10), createdAt: daysAgo(d, 12),
    verifiedBy: status === 'verified' ? 'Tariq Mehmood' : '', rejectionReason: status === 'rejected' ? 'Transaction ID not found' : ''
  }));

  // expenses
  const expenses = coll('expenses');
  const iso = (d) => new Date(NOW.getTime() - d * 86400000).toISOString().slice(0, 10);
  [
    ['Utilities', 'LESCO electricity bill – street lights & tube well (September)', 18500, 'bills', '', 2],
    ['Security', 'Guard salaries – 3 guards, September', 54000, 'bills', '', 3],
    ['Sanitation', 'Garbage lifting contractor – September', 12000, 'bills', '', 8],
    ['Maintenance', 'Tube well motor rewinding', 22000, 'bills', '', 20, 'BD-2026-07'],
    ['Mosque', 'Bitumen sheets & cement for roof repair (first lot)', 48000, 'fund', 'f1', 12],
    ['Welfare', '45 ration bags – flood relief', 31500, 'fund', 'f2', 9],
    ['Utilities', 'LESCO electricity bill – August', 17200, 'bills', '', 33],
    ['Security', 'Guard salaries – August', 54000, 'bills', '', 34],
    ['Welfare', 'Zakat disbursement to 8 staff families', 104000, 'fund', 'f3', 170],
    ['Events', 'Independence Day lighting & flags', 9500, 'bills', '', 48],
    ['Maintenance', 'Main gate barrier repair', 7800, 'bills', '', 70],
    ['Sanitation', 'Garbage lifting contractor – August', 12000, 'bills', '', 38]
  ].forEach(([category, description, amount, source, fundId, d, ref], i) => expenses.set('ex' + i, {
    category, description, amount, source, fundId, fundTitle: fundId ? fundTitle[fundId] : '', expenseDate: iso(d), enteredBy: 'Tariq Mehmood', decisionRef: ref || '', createdAt: daysAgo(d, 15)
  }));

  // transfers
  const transfers = coll('transfers');
  transfers.set('tr1', { fromType: 'bills', toType: 'fund', toFundId: 'f4', toFundTitle: 'Park Development', amount: 25000, note: 'Seed money from surplus maintenance collections (Board decision BD-2026-09).', transferDate: iso(7), enteredBy: 'Tariq Mehmood', createdAt: daysAgo(7) });
  transfers.set('tr2', { fromType: 'fund', fromFundId: 'f3', fromFundTitle: 'Zakat Collection – Ramadan', toType: 'bills', amount: 11000, note: 'Remaining balance moved to bills account after fund closure.', transferDate: iso(150), enteredBy: 'Tariq Mehmood', createdAt: daysAgo(150) });

  // volunteers
  const vol = coll('volunteer_programs');
  vol.set('v1', { title: 'Flood Relief Ration Packing', description: 'Help pack and load ration bags for flood-affected families. Gloves and refreshments provided.', schedule: 'Saturday 4 Oct, 10 AM – 1 PM · Community Hall', status: 'active', participants: [
    { uid: 'u_r3', name: 'Fatima Zahra', house: 'House 7, Block A', phone: '0345-2219087' }, { uid: 'u_r6', name: 'Hassan Raza', house: 'House 16, Block B', phone: '0312-4455667' }, { uid: 'u_res1', name: 'Ayesha Siddiqui', house: 'House 14, Block B', phone: '0321-7788123' }], createdAt: daysAgo(5) });
  vol.set('v2', { title: 'Tree Plantation Drive', description: 'Plant 200 saplings along the main boulevard and the park perimeter.', schedule: 'Sunday 12 Oct, 7 AM', status: 'active', participants: [{ uid: 'u_r11', name: 'Zubair Anwar', house: 'House 30, Block C', phone: '0315-7766554' }], createdAt: daysAgo(3) });
  vol.set('v3', { title: 'Blood Donation Camp', description: 'Camp organised with Fatimid Foundation.', schedule: 'Held 14 Aug', status: 'closed', participants: [{ uid: 'u_r2', name: 'Muhammad Usman Khan', house: 'House 3, Block A' }, { uid: 'u_r7', name: 'Nadia Hussain', house: 'House 18, Block B' }], createdAt: daysAgo(60) });

  // decisions
  const dec = coll('decisions');
  dec.set('d1', { title: 'Approve CCTV installation – PKR 180,000', type: 'expense', description: 'Quotation from SafeVision Lahore for 9 cameras + NVR at three gates.', uploadedBy: 'Tariq Mehmood', requiredVotes: 3, status: 'pending', votes: [{ uid: 'u_r4', name: 'Bilal Ahmed Chaudhry', choice: 'endorse' }, { uid: 'u_r10', name: 'Shahid Iqbal', choice: 'reject', reason: 'Get one more quotation first' }], createdAt: daysAgo(2) });
  dec.set('d2', { title: 'Suspend membership – House 21, Block C', type: 'suspension', description: 'Six months of unpaid maintenance despite three reminders.', uploadedBy: 'Tariq Mehmood', requiredVotes: 3, status: 'approved', votes: [{ uid: 'u_r4', name: 'Bilal Ahmed Chaudhry', choice: 'endorse', reason: 'Multiple reminders ignored' }, { uid: 'u_r10', name: 'Shahid Iqbal', choice: 'endorse', reason: 'Per bylaws' }, { uid: 'u_admin', name: 'Tariq Mehmood', choice: 'endorse', reason: 'Agreed' }], finalizedAt: daysAgo(15), createdAt: daysAgo(20) });
  dec.set('d3', { title: 'Transfer PKR 25,000 to Park Development', type: 'opinion', description: 'Move surplus from bills account as seed money.', uploadedBy: 'Tariq Mehmood', requiredVotes: 3, status: 'approved', votes: [{ uid: 'u_r4', name: 'Bilal Ahmed Chaudhry', choice: 'endorse' }, { uid: 'u_r10', name: 'Shahid Iqbal', choice: 'endorse' }, { uid: 'u_admin', name: 'Tariq Mehmood', choice: 'endorse' }], finalizedAt: daysAgo(8), createdAt: daysAgo(11) });

  // monthly summaries
  const ms = coll('monthly_summaries');
  [['2026-09', 'September 2026', 96500, 61200], ['2026-08', 'August 2026', 88000, 92700], ['2026-07', 'July 2026', 71250, 55300]].forEach(([month, period, i, o]) => ms.set(month, {
    month, period, asOf: '01 ' + period.split(' ')[0].slice(0,3) + ' ' + period.split(' ')[1], members: 12, generatedAt: ts(month + '-28'), createdAt: ts(month + '-28'),
    totals: { in: i, out: o, net: i - o },
    bills: { collectedAmount: i - 33000, collectedCount: Math.round((i - 33000) / 2500), issuedAmount: 30000, issuedCount: 12, outstandingAmount: 12500, outstandingCount: 5, owingHouses: 4 },
    contributions: { amount: 33000, count: 3, byFund: [{ label: 'Flood Relief 2026', value: 30000 }, { label: 'Flood Relief 2026 (2)', value: 3000 }] },
    expenses: { amount: o, byCategory: [{ label: 'Security', value: 54000 }, { label: 'Utilities', value: o - 54000 > 0 ? o - 54000 : 7200 }], bySource: [{ label: 'Bills account', value: o - 5000 }, { label: 'Fund: Mosque Roof Repair', value: 5000 }],
      items: [{ date: month + '-03', category: 'Security', description: 'Guard salaries', source: 'Bills account', amount: 54000 }, { date: month + '-02', category: 'Utilities', description: 'LESCO electricity bill', source: 'Bills account', amount: o - 54000 > 0 ? o - 54000 : 7200 }] },
    transfers: [{ date: month + '-24', from: 'Bills account', to: 'Fund: Park Development', note: 'Seed money', amount: 25000 }],
    balances: { bills: { collected: 410000, spent: 290000, transferredIn: 11000, transferredOut: 25000, balance: 106000 }, funds: { balance: 158500 }, perFund: [{ title: 'Mosque Roof Repair', balance: 52000 }, { title: 'Flood Relief 2026', balance: 6500 }, { title: 'Park Development', balance: 55000 }] }
  }));

  // settings
  coll('settings').set('society', { bankName: 'Meezan Bank – Model Town Branch', accountTitle: 'Roshan Pakistan Housing Society', accountNumber: '0201-0104567890', iban: 'PK36MEZN0002010104567890', instructions: 'Write your house number in the transfer remarks.' });
  coll('settings').set('recurringBill', { enabled: true, amount: 2500, category: 'Monthly Maintenance', dueDay: 20, notes: '', lastRun: { at: daysAgo(0, 0), issued: 12, period: 'October 2026', skippedBilled: 0, skippedExempt: 1 } });
  coll('settings').set('monthlySummary', { enabled: true });

  // documents vault (file kept in proofs/{fileId} with kind 'document')
  const PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  coll('proofs').set('doc_f1', { uid: 'u_admin', kind: 'document', type: 'pdf', name: 'bylaws-2026.pdf', data: 'data:application/pdf;base64,JVBERi0xLjQKJeLjz9MKCg==', createdAt: daysAgo(60, 10) });
  coll('proofs').set('doc_f2', { uid: 'u_admin', kind: 'document', type: 'image', name: 'budget-2026.png', data: PX, createdAt: daysAgo(25, 10) });
  const docs = coll('documents');
  docs.set('doc1', { title: 'Society Bylaws & House Rules (2026 edition)', category: 'Bylaws & Rules', description: 'Membership, maintenance charges, construction rules and penalties.', fileId: 'doc_f1', fileType: 'pdf', fileName: 'bylaws-2026.pdf', fileSize: 412000, createdBy: 'u_admin', createdByName: 'Tariq Mehmood', createdByRole: 'management', createdAt: daysAgo(60, 10) });
  docs.set('doc2', { title: 'Approved Budget 2026-27', category: 'Budget & Accounts', description: 'Approved by the Board on 12 Sep.', fileId: 'doc_f2', fileType: 'image', fileName: 'budget-2026.png', fileSize: 98000, createdBy: 'u_admin', createdByName: 'Tariq Mehmood', createdByRole: 'management', createdAt: daysAgo(25, 10) });
  docs.set('doc3', { title: 'Gate Pass Request Form', category: 'Forms', description: '', link: 'https://drive.google.com/file/d/rphs-gate-pass/view', createdBy: 'u_r4', createdByName: 'Bilal Hussain', createdByRole: 'board', createdAt: daysAgo(12, 10) });
  docs.set('doc4', { title: 'Old parking policy', category: 'Notices & Circulars', link: 'https://example.com/old', createdBy: 'u_admin', createdByName: 'Tariq Mehmood', createdAt: daysAgo(200), isDeleted: true, deletedAt: daysAgo(100), deletedBy: 'Tariq Mehmood' });

  // board meetings: one upcoming (agenda open to suggestions), one held (minutes)
  const meetings = coll('meetings');
  const at = (d) => daysAgo(d, 18).toDate().getTime();
  meetings.set('m1', {
    title: 'Monthly Board Meeting – October', date: iso(-6), time: '8:00 PM', venue: 'Community Hall', description: 'All residents welcome as observers.',
    status: 'upcoming', suggestionsOpen: true,
    agenda: [
      { text: 'Approve September accounts', source: 'board', by: 'Tariq Mehmood', byUid: 'u_admin', house: 'House 1, Block A', at: at(4) },
      { text: 'Gate security contract renewal', source: 'board', by: 'Tariq Mehmood', byUid: 'u_admin', house: 'House 1, Block A', at: at(4) },
      { text: 'Speed breakers near the park', source: 'resident', by: 'Muhammad Usman Khan', byUid: 'u_r2', house: 'House 3, Block A', at: at(2) }
    ],
    createdBy: 'u_admin', createdByName: 'Tariq Mehmood', createdByRole: 'management', createdAt: daysAgo(4, 18), updatedAt: daysAgo(2, 18)
  });
  meetings.set('m2', {
    title: 'Monthly Board Meeting – September', date: iso(22), time: '8:00 PM', venue: 'Community Hall',
    status: 'held', suggestionsOpen: false,
    agenda: [
      { text: 'CCTV installation quotation', source: 'board', by: 'Tariq Mehmood', byUid: 'u_admin', at: at(30) },
      { text: 'Park development fund', source: 'board', by: 'Tariq Mehmood', byUid: 'u_admin', at: at(30) }
    ],
    minutes: '1. CCTV quotation from SafeVision reviewed; Board approved 9 cameras at three gates.\n2. PKR 25,000 moved from the bills account to the Park Development fund as seed money.\n3. Next meeting: first week of October.',
    decisions: [{ id: 'd1', title: 'Approve CCTV installation – PKR 180,000', outcome: 'approved' }, { id: 'd3', title: 'Transfer PKR 25,000 to Park Development', outcome: 'approved' }],
    attendees: 'Tariq Mehmood, Hina Shahid, Bilal Hussain, Hassan Raza',
    minutesPublishedAt: daysAgo(21, 10), minutesBy: 'Tariq Mehmood',
    createdBy: 'u_admin', createdByName: 'Tariq Mehmood', createdByRole: 'management', createdAt: daysAgo(30, 18), updatedAt: daysAgo(21, 10)
  });

  // audit log
  const audit = coll('audit_log');
  [['bill', 'update', 'Bill BILL-302112 marked paid', 1], ['member', 'update', 'Membership approved: Mehwish Tariq', 4], ['fund', 'create', 'Fund "Park Development" started', 12], ['expense', 'create', 'Expense Mosque PKR 48,000 recorded', 12], ['tickets', 'archive', 'Complaint TKT-4600 archived', 38]]
    .forEach(([entityType, action, details, d], i) => audit.set('al' + i, { entityType, action, details, performedBy: 'Tariq Mehmood', role: 'admin', timestamp: daysAgo(d, 11) }));

  // notifications
  function seedNotifs(uid, list) { const c = coll('users/' + uid + '/notifications'); list.forEach((n, i) => c.set('n' + i, Object.assign({ read: false, type: 'info', createdAt: daysAgo(n.d, n.h || 10) }, n))); }
  seedNotifs('u_admin', [
    { title: 'Payment Proof Uploaded', body: 'Bilal Ahmed Chaudhry uploaded payment proof for BILL-302123 (September 2026).', category: 'bills', d: 0, h: 9 },
    { title: 'New Complaint (TKT-4821)', body: 'Ayesha Siddiqui — Street Lights: Street light outside House 14 has not been working for a week.', category: 'complaints', d: 1 },
    { title: 'New Registration', body: 'Asad Farooq (House 36, Block D) registered and is awaiting approval.', category: 'membership', d: 1, h: 7 },
    { title: 'Fund Contribution Submitted', body: 'Zubair Anwar submitted PKR 20,000 to Mosque Roof Repair.', category: 'funds', d: 2, read: true },
    { title: 'Board Vote Cast', body: 'Shahid Iqbal opposed "Approve CCTV installation".', category: 'general', d: 2, read: true },
    { title: 'EMERGENCY: Gas Leak Block C', body: 'Sui gas leak reported near House 24. SNGPL team on site. Avoid the area.', category: 'emergency', type: 'error', d: 6, read: true }
  ]);
  seedNotifs('u_res1', [
    { title: 'New Maintenance Bill (BILL-' + (302110 + 5) + ')', body: 'Monthly Maintenance for October 2026: PKR 2,500. Due by 2026-10-20.', category: 'bills', d: 0, h: 9 },
    { title: 'Payment Proof Rejected', body: 'Your proof for September 2026 was rejected: Screenshot was unreadable. Please upload again.', category: 'bills', type: 'error', d: 1 },
    { title: 'New Announcement', body: 'Water Supply Suspension – Saturday', category: 'notices', d: 1, h: 8 },
    { title: 'New Poll', body: 'Increase monthly maintenance from PKR 2,500 to PKR 3,000 from January?', category: 'polls', d: 0, h: 8 },
    { title: 'Complaint Update (TKT-4702)', body: 'Your complaint status changed to closed.', category: 'complaints', d: 15, read: true },
    { title: 'Contribution Verified', body: 'Your contribution of PKR 10,000 to Mosque Roof Repair has been verified. JazakAllah!', category: 'funds', d: 28, read: true }
  ]);

  // ---------- Firestore API ----------
  function clone(v) { if (v instanceof Timestamp) return v; if (Array.isArray(v)) return v.map(clone); if (v && typeof v === 'object') { const o = {}; for (const k in v) o[k] = clone(v[k]); return o; } return v; }
  function getField(obj, path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }
  function cmpVal(a, b) {
    const n = v => v instanceof Timestamp ? v.toMillis() : (v && typeof v.toDate === 'function') ? v.toDate().getTime() : v;
    a = n(a); b = n(b);
    if (a === b) return 0; if (a == null) return -1; if (b == null) return 1;
    return a < b ? -1 : 1;
  }
  function makeDocSnap(path, id, data) {
    return { id, exists: data !== undefined, ref: docRef(path, id), data: () => (data === undefined ? undefined : clone(data)), get: (f) => data && getField(data, f), metadata: { fromCache: false, hasPendingWrites: false } };
  }
  function makeQuerySnap(path, docs) {
    const snaps = docs.map(([id, d]) => makeDocSnap(path, id, d));
    return { docs: snaps, empty: snaps.length === 0, size: snaps.length, forEach: (cb) => snaps.forEach(cb), docChanges: () => [], metadata: { fromCache: false } };
  }
  const delay = (v) => new Promise(r => setTimeout(() => r(v), 15));

  function docRef(path, id) {
    const full = path + '/' + id;
    const ref = {
      id, path: full, parent: null,
      get: (opts) => {
        if (opts && opts.source === 'cache') return Promise.reject(Object.assign(new Error('cache miss'), { code: 'unavailable' }));
        return delay(makeDocSnap(path, id, coll(path).get(id)));
      },
      set: (data, opts) => { const c = coll(path); const base = opts && opts.merge ? clone(c.get(id) || {}) : {}; c.set(id, applyFields(base, data)); return delay(); },
      update: (data) => { const c = coll(path); c.set(id, applyFields(clone(c.get(id) || {}), data)); return delay(); },
      delete: () => { coll(path).delete(id); return delay(); },
      collection: (sub) => collectionRef(full + '/' + sub),
      onSnapshot: (cb) => { setTimeout(() => cb(makeDocSnap(path, id, coll(path).get(id))), 10); return () => {}; }
    };
    return tolerant(ref, 'doc');
  }

  function collectionRef(path, filters, orders, lim) {
    filters = filters || []; orders = orders || [];
    const run = () => {
      let docs = [...coll(path).entries()];
      filters.forEach(([f, op, v]) => {
        docs = docs.filter(([, d]) => {
          const x = getField(d, f);
          switch (op) {
            case '==': return x === v || (x == null && v == null);
            case '!=': return x !== v;
            case '<': return cmpVal(x, v) < 0;
            case '<=': return cmpVal(x, v) <= 0;
            case '>': return cmpVal(x, v) > 0;
            case '>=': return cmpVal(x, v) >= 0;
            case 'in': return Array.isArray(v) && v.includes(x);
            case 'not-in': return Array.isArray(v) && !v.includes(x);
            case 'array-contains': return Array.isArray(x) && x.includes(v);
            case 'array-contains-any': return Array.isArray(x) && v.some(y => x.includes(y));
            default: return true;
          }
        });
      });
      // Firestore orderBy excludes docs missing the field
      orders.forEach(([f]) => { docs = docs.filter(([, d]) => getField(d, f) !== undefined); });
      if (orders.length) docs.sort((a, b) => { for (const [f, dir] of orders) { const c = cmpVal(getField(a[1], f), getField(b[1], f)); if (c) return dir === 'desc' ? -c : c; } return 0; });
      if (lim) docs = docs.slice(0, lim);
      return docs;
    };
    const q = {
      id: path.split('/').pop(), path,
      where: (f, op, v) => collectionRef(path, filters.concat([[f, op, v]]), orders, lim),
      orderBy: (f, dir) => collectionRef(path, filters, orders.concat([[f, dir || 'asc']]), lim),
      limit: (n) => collectionRef(path, filters, orders, n),
      limitToLast: (n) => collectionRef(path, filters, orders, n),
      startAfter: () => q, startAt: () => q, endAt: () => q, endBefore: () => q,
      get: (opts) => {
        if (opts && opts.source === 'cache') return Promise.reject(Object.assign(new Error('cache miss'), { code: 'unavailable' }));
        return delay(makeQuerySnap(path, run()));
      },
      onSnapshot: (cb) => { setTimeout(() => cb(makeQuerySnap(path, run())), 10); return () => {}; },
      doc: (id) => docRef(path, id || newId()),
      add: (data) => { const id = newId(); coll(path).set(id, applyFields({}, data)); return delay(docRef(path, id)); }
    };
    return tolerant(q, 'query');
  }

  function tolerant(obj, label) {
    if (typeof Proxy === 'undefined') return obj;
    return new Proxy(obj, {
      get(t, p) {
        if (p in t || typeof p === 'symbol' || p === 'then' || p === 'toJSON') return t[p];
        console.warn('[mock] unknown ' + label + '.' + String(p) + ' – no-op');
        const noop = function () { return Promise.resolve(); };
        return noop;
      }
    });
  }

  const firestoreInstance = tolerant({
    collection: (name) => collectionRef(name),
    doc: (p) => { const parts = p.split('/'); const id = parts.pop(); return docRef(parts.join('/'), id); },
    batch: () => { const ops = []; const b = { set: (r, d, o) => { ops.push(() => r.set(d, o)); return b; }, update: (r, d) => { ops.push(() => r.update(d)); return b; }, delete: (r) => { ops.push(() => r.delete()); return b; }, commit: () => Promise.all(ops.map(f => f())) }; return b; },
    runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, d, o) => { r.set(d, o); }, update: (r, d) => { r.update(d); }, delete: (r) => { r.delete(); } }),
    enablePersistence: () => Promise.resolve(),
    settings: () => {},
    enableNetwork: () => Promise.resolve(), disableNetwork: () => Promise.resolve()
  }, 'firestore');

  // ---------- Auth ----------
  const uidForRole = { admin: 'u_admin', resident: 'u_res1', board: 'u_r4', superadmin: 'u_sa' }[ROLE];
  let currentUser = uidForRole ? {
    uid: uidForRole, email: byUid[uidForRole].email, emailVerified: true, displayName: byUid[uidForRole].name,
    reload: () => Promise.resolve(), sendEmailVerification: () => Promise.resolve(), getIdToken: () => Promise.resolve('tok')
  } : null;
  const listeners = [];
  const authInstance = tolerant({
    get currentUser() { return currentUser; },
    onAuthStateChanged: (cb) => { listeners.push(cb); setTimeout(() => cb(currentUser), 30); return () => {}; },
    signOut: () => { currentUser = null; listeners.forEach(cb => cb(null)); return Promise.resolve(); },
    signInWithEmailAndPassword: () => Promise.reject(Object.assign(new Error('Mock: sign-in disabled'), { code: 'auth/wrong-password' })),
    createUserWithEmailAndPassword: () => Promise.reject(Object.assign(new Error('Mock'), { code: 'auth/operation-not-allowed' })),
    sendPasswordResetEmail: () => Promise.resolve(),
    setPersistence: () => Promise.resolve()
  }, 'auth');

  const firestoreFn = () => firestoreInstance;
  firestoreFn.FieldValue = FieldValue;
  firestoreFn.Timestamp = Timestamp;
  firestoreFn.FieldPath = { documentId: () => '__name__' };
  const authFn = () => authInstance;
  authFn.Auth = { Persistence: { LOCAL: 'local', SESSION: 'session', NONE: 'none' } };
  const messagingFn = () => tolerant({ getToken: () => Promise.resolve(''), onMessage: () => () => {} }, 'messaging');
  messagingFn.isSupported = () => Promise.resolve(false);

  window.firebase = {
    apps: [],
    initializeApp: function (cfg) { const app = { name: '[DEFAULT]', options: cfg }; this.apps.push(app); return app; },
    app: () => ({ name: '[DEFAULT]' }),
    firestore: firestoreFn,
    auth: authFn,
    messaging: messagingFn
  };
  window.__mockStore = store;
})();
