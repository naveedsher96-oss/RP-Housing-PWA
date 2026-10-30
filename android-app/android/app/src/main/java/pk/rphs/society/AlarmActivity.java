package pk.rphs.society;

import android.app.Activity;
import android.app.KeyguardManager;
import android.app.NotificationManager;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Full-screen emergency screen shown over the lock screen. The siren itself is
 * the Emergency notification's sound; "Open RPHS" goes to the app, where the
 * member taps "I've seen it" (which stops the repeats for them), and "Silence"
 * just stops the sound on this phone.
 */
public class AlarmActivity extends Activity {

    static final String EXTRA_TITLE = "title";
    static final String EXTRA_BODY = "body";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setBackgroundColor(Color.parseColor("#B71C1C"));
        int pad = dp(28);
        root.setPadding(pad, pad, pad, pad);

        TextView icon = text("🚨", 64, false);
        TextView title = text(getIntent().getStringExtra(EXTRA_TITLE), 26, true);
        TextView body = text(getIntent().getStringExtra(EXTRA_BODY), 17, false);
        body.setAlpha(0.92f);

        Button open = button("Open RPHS", Color.WHITE, Color.parseColor("#B71C1C"));
        open.setOnClickListener(v -> {
            silence();
            startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP));
            unlockThenFinish();
        });
        Button quiet = button("Silence", Color.parseColor("#7F0000"), Color.WHITE);
        quiet.setOnClickListener(v -> {
            silence();
            finish();
        });

        root.addView(icon);
        root.addView(title, spaced(12));
        root.addView(body, spaced(12));
        root.addView(open, spaced(36));
        root.addView(quiet, spaced(12));
        setContentView(root);
    }

    private void silence() {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) manager.cancel(EmergencyMessagingService.EMERGENCY_NOTIFICATION_ID);
    }

    private void unlockThenFinish() {
        KeyguardManager keyguard = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
        if (keyguard != null && keyguard.isKeyguardLocked() && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            keyguard.requestDismissKeyguard(this, null);
        }
        finish();
    }

    private TextView text(String value, int sp, boolean bold) {
        TextView t = new TextView(this);
        t.setText(value != null ? value : "");
        t.setTextColor(Color.WHITE);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setGravity(Gravity.CENTER);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private Button button(String label, int background, int color) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setTextColor(color);
        b.setBackgroundColor(background);
        b.setPadding(dp(16), dp(14), dp(16), dp(14));
        return b;
    }

    private LinearLayout.LayoutParams spaced(int topDp) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        p.topMargin = dp(topDp);
        return p;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
