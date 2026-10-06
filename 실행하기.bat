@echo off
rem 이 파일이 있는 폴더(프로그램 폴더)로 이동
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

if exist node_modules goto run
echo 처음 실행입니다. 필요한 파일을 설치합니다. 1~2분 걸릴 수 있습니다...
call npm install
if errorlevel 1 goto fail

:run
echo.
echo 서버를 시작합니다. 잠시 후 브라우저가 열립니다.
echo 이 창을 닫으면 서버가 꺼집니다. 사용하는 동안 열어 두세요.
echo.
start "" cmd /c "timeout /t 3 >nul & start http://localhost:3000"
call npm start
pause
exit /b

:nonode
echo Node.js가 설치되어 있지 않습니다.
echo https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요.
pause
exit /b

:fail
echo 설치 중 오류가 났습니다. 위의 메시지를 복사해서 보내 주세요.
pause
