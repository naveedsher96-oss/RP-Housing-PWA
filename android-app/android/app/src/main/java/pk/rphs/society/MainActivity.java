package pk.rphs.society;

import android.app.AlertDialog;
import android.app.NotificationManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(RphsBridgePlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onResume() {
        super.onResume();
        askForFullScreenAlarmOnce();
    }

    // Android 14+ only lets an app open full screen over the lock screen if the
    // member allows it. Asked once, after they have turned on alerts.
    private void askForFullScreenAlarmOnce() {
        if (Build.VERSION.SDK_INT < 34) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null || manager.canUseFullScreenIntent()) return;
        if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) return;
        SharedPreferences prefs = getSharedPreferences("rphs", MODE_PRIVATE);
        if (prefs.getBoolean("askedFullScreen", false)) return;
        prefs.edit().putBoolean("askedFullScreen", true).apply();
        new AlertDialog.Builder(this)
            .setTitle("Emergency alarm on the lock screen")
            .setMessage("Allow RPHS to show emergency alarms full screen, even when your phone is locked. On the next screen, turn on \"Allow full screen notifications\".")
            .setPositiveButton("Allow", (d, w) -> {
                try {
                    startActivity(new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + getPackageName())));
                } catch (ActivityNotFoundException e) {
                    // Older Android 14 builds without this screen: the siren still rings.
                }
            })
            .setNegativeButton("Not now", null)
            .show();
    }
}
