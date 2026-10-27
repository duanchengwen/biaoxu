const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLIENT_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(CLIENT_ROOT, '..');
const PROJECT_PATH = path.join(REPO_ROOT, 'openxmlhelper', 'src', 'OpenXmlHelper', 'OpenXmlHelper.csproj');
const VENDOR_ROOT = path.join(CLIENT_ROOT, 'vendor', 'openxml-tools');

const RID_BY_KEY = {
  'win32-x64': 'win-x64',
  'darwin-x64': 'osx-x64',
  'darwin-arm64': 'osx-arm64',
};

function readArg(name, fallback = '') {
  const prefix = `${name}=`;
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((item) => item.startsWith(prefix));
  return inline ? inline.slice(prefix.length) : fallback;
}

function executableName(platform) {
  return platform === 'win32' ? 'openxmlhelper.exe' : 'openxmlhelper';
}

/** 展开目标架构；macOS 本地打包默认同时准备 Intel 与 Apple Silicon。 */
function resolveTargetArches(platform, arch) {
  if (arch !== 'all') return [arch];
  const prefix = `${platform}-`;
  const arches = Object.keys(RID_BY_KEY)
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));
  if (!arches.length) {
    throw new Error(`不支持发布全部架构的平台：${platform}`);
  }
  return arches;
}

function runDotnet(args) {
  execFileSync('dotnet', args, {
    cwd: REPO_ROOT,
    windowsHide: true,
    shell: false,
    stdio: 'inherit',
    timeout: 180000,
    env: {
      ...process.env,
      DOTNET_NOLOGO: '1',
    },
  });
}

function hasCachedWindowsRuntimePack() {
  const packages = process.env.NUGET_PACKAGES || path.join(os.homedir(), '.nuget', 'packages');
  const root = path.join(packages, 'microsoft.netcore.app.runtime.win-x64');
  if (!fs.existsSync(root)) return false;
  return fs.readdirSync(root).some(version => fs.existsSync(path.join(
    root, version, 'runtimes', 'win-x64', 'lib', 'net10.0', 'System.Private.CoreLib.dll',
  )));
}

function resolveLocalDotnetRuntime() {
  const output = execFileSync('dotnet', ['--list-runtimes'], {
    cwd: REPO_ROOT,
    windowsHide: true,
    shell: false,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, DOTNET_NOLOGO: '1' },
  });
  const runtimes = String(output).split(/\r?\n/).flatMap(line => {
    const match = /^Microsoft\.NETCore\.App\s+(10\.\d+\.\d+)\s+\[(.+)]$/.exec(line.trim());
    return match ? [{ version: match[1], sharedRoot: match[2] }] : [];
  });
  const selected = runtimes.at(-1);
  if (!selected) throw new Error('没有找到可局部部署的 Microsoft.NETCore.App 10.x 运行时');
  const root = path.resolve(selected.sharedRoot, '..', '..');
  const runtimeDir = path.join(selected.sharedRoot, selected.version);
  const hostDir = path.join(root, 'host');
  if (!fs.existsSync(runtimeDir) || !fs.existsSync(hostDir) || !fs.existsSync(path.join(root, 'dotnet.exe'))) {
    throw new Error(`.NET 10 运行时文件不完整：${root}`);
  }
  return { root, runtimeDir };
}

function publishFrameworkDependentWindows(outputDir) {
  const runtime = resolveLocalDotnetRuntime();
  // Clean 只清理本工程的 Release 中间产物，保证 apphost 写入本次私有 runtime 相对路径。
  runDotnet(['clean', PROJECT_PATH, '-c', 'Release', '-v', 'minimal']);
  runDotnet([
    'publish', PROJECT_PATH,
    '-c', 'Release',
    '--self-contained', 'false',
    '-p:RestoreIgnoreFailedSources=true',
    '-p:NuGetAudit=false',
    '-p:AppHostDotNetSearch=AppRelative',
    '-p:AppHostRelativeDotNet=dotnet-runtime',
    '-o', outputDir,
  ]);

  const privateRoot = path.join(outputDir, 'dotnet-runtime');
  fs.mkdirSync(path.join(privateRoot, 'shared', 'Microsoft.NETCore.App'), { recursive: true });
  fs.cpSync(path.join(runtime.root, 'host'), path.join(privateRoot, 'host'), { recursive: true, force: true });
  fs.cpSync(runtime.runtimeDir, path.join(privateRoot, 'shared', 'Microsoft.NETCore.App', path.basename(runtime.runtimeDir)), { recursive: true, force: true });
  for (const fileName of ['dotnet.exe', 'LICENSE.txt', 'ThirdPartyNotices.txt']) {
    const source = path.join(runtime.root, fileName);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(privateRoot, fileName));
  }
}

/** 优先发布自包含单文件；Windows runtime pack 不完整时发布源码产物并附应用私有运行时。 */
function publishTarget(platform, arch) {
  const key = `${platform}-${arch}`;
  const rid = RID_BY_KEY[key];
  if (!rid) {
    throw new Error(`不支持的 Open XML 助手平台：${key}`);
  }
  if (!fs.existsSync(PROJECT_PATH)) {
    throw new Error(`找不到 Open XML 助手工程：${PROJECT_PATH}`);
  }

  const outputDir = path.join(VENDOR_ROOT, key);
  fs.mkdirSync(outputDir, { recursive: true });

  if (platform === 'win32' && !hasCachedWindowsRuntimePack()) {
    console.warn('未找到完整的 win-x64 self-contained runtime pack，改为发布当前源码并附带应用私有 .NET 10 运行时。');
    publishFrameworkDependentWindows(outputDir);
  } else {
    try {
      runDotnet([
        'publish', PROJECT_PATH,
        '-c', 'Release',
        '-r', rid,
        '--self-contained', 'true',
        '-p:PublishSingleFile=true',
        '-p:IncludeNativeLibrariesForSelfExtract=true',
        '-p:PublishTrimmed=false',
        '-p:RestoreIgnoreFailedSources=true',
        '-p:NuGetAudit=false',
        '-o', outputDir,
      ]);
    } catch (error) {
      if (platform !== 'win32') throw error;
      console.warn('自包含单文件发布失败，改为发布当前源码并附带应用私有 .NET 10 运行时。');
      publishFrameworkDependentWindows(outputDir);
    }
  }

  const exePath = path.join(outputDir, executableName(platform));
  if (!fs.existsSync(exePath)) {
    throw new Error(`发布后未找到助手程序：${exePath}`);
  }
  if (platform !== 'win32') {
    fs.chmodSync(exePath, 0o755);
  }
  console.log(`Open XML helper published: ${exePath}`);
}

function main() {
  const platform = readArg('--platform', process.platform);
  const arch = readArg('--arch', platform === 'darwin' ? 'all' : process.arch);
  for (const targetArch of resolveTargetArches(platform, arch)) {
    publishTarget(platform, targetArch);
  }
}

try {
  main();
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
}
