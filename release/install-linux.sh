#!/usr/bin/env sh
# CFLS client installer for Linux.
#
# Place this file beside the matching standalone binary downloaded from the
# CFLS release page (`cfls-linux-x64` or `cfls-linux-arm64`), then run:
#
#   chmod +x install-linux.sh
#   ./install-linux.sh --workspace /path/to/repo --name alice --invite '<code>'
#
# It installs only for the current user. With an invitation, it also configures
# the deployed CFLS relay and starts the per-user systemd agent automatically.

set -eu

DEFAULT_ENDPOINT="wss://sync.cfls.cyberkunju.com"
DEFAULT_TEAM="cyberkunju-cfls"

usage() {
  cat <<'EOF'
Usage: ./install-linux.sh [options]

Install the standalone CFLS client for the current user. If --workspace and
--invite are supplied, the installer also joins the live CFLS relay and starts
the background agent for that repository.

Options:
  --workspace PATH       Checked-out repository to coordinate
  --name NAME            Display name for this computer/member
  --team ID              Team id (default: cyberkunju-cfls)
  --invite CODE          Signed invitation supplied by the team admin
  --endpoint WSS_URL     Relay URL (default: wss://sync.cfls.cyberkunju.com)
  --binary PATH          Standalone binary to install (normally auto-detected)
  --install-dir PATH     Destination directory (default: ~/.local/bin)
  --no-service           Configure the workspace but do not start systemd
  --help                 Show this help

Environment equivalents: CFLS_ENDPOINT, CFLS_TEAM_ID, CFLS_INVITATION,
CFLS_BINARY, and CFLS_INSTALL_DIR.

An invitation is device-specific. Without one, CFLS is installed and the relay
is saved for the workspace, but no agent service is started.
EOF
}

die() {
  printf '%s\n' "CFLS installer: $*" >&2
  exit 1
}

note() {
  printf '%s\n' "CFLS installer: $*"
}

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WORKSPACE=""
MEMBER_NAME=""
TEAM_ID=${CFLS_TEAM_ID:-$DEFAULT_TEAM}
ENDPOINT=${CFLS_ENDPOINT:-$DEFAULT_ENDPOINT}
INVITATION=${CFLS_INVITATION:-}
INSTALL_DIR=${CFLS_INSTALL_DIR:-"$HOME/.local/bin"}
BINARY=${CFLS_BINARY:-}
START_SERVICE=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --workspace|--name|--team|--invite|--endpoint|--binary|--install-dir)
      [ "$#" -ge 2 ] || die "missing value for $1"
      case "$1" in
        --workspace) WORKSPACE=$2 ;;
        --name) MEMBER_NAME=$2 ;;
        --team) TEAM_ID=$2 ;;
        --invite) INVITATION=$2 ;;
        --endpoint) ENDPOINT=$2 ;;
        --binary) BINARY=$2 ;;
        --install-dir) INSTALL_DIR=$2 ;;
      esac
      shift 2
      ;;
    --no-service)
      START_SERVICE=0
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1 (run with --help)"
      ;;
  esac
done

case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "unsupported CPU architecture: $(uname -m); download a matching CFLS binary" ;;
esac

if [ -z "$BINARY" ]; then
  BINARY="$SCRIPT_DIR/cfls-linux-$ARCH"
fi

[ -f "$BINARY" ] || die "standalone binary not found: $BINARY"
[ -r "$BINARY" ] || die "standalone binary is not readable: $BINARY"

case "$ENDPOINT" in
  wss://*) ;;
  *) die "--endpoint must use wss:// (got: $ENDPOINT)" ;;
esac

mkdir -p "$INSTALL_DIR"
DESTINATION="$INSTALL_DIR/cfls"
install -m 0755 "$BINARY" "$DESTINATION"
note "installed $DESTINATION"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) note "add $INSTALL_DIR to PATH to run 'cfls' from any terminal" ;;
esac

if [ -z "$WORKSPACE" ]; then
  note "binary installation complete. Open your project in VS Code, install the CFLS extension, then click the CFLS status item to pair this computer."
  exit 0
fi

[ -d "$WORKSPACE" ] || die "workspace is not a directory: $WORKSPACE"
WORKSPACE=$(CDPATH= cd -- "$WORKSPACE" && pwd)

# `join` and `connect` intentionally use the repository's local coordination
# directory, so run them from the requested workspace. Do not use eval for
# argument construction: member names and filesystem paths can contain spaces.
if [ -n "$MEMBER_NAME" ]; then
  (
    cd "$WORKSPACE"
    "$DESTINATION" join --host "$ENDPOINT" --team "$TEAM_ID" --name "$MEMBER_NAME"
  )
else
  (
    cd "$WORKSPACE"
    "$DESTINATION" join --host "$ENDPOINT" --team "$TEAM_ID"
  )
fi

if [ -z "$INVITATION" ]; then
  note "relay configuration was saved. For the easy demo flow, open this folder in VS Code and use CFLS: Set Up This Workspace (Demo Pairing)."
  exit 0
fi

(
  cd "$WORKSPACE"
  "$DESTINATION" connect "$INVITATION"
)

if [ "$START_SERVICE" -eq 0 ]; then
  note "relay and invitation configured. Start manually with: $DESTINATION agent"
  exit 0
fi

"$DESTINATION" service install --workspace "$WORKSPACE"
"$DESTINATION" service status --workspace "$WORKSPACE" || true
note "ready: the CFLS agent starts automatically for $WORKSPACE and connects to $ENDPOINT"
