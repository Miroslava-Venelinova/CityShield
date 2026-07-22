@echo off
REM ============================================================================
REM  CityShield - install dependencies (double-click me)
REM
REM  Asks what to set up (frontend, backend, or both) and whether to use Docker.
REM  The default for both questions is the plain local toolchain: Node on
REM  Windows, plus a JDK and the Android SDK for the app build. Docker is only
REM  worth answering yes to if you already work that way.
REM
REM  Non-interactive:
REM    setup.bat both              setup.bat frontend docker
REM    setup.bat backend           setup.bat frontend native
REM ============================================================================

setlocal enabledelayedexpansion
cd /d "%~dp0"

set TARGET=%~1
set ENGINE=%~2

echo.
echo  ============================================
echo   CityShield - dependency setup
echo  ============================================
echo.

REM --- What to install ------------------------------------------------------
if not "%TARGET%"=="" goto :target_set
echo   [B] Both        frontend ^(React Native app^) and backend ^(Worker^)
echo   [F] Frontend    React Native app only
echo   [K] Backend     Cloudflare Worker only
echo.
set "ANSWER="
set /p "ANSWER=  What do you want to set up? [B/f/k]: "
if /i "%ANSWER%"=="f" set TARGET=frontend
if /i "%ANSWER%"=="k" set TARGET=backend
if "%TARGET%"=="" set TARGET=both
echo.
:target_set

if /i "%TARGET%"=="both"     goto :target_ok
if /i "%TARGET%"=="frontend" goto :target_ok
if /i "%TARGET%"=="backend"  goto :target_ok
echo ERROR: first argument must be "both", "frontend" or "backend", got "%TARGET%".
goto :fail
:target_ok

REM --- Which toolchain ------------------------------------------------------
if /i "%ENGINE%"=="docker" goto :engine_ok
if /i "%ENGINE%"=="native" goto :engine_ok
if not "%ENGINE%"=="" (
    echo ERROR: second argument must be "docker" or "native", got "%ENGINE%".
    goto :fail
)
echo   Docker builds the app inside a container that already carries Node, a
echo   JDK and the Android SDK. Answer N ^(or press Enter^) to install everything
echo   on Windows directly - that is the setup build-apk.bat expects.
echo.
set "ANSWER="
set /p "ANSWER=  Use Docker? [y/N]: "
if /i "%ANSWER%"=="y"   set ENGINE=docker
if /i "%ANSWER%"=="yes" set ENGINE=docker
if not "%ENGINE%"=="docker" set ENGINE=native
echo.
:engine_ok

set FAILED=
set NOTES=

if /i "%TARGET%"=="backend" goto :do_backend
call :setup_frontend
if /i "%TARGET%"=="frontend" goto :summary

:do_backend
call :setup_backend

:summary
echo.
echo  ============================================
if defined FAILED (
    echo   SETUP FINISHED WITH ERRORS:%FAILED%
) else (
    echo   SETUP COMPLETE
)
echo  ============================================
echo.
echo   Next steps:
if /i not "%TARGET%"=="backend" (
    echo     frontend\build-apk.bat        build a standalone release APK
)
if /i not "%TARGET%"=="frontend" (
    echo     cd backend ^&^& npm run dev    run the Worker locally
    echo     cd backend ^&^& npm test       run the Worker test suite
)
echo.
pause
if defined FAILED exit /b 1
exit /b 0

:fail
echo.
pause
exit /b 1


REM ============================================================================
REM  Frontend - React Native app
REM ============================================================================
:setup_frontend
echo  --------------------------------------------
echo   Frontend ^(React Native app^)
echo  --------------------------------------------

if /i "%ENGINE%"=="docker" (
    docker info >nul 2>&1
    if errorlevel 1 (
        echo   ERROR: Docker Desktop is not running. Start it and re-run.
        set FAILED=!FAILED! frontend
        exit /b 0
    )
    echo   Building the Docker images ^(Node 22 + JDK 17 + Android SDK^)...
    echo   The first run downloads a few GB; later runs are cached.
    pushd frontend
    docker compose build
    if errorlevel 1 set FAILED=!FAILED! frontend
    popd
    call :seed_file "frontend\.env" "frontend\.env.example"
    exit /b 0
)

