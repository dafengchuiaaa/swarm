package com.swarm.mobile;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

import java.util.Locale;

public class MainActivity extends BridgeActivity implements TextToSpeech.OnInitListener {
    private TextToSpeech tts;
    private boolean ttsReady = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 1. 初始化 Android 原生离线语音引擎 (TextToSpeech)
        tts = new TextToSpeech(this, this);

        // 2. 注册 WebView 原生桥接对象
        WebView webView = getBridge().getWebView();
        webView.addJavascriptInterface(new SwarmBridge(), "SwarmAndroidBridge");

        // 3. Android 13+ 通知权限动态申请
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(
                        this,
                        new String[]{Manifest.permission.POST_NOTIFICATIONS},
                        101
                );
            }
        }
    }

    @Override
    public void onInit(int status) {
        if (status == TextToSpeech.SUCCESS) {
            int result = tts.setLanguage(Locale.CHINESE);
            if (result != TextToSpeech.LANG_MISSING_DATA && result != TextToSpeech.LANG_NOT_SUPPORTED) {
                ttsReady = true;
                tts.setSpeechRate(1.05f);
            }
        }
    }

    public class SwarmBridge {
        @JavascriptInterface
        public void startKeepAlive(String wsUrl) {
            Intent serviceIntent = new Intent(MainActivity.this, SwarmKeepAliveService.class);
            serviceIntent.setAction(SwarmKeepAliveService.ACTION_START);
            serviceIntent.putExtra(SwarmKeepAliveService.EXTRA_WS_URL, wsUrl);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(serviceIntent);
            } else {
                startService(serviceIntent);
            }
        }

        @JavascriptInterface
        public void stopKeepAlive() {
            Intent serviceIntent = new Intent(MainActivity.this, SwarmKeepAliveService.class);
            serviceIntent.setAction(SwarmKeepAliveService.ACTION_STOP);
            startService(serviceIntent);
        }

        @JavascriptInterface
        public void speak(String text) {
            if (tts != null && ttsReady) {
                tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "utterance_" + System.currentTimeMillis());
            }
        }

        @JavascriptInterface
        public void stopSpeaking() {
            if (tts != null) {
                tts.stop();
            }
        }
    }

    @Override
    public void onDestroy() {
        if (tts != null) {
            tts.stop();
            tts.shutdown();
        }
        super.onDestroy();
    }
}
