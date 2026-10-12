@echo off
rem Restart local Master Leeter dev servers (API :4000, web :3000).
cd /d "%~dp0.."
echo Stopping anything listening on ports 3000 and 4000...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3000,4000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"
echo Starting API...
start "Master Leeter API" cmd /k "pnpm dev:api"
timeout /t 4 /nobreak >nul
echo Starting web...
start "Master Leeter Web" cmd /k "pnpm dev:web"
echo Done. Open http://localhost:3000 once both windows say they are ready.
timeout /t 5 >nul
