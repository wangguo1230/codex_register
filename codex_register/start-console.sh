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
pkill -9 -f "bundle/server.mjs" 2>/dev/null || true
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

# 主服务使用预构建产物，避免 tsx 在大依赖图下并发写缓存耗尽文件描述符。
echo "[构建] 后端服务 ..."
npm run build:server

# 先起后端，等 3100 通了再开 Vite，避免页面先请求空数据
MAILCOM_HEADLESS=1 node bundle/server.mjs &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" "$VITE_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[等待] 后端 http://localhost:${PORT} ..."
for i in $(seq 1 40); do
  if curl -sf -o /dev/null --connect-timeout 1 "http://127.0.0.1:${PORT}/api/health"; then
    echo "[就绪] 后端已监听"
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[错误] 后端进程退出，看上面日志"
    exit 1
  fi
  sleep 0.5
done

cd web
MAILCOM_HEADLESS=1 npx --yes vite &
VITE_PID=$!
cd ..
wait "$SERVER_PID"
