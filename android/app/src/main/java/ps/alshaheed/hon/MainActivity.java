package ps.alshaheed.hon;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.provider.Settings;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.GeolocationPermissions;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * "هون" for Android: a thin shell around https://talk.alshaheed.ps.
 * Everything the user sees comes from the server, so every update pushed to GitHub
 * reaches installed apps right away — no new APK needed.
 */
public class MainActivity extends Activity {

    private static final int REQ_LOCATION = 1;
    private static final int REQ_FILE = 2;
    private static final int REQ_NOTIFY = 3;

    static void ensureChannel(Context ctx) {
        NotificationManager nm = ctx.getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel("replies") == null) {
            NotificationChannel ch = new NotificationChannel("replies", "الردود", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("لما حدا يرد على رسالتك أو على نقاش شاركت فيه");
            nm.createNotificationChannel(ch);
        }
    }

    /** Get this phone's Firebase token (if the app was built with Firebase) and keep it for the page. */
    private void setupPush() {
        ensureChannel(this);
        try {
            com.google.firebase.messaging.FirebaseMessaging.getInstance().getToken().addOnSuccessListener(t ->
                getSharedPreferences("hon", MODE_PRIVATE).edit().putString("push_token", t).apply());
        } catch (Exception noFirebase) { /* built without google-services.json */ }
    }

    /** "/?post=12" from a notification → full address on our site. */
    private static String linkFrom(Intent intent) {
        if (intent == null) return null;
        String path = intent.getStringExtra("url");
        if (path == null || !path.startsWith("/")) return null;
        return BuildConfig.APP_URL + path.substring(1);
    }

    private WebView web;
    private View splashView;

    private void revealPage() {
        if (splashView == null) return;
        final View sv = splashView;
        splashView = null;
        web.setAlpha(0f);
        web.setVisibility(View.VISIBLE);
        web.animate().alpha(1f).setDuration(220).start();
        sv.animate().alpha(0f).setDuration(220).withEndAction(() -> ((android.view.ViewGroup) sv.getParent()).removeView(sv)).start();
    }
    private String pendingGeoOrigin;
    private GeolocationPermissions.Callback pendingGeoCallback;
    private ValueCallback<Uri[]> pendingFiles;

