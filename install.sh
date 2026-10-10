#!/bin/sh
#
# Bootstrap claude-openrouter on a macOS or Linux machine that may have nothing
# installed.
#
# setup.js is a Node program, so it cannot install Node for itself. This script
# can. It installs Node if it is missing or too old, downloads setup.js, and
# runs it.
#
#   curl -fsSL https://raw.githubusercontent.com/djerok/claude-openrouter/main/install.sh | sh -s -- --key sk-or-v1-...
#
# Every argument after `--` is forwarded to setup.js, so --status, --off and
# --on work the same way.
#
# Deliberately POSIX sh, not bash: some minimal containers and Alpine images
# have no bash, and this is the one script that has to run before anything is
# set up.

set -eu

MIN_NODE=18
RAW_BASE="https://raw.githubusercontent.com/djerok/claude-openrouter/main"

if [ -t 1 ]; then
  R=$(printf '\033[31m'); G=$(printf '\033[32m'); Y=$(printf '\033[33m')
  B=$(printf '\033[36m'); D=$(printf '\033[2m');  N=$(printf '\033[0m')
else
  R=''; G=''; Y=''; B=''; D=''; N=''
fi

step() { printf '%s[*]%s %s\n' "$B" "$N" "$1"; }
ok()   { printf '    %sok%s   %s\n' "$G" "$N" "$1"; }
warn() { printf '    %swarn%s %s\n' "$Y" "$N" "$1"; }
note() { printf '    %s%s%s\n' "$D" "$1" "$N"; }
fail() {
  printf '\n%sfatal:%s %s\n' "$R" "$N" "$1" >&2
  [ $# -gt 1 ] && printf '%s%s%s\n' "$D" "$2" "$N" >&2
  exit 1
}

has() { command -v "$1" >/dev/null 2>&1; }

# Truth comes from running node, never from a package manager's exit code.
node_major() {
  has node || { echo 0; return; }
  v=$(node --version 2>/dev/null || echo '')
  case "$v" in
    v*) echo "$v" | sed 's/^v\([0-9]*\)\..*/\1/' ;;
    *)  echo 0 ;;
  esac
}

fetch() {
  if has curl; then curl -fsSL "$1" -o "$2"
  elif has wget; then wget -qO "$2" "$1"
  else fail "Neither curl nor wget is installed." "Install one of them, then re-run."
  fi
}

# Node is installed from the official tarball rather than through nvm.
# nvm must be sourced into a shell it supports and wants to read from stdin,
# and this script is itself running under `sh` with stdin attached to a curl
# pipe — which is exactly why the nvm route failed on a clean Mac. A tarball
# needs no shell integration, no sudo and no stdin.
NODE_PREFIX="$HOME/.local/node"
NODE_MARK_BEGIN="# >>> claude-openrouter: node on PATH >>>"
NODE_MARK_END="# <<< claude-openrouter <<<"

node_platform() {
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux)  os=linux ;;
    *) return 1 ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch=arm64 ;;
    x86_64|amd64)  arch=x64 ;;
    armv7l)        arch=armv7l ;;
    *) return 1 ;;
  esac
  echo "${os}-${arch}"
}

# index.tab is the machine-readable version of the release index: columns are
# version, date, ..., lts. The first row whose lts column is not "-" is the
# current LTS. Parsing this avoids needing jq, python or node itself.
latest_lts() {
  tab=$(mktemp /tmp/node-index.XXXXXX)
  fetch 'https://nodejs.org/dist/index.tab' "$tab" || { rm -f "$tab"; return 1; }
  v=$(awk 'NR>1 && $10 != "-" { print $1; exit }' "$tab")
  rm -f "$tab"
  [ -n "$v" ] || return 1
  echo "$v"
}

persist_node_path() {
  bin="$1"
  case "$SHELL" in
    *zsh) rc="$HOME/.zshrc" ;;
    *bash) rc="$HOME/.bashrc" ;;
    *) [ "$(uname -s)" = "Darwin" ] && rc="$HOME/.zshrc" || rc="$HOME/.profile" ;;
  esac
  [ -f "$rc" ] || : > "$rc"
  if ! grep -q "claude-openrouter: node on PATH" "$rc" 2>/dev/null; then
    {
      printf '
%s
' "$NODE_MARK_BEGIN"
      printf 'export PATH="%s:$PATH"
' "$bin"
      printf '%s
' "$NODE_MARK_END"
    } >> "$rc"
    note "added Node to your PATH in $rc"
  fi
}

