@echo off
setlocal

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

:: Copy FFmpeg binaries (needed alongside the exe for portable use)
mkdir "%RELEASE_DIR%\bin" >nul 2>&1
copy "%~dp0src-tauri\bin\ffmpeg.exe" "%RELEASE_DIR%\bin\ffmpeg.exe" >nul
copy "%~dp0src-tauri\bin\ffprobe.exe" "%RELEASE_DIR%\bin\ffprobe.exe" >nul

:: Copy the MSI installer if it exists
for %%f in ("%~dp0src-tauri\target\release\bundle\msi\*.msi") do (
    copy "%%f" "%RELEASE_DIR%\%%~nxf" >nul
    echo  Installer: %%~nxf
)

:: Copy WebView2 bootstrapper if bundled
if exist "%~dp0src-tauri\target\release\bundle\msi\*.exe" (
    for %%f in ("%~dp0src-tauri\target\release\bundle\msi\*.exe") do (
        copy "%%f" "%RELEASE_DIR%\%%~nxf" >nul
    )
)

echo.
echo  ===================================
echo   Build complete!
echo  ===================================
echo.
echo   release\
echo     ConvertX.exe        (portable)
for %%f in ("%RELEASE_DIR%\*.msi") do (
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
