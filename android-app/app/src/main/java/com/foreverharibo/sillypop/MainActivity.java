package com.foreverharibo.sillypop;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.TextView;
import android.widget.Toast;

public final class MainActivity extends Activity {
    private static final int NOTIFICATION_PERMISSION_REQUEST = 1001;
    private static final String KEY_ICON_STYLE = "launcher_icon_style";
    private static final String ICON_BLACK = "black";
    private static final String ICON_WHITE = "white";
    private TextView permissionStatus;
    private Button permissionButton;
    private FrameLayout logoFrame;
    private ImageView logoImage;
    private Button blackIconButton;
    private Button whiteIconButton;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        NotificationHelper.createChannels(this);

        permissionStatus = findViewById(R.id.permissionStatus);
        permissionButton = findViewById(R.id.permissionButton);
        logoFrame = findViewById(R.id.logoFrame);
        logoImage = findViewById(R.id.logoImage);
        blackIconButton = findViewById(R.id.blackIconButton);
        whiteIconButton = findViewById(R.id.whiteIconButton);
        Button testButton = findViewById(R.id.testButton);
        Button openSillyButton = findViewById(R.id.openSillyButton);

        permissionButton.setOnClickListener(view -> requestNotificationPermission());
        testButton.setOnClickListener(view -> sendTestNotification());
        openSillyButton.setOnClickListener(view -> openSillyTavern());
        blackIconButton.setOnClickListener(view -> setIconStyle(ICON_BLACK, true));
        whiteIconButton.setOnClickListener(view -> setIconStyle(ICON_WHITE, true));
        setIconStyle(getSavedIconStyle(), false);
        updatePermissionUi();
    }

    @Override
    protected void onResume() {
        super.onResume();
        updatePermissionUi();
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
            "톡! 알림이 예쁘게 잘 도착했어요 ✨",
            url,
            true,
            true
        );
        Toast.makeText(this, shown ? "테스트 알림을 보냈어요!" : "알림 설정에서 Silly-Pop 알림을 허용해 주세요.", Toast.LENGTH_SHORT).show();
    }

    private void openSillyTavern() {
        String url = getSharedPreferences(NotificationHelper.PREFERENCES, MODE_PRIVATE)
            .getString(NotificationHelper.KEY_LAST_URL, NotificationHelper.DEFAULT_SILLY_URL);
        try {
            Intent intent = NotificationHelper.createOpenIntent(this, url);
            startActivity(intent);
        } catch (Exception error) {
            Toast.makeText(this, "실리 주소를 열 수 없어요.", Toast.LENGTH_SHORT).show();
        }
    }

    private void updatePermissionUi() {
        boolean allowed = hasNotificationPermission();
        permissionStatus.setText(allowed ? R.string.permission_allowed : R.string.permission_needed);
        permissionStatus.setTextColor(getColor(allowed ? R.color.green : R.color.pink_500));
        permissionButton.setText(allowed ? "설정 열기" : getString(R.string.permission_button));
    }

    private String getSavedIconStyle() {
        return getSharedPreferences(NotificationHelper.PREFERENCES, MODE_PRIVATE)
            .getString(KEY_ICON_STYLE, ICON_BLACK);
    }

    private void setIconStyle(String style, boolean announce) {
        boolean white = ICON_WHITE.equals(style);
        getSharedPreferences(NotificationHelper.PREFERENCES, MODE_PRIVATE)
            .edit()
            .putString(KEY_ICON_STYLE, white ? ICON_WHITE : ICON_BLACK)
            .apply();

        logoFrame.setBackgroundResource(white ? R.drawable.bg_logo_white : R.drawable.bg_logo_black);
        logoImage.setImageResource(white ? R.drawable.ic_st_modular_black : R.drawable.ic_st_modular_white);
        blackIconButton.setText(white ? R.string.icon_black : R.string.icon_black_selected);
        whiteIconButton.setText(white ? R.string.icon_white_selected : R.string.icon_white);

        PackageManager packageManager = getPackageManager();
        ComponentName blackAlias = new ComponentName(this, getPackageName() + ".BlackIcon");
        ComponentName whiteAlias = new ComponentName(this, getPackageName() + ".WhiteIcon");
        packageManager.setComponentEnabledSetting(
            blackAlias,
            white ? PackageManager.COMPONENT_ENABLED_STATE_DISABLED : PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
            PackageManager.DONT_KILL_APP
        );
        packageManager.setComponentEnabledSetting(
            whiteAlias,
            white ? PackageManager.COMPONENT_ENABLED_STATE_ENABLED : PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
            PackageManager.DONT_KILL_APP
        );

        if (announce) {
            Toast.makeText(this, white ? "화이트 아이콘으로 바꿨어요." : "블랙 아이콘으로 바꿨어요.", Toast.LENGTH_SHORT).show();
        }
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
