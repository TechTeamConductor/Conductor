#!/usr/bin/env bash
# Conductor installer for macOS (supported) and Linux (experimental).
#
#   curl -fsSL https://github.com/TechTeamConductor/Conductor/releases/latest/download/install.sh | bash
#
# Then start the dashboard:  conductor start
#
# What it does: finds the latest release, downloads conductor.tgz + SHA256SUMS.txt over HTTPS, verifies the checksum, unpacks the app
# into ~/.conductor-app (NOT inside node_modules: Node cannot run TypeScript from there) and writes a `conductor` launcher into
# ~/.local/bin. It never uses sudo, never edits your shell profile, and never touches your data folder (~/.conductor-v2).
#
#   bash install.sh --uninstall     remove the app and the launcher (your data folder stays)
#   bash install.sh --help
#
# Environment (all optional):
#   CONDUCTOR_INSTALL_VERSION=X.Y.Z   install that release instead of the latest
#   CONDUCTOR_LOCAL_DIR=<dir>         use <dir>/conductor.tgz and <dir>/SHA256SUMS.txt instead of downloading (still verified)
#   CONDUCTOR_INSTALL_DIR, CONDUCTOR_BIN_DIR   where the app / launcher go (defaults: ~/.conductor-app, ~/.local/bin)
#   CONDUCTOR_ALLOW_ROOT=1            allow running as root (not recommended)
#
# The whole script is one function called on the last line, so a truncated download runs nothing.

REPO="TechTeamConductor/Conductor"
SHIM_MARKER="# conductor-installer-shim v1"
APP_MARKER=".conductor-installer"
SEMVER_RE='^[0-9]+\.[0-9]+\.[0-9]+$'
TAG_RE='^v[0-9]+\.[0-9]+\.[0-9]+$'

say() { printf '%s\n' "$*"; }
die() { printf 'Conductor installer: %s\n' "$*" >&2; exit 1; }

# the release tag from the final URL of the /releases/latest redirect (…/releases/tag/vX.Y.Z), or fail
tag_from_url() {
  local url="$1" tag
  case "$url" in
    https://github.com/"$REPO"/releases/tag/*) tag="${url##*/}" ;;
    *) return 1 ;;
  esac
  [[ "$tag" =~ $TAG_RE ]] || return 1
  printf '%s' "$tag"
}

valid_version() { [[ "$1" =~ $SEMVER_RE ]]; }

# an absolute path with nothing that could break out of the single-quoted launcher or the printed hints (non-ASCII names and spaces are fine)
safe_path() {
  case "$1" in /*) ;; *) return 1 ;; esac
  case "$1" in *\'*|*\"*|*\$*|*\`*|*\\*|*$'\n'*|*$'\r'*) return 1 ;; esac
  return 0
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else die "need sha256sum or shasum to verify the download"
  fi
}

# the expected SHA-256 of conductor.tgz from SHA256SUMS.txt: exactly one "<64 lowercase hex>  conductor.tgz" line (CR tolerated)
expected_sha() {
  local sums="$1" lines count
  lines="$(tr -d '\r' < "$sums" | grep -E '^[0-9a-f]{64}  conductor\.tgz$' || true)"
  if [ -z "$lines" ]; then count=0; else count="$(printf '%s\n' "$lines" | wc -l | tr -d ' ')"; fi
  [ "$count" = "1" ] || return 1
  printf '%s' "${lines%%  *}"
}

check_node() {
  command -v node >/dev/null 2>&1 || die "Node.js 22.18 or newer is required but 'node' was not found. Install it from https://nodejs.org (or: brew install node), then run this again."
  local v major minor
  v="$(node -p 'process.versions.node' 2>/dev/null || true)"
  [[ "$v" =~ ^([0-9]+)\.([0-9]+)\. ]] || die "could not read the Node.js version"
  major="${BASH_REMATCH[1]}"; minor="${BASH_REMATCH[2]}"
  if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 18 ]; }; then
    die "Node.js 22.18 or newer is required (you have $v). Install a newer Node from https://nodejs.org (or: nvm install 22), then run this again."
  fi
}

fetch() { # fetch <url> <dest>
  command -v curl >/dev/null 2>&1 || die "curl is required"
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --retry 2 -o "$2" "$1" || die "download failed: $1"
}

check_tar_listing() { # reject unsafe entries BEFORE extracting
  local tgz="$1" name kinds
  while IFS= read -r name; do
    case "$name" in
      /*|*..*|*\\*) die "unsafe path in the archive: $name" ;;
      package/*|package) ;;
      *) die "unexpected entry in the archive: $name" ;;
    esac
    case "$name" in */../*|../*|*/..) die "unsafe path in the archive: $name" ;; esac
  done < <(tar -tzf "$tgz")
  kinds="$(tar -tvzf "$tgz" | cut -c1 | sort -u | tr -d '\n')"
  case "$kinds" in
    -|d|-d|d-) ;;
    *) die "the archive contains links or special files, refusing to unpack it" ;;
  esac
}

