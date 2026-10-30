const { onDocumentCreated, onDocumentUpdated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const crypto = require("crypto");

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
// The due date only counts for bills without a month period: a "September 2026"
// bill issued late in September falls due on 20 October but is not October's.
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
  const isMonthPeriod = (p) => /^[a-z]+ \d{4}$/i.test(String(p || "").trim());
  const dueOnly = byDue.docs.filter((d) => !isMonthPeriod(d.data().period));
  [...dueOnly, ...byPeriod.docs, ...byStamp.docs].forEach((d) => {
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

// Late fee (settings/recurringBill: lateFeeEnabled, lateFeeAmount, lateFeeGraceDays,
// lateFeeSince). Every morning, each unpaid bill of the recurring category whose
// due date is on/after lateFeeSince and more than the grace days in the past gets
// the fee added once (lateFeeApplied). Replaces the old on-app-open client check.
async function applyLateFees(db, today) {
  const snap = await db.doc(RECURRING_SETTINGS_PATH).get();
  const s = snap.exists ? snap.data() : {};
  const fee = Number(s.lateFeeAmount) || 0;
  if (s.lateFeeEnabled !== true || !(fee > 0) || typeof s.lateFeeSince !== "string") {
    return { applied: 0, skipped: "disabled" };
  }
  const cutoff = addDays(today, -(Number(s.lateFeeGraceDays) || 0));
  const category = String(s.category || "Monthly Maintenance").trim().toLowerCase();
  const unpaid = await db.collection("bills").where("status", "==", "unpaid").get();
  const due = unpaid.docs.filter((d) => {
    const b = d.data();
    return !b.isDeleted && b.lateFeeApplied !== true && typeof b.dueDate === "string"
      && String(b.category || "").trim().toLowerCase() === category
      && b.dueDate >= s.lateFeeSince && b.dueDate < cutoff;
  });
  const now = admin.firestore.FieldValue.serverTimestamp();
  let batch = db.batch();
  let ops = 0;
  const flush = async () => { if (ops) { await batch.commit(); batch = db.batch(); ops = 0; } };
  for (const d of due) {
    const b = d.data();
    const base = Number(b.amount || 0);
    batch.update(d.ref, { amount: base + fee, baseAmount: base, lateFee: fee, lateFeeApplied: true, lateFeeAt: now });
    batch.set(db.collection("audit_log").doc(), {
      entityType: "bill", entityId: d.id, action: "late_fee",
      details: `Late fee ${formatMoney(fee)} added to ${b.billNo || d.id} (${b.name || ""})`,
      performedBy: RECURRING_ISSUER, performedByUid: "", role: "system", timestamp: now,
    });
    ops += 2;
    if (b.uid) {
      batch.set(db.collection("users").doc(b.uid).collection("notifications").doc(), notificationDoc(
        `Late fee added (${b.billNo || "bill"})`,
        `${b.period || b.category || "Your bill"} is overdue, so a late fee of ${formatMoney(fee)} was added. New total: ${formatMoney(base + fee)}.${PAY_FOOTER}`,
        "warning"
      ));
      ops++;
    }
    if (ops >= 400) await flush();
  }
  batch.set(snap.ref, { lateFeeLastRun: { at: now, date: today, applied: due.length } }, { merge: true });
  ops++;
  await flush();
  console.log(`${today}: late fee ${formatMoney(fee)} applied to ${due.length} bill(s)`);
  return { applied: due.length };
}

exports.applyLateFeesDaily = onSchedule(
  { schedule: "every day 09:15", timeZone: TIME_ZONE },
  async () => applyLateFees(admin.firestore(), todayKey())
);

// ---------- final notice & restriction for long-unpaid accounts ----------
// settings/recurringBill: finalNoticeEnabled, finalNoticeMonths (default 3),
// finalNoticeDays (default 5). Every morning each approved resident with that
// many months of overdue bills gets ONE final notice (in-app + push): pay
// within the given days or the account is restricted. users/{uid}.finalNotice
// records it; an admin restricts by hand from Defaulters once it has passed.
// Restricted (users/{uid}.restricted) residents can still pay and use the
// Emergency Alarm. The notice is cleared once they drop below the threshold,
// and a non-payment restriction lifts itself once nothing is overdue or in review.
const FINAL_NOTICE_MONTHS = 3;
const FINAL_NOTICE_DAYS = 5;

function longDate(key) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "long" })
    .format(new Date(Date.parse(key)));
}

