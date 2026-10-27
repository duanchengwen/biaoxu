// 纯本地品牌/资产契约检查：不启动客户端、不读取用户数据、不调用模型。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const metadata = JSON.parse(read('package.json'));

assert.equal(metadata.build.productName, '标序');
assert.equal(metadata.build.appId, 'com.openbidkit.toubiaobao', '改显示名称不能更换历史应用身份');
assert.equal(metadata.name, 'openbidkit-toubiaobao');
assert.equal(metadata.build.win.icon, 'assets/bidxu-icon.ico');
assert.equal(metadata.build.mac.icon, 'assets/bidxu-icon.icns');
assert.match(read('index.html'), /<title>标序<\/title>/);
assert.match(read('electron/main.cjs'), /app\.setName\('标序'\)/);
assert.match(read('electron/main.cjs'), /app\.setPath\('userData', path\.join\(app\.getPath\('appData'\), 'OpenBidKit-TouBiaoBao'\)\)/);
assert.match(read('electron/main.cjs'), /title: '标序'/);
assert.match(read('electron/main.cjs'), /assets\/bidxu-icon\.ico/);
assert.match(read('electron/preload.cjs'), /appName: '标序'/);
assert.match(read('electron/preload.cjs'), /exposeInMainWorld\('yibiao'/);
assert.match(read('src/components/Sidebar.tsx'), /bidxu-mark\.svg/);
assert.match(read('src/components/Sidebar.tsx'), /<strong>标序<\/strong>/);
assert.doesNotMatch(read('src/components/Sidebar.tsx'), /易标增强版|<span>投标宝/);

for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  const png = fs.readFileSync(path.join(root, 'assets', `bidxu-icon-${size}.png`));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16), size);
  assert.equal(png.readUInt32BE(20), size);
}
const ico = fs.readFileSync(path.join(root, 'assets', 'bidxu-icon.ico'));
assert.equal(ico.readUInt16LE(0), 0);
assert.equal(ico.readUInt16LE(2), 1);
assert.equal(ico.readUInt16LE(4), 7);
for (let i = 0; i < 7; i++) {
  const entry = 6 + i * 16;
  const size = ico[entry] || 256;
  const bytes = ico.readUInt32LE(entry + 8);
  const offset = ico.readUInt32LE(entry + 12);
  assert.ok(offset >= 118 && offset + bytes <= ico.length);
  assert.equal(ico.readUInt32BE(offset + 16), size);
  assert.equal(ico.readUInt32BE(offset + 20), size);
}
const icns = fs.readFileSync(path.join(root, 'assets', 'bidxu-icon.icns'));
assert.equal(icns.toString('ascii', 0, 4), 'icns');
assert.equal(icns.readUInt32BE(4), icns.length);
let cursor = 8;
let chunks = 0;
while (cursor < icns.length) {
  const length = icns.readUInt32BE(cursor + 4);
  assert.ok(length > 8 && cursor + length <= icns.length);
  cursor += length; chunks++;
}
assert.equal(cursor, icns.length);
assert.equal(chunks, 7);
const launcher = fs.readFileSync(path.join(root, '..', '开发预览-标序.cmd'), 'utf8');
assert.match(launcher, /ELECTRON_RENDERER_URL=/);
assert.match(launcher, /start "标序 - 开发预览" \/D "%CLIENT_DIR%" "%ELECTRON_EXE%" "\."/);
assert.doesNotMatch(launcher, /taskkill|Stop-Process|npm run dist/);
console.log('check-bidxu-brand: PASS（新品牌、历史身份不迁移、PNG/ICO/ICNS和开发入口）');
