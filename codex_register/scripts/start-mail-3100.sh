#!/bin/zsh
cd /Users/mrwang/study/2026/custom-mail/codex_register || exit 1
npm run build:server
exec node bundle/server.mjs