// Months a resident is behind: distinct billing periods among overdue bills of
// the recurring category (one-off charges don't count as a month). total covers
// every overdue bill; open = overdue + bills whose proof is still in review.
function arrearsOf(bills, today, category) {
  const cat = String(category || "Monthly Maintenance").trim().toLowerCase();
  const overdue = bills.filter((b) => b.status === "unpaid" && b.dueDate < today);
  const months = new Set(overdue.filter((b) => String(b.category || "").trim().toLowerCase() === cat)
    .map((b) => String(b.period || b.dueDate.slice(0, 7)).trim().toLowerCase()));
  return {
    months: months.size,
    total: overdue.reduce((s, b) => s + Number(b.amount || 0), 0),
    open: overdue.length + bills.filter((b) => b.status === "submitted").length,
  };
}

async function openBillsByUser(db, uid) {
  const q = db.collection("bills").where("status", "in", ["unpaid", "submitted"]);
  const snap = await (uid ? q.where("uid", "==", uid) : q).get();
  const byUser = {};
  snap.docs.forEach((d) => {
    const b = d.data();
    if (!b.uid || b.isDeleted || typeof b.dueDate !== "string") return;
    (byUser[b.uid] = byUser[b.uid] || []).push(b);
  });
  return byUser;
}

function liftRestriction(batch, ref, now) {
  batch.update(ref, {
    restricted: false, restrictedReason: admin.firestore.FieldValue.delete(),
    restrictedAt: admin.firestore.FieldValue.delete(), restrictedBy: admin.firestore.FieldValue.delete(),
    finalNotice: admin.firestore.FieldValue.delete(),
  });
  batch.set(ref.collection("notifications").doc(), {
    ...notificationDoc("Account access restored",
      "Thank you for clearing your dues. Your RPHS app account is fully active again.", "success"),
    category: "membership",
  });
  batch.set(admin.firestore().collection("audit_log").doc(), {
    entityType: "member", entityId: ref.id, action: "update",
    details: "Unpaid-dues suspension lifted automatically: overdue bills cleared",
    performedBy: RECURRING_ISSUER, performedByUid: "", role: "system", timestamp: now,
  });
}

