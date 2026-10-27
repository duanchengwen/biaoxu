const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { finished } = require('node:stream/promises');

const clientRoot = path.resolve(__dirname, '..');
const releaseRoot = path.join(clientRoot, 'release', 'win-unpacked');
const electronDist = path.join(clientRoot, 'node_modules', 'electron', 'dist');
const lockfilePath = path.join(clientRoot, 'package-lock.json');
const MAX_ASAR_BUFFER_CACHE_BYTES = 512 * 1024 * 1024;
const MAX_CACHED_FILE_BYTES = 8 * 1024 * 1024;
let asarBufferCacheBytes = 0;
let asarFirstReadCount = 0;
let asarWriteReadCount = 0;

function assertFile(filePath, description) {
  if (!fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`${description}缺失：${filePath}`);
  }
}

function assertPathWithin(parentPath, targetPath, description) {
  const parent = path.resolve(parentPath);
  const target = path.resolve(targetPath);
  if (target === parent || !target.startsWith(`${parent}${path.sep}`)) {
    throw new Error(`${description}不在预期输出目录内，已停止：${target}`);
  }
}

function collectProductionModuleRoots() {
  const lockfile = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
  if (!lockfile.packages || typeof lockfile.packages !== 'object') {
    throw new Error('package-lock.json 不含 packages 清单，无法安全收集生产依赖');
  }

  const prefix = 'node_modules/';
  const installedProductionModules = Object.entries(lockfile.packages)
    .filter(([relativePath, metadata]) => relativePath.startsWith(prefix) && metadata?.dev !== true)
    .map(([relativePath]) => relativePath.slice(prefix.length))
    .filter((relativePath) => {
      const absolutePath = path.resolve(clientRoot, prefix, relativePath);
      const expectedRoot = `${path.resolve(clientRoot, 'node_modules')}${path.sep}`;
      return absolutePath.startsWith(expectedRoot) && fs.existsSync(absolutePath);
    })
    .sort();

  // 每个最外层生产包单独扫描一次，只需一个 **/* 模式；避免在整个 node_modules
  // 文件树上逐文件匹配数百条包名 glob。npm 不会安装依赖包自身的 devDependencies，
  // 因此包内嵌套 node_modules 可随其最外层生产包一并收集。
  const outermostModules = installedProductionModules.filter((relativePath) => (
    !installedProductionModules.some((candidate) => (
      candidate !== relativePath && relativePath.startsWith(`${candidate}/node_modules/`)
    ))
  ));
  return outermostModules;
}

function collectAsarStreams(sourceRoot, destinationRoot, streams) {
  const pending = [{ source: sourceRoot, destination: destinationRoot }];
  while (pending.length) {
    const current = pending.pop();
    const stat = fs.lstatSync(current.source);
    if (stat.isSymbolicLink()) {
      streams.push({
        type: 'link',
        path: current.destination,
        stat,
        unpacked: false,
        symlink: fs.readlinkSync(current.source),
        streamGenerator: () => fs.createReadStream(current.source),
      });
      continue;
    }
    if (stat.isDirectory()) {
      const children = fs.readdirSync(current.source).sort().reverse();
      for (const name of children) {
        pending.push({
          source: path.join(current.source, name),
          destination: path.posix.join(current.destination, name),
        });
      }
      continue;
    }
    if (!stat.isFile()) continue;
    const extension = path.extname(current.source).toLowerCase();
    let cachedContent;
    let streamRequestCount = 0;
    const streamGenerator = stat.size <= MAX_CACHED_FILE_BYTES
      ? () => {
          streamRequestCount += 1;
          if (streamRequestCount === 1) {
            asarFirstReadCount += 1;
            if (asarFirstReadCount % 2000 === 0) console.log(`ASAR 完整性读取：${asarFirstReadCount} 个文件`);
          } else {
            asarWriteReadCount += 1;
            if (asarWriteReadCount % 2000 === 0) console.log(`ASAR 写入读取：${asarWriteReadCount} 个文件`);
          }
          if (!cachedContent && asarBufferCacheBytes + stat.size <= MAX_ASAR_BUFFER_CACHE_BYTES) {
            cachedContent = fs.readFileSync(current.source);
            asarBufferCacheBytes += cachedContent.length;
          }
          return Readable.from([cachedContent || fs.readFileSync(current.source)]);
        }
      : () => {
          streamRequestCount += 1;
          if (streamRequestCount === 1) {
            asarFirstReadCount += 1;
            if (asarFirstReadCount % 2000 === 0) console.log(`ASAR 完整性读取：${asarFirstReadCount} 个文件`);
          } else {
            asarWriteReadCount += 1;
            if (asarWriteReadCount % 2000 === 0) console.log(`ASAR 写入读取：${asarWriteReadCount} 个文件`);
          }
          return fs.createReadStream(current.source);
        };
    streams.push({
      type: 'file',
      path: current.destination,
      stat,
      unpacked: extension === '.node' || extension === '.dll' || extension === '.exe',
      streamGenerator,
    });
  }
}

