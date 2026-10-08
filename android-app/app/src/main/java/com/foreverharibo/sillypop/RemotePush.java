package com.foreverharibo.sillypop;

import android.content.Context;
import android.content.SharedPreferences;
import com.google.android.gms.tasks.Tasks;
import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseUser;
import com.google.firebase.messaging.FirebaseMessaging;
import org.json.JSONObject;
import java.io.InputStream;
import java.net.URL;
import javax.net.ssl.HttpsURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

final class RemotePush {
    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences("silly_pop_remote", Context.MODE_PRIVATE);
    }
    static boolean enabled(Context context) { return prefs(context).getBoolean("enabled", false); }

    // Called only on a background thread. Serialization prevents a token refresh
    // worker from resurrecting a registration while the user disconnects it.
    static synchronized String pair(Context context) throws Exception {
        if (!BuildConfig.PUSH_CONFIGURED) throw new IllegalStateException("Unconfigured push");
        prefs(context).edit().putBoolean("enabled", true).commit();
        FirebaseMessaging.getInstance().setAutoInitEnabled(true);
        sync(context);
        return request("/device/pair", new JSONObject()).getString("code");
    }
    static synchronized void sync(Context context) throws Exception {
        if (!BuildConfig.PUSH_CONFIGURED || !enabled(context)) return;
        FirebaseMessaging.getInstance().setAutoInitEnabled(true);
        String token = Tasks.await(FirebaseMessaging.getInstance().getToken(), 20, TimeUnit.SECONDS);
        request("/device/register", new JSONObject().put("token", token));
    }
    static synchronized void disconnect(Context context) throws Exception {
        if (!BuildConfig.PUSH_CONFIGURED || !enabled(context)) return;
        // Keep registration retryable if the gateway cannot confirm revocation.
        request("/device/disconnect", new JSONObject());
        prefs(context).edit().putBoolean("enabled", false).commit();
        FirebaseMessaging.getInstance().setAutoInitEnabled(false);
        PushSyncWorker.cancel(context);
        // A stale token cannot send after server-side revocation. Deletion is
        // best effort; a later opt-in can safely fetch a fresh token.
        FirebaseMessaging.getInstance().deleteToken();
    }
    private static JSONObject request(String route, JSONObject body) throws Exception {
        FirebaseAuth auth = FirebaseAuth.getInstance();
        FirebaseUser user = auth.getCurrentUser();
        if (user == null) user = Tasks.await(auth.signInAnonymously(), 20, TimeUnit.SECONDS).getUser();
        if (user == null) throw new IllegalStateException("Authentication failed");
        String bearer = Tasks.await(user.getIdToken(false), 20, TimeUnit.SECONDS).getToken();
        URL url = new URL(BuildConfig.PUSH_GATEWAY.replaceAll("/$", "") + route);
        if (!"https".equals(url.getProtocol())) throw new IllegalStateException("HTTPS required");
        HttpsURLConnection connection = (HttpsURLConnection) url.openConnection();
        try {
            connection.setConnectTimeout(12000);
            connection.setReadTimeout(12000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Authorization", "Bearer " + bearer);
            connection.setDoOutput(true);
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(bytes.length);
            try (java.io.OutputStream out = connection.getOutputStream()) { out.write(bytes); }
            if (connection.getResponseCode() != 200) throw new java.io.IOException("Push connection failed");
            try (InputStream in = connection.getInputStream()) {
                java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
                byte[] buffer = new byte[1024];
                int read;
                while ((read = in.read(buffer)) != -1) {
                    if (out.size() + read > 8192) throw new java.io.IOException("Oversized response");
                    out.write(buffer, 0, read);
                }
                return new JSONObject(out.toString("UTF-8"));
            }
        } finally { connection.disconnect(); }
    }
}
