@echo off
chcp 65001 > nul
setlocal

echo.
echo  ==========================================
echo   耳塾 - 日语听力会话练习  安装程序
echo  ==========================================
echo.

:: ── 检查 Node.js ──────────────────────────────
where node > nul 2>&1
if %errorlevel% neq 0 (
    echo  [错误] 未检测到 Node.js，请先安装后再运行本脚本。
    echo.
    echo  推荐下载地址：https://nodejs.org/zh-cn/download
    echo  建议选择 LTS 版本（20 或更高）。
    echo.
    pause
    exit /b 1
)

:: 检查版本 >= 18
node -e "const v=parseInt(process.version.slice(1));if(v<18){process.stderr.write('low');process.exit(1)}" 2>nul
if %errorlevel% neq 0 (
    echo  [警告] Node.js 版本过低，建议 18 或更高版本。当前版本：
    node -v
    echo.
    echo  请从 https://nodejs.org 升级后重试。
    echo.
    pause
    exit /b 1
)

for /f %%i in ('node -v') do set NODE_VER=%%i
echo  Node.js 版本：%NODE_VER%  OK
echo.

:: ── npm install ───────────────────────────────
echo  正在安装依赖包，首次安装约需 1-3 分钟...
echo.
call npm install
if %errorlevel% neq 0 (
    echo.
    echo  [错误] npm install 失败，请检查网络连接后重试。
    echo  如在中国大陆，可尝试：npm install --registry https://registry.npmmirror.com
    echo.
    pause
    exit /b 1
)

echo.
echo  依赖安装完成。

:: ── 创建 .env ─────────────────────────────────
if not exist ".env" (
    copy ".env.example" ".env" > nul
    echo  已创建 .env 配置文件（API Key 可选，也可在页面内配置）。
)

echo.
echo  ==========================================
echo   安装完成！
echo  ==========================================
echo.
echo  启动服务：
echo    双击  start.bat
echo    或在终端运行  npm start
echo.
echo  启动后用浏览器打开：http://localhost:3000
echo.
pause
endlocal
