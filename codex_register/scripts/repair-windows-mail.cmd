@echo off
chcp 65001 >nul
cd /d D:\study\codex_register
echo [1/5] git pull
git checkout -- package-lock.json 2>nul
git checkout -- web\package-lock.json 2>nul
git checkout -- codex_register\package-lock.json 2>nul
git pull --ff-only origin main
if errorlevel 1 (
  echo git pull 失败，检查网络后重试
  pause
  exit /b 1
)

echo [2/5] 检查比特是否已登录
curl -sS -m 5 -o "%TEMP%\bit-list.json" -X POST http://127.0.0.1:54345/browser/list -H "Content-Type: application/json" -d "{\"page\":0,\"pageSize\":5}"
findstr /C:"Login out" /C:"未登录" "%TEMP%\bit-list.json" >nul
if not errorlevel 1 (
  echo.
  echo 比特还没登录。请先打开比特浏览器，登录会员，再重新运行本脚本。
  type "%TEMP%\bit-list.json"
  echo.
  pause
  exit /b 2
)

echo [3/5] 关掉多余 harden 比特窗
powershell -NoProfile -Command ^
  "$j=Invoke-RestMethod -Method Post -Uri http://127.0.0.1:54345/browser/list -ContentType application/json -Body '{\"page\":0,\"pageSize\":100}';" ^
  "if (-not $j.success) { Write-Output ('比特未登录: ' + $j.msg); exit 2 };" ^
  "foreach ($w in @($j.data.list)) { if ($w.name -like 'harden-*' -or $w.remark -eq 'gmail-harden') { Write-Output ('CLOSE ' + $w.name); try { Invoke-RestMethod -Method Post -Uri http://127.0.0.1:54345/browser/close -ContentType application/json -Body ('{\"id\":\"' + $w.id + '\"}') | Out-Null } catch {}; Start-Sleep -m 200; try { Invoke-RestMethod -Method Post -Uri http://127.0.0.1:54345/browser/delete -ContentType application/json -Body ('{\"ids\":[\"' + $w.id + '\"]}') | Out-Null } catch {}; Start-Sleep -m 200 } }"

echo [4/5] 重启 :3100
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :3100 ^| findstr LISTENING') do taskkill /PID %%p /F >nul 2>&1
timeout /t 2 /nobreak >nul
cd /d D:\study\codex_register\codex_register
start "mail3100" /MIN cmd /c ""C:\Program Files\nodejs\node.exe" --require D:\study\codex_register\codex_register\node_modules\tsx\dist\preflight.cjs --import file:///D:/study/codex_register/codex_register/node_modules/tsx/dist/loader.mjs server/index.ts"

echo [5/5] 等服务起来
timeout /t 6 /nobreak >nul
curl -sS -m 5 -o NUL -w "3100 HTTP %%{http_code}\n" http://127.0.0.1:3100/api/mailboxes/job
echo.
echo 修好了就看上面是 200。这个窗口可以最小化，不要关。
pause
