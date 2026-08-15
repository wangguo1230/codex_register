@echo off
chcp 65001 >nul 2>&1
title GPT 批量注册
cd /d "%~dp0"

set PORT=3100

:: 一进来先清旧后端，不要等 npm install 那几十秒里旧进程继续开窗
echo [清理] 结束旧 server/index.ts 和 :%PORT% ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\kill-old-3100.ps1" -Port %PORT%

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

:: npm 装完再清一次，防止装依赖期间又被人点开第二份
echo [清理] 再清一遍旧 :%PORT% ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\kill-old-3100.ps1" -Port %PORT%
timeout /t 2 /nobreak >nul 2>&1

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
