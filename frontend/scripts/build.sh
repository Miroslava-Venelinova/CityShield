#!/bin/sh
set -e

MANIFEST="/app/android/app/src/main/AndroidManifest.xml"
ROOT_GRADLE="/app/android/build.gradle"
APP_GRADLE="/app/android/app/build.gradle"

# Comma-separated ABI list. Empty means "whatever android/gradle.properties
# says", which is all four. Narrowing it is the single biggest build-time lever
# we have: newArchEnabled=true compiles React Native's C++ from source once per
# ABI, so arm64-v8a alone is roughly a quarter of the native work. The cost is
# that the APK then only installs on matching devices — arm64-v8a covers modern
# phones but not x86_64 emulators.
ABIS="${ABIS:-}"

# debug   — no JS bundle in the APK; the app pulls it from Metro over adb reverse.
# release — Hermes bundle baked in, so the APK runs standalone with no dev server.
BUILD_TYPE="${BUILD_TYPE:-debug}"
case "$BUILD_TYPE" in
  debug)
    GRADLE_TASK="assembleDebug"
    APK_FINAL="/app/android/app/build/outputs/apk/debug/app-debug.apk"
    ;;
  release)
    GRADLE_TASK="assembleRelease"
    APK_FINAL="/app/android/app/build/outputs/apk/release/app-release.apk"
    ;;
  *)
    echo "ERROR: BUILD_TYPE must be 'debug' or 'release', got '$BUILD_TYPE'." >&2
    exit 1
    ;;
esac

# The app's Android package name. It used to be read out of google-services.json;
# push now goes through OneSignal, which carries no per-app file in the build, so
# it is declared here instead. It must match the package registered in the
# OneSignal dashboard, or devices subscribe and never receive anything.
PACKAGE_NAME="${PACKAGE_NAME:-com.cityshield.fcmtest}"

echo ""
echo "=========================================="
echo " CityShield — Build ($BUILD_TYPE)"
echo "=========================================="

# src/config.ts throws at startup if either of these is missing from a release
# bundle. Check here too: the same failure costs one second now instead of a
# full Gradle run followed by an app that dies on its first screen.
if [ "$BUILD_TYPE" = "release" ]; then
  missing=""
  [ -z "$CITYSHIELD_API_URL" ] && missing="$missing CITYSHIELD_API_URL"
  [ -z "$ONESIGNAL_APP_ID" ]   && missing="$missing ONESIGNAL_APP_ID"
  if [ -n "$missing" ]; then
    echo "ERROR: release build is missing:$missing" >&2
    echo "       Pass them through docker-compose, e.g." >&2
    echo "       CITYSHIELD_API_URL=https://... ONESIGNAL_APP_ID=... make release" >&2
    exit 1
  fi
  case "$CITYSHIELD_API_URL" in
    https://*) ;;
    *) echo "ERROR: CITYSHIELD_API_URL must be HTTPS ('$CITYSHIELD_API_URL')." >&2
       echo "       Release builds block cleartext HTTP to anything but 10.0.2.2." >&2
       exit 1 ;;
  esac
  echo ">>> API:       $CITYSHIELD_API_URL"
  echo ">>> OneSignal: $ONESIGNAL_APP_ID"
fi

# ── 1. JS deps ────────────────────────────────────────────────────────────────
echo ">>> Installing JS dependencies..."
cd /app
npm install --legacy-peer-deps --silent

# React Native caches autolinking results under android/build, keyed only on the
# package.json hashes — not on where the build ran. A host (build-apk.bat) build
# leaves behind C:\... project paths that mean nothing in here, and Gradle then
# fails with "No variants exist" for every autolinked library. Drop the cache
# whenever it was generated outside this container.
AUTOLINK=/app/android/build/generated/autolinking
if [ -f "$AUTOLINK/autolinking.json" ] && ! grep -q '"root": "/app"' "$AUTOLINK/autolinking.json"; then
  echo ">>> Clearing an autolinking cache from a host build..."
  rm -rf "$AUTOLINK"
