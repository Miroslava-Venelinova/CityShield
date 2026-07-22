@echo off
REM ============================================================================
REM  CityShield - one-click APK build (double-click me)
REM
REM    build-apk.bat            standalone release APK (runs with no Metro)
REM    build-apk.bat fast       same, arm64-v8a only - much quicker, but will
REM                             NOT install on an x86_64 emulator
REM    build-apk.bat debug      debug APK (needs Metro + adb reverse)
REM
REM  The build runs on your local toolchain (Node + JDK + Android SDK) by
REM  default; the script asks whether to use the Docker image instead, which
REM  only makes sense if you set the project up that way. Skip the question by
REM  passing the engine as a second argument:
REM
REM    build-apk.bat release docker
REM    build-apk.bat fast native
REM
REM  Both values below are public: the app id ships inside the APK anyway, and
REM  the REST key that can actually send push is backend-only. Set them as real
REM  environment variables to override.
REM ============================================================================

setlocal enabledelayedexpansion
cd /d "%~dp0"

set MODE=%~1
set ENGINE=%~2
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
    echo ERROR: first argument must be "release", "fast" or "debug", got "%MODE%".
    goto :fail
)

if "%CITYSHIELD_API_URL%"=="" set CITYSHIELD_API_URL=https://cityshield.cityshield-varna.workers.dev
if "%ONESIGNAL_APP_ID%"=="" set ONESIGNAL_APP_ID=2988dfb1-4647-4dc5-b5bb-7c52a3150b5f

if /i "%BUILD_TYPE%"=="release" (
    set APK=android\app\build\outputs\apk\release\app-release.apk
    set GRADLE_TASK=assembleRelease
) else (
    set APK=android\app\build\outputs\apk\debug\app-debug.apk
    set GRADLE_TASK=assembleDebug
)

REM --- src/config.ts throws at startup without these, so fail in one second
REM     rather than after a full Gradle run ------------------------------------
if /i not "%BUILD_TYPE%"=="release" goto :env_ok
if "%ONESIGNAL_APP_ID%"=="" (
    echo ERROR: release build needs ONESIGNAL_APP_ID.
    goto :fail
)
echo %CITYSHIELD_API_URL%| findstr /i /b "https://" >nul
if errorlevel 1 (
    echo ERROR: CITYSHIELD_API_URL must be HTTPS ^("%CITYSHIELD_API_URL%"^).
    echo        Release builds block cleartext HTTP to anything but 10.0.2.2.
    goto :fail
)
:env_ok

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

REM --- Which toolchain? Local is the default; Docker is opt-in --------------
if /i "%ENGINE%"=="docker" goto :engine_set
if /i "%ENGINE%"=="native" goto :engine_set
if not "%ENGINE%"=="" (
    echo ERROR: second argument must be "docker" or "native", got "%ENGINE%".
    goto :fail
)
echo   Did you set this project up with Docker? Answer N (or just press Enter)
echo   if you installed Node, a JDK and the Android SDK on Windows directly.
echo.
set "ANSWER="
set /p "ANSWER=  Build inside Docker? [y/N]: "
if /i "%ANSWER%"=="y"   set ENGINE=docker
if /i "%ANSWER%"=="yes" set ENGINE=docker
if not "%ENGINE%"=="docker" set ENGINE=native
echo.
:engine_set

REM --- Delete the old APK so a failed build can't leave a stale one behind -
if exist "%APK%" del /q "%APK%"

if /i "%ENGINE%"=="docker" (
    call :build_docker
) else (
    call :build_native
)
if errorlevel 1 (
    echo.
    echo BUILD FAILED - scroll up for the first error.
    goto :fail
)

