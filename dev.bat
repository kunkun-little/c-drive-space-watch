@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem --- 定位 Go 可执行文件 -----------------------------------------------------
set "GO_EXE="
for %%G in (go.exe) do set "GO_EXE=%%~$PATH:G"
if not defined GO_EXE (
  for /f "usebackq delims=" %%G in (`where.exe go 2^>nul`) do if not defined GO_EXE set "GO_EXE=%%G"
)
if not defined GO_EXE if exist "%ProgramFiles%\Go\bin\go.exe" set "GO_EXE=%ProgramFiles%\Go\bin\go.exe"
if not defined GO_EXE if exist "%LOCALAPPDATA%\Programs\Go\bin\go.exe" set "GO_EXE=%LOCALAPPDATA%\Programs\Go\bin\go.exe"
if not defined GO_EXE if exist "%USERPROFILE%\scoop\apps\go\current\bin\go.exe" set "GO_EXE=%USERPROFILE%\scoop\apps\go\current\bin\go.exe"

if not defined GO_EXE (
  echo [ERROR] 无法定位 Go 可执行文件。
  echo [INFO] 当前 PATH: %PATH%
  echo [INFO] 请在同一个 CMD 窗口执行: where.exe go
  pause
  exit /b 1
)

"%GO_EXE%" version
if errorlevel 1 (
  echo [ERROR] Go 已定位但无法执行: "%GO_EXE%"
  pause
  exit /b 1
)

rem --- 定位 npm -------------------------------------------------------------
set "NPM_EXE="
for %%N in (npm.cmd) do set "NPM_EXE=%%~$PATH:N"
if not defined NPM_EXE (
  for /f "usebackq delims=" %%N in (`where.exe npm.cmd 2^>nul`) do if not defined NPM_EXE set "NPM_EXE=%%N"
)
if not defined NPM_EXE if exist "%ProgramFiles%\nodejs\npm.cmd" set "NPM_EXE=%ProgramFiles%\nodejs\npm.cmd"

if not defined NPM_EXE (
  echo [ERROR] 无法定位 npm.cmd，请确认 Node.js 已安装并加入 PATH。
  pause
  exit /b 1
)

call "%NPM_EXE%" --version >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm 已定位但无法执行: "%NPM_EXE%"
  pause
  exit /b 1
)

echo [INFO] Go:  "%GO_EXE%"
echo [INFO] npm: "%NPM_EXE%"
echo.

if not exist "frontend\node_modules" (
  echo [1/3] 正在安装前端依赖...
  pushd frontend
  call "%NPM_EXE%" install
  if errorlevel 1 (
    popd
    echo [ERROR] npm install 失败。
    pause
    exit /b 1
  )
  popd
)

echo [2/3] 准备并启动 Go 后端: http://127.0.0.1:8899
pushd backend
"%GO_EXE%" mod download
if errorlevel 1 (
  popd
  echo [ERROR] go mod download 失败。
  pause
  exit /b 1
)
popd
start "SpaceWatch Backend" cmd /k "cd /d ""%~dp0backend"" && set ""SPACEWATCH_HOME=%~dp0"" && ""%GO_EXE%"" run ./cmd/spacewatch"

echo [3/3] 启动 Vue 前端: http://127.0.0.1:5173
start "SpaceWatch Frontend" cmd /k "cd /d ""%~dp0frontend"" && call ""%NPM_EXE%"" run dev"

timeout /t 2 >nul
start "" http://127.0.0.1:5173
endlocal
