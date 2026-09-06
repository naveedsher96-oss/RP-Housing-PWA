const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp();
setGlobalOptions({ region: "asia-south1" });

const TIME_ZONE = "Asia/Karachi";
const REMINDER_INTERVAL_DAYS = 7;

function formatMoney(n) {
  return "PKR " + Number(n || 0).toLocaleString("en-PK");
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

// Runs every morning. Any bill still unpaid on/after its due date gets a
// reminder to the resident (in-app notification, which in turn triggers a
// push via sendPushOnNotification). One notification per resident covering all
// their due bills; repeated every REMINDER_INTERVAL_DAYS while still unpaid.
exports.sendBillDueReminders = onSchedule(
  { schedule: "every day 09:00", timeZone: TIME_ZONE },
  async () => {
    const db = admin.firestore();
    const today = todayKey();

    // Single-field query (no composite index needed); due-date filter in code.
    const snap = await db.collection("bills").where("status", "==", "unpaid").get();

    const byUser = {};
    snap.docs.forEach((d) => {
      const b = d.data();
      if (!b.uid || b.isDeleted) return;
      if (typeof b.dueDate !== "string" || b.dueDate > today) return;
      if (b.lastReminderDate && daysBetween(b.lastReminderDate, today) < REMINDER_INTERVAL_DAYS) return;
      (byUser[b.uid] = byUser[b.uid] || []).push({ ref: d.ref, ...b });
    });

    const uids = Object.keys(byUser);
    if (!uids.length) {
      console.log("No bill reminders due on", today);
      return;
    }

    for (const uid of uids) {
      const bills = byUser[uid];
      const total = bills.reduce((s, b) => s + Number(b.amount || 0), 0);
      const overdue = bills.filter((b) => b.dueDate < today);
      const title = overdue.length
        ? `Maintenance bill overdue (${formatMoney(total)})`
        : `Maintenance bill due today (${formatMoney(total)})`;
      const lines = bills.map((b) => {
        const late = daysBetween(b.dueDate, today);
        return `${b.billNo || "Bill"} · ${b.category || "Maintenance"}${b.period ? " for " + b.period : ""}: ${formatMoney(b.amount)}` +
          (late > 0 ? ` (${late} day${late === 1 ? "" : "s"} overdue)` : " (due today)");
      });
      const body = lines.join("\n") +
        "\n\nPlease pay and submit your payment proof in the Bills tab. Ignore if you have already paid and it is awaiting verification.";

      const batch = db.batch();
      batch.set(db.collection("users").doc(uid).collection("notifications").doc(), {
        title,
        body,
        text: body,
        type: "bill_reminder",
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      bills.forEach((b) => batch.update(b.ref, {
        lastReminderDate: today,
        reminderCount: admin.firestore.FieldValue.increment(1),
      }));
      await batch.commit();
    }
    console.log(`Sent bill reminders to ${uids.length} resident(s) on ${today}`);
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
