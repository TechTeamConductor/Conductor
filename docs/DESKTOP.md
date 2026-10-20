# Conductor desktop app (macOS)

A native macOS wrapper around the same local dashboard. **Scope: the macOS `.dmg` only** (Apple Silicon build; no Windows or Linux packages).

## Build
```bash
cd desktop
npm install            # pinned: electron 44.9.2, electron-builder 26.15.3 (packaging-only; the app itself has no dependencies)
npm run dist           # compiles the server to plain JS, packs, ad-hoc signs, writes desktop/dist/Conductor-<version>-arm64.dmg
```

## How it works
- `desktop/main.cjs` (Electron main) starts the server as a **utilityProcess** (`src/desktop-sidecar.ts`, compiled), which binds `127.0.0.1` on **port 0** and sends `{port, otp}` to the main process over its message channel. The window signs in with a **POST** (the one-time code is never in a URL or history). No fixed port, no control socket, no files.
- The window is hardened: `contextIsolation`, `sandbox`, no Node in the renderer, no webview, DevTools only in unpackaged builds, an in-memory session (the cookie never reaches disk), navigation/redirects restricted to the exact loopback origin, `window.open` denied (a user-clicked `https:` link opens in your browser), every permission request denied, every request outside the origin cancelled.
- Fuses flipped at pack time: `RunAsNode` off, `NODE_OPTIONS` off, inspect arguments off, cookie encryption on, `OnlyLoadAppFromAsar` on, asar integrity validation on.
- The server runs with your login-shell `PATH` (a Finder-launched app has a minimal one) so the `claude` and `agent` CLIs are found. Data lives in `~/.conductor-v2`, shared with `conductor start`; only one of them can run at a time.

## Honest limits
- **Unsigned** (ad-hoc signature only): the first open needs right-click → Open, or System Settings → Privacy & Security → Open Anyway.
- Verified on this Mac only: the packaged app launches, its server answers on a random loopback port (302 / 401 unauthenticated), and quitting stops it. The window contents were not inspected visually here; no automated UI test of the packaged app exists.
- Apple Silicon only (arm64). No auto-update.
