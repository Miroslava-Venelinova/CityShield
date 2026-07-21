# CityShield App — Setup & Development Guide

Everything runs inside Docker (Node, Java, Android SDK, Gradle) — you don't need to install any of those on your machine.

---

## What you need (one time only)

| Tool | Download | Why |
|---|---|---|
| Docker Desktop | https://www.docker.com/products/docker-desktop | Runs Node, Java, Android SDK, Metro, Gradle |
| Android Studio | https://developer.android.com/studio | Emulator only |
| Make | https://gnuwin32.sourceforge.net/packages/make.htm | Runs the `make ...` commands |

---

## Get the app running (from zero)

### Step 1 — Install Docker Desktop
1. Download and install Docker Desktop for Windows
2. Restart when prompted
3. Open Docker Desktop and wait for the whale icon in the taskbar to go solid
4. Verify: open Command Prompt → `docker --version`

### Step 2 — Set up the Android emulator
1. Install Android Studio with all defaults
2. Open Android Studio → Welcome screen → **More Actions → Virtual Device Manager**
3. **Create Device** → **Pixel 8** → **Next**
4. Select **API 35** (download if needed) → **Finish**
5. Press ▶️ — a phone window appears

### Step 3 — Start the backend API
Open the solution `ASP/CityShieldAPI/CityShieldAPI.sln` in Visual Studio and press **Run**, or from a terminal:

```cmd
dotnet run --project ASP\CityShieldAPI\CityShieldAPI
```

No configuration needed — the API automatically listens on port **5276** on all interfaces, which is exactly where the emulator expects it.

### Step 4 — Build and install the app
From the `frontend/` folder:

```cmd
copy .env.example .env
make build
make install-host
```

First run takes ~5–10 min (downloads Android SDK layers). Subsequent builds are faster.

### Step 5 — Start it up
Open **two** terminals in `frontend/`:

```
Terminal 1:   make dev        ← starts Metro, keep open all session
Terminal 2:   make reverse    ← run once per emulator boot
```

Then open the emulator and tap **CityShield**. Done ✅

---

## Daily workflow (after first-time setup)

1. Start Docker Desktop and the emulator
2. Start the backend API (Visual Studio ▶️ or `dotnet run`)
3. Terminal 1: `make dev`
4. Terminal 2: `make reverse`
5. Open the app on the emulator

---

## I changed something — what do I run?

Pick the row that matches what you changed:

| What you changed | What to run | How long |
|---|---|---|
| A `.ts` / `.tsx` file | **Nothing** — Metro hot-reloads on save | instant |
| Hot reload didn't kick in | Press **R R** on the emulator | instant |
| Still stale (renamed/moved a file) | `make reload` | ~30 s |
| Added/removed an npm package | `make rebuild` | ~3–4 min |
| Changed `AndroidManifest.xml` or anything in `android/` | `make rebuild` | ~3–4 min |
| Want a fresh reinstall without the full Gradle clean | `make ship` | ~1–2 min |

**Rule of thumb:** JavaScript/TypeScript changes need nothing. Anything native (packages, manifest, `android/`) needs `make rebuild`.

---

## All commands

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
frontend/
├── index.js                        Entry point
├── App.tsx                         Root component
├── Makefile                        All dev commands
├── docker-compose.yml              metro / build / install services
├── Dockerfile                      Node 22 + JDK 17 + Android SDK 35
├── scripts/
│   ├── build.sh                    Gradle build + manifest patching
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

The variable has to reach the *build container*, not just your shell —
`docker-compose.yml` forwards it, so export it before invoking make:
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

On Windows, **`build-apk.bat`** does all of the above in one double-click
(`build-apk.bat` = release, `fast` = arm64 only, `debug` = Metro build). It
checks Docker is running and offers to install if a device is attached.

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

### Hot reload not working
→ Press **R R** on the emulator, or run `make reload`

### "Network request failed"
1. Is the API running? (Visual Studio ▶️ or `dotnet run`)
2. Check `BASE_URL` in `src/services/api.ts` — should be `http://10.0.2.2:5276`

### Black screen
→ `make clean` then `make ship`

### "Unable to load script" (Metro not found)
→ Run `make reverse` in a second terminal, then press **R R** on the emulator

### Gradle manifest parse error
→ `rmdir /s /q android` then `make clean` then `make build`

### Notification toggle grayed out in Settings
→ The APK was built before the `POST_NOTIFICATIONS` permission was added
→ Run `make rebuild` to reinstall with the fix, then toggle Push Alerts in Profile

### Port 8081 already in use
→ `netstat -ano | findstr :8081` → end the process in Task Manager

### `make` not found (Windows)
→ Install Make: https://gnuwin32.sourceforge.net/packages/make.htm
→ Or run the `docker compose ...` commands from the Makefile directly

---

## OpenStreetMap notes

The app uses OpenStreetMap tiles — no Google Maps API key or billing required. Tiles come from `tile.openstreetmap.org` via the `UrlTile` component in `react-native-maps`.

For production, use a self-hosted tile server or a paid OSM provider (Stadia Maps, MapTiler) — the public OSM tile server enforces a usage policy and rate-limits heavy traffic. Swap the `urlTemplate` prop in `HomeScreen.tsx` to change providers.
