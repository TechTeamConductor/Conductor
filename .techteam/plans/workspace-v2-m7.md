# Sub-plan M7 — Desktop distribution (Windows `.exe`, Debian `.deb`) and cross-platform runtime

- Parent: `.techteam/plans/workspace-v2.md` (direction M7 incl. binding requirements F-9 and additions M-5). Requirement: `workspace-v2-requirements.md` §1 (complete product), §9 (Desktop Distribution and Reliability).
- Author: TechTeam Lead · Date: 2026-10-20 · Plan status: **pending_reviewer** (rev 1) · Depends on: M1–M6.
- Gates: Reviewer approval before the first source edit **and Security design sign-off before the first source edit** (Electron main/preload/IPC, secret storage, an OS-specific child-process layer, a packaged binary users will run). **User permission is required before anything is downloaded** (decision D4): Electron, electron-builder, NSIS/fpm tooling, Docker images. Nothing in this plan is downloaded or installed until the user says yes in chat.
- **Honesty rule (binding):** Windows is **preview / unverified** until a real Windows host has run the installer and the doctor self-test; Linux `.deb` is reported unverified beyond what a container smoke test proves; any CI workflow is **written, never executed** (no push) and reported as unvalidated YAML. Nothing here is called "production ready" without that evidence.

## 1. Current State (verified in the clone at `bd5f186`)