async function sendFinalNotices(db, today) {
  const settingsSnap = await db.doc(RECURRING_SETTINGS_PATH).get();
  const s = settingsSnap.exists ? settingsSnap.data() : {};
  const enabled = s.finalNoticeEnabled === true;
  const minMonths = Math.max(1, Number(s.finalNoticeMonths) || FINAL_NOTICE_MONTHS);
  const days = Math.max(1, Number(s.finalNoticeDays) || FINAL_NOTICE_DAYS);
  const [users, byUser] = await Promise.all([
    db.collection("users").where("approved", "==", true).get(),
    openBillsByUser(db),
  ]);
  const now = admin.firestore.FieldValue.serverTimestamp();
  let batch = db.batch();
  let ops = 0;
  const flush = async () => { if (ops) { await batch.commit(); batch = db.batch(); ops = 0; } };
  const sent = [];
  const passed = [];
  let cleared = 0;
  let lifted = 0;

  for (const d of users.docs) {
    const u = d.data();
    if (u.role !== "resident" || u.suspended === true) continue;
    const a = arrearsOf(byUser[d.id] || [], today, s.category);
    if (u.restricted === true && u.restrictedReason === "unpaid" && a.open === 0) {
      liftRestriction(batch, d.ref, now);
      ops += 3;
      lifted++;
    } else if (u.finalNotice && a.months < minMonths && u.restricted !== true) {
      batch.update(d.ref, { finalNotice: admin.firestore.FieldValue.delete() });
      ops++;
      cleared++;
    } else if (enabled && !u.finalNotice && u.restricted !== true && a.months >= minMonths) {
      const deadline = addDays(today, days);
      batch.update(d.ref, { finalNotice: { date: today, deadline, months: a.months, total: a.total, sentAt: now } });
      batch.set(d.ref.collection("notifications").doc(), {
        ...notificationDoc("Final Notice — Suspension Warning",
          `Your account has unpaid dues of ${formatMoney(a.total)} (${a.months} months). ` +
          `Pay by ${longDate(deadline)} or your account will be suspended: ` +
          "no voting, complaints, posts or comments until it is paid. " +
          "Bills, payments and the Emergency Alarm keep working." + PAY_FOOTER, "warning"),
        category: "bills",
      });
      ops += 2;
      sent.push(`${u.name || "Resident"} (${u.house || "N/A"})`);
    } else if (u.finalNotice && u.restricted !== true && !u.finalNotice.adminTold &&
        typeof u.finalNotice.deadline === "string" && u.finalNotice.deadline < today) {
      batch.update(d.ref, { "finalNotice.adminTold": true });
      ops++;
      passed.push(`${u.name || "Resident"} (${u.house || "N/A"})`);
    }
    if (ops >= 400) await flush();
  }

  const tell = (title, body) => users.docs.forEach((d) => {
    if (d.data().role === "admin" && d.data().suspended !== true) {
      batch.set(d.ref.collection("notifications").doc(), { ...notificationDoc(title, body, "info"), category: "bills" });
      ops++;
    }
  });
  if (sent.length) {
    tell(`Suspension warning sent to ${sent.length} resident(s)`,
      `${minMonths}+ months unpaid, asked to pay by ${longDate(addDays(today, days))}: ${sent.join(", ")}. See the Bills tab.`);
  }
  if (passed.length) {
    tell(`Payment deadline passed for ${passed.length} resident(s)`,
      `${passed.join(", ")} did not pay after the final notice. You can suspend them from the Bills tab.`);
  }
  if (sent.length || lifted) {
    batch.set(db.collection("audit_log").doc(), {
      entityType: "bill", entityId: today, action: "notify",
      details: `Final notices: ${sent.length} sent${sent.length ? " (" + sent.join(", ") + ")" : ""}; ${lifted} restriction(s) lifted`,
      performedBy: RECURRING_ISSUER, performedByUid: "", role: "system", timestamp: now,
    });
    ops++;
  }
  await flush();
  console.log(`${today}: final notices ${sent.length} sent, ${passed.length} past deadline, ${cleared} cleared, ${lifted} restriction(s) lifted`);
  return { sent: sent.length, passed: passed.length, cleared, lifted };
}

exports.sendFinalNoticesDaily = onSchedule(
  { schedule: "every day 09:30", timeZone: TIME_ZONE },
  async () => sendFinalNotices(admin.firestore(), todayKey())
);

// Lift a non-payment restriction as soon as the last overdue bill is approved
// as paid, instead of waiting for the next morning.
exports.liftRestrictionOnPayment = onDocumentUpdated("bills/{billId}", async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (!after || !after.uid || before.status === after.status || after.status !== "paid") return;
  const db = admin.firestore();
  const ref = db.collection("users").doc(after.uid);
  const snap = await ref.get();
  const u = snap.exists ? snap.data() : null;
  if (!u || u.restricted !== true || u.restrictedReason !== "unpaid") return;
  const a = arrearsOf((await openBillsByUser(db, after.uid))[after.uid] || [], todayKey(), after.category);
  if (a.open > 0) return;
  const batch = db.batch();
  liftRestriction(batch, ref, admin.firestore.FieldValue.serverTimestamp());
  await batch.commit();
});

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

