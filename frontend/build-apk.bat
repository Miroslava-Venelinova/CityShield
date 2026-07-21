@echo off
REM ============================================================================
REM  CityShield - one-click APK build (double-click me)
REM
REM    build-apk.bat            standalone release APK (runs with no Metro)
REM    build-apk.bat fast       same, arm64-v8a only - much quicker, but will
REM                             NOT install on an x86_64 emulator
REM    build-apk.bat debug      debug APK (needs Metro + adb reverse)
REM
REM  Both values below are public: the app id ships inside the APK anyway, and
REM  the REST key that can actually send push is backend-only. Set them as real
REM  environment variables to override.
REM ============================================================================

setlocal
cd /d "%~dp0"

set MODE=%~1
if "%MODE%"=="" set MODE=release

set ABIS=
if /i "%MODE%"=="release" (
    set BUILD_TYPE=release
) else if /i "%MODE%"=="fast" (
    set BUILD_TYPE=release
    set ABIS=arm64-v8a
) else if /i "%MODE%"=="debug" (
    set BUILD_TYPE=debug
) else (
    echo ERROR: argument must be "release", "fast" or "debug", got "%MODE%".
    goto :fail
)

if "%CITYSHIELD_API_URL%"=="" set CITYSHIELD_API_URL=https://cityshield.cityshield-varna.workers.dev
if "%ONESIGNAL_APP_ID%"=="" set ONESIGNAL_APP_ID=2988dfb1-4647-4dc5-b5bb-7c52a3150b5f

if /i "%BUILD_TYPE%"=="release" (
    set APK=android\app\build\outputs\apk\release\app-release.apk
) else (
    set APK=android\app\build\outputs\apk\debug\app-debug.apk
)

echo.
echo  ============================================
echo   CityShield - building %BUILD_TYPE% APK
echo  ============================================
echo   API:       %CITYSHIELD_API_URL%
echo   OneSignal: %ONESIGNAL_APP_ID%
if "%ABIS%"=="" (
    echo   ABIs:      all four ^(portable, slower^)
) else (
    echo   ABIs:      %ABIS% - will NOT run on an x86_64 emulator
)
echo.
echo   The first build of a variant compiles native code from scratch and
echo   takes a while; unchanged rebuilds are much quicker. Leave this open.
echo.

REM --- Docker has to actually be running, not just installed --------------
docker info >nul 2>&1
if errorlevel 1 (
    echo ERROR: Docker Desktop is not running. Start it and try again.
    goto :fail
)

REM --- Delete the old APK so a failed build can't leave a stale one behind -
if exist "%APK%" del /q "%APK%"

docker compose run --rm build
if errorlevel 1 (
    echo.
    echo BUILD FAILED - scroll up for the first Gradle error.
    goto :fail
)

if not exist "%APK%" (
    echo.
    echo ERROR: Gradle reported success but %APK% is missing.
    goto :fail
)

for %%A in ("%APK%") do set APKSIZE=%%~zA
set /a APKMB=%APKSIZE% / 1048576

echo.
echo  ============================================
echo   APK READY  (%APKMB% MB)
echo   %CD%\%APK%
echo  ============================================
echo.

REM --- Offer to install, but only if exactly one device is attached --------
where adb >nul 2>&1
if errorlevel 1 goto :done

set DEVICES=0
for /f "skip=1 tokens=2" %%D in ('adb devices') do if "%%D"=="device" set /a DEVICES+=1

if "%DEVICES%"=="0" (
    echo No device attached. Start your emulator, then run:
    echo     adb install -r "%APK%"
    goto :done
)
if not "%DEVICES%"=="1" (
    echo %DEVICES% devices attached - install by hand with "adb -s ^<serial^> install -r".
    goto :done
)

echo A device is attached.
choice /c YN /n /m "Install it now? [Y/N] "
if errorlevel 2 goto :done

REM A debug-signed release APK can't overwrite a differently-signed install,
REM so fall back to uninstall-then-install rather than failing.
adb install -r "%APK%"
if errorlevel 1 (
    echo.
    echo Install failed - usually a signature mismatch with the installed copy.
    choice /c YN /n /m "Uninstall com.cityshield.fcmtest and retry? [Y/N] "
    if errorlevel 2 goto :done
    adb uninstall com.cityshield.fcmtest
    adb install -r "%APK%"
)

:done
echo.
pause
exit /b 0

:fail
echo.
pause
exit /b 1