fi

# ── 2. Scaffold android/ on first run ─────────────────────────────────────────
if [ ! -f /app/android/gradlew ]; then
  echo ">>> First run: scaffolding Android project (~2 min)..."
  npx --yes @react-native-community/cli@15 init CityShieldScaffold \
    --skip-install \
    --directory /tmp/rn-scaffold \
    --title CityShield
  cp -rn /tmp/rn-scaffold/android/. /app/android/
  rm -rf /tmp/rn-scaffold
  echo ">>> Scaffold complete."
fi

# ── 3. Patch the Android package name onto the scaffold ───────────────────────
echo ">>> Patching Android package name to $PACKAGE_NAME..."
python3 << PYEOF
import os, re, sys

pkg     = "$PACKAGE_NAME"
old_pkg = "com.cityshieldscaffold"

files_to_patch = [
    "/app/android/app/build.gradle",
    "/app/android/app/src/main/AndroidManifest.xml",
    "/app/android/app/src/main/java/com/cityshieldscaffold/MainActivity.kt",
    "/app/android/app/src/main/java/com/cityshieldscaffold/MainApplication.kt",
    "/app/android/app/src/debug/java/com/cityshieldscaffold/ReactNativeFlipper.java",
]

patched = []
for path in files_to_patch:
    if not os.path.exists(path):
        continue
    content = open(path).read()
    if old_pkg in content:
        open(path, "w").write(content.replace(old_pkg, pkg))
        patched.append(path)

# Rename java source directories if needed
old_dir = "/app/android/app/src/main/java/" + old_pkg.replace(".", "/")
new_dir = "/app/android/app/src/main/java/" + pkg.replace(".", "/")
if os.path.exists(old_dir) and old_dir != new_dir:
    os.makedirs(os.path.dirname(new_dir), exist_ok=True)
    os.rename(old_dir, new_dir)
    patched.append(f"renamed {old_dir} -> {new_dir}")

if patched:
    for p in patched:
        print(f"    -> {p}")
else:
    print("    -> Already using correct package name, skipping.")
PYEOF

# ── 4. Strip the Google Services plugin from older scaffolds ──────────────────
# The OneSignal SDK does its own FCM registration from credentials held in the
# OneSignal dashboard, so the app needs neither the plugin nor a
# google-services.json. A container reusing an android/ dir that earlier builds
# patched would otherwise fail on the missing file.
echo ">>> Removing obsolete Google Services configuration..."
if grep -q "google-services" "$ROOT_GRADLE"; then
  sed -i '/com.google.gms:google-services/d' "$ROOT_GRADLE"
  echo "    -> Root build.gradle: classpath removed."
fi
if grep -q "com.google.gms.google-services" "$APP_GRADLE"; then
  sed -i "/apply plugin: 'com.google.gms.google-services'/d" "$APP_GRADLE"
  echo "    -> app/build.gradle: plugin removed."
fi
rm -f /app/android/app/google-services.json

# ── 5. Write network_security_config.xml ──────────────────────────────────────
echo ">>> Writing network_security_config.xml..."
mkdir -p /app/android/app/src/main/res/xml
cat > /app/android/app/src/main/res/xml/network_security_config.xml << 'XMLEOF'
<?xml version="1.0" encoding="utf-8"?>
<!--
  Allows plain HTTP to the local dev API server (10.0.2.2 = emulator localhost).
  OSM tile servers use HTTPS and are listed explicitly for clarity.
  Remove the 10.0.2.2 entry before releasing to production.
-->
<network-security-config>
  <!-- Local dev API (HTTP allowed) -->
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">10.0.2.2</domain>
  </domain-config>
  <!-- OpenStreetMap tile servers (HTTPS only) -->
  <domain-config cleartextTrafficPermitted="false">
    <domain includeSubdomains="true">openstreetmap.org</domain>
    <domain includeSubdomains="true">tile.openstreetmap.org</domain>
  </domain-config>
