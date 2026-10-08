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
        setupRemote();
    }

    @Override
    protected void onResume() {
        super.onResume();
        updatePermissionUi();
        PushSyncWorker.schedule(this);
    }

    private void setupRemote() {
        TextView status = findViewById(R.id.remoteStatus);
        status.setText(!BuildConfig.PUSH_CONFIGURED ? "PC 푸시 설정 전인 개발 빌드예요. 기존 Termux 연결은 사용할 수 있어요."
            : RemotePush.enabled(this) ? "PC 알림 수신이 켜져 있어요. 실리태번에서 테스트 알림으로 확인해 주세요."
            : "코드를 실리태번 Silly-Pop 설정에 붙여넣으면 답장 알림만 도착해요. 상시 알림은 없어요.");
        findViewById(R.id.remotePair).setEnabled(BuildConfig.PUSH_CONFIGURED);
        findViewById(R.id.remotePair).setOnClickListener(view -> runRemoteAction(true));
        findViewById(R.id.remoteDisconnect).setOnClickListener(view -> runRemoteAction(false));
    }

    private void runRemoteAction(boolean pair) {
        if (pair && !hasNotificationPermission()) { requestNotificationPermission(); return; }
        findViewById(R.id.remotePair).setEnabled(false);
        findViewById(R.id.remoteDisconnect).setEnabled(false);
        ((TextView) findViewById(R.id.remoteStatus)).setText(pair ? "연결 코드를 만들고 있어요…" : "연결을 해제하고 있어요…");
        new Thread(() -> {
            String code = null;
            String error = null;
            try {
                if (pair) code = RemotePush.pair(getApplicationContext());
                else RemotePush.disconnect(getApplicationContext());
            } catch (Exception exception) { error = "연결 요청에 실패했어요. 인터넷 연결을 확인한 뒤 다시 눌러 주세요."; }
            final String result = code;
            final String failure = error;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) return;
                setupRemote();
                findViewById(R.id.remoteDisconnect).setEnabled(true);
                TextView status = findViewById(R.id.remoteStatus);
                if (failure != null) { status.setText(failure); return; }
                if (result != null) {
                    ClipData clip = ClipData.newPlainText("Silly-Pop PC 연결 코드", result);
                    PersistableBundle extras = new PersistableBundle();
                    extras.putBoolean("android.content.extra.IS_SENSITIVE", true);
                    clip.getDescription().setExtras(extras);
                    getSystemService(ClipboardManager.class).setPrimaryClip(clip);
                    status.setText("복사했어요! 10분 안에 실리태번의 Silly-Pop → 컴퓨터 서버 연결에 붙여넣어 주세요. 새 PC를 연결하면 이전 연결은 해제돼요.");
                } else status.setText("PC 알림 연결을 해제했어요.");
            });
        }, "silly-pop-pairing").start();
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
