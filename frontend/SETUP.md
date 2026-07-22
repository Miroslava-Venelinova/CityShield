# CityShield App — Setup & Development Guide

There are two ways to build the app. **The default is a local toolchain** —
Node, a JDK and the Android SDK installed on Windows. Docker is still supported
and needs none of those on the host, but it is the slower, opt-in path: the
container runs `--rm` with no Gradle daemon, so every build starts cold.

Both entry-point scripts ask which one you want and default to local.

---

## Quickest path (Windows)

From the repo root:

```cmd
setup.bat                  answer the two prompts (Enter = both, Enter = no Docker)
frontend\build-apk.bat     answer N to the Docker question
```

`setup.bat` installs the npm packages for `frontend/` and `backend/`, writes
`android/local.properties`, and tells you if a required Android SDK component
or a Java 17–21 JDK is missing. `build-apk.bat` produces a standalone release
APK and opens the output folder in Explorer when it's done.

---

## What you need (one time only)

### Local toolchain (default)

| Tool | Download | Why |
|---|---|---|
| Node.js 20+ | https://nodejs.org | npm packages, Metro, the bundler |
| Android Studio | https://developer.android.com/studio | Android SDK, emulator, and a bundled Java 21 JDK |
| Android SDK bits | Android Studio → SDK Manager | `platforms;android-36`, `build-tools;36.0.0`, `ndk;27.1.12297006`, `cmake;3.22.1` — must match `android/build.gradle`'s `ext` block |

