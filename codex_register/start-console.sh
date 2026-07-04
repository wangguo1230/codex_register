#!/usr/bin/env bash
# 一键启动 GPT 批量注册 Web 控制台
set -e
cd "$(dirname "$0")"

# 首次运行：构建前端
if [ ! -d web/dist ]; then
  echo "[首次] 安装并构建前端 ..."
  (cd web && npm install && npm run build)
fi

PORT="${PORT:-3100}"

# 先杀后启：干掉所有旧的 server 进程，避免多进程抢端口、请求打到旧进程跑旧代码(改后端不生效的元凶)
# 注意:npx tsx 会派生多个 node 子进程,只按端口 kill 会漏掉→用 pkill -f 兜底杀全。
pkill -9 -f "server/index.ts" 2>/dev/null || true
pkill -9 -f "tsx server" 2>/dev/null || true
sleep 1
OLD_PIDS=$(lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)
if [ -n "$OLD_PIDS" ]; then
  echo "[清理] 强杀仍占用端口 ${PORT} 的进程: $OLD_PIDS"
  kill -9 $OLD_PIDS 2>/dev/null || true; sleep 1
fi

echo "============================================================"
echo "  GPT 批量注册控制台:  http://localhost:${PORT}"
echo "  (Ctrl+C 退出)"
echo "============================================================"
MAILCOM_HEADLESS=1 exec npx tsx server/index.ts
