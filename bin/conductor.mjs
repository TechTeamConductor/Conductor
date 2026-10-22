#!/usr/bin/env node
// Entry point: checks the Node version, then loads the TypeScript CLI (Node strips types natively — no build step).
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`Conductor needs Node.js 22.18 or newer (you have ${process.versions.node}).\nInstall a newer Node (https://nodejs.org or \`nvm install 22\`) and try again.`);
  process.exit(1);
}
// Node refuses to run TypeScript from inside node_modules, so an `npm install -g` / `npx` copy can never work. Say so and point to the installer.
if (/[\\/]node_modules[\\/]/.test(import.meta.url.replace(/%5C/gi, '\\').replace(/%2F/gi, '/'))) {
  console.error('Conductor cannot run from inside a node_modules folder (Node cannot run its TypeScript code there).\nInstall it with the installer instead:\n  macOS / Linux:  curl -fsSL https://github.com/TechTeamConductor/Conductor/releases/latest/download/install.sh | bash\n  Windows:        irm https://github.com/TechTeamConductor/Conductor/releases/latest/download/install.ps1 | iex');
  process.exit(1);
}
await import('../src/cli.ts');
