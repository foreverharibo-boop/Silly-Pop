package com.foreverharibo.sillypop;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

/** A disposable launcher entry, never the root of the settings screen's task. */
public final class LauncherActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        startActivity(new Intent(this, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP));
        finish();
    }
}
