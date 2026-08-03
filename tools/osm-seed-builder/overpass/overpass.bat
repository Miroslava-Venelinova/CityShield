@echo off
REM ============================================================================
REM  CityShield - self-hosted Overpass (double-click me)
REM
REM  First run:  creates the container and imports Geofabrik's Bulgaria extract.
REM  Later runs: starts it back up, or re-imports to pick up newer OSM data.
REM
REM  The database is NOT the container. It lives in the named volume, and the
REM  image imports only when that volume is empty - so deleting and recreating
REM  the container picks up nothing new. Refreshing the data means deleting the
REM  volume and importing from scratch, which is what "refresh" below does.
REM  (There is no diff updater; the compose file says why.) The import always
REM  downloads bulgaria-latest.osm.pbf, which Geofabrik rebuilds daily, so a
REM  refresh lands you at most about a day behind live OSM.
REM
REM  Non-interactive:
REM    overpass.bat start        create/start; never touches existing data
REM    overpass.bat refresh      delete the database and re-import (asks first)
REM    overpass.bat refresh -y   ... without asking
REM    overpass.bat status       what exists, and is it answering area queries
REM    overpass.bat stop         stop the container, keep the database
REM    overpass.bat logs         follow the import / serving log
REM ============================================================================

setlocal enabledelayedexpansion
cd /d "%~dp0"

set "ACTION=%~1"
set "FLAG=%~2"

echo.
echo  ============================================
echo   CityShield - self-hosted Overpass
echo  ============================================
echo.

REM --- Prerequisites --------------------------------------------------------
docker info >nul 2>&1
if errorlevel 1 (
    echo   ERROR: Docker Desktop is not running. Start it and re-run.
    goto :fail
)
docker compose version >nul 2>&1
if errorlevel 1 (
    echo   ERROR: "docker compose" is unavailable - this needs Compose v2,
    echo          which ships with current Docker Desktop.
    goto :fail
)

call :read_state

if /i "%ACTION%"=="start"   goto :do_start
if /i "%ACTION%"=="refresh" goto :do_refresh
if /i "%ACTION%"=="status"  goto :do_status
if /i "%ACTION%"=="stop"    goto :do_stop
if /i "%ACTION%"=="logs"    goto :do_logs
if not "%ACTION%"=="" (
    echo   ERROR: unknown argument "%ACTION%".
    echo          Use: start ^| refresh ^| status ^| stop ^| logs
    goto :fail
)

REM --- No argument: decide from what is on the machine -----------------------
if not defined VOL (
    echo   No Overpass database found - this is a first run.
    echo.
    goto :do_start
)

call :show_state
echo.
echo   The database above is a snapshot taken when it was imported; it does
echo   not update itself. Re-importing downloads today's Bulgaria extract
echo   (~170 MB) and rebuilds the index from zero - the existing database is
echo   deleted first, and the instance is unusable until it finishes.
echo.
set "ANSWER="
set /p "ANSWER=  Re-import with the latest OSM data? [y/N]: "
echo.
if /i "%ANSWER%"=="y"   goto :refresh_confirmed
if /i "%ANSWER%"=="yes" goto :refresh_confirmed
echo   Keeping the existing database. Making sure it is running...
echo.
goto :do_start


REM ============================================================================
REM  Actions
REM ============================================================================

:do_start
echo   docker compose up -d
docker compose up -d
if errorlevel 1 (
    echo.
    echo   ERROR: compose failed to bring the service up.
    echo          docker compose logs -f
    goto :fail
)
echo.
call :wait_ready
goto :done


:do_refresh
if not defined VOL (
    echo   Nothing to refresh - no database exists yet. Importing from scratch.
    echo.
    goto :do_start
)
call :show_state
echo.
echo   This DELETES the database volume and imports again from scratch:
echo     - ~170 MB downloaded from Geofabrik
echo     - full re-index plus area generation, which takes a long while
echo     - no queries can be answered until it is done
echo.
if /i "%FLAG%"=="-y" goto :refresh_confirmed
if /i "%FLAG%"=="/y" goto :refresh_confirmed
set "ANSWER="
set /p "ANSWER=  Delete the database and re-import? [y/N]: "
echo.
if /i "%ANSWER%"=="y"   goto :refresh_confirmed
if /i "%ANSWER%"=="yes" goto :refresh_confirmed
echo   Cancelled - nothing was changed.
goto :done

:refresh_confirmed
echo   docker compose down -v      ^(stopping, and deleting the database^)
docker compose down -v
if errorlevel 1 (
    echo.
    echo   ERROR: could not tear the stack down. The database was NOT deleted.
    goto :fail
)
echo.
echo   docker compose up -d        ^(re-importing^)
docker compose up -d
if errorlevel 1 (
    echo.
    echo   ERROR: compose failed to bring the service back up.
    echo          docker compose logs -f
    goto :fail
)
echo.
call :wait_ready
goto :done