// One push. Every push is sent with high urgency: at normal urgency Android
// holds it back while the phone is idle (Doze), so alerts arrived late or only
// when the app was opened. Emergency pushes also stay on screen until dismissed,
// vibrate, and re-alert (sound again) when repeated with the same tag.
// Emergency pushes to the RPHS Android app (alarmApp: its token was saved with
// alarm >= 1) go as data-only messages, so the app itself handles them even when
// closed: a siren (the alarm) shows full screen with the siren on the alarm
// volume, and its "All clear" stops the siren. Other Android app tokens get the Emergency or Alerts
// channel; browsers ignore the android block.
function pushMessage(token, title, body, category, opts = {}) {
  const emergency = category === "emergency";
  const ttlSeconds = emergency ? 600 : 3 * 86400;
  if (emergency && opts.alarmApp) {
    // siren: show the alarm; clear: the "All clear", which also stops the siren.
    return {
      token,
      data: { category, [opts.siren ? "siren" : "clear"]: "1", title: String(title), body: String(body) },
      android: { priority: "high", ttl: ttlSeconds * 1000 },
    };
  }
  return {
    token,
    notification: { title, body },
    data: { category },
    android: {
      priority: "high",
      ttl: ttlSeconds * 1000,
      notification: { channelId: opts.siren ? "rphs_emergency" : "rphs_alerts", ...(emergency ? { tag: "rphs-emergency" } : {}) },
    },
    webpush: {
      headers: { Urgency: "high", TTL: String(ttlSeconds) },
      notification: {
        icon: "https://naveedsher96-oss.github.io/RP-Housing-PWA/icon-192.png",
        ...(emergency ? { requireInteraction: true, vibrate: [700, 250, 700, 250, 700, 250, 700], tag: "rphs-emergency", renotify: true } : {}),
      },
      fcmOptions: { link: "https://naveedsher96-oss.github.io/RP-Housing-PWA/" },
    },
  };
}

// Every device a member is signed in on: fcm_tokens/{uid}.tokens holds one entry
// per phone/computer (newest first, at most MAX_DEVICES); `token` is the older
// single-device field, still read so nobody misses alerts before they reopen the app.
const MAX_DEVICES = 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function deviceTokens(tokenDoc) {
  if (!tokenDoc || !tokenDoc.exists) return [];
  const d = tokenDoc.data() || {};
  const map = d.tokens && typeof d.tokens === "object" ? d.tokens : {};
  const at = (v) => (v && v.updatedAt && v.updatedAt.toMillis ? v.updatedAt.toMillis() : 0);
  const list = Object.keys(map).sort((a, b) => at(map[b]) - at(map[a])).slice(0, MAX_DEVICES);
  if (d.token && !list.includes(d.token)) list.push(d.token);
  return list;
}
// Tokens of the RPHS Android app versions that can show the siren alarm.
function alarmAppTokens(tokenDoc) {
  const map = (tokenDoc && tokenDoc.exists && tokenDoc.data().tokens) || {};
  return new Set(Object.keys(map).filter((t) => map[t] && Number(map[t].alarm) >= 1));
}
function isDeadToken(err) {
  const code = err && err.code;
  return code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token";
}
// Removes tokens FCM says are gone (app uninstalled, site data cleared).
async function dropTokens(ref, dead) {
  if (!dead.length) return;
  const snap = await ref.get();
  if (!snap.exists) return;
  const args = [];
  dead.forEach((t) => args.push(new admin.firestore.FieldPath("tokens", t), admin.firestore.FieldValue.delete()));
  if (dead.includes(snap.data().token)) args.push("token", admin.firestore.FieldValue.delete());
  await ref.update(...args);
}

