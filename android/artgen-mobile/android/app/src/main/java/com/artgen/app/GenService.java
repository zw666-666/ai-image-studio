package com.artgen.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** 前台服务：后台线程执行生图/图生图，持 WakeLock/WifiLock 保证息屏不中断网络。 */
public class GenService extends Service {
    private static final String CHANNEL_ID = "artgen_gen";
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private PowerManager.WakeLock cpuWakeLock;
    private WifiManager.WifiLock wifiLock;

    @Override
    public void onCreate() {
        super.onCreate();
        ensureChannel();
        acquireLocks();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(1, buildNotification("正在生成图片…"));

        final String action = intent.getStringExtra("action");
        final String prompt = intent.getStringExtra("prompt");
        final String model = intent.getStringExtra("model");
        final String size = intent.getStringExtra("size");
        final String quality = intent.getStringExtra("quality");
        final String promptType = intent.getStringExtra("promptType");
        final String language = intent.getStringExtra("language");
        final int taskId = intent.getIntExtra("taskId", 0);

        executor.execute(() -> {
            // 息屏/切后台瞬间网络可能被系统掐断，指数退避重试兜底
            int maxAttempts = 3;
            for (int attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    JSONObject result;
                    if ("describe".equals(action)) {
                        result = new ApiClient(this).describeImage(GenBus.editImageBytes, promptType, language);
                    } else if ("edit".equals(action)) {
                        ApiClient client = new ApiClient(this);
                        if (GenBus.editRefBytes != null) {
                            result = client.referenceEdit(GenBus.editImageBytes, GenBus.editRefBytes, prompt, model, size);
                        } else {
                            result = client.edit(GenBus.editImageBytes, prompt, model, size);
                        }
                    } else {
                        result = new ApiClient(this).generate(prompt, model, size, quality);
                    }
                    GenBus.putResult(taskId, result.toString());
                    break;
                } catch (Exception e) {
                    if (attempt == maxAttempts) {
                        GenBus.putResult(taskId, errorJson(e));
                    } else {
                        try { Thread.sleep(attempt * 2500L); } catch (InterruptedException ignored) {}
                    }
                }
            }
            releaseLocks();
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
        });
        return START_NOT_STICKY;
    }

    private void acquireLocks() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            cpuWakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "artgen:gen");
            cpuWakeLock.setReferenceCounted(false);
            cpuWakeLock.acquire(10 * 60 * 1000L); // 10 分钟超时，防异常持锁耗电
        } catch (Exception ignored) {}
        try {
            WifiManager wm = (WifiManager) getApplicationContext()
                    .getSystemService(Context.WIFI_SERVICE);
            wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "artgen:gen");
            wifiLock.acquire();
        } catch (Exception ignored) {}
    }

    private void releaseLocks() {
        try {
            if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        } catch (Exception ignored) {}
        try {
            if (cpuWakeLock != null && cpuWakeLock.isHeld()) cpuWakeLock.release();
        } catch (Exception ignored) {}
    }

    private String errorJson(Exception e) {
        try {
            JSONObject o = new JSONObject();
            o.put("error", e.getMessage() == null ? "未知错误" : e.getMessage());
            return o.toString();
        } catch (Exception ex) {
            return "{\"error\":\"unknown\"}";
        }
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "图片生成", NotificationManager.IMPORTANCE_LOW);
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.createNotificationChannel(ch);
        }
    }

    private Notification buildNotification(String text) {
        PendingIntent pi = PendingIntent.getActivity(
                this, 0, new Intent(this, MainActivity.class),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        b.setContentTitle("image生图助手")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_menu_gallery)
                .setContentIntent(pi)
                .setOngoing(true);
        return b.build();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
