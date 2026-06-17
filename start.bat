@echo off
chcp 65001 > nul

:: 检查是否已安装依赖
if not exist "node_modules" (
    echo  [提示] 尚未安装依赖，请先运行 install.bat
    pause
    exit /b 1
)

echo  正在启动耳塾服务...
echo  启动后请用浏览器访问：http://localhost:3000
echo  按 Ctrl+C 可停止服务
echo.

:: 延迟 2 秒后自动打开浏览器（等服务启动）
start /b cmd /c "timeout /t 2 /nobreak > nul && start http://localhost:3000"

node server.js
