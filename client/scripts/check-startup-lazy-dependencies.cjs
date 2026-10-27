const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app } = require('electron');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bidxu-lazy-qa-'));
app.setPath('userData', temporary);
app.on('quit', () => fs.rmSync(temporary, { recursive: true, force: true }));
process.on('uncaughtException', error => {
  console.error(error.stack || error.message);
  app.exit(1);
});

const originalLoad = Module._load;
const loaded = [];
Module._load = function load(request, parent, isMain) {
  loaded.push(request);
  return originalLoad.call(this, request, parent, isMain);
};

try {
  require('../electron/services/duplicateCheckService.cjs');
  const report = require('../electron/services/checkResultExportService.cjs').__test__;
  assert.ok(!loaded.includes('pdf-parse'), '打开应用不应加载 PDF 解析器及其原生画布依赖');
  assert.ok(!loaded.includes('xlsx'), '打开应用不应加载 Excel 导出器');

  const workbook = report.buildRejectionWorkbook({}, {}, { exportedAt: '2026-10-27T00:00:00Z' });
  const bytes = report.workbookToBuffer(workbook);
  assert.ok(loaded.includes('xlsx'), '实际导出时应按需加载 Excel');
  const XLSX = require('xlsx');
  const reopened = XLSX.read(bytes, { type: 'buffer' });
  assert.deepEqual(reopened.SheetNames, ['检查概览', '废标项', '错别字', '逻辑问题']);
  assert.equal(reopened.Sheets['检查概览'].A1.v, '导出时间');

  const pdfServiceSource = require('node:fs').readFileSync(path.join(__dirname, '../electron/services/duplicateCheckService.cjs'), 'utf8');
  assert.match(pdfServiceSource, /async function extractPdfMetadata\(filePath\)\s*\{[\s\S]*?const \{ PDFParse \} = require\('pdf-parse'\)/);
  console.log('check-startup-lazy-dependencies: PASS（启动不加载 PDF/Excel，首次 Excel 导出可正常读回）');
} finally {
  Module._load = originalLoad;
}
app.exit(0);