install_node_tarball() {
  plat=$(node_platform) || {
    warn "unsupported platform $(uname -s)/$(uname -m) for the official tarball"
    return 1
  }
  ver=$(latest_lts) || { warn 'could not read the Node release index'; return 1; }
  note "installing Node $ver ($plat) into $NODE_PREFIX"

  url="https://nodejs.org/dist/$ver/node-$ver-$plat.tar.gz"
  tgz=$(mktemp /tmp/node.XXXXXX.tar.gz)
  fetch "$url" "$tgz" || { rm -f "$tgz"; warn "download failed: $url"; return 1; }

  # Verify by bytes. A proxy or captive portal serving an HTML error page is
  # otherwise indistinguishable from a successful download.
  size=$(wc -c < "$tgz" | tr -d ' ')
  if [ "$size" -lt 5000000 ]; then
    rm -f "$tgz"
    warn "the download was only $size bytes — truncated or intercepted"
    return 1
  fi

  mkdir -p "$NODE_PREFIX"
  tar -xzf "$tgz" -C "$NODE_PREFIX" --strip-components=1 || {
    rm -f "$tgz"; warn 'could not unpack the Node tarball'; return 1
  }
  rm -f "$tgz"

  [ -x "$NODE_PREFIX/bin/node" ] || { warn 'unpacked, but no node binary found'; return 1; }
  PATH="$NODE_PREFIX/bin:$PATH"
  export PATH
  persist_node_path "$NODE_PREFIX/bin"
  return 0
}

install_node() {
  step 'Installing Node.js'

  # Homebrew first when it is already there: it is quick and keeps Node under
  # the package manager the user already uses.
  if [ "$(uname -s)" = "Darwin" ] && has brew; then
    note 'installing Node via Homebrew'
    brew install node >/dev/null 2>&1 || warn 'brew install node reported a problem'
    [ "$(node_major)" -ge "$MIN_NODE" ] && return 0
    warn 'Homebrew did not produce a usable Node — falling back to the official tarball'
  fi

  install_node_tarball && [ "$(node_major)" -ge "$MIN_NODE" ] && return 0

  # Last resort on Linux: the distro package. Often too old, hence last.
  if [ "$(uname -s)" = "Linux" ]; then
    warn 'falling back to the system package manager'
    if has apt-get;  then sudo apt-get update -qq && sudo apt-get install -y nodejs npm >/dev/null 2>&1 || true
    elif has dnf;    then sudo dnf install -y nodejs npm >/dev/null 2>&1 || true
    elif has yum;    then sudo yum install -y nodejs npm >/dev/null 2>&1 || true
    elif has pacman; then sudo pacman -Sy --noconfirm nodejs npm >/dev/null 2>&1 || true
    elif has apk;    then sudo apk add --no-cache nodejs npm >/dev/null 2>&1 || true
    elif has zypper; then sudo zypper install -y nodejs npm >/dev/null 2>&1 || true
    fi
  fi
  return 0
}

# --- Node -------------------------------------------------------------------

step 'Checking Node.js'
major=$(node_major)

if [ "$major" -ge "$MIN_NODE" ]; then
  ok "node $(node --version)"
else
  if [ "$major" -gt 0 ]; then
    warn "node $(node --version) is older than v$MIN_NODE — upgrading"
  else
    warn 'node not found'
  fi

  install_node
  major=$(node_major)

  if [ "$major" -lt "$MIN_NODE" ]; then
    fail 'Node still is not usable after trying to install it.' \
"Two things usually cause this:
  1. Node installed into a shell profile this script cannot see. Close this terminal,
     open a new one, and run the command again.
  2. Your distribution ships a version older than $MIN_NODE. Install a current one from
     https://nodejs.org or with nvm (https://github.com/nvm-sh/nvm), then re-run."
  fi
  ok "node $(node --version)"
fi

# --- npm --------------------------------------------------------------------

step 'Checking npm'
if ! has npm; then
  fail 'npm is missing even though Node is installed.' \
"On Debian/Ubuntu the nodejs package sometimes omits it:
  sudo apt-get install -y npm
Otherwise reinstall Node from https://nodejs.org, then re-run."
fi
ok "npm $(npm --version)"

# --- setup.js ---------------------------------------------------------------

step 'Downloading setup.js'
SETUP=$(mktemp /tmp/claude-openrouter-setup.XXXXXX.js)
trap 'rm -f "$SETUP"' EXIT INT TERM
fetch "$RAW_BASE/setup.js" "$SETUP" \
  || fail 'Could not download setup.js.' 'Check your network or proxy, then re-run.'

# A captive portal or proxy returning an HTML error page is the classic silent
# failure here, so inspect what actually arrived rather than trusting the fetch.
size=$(wc -c < "$SETUP" | tr -d ' ')
if [ "$size" -lt 5000 ] || ! head -n 1 "$SETUP" | grep -q node; then
  fail 'What downloaded is not setup.js.' \
    'Something on your network replaced the file. Try a different connection, or clone the repository manually.'
fi
ok "$((size / 1024)) KB"

# --- run --------------------------------------------------------------------

step 'Running setup'
echo
# Under `curl ... | sh`, standard input is the pipe this script arrived on, and
# setup.js hands it on to the Claude Code it starts at the end -- which needs a
# terminal to read keys from, and stops with "Raw mode is not supported" when it
# gets a pipe. Give it the terminal instead whenever there is one to open.
if [ ! -t 0 ] && (exec < /dev/tty) 2>/dev/null; then
  node "$SETUP" "$@" < /dev/tty
else
  node "$SETUP" "$@"
fi
