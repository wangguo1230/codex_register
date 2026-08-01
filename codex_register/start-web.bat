@echo off
chcp 65001 >nul 2>&1
title GPT 批量注册 - 前端开发
cd /d "%~dp0\web"

echo [依赖] 检查并安装前端依赖 ...
call npm install --yes

echo ============================================================
echo   前端开发服务器启动中（Vite 热更新）
echo   (Ctrl+C 退出)
echo ============================================================

npx --yes vite
pause
