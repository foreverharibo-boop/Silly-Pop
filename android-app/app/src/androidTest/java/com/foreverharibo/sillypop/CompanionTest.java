package com.foreverharibo.sillypop;

import static org.junit.Assert.*;

import android.Manifest;
import android.app.Activity;
import android.app.Instrumentation;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.content.pm.ActivityInfo;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.ColorDrawable;
import android.widget.TextView;
import java.nio.charset.StandardCharsets;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONObject;
import android.os.Bundle;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.service.notification.StatusBarNotification;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Exercises the real launcher aliases and an external notification broadcast. */
@RunWith(AndroidJUnit4.class)
public final class CompanionTest {
    @Test
    public void notificationOpensOnlyAnUnambiguousMatchingWebApp() {
        Intent base = new Intent(Intent.ACTION_VIEW, Uri.parse("https://silly.example/chat"));
        ResolveInfo browser = webApp("browser", null);
        assertNull(NotificationHelper.selectWebAppIntent(base, java.util.List.of(browser)));
        ResolveInfo app = webApp("org.chromium.webapk.example", "https://silly.example/");
        Intent target = NotificationHelper.selectWebAppIntent(base, java.util.List.of(browser, app));
        assertNotNull(target);
        assertEquals("org.chromium.webapk.example", target.getComponent().getPackageName());
        assertEquals(base.getData(), target.getData());
        assertNull(NotificationHelper.selectWebAppIntent(base,
            java.util.List.of(webApp("other", "https://other.example/"))));
        assertNull(NotificationHelper.selectWebAppIntent(base,
            java.util.List.of(app, webApp("duplicate", "https://silly.example/"))));
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertNull(NotificationHelper.createOpenIntent(context, "javascript:alert(1)"));
    }

    private static ResolveInfo webApp(String packageName, String startUrl) {
        ResolveInfo result = new ResolveInfo();
        result.activityInfo = new ActivityInfo();
        result.activityInfo.name = "MainActivity";
        result.activityInfo.packageName = packageName;
        result.activityInfo.enabled = true;
        result.activityInfo.exported = true;
        result.activityInfo.applicationInfo = new ApplicationInfo();
        result.activityInfo.applicationInfo.enabled = true;
        result.activityInfo.applicationInfo.metaData = new Bundle();
        if (startUrl != null) result.activityInfo.applicationInfo.metaData.putString(
            "org.chromium.webapk.shell_apk.startUrl", startUrl);
        return result;
    }

    @Test
    public void whiteIconsIgnoreOldPreferenceAndBothLegacyLaunchersStillWork() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = instrumentation.getTargetContext();
        String packageName = context.getPackageName();
        if (Build.VERSION.SDK_INT >= 33) {
            instrumentation.getUiAutomation().grantRuntimePermission(packageName, Manifest.permission.POST_NOTIFICATIONS);
        }
        PackageManager pm = context.getPackageManager();
        // The system/Samsung popup reads the application icon, independently of
        // the notification bitmap. Check that source as well as both launchers.
        assertWhiteIcon(pm.getApplicationIcon(packageName));
        assertWhiteIcon(context.getDrawable(R.mipmap.ic_launcher_white_round));
        NotificationManager notifications = context.getSystemService(NotificationManager.class);
        notifications.cancelAll();
        assertTrue(context.getSharedPreferences(NotificationHelper.PREFERENCES, Context.MODE_PRIVATE)
            .edit().putString("launcher_icon_style", "black").commit());
        assertTrue(NotificationHelper.show(context, "WhiteRegression",
            NotificationHelper.DEFAULT_SILLY_URL, false, false));
        StatusBarNotification original = notifications.getActiveNotifications()[0];
        assertWhiteNotification(context, original.getNotification());

