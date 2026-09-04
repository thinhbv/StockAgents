@echo off
setlocal
cd /d "%~dp0"

echo Dang khoi dong lai cac dich vu PM2 (data-service, telegram-bot)...
call pm2 restart ecosystem.config.cjs --update-env

if errorlevel 1 (
  echo.
  echo LOI: pm2 restart that bai. Kiem tra pm2 co dang chay khong ^(pm2 list^).
  pause
  exit /b 1
)

echo.
echo Xong. Trang thai hien tai:
call pm2 list

pause