where npm >nul 2>&1
if errorlevel 1 (
    echo   ERROR: npm is not on PATH. Install Node 20+ from https://nodejs.org
    set FAILED=!FAILED! frontend
    exit /b 0
)

REM No --legacy-peer-deps: this dependency set does not need it, and it rewrites
REM package-lock.json metadata on every run. Kept only as a fallback.
echo   Installing npm packages...
pushd frontend
call npm install --no-fund
if errorlevel 1 (
    echo   Peer dependency conflict - retrying with --legacy-peer-deps...
    call npm install --legacy-peer-deps --no-fund
    if errorlevel 1 (
        set FAILED=!FAILED! frontend
        popd
        exit /b 0
    )
)
popd
echo   npm packages OK.

call :seed_file "frontend\.env" "frontend\.env.example"

REM --- Android toolchain ----------------------------------------------------
echo.
echo   Checking the Android toolchain...

call :find_sdk
if not defined SDK (
    echo   MISSING: Android SDK.
    echo            Install Android Studio ^(https://developer.android.com/studio^),
    echo            open it once so it downloads the SDK, then re-run this script.
    set NOTES=1
) else (
    echo   SDK:  %SDK%
    if not exist "frontend\android\local.properties" (
        set "SDKFWD=!SDK:\=/!"
        > "frontend\android\local.properties" echo sdk.dir=!SDKFWD!
        echo   Wrote frontend\android\local.properties
    )
    call :want_sdk "platforms\android-36"  "platforms;android-36"
    call :want_sdk "build-tools\36.0.0"    "build-tools;36.0.0"
    call :want_sdk "ndk\27.1.12297006"     "ndk;27.1.12297006"
    call :want_sdk "cmake\3.22.1"          "cmake;3.22.1"
)

call :find_jdk
if not defined JDK (
    echo   MISSING: a Java 17-21 JDK. Gradle 8.14 with the Android plugin
    echo            rejects anything newer, so a stray JDK on PATH is not enough.
    echo            Android Studio bundles a suitable one; otherwise install
    echo            Temurin 21 from https://adoptium.net
    set NOTES=1
) else (
    echo   JDK:  %JDK% ^(Java %JMAJ%^)
)

if defined NOTES (
    echo.
    echo   The app will not build until the items above are installed.
)
exit /b 0


REM ============================================================================
REM  Backend - Cloudflare Worker. No container: wrangler runs the Worker in
REM  workerd locally, so Docker has nothing to add here.
REM ============================================================================
:setup_backend
echo.
echo  --------------------------------------------
echo   Backend ^(Cloudflare Worker^)
echo  --------------------------------------------
if /i "%ENGINE%"=="docker" (
    echo   The Worker has no Docker image - wrangler runs it in workerd
    echo   directly. Installing with npm instead.
)

where npm >nul 2>&1
if errorlevel 1 (
    echo   ERROR: npm is not on PATH. Install Node 20+ from https://nodejs.org
    set FAILED=!FAILED! backend
    exit /b 0
)

echo   Installing npm packages...
pushd backend
call npm install
if errorlevel 1 (
    set FAILED=!FAILED! backend
    popd
    exit /b 0
)
popd
echo   npm packages OK.

call :seed_file "backend\.dev.vars" "backend\.dev.vars.example"
echo   Local D1 database: run "cd backend && npm run db:local" to apply
echo   migrations and load the seed data.
exit /b 0


REM ============================================================================
REM  Helpers
REM ============================================================================

REM :seed_file <destination> <template> - copy the template on first setup only
:seed_file
if exist "%~1" exit /b 0
if not exist "%~2" exit /b 0
copy /y "%~2" "%~1" >nul
echo   Created %~1 from %~2 - fill in your values.
exit /b 0

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
echo   MISSING: %~2
echo            Add it in Android Studio: Settings ^> Languages ^& Frameworks ^>
echo            Android SDK ^> SDK Tools ^(tick "Show Package Details"^).
set NOTES=1
exit /b 0

REM Picks the first Java 17-21 it can find - the range android/build.gradle's
REM AGP accepts, which is not necessarily the java on PATH.
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