// Sends a push notification to each of the target user's devices whenever an
// in-app notification document is created under users/{uid}/notifications.
// A "Send a test alert" from Profile (testPush) waits 15 seconds so the member
// has time to close the app and see a real background alert.
exports.sendPushOnNotification = onDocumentCreated(
  "users/{uid}/notifications/{notificationId}",
  async (event) => {
    const data = event.data && event.data.data();
    if (!data || !data.title) return;

    const uid = event.params.uid;
    const ref = admin.firestore().collection("fcm_tokens").doc(uid);
    if (data.testPush !== true && (await isPushMuted(uid, data))) return;
    if (data.testPush === true) await sleep(15000);
    const tokenDoc = await ref.get();
    const tokens = deviceTokens(tokenDoc);
    if (!tokens.length) return;

    const category = notifCategory(data);
    // An emergency alarm rings the siren; its "All clear" (type notice) doesn't.
    const siren = category === "emergency" && data.type !== "notice";
    const alarmApp = alarmAppTokens(tokenDoc);
    const res = await admin.messaging().sendEach(tokens.map((t) =>
      pushMessage(t, data.title, data.body || data.text || "", category, { siren, alarmApp: alarmApp.has(t) })));
    const dead = [];
    res.responses.forEach((r, i) => {
      if (r.success) return;
      if (isDeadToken(r.error)) dead.push(tokens[i]);
      else console.error("Push send failed for", uid, r.error);
    });
    await dropTokens(ref, dead);
  }
);

// The member who raised an alertAll post, if still approved and active.
async function activeAuthor(db, uid) {
  if (!uid) return null;
  const snap = await db.collection("users").doc(uid).get();
  const a = snap.exists ? snap.data() : null;
  return a && a.approved === true && a.suspended !== true ? a : null;
}

// One in-app notification (and so one push) to every approved, active member
// except skipUid. Used for posts residents raise, since they cannot read the
// member list to notify everyone themselves.
async function notifyAllMembers(db, skipUid, title, body, type, category) {
  const users = await db.collection("users").where("approved", "==", true).get();
  const targets = users.docs.filter((d) => d.id !== skipUid && d.data().suspended !== true);
  for (let i = 0; i < targets.length; i += 400) {
    const batch = db.batch();
    targets.slice(i, i + 400).forEach((d) => {
      batch.set(d.ref.collection("notifications").doc(), { ...notificationDoc(title, body, type), category });
    });
    await batch.commit();
  }
}

// Society calendar reminder: every evening, a notification to every member for
// each calendar item happening tomorrow (one-off, weekly or monthly repeats).
function eventFallsOn(ev, key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ev.date || "")) || ev.date > key) return false;
  if (ev.repeat === "weekly") return daysBetween(ev.date, key) % 7 === 0;
  if (ev.repeat === "monthly") return ev.date.slice(8, 10) === key.slice(8, 10);
  return ev.date === key;
}
function eventTimeLabel(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ""));
  if (!m) return "";
  const h = Number(m[1]);
  return `${((h + 11) % 12) + 1}:${m[2]} ${h < 12 ? "am" : "pm"}`;
}
exports.sendEventReminders = onSchedule(
  { schedule: "every day 18:00", timeZone: TIME_ZONE },
  async () => {
    const db = admin.firestore();
    const tomorrow = addDays(todayKey(), 1);
    const snap = await db.collection("events").get();
    const due = snap.docs.map((d) => d.data()).filter((ev) => !ev.isDeleted && eventFallsOn(ev, tomorrow));
    for (const ev of due) {
      const when = [eventTimeLabel(ev.time), ev.place || ""].filter(Boolean).join(" · ");
      await notifyAllMembers(db, null, `Tomorrow: ${String(ev.title || "Society calendar").slice(0, 90)}`,
        `${when ? when + ". " : ""}${String(ev.note || "Open Calendar in the RPHS app for details.").slice(0, 250)}`, "notice", "notices");
    }
    console.log(`Event reminders for ${tomorrow}: ${due.length}`);
  }
);

