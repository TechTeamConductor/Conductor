#!/usr/bin/env node
// Entry point: checks the Node version, then loads the TypeScript CLI (Node strips types natively — no build step).
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`Conductor needs Node.js 22.18 or newer (you have ${process.versions.node}).\nInstall a newer Node (https://nodejs.org or \`nvm install 22\`) and try again.`);
  process.exit(1);
}
await import('../src/cli.ts');
