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

echo.
echo Dang khoi dong dashboard API (cong 8080)...
netstat -ano | findstr /R /C:":8080 .*LISTENING" >nul
if errorlevel 1 (
  start "api-dashboard" /min cmd /c "node packages/api/src/server.js > logs\api-out.log 2> logs\api-error.log"
  timeout /t 3 /nobreak >nul
) else (
  echo API dang chay san tren cong 8080, giu nguyen.
)

echo Dang mo public link (Cloudflare quick tunnel)...
taskkill /IM cloudflared.exe /F >nul 2>&1
start "cloudflared-tunnel" /min cmd /c ""C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:8080 > logs\cloudflared.log 2>&1"

set PUBLIC_URL=
for /l %%i in (1,1,20) do (
  if not defined PUBLIC_URL (
    timeout /t 2 /nobreak >nul
    for /f "delims=" %%u in ('powershell -NoProfile -Command "(Select-String -Path logs\cloudflared.log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1).Matches.Value"') do set PUBLIC_URL=%%u
  )
)

echo.
if defined PUBLIC_URL (
  echo ==========================================================
  echo  Dashboard local : http://localhost:8080
  echo  Dashboard public: %PUBLIC_URL%
  echo ==========================================================
  echo CANH BAO: link public khong co mat khau, ai co link deu doi duoc cau hinh va reset agent.
) else (
  echo LOI: chua lay duoc public link. Xem logs\cloudflared.log
)

pause
