#!/bin/bash
# Install the Enphase local monitor as a macOS LaunchDaemon.
#
# A LaunchDaemon starts at boot — before anyone logs in — so the monitor
# comes back on its own after a power cycle, with no auto-login required.
# The daemon itself runs as your normal user, not root.
#
#   sudo ./deploy/install-daemon.sh              install (or update) and start
#   sudo ./deploy/install-daemon.sh --uninstall  stop and remove
#   ./deploy/install-daemon.sh --status          show daemon state
#   ./deploy/install-daemon.sh --print-plist     print the generated plist
#
set -euo pipefail

LABEL="com.enphase.localmonitor"
PLIST="/Library/LaunchDaemons/${LABEL}.plist"

# Project root = parent of this script's directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# The user the daemon should run as: whoever invoked sudo, or the current user.
TARGET_USER="${SUDO_USER:-$(id -un)}"

find_node() {
  # Try the target user's login shell first (catches nvm/homebrew setups),
  # then the usual suspects.
  local candidate
  candidate="$(sudo -u "$TARGET_USER" -i sh -lc 'command -v node' 2>/dev/null || true)"
  for candidate in "$candidate" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

generate_plist() {
  local node_path="$1"
  cat <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node_path}</string>
    <string>${PROJECT_DIR}/build-server/server.js</string>
  </array>
  <key>UserName</key><string>${TARGET_USER}</string>
  <key>WorkingDirectory</key><string>${PROJECT_DIR}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${PROJECT_DIR}/monitor.log</string>
  <key>StandardErrorPath</key><string>${PROJECT_DIR}/monitor.log</string>
</dict>
</plist>
PLIST_EOF
}

case "${1:-install}" in
  --print-plist)
    NODE_PATH="$(find_node || echo /usr/local/bin/node)"
    generate_plist "$NODE_PATH"
    ;;

  --status)
    launchctl print "system/${LABEL}" 2>/dev/null | sed -n '1,14p' \
      || echo "${LABEL} is not loaded."
    ;;

  --uninstall)
    if [ "$(id -u)" -ne 0 ]; then
      echo "Run with sudo: sudo $0 --uninstall" >&2
      exit 1
    fi
    launchctl bootout "system/${LABEL}" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed ${LABEL}."
    ;;

  install)
    if [ "$(id -u)" -ne 0 ]; then
      echo "Run with sudo: sudo $0" >&2
      exit 1
    fi
    if ! NODE_PATH="$(find_node)"; then
      echo "Could not find node. Install Node.js 18+ and re-run." >&2
      exit 1
    fi
    if [ ! -f "${PROJECT_DIR}/build-server/server.js" ]; then
      echo "build-server/server.js not found — run 'npm run build' first." >&2
      exit 1
    fi
    if [ ! -f "${PROJECT_DIR}/.enphase_token" ] && [ -z "${ENPHASE_BEARER_TOKEN:-}" ]; then
      echo "note: no .enphase_token yet — the daemon will retry every 30s until you create it."
    fi

    # Replace any existing instance, then install and start.
    launchctl bootout "system/${LABEL}" 2>/dev/null || true
    generate_plist "$NODE_PATH" > "$PLIST"
    chown root:wheel "$PLIST"
    chmod 644 "$PLIST"
    launchctl bootstrap system "$PLIST"
    launchctl enable "system/${LABEL}"

    echo "Installed. The monitor now starts at boot, before login."
    echo "  status:    ./deploy/install-daemon.sh --status"
    echo "  logs:      tail -f ${PROJECT_DIR}/monitor.log"
    echo "  dashboard: http://localhost:8787"
    ;;

  *)
    echo "Usage: sudo $0 [--uninstall] | $0 [--status|--print-plist]" >&2
    exit 1
    ;;
esac
