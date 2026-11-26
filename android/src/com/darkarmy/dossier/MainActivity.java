package com.darkarmy.dossier;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/**
 * DarkArmy Dossier Android client.
 *
 * Native setup screen (dark, no default white Android controls) + WebView.
 * All startup work is defensive: if WebView/initialization fails, the user
 * still gets an in-app error screen instead of a process crash.
 */
public class MainActivity extends Activity {
    private static final String DEFAULT_HINT = "147.45.78.20:8443";
    private static final int FILE_CHOOSER = 1001;
    private static final int AUDIO_PERMISSION = 1002;

    private WebView web;
    private TextView addressView;
    private FrameLayout content;
    private LinearLayout setupPanel;
    private EditText serverInput;
    private TextView statusView;
    private ValueCallback<Uri[]> fileCallback;
    private boolean webReady;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try {
            buildInterface();
        } catch (Throwable t) {
            showFatal(t);
        }
    }

    private void buildInterface() {
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        getWindow().setStatusBarColor(0xFF080A0F);
        getWindow().setNavigationBarColor(0xFF080A0F);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF080A0F);

        content = new FrameLayout(this);
        content.setBackgroundColor(0xFF080A0F);
        root.addView(content, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        try {
            web = new WebView(this);
            web.setBackgroundColor(0xFF080A0F);
            WebSettings s = web.getSettings();
            s.setJavaScriptEnabled(true);
            s.setDomStorageEnabled(true);
            s.setDatabaseEnabled(true);
            s.setLoadWithOverviewMode(true);
            s.setUseWideViewPort(true);
            s.setMediaPlaybackRequiresUserGesture(false);
            s.setAllowFileAccess(true);
            s.setCacheMode(WebSettings.LOAD_DEFAULT);
            if (Build.VERSION.SDK_INT >= 21) {
                s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
            }
            WebView.setWebContentsDebuggingEnabled(false);
            web.setVisibility(View.GONE);
            web.setWebViewClient(new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    String u = request.getUrl().toString();
                    if (u.startsWith("http://") || u.startsWith("https://")) return false;
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(u)));
                    } catch (Exception ignored) { }
                    return true;
                }

                @Override
                public void onPageFinished(WebView view, String url) {
                    if (web == null) return;
                    if (setupPanel != null && setupPanel.getVisibility() == View.VISIBLE) return;
                    web.setVisibility(View.VISIBLE);
                    webReady = true;
                }

                @Override
                public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                    if (request == null || !request.isForMainFrame()) return;
                    showSetup("Не удалось открыть сервер. Проверьте адрес и сеть.");
                }
            });
            web.setWebChromeClient(new WebChromeClient() {
                @Override
                public void onPermissionRequest(final PermissionRequest request) {
                    runOnUiThread(new Runnable() {
                        public void run() {
                            boolean audio = false;
                            try {
                                for (String r : request.getResources()) {
                                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) audio = true;
                                }
                            } catch (Exception ignored) { }
                            if (audio && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                                requestAudioPermission();
                                request.deny();
                                Toast.makeText(MainActivity.this, "Разрешите микрофон и попробуйте снова", Toast.LENGTH_SHORT).show();
                            } else {
                                try { request.grant(request.getResources()); } catch (Exception ignored) { }
                            }
                        }
                    });
                }

                @Override
                public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                    fileCallback = callback;
                    try {
                        startActivityForResult(params.createIntent(), FILE_CHOOSER);
                        return true;
                    } catch (Exception e) {
                        fileCallback = null;
                        return false;
                    }
                }
            });
            content.addView(web, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            setupPanel = buildSetupPanel();
            content.addView(setupPanel, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            web.addJavascriptInterface(new NativeBridge(), "DarkArmyNative");
        } catch (Throwable t) {
            setupPanel = buildSetupPanel();
            content.addView(setupPanel, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            showSetup("WebView недоступен на этом устройстве. Обновите Android System WebView.");
        }

        setContentView(root);

        SharedPreferences sp = getSharedPreferences("dossier", Context.MODE_PRIVATE);
        String saved = sp.getString("url", "");
        if (saved != null && saved.length() > 0) {
            serverInput.setText(saved);
            openServer(saved, false);
        } else {
            serverInput.setText("");
        }
    }

    private LinearLayout buildSetupPanel() {
        LinearLayout wrapper = new LinearLayout(this);
        wrapper.setOrientation(LinearLayout.VERTICAL);
        wrapper.setGravity(Gravity.CENTER);
        wrapper.setBackgroundColor(0xFF080A0F);
        wrapper.setPadding(dp(22), dp(22), dp(22), dp(22));

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(24), dp(24), dp(24), dp(22));
        GradientDrawable panel = new GradientDrawable();
        panel.setColor(0xFF12151D);
        panel.setCornerRadius(dp(22));
        panel.setStroke(dp(1), 0xFF262B3A);
        box.setBackground(panel);

        LinearLayout brandRow = new LinearLayout(this);
        brandRow.setOrientation(LinearLayout.HORIZONTAL);
        brandRow.setGravity(Gravity.CENTER_VERTICAL);

        TextView logo = new TextView(this);
        logo.setText("DA");
        logo.setTextColor(Color.WHITE);
        logo.setTextSize(16);
        logo.setTypeface(Typeface.DEFAULT_BOLD);
        logo.setGravity(Gravity.CENTER);
        GradientDrawable logoBg = new GradientDrawable();
        logoBg.setShape(GradientDrawable.OVAL);
        logoBg.setColor(0xFFE63946);
        logo.setBackground(logoBg);
        brandRow.addView(logo, new LinearLayout.LayoutParams(dp(44), dp(44)));

        LinearLayout brandText = new LinearLayout(this);
        brandText.setOrientation(LinearLayout.VERTICAL);
        brandText.setPadding(dp(12), 0, 0, 0);
        TextView brand = new TextView(this);
        brand.setText("DarkArmy Dossier");
        brand.setTextColor(0xFFF2F4F8);
        brand.setTextSize(20);
        brand.setTypeface(Typeface.DEFAULT_BOLD);
        TextView tagline = new TextView(this);
        tagline.setText("Твоё пространство. Твои данные.");
        tagline.setTextColor(0xFF8B90A3);
        tagline.setTextSize(12);
        brandText.addView(brand);
        brandText.addView(tagline);
        brandRow.addView(brandText);
        box.addView(brandRow);

        TextView title = new TextView(this);
        title.setText("Подключение к серверу");
        title.setTextColor(0xFFF2F4F8);
        title.setTextSize(22);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        LinearLayout.LayoutParams titleLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        titleLp.topMargin = dp(26);
        box.addView(title, titleLp);

        TextView hint = new TextView(this);
        hint.setText("Введите адрес своего сервера — ip:port или домен.\nДля 8443/443 приложение само включит HTTPS.");
        hint.setTextColor(0xFF9AA0B4);
        hint.setTextSize(13);
        hint.setLineSpacing(dp(3), 1f);
        LinearLayout.LayoutParams hintLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        hintLp.topMargin = dp(8);
        box.addView(hint, hintLp);

        serverInput = new EditText(this);
        serverInput.setSingleLine(true);
        serverInput.setHint(DEFAULT_HINT);
        serverInput.setHintTextColor(0xFF5E6478);
        serverInput.setTextColor(0xFFF2F4F8);
        serverInput.setTextSize(15);
        serverInput.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        serverInput.setPadding(dp(14), dp(12), dp(14), dp(12));
        GradientDrawable inputBg = new GradientDrawable();
        inputBg.setColor(0xFF0B0D13);
        inputBg.setCornerRadius(dp(12));
        inputBg.setStroke(dp(1), 0xFF2C3244);
        serverInput.setBackground(inputBg);
        LinearLayout.LayoutParams inputLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        inputLp.topMargin = dp(18);
        box.addView(serverInput, inputLp);

        statusView = new TextView(this);
        statusView.setTextColor(0xFFFF8A94);
        statusView.setTextSize(12);
        statusView.setVisibility(View.GONE);
        LinearLayout.LayoutParams statusLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        statusLp.topMargin = dp(8);
        box.addView(statusView, statusLp);

        TextView connect = makeButton("Подключиться", true);
        connect.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { connectFromInput(); }
        });
        LinearLayout.LayoutParams connectLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(48));
        connectLp.topMargin = dp(16);
        box.addView(connect, connectLp);

        TextView local = makeButton("Открыть локальный сервер", false);
        local.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                serverInput.setText("http://127.0.0.1:7561/");
                connectFromInput();
            }
        });
        LinearLayout.LayoutParams localLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(44));
        localLp.topMargin = dp(10);
        box.addView(local, localLp);

        TextView foot = new TextView(this);
        foot.setText("Адрес сохранится. Сменить сервер можно кнопкой «Сервер» вверху.");
        foot.setTextColor(0xFF6F7488);
        foot.setTextSize(11);
        foot.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams footLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        footLp.topMargin = dp(14);
        box.addView(foot, footLp);

        scroll.addView(box, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        wrapper.addView(scroll, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        return wrapper;
    }

    private TextView makeButton(String text, boolean primary) {
        TextView b = new TextView(this);
        b.setText(text);
        b.setTextSize(14);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setGravity(Gravity.CENTER);
        b.setTextColor(primary ? Color.WHITE : 0xFFD8DAE5);
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(dp(12));
        if (primary) {
            bg.setColor(0xFFE63946);
        } else {
            bg.setColor(0xFF1A1E29);
            bg.setStroke(dp(1), 0xFF343A4D);
        }
        b.setBackground(bg);
        b.setClickable(true);
        b.setFocusable(true);
        return b;
    }

    private void connectFromInput() {
        String u = serverInput == null ? "" : serverInput.getText().toString().trim();
        if (u.length() == 0) {
            showSetup("Введите адрес сервера.");
            return;
        }
        if (!u.startsWith("http://") && !u.startsWith("https://")) {
            boolean https = u.contains(":8443") || u.contains(":443")
                    || (!u.contains(":") && !u.startsWith("127.") && !u.toLowerCase().startsWith("localhost"));
            u = (https ? "https://" : "http://") + u;
        }
        if (!u.endsWith("/")) u += "/";
        getSharedPreferences("dossier", Context.MODE_PRIVATE).edit().putString("url", u).apply();
        openServer(u, true);
    }

    private void openServer(String url, boolean fromForm) {
        if (web == null) {
            showSetup("WebView недоступен. Установите/обновите Android System WebView.");
            return;
        }
        statusView.setVisibility(View.GONE);
        if (setupPanel != null) setupPanel.setVisibility(View.GONE);
        content.setBackgroundColor(0xFF080A0F);
        web.setVisibility(View.VISIBLE);
        web.setAlpha(1f);
        web.loadUrl(url);
    }

    private void showSetup(String error) {
        if (web != null) web.setVisibility(View.GONE);
        if (setupPanel != null) setupPanel.setVisibility(View.VISIBLE);
        if (statusView != null && error != null) {
            statusView.setText(error);
            statusView.setVisibility(View.VISIBLE);
        }
    }

    private void showFatal(Throwable t) {
        try {
            LinearLayout box = new LinearLayout(this);
            box.setOrientation(LinearLayout.VERTICAL);
            box.setGravity(Gravity.CENTER);
            box.setBackgroundColor(0xFF080A0F);
            box.setPadding(dp(24), dp(24), dp(24), dp(24));
            TextView title = new TextView(this);
            title.setText("DarkArmy Dossier");
            title.setTextColor(0xFFF2F4F8);
            title.setTextSize(22);
            title.setTypeface(Typeface.DEFAULT_BOLD);
            TextView err = new TextView(this);
            err.setText("Не удалось запустить приложение.\n\n" + t.getClass().getSimpleName()
                    + (t.getMessage() == null ? "" : ": " + t.getMessage()));
            err.setTextColor(0xFFFF8A94);
            err.setTextSize(13);
            err.setPadding(0, dp(14), 0, 0);
            box.addView(title);
            box.addView(err);
            setContentView(box);
        } catch (Throwable ignored) { }
    }

    private int dp(int v) {
        return Math.round(getResources().getDisplayMetrics().density * v);
    }

    private void requestAudioPermission() {
        if (Build.VERSION.SDK_INT >= 23) {
            try {
                requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, AUDIO_PERMISSION);
            } catch (Exception ignored) { }
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web != null && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER) {
            if (fileCallback != null) {
                Uri[] result = null;
                if (resultCode == RESULT_OK && data != null) {
                    if (data.getClipData() != null) {
                        int n = data.getClipData().getItemCount();
                        result = new Uri[n];
                        for (int i = 0; i < n; i++) result[i] = data.getClipData().getItemAt(i).getUri();
                    } else if (data.getData() != null) {
                        result = new Uri[]{data.getData()};
                    }
                }
                fileCallback.onReceiveValue(result);
                fileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == AUDIO_PERMISSION && grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            Toast.makeText(this, "Микрофон разрешён — повторите запрос", Toast.LENGTH_SHORT).show();
        }
    }

    private class NativeBridge {
        @JavascriptInterface
        public void openServerSettings() {
            runOnUiThread(new Runnable() {
                public void run() {
                    showSetup("");
                }
            });
        }
    }

    @Override
    protected void onDestroy() {
        try {
            if (web != null) {
                web.loadUrl("about:blank");
                web.destroy();
                web = null;
            }
        } catch (Throwable ignored) { }
        super.onDestroy();
    }
}
