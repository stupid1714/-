@echo off
rem 휴대폰(같은 와이파이)에서 접속할 수 있도록 Windows 방화벽에서 3000번 포트를 허용합니다.
rem 관리자 권한이 필요해서, 권한이 없으면 스스로 관리자 권한으로 다시 실행합니다.
net session >nul 2>&1
if not errorlevel 1 goto admin
echo 관리자 권한 확인 창이 뜨면 [예]를 눌러 주세요...
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
exit /b

:admin
netsh advfirewall firewall delete rule name="StudyManager 3000" >nul 2>&1
netsh advfirewall firewall add rule name="StudyManager 3000" dir=in action=allow protocol=TCP localport=3000 profile=any
if errorlevel 1 goto fail
echo.
echo 완료! 이제 휴대폰에서 접속할 수 있습니다.
echo 서버를 켠 뒤, 검은 창에 ★ 표시된 주소를 휴대폰 브라우저에 입력하세요.
echo.
pause
exit /b

:fail
echo 방화벽 설정에 실패했습니다. 이 화면을 캡처해서 보내 주세요.
pause
