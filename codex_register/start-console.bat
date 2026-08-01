@echo off
chcp 65001 >nul 2>&1
title GPT 批量注册
cd /d "%~dp0"

set PORT=3100

:: 安装后端依赖
echo [依赖] 检查并安装后端依赖 ...
call npm config set fetch-remote-tarball true >nul 2>&1
call npm install --yes --registry https://registry.npmmirror.com

:: 安装前端依赖
echo [依赖] 检查并安装前端依赖 ...
cd /d "%~dp0\web"
call npm config set fetch-remote-tarball true >nul 2>&1
call npm install --yes --registry https://registry.npmmirror.com
cd /d "%~dp0"

:: 清理旧进程
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":%PORT% "') do (
    taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 /nobreak >nul 2>&1

echo ============================================================
echo   后端 API:  http://localhost:%PORT%
echo   前端开发:  http://localhost:5173
echo   (Ctrl+C 退出)
echo ============================================================

:: 后台启动前端 Vite
set MAILCOM_HEADLESS=1
start "前端Vite" /min cmd /c "cd /d "%~dp0\web" && npx --yes vite"

:: 前台启动后端
npx --yes tsx server/index.ts
pause
