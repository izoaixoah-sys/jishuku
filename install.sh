#!/usr/bin/env bash
set -euo pipefail

echo ""
echo "=========================================="
echo "  耳塾 - 日语听力会话练习  安装程序"
echo "=========================================="
echo ""

# ── 检查 Node.js ──────────────────────────────────
if ! command -v node &> /dev/null; then
    echo "  [错误] 未检测到 Node.js，请先安装后再运行本脚本。"
    echo ""
    echo "  安装方式（选其一）："
    echo ""
    echo "  macOS（推荐 Homebrew）："
    echo "    brew install node"
    echo ""
    echo "  Ubuntu / Debian："
    echo "    sudo apt update && sudo apt install nodejs npm"
    echo ""
    echo "  通用（nvm，支持多版本）："
    echo "    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash"
    echo "    nvm install --lts"
    echo ""
    echo "  官网下载：https://nodejs.org/zh-cn/download"
    exit 1
fi

# 检查版本 >= 18
NODE_MAJOR=$(node -e "console.log(parseInt(process.version.slice(1)))" 2>/dev/null || echo 0)
if [ "${NODE_MAJOR}" -lt 18 ]; then
    echo "  [错误] Node.js 版本过低（需要 18+），当前版本：$(node -v)"
    echo ""
    echo "  请使用 nvm 或包管理器升级后重试。"
    exit 1
fi

echo "  Node.js 版本：$(node -v)  OK"
echo ""

# ── npm install ──────────────────────────────────────
echo "  正在安装依赖包，首次安装约需 1-3 分钟..."
echo ""
npm install
echo ""
echo "  依赖安装完成。"

# ── 创建 .env ────────────────────────────────────────
if [ ! -f ".env" ]; then
    cp .env.example .env
    echo "  已创建 .env 配置文件（API Key 可选，也可在页面内配置）。"
fi

# ── 赋予启动脚本执行权限 ─────────────────────────────
chmod +x start.sh

echo ""
echo "=========================================="
echo "  安装完成！"
echo "=========================================="
echo ""
echo "  启动服务："
echo "    bash start.sh"
echo "    或运行：npm start"
echo ""
echo "  启动后用浏览器打开：http://localhost:3000"
echo ""
