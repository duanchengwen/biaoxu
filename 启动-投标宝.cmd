@echo off
setlocal
chcp 65001 >nul

set "APP_ROOT=%~dp0"
set "CLIENT_DIR=%APP_ROOT%client"
set "PACKAGED_EXE=%CLIENT_DIR%\release\win-unpacked\TouBiaoBao.exe"
set "ELECTRON_EXE=%CLIENT_DIR%\node_modules\electron\dist\electron.exe"
set "ELECTRON_RENDERER_URL="
set "ELECTRON_RUN_AS_NODE="

if exist "%PACKAGED_EXE%" (
  start "投标宝·易标增强版" /D "%CLIENT_DIR%\release\win-unpacked" "%PACKAGED_EXE%"
  if errorlevel 1 (
    echo [投标宝] 便携版启动失败，请查看应用日志。
    pause
    exit /b 1
  )
  exit /b 0
)

if not exist "%CLIENT_DIR%\dist\index.html" (
  echo [投标宝] 未找到便携版或已构建页面。
  echo 正式使用请确认 client\release\win-unpacked\TouBiaoBao.exe 已完整解压。
  pause
  exit /b 1
)

if not exist "%ELECTRON_EXE%" (
  echo [投标宝] 未找到便携版；源码回退启动也缺少 Electron。
  echo 正式使用请重新获取完整的 win-unpacked 交付目录。
  pause
  exit /b 1
)

start "投标宝·易标增强版" /D "%CLIENT_DIR%" "%ELECTRON_EXE%" "."

if errorlevel 1 (
  echo [投标宝] 启动失败，请查看终端或应用日志。
  pause
  exit /b 1
)

endlocal