    private static final String OFFLINE_HTML =
        "<!doctype html><html dir='rtl'><meta name='viewport' content='width=device-width,initial-scale=1'>"
        + "<body style='margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;"
        + "background:#f5f2ea;color:#14213d;font-family:sans-serif;text-align:center;padding:24px;box-sizing:border-box'>"
        + "<div style='font-size:56px'>📍</div><h2 style='margin:12px 0 6px'>ما في اتصال</h2>"
        + "<p style='color:#6b7489;margin:0 0 22px'>تأكد من الإنترنت وجرّب مرة ثانية</p>"
        + "<button onclick='location.replace(\"" + BuildConfig.APP_URL + "\")' style='border:0;border-radius:14px;"
        + "padding:14px 30px;background:#fca311;color:#3d2600;font-size:17px;font-weight:bold'>إعادة المحاولة</button></body></html>";

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#F5F2EA"));
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        // Navy splash with the logo + a small spinner stays until the page has painted — never a white screen.
        android.widget.FrameLayout root = new android.widget.FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#14213D"));
        web.setVisibility(View.INVISIBLE);
        root.addView(web, new android.widget.FrameLayout.LayoutParams(-1, -1));
        float dp = getResources().getDisplayMetrics().density;
        android.widget.LinearLayout splash = new android.widget.LinearLayout(this);
        splash.setOrientation(android.widget.LinearLayout.VERTICAL);
        splash.setGravity(android.view.Gravity.CENTER);
        android.widget.ImageView logo = new android.widget.ImageView(this);
        logo.setImageResource(R.mipmap.ic_launcher_foreground);
        splash.addView(logo, new android.widget.LinearLayout.LayoutParams((int) (160 * dp), (int) (160 * dp)));
        android.widget.ProgressBar spin = new android.widget.ProgressBar(this);
        spin.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(Color.parseColor("#FCA311")));
        android.widget.LinearLayout.LayoutParams sp = new android.widget.LinearLayout.LayoutParams((int) (28 * dp), (int) (28 * dp));
        sp.topMargin = (int) (8 * dp);
        splash.addView(spin, sp);
        root.addView(splash, new android.widget.FrameLayout.LayoutParams(-1, -1));
        splashView = splash;
        setContentView(root);
        web.postDelayed(this::revealPage, 8000);   // never stay on the splash forever
        // Android 15+ draws apps under the status bar and keyboard; keep the page clear of both.
        if (Build.VERSION.SDK_INT >= 35) {
            web.setOnApplyWindowInsetsListener((v, insets) -> {
                android.graphics.Insets b = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                v.setPadding(b.left, b.top, b.right, b.bottom);
                return WindowInsets.CONSUMED;
            });
        }

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setGeolocationEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setUserAgentString(s.getUserAgentString() + " HonApp/Android/" + BuildConfig.VERSION_NAME);

        web.addJavascriptInterface(new Native(), "HonNative");

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("https".equals(uri.getScheme()) && BuildConfig.APP_HOST.equals(uri.getHost())) return false;
                // WhatsApp, phone, maps and any other site open in their own apps
                try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (ActivityNotFoundException ignored) { }
                return true;
            }

            @Override
            public void onPageCommitVisible(WebView view, String url) { revealPage(); }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) view.loadDataWithBaseURL(null, OFFLINE_HTML, "text/html", "utf-8", null);
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                if (hasLocationPermission()) { callback.invoke(origin, true, false); return; }
                pendingGeoOrigin = origin;
                pendingGeoCallback = callback;
                requestPermissions(new String[]{ Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }, REQ_LOCATION);
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingFiles != null) pendingFiles.onReceiveValue(null);
                pendingFiles = callback;
                Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("image/*");
                try {
                    startActivityForResult(Intent.createChooser(pick, "اختار صورة"), REQ_FILE);
                } catch (ActivityNotFoundException e) {
                    pendingFiles = null;
                    return false;
                }
                return true;
            }
        });

        setupPush();

        Uri link = getIntent() != null ? getIntent().getData() : null;
        String fromNotification = linkFrom(getIntent());
        if (fromNotification != null) web.loadUrl(fromNotification);
        else if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(link != null && BuildConfig.APP_HOST.equals(link.getHost()) ? link.toString() : BuildConfig.APP_URL);
    }

    /** What the page can ask the app. Only our own site is ever loaded in this WebView. */
    private class Native {
        /** One-way hash of this phone's Android ID: stable across reinstalls, never sent in clear. */
        @JavascriptInterface
        public String deviceId() {
            try {
                String id = Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID);
                if (id == null) return "";
                java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
                byte[] h = md.digest(("hon:" + getPackageName() + ":" + id).getBytes(java.nio.charset.StandardCharsets.UTF_8));
                StringBuilder sb = new StringBuilder();
                for (byte b : h) sb.append(String.format("%02x", b));
                return sb.toString();
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public String platform() { return "android"; }

        /** Is the phone's Location (GPS) switch on? */
        @JavascriptInterface
        public boolean locationOn() {
            android.location.LocationManager lm = getSystemService(android.location.LocationManager.class);
            if (lm == null) return true;
            if (Build.VERSION.SDK_INT >= 28) return lm.isLocationEnabled();
            return lm.isProviderEnabled(android.location.LocationManager.GPS_PROVIDER) || lm.isProviderEnabled(android.location.LocationManager.NETWORK_PROVIDER);
        }

        @JavascriptInterface
        public void openLocationSettings() {
            runOnUiThread(() -> { try { startActivity(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)); } catch (Exception ignored) { } });
        }

        @JavascriptInterface
        public void openAppSettings() {
            runOnUiThread(() -> { try { startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", getPackageName(), null))); } catch (Exception ignored) { } });
        }

        /** Asked by the page right after your first message/reply, not at launch (so it never clashes with the location prompt). */
        @JavascriptInterface
        public void requestNotifications() {
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
                    requestPermissions(new String[]{ Manifest.permission.POST_NOTIFICATIONS }, REQ_NOTIFY);
            });
        }

        /** Share the story card (PNG, base64) to Instagram, WhatsApp… through Android's share sheet. */
        @JavascriptInterface
        public void shareImage(String base64, String text) {
            try {
                java.io.File dir = new java.io.File(getCacheDir(), "share");
                dir.mkdirs();
                java.io.File f = new java.io.File(dir, "hon.png");
                try (java.io.FileOutputStream out = new java.io.FileOutputStream(f)) {
                    out.write(android.util.Base64.decode(base64, android.util.Base64.DEFAULT));
                }
                Uri uri = androidx.core.content.FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".files", f);
                Intent send = new Intent(Intent.ACTION_SEND)
                    .setType("image/png")
                    .putExtra(Intent.EXTRA_STREAM, uri)
                    .putExtra(Intent.EXTRA_TEXT, text)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                runOnUiThread(() -> startActivity(Intent.createChooser(send, "شارك هون")));
            } catch (Exception ignored) { }
        }

        @JavascriptInterface
        public String pushToken() { return getSharedPreferences("hon", MODE_PRIVATE).getString("push_token", ""); }
    }

    private boolean hasLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == REQ_LOCATION && pendingGeoCallback != null) {
            pendingGeoCallback.invoke(pendingGeoOrigin, hasLocationPermission(), false);
            pendingGeoCallback = null;
            pendingGeoOrigin = null;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_FILE || pendingFiles == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getData() != null) result = new Uri[]{ data.getData() };
            else if (data.getClipData() != null && data.getClipData().getItemCount() > 0) result = new Uri[]{ data.getClipData().getItemAt(0).getUri() };
        }
        pendingFiles.onReceiveValue(result);
        pendingFiles = null;
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String fromNotification = linkFrom(intent);
        if (fromNotification != null) { web.loadUrl(fromNotification); return; }
        Uri link = intent.getData();
        if (link != null && BuildConfig.APP_HOST.equals(link.getHost())) web.loadUrl(link.toString());
    }

    /** Back closes an open sheet first (the page answers through window.honBack), then leaves the app. */
    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        web.evaluateJavascript("(window.honBack && window.honBack()) ? 'closed' : 'none'", value -> {
            if (value != null && value.contains("closed")) return;
            if (web.canGoBack()) web.goBack();
            else MainActivity.super.onBackPressed();
        });
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
        web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
