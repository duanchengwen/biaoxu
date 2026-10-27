@echo off
setlocal
chcp 65001 >nul
set "APP_ROOT=%~dp0"
set "CLIENT_DIR=%APP_ROOT%client"
set "ELECTRON_SOURCE=%CLIENT_DIR%\node_modules\electron\dist\electron.exe"
set "ELECTRON_EXE=%CLIENT_DIR%\node_modules\electron\dist\bidxu-dev-runtime\electron.exe"
set "PACKAGED_EXE=%CLIENT_DIR%\release\win-unpacked\TouBiaoBao.exe"
set "ELECTRON_RUN_AS_NODE="
set "ELECTRON_RENDERER_URL="

if not exist "%CLIENT_DIR%\dist\index.html" (
  echo [标序] 尚未构建开发页面，请先在 client 中运行 npm run build。
  pause
  exit /b 1
)
if not exist "%ELECTRON_SOURCE%" (
  echo [标序] 缺少本项目的 Electron 开发运行时。
  pause
  exit /b 1
)

rem 不强制结束旧客户端，防止两个实例同时修改相同工作区。
powershell.exe -NoProfile -NonInteractive -Command "$paths=@('%ELECTRON_EXE%','%ELECTRON_SOURCE%','%CLIENT_DIR%\node_modules\electron\dist\Bidxu-dev.exe','%PACKAGED_EXE%'); $running=Get-CimInstance Win32_Process -ErrorAction Stop; foreach ($item in $running) { if ($paths -contains $item.ExecutablePath) { exit 23 } }"
if errorlevel 1 (
  echo [标序] 请先保存任务并关闭此工程已打开的投标宝或标序窗口，再启动开发预览。
  echo 此检查不会关闭其他目录中的程序，也不会修改数据。
  pause
  exit /b 1
)

node "%CLIENT_DIR%\scripts\prepare-dev-launcher.cjs"
if errorlevel 1 (
  echo [标序] 无法准备开发启动图标，请保留上述错误信息。
  pause
  exit /b 1
)

rem 优先使用本工作区已有的私有 SDK，不修改系统环境或执行策略。
set "PREVIEW_DOTNET=%APP_ROOT%..\.qa\dotnet10"
if exist "%PREVIEW_DOTNET%\sdk" (
  set "DOTNET_ROOT=%PREVIEW_DOTNET%"
  set "PATH=%PREVIEW_DOTNET%;%PATH%"
)

echo [标序] 正在启动最新开发页面，不读取旧 release 的页面，不执行打包。
start "标序 - 开发预览" /D "%CLIENT_DIR%" "%ELECTRON_EXE%" "."
if errorlevel 1 (
  echo [标序] 开发预览启动失败。
  pause
  exit /b 1
)
endlocal