async function buildRuntimeAsar(productionModuleRoots) {
  const asar = require(path.join(clientRoot, 'node_modules', '@electron', 'asar'));
  const resourcesRoot = path.join(releaseRoot, 'resources');
  const appAsar = path.join(resourcesRoot, 'app.asar');
  const nextAsar = path.join(resourcesRoot, 'app.asar.next');
  const nextUnpacked = `${nextAsar}.unpacked`;
  const unpacked = `${appAsar}.unpacked`;
  assertPathWithin(releaseRoot, resourcesRoot, '资源目录');
  assertPathWithin(releaseRoot, nextUnpacked, '临时原生依赖目录');
  assertPathWithin(releaseRoot, unpacked, '原生依赖目录');
  fs.rmSync(nextAsar, { force: true });
  fs.rmSync(nextUnpacked, { recursive: true, force: true });

  const streams = [];
  for (const name of ['dist', 'electron', 'assets']) {
    collectAsarStreams(path.join(clientRoot, name), name, streams);
  }
  collectAsarStreams(path.join(clientRoot, 'package.json'), 'package.json', streams);
  for (const relativePath of productionModuleRoots) {
    collectAsarStreams(
      path.join(clientRoot, 'node_modules', ...relativePath.split('/')),
      path.posix.join('node_modules', relativePath),
      streams,
    );
  }
  streams.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const totalBytes = streams.reduce((total, stream) => total + (stream.stat?.size || 0), 0);
  console.log(`正在写入 app.asar：${streams.length} 个应用与生产依赖文件，共 ${(totalBytes / 1024 / 1024).toFixed(1)} MiB。`);
  const output = await asar.createPackageFromStreams(nextAsar, streams);
  if (!output.writableFinished) await finished(output);
  console.log(`ASAR 小文件缓存峰值：${(asarBufferCacheBytes / 1024 / 1024).toFixed(1)} MiB。`);

  fs.rmSync(appAsar, { force: true });
  fs.rmSync(unpacked, { recursive: true, force: true });
  fs.renameSync(nextAsar, appAsar);
  if (fs.existsSync(nextUnpacked)) fs.renameSync(nextUnpacked, unpacked);
}

async function refreshWindowsAsarIntegrity() {
  const executablePath = path.join(releaseRoot, 'TouBiaoBao.exe');
  const resourcesRoot = path.join(releaseRoot, 'resources');
  const { computeData } = require(path.join(clientRoot, 'node_modules', 'app-builder-lib', 'out', 'asar', 'integrity.js'));
  const { addWinAsarIntegrity } = require(path.join(clientRoot, 'node_modules', 'app-builder-lib', 'out', 'electron', 'electronWin.js'));
  const resedit = require(path.join(clientRoot, 'node_modules', 'resedit'));
  const executable = resedit.NtExecutable.from(fs.readFileSync(executablePath));
  const resource = resedit.NtExecutableResource.from(executable);
  resource.entries = resource.entries.filter((entry) => !(entry.type === 'INTEGRITY' && entry.id === 'ELECTRONASAR'));
  resource.outputResource(executable);
  fs.writeFileSync(executablePath, Buffer.from(executable.generate()));

  const asarIntegrity = await computeData({
    resourcesPath: resourcesRoot,
    resourcesRelativePath: 'resources',
    resourcesDestinationPath: resourcesRoot,
    extraResourceMatchers: [],
  });
  await addWinAsarIntegrity(executablePath, asarIntegrity);
}

