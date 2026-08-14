@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ========================================
echo C Drive Space Watch - Build
echo ========================================
echo.

rem ===== 检查 Go =====
go version
if errorlevel 1 goto :go_error

rem ===== 检查 npm =====
call npm --version >nul 2>&1
if errorlevel 1 goto :npm_error

echo.
echo [INFO] Go:
go version
echo [INFO] npm:
call npm --version
echo.

rem ===== 清理旧构建（保留运行数据和用户配置） =====
if exist "dist\web" rmdir /s /q "dist\web"
if exist "dist\SpaceWatch.exe" del /q "dist\SpaceWatch.exe"

mkdir "dist" >nul 2>&1
mkdir "dist\web" >nul 2>&1
mkdir "dist\config" >nul 2>&1
mkdir "dist\data" >nul 2>&1

rem ===== 构建前端 =====
if not exist "frontend\node_modules" (
  echo [1/4] 未检测到前端依赖，正在安装...
  pushd "frontend"
  call npm install --no-audit --no-fund --prefer-offline
  if errorlevel 1 goto :npm_install_error
  popd
) else (
  echo [1/4] 已检测到 frontend\node_modules，跳过 npm install。
)

echo.
echo [2/4] 构建 Vue 前端...
pushd "frontend"
call npm run build
if errorlevel 1 goto :frontend_build_error

popd

echo.
echo [INFO] 复制前端构建产物...
xcopy /e /i /y "frontend\dist\*" "dist\web\" >nul
if errorlevel 1 goto :frontend_copy_error

rem ===== 构建 Go 后端 =====
echo.
echo [3/4] 构建 Go 后端...
pushd "backend"

rem 依赖已缓存时不会联网；缺少依赖时使用国内代理自动下载。
set "GOPROXY=https://goproxy.cn,direct"

set "CGO_ENABLED=0"

go build -trimpath -ldflags="-s -w" -o "..\dist\SpaceWatch.exe" ".\cmd\spacewatch"
if errorlevel 1 goto :go_build_error

popd

rem ===== 复制默认配置（不覆盖已有用户配置） =====
if not exist "dist\config\config.json" if exist "config\config.json" copy /y "config\config.json" "dist\config\config.json" >nul
if exist "start.bat" copy /y "start.bat" "dist\start.bat" >nul

echo.
echo [4/4] 构建完成
echo.
echo 输出目录:
echo %~dp0dist
echo.
pause
exit /b 0


:go_error
echo.
echo [ERROR] Go 无法执行。
echo 请执行: go version
echo.
pause
exit /b 1


:npm_error
echo.
echo [ERROR] npm 无法执行。
echo 请执行: npm --version
echo.
pause
exit /b 1


:npm_install_error
popd
echo.
echo [ERROR] npm install 失败。
echo.
pause
exit /b 1


:frontend_build_error
popd
echo.
echo [ERROR] Vue 前端构建失败。
echo.
pause
exit /b 1


:frontend_copy_error
echo.
echo [ERROR] 前端构建产物复制失败。
echo.
pause
exit /b 1


:go_build_error
popd
echo.
echo [ERROR] Go 后端构建失败；如果提示缺少模块，请先联网完成一次依赖下载。
echo.
pause
exit /b 1
