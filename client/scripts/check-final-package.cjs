// 使用与交付版同版本的 Electron，在隔离临时目录检查最终 ASAR。
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { app, nativeImage } = require('electron');

const sourceRoot = path.resolve(__dirname, '..');
const packedRoot = path.resolve(process.env.YIBIAO_TEST_APP_ROOT || path.join(sourceRoot, 'release', 'win-unpacked', 'resources', 'app.asar'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), '投标宝-交付包检查-'));
app.setPath('userData', temp);
const hash = data => crypto.createHash('sha256').update(data).digest('hex');

async function run() {
  const packedRequire = createRequire(path.join(packedRoot, 'package.json'));
  const metadata = packedRequire('./package.json');
  assert.equal(metadata.name, 'openbidkit-toubiaobao');
  assert.equal(metadata.version, '0.2.0');
  for (const relative of [
    'electron/main.cjs', 'electron/preload.cjs', 'electron/shared/pageBudget.mjs',
    'electron/services/contentGenerationTask.cjs', 'electron/services/contentGenerationPages.cjs',
    'electron/services/contentGenerationNaturalize.cjs', 'electron/services/taskService.cjs',
    'electron/services/sqliteDatabase.cjs', 'electron/services/technicalPlanStore.cjs',
    'electron/services/blindCheckImageText.cjs', 'electron/services/blindCheckImageVision.cjs',
    'electron/services/blindCheckWindowsOcr.ps1', 'electron/services/blindCheckTask.cjs',
    'electron/services/blindCheckFixTask.cjs', 'dist/index.html',
  ]) {
    assert.equal(hash(fs.readFileSync(path.join(packedRoot, relative))), hash(fs.readFileSync(path.join(sourceRoot, relative))), `${relative} 与最新源码不一致`);
  }
  const Database = packedRequire('better-sqlite3');
  const db = new Database(':memory:');
  try { assert.equal(db.prepare('SELECT 42 AS result').get().result, 42); }
  finally { db.close(); }
  const budget = packedRequire('./electron/shared/pageBudget.mjs');
  assert.equal(budget.isPageCountAccepted(102, { mode: 'pages', targetPages: 100, minimumPages: 90, maximumPages: 110 }), true);
  for (const service of ['aiService', 'taskService', 'technicalPlanStore', 'blindCheckTask', 'blindCheckFixTask', 'openXmlHelperService']) {
    assert.ok(packedRequire(`./electron/services/${service}.cjs`), `${service} 无法从交付包加载`);
  }
  // 使用产品自身的 ESM 导入路径；这两个包仅提供 import 条件，不能用 CJS require.resolve。
  const pi = await packedRequire('./electron/services/pi/piSessionFactory.cjs').loadPiModules();
  assert.ok(pi.codingAgent && pi.piAi && pi.typebox);
  const bitmap = nativeImage.createFromBitmap(Buffer.alloc(4 * 4 * 4, 255), { width: 4, height: 4 });
  assert.equal(bitmap.isEmpty(), false);
  assert.ok(bitmap.toPNG().length > 0);
  console.log('check-final-package: PASS（最新源码哈希、原生 SQLite、核心服务、AI 生产依赖、页数范围与原生图像）');
}

app.whenReady().then(run).then(() => app.exit(0), error => {
  console.error(error?.stack || error);
  app.exit(1);
});
process.on('exit', () => {
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
});
