@echo off
chcp 65001 >nul
cd /d D:\study\codex_register
echo [1/4] git pull
git checkout -- package-lock.json 2>nul
git checkout -- web\package-lock.json 2>nul
git checkout -- codex_register\package-lock.json 2>nul
git pull --ff-only origin main
if errorlevel 1 (
  echo git pull 失败，检查网络后重试
  pause
  exit /b 1
)

echo [2/4] 检查比特是否已登录（只探测，不关窗）
curl -sS -m 5 -o "%TEMP%\bit-list.json" -X POST http://127.0.0.1:54345/browser/list -H "Content-Type: application/json" -d "{\"page\":0,\"pageSize\":5}"
findstr /C:"Login out" /C:"未登录" "%TEMP%\bit-list.json" >nul
if not errorlevel 1 (
  echo.
  echo 比特还没登录。请先打开比特浏览器并登录会员。本脚本不会关你已经打开的窗。
  type "%TEMP%\bit-list.json"
  echo.
  pause
  exit /b 2
)

echo [3/4] 强制结束旧 :3100（不走关窗收尾）后拉起新代码
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :3100 ^| findstr LISTENING') do taskkill /F /PID %%p >nul 2>&1
timeout /t 2 /nobreak >nul
cd /d D:\study\codex_register\codex_register
start "mail3100" /MIN cmd /c ""C:\Program Files\nodejs\node.exe" --require D:\study\codex_register\codex_register\node_modules\tsx\dist\preflight.cjs --import file:///D:/study/codex_register/codex_register/node_modules/tsx/dist/loader.mjs server/index.ts"

echo [4/4] 等服务起来
timeout /t 6 /nobreak >nul
curl -sS -m 5 -o NUL -w "3100 HTTP %%{http_code}\n" http://127.0.0.1:3100/api/mailboxes/job
echo.
echo 修好了就看上面是 200。这个窗口可以最小化，不要关。新代码启动后不会再扫开着的比特窗。
pause
