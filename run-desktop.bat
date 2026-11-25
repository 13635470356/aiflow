@echo off
chcp 65001 >nul
cd /d "%~dp0"
title aiflow
if not exist node_modules\electron (
  echo 首次运行需要安装 Electron，请稍候...
  call npm install
)
call npx electron .