</network-security-config>
XMLEOF

# ── 6. Clean up obsolete react-native-maps configuration ──────────────────────
# The map is now Leaflet + OpenStreetMap inside react-native-webview, so the
# Google Maps SDK is no longer part of the build. Remove leftovers that older
# builds may have written.
echo ">>> Cleaning up obsolete Google Maps configuration..."

GRADLE_PROPS="/app/android/gradle.properties"
if grep -q "REACT_NATIVE_MAPS_PROVIDER" "$GRADLE_PROPS" 2>/dev/null; then
  sed -i '/REACT_NATIVE_MAPS_PROVIDER/d; /react-native-maps: OSM\/default provider/d' "$GRADLE_PROPS"
  echo "    -> gradle.properties: removed obsolete REACT_NATIVE_MAPS_PROVIDER flag."
fi

# ── 7. Patch AndroidManifest.xml ──────────────────────────────────────────────
echo ">>> Patching AndroidManifest.xml..."
python3 << 'PYEOF'
import xml.etree.ElementTree as ET, sys

path = "/app/android/app/src/main/AndroidManifest.xml"
ET.register_namespace("android", "http://schemas.android.com/apk/res/android")
ET.register_namespace("tools",   "http://schemas.android.com/tools")

tree = ET.parse(path)
root = tree.getroot()
NS   = "http://schemas.android.com/apk/res/android"

app_el = root.find("application")
if app_el is None:
    print("ERROR: <application> not found"); sys.exit(1)

changed = False
nsc_key  = f"{{{NS}}}networkSecurityConfig"
ctxt_key = f"{{{NS}}}usesCleartextTraffic"
name_key = f"{{{NS}}}name"

if app_el.get(nsc_key) is None:
    app_el.set(nsc_key, "@xml/network_security_config"); changed = True
if app_el.get(ctxt_key) is None:
    app_el.set(ctxt_key, "true"); changed = True

perm_name = "android.permission.POST_NOTIFICATIONS"
existing  = [el.get(name_key) for el in root.findall("uses-permission")]
if perm_name not in existing:
    el = ET.Element("uses-permission")
    el.set(name_key, perm_name)
    root.insert(list(root).index(app_el), el)
    changed = True
    print("    -> POST_NOTIFICATIONS added.")

# Remove the geo.API_KEY meta-data if a previous build added it — the map is
# now Leaflet + OSM in a WebView and the Google Maps SDK is no longer used.
geo_key_name  = "com.google.android.geo.API_KEY"
existing_meta = {el.get(f"{{{NS}}}name"): el for el in app_el.findall("meta-data")}
if geo_key_name in existing_meta:
    app_el.remove(existing_meta[geo_key_name])
    changed = True
    print("    -> Removed obsolete geo.API_KEY meta-data.")

if changed:
    tree.write(path, encoding="utf-8", xml_declaration=True)
    print("    -> Manifest patched.")
else:
    print("    -> Manifest already patched.")
PYEOF

# ── 8. Gradle build ───────────────────────────────────────────────────────────
chmod +x /app/android/gradlew
cd /app/android

# Unquoted on purpose: this has to split into separate argv entries, and an ABI
# list never contains spaces.
GRADLE_ARGS="$GRADLE_TASK --no-daemon"
if [ -n "$ABIS" ]; then
  GRADLE_ARGS="$GRADLE_ARGS -PreactNativeArchitectures=$ABIS"
  echo ">>> Running Gradle $GRADLE_TASK (ABIs: $ABIS)..."
else
  echo ">>> Running Gradle $GRADLE_TASK (all ABIs)..."
fi
./gradlew $GRADLE_ARGS

if [ -f "$APK_FINAL" ]; then
  echo ""
  echo "=========================================="
  echo " APK ready:"
  echo " ${APK_FINAL#/app/}"
  echo "=========================================="
else
  echo "ERROR: APK not found." >&2; exit 1
fi
