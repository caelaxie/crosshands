@echo off
setlocal EnableExtensions EnableDelayedExpansion
if not defined VSCMD_VER (
  set "VSINSTALL=%ProgramFiles%\Microsoft Visual Studio\2022\Enterprise"
  if not exist "!VSINSTALL!\VC\Auxiliary\Build\vcvars64.bat" set "VSINSTALL=%ProgramFiles%\Microsoft Visual Studio\2022\Professional"
  if not exist "!VSINSTALL!\VC\Auxiliary\Build\vcvars64.bat" set "VSINSTALL=%ProgramFiles%\Microsoft Visual Studio\2022\Community"
  if not exist "!VSINSTALL!\VC\Auxiliary\Build\vcvars64.bat" set "VSINSTALL=%ProgramFiles%\Microsoft Visual Studio\2022\BuildTools"
  if not exist "!VSINSTALL!\VC\Auxiliary\Build\vcvars64.bat" set "VSINSTALL="
  if not defined VSINSTALL (
    set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
    if not exist "!VSWHERE!" set "VSWHERE=%ProgramFiles%\Microsoft Visual Studio\Installer\vswhere.exe"
    if not exist "!VSWHERE!" set "VSWHERE=%ChocolateyInstall%\bin\vswhere.exe"
    if not exist "!VSWHERE!" (
      echo Visual Studio Build Tools discovery is unavailable. 1>&2
      exit /b 2
    )
    for /f "usebackq delims=" %%I in (`"!VSWHERE!" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSINSTALL=%%I"
  )
  if not defined VSINSTALL (
    echo Visual Studio x64 C++ build tools are unavailable. 1>&2
    exit /b 2
  )
  call "!VSINSTALL!\VC\Auxiliary\Build\vcvars64.bat" >nul
  if errorlevel 1 exit /b !ERRORLEVEL!
)
if not exist "%~dp0..\..\..\packages\platform-windows\assets" (
  echo Platform assets directory is missing. 1>&2
  exit /b 3
)
cl.exe /nologo /W4 /WX /O2 /Brepro /guard:cf /DUNICODE /D_UNICODE /EHsc /std:c++17 ^
  "%~dp0pipe_relay.cpp" /link /DYNAMICBASE /NXCOMPAT /HIGHENTROPYVA ^
  /OUT:"%~dp0..\..\..\packages\platform-windows\assets\crosshands-pipe-relay.exe" ^
  advapi32.lib
exit /b %ERRORLEVEL%
