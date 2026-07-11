#!/bin/sh
set -e

APK="/app/android/app/build/outputs/apk/debug/app-debug.apk"
ADB="adb -H host.docker.internal -P 5037"

echo ""
echo "=========================================="
echo " CityShield — Install"
echo "=========================================="

# ── 1. Check APK exists ───────────────────────────────────────────────────────
if [ ! -f "$APK" ]; then
  echo ""
  echo "ERROR: APK not found at:"
  echo "  $APK"
  echo ""
  echo "Run 'make build' first to compile the APK."
  exit 1
fi

# ── 2. Connect to host ADB server ─────────────────────────────────────────────
echo ""
echo ">>> Connecting to host ADB server (host.docker.internal:5037)..."
echo "    (Make sure you ran: adb -a nodaemon server start)"
echo ""

$ADB devices

# ── 3. Install ────────────────────────────────────────────────────────────────
echo ""
echo ">>> Installing APK..."
$ADB install "$APK"

echo ""
echo "=========================================="
echo " Installed successfully!"
echo "=========================================="
