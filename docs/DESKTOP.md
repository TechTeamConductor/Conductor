# Releases, installers and the desktop apps

## How users install Conductor
There is no app store and no registry package: Conductor is installed by a one-line command that downloads the latest **release**, checks it, and unpacks it into your home folder.

| System | Command | Then |
| --- | --- | --- |
| macOS | `curl -fsSL https://github.com/TechTeamConductor/Conductor/releases/latest/download/install.sh \| bash` | `conductor start` |
| Windows (experimental) | `irm https://github.com/TechTeamConductor/Conductor/releases/latest/download/install.ps1 \| iex` | `conductor start` |
| Linux (experimental) | the macOS command | `conductor start` |

Needs Node.js 22.18 or newer. Update with `conductor update` (or run the same command again). See the [README](../README.md#install) for uninstalling, pinning a version and what the installer does and does not touch.

**Why not `npm install -g`?** Conductor runs its TypeScript directly (no build step) and Node refuses to run TypeScript from inside a `node_modules` folder, so an npm global install cannot work. The installer unpacks the app into `~/.conductor-app` (Windows: `%LOCALAPPDATA%\Conductor\app`) and writes a small `conductor` launcher. If you copy the app into a `node_modules` folder anyway, `conductor` stops with a message pointing here.

**What the installer does:** resolves the latest release to one tag, downloads `conductor.tgz` and `SHA256SUMS.txt` from that tag over HTTPS only, verifies the SHA-256 before unpacking (this detects corrupted downloads; the checksum comes from the same release, so the trust anchor is HTTPS plus this repository, not the checksum), refuses archives with unsafe paths or links, swaps the new version in (keeping the old one until a self-check passes, then rolls back on failure), writes the launcher, and never touches your data folder. macOS/Linux: no `sudo`, no edits to your shell profile (it prints the PATH line if you need it). Windows: adds the launcher folder to your **user** PATH only. Both installers only ever replace a launcher or app folder they created themselves.

**Two different "uninstall"s:** `conductor uninstall` removes the background service (and, with `--purge`, your data folder). The installer's `--uninstall` (Windows: `CONDUCTOR_UNINSTALL=1`) removes the app and the launcher and never your data.

**Windows is experimental.** The installer and the dashboard work, but registering repositories, running gates and launching the `claude` / `agent` CLIs are not ported to native Windows yet (repo paths must start with `/`, gates run through `sh -c`, the CLI shims are `.cmd` files). Use WSL2 or a Mac for the full product. Linux is experimental too: CI only checks install and dashboard start.

## Automatic versions and releases
Four GitHub Actions workflows live in `.github/workflows/`:

| Workflow | When | What |
| --- | --- | --- |
| `ci.yml` | every pull request (and reused by the release) | `npm run check` and `npm test` on macOS, plus the packaging check below on pull requests |
| `package.yml` | pull requests, the release, or by hand (dry run) | stamps a version, packs `conductor.tgz`, writes `SHA256SUMS.txt`, lints both installers, then installs the package for real on macOS, Linux and (experimentally) Windows: start the dashboard, update, refuse a tampered download, uninstall |
| `release.yml` | every push to `main`, or run by hand | computes the next version, tests, packages, and publishes a **full GitHub Release marked Latest** |
| `desktop.yml` | by hand only | parked: builds the macOS `.dmg` and Windows `.exe`, not part of releases |

**Versions come from commit messages** ([Conventional Commits](https://www.conventionalcommits.org)), since the last `vX.Y.Z` tag:

| Commit | Effect |
| --- | --- |
| `feat: …` | minor (`0.3.0` → `0.4.0`) |
| `fix: …` · `perf: …` · `revert: …` | patch (`0.3.0` → `0.3.1`) |
| `feat!: …` or a `BREAKING CHANGE:` footer | major, **except below 1.0.0, where it bumps minor** |
| `docs` · `chore` · `ci` · `test` · `style` · `refactor` · `build` | no release |

To cut `1.0.0` (or force any bump), run **Actions → Release → Run workflow** and pick `major` / `minor` / `patch`. The git tag is the source of truth: nothing is committed back to `main`, so `package.json` keeps the development placeholder `0.0.0-dev` and a release stamps the real version into the package it builds. Local check of what the next version would be: `node scripts/next-version.ts`.

**What a release contains:** `conductor.tgz`, `install.sh`, `install.ps1` and `SHA256SUMS.txt`, with generated release notes and the install commands on top. The release is created as a draft, its assets are verified against the checksums, and only then it is published as the latest full release (so `…/releases/latest/download/install.sh` always works). The only job that can write to the repository is the publishing one, and it never runs for a pull request. A failed test, package or macOS/Linux install check publishes nothing; the experimental Windows check is reported in the release notes instead of blocking the release.

**One-time repository settings:** Settings → Actions → General → Workflow permissions must not block the workflow's declared `contents: write` (an organization policy can override it). The one-line install commands download from the release page, so the repository must be **public** for anyone but you to use them.

**Roll back a bad release:** `gh release delete vX.Y.Z --cleanup-tag --yes`. The next push to `main` recomputes the version from the remaining tags (the installers always use the latest published release).

## The desktop apps (parked for a later phase)
A native wrapper around the same local dashboard exists in `desktop/` (Electron). It is **not part of releases** and not the recommended way to install: the macOS `.dmg` is only ad-hoc signed, so macOS Gatekeeper blocks it until it is signed with a Developer ID certificate and notarized (planned), and the Windows `.exe` is unsigned and experimental. You can still build them by hand:

```bash
npm ci                 # repo root: the TypeScript compiler used to build the server payload
cd desktop
npm ci                 # pinned: electron 44.9.2, electron-builder 26.15.3 (packaging-only; the app itself has no dependencies)
npm run dist           # macOS: writes desktop/dist/Conductor-<version>-arm64.dmg
npm run dist:win       # Windows (run on Windows): writes desktop/dist/Conductor-<version>-x64-setup.exe
```
`CONDUCTOR_VERSION=X.Y.Z` (and `-c.extraMetadata.version=X.Y.Z` for electron-builder) stamps a version; `CONDUCTOR_REQUIRE_VERSION=1` makes a missing or malformed version a build error. The manual `desktop.yml` workflow does the same on GitHub runners.

If you do run the unsigned `.dmg` on a Mac, remove the download mark once: `xattr -dr com.apple.quarantine /Applications/Conductor.app`, or use System Settings → Privacy & Security → Open Anyway.

### How the desktop app works
- `desktop/main.cjs` (Electron main) starts the server as a **utilityProcess** (`src/desktop-sidecar.ts`, compiled), which binds `127.0.0.1` on **port 0** and sends `{port, otp}` to the main process over its message channel. The window signs in with a **POST** (the one-time code is never in a URL or history). No fixed port, no control socket, no files.
- The window is hardened: `contextIsolation`, `sandbox`, no Node in the renderer, no webview, DevTools only in unpackaged builds, an in-memory session (the cookie never reaches disk), navigation/redirects restricted to the exact loopback origin, `window.open` denied (a user-clicked `https:` link opens in your browser), every permission request denied, every request outside the origin cancelled.
- Fuses flipped at pack time: `RunAsNode` off, `NODE_OPTIONS` off, inspect arguments off, cookie encryption on, `OnlyLoadAppFromAsar` on, asar integrity validation on.
- The server runs with your login-shell `PATH` (a Finder-launched app has a minimal one) so the `claude` and `agent` CLIs are found. Data lives in `~/.conductor-v2`, shared with `conductor start`; only one of them can run at a time.

## Honest limits
- **Unsigned**: macOS has an ad-hoc signature only; the Windows installer has none.
- **Windows is experimental.** It is built by CI but has never been run on Windows by the maintainers. Secret storage (Keychain), notifications, the background service and the `open` command are macOS-only.
- Verified on macOS (Apple Silicon) only: the packaged app launches, its server answers on a random loopback port (302 / 401 unauthenticated), and quitting stops it. The window contents have not been inspected visually; no automated UI test of the packaged app exists.
- macOS build is Apple Silicon only (arm64). No auto-update.
