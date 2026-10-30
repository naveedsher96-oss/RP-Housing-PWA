package pk.rphs.society;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.FileProvider;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.util.Collections;

/**
 * Glue between the live RPHS web app and Android.
 *
 * The web app is written for Chrome. Inside the app's WebView a few Chrome
 * features are missing (the share sheet, file downloads, intent:// links), so
 * this plugin injects a small script (assets/rphs-shim.js) that fills those
 * gaps with native code, and turns on native push alerts. The web app itself
 * is not changed.
 */
@CapacitorPlugin(name = "RphsBridge")
public class RphsBridgePlugin extends Plugin {

    static final String APP_ORIGIN = "https://naveedsher96-oss.github.io";

    @Override
    public void load() {
        RphsChannels.ensure(getContext());
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            Logger.warn("RphsBridge", "WebView too old for the RPHS shim; sharing and downloads may not work");
            return;
        }
        try (InputStream in = getContext().getAssets().open("rphs-shim.js")) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            for (int n; (n = in.read(buf)) != -1; ) out.write(buf, 0, n);
            // Lets the web app read Notification.permission straight away.
            String permission = NotificationManagerCompat.from(getContext()).areNotificationsEnabled() ? "granted" : "default";
            String script = new String(out.toByteArray(), StandardCharsets.UTF_8).replace("__RPHS_PUSH_PERMISSION__", permission);
            WebViewCompat.addDocumentStartJavaScript(getBridge().getWebView(), script, Collections.singleton(APP_ORIGIN));
        } catch (Exception e) {
            Logger.error("RphsBridge", "Could not inject the RPHS shim", e);
        }
    }

    /** Opens intent:// links (used for "WhatsApp" and "WhatsApp Business") the way Chrome does. */
    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        if (!"intent".equals(url.getScheme())) return null;
        String raw = url.toString();
        try {
            Intent intent = Intent.parseUri(raw, Intent.URI_INTENT_SCHEME);
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            intent.setComponent(null);
            intent.setSelector(null);
            try {
                getActivity().startActivity(intent);
                return true;
            } catch (ActivityNotFoundException e) {
                String fallback = intent.getStringExtra("browser_fallback_url");
                if (fallback != null && (fallback.startsWith("https://") || fallback.startsWith("http://"))) {
                    openExternal(Uri.parse(fallback));
                }
                return true;
            }
        } catch (URISyntaxException e) {
            Logger.warn("RphsBridge", "Bad intent link: " + raw);
            return true;
        }
    }

    /** Opens a link outside the app (WhatsApp, maps, websites). */
    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("Missing url");
            return;
        }
        Uri uri = Uri.parse(url);
        if ("intent".equals(uri.getScheme())) {
            shouldOverrideLoad(uri);
            call.resolve();
            return;
        }
        if (openExternal(uri)) call.resolve();
        else call.reject("No app can open this link");
    }

    /** Shows a saved file (PDF, image, CSV) in a viewer app, like opening it in a new tab in Chrome. */
    @PluginMethod
    public void openFile(PluginCall call) {
        String path = call.getString("uri");
        String mime = call.getString("mime", "*/*");
        if (path == null) {
            call.reject("Missing uri");
            return;
        }
        try {
            File file = new File(Uri.parse(path).getPath());
            Uri contentUri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(contentUri, mime);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("No app can open this file");
        } catch (Exception e) {
            call.reject("Could not open the file", e);
        }
    }

    private boolean openExternal(Uri uri) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            getActivity().startActivity(intent);
            return true;
        } catch (ActivityNotFoundException e) {
            return false;
        }
    }
}
