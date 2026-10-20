#!/usr/bin/env node
// A launcher whose native program is missing (the shape of this machine's Codex install): fails on every invocation, prints nothing on stdout.
process.stderr.write("Error: spawn /usr/local/lib/node_modules/some-cli/node_modules/some-cli-darwin-arm64/vendor/aarch64-apple-darwin/some-cli ENOENT\n");
process.exit(1);
