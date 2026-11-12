#!/usr/bin/env bash
# Starts the CameraView gateway (go2rtc) on macOS or Linux.
# Downloads the go2rtc binary on first run into gateway/bin/.
set -euo pipefail

cd "$(dirname "$0")"
GO2RTC_VERSION="${GO2RTC_VERSION:-latest}"
BIN_DIR="bin"
BIN="$BIN_DIR/go2rtc"

if [ "$GO2RTC_VERSION" = "latest" ]; then
  BASE="https://github.com/AlexxIT/go2rtc/releases/latest/download"
else
  BASE="https://github.com/AlexxIT/go2rtc/releases/download/$GO2RTC_VERSION"
fi

if [ ! -x "$BIN" ]; then
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Linux)
      case "$arch" in
        x86_64|amd64) asset="go2rtc_linux_amd64" ;;
        aarch64|arm64) asset="go2rtc_linux_arm64" ;;
        armv7*|armv8l) asset="go2rtc_linux_arm" ;;
        armv6*) asset="go2rtc_linux_armv6" ;;
        i386|i686) asset="go2rtc_linux_i386" ;;
        *) echo "Unsupported CPU architecture: $arch" >&2; exit 1 ;;
      esac ;;
    Darwin)
      case "$arch" in
        arm64) asset="go2rtc_mac_arm64.zip" ;;
        *) asset="go2rtc_mac_amd64.zip" ;;
      esac ;;
    *) echo "Unsupported OS: $os (on Windows use gateway\\start.ps1)" >&2; exit 1 ;;
  esac

  mkdir -p "$BIN_DIR"
  echo "Downloading $asset ..."
  if [[ "$asset" == *.zip ]]; then
    tmp="$(mktemp -d)"
    curl -fL --progress-bar -o "$tmp/go2rtc.zip" "$BASE/$asset"
    unzip -q -o "$tmp/go2rtc.zip" -d "$tmp"
    mv "$tmp/go2rtc" "$BIN"
    rm -rf "$tmp"
  else
    curl -fL --progress-bar -o "$BIN" "$BASE/$asset"
  fi
  chmod +x "$BIN"
fi

ip="$( (hostname -I 2>/dev/null || ipconfig getifaddr en0 2>/dev/null || true) | awk '{print $1}')"
echo
echo "CameraView gateway starting..."
echo "  On this computer:      http://localhost:1984/"
[ -n "$ip" ] && echo "  From other devices:    http://$ip:1984/"
echo "  Hosted app:            https://aurasscz.github.io/CameraView/  (gateway: http://localhost:1984)"
echo "Press Ctrl+C to stop."
echo
exec "./$BIN" -config go2rtc.yaml
