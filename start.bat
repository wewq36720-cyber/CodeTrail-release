@echo off
chcp 65001 >nul
title CodeTrail 码途 - 本地代码学习平台

echo.
echo ========================================
echo   CodeTrail 码途 - 启动器
echo ========================================
echo.

REM ---- 环境自检（FR-30 / NF-06）----
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js 20+（https://nodejs.org/）
    pause
    exit /b 1
)
for /f "tokens=1" %%i in ('node --version') do set NODE_VER=%%i
echo [OK] Node.js %NODE_VER%

uv --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [警告] 未检测到 uv，Python 相关验证功能将受限
    echo        安装: powershell -c "irm https://astral.sh/uv/install.ps1 | iex"
) else (
    for /f "tokens=1" %%i in ('uv --version') do set UV_VER=%%i
    echo [OK] uv %UV_VER%
)

go version >nul 2>&1
if %errorlevel% neq 0 (
    echo [提示] 未检测到 Go，Go 课程验证按钮将置灰（FR-18 降级）
    echo        安装建议: winget install GoLang.Go
) else (
    echo [OK] Go 已安装
)

REM ---- 依赖与前端构建 ----
cd /d "%~dp0server"
if not exist "node_modules" (
    echo [安装] 首次运行，正在安装后端依赖...
    call npm install
    if %errorlevel% neq 0 (
        echo [错误] 后端依赖安装失败
        pause
        exit /b 1
    )
)

cd /d "%~dp0client"
if not exist "node_modules" (
    echo [安装] 首次运行，正在安装前端依赖...
    call npm install
    if %errorlevel% neq 0 (
        echo [错误] 前端依赖安装失败
        pause
        exit /b 1
    )
)

if not exist "dist\index.html" (
    echo [构建] 正在构建前端（约 1~2 分钟）...
    call npm run build
    if %errorlevel% neq 0 (
        echo [错误] 前端构建失败
        pause
        exit /b 1
    )
)

REM ---- 先启动服务，等健康检查通过后再打开浏览器 ----
echo.
echo [启动] CodeTrail 服务（http://127.0.0.1:8787）...

cd /d "%~dp0server"
start "CodeTrail Server" cmd /c "npx tsx src/index.ts & pause"

REM 轮询健康检查，最长等 30 秒
set /a TRIES=0
:wait_health
timeout /t 1 /nobreak >nul
curl -s -m 2 http://127.0.0.1:8787/api/health | findstr /c:"ok" >nul 2>&1
if %errorlevel% equ 0 goto health_ok
set /a TRIES+=1
if %TRIES% geq 30 (
    echo [错误] 服务 30 秒内未启动成功。请查看 CodeTrail Server 窗口中的报错信息。
    echo 常见原因：端口 8787 被占用（已有一个实例在运行，直接访问 http://127.0.0.1:8787 即可）。
    pause
    exit /b 1
)
goto wait_health

:health_ok
echo [OK] 服务已就绪，正在打开浏览器...
start "" "http://127.0.0.1:8787"

echo.
echo ========================================
echo   CodeTrail 已启动！
echo   地址: http://127.0.0.1:8787
echo   数据: %~dp0..\.learndesk
echo   关闭: 关闭 CodeTrail Server 窗口即停止服务
echo ========================================
echo.
echo 本窗口可以关闭。
pause >nul
