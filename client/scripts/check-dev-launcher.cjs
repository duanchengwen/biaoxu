const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { NtExecutable, NtExecutableResource, Data, Resource } = require('resedit');
const { prepareDevLauncher } = require('./prepare-dev-launcher.cjs');

if (process.platform !== 'win32') {
  console.log('check-dev-launcher: skipped (Windows only)');
  process.exit(0);
}
const root = path.resolve(__dirname, '..');
const original = path.join(root, 'node_modules/electron/dist/electron.exe');
const hashFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const originalHash = hashFile(original);
const executablePath = prepareDevLauncher();
assert.notEqual(executablePath, original);
assert.equal(path.basename(executablePath), 'electron.exe', '保留 Electron 开发模式识别所需的文件名');
assert.equal(hashFile(original), originalHash, 'Electron 原运行时不得被改写');
const executable = NtExecutable.from(fs.readFileSync(executablePath));
const resources = NtExecutableResource.from(executable);
const expectedIcons = Data.IconFile.from(fs.readFileSync(path.join(root, 'assets/bidxu-icon.ico'))).icons;
const nativeIcons = resources.entries.filter(entry => entry.type === 3);
for (const icon of expectedIcons) {
  assert.ok(nativeIcons.some(entry => Buffer.from(entry.bin).equals(Buffer.from(icon.data.bin))),
    `启动文件缺少 ${icon.data.width}px 的标序图标`);
}
const versions = Resource.VersionInfo.fromEntries(resources.entries);
assert.ok(versions.length > 0);
for (const version of versions) {
  for (const language of version.getAvailableLanguages()) {
    const values = version.getStringValues(language);
    assert.equal(values.ProductName, '标序');
    assert.equal(values.FileDescription, '标序开发预览');
  }
}
const result = spawnSync(executablePath, ['-e', 'process.stdout.write(process.versions.electron)'], {
  cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
assert.equal(result.status, 0, result.stderr);
assert.equal(result.stdout, require('electron/package.json').version);
const modeEnvironment = { ...process.env };
delete modeEnvironment.ELECTRON_RUN_AS_NODE;
const modeResult = spawnSync(executablePath, [path.join(__dirname, 'profile-startup-modules.cjs')], {
  cwd: root, encoding: 'utf8', timeout: 30000, windowsHide: true,
  env: modeEnvironment,
});
assert.equal(modeResult.status, 0, modeResult.stderr);
assert.equal(JSON.parse(modeResult.stdout.trim()).developmentRuntime, true,
  '品牌开发入口不得被误判为安装包，否则 Word 助手和开发路径会失效');
const main = fs.readFileSync(path.join(root, 'electron/main.cjs'), 'utf8');
assert.match(main, /setAppUserModelId\('com\.openbidkit\.toubiaobao'\)/);
assert.match(main, /show: false/);
assert.match(main, /once\('ready-to-show'/);
console.log('check-dev-launcher: PASS（独立启动图标、原运行时未改、Electron 版本与窗口身份一致）');