// Lost & Found alert: a new listing with alertAll: true (lost/found only, see
// firestore.rules) notifies every approved member except the poster.
exports.listingAlert = onDocumentCreated(
  "listings/{listingId}",
  async (event) => {
    const l = event.data && event.data.data();
    if (!l || l.alertAll !== true || !["lost", "found"].includes(l.kind)) return;
    const db = admin.firestore();
    const a = await activeAuthor(db, l.createdBy);
    if (!a) return;
    const title = `${l.kind === "lost" ? "🔍 Lost" : "🎁 Found"}: ${String(l.title || "").slice(0, 80)}`;
    const body = `${a.name || "A resident"}${a.house ? " (" + a.house + ")" : ""}${l.location ? " · " + String(l.location).slice(0, 80) : ""} — open Lost & Found to help.`;
    await notifyAllMembers(db, l.createdBy, title, body, "notice", "general");
  }
);

// Emergency alarm raised by a resident (announcement with emergency and
// alertAll: true): high-priority push to every member, never muted.
exports.emergencyAlert = onDocumentCreated(
  "announcements/{id}",
  async (event) => {
    const n = event.data && event.data.data();
    if (!n || n.emergency !== true || n.alertAll !== true) return;
    const db = admin.firestore();
    if (!(await activeAuthor(db, n.createdBy))) return;
    await notifyAllMembers(db, n.createdBy, "🚨 EMERGENCY: " + String(n.title || "").slice(0, 90),
      String(n.content || "Open the RPHS app now.").slice(0, 300), "error", "emergency");
  }
);

// All-clear for those alarms once they are resolved (by the raiser or management).
exports.emergencyAllClear = onDocumentUpdated(
  "announcements/{id}",
  async (event) => {
    const before = event.data && event.data.before.data();
    const after = event.data && event.data.after.data();
    if (!before || !after || after.emergency !== true || (after.alertAll !== true && !after.familyOf)) return;
    if (before.resolvedAt || !after.resolvedAt) return;
    const by = after.resolvedBy ? ` by ${String(after.resolvedBy).slice(0, 60)}` : "";
    const title = "All clear: " + String(after.title || "").slice(0, 90);
    const body = `This emergency has been marked resolved${by}.`;
    if (after.familyOf) {
      const db = admin.firestore();
      await notifyUids(db, await familyAlarmTargets(db, after), title, body, "notice", "emergency");
      return;
    }
    await notifyAllMembers(admin.firestore(), null, title, body, "notice", "emergency");
  }
);

// Alarm while the app is closed: browsers cannot play a custom siren from a
// notification, so for every new emergency the push is repeated every
// ALARM_REPEAT_SECONDS (each one beeps and vibrates again) for ALARM_REPEAT_ROUNDS
// rounds, to every member who has not tapped "I've seen it" in the app
// (announcements/{id}/acks/{uid}), until the emergency is resolved. The first
// alert is the normal emergency notification, so repeats start one interval later.
const ALARM_REPEAT_SECONDS = 20;
const ALARM_REPEAT_ROUNDS = 9; // about 3 minutes