function verifyPackage() {
  const resourcesRoot = path.join(releaseRoot, 'resources');
  const appAsar = path.join(resourcesRoot, 'app.asar');
  assertFile(path.join(releaseRoot, 'TouBiaoBao.exe'), '便携版主程序');
  assertFile(appAsar, '应用资源包');
  assertFile(
    path.join(resourcesRoot, 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
    'Electron ABI 原生 SQLite 模块',
  );

  for (const name of ['LICENSE-OpenBidKit.txt', 'NOTICE-OpenBidKit.txt', '二次开发交付说明.txt', '投标宝-使用说明.md']) {
    assertFile(path.join(releaseRoot, name), `交付文件 ${name}`);
  }
  for (const name of ['rg.exe', 'fd.exe', 'jq.exe']) {
    assertFile(path.join(resourcesRoot, 'agent-tools', 'win32-x64', 'bin', name), `代理工具 ${name}`);
  }
  assertFile(path.join(resourcesRoot, 'agent-tools', 'win32-x64', 'manifest.json'), '代理工具清单');
  assertFile(path.join(resourcesRoot, 'openxml-tools', 'win32-x64', 'openxmlhelper.exe'), 'OpenXML 助手');
  assertFile(path.join(resourcesRoot, 'openxml-tools', 'win32-x64', 'dotnet-runtime', 'dotnet.exe'), '应用私有 .NET 运行时');

  const asar = require(path.join(clientRoot, 'node_modules', '@electron', 'asar'));
  asar.uncache(appAsar);
  const entries = asar.listPackage(appAsar).map((entry) => entry.replaceAll('\\', '/'));
  const requireAsarEntry = (suffix, description) => {
    if (!entries.some((entry) => entry.endsWith(suffix))) {
      throw new Error(`app.asar 中${description}缺失：${suffix}`);
    }
  };
  requireAsarEntry('/node_modules/better-sqlite3/package.json', '生产依赖');
  requireAsarEntry('/electron/services/blindCheckImageText.cjs', '图片 OCR 服务');
  requireAsarEntry('/electron/shared/pageBudget.mjs', '共享篇幅预算模块');
  requireAsarEntry('/dist/index.html', '渲染页面');

  const ocrService = asar.extractFile(appAsar, path.join('electron', 'services', 'blindCheckImageText.cjs')).toString('utf8');
  if (!ocrService.includes("fs.readFileSync(path.join(__dirname, 'blindCheckWindowsOcr.ps1'))")) {
    throw new Error('app.asar 未包含打包态 OCR 脚本实体化逻辑');
  }

  const rendererBundles = entries.filter((entry) => /\/dist\/assets\/index-[^/]+\.js$/u.test(entry));
  const rendererText = rendererBundles
    .map((entry) => asar.extractFile(appAsar, entry.replace(/^\//u, '').replaceAll('/', path.sep)).toString('utf8'))
    .join('\n');
  for (const marker of ['标书文件篇幅优化', '按页数', '按字数']) {
    if (!rendererText.includes(marker)) throw new Error(`渲染包缺少最新篇幅界面标记：${marker}`);
  }

  const stats = fs.statSync(appAsar);
  console.log(`本地 Windows 便携版已生成：${releaseRoot}`);
  console.log(`app.asar ${(stats.size / 1024 / 1024).toFixed(1)} MiB，生产依赖、原生模块、OCR、OpenXML 工具与交付文件均已核验。`);
  console.warn('提示：本地交付包未做代码签名，且为避免联网下载 rcedit，Windows 文件属性仍显示 Electron 元数据。');
}

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isFinite(major) || major < 24) {
    throw new Error(`本地打包要求 Node.js 24 或更高版本，当前为 ${process.version}`);
  }
  assertFile(path.join(electronDist, 'electron.exe'), '本地 Electron 运行时');
  assertFile(lockfilePath, '依赖锁文件');

  if (process.argv.includes('--verify-existing')) {
    await refreshWindowsAsarIntegrity();
    verifyPackage();
    return;
  }

  const productionModuleRoots = collectProductionModuleRoots();
  if (!productionModuleRoots.length) throw new Error('没有找到已安装的生产依赖');
  console.log(`正在打包 ${productionModuleRoots.length} 个最外层生产依赖目录；不联网、不发布、不修改系统策略。`);

  const { Arch, Platform, build } = require(path.join(clientRoot, 'node_modules', 'electron-builder'));
  await build({
    projectDir: clientRoot,
    targets: Platform.WINDOWS.createTarget(['dir'], Arch.x64),
    publish: 'never',
    config: {
      electronDist,
      // 必须保留 true，让 beforeBuild(false) 将依赖标记为“由本脚本处理”；
      // 若直接设为 false，electron-builder 会跳过 hook 并再次慢速枚举依赖。
      npmRebuild: true,
      nodeGypRebuild: false,
      beforeBuild: async () => false,
      files: [
        'dist/**/*',
        'electron/**/*',
        'assets/**/*',
        'package.json',
      ],
      win: {
        signAndEditExecutable: false,
      },
    },
  });

  await buildRuntimeAsar(productionModuleRoots);
  await refreshWindowsAsarIntegrity();
  verifyPackage();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