uninstall() {
  local app="$1" bin="$2" removed=0
  if [ -f "$bin/conductor" ] && grep -q "^$SHIM_MARKER\$" "$bin/conductor" 2>/dev/null; then rm -f "$bin/conductor"; say "Removed the launcher $bin/conductor"; removed=1; fi
  if [ -L "$app" ]; then say "Left $app alone: it is a symlink."
  elif [ -d "$app" ] && [ -f "$app/$APP_MARKER" ]; then rm -rf "$app"; say "Removed the app $app"; removed=1; fi
  [ -d "$app" ] && [ ! -f "$app/$APP_MARKER" ] && say "Left $app alone: it was not created by this installer."
  [ "$removed" = 1 ] || say "Nothing to remove."
  say "Your data folder (${CONDUCTOR_HOME:-$HOME/.conductor-v2}) was not touched. Delete it yourself if you also want your boards and settings gone."
}

main() {
  set -euo pipefail
  umask 022

  local mode="install"
  case "${1:-}" in
    --uninstall) mode="uninstall" ;;
    --help|-h) sed -n '2,22p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || true; return 0 ;;
    "") ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac

  if [ "$(id -u)" = "0" ] && [ "${CONDUCTOR_ALLOW_ROOT:-}" != "1" ]; then
    die "do not run this as root (it installs into your home folder). Set CONDUCTOR_ALLOW_ROOT=1 to override."
  fi

  local platform
  case "$(uname -s)" in
    Darwin) platform="macos" ;;
    Linux) platform="linux" ;;
    MINGW*|MSYS*|CYGWIN*) die "this is the macOS/Linux installer. On Windows use PowerShell: irm https://github.com/$REPO/releases/latest/download/install.ps1 | iex" ;;
    *) die "unsupported system: $(uname -s)" ;;
  esac

  [ -n "${HOME:-}" ] || die "HOME is not set"
  local app="${CONDUCTOR_INSTALL_DIR:-$HOME/.conductor-app}" bin="${CONDUCTOR_BIN_DIR:-$HOME/.local/bin}"
  safe_path "$app" || die "the install folder has unsupported characters (it must be an absolute path without quotes, \$, backticks, backslashes or line breaks): $app"
  safe_path "$bin" || die "the launcher folder has unsupported characters (it must be an absolute path without quotes, \$, backticks, backslashes or line breaks): $bin"
  app="${app%/}"; bin="${bin%/}"
  if [ -z "$app" ] || [ -z "$bin" ]; then die "the install and launcher folders must not be the root folder"; fi

  if [ "$mode" = "uninstall" ]; then uninstall "$app" "$bin"; return 0; fi

  # the requested version is validated first, before anything else happens
  local want=""
  if [ -n "${CONDUCTOR_INSTALL_VERSION+x}" ]; then
    valid_version "$CONDUCTOR_INSTALL_VERSION" || die "CONDUCTOR_INSTALL_VERSION must look like 1.2.3"
    want="$CONDUCTOR_INSTALL_VERSION"
  fi

  check_node

  # never overwrite something this installer did not create
  if [ -e "$bin/conductor" ] && ! grep -q "^$SHIM_MARKER\$" "$bin/conductor" 2>/dev/null; then
    die "another 'conductor' already exists at $bin/conductor and was not created by this installer. Move it away and run this again."
  fi
  if [ -L "$app" ]; then die "$app is a symlink, refusing to touch it"; fi
  if [ -e "$app" ] && [ ! -f "$app/$APP_MARKER" ]; then
    die "$app already exists and was not created by this installer. Move it away (or set CONDUCTOR_INSTALL_DIR) and run this again."
  fi

  local parent; parent="$(dirname "$app")"
  mkdir -p "$parent" "$bin"
  local lock="$parent/.conductor-install.lock"
  mkdir "$lock" 2>/dev/null || die "another install seems to be running (or crashed). If not, remove $lock and run this again."
  # globals: the EXIT trap runs after main has returned, when its locals are gone
  LOCK_DIR="$lock"
  trap 'rm -rf "${LOCK_DIR:-}" "${WORK_DIR:-}"' EXIT
  WORK_DIR="$(mktemp -d "$parent/.conductor-install.XXXXXX")"
  local work="$WORK_DIR"

  local tag=""
  if [ -n "${CONDUCTOR_LOCAL_DIR:-}" ]; then
    if [ ! -f "$CONDUCTOR_LOCAL_DIR/conductor.tgz" ] || [ ! -f "$CONDUCTOR_LOCAL_DIR/SHA256SUMS.txt" ]; then die "CONDUCTOR_LOCAL_DIR must hold conductor.tgz and SHA256SUMS.txt"; fi
    say "Installing from the local folder $CONDUCTOR_LOCAL_DIR: its SHA256SUMS.txt only catches corruption, it does not prove where the files came from."
    cp "$CONDUCTOR_LOCAL_DIR/conductor.tgz" "$work/conductor.tgz"
    cp "$CONDUCTOR_LOCAL_DIR/SHA256SUMS.txt" "$work/SHA256SUMS.txt"
    [ -z "$want" ] || tag="v$want"
  else
    if [ -n "$want" ]; then tag="v$want"; else
      command -v curl >/dev/null 2>&1 || die "curl is required"
      local final
      final="$(curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --head --retry 2 -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")" || die "could not look up the latest release"
      tag="$(tag_from_url "$final")" || die "could not find the latest release (is there a published release yet?)"
    fi
    say "Installing Conductor $tag …"
    fetch "https://github.com/$REPO/releases/download/$tag/conductor.tgz" "$work/conductor.tgz"
    fetch "https://github.com/$REPO/releases/download/$tag/SHA256SUMS.txt" "$work/SHA256SUMS.txt"
  fi

  # verify BEFORE unpacking anything
  local expect actual
  expect="$(expected_sha "$work/SHA256SUMS.txt")" || die "SHA256SUMS.txt has no single valid line for conductor.tgz, refusing to install"
  actual="$(sha256_of "$work/conductor.tgz")"
  [ "$expect" = "$actual" ] || die "checksum mismatch for conductor.tgz (expected $expect, got $actual). Nothing was installed."

  check_tar_listing "$work/conductor.tgz"
  mkdir "$work/extract"
  tar -xzf "$work/conductor.tgz" -C "$work/extract" --strip-components=1 --no-same-owner
  if [ -n "$(find "$work/extract" ! -type f ! -type d -print -quit)" ]; then die "the archive contained links or special files, refusing to install"; fi

  local info version
  info="$(node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(p.name+" "+p.version)' "$work/extract/package.json" 2>/dev/null || true)"
  [ "${info%% *}" = "conductor" ] || die "the archive is not a Conductor package"
  version="${info#* }"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]*[0-9A-Za-z])?$ ]] || die "the archive has an invalid version: $version"
  [ -z "$tag" ] || [ "v$version" = "$tag" ] || die "the archive is version $version but release $tag was requested"
  [ -f "$work/extract/bin/conductor.mjs" ] || die "the archive is missing bin/conductor.mjs"
  : > "$work/extract/$APP_MARKER"

  # a running Conductor keeps its files open on some systems: ask the user to quit it first
  if [ -S "${CONDUCTOR_HOME:-$HOME/.conductor-v2}/run/control.sock" ]; then say "Note: Conductor looks like it is running. Quit it (Ctrl+C) and re-run \`conductor start\` after the update."; fi

  # swap with rollback
  rm -rf "$app.old"
  [ ! -d "$app" ] || mv "$app" "$app.old"
  if ! mv "$work/extract" "$app"; then
    [ ! -d "$app.old" ] || mv "$app.old" "$app"
    die "could not move the new version into place"
  fi
  local got
  got="$(node "$app/bin/conductor.mjs" version 2>/dev/null || true)"
  if [ "$got" != "$version" ]; then
    rm -rf "$app"
    [ ! -d "$app.old" ] || mv "$app.old" "$app"
    die "the new version failed its self-check (got '$got', expected '$version'); the previous install was restored"
  fi

  # the launcher: quoted absolute path, a marker so only this installer ever replaces or removes it
  local tmpshim="$bin/.conductor.$$"
  {
    printf '#!/bin/sh\n%s\n' "$SHIM_MARKER"
    printf 'command -v node >/dev/null 2>&1 || { echo "Conductor needs Node.js 22.18 or newer on your PATH (https://nodejs.org)." >&2; exit 1; }\n'
    printf "exec node '%s/bin/conductor.mjs' \"\$@\"\n" "$app"
  } > "$tmpshim"
  chmod 755 "$tmpshim"
  mv -f "$tmpshim" "$bin/conductor"
  rm -rf "$app.old"

  say ""
  say "Conductor $version is installed."
  say "  app:       $app"
  say "  launcher:  $bin/conductor"
  case ":$PATH:" in
    *":$bin:"*) say ""; say "Start it:   conductor start" ;;
    *)
      say ""
      say "$bin is not on your PATH yet. Either run it by full path:"
      say "  $bin/conductor start"
      say "or add it to your PATH (zsh example), then open a new terminal:"
      say "  echo 'export PATH=\"$bin:\$PATH\"' >> ~/.zshrc"
      ;;
  esac
  say "Try it without any keys first:   conductor demo"
  say "Check your setup:               conductor doctor"
  say "Update later:                   run the install command again"
  if [ "$platform" = "linux" ]; then
    say ""
    say "Note: Linux support is experimental. The dashboard runs, but the full build flow is only tested on macOS."
  fi
  return 0
}

if [ "${CONDUCTOR_INSTALLER_NO_MAIN:-}" != "1" ]; then main "$@"; fi
