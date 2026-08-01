#!/usr/bin/env bash
# 一键启动：安装依赖 → 后台起 Vite → 前台起后端
set -e
cd "$(dirname "$0")"

PORT="${PORT:-3100}"

# 安装后端依赖
echo "[依赖] 检查并安装后端依赖 ..."
npm install --yes 2>&1 | tail -1

# 安装前端依赖
echo "[依赖] 检查并安装前端依赖 ..."
cd web
npm install --yes 2>&1 | tail -1
cd ..

# 清理旧进程
pkill -9 -f "server/index.ts" 2>/dev/null || true
pkill -9 -f "tsx server" 2>/dev/null || true
sleep 1
OLD_PIDS=$(lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)
if [ -n "$OLD_PIDS" ]; then
  echo "[清理] 强杀占用端口 ${PORT} 的进程: $OLD_PIDS"
  kill -9 $OLD_PIDS 2>/dev/null || true; sleep 1
fi

# 删除旧构建产物，避免后端托管过期的静态文件
rm -rf web/dist

echo "============================================================"
echo "  后端 API:  http://localhost:${PORT}"
echo "  前端开发:  http://localhost:5173"
echo "  (Ctrl+C 退出)"
echo "============================================================"

# 后台启动前端 Vite
cd web
MAILCOM_HEADLESS=1 npx --yes vite &
VITE_PID=$!
cd ..
trap "kill $VITE_PID 2>/dev/null" EXIT

# 前台启动后端
MAILCOM_HEADLESS=1 exec npx tsx server/index.ts
