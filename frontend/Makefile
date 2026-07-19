.PHONY: dev reverse reload rebuild ship build install install-host uninstall adb-host logs stop clean

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

install-host:
	adb install -r android/app/build/outputs/apk/debug/app-debug.apk

uninstall:
	@PKG=$$(python3 -c "import json; d=json.load(open('android/app/google-services.json')); print(d['client'][0]['client_info']['android_client_info']['package_name'])" 2>/dev/null || echo "com.cityshieldscaffold"); \
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
