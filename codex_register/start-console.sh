#!/usr/bin/env bash
# 启动后端 API 服务（前端请单独 cd web && npm run dev）
set -e
cd "$(dirname "$0")"

PORT="${PORT:-3100}"

pkill -9 -f "server/index.ts" 2>/dev/null || true
pkill -9 -f "tsx server" 2>/dev/null || true
sleep 1
OLD_PIDS=$(lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)
if [ -n "$OLD_PIDS" ]; then
  echo "[清理] 强杀仍占用端口 ${PORT} 的进程: $OLD_PIDS"
  kill -9 $OLD_PIDS 2>/dev/null || true; sleep 1
fi

echo "============================================================"
echo "  后端 API:  http://localhost:${PORT}"
echo "  前端开发:  cd web && npm run dev"
echo "  (Ctrl+C 退出)"
echo "============================================================"
MAILCOM_HEADLESS=1 exec npx tsx server/index.ts
