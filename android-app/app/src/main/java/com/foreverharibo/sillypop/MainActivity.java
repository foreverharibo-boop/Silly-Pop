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
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.TextView;
import android.widget.Toast;
import java.util.Arrays;

public final class MainActivity extends Activity {
    private static final int NOTIFICATION_PERMISSION_REQUEST = 1001;
    private static final String KEY_ICON_STYLE = NotificationHelper.KEY_ICON_STYLE;
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
        blackIconButton = findViewById(R.id.blackIconButton);
        whiteIconButton = findViewById(R.id.whiteIconButton);
        Button testButton = findViewById(R.id.testButton);

        permissionButton.setOnClickListener(view -> requestNotificationPermission());
        testButton.setOnClickListener(view -> sendTestNotification());
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
            "테스트 알림이 도착했어요.",
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
        applyTheme(white);
        if (announce) NotificationHelper.refreshNotificationIcons(this);

        PackageManager packageManager = getPackageManager();
        ComponentName blackAlias = new ComponentName(this, getPackageName() + ".BlackIcon");
        ComponentName whiteAlias = new ComponentName(this, getPackageName() + ".WhiteIcon");
        // MainActivity lives in its own stable task; only disposable launcher entries change.
        if (announce) {
            ComponentName enabled = white ? whiteAlias : blackAlias;
            ComponentName disabled = white ? blackAlias : whiteAlias;
            int enabledState = packageManager.getComponentEnabledSetting(enabled);
            int disabledState = packageManager.getComponentEnabledSetting(disabled);
            boolean alreadyEnabled = enabledState == PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                || (enabledState == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT && !white);
            boolean alreadyDisabled = disabledState == PackageManager.COMPONENT_ENABLED_STATE_DISABLED
                || (disabledState == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT && !white);
            if (!alreadyEnabled || !alreadyDisabled) {
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        packageManager.setComponentEnabledSettings(Arrays.asList(
                            new PackageManager.ComponentEnabledSetting(enabled,
                                PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP),
                            new PackageManager.ComponentEnabledSetting(disabled,
                                PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP)
                        ));
                    } else {
                        packageManager.setComponentEnabledSetting(enabled,
                            PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP);
                        packageManager.setComponentEnabledSetting(disabled,
                            PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP);
                    }
                } catch (RuntimeException error) {
                    Toast.makeText(this, "화면 색상은 변경됐지만 홈 아이콘 변경에 실패했어요. 앱을 다시 열어 시도해 주세요.", Toast.LENGTH_LONG).show();
                    return;
                }
            }
        }

        if (announce) {
            Toast.makeText(this, white ? "화이트로 바꿨어요." : "블랙으로 바꿨어요.", Toast.LENGTH_SHORT).show();
        }
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

    private void applyTheme(boolean white) {
        int background = Color.parseColor(white ? "#FFFFFF" : "#101010");
        int surface = Color.parseColor(white ? "#F7F7F7" : "#1B1B1B");
        int primary = Color.parseColor(white ? "#151515" : "#F5F5F5");
        int secondary = Color.parseColor(white ? "#707070" : "#A6A6A6");
        int border = Color.parseColor(white ? "#E3E3E3" : "#333333");
        View root = findViewById(R.id.screenRoot);
        root.setBackgroundColor(background);
        colorText(root, primary, secondary);
        findViewById(R.id.settingsCard).setBackground(rounded(surface, border, 16));
        findViewById(R.id.divider).setBackgroundColor(border);
        permissionButton.setBackground(rounded(surface, border, 10));
        Button test = findViewById(R.id.testButton);
        test.setBackground(rounded(primary, primary, 12));
        test.setTextColor(background);
        blackIconButton.setBackground(rounded(Color.BLACK, white ? border : primary, 9));
        blackIconButton.setTextColor(Color.WHITE);
        whiteIconButton.setBackground(rounded(Color.WHITE, white ? primary : border, 9));
        whiteIconButton.setTextColor(Color.BLACK);
        ((ImageView) findViewById(R.id.privacyIcon)).setColorFilter(secondary);
        getWindow().setStatusBarColor(background);
        getWindow().setNavigationBarColor(background);
        getWindow().getDecorView().setSystemUiVisibility(white
            ? View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR : 0);
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
