@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [mail3100] 先结束占用 :3100 的旧进程（强制结束，不关比特窗）
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3100" ^| findstr LISTENING') do (
  if not "%%p"=="0" taskkill /F /PID %%p >nul 2>&1
)
timeout /t 2 /nobreak >nul
echo [mail3100] 启动
npx --yes tsx server/index.ts
pause
