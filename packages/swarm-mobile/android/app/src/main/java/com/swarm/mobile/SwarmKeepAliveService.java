package com.swarm.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import org.json.JSONObject;

import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

public class SwarmKeepAliveService extends Service {
    private static final String TAG = "SwarmKeepAlive";

    public static final String ACTION_START = "com.swarm.mobile.START_KEEPALIVE";
    public static final String ACTION_STOP = "com.swarm.mobile.STOP_KEEPALIVE";
    public static final String EXTRA_WS_URL = "extra_ws_url";

    public static final String CHANNEL_KEEPALIVE_ID = "swarm_keepalive";
    public static final String CHANNEL_ALERTS_ID = "swarm_alerts";
    private static final int FOREGROUND_SERVICE_ID = 1001;

    private OkHttpClient httpClient;
    private WebSocket webSocket;
    private String currentWsUrl = "";
    private boolean isRunning = false;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable reconnectRunnable = this::doConnect;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannels();
        httpClient = new OkHttpClient.Builder()
                .readTimeout(0, TimeUnit.MILLISECONDS)
                .pingInterval(15, TimeUnit.SECONDS)
                .build();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return START_STICKY;

        String action = intent.getAction();
        if (ACTION_START.equals(action)) {
            String wsUrl = intent.getStringExtra(EXTRA_WS_URL);
            if (wsUrl != null && !wsUrl.isEmpty()) {
                currentWsUrl = wsUrl;
                startKeepAliveForeground();
                doConnect();
            }
        } else if (ACTION_STOP.equals(action)) {
            stopKeepAlive();
        }

        return START_STICKY;
    }

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;

            // 1. 保活常驻静音通知渠道
            NotificationChannel keepaliveChannel = new NotificationChannel(
                    CHANNEL_KEEPALIVE_ID,
                    "蜂群后台保活通道",
                    NotificationManager.IMPORTANCE_LOW
            );
            keepaliveChannel.setDescription("维持家庭 Wi-Fi 局域网长连接以稳定接收任务提醒");
            nm.createNotificationChannel(keepaliveChannel);

            // 2. 关键任务提醒渠道（声音+高优先级横幅）
            NotificationChannel alertsChannel = new NotificationChannel(
                    CHANNEL_ALERTS_ID,
                    "蜂群关键任务提醒",
                    NotificationManager.IMPORTANCE_HIGH
            );
            alertsChannel.setDescription("任务完成、失败与用户明确决策事项提醒");
            alertsChannel.enableVibration(true);
            nm.createNotificationChannel(alertsChannel);
        }
    }

    private void startKeepAliveForeground() {
        Intent notificationIntent = new Intent(this, MainActivity.class);
        PendingIntent pendingIntent = PendingIntent.getActivity(
                this, 0, notificationIntent,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );

        Notification notification = new NotificationCompat.Builder(this, CHANNEL_KEEPALIVE_ID)
                .setContentTitle("蜂群后台监控中")
                .setContentText("已连接电脑端蜂群 · 熄屏状态下仍可接收交付与审批提醒")
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentIntent(pendingIntent)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();

        startForeground(FOREGROUND_SERVICE_ID, notification);
        isRunning = true;
    }

    private synchronized void doConnect() {
        if (!isRunning || currentWsUrl == null || currentWsUrl.isEmpty()) return;

        if (webSocket != null) {
            try {
                webSocket.cancel();
            } catch (Exception ignored) {}
        }

        try {
            Request request = new Request.Builder().url(currentWsUrl).build();
            webSocket = httpClient.newWebSocket(request, new WebSocketListener() {
                @Override
                public void onOpen(WebSocket ws, Response response) {
                    Log.i(TAG, "已连接到蜂群桌面 WebSocket: " + currentWsUrl);
                }

                @Override
                public void onMessage(WebSocket ws, String text) {
                    handleWsMessage(text);
                }

                @Override
                public void onClosed(WebSocket ws, int code, String reason) {
                    Log.i(TAG, "蜂群 WebSocket 关闭: " + reason);
                    scheduleReconnect();
                }

                @Override
                public void onFailure(WebSocket ws, Throwable t, Response response) {
                    Log.w(TAG, "蜂群 WebSocket 连接异常: " + t.getMessage());
                    scheduleReconnect();
                }
            });
        } catch (Exception e) {
            Log.e(TAG, "发起连接异常", e);
            scheduleReconnect();
        }
    }

    private void scheduleReconnect() {
        if (!isRunning) return;
        handler.removeCallbacks(reconnectRunnable);
        handler.postDelayed(reconnectRunnable, 5000);
    }

    private void handleWsMessage(String text) {
        try {
            JSONObject obj = new JSONObject(text);
            String type = obj.optString("type");
            if ("alert".equals(type)) {
                String alertType = obj.optString("alertType");
                String title = obj.optString("title", "蜂群提醒");
                String body = obj.optString("body", "");
                String taskId = obj.optString("taskId", "");

                postTaskNotification(alertType, title, body, taskId);
            }
        } catch (Exception e) {
            Log.e(TAG, "解析推送消息异常", e);
        }
    }

    private void postTaskNotification(String alertType, String title, String body, String taskId) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        Intent intent = new Intent(this, MainActivity.class);
        intent.putExtra("task_id", taskId);
        intent.putExtra("alert_type", alertType);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);

        PendingIntent pendingIntent = PendingIntent.getActivity(
                this,
                (int) (System.currentTimeMillis() % 100000),
                intent,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );

        String prefix = "waiting_for_user".equals(alertType) ? "🚨 " : "done".equals(alertType) ? "✅ " : "⚠️ ";

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ALERTS_ID)
                .setContentTitle(prefix + title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setSmallIcon(R.mipmap.ic_launcher)
                .setAutoCancel(true)
                .setContentIntent(pendingIntent)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_EVENT)
                .setDefaults(Notification.DEFAULT_ALL);

        nm.notify((int) System.currentTimeMillis(), builder.build());
    }

    private void stopKeepAlive() {
        isRunning = false;
        handler.removeCallbacks(reconnectRunnable);
        if (webSocket != null) {
            try {
                webSocket.close(1000, "Service stopped");
            } catch (Exception ignored) {}
            webSocket = null;
        }
        stopForeground(true);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        stopKeepAlive();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
