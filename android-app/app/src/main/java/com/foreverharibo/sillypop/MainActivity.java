package com.foreverharibo.sillypop;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.Button;
import android.widget.TextView;
import android.widget.Toast;

public final class MainActivity extends Activity {
    private static final int NOTIFICATION_PERMISSION_REQUEST = 1001;
    private TextView permissionStatus;
    private Button permissionButton;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        NotificationHelper.createChannels(this);

        permissionStatus = findViewById(R.id.permissionStatus);
        permissionButton = findViewById(R.id.permissionButton);
        Button testButton = findViewById(R.id.testButton);
        Button openSillyButton = findViewById(R.id.openSillyButton);

        permissionButton.setOnClickListener(view -> requestNotificationPermission());
        testButton.setOnClickListener(view -> sendTestNotification());
        openSillyButton.setOnClickListener(view -> openSillyTavern());
        updatePermissionUi();
    }

    @Override
    protected void onResume() {
        super.onResume();
        updatePermissionUi();
    }

    private boolean hasNotificationPermission() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !hasNotificationPermission()) {
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
        NotificationHelper.show(
            this,
            "Silly-Pop 테스트",
            "톡! 알림이 예쁘게 잘 도착했어요 ✨",
            url,
            true,
            true
        );
        Toast.makeText(this, "테스트 알림을 보냈어요!", Toast.LENGTH_SHORT).show();
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
