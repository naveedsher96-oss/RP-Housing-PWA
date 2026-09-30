const { onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp();
setGlobalOptions({ region: "asia-south1" });

const TIME_ZONE = "Asia/Karachi";
const REMINDER_INTERVAL_DAYS = 7;
const PRE_DUE_REMINDER_DAYS = 3;
const MAINTENANCE_DUE_DAY = 20;
const RECURRING_ISSUE_DAY = 1;
const RECURRING_SETTINGS_PATH = "settings/recurringBill";
const RECURRING_ISSUER = "Auto (recurring)";

function formatMoney(n) {
  return "PKR " + Number(n || 0).toLocaleString("en-PK");
}

// Mirrors inferNotifCategory() in index.html for notifications created without
// an explicit category. Emergency alerts can never be muted.
function notifCategory(data) {
  if (data.category) return String(data.category);
  const t = String(data.title || "").toLowerCase();
  if (/emergency/.test(t)) return "emergency";
  if (/bill|payment|maintenance|proof/.test(t)) return "bills";
  if (/contribution|fund/.test(t)) return "funds";
  if (/poll/.test(t)) return "polls";
  if (/announcement|comment/.test(t)) return "notices";
  if (/complaint|ticket/.test(t)) return "complaints";
  if (/volunteer/.test(t)) return "volunteers";
  if (/membership|account|suspension|approved/.test(t)) return "membership";
  return "general";
}

async function isPushMuted(uid, data) {
  const category = notifCategory(data);
  if (category === "emergency") return false;
  const userDoc = await admin.firestore().collection("users").doc(uid).get();
  const muted = userDoc.exists ? userDoc.data().mutedCategories : null;
  return Array.isArray(muted) && muted.includes(category);
}

// Today's date as YYYY-MM-DD in Pakistan time (matches the app's dueDate strings).
function todayKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function daysBetween(fromKey, toKey) {
  return Math.round((Date.parse(toKey) - Date.parse(fromKey)) / 86400000);
}

function addDays(key, n) {
  return new Date(Date.parse(key) + n * 86400000).toISOString().slice(0, 10);
}

function monthLabel(key) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", month: "long", year: "numeric" })
    .format(new Date(Date.parse(key)));
}

