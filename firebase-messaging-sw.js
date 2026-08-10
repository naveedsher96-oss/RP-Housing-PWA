// firebase-messaging-sw.js
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyA5jR_KvDtN52sIUQiYffXL_1pcoN5vNpk",
  authDomain: "rp-housing-society.firebaseapp.com",
  projectId: "rp-housing-society",
  storageBucket: "rp-housing-society.firebasestorage.app",
  messagingSenderId: "964175352040",
  appId: "1:964175352040:web:a5aadfe8bf9a6d53af395d"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const notificationTitle = payload.notification.title;
  const notificationOptions = {
    body: payload.notification.body,
    icon: '/icon-192.png'
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});
