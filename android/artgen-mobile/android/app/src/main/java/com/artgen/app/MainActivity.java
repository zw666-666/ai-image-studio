package com.artgen.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;

import com.getcapacitor.BridgeActivity;

import java.io.InputStream;

/**
 * 基于 Capacitor BridgeActivity，把原生能力通过 addJavascriptInterface
 * 暴露为 window.AndroidBridge，供 WebView 前端调用。
 * 生成/编辑走前台服务（GenService）异步执行，避免切后台被中断。
 */
public class MainActivity extends BridgeActivity {

    private WebView webView;
    private ActivityResultLauncher<Intent> pickLauncher;
    private volatile boolean pickRef = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        pickLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                result -> {
                    Uri uri = (result.getResultCode() == RESULT_OK && result.getData() != null)
                            ? result.getData().getData() : null;
                    if (uri == null) { notifyPicked(null); return; }
                    // 读取图片放到后台线程，避免阻塞 UI
                    new Thread(() -> {
                        String dataUrl = readAsDataUrl(uri);
                        runOnUiThread(() -> notifyPicked(dataUrl));
                    }).start();
                });

        webView = getBridge().getWebView();
        webView.getSettings().setJavaScriptEnabled(true);
        webView.addJavascriptInterface(new Bridge(), "AndroidBridge");

        ensureBatteryExempt();
    }

    /** 引导用户忽略电池优化，避免息屏后 Doze 掐断网络导致生成失败。 */
    private void ensureBatteryExempt() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        if (isBatteryExempt()) return;
        openBatterySettings();
    }

    private boolean isBatteryExempt() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        return pm.isIgnoringBatteryOptimizations(getPackageName());
    }

    private void openBatterySettings() {
        try {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            i.setData(Uri.parse("package:" + getPackageName()));
            startActivity(i);
        } catch (Exception e) {
            try {
                startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
            } catch (Exception ignored) {}
        }
    }

    private void startGen(Intent i) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(i);
        } else {
            startService(i);
        }
    }

    private void notifyPicked(String dataUrl) {
        String cb = pickRef ? "window.__onPickedRef" : "window.__onPicked";
        String json = dataUrl == null ? "null" : "\"" + jsonEscape(dataUrl) + "\"";
        webView.evaluateJavascript(cb + " && " + cb + "(" + json + ")", null);
    }

    private String readAsDataUrl(Uri uri) {
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            byte[] bytes = ApiClient.readFully(in);
            String mime = ApiClient.detectMime(bytes);
            return "data:" + mime + ";base64," + Base64.encodeToString(bytes, Base64.NO_WRAP);
        } catch (Exception e) {
            return null;
        }
    }

    /** 暴露给 JS 的原生桥：window.AndroidBridge。 */
    private class Bridge {

        @JavascriptInterface
        public void generate(String prompt, String model, String size, String quality, int taskId) {
            Intent i = new Intent(MainActivity.this, GenService.class);
            i.putExtra("action", "generate");
            i.putExtra("prompt", prompt);
            i.putExtra("model", model);
            i.putExtra("size", size);
            i.putExtra("quality", quality);
            i.putExtra("taskId", taskId);
            startGen(i);
        }

        @JavascriptInterface
        public void edit(String imageBase64, String prompt, String model, String size, int taskId) {
            // 图片字节通过内存传递，避免大图超出 Intent/Binder 大小限制
            GenBus.editImageBytes = Base64.decode(imageBase64, Base64.NO_WRAP);
            GenBus.editRefBytes = null;
            Intent i = new Intent(MainActivity.this, GenService.class);
            i.putExtra("action", "edit");
            i.putExtra("prompt", prompt);
            i.putExtra("model", model);
            i.putExtra("size", size);
            i.putExtra("taskId", taskId);
            startGen(i);
        }

        @JavascriptInterface
        public void referenceEdit(String imageBase64, String refBase64, String prompt, String model, String size, int taskId) {
            GenBus.editImageBytes = Base64.decode(imageBase64, Base64.NO_WRAP);
            GenBus.editRefBytes = Base64.decode(refBase64, Base64.NO_WRAP);
            Intent i = new Intent(MainActivity.this, GenService.class);
            i.putExtra("action", "edit");
            i.putExtra("prompt", prompt);
            i.putExtra("model", model);
            i.putExtra("size", size);
            i.putExtra("taskId", taskId);
            startGen(i);
        }

        @JavascriptInterface
        public void describeImage(String imageBase64, String promptType, String language, int taskId) {
            GenBus.editImageBytes = Base64.decode(imageBase64, Base64.NO_WRAP);
            GenBus.editRefBytes = null;
            Intent i = new Intent(MainActivity.this, GenService.class);
            i.putExtra("action", "describe");
            i.putExtra("promptType", promptType);
            i.putExtra("language", language);
            i.putExtra("taskId", taskId);
            startGen(i);
        }

        @JavascriptInterface
        public void pickImage() {
            pickRef = false;
            launchPicker();
        }

        @JavascriptInterface
        public void pickImageRef() {
            pickRef = true;
            launchPicker();
        }

        private void launchPicker() {
            runOnUiThread(() -> {
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("image/*");
                pickLauncher.launch(intent);
            });
        }

        @JavascriptInterface
        public String pollResult(int taskId) {
            return GenBus.pollResult(taskId);
        }

        @JavascriptInterface
        public void removeResult(int taskId) {
            GenBus.removeResult(taskId);
        }
    }

    private static String jsonEscape(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t");
    }
}
