package com.foreverharibo.sillypop;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.HashSet;
import java.util.Set;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONObject;

/** Per-installation secret; never accepted from an incoming broadcast. */
final class BridgeAuth {
    static final String PREFS = "silly_pop_bridge_auth";
    static final long WINDOW_MS = 120000;
    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static synchronized String getOrCreateKey(Context context) {
        SharedPreferences prefs = preferences(context);
        String key = prefs.getString("key", "");
        if (key.matches("[a-f0-9]{64}")) return key;
        byte[] bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        StringBuilder hex = new StringBuilder();
        for (byte value : bytes) hex.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        key = hex.toString();
        if (!prefs.edit().putString("key", key).remove("nonces").commit()) {
            throw new IllegalStateException("연결 키를 저장하지 못했어요.");
        }
        return key;
    }

    static JSONObject verify(Context context, Intent intent) {
        return verify(context, intent, System.currentTimeMillis());
    }

    static synchronized JSONObject verify(Context context, Intent intent, long now) {
        try {
            String payload = intent.getStringExtra("payload");
            String signature = intent.getStringExtra("signature");
            String key = preferences(context).getString("key", "");
            if (payload == null || payload.length() > 8192 || signature == null
                || !signature.matches("[a-f0-9]{64}") || !key.matches("[a-f0-9]{64}")) return null;
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(decodeHex(key), "HmacSHA256"));
            if (!MessageDigest.isEqual(mac.doFinal(payload.getBytes(StandardCharsets.UTF_8)), decodeHex(signature))) return null;
            JSONObject message = new JSONObject(payload);
            long timestamp = message.getLong("ts");
            String nonce = message.getString("nonce");
            String action = message.getString("action");
            if (message.getInt("v") != 1 || !action.equals(intent.getAction())
                || !(SillyPopReceiver.ACTION_NOTIFY.equals(action) || SillyPopReceiver.ACTION_PING.equals(action))
                || timestamp < now - WINDOW_MS || timestamp > now + WINDOW_MS
                || !nonce.matches("[a-f0-9]{32}")) return null;
            Set<String> retained = new HashSet<>();
            for (String entry : preferences(context).getStringSet("nonces", new HashSet<>())) {
                int separator = entry.indexOf(':');
                if (separator != 32) continue;
                long seenTimestamp = Long.parseLong(entry.substring(separator + 1));
                if (seenTimestamp < now - WINDOW_MS) continue;
                if (entry.substring(0, separator).equals(nonce)) return null;
                retained.add(entry);
            }
            // Fail closed instead of evicting a still-valid nonce and allowing replays.
            if (retained.size() >= 512) return null;
            retained.add(nonce + ":" + timestamp);
            if (!preferences(context).edit().putStringSet("nonces", retained).commit()) return null;
            return message;
        } catch (Exception invalid) {
            return null;
        }
    }

    private static byte[] decodeHex(String value) {
        byte[] bytes = new byte[value.length() / 2];
        for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) Integer.parseInt(value.substring(i * 2, i * 2 + 2), 16);
        return bytes;
    }
}
