# Silly-Pop Android Companion Bridge

This directory contains the optional SillyTavern server plugin used by Silly-Pop v1.3.0 and later.

The repository root `package.json` points SillyTavern's server plugin loader to `server-plugin/index.cjs`, so the same GitHub repository URL can be installed both as a client extension and as a server plugin.

The plugin watches only generation responses explicitly marked by the Silly-Pop client extension. When a successful marked response finishes, it spawns Android's `/system/bin/am` directly (without a shell) and sends an explicit broadcast to the Silly-Pop companion app. Only sanitized HTTP(S) URLs and short notification text are passed to the app.

See the root [README](../README.md) for installation instructions.
