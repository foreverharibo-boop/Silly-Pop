# Silly-Pop Android Companion Bridge

This directory contains the optional SillyTavern server plugin used by Silly-Pop v1.3.0 and later.

The repository root `package.json` points SillyTavern's server plugin loader to `server-plugin/index.cjs`, so the same GitHub repository URL can be installed both as a client extension and as a server plugin.

The plugin watches only generation responses explicitly marked by the Silly-Pop client extension. When a successful marked response finishes, it spawns Termux's `am` directly (without a shell) and sends an explicit broadcast to the Silly-Pop companion app. Only sanitized HTTP(S) URLs and short notification text are passed to the app.

See the root [README](../README.md) for installation instructions.

Server 2.4.3 requires app 1.0.0 and one-time pairing using the command copied from the app. Requests carry an HMAC-SHA256 signature, timestamp and nonce; the pairing key is never included in broadcasts. See the root README for setup.

Extension 1.5.2 reports page visibility rather than keyboard/window focus. Background-only notifications use the latest visibility at response completion; a previous trip to the background no longer overrides a return to SillyTavern.


Server 2.4.3 validates a bounded response copy (JSON/SSE, including gzip/deflate/Brotli) before notifying. Empty, error-only, interrupted and oversized responses are excluded. Extension 1.5.2 supplies a generation ID so retries and nested 100LOG rewrites are deduplicated per client and generation. This remains a server-receipt notification, not a final review/render notification. Update both the extension and server plugin; no APK reinstall or pairing reset is required.
