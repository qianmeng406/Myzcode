package com.zcode.myzcode;

import android.graphics.Insets;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Android 15 起 window 默认 edge-to-edge，WebView 延伸到状态栏/手势条
        // 之下；这里把系统栏 inset 转成内容根的 padding，WebUI/壳页自身不再做
        // 状态栏高度补偿（低版本 Android 非 edge-to-edge，无需处理）。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            View content = findViewById(android.R.id.content);
            content.setOnApplyWindowInsetsListener((view, insets) -> {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return WindowInsets.CONSUMED;
            });
        }
    }
}
