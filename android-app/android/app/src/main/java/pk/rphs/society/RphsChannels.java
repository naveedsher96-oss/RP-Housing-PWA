package pk.rphs.society;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ContentResolver;
import android.content.Context;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;

/** The app's notification channels. Safe to call often; Android keeps the first settings. */
final class RphsChannels {

    static final String ALERTS = "rphs_alerts";
    static final String EMERGENCY = "rphs_emergency";

    static final long[] SIREN_VIBRATION = { 0, 900, 300, 900, 300, 900, 300, 900 };

    private RphsChannels() {}

    static Uri sirenUri(Context context) {
        return Uri.parse(ContentResolver.SCHEME_ANDROID_RESOURCE + "://" + context.getPackageName() + "/" + R.raw.rphs_siren);
    }

    static void ensure(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;

        if (manager.getNotificationChannel(ALERTS) == null) {
            NotificationChannel alerts = new NotificationChannel(ALERTS, "Alerts", NotificationManager.IMPORTANCE_HIGH);
            alerts.setDescription("Bills, notices, complaints and other RPHS alerts");
            alerts.enableVibration(true);
            alerts.setShowBadge(true);
            manager.createNotificationChannel(alerts);
        }

        if (manager.getNotificationChannel(EMERGENCY) == null) {
            NotificationChannel emergency = new NotificationChannel(EMERGENCY, "Emergency alarm", NotificationManager.IMPORTANCE_HIGH);
            emergency.setDescription("Loud siren for emergency alarms. Plays on the alarm volume, so it rings even when the phone is on silent.");
            // The alarm stream isn't muted by silent or vibrate mode.
            emergency.setSound(
                sirenUri(context),
                new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
            );
            emergency.enableVibration(true);
            emergency.setVibrationPattern(SIREN_VIBRATION);
            emergency.enableLights(true);
            emergency.setLightColor(0xFFFF0000);
            emergency.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);
            // Only takes effect if the member allows RPHS in Do Not Disturb settings.
            emergency.setBypassDnd(true);
            manager.createNotificationChannel(emergency);
        }
    }
}
