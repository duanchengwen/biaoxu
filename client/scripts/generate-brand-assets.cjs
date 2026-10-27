// 将代码原生品牌 SVG 渲染为 Electron/Windows/macOS 图标，不修改旧图标或用户数据。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, nativeImage } = require('electron');

const assets = path.resolve(__dirname, '..', 'assets');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bidxu-brand-assets-'));
app.setPath('userData', temp);
app.disableHardwareAcceleration();
let window;

async function run() {
  const svg = fs.readFileSync(path.join(assets, 'bidxu-mark.svg'), 'utf8');
  window = new BrowserWindow({ show: false, width: 256, height: 256,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html><body></body></html>'));
  const uri = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  const data = await window.webContents.executeJavaScript(`(async () => {
    const img = new Image(); img.src = ${JSON.stringify(uri)}; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 1024;
    canvas.getContext('2d').drawImage(img, 0, 0, 1024, 1024);
    return canvas.toDataURL('image/png').split(',')[1];
  })()`);
  const original = nativeImage.createFromBuffer(Buffer.from(data, 'base64'));
  assert.equal(original.isEmpty(), false);
  const pngs = new Map();
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    const png = original.resize({ width: size, height: size, quality: 'best' }).toPNG();
    assert.deepEqual(nativeImage.createFromBuffer(png).getSize(), { width: size, height: size });
    fs.writeFileSync(path.join(assets, `bidxu-icon-${size}.png`), png);
    pngs.set(size, png);
  }
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, i) => {
    const start = 6 + i * 16; const png = pngs.get(size);
    header[start] = size === 256 ? 0 : size; header[start + 1] = header[start];
    header.writeUInt16LE(1, start + 4); header.writeUInt16LE(32, start + 6);
    header.writeUInt32LE(png.length, start + 8); header.writeUInt32LE(offset, start + 12);
    offset += png.length;
  });
  fs.writeFileSync(path.join(assets, 'bidxu-icon.ico'), Buffer.concat([header, ...sizes.map(size => pngs.get(size))]));
  const chunks = [[16, 'icp4'], [32, 'icp5'], [64, 'icp6'], [128, 'ic07'], [256, 'ic08'], [512, 'ic09'], [1024, 'ic10']].map(([size, type]) => {
    const png = pngs.get(size); const chunk = Buffer.alloc(8);
    chunk.write(type, 0, 4, 'ascii'); chunk.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([chunk, png]);
  });
  const icnsHeader = Buffer.alloc(8); icnsHeader.write('icns');
  icnsHeader.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
  fs.writeFileSync(path.join(assets, 'bidxu-icon.icns'), Buffer.concat([icnsHeader, ...chunks]));
  console.log('BIDXU brand assets generated: SVG, 9 PNG sizes, ICO and ICNS.');
}

app.whenReady().then(run).then(() => app.exit(0), error => {
  console.error(error?.stack || error); app.exit(1);
});
process.on('exit', () => {
  try { window?.destroy(); } catch {}
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
});
