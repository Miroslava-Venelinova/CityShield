#!/bin/sh
set -e

APK_FINAL="/app/android/app/build/outputs/apk/debug/app-debug.apk"
MANIFEST="/app/android/app/src/main/AndroidManifest.xml"
ROOT_GRADLE="/app/android/build.gradle"
APP_GRADLE="/app/android/app/build.gradle"
GOOGLE_SERVICES="/app/android/app/google-services.json"

echo ""
echo "=========================================="
echo " CityShield — Build"
echo "=========================================="

# ── 1. JS deps ────────────────────────────────────────────────────────────────
echo ">>> Installing JS dependencies..."
cd /app
npm install --legacy-peer-deps --silent

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

# ── 3. Verify google-services.json exists ─────────────────────────────────────
if [ ! -f "$GOOGLE_SERVICES" ]; then
  echo ""
  echo "ERROR: google-services.json not found at android/app/google-services.json"
  echo ""
  echo "  1. Go to https://console.firebase.google.com"
  echo "  2. Add an Android app (any package name)"
  echo "  3. Download google-services.json"
  echo "  4. Place it at android/app/google-services.json"
  exit 1
fi
echo ">>> google-services.json found."

# ── 4. Read the real package name from google-services.json ───────────────────
# Whatever package name you used when registering the app in Firebase is the
# one we use — no need to re-register. We patch all Android files to match.
FIREBASE_PKG=$(python3 -c "
import json, sys
data = json.load(open('$GOOGLE_SERVICES'))
clients = data.get('client', [])
if not clients:
    print('ERROR: no client found in google-services.json', file=sys.stderr)
    sys.exit(1)
pkg = clients[0]['client_info']['android_client_info']['package_name']
print(pkg)
")
echo ">>> Firebase package name: $FIREBASE_PKG"

# ── 5. Patch Android package name to match Firebase ───────────────────────────
echo ">>> Patching Android package name to $FIREBASE_PKG..."
python3 << PYEOF
import os, re, sys

pkg     = "$FIREBASE_PKG"
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

# ── 6. Patch root build.gradle — Google Services classpath ────────────────────
echo ">>> Patching root build.gradle..."
if ! grep -q "google-services" "$ROOT_GRADLE"; then
  sed -i 's|classpath("com.facebook.react:react-native-gradle-plugin")|classpath("com.facebook.react:react-native-gradle-plugin")\n        classpath("com.google.gms:google-services:4.4.2")|' "$ROOT_GRADLE"
  echo "    -> Root build.gradle patched."
else
  echo "    -> Root build.gradle already patched."
fi

# ── 7. Patch app/build.gradle — apply Google Services plugin ──────────────────
echo ">>> Patching app/build.gradle..."
if ! grep -q "com.google.gms.google-services" "$APP_GRADLE"; then
  echo "" >> "$APP_GRADLE"
  echo "apply plugin: 'com.google.gms.google-services'" >> "$APP_GRADLE"
  echo "    -> app/build.gradle patched."
else
  echo "    -> app/build.gradle already patched."
fi

# ── 8. Write network_security_config.xml ──────────────────────────────────────
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

# ── 9a. Clean up obsolete react-native-maps configuration ─────────────────────
# The map is now Leaflet + OpenStreetMap inside react-native-webview, so the
# Google Maps SDK is no longer part of the build. Remove leftovers that older
# builds may have written.
echo ">>> Cleaning up obsolete Google Maps configuration..."

GRADLE_PROPS="/app/android/gradle.properties"
if grep -q "REACT_NATIVE_MAPS_PROVIDER" "$GRADLE_PROPS" 2>/dev/null; then
  sed -i '/REACT_NATIVE_MAPS_PROVIDER/d; /react-native-maps: OSM\/default provider/d' "$GRADLE_PROPS"
  echo "    -> gradle.properties: removed obsolete REACT_NATIVE_MAPS_PROVIDER flag."
fi

# ── 9. Patch AndroidManifest.xml ──────────────────────────────────────────────
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

# ── 10. Gradle build ──────────────────────────────────────────────────────────
echo ">>> Running Gradle assembleDebug..."
chmod +x /app/android/gradlew
cd /app/android
./gradlew assembleDebug --no-daemon

if [ -f "$APK_FINAL" ]; then
  echo ""
  echo "=========================================="
  echo " APK ready:"
  echo " android/app/build/outputs/apk/debug/app-debug.apk"
  echo "=========================================="
else
  echo "ERROR: APK not found." >&2; exit 1
fi
