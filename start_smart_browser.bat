@echo off
setlocal

set "URL=https://i.alibaba.com/"
set "PROFILE=%LOCALAPPDATA%\AlibabaCustomerDevAssistantSmartChrome"
set "BROWSER="

if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"

if not defined BROWSER (
  echo Could not find Chrome or Edge.
  pause
  exit /b 1
)

start "" "%BROWSER%" --remote-debugging-port=9222 --force-renderer-accessibility --user-data-dir="%PROFILE%" "%URL%"
endlocal