exports.emergencyAlarmRepeat = onDocumentCreated(
  { document: "announcements/{id}", timeoutSeconds: 300 },
  async (event) => {
    const n = event.data && event.data.data();
    if (!n || n.emergency !== true) return;
    const db = admin.firestore();
    const ref = event.data.ref;
    const title = "🚨 EMERGENCY: " + String(n.title || "").slice(0, 90);
    const body = String(n.content || "Open the RPHS app now.").slice(0, 200) + "\n\nOpen the app and tap \"I've seen it\" to stop the alarm.";
    let uids;
    if (n.familyOf) {
      uids = (await familyAlarmTargets(db, n)).filter((uid) => uid !== n.createdBy);
    } else {
      const members = await db.collection("users").where("approved", "==", true).get();
      uids = members.docs.filter((d) => d.id !== n.createdBy && d.data().suspended !== true).map((d) => d.id);
    }
    const tokens = {}; // uid -> that member's device tokens
    const alarmApp = new Set(); // tokens of app versions that show the siren alarm
    await Promise.all(uids.map(async (uid) => {
      const doc = await db.collection("fcm_tokens").doc(uid).get();
      const list = deviceTokens(doc);
      if (list.length) tokens[uid] = list;
      alarmAppTokens(doc).forEach((t) => alarmApp.add(t));
    }));

    for (let round = 1; round <= ALARM_REPEAT_ROUNDS; round++) {
      await sleep(ALARM_REPEAT_SECONDS * 1000);
      const now = await ref.get();
      if (!now.exists || now.data().resolvedAt || now.data().isDeleted) return;
      const acked = new Set((await ref.collection("acks").get()).docs.map((d) => d.id));
      const left = Object.keys(tokens).filter((uid) => !acked.has(uid));
      if (!left.length) return;
      const sends = [];
      left.forEach((uid) => tokens[uid].forEach((t) => sends.push({ uid, t })));
      for (let i = 0; i < sends.length; i += 500) {
        const chunk = sends.slice(i, i + 500);
        const res = await admin.messaging().sendEach(chunk.map((s) => pushMessage(s.t, title, body, "emergency", { siren: true, alarmApp: alarmApp.has(s.t) })));
        res.responses.forEach((r, j) => {
          if (!isDeadToken(r.error)) return;
          const s = chunk[j];
          tokens[s.uid] = tokens[s.uid].filter((t) => t !== s.t);
          if (!tokens[s.uid].length) delete tokens[s.uid];
        });
      }
    }
  }
);

// ---------- Family Emergency Access ----------
// A resident shares one 6-digit code (Profile > Family Emergency Access) with
// family members on other phones. They enter it on the sign-in screen, are
// signed in anonymously and linked to the house in family/{uid}. Family phones
// only see the SOS screen; their alarm (announcement with familyOf: residentUid)
// goes to management, the resident and the house's other family phones. It
// keeps working while the resident is suspended.
const FAMILY_MAX_PHONES = 6;
const FAMILY_MAX_FAILS = 20; // wrong codes per hour from one connection
const STAFF_ROLES = ["admin", "board", "superadmin"];

// The resident's code: created on first ask, replaced on renew (the old code
// stops working; phones already linked stay linked).
exports.familyCode = onCall(async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Please sign in again.");
  const db = admin.firestore();
  const userRef = db.collection("users").doc(uid);
  const u = (await userRef.get()).data();
  if (!u || (u.approved !== true && !STAFF_ROLES.includes(u.role))) {
    throw new HttpsError("permission-denied", "Only approved members can add family phones.");
  }
  if (u.familyCode && !(req.data && req.data.renew)) return { code: u.familyCode };
  for (let i = 0; i < 20; i++) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    const ref = db.collection("familyCodes").doc(code);
    const made = await db.runTransaction(async (tx) => {
      if ((await tx.get(ref)).exists) return false;
      tx.set(ref, { residentUid: uid, createdAt: admin.firestore.FieldValue.serverTimestamp() });
      if (u.familyCode) tx.delete(db.collection("familyCodes").doc(String(u.familyCode)));
      tx.update(userRef, { familyCode: code });
      return true;
    });
    if (made) return { code };
  }
  throw new HttpsError("unavailable", "Could not make a code. Please try again.");
});

