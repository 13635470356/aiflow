@echo off
chcp 65001 >nul
cd /d "%~dp0"
title aiflow 网页版（关闭此窗口即退出）
node bin\aiflow.js ui
pause