if not exist "%APK%" (
    echo.
    echo ERROR: the build reported success but %APK% is missing.
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

REM --- Pop the output folder with the APK already selected -----------------
explorer /select,"%CD%\%APK%"

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


REM ============================================================================
REM  Docker build - everything (Node, JDK, SDK, NDK) lives in the image, so
REM  the only host requirement is a running Docker Desktop. scripts/build.sh
REM  reads BUILD_TYPE and ABIS out of the environment via docker-compose.yml.
REM ============================================================================
:build_docker
docker info >nul 2>&1
if errorlevel 1 (
    echo ERROR: Docker Desktop is not running. Start it and try again.
    echo        Or answer N to the Docker question to build locally instead.
    exit /b 1
)
docker compose run --rm build
exit /b %errorlevel%


REM ============================================================================
REM  Local build - android/ is committed already patched (package name, network
REM  security config, manifest), so this skips straight to Gradle. Unlike the
REM  container it keeps the Gradle daemon alive, which makes rebuilds quicker.
REM ============================================================================
:build_native
call :find_sdk
if not defined SDK (
    echo ERROR: no Android SDK found.
    echo        Install Android Studio, or set ANDROID_HOME to your SDK folder.
    echo        Expected it at %LOCALAPPDATA%\Android\Sdk
    exit /b 1
)
echo ^>^>^> Android SDK:  %SDK%

call :find_jdk
if not defined JDK (
    echo ERROR: no usable JDK found. Gradle 8.14 with AGP needs Java 17-21;
    echo        a newer JDK on PATH is rejected by the Android plugin.
    echo        Install Android Studio ^(it bundles one^) or a Temurin 17/21 JDK,
    echo        then point JAVA_HOME at it.
    exit /b 1
)
echo ^>^>^> JDK:          %JDK% ^(Java %JMAJ%^)

REM Gradle reads the SDK location from here; it is gitignored, per machine.
if not exist "android\local.properties" (
    set "SDKFWD=%SDK:\=/%"
    > "android\local.properties" echo sdk.dir=!SDKFWD!
    echo ^>^>^> Wrote android\local.properties
)

REM Not fatal - AGP downloads most of these on demand - but a missing NDK turns
REM one slow build into a very slow one, so say so up front.
call :want_sdk "platforms\android-36"      "platforms;android-36"
call :want_sdk "build-tools\36.0.0"        "build-tools;36.0.0"
call :want_sdk "ndk\27.1.12297006"         "ndk;27.1.12297006"
call :want_sdk "cmake\3.22.1"              "cmake;3.22.1"

where npm >nul 2>&1
if errorlevel 1 (
    echo ERROR: npm is not on PATH. Install Node 20+ ^(or run setup.bat in the
    echo        repo root^), then try again.
    exit /b 1
)
REM Every time, not just when node_modules is missing: adding a package to
REM package.json between builds is the common case, and stale node_modules
REM surfaces much later as a confusing Gradle error. Costs ~1s when in sync.
REM
REM Deliberately without --legacy-peer-deps, which the container uses: this
REM dependency set does not need it, and it rewrites package-lock.json metadata
REM on every run, so every build would leave the working tree dirty. Kept as a
REM fallback in case a future package really does have a peer conflict.
echo ^>^>^> Syncing JS dependencies...
call npm install --no-fund --no-audit
if errorlevel 1 (
    echo     Peer dependency conflict - retrying with --legacy-peer-deps...
    call npm install --legacy-peer-deps --no-fund --no-audit
    if errorlevel 1 (
        echo ERROR: npm install failed.
        exit /b 1
    )
)

REM React Native caches autolinking results under android\build, keyed only on
REM the package.json hashes - not on where the build ran. A Docker build leaves
REM behind /app/... project paths that do not exist on Windows, and Gradle then
REM fails with "No variants exist" for every autolinked library. Drop the cache
REM whenever it was generated somewhere other than here.
set "AUTOLINK=android\build\generated\autolinking"
if not exist "%AUTOLINK%\autolinking.json" goto :autolink_ok
REM "find", not "findstr": findstr treats a backslash as an escape even in a
REM literal /c: search, so every path in the pattern silently fails to match.
REM Spelled out in full because Git Bash, MSYS and Cygwin all put a GNU "find"
REM on PATH that would shadow this one.
set "CDJSON=%CD:\=\\%"
"%SystemRoot%\System32\find.exe" /i "%CDJSON%" "%AUTOLINK%\autolinking.json" >nul
if not errorlevel 1 goto :autolink_ok
echo ^>^>^> Clearing an autolinking cache from another machine or container...
rmdir /s /q "%AUTOLINK%"
:autolink_ok

REM babel.config.js inlines these two into the bundle from the environment,
REM so they have to be exported before Gradle spawns the bundler.
set "JAVA_HOME=%JDK%"
set "ANDROID_HOME=%SDK%"
set "GRADLE_ARGS=%GRADLE_TASK%"
if not "%ABIS%"=="" set "GRADLE_ARGS=%GRADLE_ARGS% -PreactNativeArchitectures=%ABIS%"

echo ^>^>^> Running Gradle %GRADLE_ARGS%...
echo.
pushd android
REM ".\" on purpose: cmd skips the current directory when looking up a command
REM if NoDefaultCurrentDirectoryInExePath is set in the environment.
call .\gradlew.bat %GRADLE_ARGS%
set GRADLE_RC=!errorlevel!
popd
exit /b %GRADLE_RC%


:find_sdk
set "SDK="
if defined ANDROID_HOME if exist "%ANDROID_HOME%\platform-tools" set "SDK=%ANDROID_HOME%"
if not defined SDK if defined ANDROID_SDK_ROOT if exist "%ANDROID_SDK_ROOT%\platform-tools" set "SDK=%ANDROID_SDK_ROOT%"
if not defined SDK if exist "%LOCALAPPDATA%\Android\Sdk\platform-tools" set "SDK=%LOCALAPPDATA%\Android\Sdk"
if not defined SDK if exist "C:\Android\Sdk\platform-tools" set "SDK=C:\Android\Sdk"
exit /b 0

REM :want_sdk <relative path> <sdkmanager package name>
:want_sdk
if exist "%SDK%\%~1" exit /b 0
echo     WARNING: %SDK%\%~1 is missing.
echo              Install "%~2" from Android Studio's SDK Manager if the build fails.
exit /b 0

REM Picks the first Java 17-21 it can find. The versions must match what
REM android/build.gradle's AGP expects, not just "some java on PATH".
:find_jdk
set "JDK="
if defined JAVA_HOME call :try_jdk "%JAVA_HOME%"
call :try_jdk "C:\Program Files\Android\Android Studio\jbr"
call :try_jdk "%LOCALAPPDATA%\Programs\Android Studio\jbr"
call :try_jdk "C:\Program Files\Android\Android Studio Preview\jbr"
for /d %%J in ("C:\Program Files\Eclipse Adoptium\jdk-*") do call :try_jdk "%%~fJ"
for /d %%J in ("C:\Program Files\Microsoft\jdk-*")        do call :try_jdk "%%~fJ"
for /d %%J in ("C:\Program Files\Java\jdk-*")             do call :try_jdk "%%~fJ"
exit /b 0

REM :try_jdk <candidate home> - sets JDK/JMAJ on the first acceptable one
:try_jdk
if defined JDK exit /b 0
set "CAND=%~1"
if not exist "%CAND%\bin\java.exe" exit /b 0
REM java -version prints to stderr, and the path has spaces in it, so go via a
REM temp file rather than trying to quote a pipe inside for /f.
set "JV="
"%CAND%\bin\java.exe" -version 2>"%TEMP%\cityshield-java-version.txt"
for /f "tokens=3" %%v in ('findstr /i "version" "%TEMP%\cityshield-java-version.txt"') do if not defined JV set JV=%%v
del "%TEMP%\cityshield-java-version.txt" >nul 2>&1
if not defined JV exit /b 0
set JV=%JV:"=%
for /f "tokens=1 delims=." %%m in ("%JV%") do set JMAJ=%%m
if not defined JMAJ exit /b 0
if %JMAJ% LSS 17 exit /b 0
if %JMAJ% GTR 21 exit /b 0
set "JDK=%CAND%"
exit /b 0