// Links an anonymously signed-in phone to the house whose code it entered.
exports.linkFamilyPhone = onCall(async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Please try again.");
  if (req.auth.token.firebase.sign_in_provider !== "anonymous") {
    throw new HttpsError("failed-precondition", "This phone is signed in as a member. Sign out first.");
  }
  const code = String((req.data && req.data.code) || "").replace(/\D/g, "");
  const name = String((req.data && req.data.name) || "").replace(/\s+/g, " ").trim().slice(0, 40);
  if (!/^\d{6}$/.test(code)) throw new HttpsError("invalid-argument", "The code has 6 digits.");
  if (!name) throw new HttpsError("invalid-argument", "Please type your name.");

  const db = admin.firestore();
  const raw = req.rawRequest || {};
  const ip = String((raw.headers && raw.headers["x-forwarded-for"]) || raw.ip || uid).split(",")[0].trim();
  const limitRef = db.collection("familyLinkAttempts").doc(crypto.createHash("sha256").update(ip).digest("hex").slice(0, 40));
  const lim = (await limitRef.get()).data();
  const fails = lim && Date.now() - lim.since < 3600000 ? lim.fails : 0;
  if (fails >= FAMILY_MAX_FAILS) {
    throw new HttpsError("resource-exhausted", "Too many wrong codes. Please wait an hour and try again.");
  }
  const wrongCode = async () => {
    await limitRef.set({ since: fails ? lim.since : Date.now(), fails: fails + 1 });
    return new HttpsError("not-found", "That code is not right. Ask your family member for the code in their Profile.");
  };

  const codeDoc = await db.collection("familyCodes").doc(code).get();
  if (!codeDoc.exists) throw await wrongCode();
  const residentUid = codeDoc.data().residentUid;
  const r = (await db.collection("users").doc(residentUid).get()).data();
  if (!r || r.familyCode !== code) throw await wrongCode();

  const linked = await db.collection("family").where("residentUid", "==", residentUid).get();
  if (linked.size >= FAMILY_MAX_PHONES && !linked.docs.some((d) => d.id === uid)) {
    throw new HttpsError("resource-exhausted", `This house already has ${FAMILY_MAX_PHONES} family phones. Ask ${r.name || "the resident"} to remove one in their Profile.`);
  }
  await db.collection("family").doc(uid).set({
    residentUid,
    residentName: r.name || "",
    residentPhone: r.phone || "",
    house: r.house || "",
    name,
    linkedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { house: r.house || "", residentName: r.name || "" };
});

// Who a family alarm reaches: management (admin, board, super admin), the
// resident, and every family phone of that house.
async function familyAlarmTargets(db, n) {
  const [roles, boardFlag, saFlag, fam] = await Promise.all([
    db.collection("users").where("role", "in", STAFF_ROLES).get(),
    db.collection("users").where("boardMember", "==", true).get(),
    db.collection("users").where("superAdmin", "==", true).get(),
    db.collection("family").where("residentUid", "==", n.familyOf).get(),
  ]);
  const uids = new Set([n.familyOf]);
  roles.docs.concat(boardFlag.docs, saFlag.docs).forEach((d) => {
    const u = d.data();
    if (u.approved !== false && u.suspended !== true) uids.add(d.id);
  });
  fam.docs.forEach((d) => uids.add(d.id));
  return [...uids];
}

async function notifyUids(db, uids, title, body, type, category) {
  for (let i = 0; i < uids.length; i += 400) {
    const batch = db.batch();
    uids.slice(i, i + 400).forEach((uid) => {
      batch.set(db.collection("users").doc(uid).collection("notifications").doc(), { ...notificationDoc(title, body, type), category });
    });
    await batch.commit();
  }
}

exports.familyEmergencyAlert = onDocumentCreated(
  "announcements/{id}",
  async (event) => {
    const n = event.data && event.data.data();
    if (!n || n.emergency !== true || !n.familyOf || n.createdByRole !== "family") return;
    const db = admin.firestore();
    const uids = (await familyAlarmTargets(db, n)).filter((uid) => uid !== n.createdBy);
    await notifyUids(db, uids, "🚨 EMERGENCY: " + String(n.title || "").slice(0, 90),
      String(n.content || "Open the RPHS app now.").slice(0, 300), "error", "emergency");
  }
);

exports._applyLateFees = applyLateFees;
exports._sendFinalNotices = sendFinalNotices;
