package pk.rphs.society;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

/**
 * Receives every push. Emergency pushes arrive as data-only messages (sent only
 * to app versions that understand them), so they reach this code even when the
 * app is closed: siren=1 posts a siren notification on the Emergency channel
 * that opens full screen over the lock screen, and clear=1 (the "All clear")
 * stops it. Everything also goes to Capacitor's push plugin as before.
 */
public class EmergencyMessagingService extends MessagingService {

    static final int EMERGENCY_NOTIFICATION_ID = 911;

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        Map<String, String> data = remoteMessage.getData();
        if ("1".equals(data.get("siren"))) {
            showEmergency(this, data.get("title"), data.get("body"));
        } else if ("1".equals(data.get("clear"))) {
            showAllClear(this, data.get("title"), data.get("body"));
        }
        super.onMessageReceived(remoteMessage);
    }

    static void showEmergency(Context context, String title, String body) {
        RphsChannels.ensure(context);
        String safeTitle = title != null && !title.isEmpty() ? title : "🚨 EMERGENCY";
        String safeBody = body != null ? body : "Open the RPHS app now.";
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;

        Intent alarm = new Intent(context, AlarmActivity.class)
            .putExtra(AlarmActivity.EXTRA_TITLE, safeTitle)
            .putExtra(AlarmActivity.EXTRA_BODY, safeBody)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION);
        PendingIntent fullScreen = PendingIntent.getActivity(context, 1, alarm, flags);

        Intent open = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openApp = PendingIntent.getActivity(context, 2, open, flags);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, RphsChannels.EMERGENCY)
            .setSmallIcon(R.drawable.ic_stat_rphs)
            .setColor(0xFFC62828)
            .setContentTitle(safeTitle)
            .setContentText(safeBody)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(safeBody))
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            // Before Android 8 there are no channels, so sound and vibration go here.
            .setSound(RphsChannels.sirenUri(context), android.media.AudioManager.STREAM_ALARM)
            .setVibrate(RphsChannels.SIREN_VIBRATION)
            .setContentIntent(openApp)
            .setFullScreenIntent(fullScreen, true)
            .setAutoCancel(true)
            .setOnlyAlertOnce(false)
            // The server re-sends every 20 s while nobody has seen it; this stops a
            // siren nobody touches a few minutes after the last one.
            .setTimeoutAfter(4 * 60 * 1000);

        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        Notification notification = builder.build();
        notification.flags |= Notification.FLAG_INSISTENT; // sound repeats until the notification is opened or dismissed
        try {
            manager.notify(EMERGENCY_NOTIFICATION_ID, notification);
        } catch (SecurityException e) {
            // Notifications not allowed on this phone.
        }
    }

    static void showAllClear(Context context, String title, String body) {
        RphsChannels.ensure(context);
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        manager.cancel(EMERGENCY_NOTIFICATION_ID);
        Intent open = new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openApp = PendingIntent.getActivity(context, 3, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new NotificationCompat.Builder(context, RphsChannels.ALERTS)
            .setSmallIcon(R.drawable.ic_stat_rphs)
            .setColor(0xFF2E6B30)
            .setContentTitle(title != null ? title : "All clear")
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(openApp)
            .setAutoCancel(true)
            .build();
        try {
            manager.notify(EMERGENCY_NOTIFICATION_ID + 1, notification);
        } catch (SecurityException e) {
            // Notifications not allowed on this phone.
        }
    }
}
