'use strict';
// Flipping the Electron fuses edits the binary, which invalidates its signature — and arm64 macOS kills unsigned/invalid binaries on launch.
// So the app is ad-hoc signed (no developer identity; Gatekeeper will still say "unidentified developer" on first open).
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== 'darwin') return;
  const app = join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