- **Zero-runtime-dependency Node ≥ 22.18 app** started as `node bin/conductor.mjs start`; TypeScript runs by type stripping; the UI is static files served by the loopback server (OTP login, session cookie, CSRF).
- **macOS-only edges:** secrets in the macOS Keychain via the `security` CLI with a 0600 file fallback (`secrets.ts`); background service = launchd (`service.ts`, v2's own label); notifications via `osascript` (`notify.ts`); "open" via `/usr/bin/open` and a POSIX `SAFE_PATH`/`searchPath` (`config.ts`, `cli.ts`, `server/open.ts`); the control channel is a unix socket (`paths.control`, `http.ts`); path checks use `startsWith('/')` (`api.ts`, `config.ts validRepo`); child processes use POSIX tools: gates and dependency installs run through `sh -c` (`git/gates.ts`, `git/worktree.ts`), the no-push env uses `/usr/bin/false` and `/dev/null` (`agentGitEnv`, `GIT_CONFIG_GLOBAL`), process groups via `kill(-pid)` (`agents/spawn.ts`), the child env allow-list carries POSIX keys only (`agents/env.ts`).
- **No packaging at all:** no Electron shell, no installer, no CI definition, no diagnostics export, no tray/background behaviour definition, no secret inventory document.
- **Environment (verified earlier today):** macOS arm64, Node v22.21.1, Docker present, wine absent; Electron/electron-builder not installed (and not to be installed without permission).

## 2. Expected State

**Conductor can be built into (a) an Electron desktop app that runs the existing server as a sidecar and presents the same dashboard, and (b) a Windows installer and a Debian package — with the platform differences isolated behind one strategy layer, every OS-specific safety property re-established per OS, and each artifact labelled with exactly what was and was not verified.**

### 2.1 Delivery in three sub-milestones (each reviewable, each ends green)

- **M7a — cross-platform strategy layer + build-to-`dist`** (no new dependency, no download): the runtime gains `src/platform/{index,posix,win32}.ts` behind one interface and the app can be built into a self-contained `dist/` that runs with only Node. Everything verifiable on macOS (and Linux via a container if Docker is allowed) is tested here.
- **M7b — Electron shell** (needs the download permission): `desktop/` main + preload + sidecar management, hardened per F-9, with a unit-testable core and a scripted smoke run.
- **M7c — packaging + CI + diagnostics + docs** (needs the download permission for builder tooling/images): electron-builder config for NSIS (`.exe`) and `.deb`, the build run in a Docker image (Docker is present; wine is not), a smoke test of the `.deb` in a container, written-but-unexecuted CI YAML, the diagnostics export, and the secret inventory.

### 2.2 Strategy layer (M7a) — what is abstracted and how each OS behaves

| Concern | POSIX (macOS/Linux) | Windows (preview) |
| --- | --- | --- |
| Secret store | macOS Keychain via stdin (unchanged); Linux: `secret-tool` (libsecret) if present else the 0600 file store with a visible notice | DPAPI-backed encrypted file via a PowerShell-free route is not possible without a native module → **Windows uses Electron `safeStorage` only in the desktop app; the CLI/server on Windows refuses silent plaintext** (explicit consent step on `basic_text`); the sidecar receives secrets over IPC, never argv/env |
| Process runner for gates/installs | `sh -c` as today (explicit, documented) | **no `shell:true` and no `cmd /c` with agent- or schema-derived text:** gate/install commands are split into argv by a strict tokenizer or run from a temp script file written by Conductor (`.cmd`/`.ps1` generated from the validated command, never from model text); `.cmd` shims resolved to the underlying executable via `PATHEXT`; if a command cannot be run safely it is refused with the reason |
| No-push git env | `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_ASKPASS=/usr/bin/false` | `NUL` and a generated stub executable; **the no-push guard self-test (`doctor`) must exercise the guard on the host OS** — a platform whose self-test cannot run is reported unverified and **cannot build** (the build capability is gated on a passed host self-test record) |
| Process tree kill | `kill(-pgid)` | `taskkill /T /F /PID` |
| Child env allow-list | POSIX keys | + `USERPROFILE, APPDATA, LOCALAPPDATA, SystemRoot, SystemDrive, PATHEXT, TEMP, TMP, COMSPEC`; never `shell:true` |
| Paths | POSIX checks | `path.isAbsolute` + drive/UNC rules everywhere `startsWith('/')` is used; reserved device names refused |
| Control channel | unix socket 0600 | **none in desktop mode** (the dashboard server is the only channel); a named pipe only with an explicit restrictive DACL — not built in v2.0 |
| Background service | launchd (own label) | desktop: tray + sidecar (§2.4); no native Windows service (out of scope) |
| Notifications / open | `osascript` / `open`, `xdg-open`, `notify-send` | Electron `Notification` and `shell.openExternal` (https-only) in the app; PowerShell toast **not** used |
| Worktrees | `<repo parent>/.conductor-v2-worktrees` | the same layout with Windows path limits checked (long-path refusal with a reason) |

The strategy is selected once at startup; every function has a POSIX implementation identical to today's behaviour (the existing suite must pass unchanged on macOS — extraction gate), and the Windows implementations are unit-tested **as pure logic** (tokenizer, env builder, path rules, command-file generation) on any host and are **not** claimed to work on Windows.

### 2.3 Electron shell (M7b) — binding hardening (F-9)

- **Process model:** main process (window, tray, IPC, `safeStorage`), a hardened renderer loading the loopback dashboard, and a **sidecar** running the existing server via `utilityProcess` (preferred over `ELECTRON_RUN_AS_NODE`; if the latter is kept, the reason and the RunAsNode fuse are recorded).
- **Session without new surface:** the sidecar sends `{port, otp}` to main over IPC; main loads `http://127.0.0.1:<port>/auth?otp=…` (single-use OTP). **No new HTTP route, no static token, nothing on any command line.**
- **BrowserWindow:** `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webviewTag: false`; `will-navigate` and `setWindowOpenHandler` locked to the exact loopback origin; `shell.openExternal` accepts `https:` only; permission handler denies everything; a dedicated session partition; a strict CSP (the server already sends one); no remote code or content.
- **Secrets:** `safeStorage` is reachable from the **main process only** (never exposed through preload) and delivered to the sidecar over IPC; one policy: **refuse silent plaintext** — an explicit consent screen when the backend is `basic_text`; a written **secret inventory** (what is stored, where, how injected, how redacted).
- **Single instance, crash behaviour, update policy:** one instance lock; the sidecar restarts with the existing crash-recovery path; **no auto-update** in v2.0 (documented).

### 2.4 Background execution and diagnostics (M-5)

- **Window close → tray, sidecar keeps running** (a native OS service is out of scope). Quit from the tray stops the sidecar gracefully and relies on the existing crash recovery for anything in flight; documented and tested at the sidecar-manager level.
- **Diagnostics export** (user-triggered, file chosen by the user): redacted logs, versions (app, Node/Electron, CLIs), provider checks, schema versions, platform strategy report, no secrets and no run content beyond keys/status — redaction tested with planted secrets.

### 2.5 Packaging (M7c)

electron-builder config: NSIS installer (`.exe`, per-user, no admin by default, no auto-run of anything downloaded) and `.deb` (Electron sandbox needs setuid/AppArmor care — the package postinst and docs handle `chrome-sandbox`); the app bundles Conductor's `dist/` (zero runtime dependencies → nothing else to ship); build runs in a Docker image on this macOS host (cross-building NSIS without wine uses the electron-builder Docker image); **a `.deb` install + launch smoke test under Xvfb in a container**, or reported unverified; the Windows `.exe` is built but **cannot be executed here**: reported *built, unverified*. A CI workflow file (matrix build on `windows-latest` + `ubuntu-latest`, artifact upload) is written but **never executed** and labelled unvalidated YAML.

### 2.6 Measurable acceptance criteria

- **M7-AC1 (a)** The strategy layer exists; **all pre-M7 tests pass unchanged on macOS**; POSIX behaviour is byte-identical (snapshot tests for argv/env/commands per OS function).
- **M7-AC2 (a)** Windows logic units tested as pure functions: command tokenizer refusals (injection corpus: `& | ; ` $() %VAR% ^ newline`), `.cmd` resolution, env allow-list contents, path rules (drive/UNC/reserved names/long paths), command-file generation never contains unvalidated text, `taskkill` argv.
- **M7-AC3 (a)** A host self-test record gates the build capability: a platform without a passed no-push self-test cannot build (test with a fake record store).
- **M7-AC4 (a)** `dist/` build runs with only Node and passes a smoke test (server starts, OTP login, API state).
- **M7-AC5 (b)** Shell core tests: window options object equals the hardened spec (a frozen-spec test), navigation/openExternal/permission handlers reject everything outside the allow-list (table tests), IPC channel list is exactly the documented set, `safeStorage` unreachable from preload (static test), no HTTP route/token/command-line secret added.
- **M7-AC6 (b/c)** Sidecar manager: start/stop/restart/crash-recovery, tray close keeps it running, quit stops it gracefully (fake sidecar).
- **M7-AC7 (c)** Diagnostics export contains no planted secret; secret inventory document present and matches the code (test greps the stores it names).
- **M7-AC8 (c)** `.deb` builds in a container and installs/launches under Xvfb (or is reported unverified); the NSIS `.exe` builds (or is reported not built) and is labelled **built, unverified**; CI YAML lint-parses and is labelled unvalidated.
- **M7-AC9** Final report states exactly what ran on which OS.

## 3. Files to Be Changed

| File | Action | Change |
| --- | --- | --- |
| `src/platform/{index,posix,win32}.ts` | Create | the strategy interface + implementations (runner, kill, env, paths, notify, open, secrets backend selection, service, no-push helpers) |
| `src/secrets.ts`, `service.ts`, `notify.ts`, `server/open.ts`, `agents/env.ts`, `agents/spawn.ts`, `git/gates.ts`, `git/worktree.ts`, `config.ts`, `server/api.ts`, `cli.ts` | Modify | route OS-specific calls through the strategy; POSIX behaviour unchanged |
| `src/doctor.ts` | Modify | host no-push self-test + record; platform report |
| `scripts/build-dist.mjs` | Create | assemble `dist/` (no dependency) |
| `desktop/{main,preload,sidecar,tray,menu,ipc,window-spec}.ts` (+ `package.json` for the shell) | Create | Electron app (M7b; dependencies added only after permission, kept out of the root package) |
| `desktop/electron-builder.yml`, `desktop/build/*` | Create | NSIS + deb config, `chrome-sandbox` handling, icons |
| `.github/workflows/desktop.yml` | Create | matrix build (never executed here) |
| `docs/DESKTOP.md`, `docs/SECRETS.md`, `README.md`, `docs/ARCHITECTURE.md` | Create/Modify | install steps, tray behaviour, secret inventory, platform support table with honest labels |
| `test/platform/*.test.ts`, `test/desktop/*.test.ts` | Create | per §5 |

## 4. Implementation TODO

- [ ] Reviewer approval **and Security design sign-off** (before any edit).
- [ ] **Ask the user** for permission to download Electron, electron-builder and the build Docker image(s) (D4) — before M7b/M7c; M7a needs no download.
- [ ] **M7a-1 characterization** of the OS-touching functions (argv/env/command snapshots) → **M7a-2 strategy layer extraction** (POSIX identical) → **M7a-3 Windows logic units + self-test gating + `dist` build.**
- [ ] **M7b** (after permission): shell core + hardened window + IPC + sidecar manager + tray + `safeStorage` flow, with unit tests and a scripted smoke run.
- [ ] **M7c** (after permission): packaging config, container builds, `.deb` smoke test, diagnostics export, secret inventory, CI YAML, docs; run what can run, list what could not.
- [ ] Reviewer code review + Security review per sub-milestone; checkpoint commit.

## 5. Testing Strategy

- **Extraction gate:** the full existing suite unchanged on macOS; snapshot tests of every OS-touching function's output on POSIX before/after.
- **Windows logic (any host):** injection corpora against the tokenizer and command-file generator, env/path rule tables, `taskkill` argv, secret-backend selection logic, self-test gating.
- **Shell core:** frozen window-spec test, handler tables, IPC allow-list, static tests (no `contextBridge` exposure of secrets; no new HTTP routes; no secrets in argv/env), sidecar manager with a fake child.
- **Packaging:** builds in containers where permitted; `.deb` install/launch smoke under Xvfb; checksums recorded; all artifacts labelled per the honesty rule.
- **Not run (stated):** anything on real Windows; any macOS `.dmg`/notarisation (out of scope); auto-update; the CI workflow.

## 6. Risks and Dependencies

- **Native-module-free secret storage on Windows** forces `safeStorage` (desktop only): the headless Windows CLI path is limited — documented.
- **Cross-building NSIS without wine** relies on a Docker image download; if refused or unavailable the `.exe` is reported *not built*.
- **Electron on Linux (`chrome-sandbox`/AppArmor/userns):** packaging must not silently disable the sandbox; if it cannot be kept, the `.deb` is reported unverified with the reason.
- **Scope/size:** M7a is valuable on its own (a safer, portable core); M7b/c depend on the user's permission and on tooling that cannot be fully validated on this machine.

## 7. Requirement Coverage Matrix (M7 slice)

| Requirement | Coverage |
| --- | --- |
| §9 Windows installer/executable distribution (`.exe`) | **Built if tooling is permitted and works; always labelled unverified until run on a real Windows host** |
| §9 Debian package (`.deb`) | Built + container smoke test if permitted; else reported unverified |
| §9 persistent local project and workflow data | Covered (existing v2 home; per-OS data dir mapping in the strategy layer) |
| §9 secure handling of credentials, tokens, local files | Covered by the secret inventory + safeStorage policy + redaction + hardened shell (design); verified at unit level only |
| §9 reliability, crash recovery, background behaviour, diagnostics | Covered (existing recovery path, tray behaviour, diagnostics export) |
| §1 "complete product" across OSes | **Partial** by the honesty rule: macOS verified; Linux container-verified at best; Windows preview |
