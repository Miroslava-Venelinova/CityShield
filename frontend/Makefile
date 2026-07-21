.PHONY: dev reverse reload rebuild ship build release release-fast install install-host install-release uninstall adb-host logs stop clean

# ── Development ───────────────────────────────────────────────────────────────

# Start Metro bundler — keep this open in Terminal 1
dev:
	docker compose up --build metro

# ADB tunnel — run once per emulator boot in Terminal 2
reverse:
	adb reverse tcp:8081 tcp:8081
	@echo "Tunnel set. Press R R on the emulator to reload."

# JS-only change: reset Metro cache and reload
# Use this when: you changed .ts/.tsx files and hot reload isn't picking it up
reload:
	docker compose restart metro
	adb reverse tcp:8081 tcp:8081
	@echo "Metro restarted. Press R R on the emulator."

# Native change: clean Gradle + rebuild APK + reinstall
# Use this when: you added/removed a package, changed AndroidManifest.xml,
#               or changed anything in android/
rebuild:
	docker compose run --rm build ./gradlew clean
	$(MAKE) build
	$(MAKE) uninstall
	$(MAKE) install-host
	@echo "Rebuild complete. App reinstalled."

# ── Build & install ───────────────────────────────────────────────────────────

build:
	docker compose run --rm build

# Standalone APK: JS bundled in, runs with no Metro and no adb reverse.
# Both variables are inlined into the bundle and the build refuses to start
# without them. Signed with the debug keystore — sideload only, not Play Store.
#   CITYSHIELD_API_URL=https://... ONESIGNAL_APP_ID=... make release
release:
	BUILD_TYPE=release docker compose run --rm build

# Same APK, arm64-v8a only — much faster, but it will NOT install on an
# x86_64 emulator. Use it when you test on a real phone.
release-fast:
	BUILD_TYPE=release ABIS=arm64-v8a docker compose run --rm build

install-host:
	adb install -r android/app/build/outputs/apk/debug/app-debug.apk

install-release:
	adb install -r android/app/build/outputs/apk/release/app-release.apk

uninstall:
	@PKG=$${PACKAGE_NAME:-com.cityshield.fcmtest}; \
	echo "Uninstalling $$PKG..."; \
	adb uninstall $$PKG || echo "(not installed, continuing)"

# Full pipeline: build + uninstall old + install fresh
ship: build uninstall install-host

# ── Docker helpers ────────────────────────────────────────────────────────────

adb-host:
	adb -a nodaemon server start

install:
	docker compose run --rm install

logs:
	docker compose logs -f metro

stop:
	docker compose stop

# Wipe everything — use when you want a truly fresh start
clean:
	docker compose down -v --remove-orphans
	docker image rm cityshieldapp-metro cityshieldapp-build cityshieldapp-install 2>/dev/null || true
