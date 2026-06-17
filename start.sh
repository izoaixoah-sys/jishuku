#!/usr/bin/env bash
set -euo pipefail

# 检查是否已安装依赖
if [ ! -d "node_modules" ]; then
    echo "  [提示] 尚未安装依赖，请先运行：bash install.sh"
    exit 1
fi

echo "  正在启动耳塾服务..."
echo "  启动后请用浏览器访问：http://localhost:3000"
echo "  按 Ctrl+C 可停止服务"
echo ""

# 延迟 2 秒后自动在浏览器中打开
(sleep 2 && {
    if command -v open &>/dev/null; then
        open "http://localhost:3000"          # macOS
    elif command -v xdg-open &>/dev/null; then
        xdg-open "http://localhost:3000"      # Linux
    fi
}) &

node server.js
