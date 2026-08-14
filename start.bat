@echo off
chcp 65001 >nul
setlocal

set "APP_DIR=%~dp0"
if exist "%APP_DIR%SpaceWatch.exe" goto :start_server
set "APP_DIR=%~dp0dist\"
if exist "%APP_DIR%SpaceWatch.exe" goto :start_server

echo [ERROR] 找不到 SpaceWatch.exe。
echo [INFO] 已检查:
echo        "%~dp0SpaceWatch.exe"
echo        "%~dp0dist\SpaceWatch.exe"
pause
exit /b 1

:start_server
echo [INFO] 启动服务: "%APP_DIR%SpaceWatch.exe"
pushd "%APP_DIR%"
start "SpaceWatch Server" "SpaceWatch.exe"
popd

echo [INFO] 等待服务启动: http://127.0.0.1:8899
for /l %%I in (1,1,20) do (
  curl.exe --silent --show-error --fail http://127.0.0.1:8899/api/health >nul 2>&1
  if not errorlevel 1 goto :server_ready
  timeout /t 1 /nobreak >nul
)

echo [ERROR] 服务未能在 20 秒内启动。
echo [INFO] 请检查 SpaceWatch Server 窗口中的错误信息。
pause
exit /b 1

:server_ready
echo [INFO] 服务已启动。
start "" http://127.0.0.1:8899
endlocal
exit /b 0
