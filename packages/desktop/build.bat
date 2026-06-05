@echo off
setlocal enabledelayedexpansion

echo.
echo  ===================================
echo   ConvertX Build Script
echo  ===================================
echo.

:: Add Rust to PATH if installed via rustup
if exist "%USERPROFILE%\.cargo\bin\cargo.exe" (
    set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
)

:: Check for Rust
where cargo >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] Rust/Cargo not found.
    echo  Install from: https://rustup.rs
    pause
    exit /b 1
)

:: Check for Node
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] Node.js not found.
    echo  Install from: https://nodejs.org
    pause
    exit /b 1
)

:: Source the MSVC build environment so the Rust linker can find system libs
:: (msvcrt.lib, kernel32.lib, etc). Skip if LIB is already set — caller is
:: already in a Developer Command Prompt.
if not defined LIB call :setup_msvc
if errorlevel 1 (
    pause
    exit /b 1
)

:: Check for FFmpeg binaries
if not exist "%~dp0src-tauri\bin\ffmpeg.exe" (
    echo  [ERROR] ffmpeg.exe not found in src-tauri\bin\
    echo  Download from: https://www.gyan.dev/ffmpeg/builds/
    pause
    exit /b 1
)
if not exist "%~dp0src-tauri\bin\ffprobe.exe" (
    echo  [ERROR] ffprobe.exe not found in src-tauri\bin\
    pause
    exit /b 1
)
if not exist "%~dp0src-tauri\bin\yt-dlp.exe" (
    echo  [ERROR] yt-dlp.exe not found in src-tauri\bin\
    echo  Download from: https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe
    pause
    exit /b 1
)
if not exist "%~dp0src-tauri\bin\spotdl.exe" (
    echo  [ERROR] spotdl.exe not found in src-tauri\bin\
    echo  Download from: https://github.com/spotDL/spotify-downloader/releases/latest
    pause
    exit /b 1
)

:: Install npm dependencies if needed
if not exist "%~dp0node_modules" (
    echo  [1/3] Installing dependencies...
    cd /d "%~dp0"
    call npm install
    if %errorlevel% neq 0 (
        echo  [ERROR] npm install failed.
        pause
        exit /b 1
    )
) else (
    echo  [1/3] Dependencies already installed.
)

:: Build with Tauri
echo  [2/3] Building ConvertX...
echo.
cd /d "%~dp0"
call npx tauri build
if %errorlevel% neq 0 (
    echo.
    echo  [ERROR] Build failed.
    pause
    exit /b 1
)

:: Copy outputs to release folder
echo.
echo  [3/3] Copying to release folder...

set RELEASE_DIR=%~dp0release
if exist "%RELEASE_DIR%" rmdir /s /q "%RELEASE_DIR%"
mkdir "%RELEASE_DIR%"

:: Copy the exe
copy "%~dp0src-tauri\target\release\convertx.exe" "%RELEASE_DIR%\ConvertX.exe" >nul

:: Copy bundled binaries (needed alongside the exe for portable use)
mkdir "%RELEASE_DIR%\bin" >nul 2>&1
copy "%~dp0src-tauri\bin\ffmpeg.exe" "%RELEASE_DIR%\bin\ffmpeg.exe" >nul
copy "%~dp0src-tauri\bin\ffprobe.exe" "%RELEASE_DIR%\bin\ffprobe.exe" >nul
copy "%~dp0src-tauri\bin\yt-dlp.exe" "%RELEASE_DIR%\bin\yt-dlp.exe" >nul
copy "%~dp0src-tauri\bin\spotdl.exe" "%RELEASE_DIR%\bin\spotdl.exe" >nul

:: Copy the NSIS installer (per-user, no admin) if it exists
for %%f in ("%~dp0src-tauri\target\release\bundle\nsis\*-setup.exe") do (
    copy "%%f" "%RELEASE_DIR%\%%~nxf" >nul
    echo  Installer: %%~nxf
)

echo.
echo  ===================================
echo   Build complete!
echo  ===================================
echo.
echo   release\
echo     ConvertX.exe        (portable)
for %%f in ("%RELEASE_DIR%\*-setup.exe") do (
    echo     %%~nxf  (installer^)
)
echo     bin\ffmpeg.exe
echo     bin\ffprobe.exe
echo.
echo   Output: %RELEASE_DIR%
echo.

:: Open the release folder
explorer "%RELEASE_DIR%"

pause
exit /b 0


:setup_msvc
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" set "VSWHERE=%ProgramFiles%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
    echo  [ERROR] vswhere.exe not found. Install Visual Studio with the
    echo  "Desktop development with C++" workload, or run this script from
    echo  a Developer Command Prompt.
    exit /b 1
)
set "VSINSTALL="
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -prerelease -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSINSTALL=%%i"
if not defined VSINSTALL (
    echo  [ERROR] No Visual Studio install with the MSVC v14x x64/x86 build tools was found.
    echo  Open Visual Studio Installer and add the "Desktop development with C++" workload.
    exit /b 1
)
if not exist "%VSINSTALL%\Common7\Tools\VsDevCmd.bat" (
    echo  [ERROR] VsDevCmd.bat missing under "%VSINSTALL%\Common7\Tools\"
    exit /b 1
)
echo  [0/3] Loading MSVC build environment from "%VSINSTALL%"...
call "%VSINSTALL%\Common7\Tools\VsDevCmd.bat" -arch=x64 -host_arch=x64 -no_logo >nul
if errorlevel 1 (
    echo  [ERROR] VsDevCmd.bat failed to initialise.
    exit /b 1
)
exit /b 0
