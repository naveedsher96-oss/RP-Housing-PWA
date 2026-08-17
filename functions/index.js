const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");

admin.initializeApp();

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
