'use strict';
// Conductor desktop shell (macOS). Main process: window + sidecar lifecycle. The renderer is a hardened, sandboxed view of the loopback
// dashboard; the server runs in a separate utilityProcess and hands over {port, otp} on its message channel (port 0 — never a fixed port).
const { app, BrowserWindow, Menu, session, shell, utilityProcess, dialog } = require('electron');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const { homedir } = require('node:os');

app.enableSandbox();
if (!app.requestSingleInstanceLock()) app.quit();

let sidecar = null;
let win = null;
let origin = null;
let quitting = false;

/** A Finder-launched app has a minimal PATH: take the user's login-shell PATH so the `claude` / `agent` CLIs are found. */
function loginPath() {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin'), join(homedir(), '.cursor', 'bin'), join(homedir(), '.claude', 'local')];
  let fromShell = '';
  try {
    const sh = process.env.SHELL && /^\/[A-Za-z0-9/_.-]+$/.test(process.env.SHELL) ? process.env.SHELL : '/bin/zsh';
    fromShell = execFileSync(sh, ['-ilc', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { /* fall back to the common locations */ }
  return [...new Set([...(fromShell ? fromShell.split(':') : []), ...(process.env.PATH || '').split(':'), ...extra])].filter(Boolean).join(':');
}

function startSidecar() {
  const entry = join(__dirname, 'payload', 'src', 'desktop-sidecar.js');
  const env = { ...process.env, PATH: loginPath(), CONDUCTOR_DESKTOP: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  sidecar = utilityProcess.fork(entry, [], { env, serviceName: 'Conductor server', stdio: 'inherit' });
  sidecar.on('message', (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'ready' && Number.isInteger(m.port) && m.port > 0 && typeof m.otp === 'string') openWindow(m.port, m.otp);
    else if (m.type === 'error') fatal(typeof m.message === 'string' ? m.message : 'The Conductor server could not start.');
  });
  sidecar.on('exit', (code) => {
    sidecar = null;
    if (!quitting) fatal(`The Conductor server stopped unexpectedly (code ${code}).`);
  });
}

function fatal(message) {
  dialog.showErrorBox('Conductor', message);
  quit();
}

function hardenSession(ses) {
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.webRequest.onBeforeRequest((details, cb) => {
    try {
      const u = new URL(details.url);
      cb({ cancel: !(u.origin === origin || u.protocol === 'devtools:') });
    } catch { cb({ cancel: true }); }
  });
}

function openWindow(port, otp) {
  origin = `http://127.0.0.1:${port}`;
  const partition = 'conductor-desktop'; // no "persist:" prefix ⇒ in-memory: the session cookie never reaches disk
  const ses = session.fromPartition(partition);
  hardenSession(ses);
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 720, minHeight: 520, title: 'Conductor', show: false,
    webPreferences: {
      partition, contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
      webviewTag: false, webSecurity: true, allowRunningInsecureContent: false, experimentalFeatures: false, devTools: !app.isPackaged, navigateOnDragDrop: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  const allowed = (url) => { try { return new URL(url).origin === origin; } catch { return false; } };
  const guard = (e, url) => { if (!allowed(url)) e.preventDefault(); };
  win.webContents.on('will-navigate', guard);
  win.webContents.on('will-redirect', guard);
  win.webContents.on('will-frame-navigate', guard);
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    try { const u = new URL(url); if (u.protocol === 'https:' && !u.username && !u.password && url.length <= 2048) void shell.openExternal(url); } catch { /* ignore */ }
    return { action: 'deny' };
  });
  // sign in with a POST (the code never appears in a URL or in history)
  win.loadURL(`${origin}/auth`, { postData: [{ type: 'rawData', bytes: Buffer.from(`otp=${encodeURIComponent(otp)}`) }], extraHeaders: 'Content-Type: application/x-www-form-urlencoded' })
    .then(() => win.webContents.navigationHistory.clear())
    .catch((e) => fatal(`Could not open the dashboard: ${e.message}`));
  win.on('closed', () => { win = null; if (process.platform !== 'darwin') quit(); });
}

function quit() {
  if (quitting) return;
  quitting = true;
  if (sidecar) {
    try { sidecar.postMessage({ type: 'quit' }); } catch { /* gone */ }
    setTimeout(() => { try { sidecar && sidecar.kill(); } catch { /* gone */ } app.exit(0); }, 4000).unref();
    sidecar.once('exit', () => app.exit(0));
  } else app.exit(0);
}

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (ev) => ev.preventDefault());
});
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('before-quit', (e) => { if (!quitting) { e.preventDefault(); quit(); } });
app.on('activate', () => { if (!win && sidecar) sidecar.postMessage({ type: 'otp' }); });
app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' },
  ]));
  startSidecar();
});
