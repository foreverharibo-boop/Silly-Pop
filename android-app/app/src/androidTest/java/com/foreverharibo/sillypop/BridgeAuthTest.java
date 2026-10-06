package com.foreverharibo.sillypop;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class BridgeAuthTest {
    @Test
    public void acceptsNodeSignatureAndRejectsMissingForgedExpiredAndReplayedRequests() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        SharedPreferences prefs = context.getSharedPreferences(BridgeAuth.PREFS, Context.MODE_PRIVATE);
        JSONObject fixture;
        try (java.io.InputStream input = InstrumentationRegistry.getInstrumentation().getContext()
                .getAssets().open("bridge-auth-vector.json")) {
            java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
            byte[] chunk = new byte[1024]; int count;
            while ((count = input.read(chunk)) != -1) bytes.write(chunk, 0, count);
            fixture = new JSONObject(bytes.toString("UTF-8"));
        }
        String raw = fixture.getString("payload");
        String signature = fixture.getString("signature");
        long now = new JSONObject(raw).getLong("ts");
        Intent valid = new Intent(SillyPopReceiver.ACTION_NOTIFY).putExtra("payload", raw).putExtra("signature", signature);
        String previousKey = prefs.getString("key", "");
        try {
            assertTrue(prefs.edit().clear().commit());
            assertNull("Unpaired app must fail closed", BridgeAuth.verify(context, valid, now));
            assertTrue(prefs.edit().putString("key", fixture.getString("key")).commit());
            assertNull(BridgeAuth.verify(context, new Intent(SillyPopReceiver.ACTION_NOTIFY).putExtra("title", "unsigned"), now));
            assertNull(BridgeAuth.verify(context, new Intent(valid).putExtra("signature", "0000000000000000000000000000000000000000000000000000000000000000"), now));
            assertNull(BridgeAuth.verify(context, new Intent(valid).putExtra("payload", raw.replace("8000", "9999")), now));
            assertNull(BridgeAuth.verify(context, new Intent(valid).setAction(SillyPopReceiver.ACTION_PING), now));
            assertNull(BridgeAuth.verify(context, valid, now + BridgeAuth.WINDOW_MS + 1));
            assertNull(BridgeAuth.verify(context, valid, now - BridgeAuth.WINDOW_MS - 1));
            JSONObject accepted = BridgeAuth.verify(context, valid, now);
            assertNotNull("Node-generated UTF-8 signature must verify in Android", accepted);
            assertEquals("김홍진의 답변이 도착했어요", accepted.getString("title"));
            assertNull("Accepted nonce persists across receiver instances", BridgeAuth.verify(context, new Intent(valid), now));
        } finally {
            SharedPreferences.Editor editor = prefs.edit().clear();
            if (!previousKey.isEmpty()) editor.putString("key", previousKey);
            assertTrue(editor.commit());
        }
    }
}