function notificationDoc(title, body, type) {
  return {
    title,
    body,
    text: body,
    type,
    read: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

function billLine(b, today) {
  const late = daysBetween(b.dueDate, today);
  const when = late > 0 ? `${late} day${late === 1 ? "" : "s"} overdue`
    : late === 0 ? "due today" : `due in ${-late} day${late === -1 ? "" : "s"}`;
  return `${b.billNo || "Bill"} · ${b.category || "Maintenance"}${b.period ? " for " + b.period : ""}: ${formatMoney(b.amount)} (${when})`;
}

const PAY_FOOTER = "\n\nPlease pay and submit your payment proof in the Bills tab. Ignore if you have already paid and it is awaiting verification.";

// Unpaid, non-archived bills grouped by resident uid.
async function unpaidBillsByUser(db) {
  // Single-field query (no composite index needed); further filtering in code.
  const snap = await db.collection("bills").where("status", "==", "unpaid").get();
  const byUser = {};
  snap.docs.forEach((d) => {
    const b = d.data();
    if (!b.uid || b.isDeleted || typeof b.dueDate !== "string") return;
    (byUser[b.uid] = byUser[b.uid] || []).push({ ref: d.ref, ...b });
  });
  return byUser;
}

// Runs every morning. Two passes over unpaid bills:
//  1. Soft reminder PRE_DUE_REMINDER_DAYS before the due date (once per bill).
//  2. Any bill still unpaid on/after its due date gets a due/overdue reminder,
//     repeated every REMINDER_INTERVAL_DAYS while still unpaid. Skipped on
//     MAINTENANCE_DUE_DAY, when sendMonthlyMaintenanceNotice covers those bills.
// Each pass sends one in-app notification per resident covering all their
// matching bills; sendPushOnNotification turns it into a push.
exports.sendBillDueReminders = onSchedule(
  { schedule: "every day 09:00", timeZone: TIME_ZONE },
  async () => {
    const db = admin.firestore();
    const today = todayKey();
    const preDueKey = addDays(today, PRE_DUE_REMINDER_DAYS);
    const isMonthlyNoticeDay = Number(today.slice(8, 10)) === MAINTENANCE_DUE_DAY;
    const byUser = await unpaidBillsByUser(db);

    let preCount = 0;
    let dueCount = 0;
    for (const uid of Object.keys(byUser)) {
      const upcoming = byUser[uid].filter((b) => b.dueDate === preDueKey && !b.preReminderDate);
      if (upcoming.length) {
        const total = upcoming.reduce((s, b) => s + Number(b.amount || 0), 0);
        const body = upcoming.map((b) => billLine(b, today)).join("\n") +
          `\n\nA gentle reminder: payment is due on ${new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "long" }).format(new Date(Date.parse(preDueKey)))}.` + PAY_FOOTER;
        const batch = db.batch();
        batch.set(db.collection("users").doc(uid).collection("notifications").doc(),
          notificationDoc(`Maintenance bill due in ${PRE_DUE_REMINDER_DAYS} days (${formatMoney(total)})`, body, "bill_reminder"));
        upcoming.forEach((b) => batch.update(b.ref, { preReminderDate: today }));
        await batch.commit();
        preCount++;
      }

      const due = isMonthlyNoticeDay ? [] : byUser[uid].filter((b) => b.dueDate <= today &&
        !(b.lastReminderDate && daysBetween(b.lastReminderDate, today) < REMINDER_INTERVAL_DAYS));
      if (due.length) {
        const total = due.reduce((s, b) => s + Number(b.amount || 0), 0);
        const overdue = due.some((b) => b.dueDate < today);
        const title = overdue
          ? `Maintenance bill overdue (${formatMoney(total)})`
          : `Maintenance bill due today (${formatMoney(total)})`;
        const body = due.map((b) => billLine(b, today)).join("\n") + PAY_FOOTER;
        const batch = db.batch();
        batch.set(db.collection("users").doc(uid).collection("notifications").doc(), notificationDoc(title, body, "bill_reminder"));
        due.forEach((b) => batch.update(b.ref, {
          lastReminderDate: today,
          reminderCount: admin.firestore.FieldValue.increment(1),
        }));
        await batch.commit();
        dueCount++;
      }
    }
    console.log(`${today}: ${preCount} pre-due reminder(s), ${dueCount} due/overdue reminder(s)`);
  }
);

// Runs on the MAINTENANCE_DUE_DAY of every month and notifies every approved,
// non-suspended member that this month's maintenance is due today — whether or
// not a bill has been issued or paid. Members with unpaid bills see the amount.
exports.sendMonthlyMaintenanceNotice = onSchedule(
  { schedule: `${MAINTENANCE_DUE_DAY} of month 09:00`, timeZone: TIME_ZONE },
  async () => {
    const db = admin.firestore();
    const today = todayKey();
    const month = monthLabel(today);
    const [users, byUser] = await Promise.all([
      db.collection("users").where("approved", "==", true).get(),
      unpaidBillsByUser(db),
    ]);

    let sent = 0;
    let batch = db.batch();
    let ops = 0;
    for (const u of users.docs) {
      const data = u.data();
      if (data.suspended === true) continue;
      const unpaid = (byUser[u.id] || []).filter((b) => b.dueDate <= today);
      const total = unpaid.reduce((s, b) => s + Number(b.amount || 0), 0);
      const body = unpaid.length
        ? `Your maintenance bill for ${month} is due today.\n\n` + unpaid.map((b) => billLine(b, today)).join("\n") + PAY_FOOTER
        : `Monthly maintenance for ${month} falls due today, the ${MAINTENANCE_DUE_DAY}th. If you have already paid, thank you — no action needed. Otherwise please pay and submit your payment proof in the Bills tab.`;
      const title = unpaid.length
        ? `Maintenance due today (${formatMoney(total)})`
        : `Maintenance due today — ${month}`;
      batch.set(u.ref.collection("notifications").doc(), notificationDoc(title, body, "bill_reminder"));
      unpaid.forEach((b) => batch.update(b.ref, {
        lastReminderDate: today,
        reminderCount: admin.firestore.FieldValue.increment(1),
      }));
      sent++;
      ops += 1 + unpaid.length;
      if (ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
    }
    if (ops) await batch.commit();
    console.log(`${today}: monthly maintenance notice sent to ${sent} member(s)`);
  }
);

// ---------- recurring monthly bills ----------
// settings/recurringBill: { enabled, amount, category, dueDay, notes,
//   runRequest?: { month: "YYYY-MM", dueDate: "YYYY-MM-DD", by, at }, lastRun }
// A bill is issued to every approved, non-suspended, non-exempt member who
// lives in the society (role resident, or any staff with a house set) and does
// not already have a bill for that month — paid or unpaid, auto or manual.

function pad2(n) { return String(n).padStart(2, "0"); }

function lastDayOfMonth(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function isBillable(u) {
  return u.approved === true && u.suspended !== true && u.billExempt !== true &&
    (u.role === "resident" || (typeof u.house === "string" && u.house.trim() !== ""));
}

async function getRecurringSettings(db) {
  const snap = await db.doc(RECURRING_SETTINGS_PATH).get();
  const s = snap.exists ? snap.data() : {};
  return {
    ref: snap.ref,
    enabled: s.enabled === true,
    amount: Number(s.amount || 0),
    category: s.category || "Monthly Maintenance",
    dueDay: Math.min(Math.max(Number(s.dueDay) || MAINTENANCE_DUE_DAY, 1), 28),
    notes: s.notes || "",
    runRequest: s.runRequest || null,
  };
}

// uids that already hold a non-archived bill of the recurring category for the
// month: matched by the recurringMonth stamp, the period label, or a due date
// inside that month. Other categories (e.g. a one-off repair) don't count.
async function uidsBilledForMonth(db, monthKey, period, category) {
  const cat = String(category || "").trim().toLowerCase();
  const start = `${monthKey}-01`;
  const end = `${monthKey}-${pad2(lastDayOfMonth(monthKey))}`;
  const [byDue, byPeriod, byStamp] = await Promise.all([
    db.collection("bills").where("dueDate", ">=", start).where("dueDate", "<=", end).get(),
    db.collection("bills").where("period", "==", period).get(),
    db.collection("bills").where("recurringMonth", "==", monthKey).get(),
  ]);
  const uids = new Set();
  [...byDue.docs, ...byPeriod.docs, ...byStamp.docs].forEach((d) => {
    const b = d.data();
    if (b.isDeleted || !b.uid || b.status === "cancelled") return;
    const sameCat = String(b.category || "").trim().toLowerCase() === cat;
    if (sameCat || b.recurringMonth === monthKey) uids.add(b.uid);
  });
  return uids;
}

async function issueRecurringBills(db, settings, monthKey, dueDate, trigger) {
  const period = monthLabel(`${monthKey}-01`);
  const [users, already] = await Promise.all([
    db.collection("users").where("approved", "==", true).get(),
    uidsBilledForMonth(db, monthKey, period, settings.category),
  ]);

  const targets = [];
  let skippedBilled = 0;
  let skippedExempt = 0;
  users.docs.forEach((d) => {
    const u = d.data();
    if (!isBillable(u)) { if (u.approved === true && u.suspended !== true && u.billExempt === true) skippedExempt++; return; }
    if (already.has(d.id)) { skippedBilled++; return; }
    targets.push({ uid: d.id, ...u });
  });

  const now = admin.firestore.FieldValue.serverTimestamp();
  let batch = db.batch();
  let ops = 0;
  const flush = async () => { if (ops) { await batch.commit(); batch = db.batch(); ops = 0; } };
  for (const r of targets) {
    const billNo = "BILL-" + Math.floor(100000 + Math.random() * 900000);
    batch.set(db.collection("bills").doc(), {
      billNo,
      uid: r.uid,
      name: r.name || "",
      house: r.house || "",
      category: settings.category,
      period,
      amount: settings.amount,
      currency: "PKR",
      dueDate,
      notes: settings.notes,
      status: "unpaid",
      issuedBy: RECURRING_ISSUER,
      recurring: true,
      recurringMonth: monthKey,
      createdAt: now,
    });
    batch.set(db.collection("users").doc(r.uid).collection("notifications").doc(), notificationDoc(
      `New Maintenance Bill (${billNo})`,
      `${settings.category} for ${period}: ${formatMoney(settings.amount)}. Due by ${dueDate}.`,
      "info"
    ));
    ops += 2;
    if (ops >= 400) await flush();
  }

  const summary = `${period}: ${targets.length} recurring bill(s) of ${formatMoney(settings.amount)} issued, ` +
    `${skippedBilled} already billed, ${skippedExempt} exempt (${trigger})`;
  batch.set(db.collection("audit_log").doc(), {
    entityType: "bill", entityId: monthKey, action: "create", details: summary,
    performedBy: RECURRING_ISSUER, performedByUid: "", role: "system", timestamp: now,
  });
  ops++;
  users.docs.forEach((d) => {
    if (d.data().role === "admin" && d.data().suspended !== true) {
      batch.set(d.ref.collection("notifications").doc(), notificationDoc(
        `Recurring bills issued — ${period}`,
        `${targets.length} bill(s) of ${formatMoney(settings.amount)} issued (due ${dueDate}); ${skippedBilled} member(s) already billed, ${skippedExempt} exempt.`,
        "info"
      ));
      ops++;
    }
  });
  batch.set(settings.ref, {
    lastRun: { at: now, month: monthKey, period, dueDate, issued: targets.length, skippedBilled, skippedExempt, trigger },
  }, { merge: true });
  ops++;
  await flush();
  console.log(summary);
  return { issued: targets.length, skippedBilled, skippedExempt };
}

// Runs on the RECURRING_ISSUE_DAY of every month.
exports.issueMonthlyRecurringBills = onSchedule(
  { schedule: `${RECURRING_ISSUE_DAY} of month 09:00`, timeZone: TIME_ZONE },
  async () => {
    const db = admin.firestore();
    const settings = await getRecurringSettings(db);
    const today = todayKey();
    const monthKey = today.slice(0, 7);
    if (!settings.enabled || !(settings.amount > 0)) {
      console.log(`${today}: recurring bills disabled — nothing issued`);
      return;
    }
    await issueRecurringBills(db, settings, monthKey, `${monthKey}-${pad2(settings.dueDay)}`, "scheduled");
  }
);

// Admin's "Issue now" button writes settings/recurringBill.runRequest; this
// trigger performs the run (so the logic lives in one place) and clears it.
exports.runRecurringBillsOnRequest = onDocumentWritten(
  RECURRING_SETTINGS_PATH,
  async (event) => {
    const after = event.data && event.data.after;
    if (!after || !after.exists) return;
    const req = after.data().runRequest;
    if (!req || !req.month) return;
    const db = admin.firestore();
    const settings = await getRecurringSettings(db);
    await settings.ref.set({ runRequest: admin.firestore.FieldValue.delete() }, { merge: true });
    if (!(settings.amount > 0)) { console.log("Run requested but amount is not set"); return; }
    const monthKey = String(req.month).slice(0, 7);
    const dueDate = typeof req.dueDate === "string" && req.dueDate.length === 10
      ? req.dueDate : `${monthKey}-${pad2(settings.dueDay)}`;
    await issueRecurringBills(db, settings, monthKey, dueDate, `requested by ${req.by || "admin"}`);
  }
);

// ---------- monthly financial summary ----------
// On the 1st, the previous month's money story is written to
// monthly_summaries/{YYYY-MM} (structured, read by the app's Dashboard card and
// PDF) and posted as an announcement to every member. The admin's "Generate"
// button writes settings/monthlySummary.runRequest for any month; a re-run
// refreshes the stored summary and the existing announcement in place instead
// of posting a second one.
const SUMMARY_SETTINGS_PATH = "settings/monthlySummary";
const SUMMARY_AUTHOR = "RPHS Finance (auto)";
const SUMMARY_APP_HINT = "Open Dashboard → Monthly Summaries for the full breakdown and PDF.";

// YYYY-MM-DD of a Firestore Timestamp (in Pakistan time) or of a date string.
function dateKeyOf(value) {
  if (!value) return "";
  if (typeof value === "string") return value.slice(0, 10);
  if (typeof value.toDate === "function") {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(value.toDate());
  }
  return "";
}

function inMonth(value, monthKey) {
  return dateKeyOf(value).slice(0, 7) === monthKey;
}

function prevMonthKey(todayKey) {
  const [y, m] = todayKey.slice(0, 7).split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${pad2(m - 1)}`;
}

const sum = (arr) => arr.reduce((s, x) => s + Number(x.amount || 0), 0);
const live = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((x) => !x.isDeleted);

// Mirrors expenseSource()/transferEnd() in index.html.
function expenseSource(x) {
  return x.source === "fund" && x.fundId ? "fund" : "bills";
}
function transferEnd(t, end) {
  const type = t[end + "Type"] === "fund" ? "fund" : "bills";
  return { type, fundId: type === "fund" ? (t[end + "FundId"] || "") : "", title: t[end + "FundTitle"] || "Fund" };
}
function endLabel(e) {
  return e.type === "fund" ? `Fund: ${e.title}` : "Bills account";
}
function poolBalance(collected, spent, transfers, type, fundId) {
  const hit = (e) => e.type === type && (type === "bills" || e.fundId === fundId);
  const transferredIn = sum(transfers.filter((t) => hit(transferEnd(t, "to"))));
  const transferredOut = sum(transfers.filter((t) => hit(transferEnd(t, "from"))));
  return { collected, spent, transferredIn, transferredOut, balance: collected - spent + transferredIn - transferredOut };
}
function groupTotals(items, keyFn) {
  const map = {};
  items.forEach((x) => { const k = keyFn(x); map[k] = (map[k] || 0) + Number(x.amount || 0); });
  return Object.entries(map).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}

async function buildMonthlySummary(db, monthKey) {
  const period = monthLabel(`${monthKey}-01`);
  const [billsSnap, contribSnap, expSnap, trSnap, fundsSnap, usersSnap] = await Promise.all([
    db.collection("bills").get(),
    db.collection("fund_contributions").get(),
    db.collection("expenses").get(),
    db.collection("transfers").get(),
    db.collection("funds").get(),
    db.collection("users").where("approved", "==", true).get(),
  ]);
  const bills = live(billsSnap).filter((b) => b.status !== "cancelled");
  const contribs = live(contribSnap).filter((c) => c.status === "verified");
  const expenses = live(expSnap);
  const transfers = live(trSnap);
  const funds = live(fundsSnap);
  const members = usersSnap.docs.map((d) => d.data()).filter((u) => u.suspended !== true).length;

  // A bill belongs to the month it is for (recurring stamp or "Month YYYY"
  // period), otherwise to the month it was issued in.
  const issued = bills.filter((b) => b.recurringMonth ? b.recurringMonth === monthKey
    : /^[A-Z][a-z]+ \d{4}$/.test(b.period || "") ? b.period === period
    : inMonth(b.createdAt, monthKey));
  const collected = bills.filter((b) => b.status === "paid" && inMonth(b.paidAt || b.paymentDate || b.createdAt, monthKey));
  const unpaid = bills.filter((b) => b.status === "unpaid");
  const owingHouses = new Set(unpaid.map((b) => b.uid || b.house)).size;
  const mContribs = contribs.filter((c) => inMonth(c.paymentDate || c.createdAt, monthKey));
  const mExpenses = expenses.filter((x) => inMonth(x.expenseDate || x.createdAt, monthKey))
    .sort((a, b) => String(a.expenseDate || "").localeCompare(String(b.expenseDate || "")));
  const mTransfers = transfers.filter((t) => inMonth(t.transferDate || t.createdAt, monthKey))
    .sort((a, b) => String(a.transferDate || "").localeCompare(String(b.transferDate || "")));

  const billsPool = poolBalance(sum(bills.filter((b) => b.status === "paid")),
    sum(expenses.filter((x) => expenseSource(x) === "bills")), transfers, "bills");
  const fundsIn = sum(transfers.filter((t) => transferEnd(t, "to").type === "fund"));
  const fundsOut = sum(transfers.filter((t) => transferEnd(t, "from").type === "fund"));
  const fundsCollected = sum(contribs);
  const fundsSpent = sum(expenses.filter((x) => expenseSource(x) === "fund"));
  const fundsPool = { collected: fundsCollected, spent: fundsSpent, transferredIn: fundsIn, transferredOut: fundsOut,
    balance: fundsCollected - fundsSpent + fundsIn - fundsOut };
  const perFund = funds.map((f) => {
    const p = poolBalance(sum(contribs.filter((c) => c.fundId === f.id)),
      sum(expenses.filter((x) => expenseSource(x) === "fund" && x.fundId === f.id)), transfers, "fund", f.id);
    return { fundId: f.id, title: f.title || "Fund", category: f.category || "", balance: p.balance,
      collectedThisMonth: sum(mContribs.filter((c) => c.fundId === f.id)) };
  }).filter((f) => f.balance !== 0 || f.collectedThisMonth !== 0).sort((a, b) => b.balance - a.balance);

  const totalIn = sum(collected) + sum(mContribs);
  const totalOut = sum(mExpenses);
  return {
    month: monthKey,
    period,
    members,
    bills: {
      issuedCount: issued.length, issuedAmount: sum(issued),
      collectedCount: collected.length, collectedAmount: sum(collected),
      outstandingCount: unpaid.length, outstandingAmount: sum(unpaid), owingHouses,
    },
    contributions: {
      count: mContribs.length, amount: sum(mContribs),
      byFund: groupTotals(mContribs, (c) => c.fundTitle || "Fund"),
    },
    expenses: {
      count: mExpenses.length, amount: totalOut,
      byCategory: groupTotals(mExpenses, (x) => x.category || "Other"),
      bySource: groupTotals(mExpenses, (x) => expenseSource(x) === "fund" ? `Fund: ${x.fundTitle || "Community Fund"}` : "Bills account"),
      items: mExpenses.slice(0, 150).map((x) => ({
        date: x.expenseDate || dateKeyOf(x.createdAt), category: x.category || "Other",
        description: x.description || "", amount: Number(x.amount || 0),
        source: expenseSource(x) === "fund" ? `Fund: ${x.fundTitle || "Community Fund"}` : "Bills account",
      })),
    },
    transfers: mTransfers.map((t) => ({
      date: t.transferDate || dateKeyOf(t.createdAt), from: endLabel(transferEnd(t, "from")),
      to: endLabel(transferEnd(t, "to")), amount: Number(t.amount || 0), note: t.note || "",
    })),
    totals: { in: totalIn, out: totalOut, net: totalIn - totalOut },
    balances: { bills: billsPool, funds: fundsPool, perFund },
  };
}

function summaryText(s, asOf) {
  const L = [];
  const money = formatMoney;
  const list = (rows) => rows.map((r) => `• ${r.label}: ${money(r.value)}`);
  L.push(`COLLECTED IN ${s.period.toUpperCase()}`);
  L.push(`• Maintenance bills paid: ${money(s.bills.collectedAmount)} (${s.bills.collectedCount} bill${s.bills.collectedCount === 1 ? "" : "s"})`);
  L.push(`• Fund contributions verified: ${money(s.contributions.amount)}${s.contributions.byFund.length ? " — " + s.contributions.byFund.map((f) => `${f.label} ${money(f.value)}`).join(", ") : ""}`);
  L.push(`Total in: ${money(s.totals.in)}`);
  L.push("");
  L.push(`SPENT: ${money(s.expenses.amount)} (${s.expenses.count} expense${s.expenses.count === 1 ? "" : "s"})`);
  L.push(...(s.expenses.byCategory.length ? list(s.expenses.byCategory) : ["• No expenses recorded this month."]));
  if (s.expenses.bySource.length > 1) L.push(`Paid from: ${s.expenses.bySource.map((x) => `${x.label} ${money(x.value)}`).join(" · ")}`);
  L.push(`Net for the month: ${s.totals.net >= 0 ? "+" : "−"}${money(Math.abs(s.totals.net))}`);
  if (s.transfers.length) {
    L.push("");
    L.push("TRANSFERS");
    s.transfers.forEach((t) => L.push(`• ${t.from} → ${t.to}: ${money(t.amount)}${t.note ? " (" + t.note + ")" : ""}`));
  }
  L.push("");
  L.push(`BALANCES (as of ${asOf})`);
  L.push(`• Bills account: ${money(s.balances.bills.balance)}`);
  L.push(`• Community funds: ${money(s.balances.funds.balance)}${s.balances.perFund.length ? " — " + s.balances.perFund.map((f) => `${f.title} ${money(f.balance)}`).join(", ") : ""}`);
  L.push("");
  L.push(s.bills.outstandingCount
    ? `OUTSTANDING: ${money(s.bills.outstandingAmount)} still owed on ${s.bills.outstandingCount} unpaid bill${s.bills.outstandingCount === 1 ? "" : "s"} by ${s.bills.owingHouses} house${s.bills.owingHouses === 1 ? "" : "s"}. Please clear your dues in the Bills tab.`
    : "OUTSTANDING: none — every issued bill has been paid. Thank you!");
  L.push("");
  L.push(SUMMARY_APP_HINT);
  return L.join("\n");
}

async function publishMonthlySummary(db, monthKey, trigger) {
  const today = todayKey();
  const asOf = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" })
    .format(new Date(Date.parse(today)));
  const summary = await buildMonthlySummary(db, monthKey);
  const title = `Monthly Financial Summary — ${summary.period}`;
  const content = summaryText(summary, asOf);
  const now = admin.firestore.FieldValue.serverTimestamp();
  const summaryRef = db.collection("monthly_summaries").doc(monthKey);
  const existing = await summaryRef.get();
  const prevAnnouncementId = existing.exists ? existing.data().announcementId : null;
  const prevAnnouncement = prevAnnouncementId ? await db.collection("announcements").doc(prevAnnouncementId).get() : null;

  let announcementRef;
  let posted = false;
  if (prevAnnouncement && prevAnnouncement.exists) {
    announcementRef = prevAnnouncement.ref;
    await announcementRef.update({ title, content, summaryMonth: monthKey, updatedAt: now });
  } else {
    announcementRef = db.collection("announcements").doc();
    await announcementRef.set({
      title, content, allowComments: true, summaryMonth: monthKey,
      createdBy: "system", createdByName: SUMMARY_AUTHOR, createdByRole: "management", createdAt: now,
    });
    posted = true;
  }

  await summaryRef.set({
    ...summary, announcementId: announcementRef.id, trigger,
    generatedAt: now, generatedOn: today, asOf,
    ...(existing.exists ? { regeneratedCount: admin.firestore.FieldValue.increment(1) } : { regeneratedCount: 0 }),
  }, { merge: true });

  let notified = 0;
  if (posted) {
    const users = await db.collection("users").where("approved", "==", true).get();
    const body = `${summary.period}: collected ${formatMoney(summary.totals.in)}, spent ${formatMoney(summary.totals.out)}. ` +
      `Bills account ${formatMoney(summary.balances.bills.balance)}, funds ${formatMoney(summary.balances.funds.balance)}. Tap to read the full breakdown.`;
    let batch = db.batch();
    let ops = 0;
    for (const u of users.docs) {
      if (u.data().suspended === true) continue;
      batch.set(u.ref.collection("notifications").doc(), { ...notificationDoc(title, body, "notice"), category: "notices" });
      notified++;
      if (++ops >= 400) { await batch.commit(); batch = db.batch(); ops = 0; }
    }
    if (ops) await batch.commit();
  }

  await db.collection("audit_log").add({
    entityType: "report", entityId: monthKey, action: posted ? "create" : "update",
    details: `Monthly financial summary for ${summary.period} ${posted ? "posted" : "refreshed"} (${trigger}); ` +
      `in ${formatMoney(summary.totals.in)}, out ${formatMoney(summary.totals.out)}, ${notified} member(s) notified`,
    performedBy: SUMMARY_AUTHOR, performedByUid: "", role: "system", timestamp: now,
  });
  console.log(`${today}: monthly summary ${monthKey} ${posted ? "posted" : "refreshed"} (${trigger}), ${notified} notified`);
  return { posted, notified };
}

// Runs on the 1st, after the recurring bills have gone out, for the month just ended.
exports.postMonthlyFinancialSummary = onSchedule(
  { schedule: "1 of month 09:30", timeZone: TIME_ZONE },
  async () => {
    const db = admin.firestore();
    const monthKey = prevMonthKey(todayKey());
    const existing = await db.collection("monthly_summaries").doc(monthKey).get();
    if (existing.exists && existing.data().announcementId) {
      console.log(`${monthKey}: summary already published — skipping scheduled run`);
      return;
    }
    await publishMonthlySummary(db, monthKey, "scheduled");
  }
);

// Admin's "Generate" button writes settings/monthlySummary.runRequest = { month, by, at }.
exports.runMonthlySummaryOnRequest = onDocumentWritten(
  SUMMARY_SETTINGS_PATH,
  async (event) => {
    const after = event.data && event.data.after;
    if (!after || !after.exists) return;
    const req = after.data().runRequest;
    if (!req || !req.month) return;
    const db = admin.firestore();
    await after.ref.set({ runRequest: admin.firestore.FieldValue.delete() }, { merge: true });
    const monthKey = String(req.month).slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(monthKey)) { console.log("Summary requested for invalid month", req.month); return; }
    const result = await publishMonthlySummary(db, monthKey, `requested by ${req.by || "admin"}`);
    await after.ref.set({ lastRun: { month: monthKey, by: req.by || "admin", at: admin.firestore.FieldValue.serverTimestamp(), ...result } }, { merge: true });
  }
);

// Sends a push notification to the target user's registered device whenever an
// in-app notification document is created under users/{uid}/notifications.
exports.sendPushOnNotification = onDocumentCreated(
  "users/{uid}/notifications/{notificationId}",
  async (event) => {
    const data = event.data && event.data.data();
    if (!data || !data.title) return;

    const uid = event.params.uid;
    const tokenDoc = await admin.firestore().collection("fcm_tokens").doc(uid).get();
    if (!tokenDoc.exists) return;
    if (await isPushMuted(uid, data)) return;

    const token = tokenDoc.data().token;
    if (!token) return;

    try {
      await admin.messaging().send({
        token,
        notification: {
          title: data.title,
          body: data.body || data.text || "",
        },
        webpush: {
          notification: {
            icon: "https://naveedsher96-oss.github.io/RP-Housing-PWA/icon-192.png",
          },
          fcmOptions: {
            link: "https://naveedsher96-oss.github.io/RP-Housing-PWA/",
          },
        },
      });
    } catch (err) {
      if (
        err.code === "messaging/registration-token-not-registered" ||
        err.code === "messaging/invalid-registration-token"
      ) {
        await tokenDoc.ref.delete();
      } else {
        console.error("Push send failed for", uid, err);
      }
    }
  }
);
