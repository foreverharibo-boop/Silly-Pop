# Silly-Pop Termux Server Companion

This directory contains the optional SillyTavern server plugin used by Silly-Pop v1.2.0 and later.

The repository root `package.json` points SillyTavern's server plugin loader to `server-plugin/index.cjs`, so the same GitHub repository URL can be installed both as a client extension and as a server plugin.

The plugin watches only generation responses explicitly marked by the Silly-Pop client extension. When a successful marked response finishes, it invokes `termux-notification` without using a shell. Notification tap actions accept only HTTP(S) URLs and are shell-quoted before being passed to Termux:API.

See the root [README](../README.md) for installation instructions.
