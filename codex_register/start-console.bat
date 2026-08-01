@echo off
chcp 65001 >nul 2>&1
title GPT 批量注册 - 后端 API
cd /d "%~dp0"

set PORT=3100

:: 安装依赖（--yes 自动同意远程包提示）
echo [依赖] 检查并安装后端依赖 ...
call npm install --yes

:: 清理旧进程
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":%PORT% "') do (
    taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 /nobreak >nul 2>&1

echo ============================================================
echo   后端 API:  http://localhost:%PORT%
echo   前端开发:  cd web ^&^& npm run dev
echo   (Ctrl+C 退出)
echo ============================================================

set MAILCOM_HEADLESS=1
npx --yes tsx server/index.ts
pause