        ComponentName black = new ComponentName(packageName, packageName + ".BlackIcon");
        ComponentName white = new ComponentName(packageName, packageName + ".WhiteIcon");
        try {
            // Simulate component states retained from either pre-update theme.
            for (ComponentName entry : new ComponentName[]{black, white}) {
                pm.setComponentEnabledSetting(entry, PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
                    PackageManager.DONT_KILL_APP);
                pm.setComponentEnabledSetting(entry.equals(black) ? white : black,
                    PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP);
                assertWhiteIcon(pm.getActivityIcon(entry));
                Instrumentation.ActivityMonitor monitor = instrumentation.addMonitor(MainActivity.class.getName(), null, false);
                context.startActivity(new Intent(Intent.ACTION_MAIN)
                    .addCategory(Intent.CATEGORY_LAUNCHER).setComponent(entry)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                Activity screen = monitor.waitForActivityWithTimeout(10000);
                instrumentation.removeMonitor(monitor);
                assertNotNull("Either legacy launcher must still open settings", screen);
                instrumentation.waitForIdleSync();
                instrumentation.runOnMainSync(() -> {
                    assertFalse(screen.isFinishing());
                    assertFalse(screen.isDestroyed());
                    assertEquals(Color.WHITE, ((ColorDrawable) screen.findViewById(R.id.screenRoot).getBackground()).getColor());
                    assertTrue(((TextView) screen.findViewById(R.id.versionFooter)).getText().toString()
                        .contains(BuildConfig.VERSION_NAME));
                });
                assertFalse(context.getSharedPreferences(NotificationHelper.PREFERENCES, Context.MODE_PRIVATE)
                    .contains("launcher_icon_style"));
                StatusBarNotification[] active = notifications.getActiveNotifications();
                assertEquals("Refreshing an old notification must not duplicate it", 1, active.length);
                assertEquals(original.getId(), active[0].getId());
                Notification updated = active[0].getNotification();
                assertEquals("WhiteRegression", updated.extras.getCharSequence(Notification.EXTRA_TITLE).toString());
                assertEquals(original.getNotification().when, updated.when);
                assertTrue((updated.flags & Notification.FLAG_ONLY_ALERT_ONCE) != 0);
                assertWhiteNotification(context, updated);
                instrumentation.runOnMainSync(screen::finish);
                instrumentation.waitForIdleSync();
            }
        } finally {
            pm.setComponentEnabledSetting(black, PackageManager.COMPONENT_ENABLED_STATE_DEFAULT, PackageManager.DONT_KILL_APP);
            pm.setComponentEnabledSetting(white, PackageManager.COMPONENT_ENABLED_STATE_DEFAULT, PackageManager.DONT_KILL_APP);
        }

        notifications.cancelAll();
        String prefix = "am broadcast --receiver-foreground --include-stopped-packages -n " + packageName
            + "/.SillyPopReceiver -a " + SillyPopReceiver.ACTION_NOTIFY;
        assertTrue(shell(instrumentation, prefix
            + " --es title Forged --es url http://attacker.invalid/ --ez sound true").contains("authentication-failed"));
        assertEquals(0, notifications.getActiveNotifications().length);
        JSONObject payload = new JSONObject().put("v", 1).put("action", SillyPopReceiver.ACTION_NOTIFY)
            .put("ts", System.currentTimeMillis()).put("nonce", java.util.UUID.randomUUID().toString().replace("-", ""))
            .put("title", "CompanionRegression").put("url", NotificationHelper.DEFAULT_SILLY_URL)
            .put("sound", false).put("vibrate", false);
        String raw = payload.toString();
        String signature = sign(raw, BridgeAuth.getOrCreateKey(context));
        String command = prefix + " --es payload " + quote(raw) + " --es signature " + signature;
        assertTrue(shell(instrumentation, prefix + " --es payload " + quote(raw.replace("CompanionRegression", "Forged"))
            + " --es signature " + signature).contains("authentication-failed"));
        assertEquals(0, notifications.getActiveNotifications().length);
        assertTrue(shell(instrumentation, command).contains("data=\"ok\""));
        boolean received = false;
        for (int attempt = 0; attempt < 30 && !received; attempt++) {
            for (StatusBarNotification posted : notifications.getActiveNotifications()) {
                if ("CompanionRegression".contentEquals(
                    posted.getNotification().extras.getCharSequence(Notification.EXTRA_TITLE, ""))) {
                    received = true;
                    assertNull("No installed localhost WebAPK: notification must not open a browser",
                        posted.getNotification().contentIntent);
                    assertWhiteNotification(context, posted.getNotification());
                }
            }
            if (!received) SystemClock.sleep(100);
        }
        assertTrue("Authenticated external broadcast must still post a white system notification", received);
        notifications.cancelAll();
        assertTrue(shell(instrumentation, command).contains("authentication-failed"));
        assertEquals("Replayed notification must be rejected", 0, notifications.getActiveNotifications().length);
    }

    static String quote(String value) { return "'" + value.replace("'", "'\"'\"'") + "'"; }

    static String shell(Instrumentation instrumentation, String command) throws Exception {
        ParcelFileDescriptor[] pipes = instrumentation.getUiAutomation().executeShellCommandRw("sh");
        try (ParcelFileDescriptor.AutoCloseOutputStream input = new ParcelFileDescriptor.AutoCloseOutputStream(pipes[1])) {
            input.write((command + "\nexit\n").getBytes(StandardCharsets.UTF_8));
        }
        try (ParcelFileDescriptor.AutoCloseInputStream stream = new ParcelFileDescriptor.AutoCloseInputStream(pipes[0]);
             java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream()) {
            byte[] buffer = new byte[1024];
            int count;
            while ((count = stream.read(buffer)) != -1) bytes.write(buffer, 0, count);
            return bytes.toString("UTF-8");
        }
    }

    static String sign(String payload, String hexKey) throws Exception {
        byte[] key = new byte[32];
        for (int i = 0; i < key.length; i++) key[i] = (byte) Integer.parseInt(hexKey.substring(i * 2, i * 2 + 2), 16);
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        StringBuilder result = new StringBuilder();
        for (byte value : mac.doFinal(payload.getBytes(StandardCharsets.UTF_8)))
            result.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        return result.toString();
    }

    private static void assertWhiteNotification(Context context, Notification notification) {
        assertNull("Title-only notifications must omit the body", notification.extras.getCharSequence(Notification.EXTRA_TEXT));
        assertNull("Expanded notifications must also omit the body", notification.extras.getCharSequence(Notification.EXTRA_BIG_TEXT));
        assertNotNull("Notification must carry its white S-star icon", notification.getLargeIcon());
        assertWhiteIcon(notification.getLargeIcon().loadDrawable(context));
    }

    private static void assertWhiteIcon(Drawable icon) {
        assertNotNull(icon);
        Bitmap rendered = Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888);
        icon.setBounds(0, 0, 64, 64);
        icon.draw(new Canvas(rendered));
        int pixel = rendered.getPixel(32, 8); // Inside background, above the logo.
        assertEquals(255, Color.alpha(pixel));
        assertTrue("App, launcher and notification backgrounds must all be white",
            Color.red(pixel) > 240 && Color.green(pixel) > 240 && Color.blue(pixel) > 240);
    }
}
