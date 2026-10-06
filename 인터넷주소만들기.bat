@echo off
rem 휴대폰 LTE/다른 와이파이에서도 열리는 임시 인터넷 주소를 만듭니다. (Cloudflare 무료 터널)
cd /d "%~dp0"

rem 1) 서버가 꺼져 있으면 먼저 켭니다
curl.exe -s -o NUL http://localhost:3000/
if not errorlevel 1 goto tunnel
echo 서버가 꺼져 있어서 먼저 켭니다. 새로 열리는 검은 창은 닫지 마세요...
start "" "%~dp0실행하기.bat"
:wait
timeout /t 3 >NUL
curl.exe -s -o NUL http://localhost:3000/
if errorlevel 1 goto wait

:tunnel
rem 2) 처음 한 번만 Cloudflare 터널 프로그램을 내려받습니다
if exist cloudflared.exe goto run
echo 처음 한 번 Cloudflare 터널 프로그램을 내려받습니다. 잠시 기다려 주세요...
curl.exe -L --fail -o cloudflared.exe https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
if errorlevel 1 goto dlfail

:run
echo.
echo ================================================================
echo  잠시 후 아래에 https://....trycloudflare.com 주소가 나옵니다.
echo  그 주소를 휴대폰 브라우저에 입력하세요. LTE에서도 열립니다.
echo  - 이 창을 닫으면 주소가 사라집니다. 쓰는 동안 열어 두세요.
echo  - 다시 실행하면 주소가 새로 바뀝니다.
echo ================================================================
echo.
cloudflared.exe tunnel --no-autoupdate --url http://localhost:3000 2>&1 | findstr /i "trycloudflare ERR failed"
pause
exit /b

:dlfail
if exist cloudflared.exe del cloudflared.exe
echo 내려받기에 실패했습니다. 인터넷 연결을 확인하고 다시 실행해 주세요.
pause
