# Conductor desktop app

A native wrapper around the same local dashboard. **macOS (Apple Silicon) `.dmg` is the supported build; the Windows `.exe` installer is experimental and unverified.** No Linux package.

## Download
Releases are published at <https://github.com/TechTeamConductor/Conductor/releases> with a `SHA256SUMS.txt`. Neither app is code-signed: macOS needs right-click → Open the first time (or System Settings → Privacy & Security → Open Anyway), and Windows SmartScreen will warn.

## Build locally
```bash
npm ci                 # repo root: the TypeScript compiler used to build the server payload
cd desktop
npm ci                 # pinned: electron 44.9.2, electron-builder 26.15.3 (packaging-only; the app itself has no dependencies)
npm run dist           # macOS: compiles the server to plain JS, packs, ad-hoc signs, writes desktop/dist/Conductor-<version>-arm64.dmg
npm run dist:win       # Windows (run on Windows): writes desktop/dist/Conductor-<version>-x64-setup.exe
```
`CONDUCTOR_VERSION=X.Y.Z` (and `-c.extraMetadata.version=X.Y.Z` for electron-builder) stamps a release version; without it the root `package.json` version is used. `CONDUCTOR_REQUIRE_VERSION=1` makes a missing or malformed version a build error (the release workflow sets it).

## Automatic versions and releases
Two GitHub Actions workflows live in `.github/workflows/`:

| Workflow | When | What |
| --- | --- | --- |
| `ci.yml` | every pull request (and reused by the release) | `npm run check` and `npm test` on macOS |
| `release.yml` | every push to `main`, or run by hand | computes the next version, tests, builds the `.dmg` and the `.exe`, publishes a GitHub Release |

**Versions come from commit messages** ([Conventional Commits](https://www.conventionalcommits.org)), since the last `vX.Y.Z` tag:

| Commit | Effect |
| --- | --- |
| `feat: …` | minor (`0.3.0` → `0.4.0`) |
| `fix: …` · `perf: …` · `revert: …` | patch (`0.3.0` → `0.3.1`) |
| `feat!: …` or a `BREAKING CHANGE:` footer | major, **except below 1.0.0, where it bumps minor** |
| `docs` · `chore` · `ci` · `test` · `style` · `refactor` · `build` | no release |

The first release is `v0.1.0`. To cut `1.0.0` (or force any bump), run **Actions → Release → Run workflow** and pick `major` / `minor` / `patch`. The git tag is the source of truth: nothing is committed back to `main`, so `package.json` keeps a development placeholder version. Publishing is all-or-nothing (a failed test or build publishes nothing), and the only job that can write to the repository is the publishing one. Versions below 1.0.0 are marked pre-release.

Local check of what the next version would be: `node scripts/next-version.ts`.

**One-time repository setting:** Settings → Actions → General → Workflow permissions must not block the workflow's declared `contents: write` (an organization policy can override it).

**Roll back a bad release:** `gh release delete vX.Y.Z --cleanup-tag --yes`. The next push to `main` recomputes the version from the remaining tags.

## How it works
- `desktop/main.cjs` (Electron main) starts the server as a **utilityProcess** (`src/desktop-sidecar.ts`, compiled), which binds `127.0.0.1` on **port 0** and sends `{port, otp}` to the main process over its message channel. The window signs in with a **POST** (the one-time code is never in a URL or history). No fixed port, no control socket, no files.
- The window is hardened: `contextIsolation`, `sandbox`, no Node in the renderer, no webview, DevTools only in unpackaged builds, an in-memory session (the cookie never reaches disk), navigation/redirects restricted to the exact loopback origin, `window.open` denied (a user-clicked `https:` link opens in your browser), every permission request denied, every request outside the origin cancelled.
- Fuses flipped at pack time: `RunAsNode` off, `NODE_OPTIONS` off, inspect arguments off, cookie encryption on, `OnlyLoadAppFromAsar` on, asar integrity validation on.
- The server runs with your login-shell `PATH` (a Finder-launched app has a minimal one) so the `claude` and `agent` CLIs are found. Data lives in `~/.conductor-v2`, shared with `conductor start`; only one of them can run at a time.

## Honest limits
- **Unsigned**: macOS has an ad-hoc signature only; the Windows installer has none.
- **Windows is experimental.** It is built by CI but has never been run on Windows by the maintainers. Secret storage (Keychain), notifications, the background service and the `open` command are macOS-only.
- Verified on macOS (Apple Silicon) only: the packaged app launches, its server answers on a random loopback port (302 / 401 unauthenticated), and quitting stops it. The window contents have not been inspected visually; no automated UI test of the packaged app exists.
- macOS build is Apple Silicon only (arm64). No auto-update.