Gradle 8.14 with the Android plugin wants **Java 17–21**, and rejects anything
newer. `build-apk.bat` does not trust whatever `java` is on `PATH` — it looks
for a JDK in that range (Android Studio's bundled `jbr` counts) and pins
`JAVA_HOME` to it for the build.

### Docker (alternative)

| Tool | Download | Why |
|---|---|---|
| Docker Desktop | https://www.docker.com/products/docker-desktop | Runs Node, Java, Android SDK, Metro, Gradle |
| Android Studio | https://developer.android.com/studio | Emulator only |
| Make | https://gnuwin32.sourceforge.net/packages/make.htm | Runs the `make ...` commands |

Then `setup.bat frontend docker` builds the images, and the `make` targets below
all work.

---

## Get the app running (from zero)

### Step 1 — Set up the Android emulator
1. Install Android Studio with all defaults
2. Open Android Studio → Welcome screen → **More Actions → Virtual Device Manager**
3. **Create Device** → **Pixel 8** → **Next**
4. Select **API 35** (download if needed) → **Finish**
5. Press ▶️ — a phone window appears

A release APK built with `build-apk.bat fast` is arm64-only and will **not**
install on an x86_64 emulator — use plain `build-apk.bat` for emulator testing,
or a real phone for `fast`.

### Step 2 — Install the dependencies
Double-click **`setup.bat`** in the repo root, or:

```cmd
setup.bat both native
```

### Step 3 — Build and install the app
Double-click **`frontend\build-apk.bat`**. It builds a standalone release APK
pointing at the deployed Worker, opens the containing folder, and offers to
`adb install` it if exactly one device is attached.

The first build compiles React Native's C++ from scratch and takes a while;
later builds reuse the Gradle daemon and are much quicker.

### Step 4 — Only if you want live reload
A release APK carries its own JS bundle and needs no dev server. For a Metro
workflow instead, build the debug variant and open **two** terminals in
`frontend/`:

```
build-apk.bat debug
Terminal 1:   npx react-native start   ← Metro, keep open all session
Terminal 2:   adb reverse tcp:8081 tcp:8081
```

(Under Docker those two are `make dev` and `make reverse`.)

### Backend
The app talks to the deployed Cloudflare Worker by default, so nothing needs to
run locally. To point it at a local Worker instead, `cd backend && npm run dev`
and rebuild with `CITYSHIELD_API_URL` set.

---

## Daily workflow (after first-time setup)

Release APKs (the default): change code → `build-apk.bat` → install. Nothing to
keep running, and no backend to start — the app points at the deployed Worker.

For a Metro/hot-reload session:

1. Start the emulator (and Docker Desktop, if that's your setup)
2. Terminal 1: `npx react-native start` (Docker: `make dev`)
3. Terminal 2: `adb reverse tcp:8081 tcp:8081` (Docker: `make reverse`)
4. Open the app on the emulator

---

## I changed something — what do I run?

Pick the row that matches what you changed:

| What you changed | Local (default) | Docker |
|---|---|---|
| A `.ts` / `.tsx` file, Metro running | **Nothing** — hot-reloads on save | same |
| Hot reload didn't kick in | Press **R R** on the emulator | same |
| Still stale (renamed/moved a file) | Restart Metro with `--reset-cache` | `make reload` |
| A `.ts` / `.tsx` file, no Metro | `build-apk.bat` (~1 min) | `make release` |
| **Added/removed an npm package** | `build-apk.bat` — it re-runs `npm install` and React Native re-autolinks itself | `make rebuild` |
| Changed `AndroidManifest.xml` or anything in `android/` | `build-apk.bat` | `make rebuild` |
| Gradle is behaving oddly | `cd android && gradlew clean` then `build-apk.bat` | `make clean` |

**Rule of thumb:** with `build-apk.bat` there is nothing else to remember — it
syncs npm packages, clears a stale autolinking cache, and runs Gradle on every
invocation. Re-running `setup.bat` is only needed if you want the backend
packages refreshed too; it is safe to run repeatedly.

**One caveat:** a new *native* package brings a new C++ compile, so the build
after adding one is slow again — that's the package, not the script.

---

## All commands

### Local (default)

| Command | When to use it |
|---|---|
| `setup.bat` (repo root) | Install/refresh npm packages; check the Android toolchain |
| `frontend\build-apk.bat` | Build a release APK, open the folder, offer to install |
| `frontend\build-apk.bat fast` | Same, arm64-v8a only — quicker, no x86_64 emulator |
| `frontend\build-apk.bat debug` | Debug APK — needs Metro + `adb reverse` |
| `npx react-native start` | Start Metro (from `frontend/`) |
| `adb reverse tcp:8081 tcp:8081` | ADB tunnel — once per emulator boot |
| `cd android && gradlew clean` | Full Gradle clean |

### Docker

| Command | When to use it |
|---|---|
| `make dev` | Start Metro — run once, keep open |
| `make reverse` | ADB tunnel — run once per emulator boot |
| `make reload` | JS change not hot-reloading, or Metro acting stale |
| `make rebuild` | Added/removed a native package, changed `android/` or manifest |
| `make ship` | Quick reinstall without full clean (faster than rebuild) |
| `make build` | Build APK only (no install) |
| `make install-host` | Install the already-built APK |
| `make logs` | Stream Metro logs |
| `make stop` | Stop Docker containers |
| `make clean` | Wipe everything — true fresh start |

---

## Project structure

```
../setup.bat                        Install dependencies (frontend/backend, ± Docker)
frontend/
├── index.js                        Entry point
├── App.tsx                         Root component
├── build-apk.bat                   One-click APK build — local or Docker
├── Makefile                        Docker dev commands
├── docker-compose.yml              metro / build / install services
├── Dockerfile                      Node 22 + JDK 17 + Android SDK 35
├── android/                        Committed, already patched — Gradle builds it as-is
├── scripts/
│   ├── build.sh                    Gradle build + manifest patching (Docker only)
│   └── install.sh                  ADB install via Docker
└── src/
    ├── context/
    │   └── AuthContext.tsx          JWT token, hasLocation state
    ├── navigation/
    │   ├── AppNavigator.tsx         Auth stack + tab bar
    │   └── types.ts                 Navigation type definitions
    ├── screens/
    │   ├── LoginScreen.tsx
    │   ├── RegisterScreen.tsx       Email + password only (no location at register)
    │   ├── HomeScreen.tsx           Alert dashboard — banner if no location set
    │   ├── NotificationsScreen.tsx  Inbox (persisted) + category toggles
    │   └── ProfileScreen.tsx        Account, push permission, location setup
    ├── services/
    │   ├── api.ts                   All API calls — BASE_URL is here
    │   ├── push.ts                  OneSignal init, permission, user identity
    │   └── notifications.ts         Local notification storage (AsyncStorage)
    └── theme.ts                     Colors, fonts, spacing
```

---

## Push notifications (OneSignal)

Push goes through OneSignal, not Firebase directly. Android delivery still rides
on FCM underneath, but those credentials live in the OneSignal dashboard — the
app itself carries no `google-services.json` and no Firebase SDK.

### Step A — Configure the OneSignal app
1. In the OneSignal dashboard: **Settings → Push & In-App → Google Android**
2. Upload the Firebase service-account JSON
3. Set the **Android package name** to match `PACKAGE_NAME` in
   [scripts/build.sh](scripts/build.sh) (`com.cityshield.fcmtest` by default).
   A mismatch means the device subscribes and then silently receives nothing.
4. Copy the **App ID** from **Settings → Keys & IDs**

### Step B — Build with the app id
`ONESIGNAL_APP_ID` is inlined at bundle time (see `src/config.ts`); a release
build without it fails immediately rather than shipping a push-less app.

**`build-apk.bat` already carries a working app id and Worker URL**, so a
double-click needs no environment setup at all. Both values are public — the app
id ships inside the APK anyway, and the REST key that can actually send push is
backend-only. Override either by setting a real environment variable before
running it.

| | |
|---|---|
| `build-apk.bat` | standalone release APK, all four ABIs |
| `build-apk.bat fast` | same, arm64-v8a only — much quicker, no x86_64 emulator |
| `build-apk.bat debug` | debug APK, JS served by Metro |
| `build-apk.bat fast native` | skip the Docker question (`docker` also works) |

It asks whether to build in Docker (default: no), builds, prints the APK size,
opens the output folder in Explorer, and offers to `adb install` when exactly one
device is attached.

Under Docker the variables have to reach the *build container*, not just your
shell — `docker-compose.yml` forwards them, so export them before invoking make:
```sh
export ONESIGNAL_APP_ID=<app id>
make build          # debug APK — JS served by Metro
make install-host
```

For a standalone APK (JS bundled in, no Metro, installs on any device) use
`make release`, which additionally requires an HTTPS `CITYSHIELD_API_URL`:
```sh
export ONESIGNAL_APP_ID=<app id>
export CITYSHIELD_API_URL=https://<worker-url>
make release
make install-release
```
The release APK is signed with the **debug keystore** (`android/app/build.gradle`),
so it sideloads fine but cannot go to the Play Store. Swapping in a real keystore
later changes the signature, which means uninstalling first.

### Build times
`newArchEnabled=true` compiles React Native's C++ once per ABI, and
`gradle.properties` lists all four, so a first build is slow. `make release-fast`
(or `build-apk.bat fast`) passes `-PreactNativeArchitectures=arm64-v8a` and skips
three quarters of that — at the cost of an APK that will **not** install on an
x86_64 emulator. Modern physical phones are all arm64-v8a.

The Android SDK, NDK and CMake versions in the `Dockerfile` must stay in sync
with `android/build.gradle`'s `ext` block. If they drift, Gradle silently
re-downloads the difference — about 1GB for the NDK — on *every* build, because
the container runs `--rm` and `ANDROID_HOME` is not a volume.

### Step C — Subscribe the device
1. Open the app → **Profile** tab
2. Tap the **Push Alerts** toggle → Allow

There is no "register device" step anymore: signing in calls `OneSignal.login()`
with your account id, and the backend targets that id directly.

### Step D — Send a test notification
OneSignal dashboard → **Messages → New Push** → target **Subscribed Users** (or a
specific External ID — your `user_id`, visible in the GDPR export). The
**Delivery** tab shows per-device outcomes, which is the fastest way to tell a
targeting mistake from a delivery failure.

---

## Setting a location (development)

Location is set after registration via **Profile → Set My Location**. This opens a coordinate entry form — paste in any lat/lon to test. Nominatim reverse-geocodes the coordinates on the backend to find the region and street.

Varna city centre: `43.21411, 27.91472`

> For real GPS, install `react-native-geolocation-service`, add `ACCESS_FINE_LOCATION` to `AndroidManifest.xml`, and update `handleSetLocation` in `ProfileScreen.tsx`. The rest of the flow (coords → Nominatim → backend) is unchanged.

---

## Troubleshooting

### Gradle: "No matching variant … No variants exist" for every `react-native-*` project
→ A leftover autolinking cache from the *other* toolchain. React Native keys
`android/build/generated/autolinking/` on the package.json hashes only, not on
where the build ran, so a container's `/app/...` paths get reused on Windows (and
vice versa). Both `build-apk.bat` and `scripts/build.sh` now detect and clear
this automatically; to do it by hand:
`rmdir /s /q android\build\generated\autolinking`

### Gradle fails immediately with a Java/AGP version complaint
→ Something forced a JDK outside 17–21. `build-apk.bat` pins `JAVA_HOME` to a
JDK in range and ignores `PATH`, so this means `JAVA_HOME` was already set to
something odd — check `echo %JAVA_HOME%`.

### `SDK location not found`
→ `android/local.properties` is missing (it's gitignored, one per machine).
Re-run `setup.bat`, or write `sdk.dir=C:/Users/<you>/AppData/Local/Android/Sdk`.

### A newly added package isn't in the APK
→ `build-apk.bat` runs `npm install` itself, so this normally can't happen. If
the package needs native code, it may need a Gradle clean:
`cd android && gradlew clean`

### Hot reload not working
→ Press **R R** on the emulator, or restart Metro with `--reset-cache`
(Docker: `make reload`)

### "Network request failed"
→ Check `CITYSHIELD_API_URL` the APK was built with. Release builds also refuse
cleartext HTTP to anything but `10.0.2.2` — a local Worker needs the emulator
address, not `localhost`.

### Black screen
→ `cd android && gradlew clean` then `build-apk.bat` (Docker: `make clean` then `make ship`)

### "Unable to load script" (Metro not found)
→ A debug APK with no dev server. Either run `adb reverse tcp:8081 tcp:8081`
with Metro up, or build the release variant, which carries its own bundle.

### Notification toggle grayed out in Settings
→ The APK was built before the `POST_NOTIFICATIONS` permission was added
→ Rebuild and reinstall, then toggle Push Alerts in Profile

### Port 8081 already in use
→ `netstat -ano | findstr :8081` → end the process in Task Manager

### `make` not found (Windows)
→ `make` is only needed for the Docker workflow. Use `build-apk.bat` instead, or
install Make: https://gnuwin32.sourceforge.net/packages/make.htm

---

## OpenStreetMap notes

The app uses OpenStreetMap tiles — no Google Maps API key or billing required. Tiles come from `tile.openstreetmap.org` via the `UrlTile` component in `react-native-maps`.

For production, use a self-hosted tile server or a paid OSM provider (Stadia Maps, MapTiler) — the public OSM tile server enforces a usage policy and rate-limits heavy traffic. Swap the `urlTemplate` prop in `HomeScreen.tsx` to change providers.
