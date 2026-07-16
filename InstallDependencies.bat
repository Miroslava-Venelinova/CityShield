@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo  CityShield - Install all dependencies
echo ============================================
echo.

REM ---------- Python backend ----------
echo [1/3] Python backend...
where python >nul 2>nul
if errorlevel 1 (
    echo   SKIPPED: python not found on PATH. Install Python 3 first.
) else (
    if not exist "backend\.venv\Scripts\python.exe" (
        echo   Creating virtual environment backend\.venv ...
        python -m venv "backend\.venv"
    )
    echo   Installing packages from backend\requirements.txt ...
    "backend\.venv\Scripts\python.exe" -m pip install --upgrade pip
    "backend\.venv\Scripts\python.exe" -m pip install -r "backend\requirements.txt" -r "backend\requirements-dev.txt"
    if errorlevel 1 (
        echo   ERROR: pip install failed.
    ) else (
        echo   Backend OK.
    )
)
echo.

REM ---------- React Native frontend ----------
echo [2/3] Frontend (npm)...
where npm >nul 2>nul
if errorlevel 1 (
    echo   SKIPPED: npm not found on PATH. Install Node.js, or use the Docker
    echo   workflow described in frontend\SETUP.md instead.
) else (
    pushd frontend
    call npm install
    if errorlevel 1 (
        echo   ERROR: npm install failed.
    ) else (
        echo   Frontend OK.
    )
    popd
)
echo.

REM ---------- ASP.NET API ----------
echo [3/3] ASP.NET API (dotnet restore)...
where dotnet >nul 2>nul
if errorlevel 1 (
    echo   SKIPPED: dotnet not found on PATH. Install the .NET 8 SDK first.
) else (
    dotnet restore "ASP\CityShieldAPI\CityShieldAPI.sln"
    if errorlevel 1 (
        echo   ERROR: dotnet restore failed.
    ) else (
        echo   ASP.NET OK.
    )
)
echo.

echo ============================================
echo  Done.
echo ============================================
pause
