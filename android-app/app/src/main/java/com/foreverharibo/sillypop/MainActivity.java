package com.foreverharibo.sillypop;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.Intent;
import android.content.ClipboardManager;
import android.content.ClipData;
import android.os.PersistableBundle;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.TextView;
import android.widget.Toast;

public final class MainActivity extends Activity {
    private static final int NOTIFICATION_PERMISSION_REQUEST = 1001;
    private TextView permissionStatus;
    private Button permissionButton;
    private FrameLayout logoFrame;
    private ImageView logoImage;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        ((TextView) findViewById(R.id.versionFooter)).setText(getString(R.string.footer, BuildConfig.VERSION_NAME));
        findViewById(R.id.screenRoot).setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        findViewById(R.id.screenRoot).requestApplyInsets();
        NotificationHelper.createChannels(this);

        permissionStatus = findViewById(R.id.permissionStatus);
        permissionButton = findViewById(R.id.permissionButton);
        logoFrame = findViewById(R.id.logoFrame);
        logoImage = findViewById(R.id.logoImage);
        Button testButton = findViewById(R.id.testButton);

        permissionButton.setOnClickListener(view -> requestNotificationPermission());
        testButton.setOnClickListener(view -> sendTestNotification());
        findViewById(R.id.pairButton).setOnClickListener(view -> copyPairingCommand());
        logoFrame.setBackgroundResource(R.drawable.bg_logo_white);
        logoImage.setImageResource(R.drawable.ic_st_modular_black);
        applyWhiteTheme();
        // Ignore and remove the old preference; even notifications received before
        // the first launch after updating now use the fixed white icon.
        getSharedPreferences(NotificationHelper.PREFERENCES, MODE_PRIVATE)
            .edit().remove("launcher_icon_style").apply();
        NotificationHelper.refreshNotificationIcons(this);
        updatePermissionUi();
    }

    @Override
    protected void onResume() {
        super.onResume();
        updatePermissionUi();
    }

    private void copyPairingCommand() {
        try {
            String key = BridgeAuth.getOrCreateKey(this);
            String command = " mkdir -p \"$HOME/.config/silly-pop\" && chmod 700 \"$HOME/.config/silly-pop\""
                + " && (umask 077; printf '%s\\n' '" + key + "' > \"$HOME/.config/silly-pop/bridge-key\")"
                + " && chmod 600 \"$HOME/.config/silly-pop/bridge-key\" && echo 'Silly-Pop 연결 키 저장 완료'";
            ClipData clip = ClipData.newPlainText("Silly-Pop 연결 명령", command);
            PersistableBundle extras = new PersistableBundle();
            extras.putBoolean("android.content.extra.IS_SENSITIVE", true);
            clip.getDescription().setExtras(extras);
            getSystemService(ClipboardManager.class).setPrimaryClip(clip);
            Toast.makeText(this, "Termux의 새 세션에 한 번 붙여넣고 Enter를 눌러 주세요. 연결 명령은 다른 사람에게 공유하지 마세요.", Toast.LENGTH_LONG).show();
        } catch (RuntimeException error) {
            Toast.makeText(this, "연결 명령을 복사하지 못했어요. 다시 시도해 주세요.", Toast.LENGTH_LONG).show();
        }
    }

    private boolean hasRuntimeNotificationPermission() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasNotificationPermission() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        return hasRuntimeNotificationPermission() && manager != null && manager.areNotificationsEnabled();
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !hasRuntimeNotificationPermission()) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION_REQUEST);
            return;
        }

        Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
        startActivity(intent);
    }

    private void sendTestNotification() {
        if (!hasNotificationPermission()) {
            requestNotificationPermission();
            Toast.makeText(this, "알림 권한을 허용한 뒤 다시 눌러주세요.", Toast.LENGTH_SHORT).show();
            return;
        }

        String url = getSharedPreferences(NotificationHelper.PREFERENCES, MODE_PRIVATE)
            .getString(NotificationHelper.KEY_LAST_URL, NotificationHelper.DEFAULT_SILLY_URL);
        boolean shown = NotificationHelper.show(
            this,
            "Silly-Pop 테스트",
            url,
            true,
            true
        );
        Toast.makeText(this, shown ? "테스트 알림을 보냈어요!" : "알림 설정에서 Silly-Pop 알림을 허용해 주세요.", Toast.LENGTH_SHORT).show();
    }

    private void updatePermissionUi() {
        boolean allowed = hasNotificationPermission();
        permissionStatus.setText(allowed ? R.string.permission_allowed : R.string.permission_needed);
        permissionButton.setText(allowed ? "설정" : "허용하기");
    }

    private GradientDrawable rounded(int fill, int border, int radius) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(fill);
        drawable.setCornerRadius(radius * getResources().getDisplayMetrics().density);
        drawable.setStroke(Math.max(1, (int) getResources().getDisplayMetrics().density), border);
        return drawable;
    }

    private void colorText(View view, int primary, int secondary) {
        if (view instanceof TextView) {
            ((TextView) view).setTextColor("secondary".equals(view.getTag()) ? secondary : primary);
        }
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) colorText(group.getChildAt(i), primary, secondary);
        }
    }

    private void applyWhiteTheme() {
        int background = Color.parseColor("#FFFFFF");
        int surface = Color.parseColor("#F7F7F7");
        int primary = Color.parseColor("#151515");
        int secondary = Color.parseColor("#707070");
        int border = Color.parseColor("#E3E3E3");
        View root = findViewById(R.id.screenRoot);
        root.setBackgroundColor(background);
        colorText(root, primary, secondary);
        findViewById(R.id.settingsCard).setBackground(rounded(surface, border, 16));
        permissionButton.setBackground(rounded(surface, border, 10));
        findViewById(R.id.pairButton).setBackground(rounded(surface, border, 10));
        Button test = findViewById(R.id.testButton);
        test.setBackground(rounded(primary, primary, 12));
        test.setTextColor(background);
        ((ImageView) findViewById(R.id.privacyIcon)).setColorFilter(secondary);
        getWindow().setStatusBarColor(background);
        getWindow().setNavigationBarColor(background);
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        updatePermissionUi();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == NOTIFICATION_PERMISSION_REQUEST) {
            updatePermissionUi();
            if (hasNotificationPermission()) {
                Toast.makeText(this, "이제 실리의 답변을 알려드릴게요!", Toast.LENGTH_SHORT).show();
            }
        }
    }
}