:do_status
if not defined CID if not defined VOL (
    echo   Nothing exists yet - run this script with no arguments to import.
    goto :done
)
call :show_state
echo.
call :probe
if "!READY!"=="1" (
    echo   Area queries: ANSWERING - ready to use.
) else (
    if defined RUNNING (
        echo   Area queries: not answering yet - still importing, or generating
        echo                 areas. Watch it with: overpass.bat logs
    ) else (
        echo   Area queries: not answering - the container is not running.
    )
)
goto :done


:do_stop
if not defined CID (
    echo   Nothing to stop.
    goto :done
)
echo   docker compose down         ^(the database volume is kept^)
docker compose down
goto :done


:do_logs
docker compose logs -f
goto :done


REM ============================================================================
REM  Helpers
REM ============================================================================

REM Sets CID (container id), RUNNING (1 or unset), VOL (database volume name).
:read_state
set "CID="
for /f %%i in ('docker compose ps -aq overpass 2^>nul') do set "CID=%%i"
set "RUNNING="
if defined CID for /f %%s in ('docker inspect -f "{{.State.Running}}" !CID! 2^>nul') do if /i "%%s"=="true" set "RUNNING=1"
REM The volume name carries the compose project prefix, which comes from this
REM directory's name - so match on the suffix rather than hardcoding it.
set "VOL="
for /f %%v in ('docker volume ls -q 2^>nul ^| findstr /e "overpass-db"') do if not defined VOL set "VOL=%%v"
exit /b 0

:show_state
if defined VOL (
    echo   Database volume: %VOL%
    for /f "tokens=*" %%d in ('docker volume inspect -f "{{.CreatedAt}}" %VOL% 2^>nul') do echo   Imported around: %%d
) else (
    echo   Database volume: none
)
if defined RUNNING (
    echo   Container:       running
) else (
    if defined CID (
        echo   Container:       exists, stopped
    ) else (
        echo   Container:       none
    )
)
exit /b 0

REM Sets READY=1 when the instance answers an area query. Readiness is not "the
REM port answers" - HTTP comes up well before area generation finishes, and
REM every query the seed builder sends starts with area(...). CSV output keeps
REM the probe free of quotes, which batch would otherwise mangle; an area id is
REM the country relation id offset by 3600000000, hence the ^36 match.
:probe
set "READY="
where curl >nul 2>&1
if errorlevel 1 exit /b 0
set "PROBE=%TEMP%\cityshield-overpass-probe.txt"
del "%PROBE%" >nul 2>&1
curl -s -m 20 -o "%PROBE%" --data-urlencode "data=[out:csv(::id)];area[admin_level=2];out;" http://127.0.0.1:12345/api/interpreter >nul 2>&1
if not exist "%PROBE%" exit /b 0
findstr /r /c:"^36[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]" "%PROBE%" >nul 2>&1
if not errorlevel 1 set "READY=1"
del "%PROBE%" >nul 2>&1
exit /b 0

:wait_ready
where curl >nul 2>&1
if errorlevel 1 (
    echo   curl is not on PATH, so readiness cannot be probed from here.
    echo   Watch the import with: overpass.bat logs
    exit /b 0
)
call :probe
if "!READY!"=="1" (
    echo   Already answering area queries.
    goto :ready
)
echo   Importing. This runs to completion on its own - closing this window or
echo   pressing Ctrl+C does not stop it, it only stops the waiting.
echo.
set /a TRIES=0
:wait_loop
call :probe
if "!READY!"=="1" goto :ready
set /a TRIES+=1
if !TRIES! GEQ 240 (
    echo.
    echo   Two hours and still no answer to an area query. Something is wrong:
    echo     overpass.bat logs
    echo   A failed import retries at most three times ^(restart: on-failure:3^).
    exit /b 0
)
set /a MOD=TRIES %% 4
if !MOD!==0 (
    set /a MINS=TRIES/2
    echo   ... still importing ^(!MINS! min^)
)
timeout /t 30 /nobreak >nul 2>&1
if errorlevel 1 ping -n 31 127.0.0.1 >nul 2>&1
goto :wait_loop

:ready
echo.
echo   READY - answering area queries on http://127.0.0.1:12345
echo   Pick "Self-hosted (localhost:12345)" in the seed builder's endpoint
echo   dropdown, then re-run the province sweep to pick up the new data.
exit /b 0


:done
echo.
pause
exit /b 0

:fail
echo.
pause
exit /b 1
