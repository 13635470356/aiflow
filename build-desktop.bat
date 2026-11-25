@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title aiflow - 构建桌面版

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有找到 Node.js，请先安装 Node.js 18 或更高版本：https://nodejs.org
  pause & exit /b 1
)

echo.
echo 首次构建需要下载 Electron（约 100MB）和打包工具。
set /p USE_MIRROR=国内网络较慢时可使用国内镜像，是否使用？[y/N] 
if /i "%USE_MIRROR%"=="y" (
  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
  set NPM_REG=--registry=https://registry.npmmirror.com
)

echo.
echo [1/2] 安装依赖...
call npm install %NPM_REG%
if errorlevel 1 ( echo [错误] 依赖安装失败 & pause & exit /b 1 )

echo.
echo [2/2] 打包 Windows 安装包和便携版...
call npm run dist
if errorlevel 1 (
  echo.
  echo [错误] 打包失败。常见原因：
  echo   - 提示 "Cannot create symbolic link"：在 Windows 设置里打开"开发者模式"，或用管理员身份运行本脚本
  echo   - 下载超时：重新运行并选择使用国内镜像
  pause & exit /b 1
)

echo.
echo 完成！安装包在 release 文件夹：
echo   aiflow-*-x64-nsis.exe      安装版（推荐，会创建桌面快捷方式）
echo   aiflow-*-x64-portable.exe  便携版（双击即用，不安装）
start "" "%~dp0release"
pause
