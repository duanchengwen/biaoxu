// Windows.Media.Ocr + Electron nativeImage 真实接线烟雾测试（不调用用户 API）：
//   node_modules\.bin\electron.cmd scripts/check-blind-check-windows-ocr.cjs
// 默认只在 Windows 运行；生成高对比中文图片，验证真实 OCR 坐标和像素脱敏后复检。
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, nativeImage } = require('electron');
const AdmZip = require('adm-zip');
const sourceImplementation = require('../electron/services/blindCheckImageText.cjs');
const ocrUserData = fs.mkdtempSync(path.join(os.tmpdir(), '投标宝-OCR测试用户目录-'));
app.setPath('userData', ocrUserData);
process.once('exit', () => {
  try { fs.rmSync(ocrUserData, { recursive: true, force: true }); } catch {}
});

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const compact = (value) => String(value || '').normalize('NFKC').replace(/\s+/g, '');
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function renderTextImage() {
  // 隐藏 GUI 会话里 capturePage 偶发 UnknownVizError；用 Windows 自带 GDI+ 只生成
  // 高对比夹具，后续解码、像素修改和编码仍走 Electron nativeImage 的真实路径。
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '暗标OCR图片-'));
  try {
    const script = path.join(directory, 'render.ps1');
    const output = path.join(directory, 'fixture.png');
    const source = `param([string]$OutputPath)
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap(1200, 420)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.Clear([System.Drawing.Color]::White)
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $brush = [System.Drawing.Brushes]::Black
  $large = New-Object System.Drawing.Font('Microsoft YaHei', 88, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $small = New-Object System.Drawing.Font('Microsoft YaHei', 64, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  try {
    $graphics.DrawString('项目负责人：张伟', $large, $brush, 60, 45)
    $graphics.DrawString('施工方案　质量保证', $small, $brush, 60, 220)
    $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $large.Dispose(); $small.Dispose() }
} finally { $graphics.Dispose(); $bitmap.Dispose() }
`;
    fs.writeFileSync(script, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(source, 'utf8')]));
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const rendered = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-OutputPath', output], { encoding: 'utf8', windowsHide: true });
    assert.equal(rendered.status, 0, `无法生成 OCR 测试图片：${rendered.stderr || rendered.stdout}`);
    const png = fs.readFileSync(output);
    assert.equal(nativeImage.createFromBuffer(png).isEmpty(), false, 'Electron nativeImage 无法解码测试 PNG');
    return png;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function buildDocx(file, png) {
  const zip = new AdmZip();
  const drawing = '<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="图片 1" descr="技术示意图"/><a:graphic><a:graphicData><a:blip r:embed="rIdImage"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
  zip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${drawing}<w:sectPr/></w:body></w:document>`, 'utf8'));
  zip.addFile('word/_rels/document.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImage" Type="${REL}/image" Target="media/identity.png"/></Relationships>`, 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`, 'utf8'));
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', 'utf8'));
  zip.addFile('word/media/identity.png', png);
  zip.writeZip(file);
}

async function run(implementation = sourceImplementation, label = 'source') {
  const { collectImageTextFacts, redactImageTextCopy } = implementation;
  assert.equal(process.platform, 'win32', '该烟雾测试只用于 Windows.Media.Ocr');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '暗标Windows-OCR-'));
  try {
    const source = path.join(directory, '原始图片文字.docx');
    const output = path.join(directory, '图片文字脱敏.docx');
    buildDocx(source, await renderTextImage());
    const sourceHash = hash(source);
    const facts = await collectImageTextFacts(source);
    assert.equal(facts.length, 1);
    const before = facts[0];
    assert.equal(before.status, 'covered', `Windows OCR 未完成覆盖：${JSON.stringify(before)}`);
    assert.match(compact(before.text), /张伟/, `OCR 没识别到高对比姓名：${before.text}`);
    assert.match(compact(before.text), /施工方案|质量保证/, `OCR 没识别到复检保留文字：${before.text}`);
    assert.match(compact(before.regions.map((item) => item.text).join('')), /张伟/, `姓名必须有可修复坐标：${JSON.stringify(before.regions)}`);
    assert.ok(before.regions.filter((item) => /张|伟/.test(item.text)).every((item) => item.width > 0 && item.height > 0));

    const result = await redactImageTextCopy(source, output, [{
      part: before.part,
      expectedText: '张伟',
      sourceHash: before.hash,
      issue: 'windows-ocr-smoke',
    }]);
    assert.equal(hash(source), sourceHash, '真实 OCR 脱敏不得改原件');
    const image = result.images[0];
    assert.equal(image.status, 'fixed', `脱敏后必须用真实 OCR 复检通过：${JSON.stringify(image)}`);
    assert.notEqual(image.beforeHash, image.afterHash, '脱敏必须改变媒体像素');
    const after = result.facts.find((item) => item.part === before.part);
    assert.equal(after.status, 'covered', `修复后 OCR 不可失去覆盖：${JSON.stringify(after)}`);
    assert.doesNotMatch(compact(after.text), /张伟/);
    assert.match(compact(after.text), /施工方案|质量保证/, '非目标文字应保留并可复检');
    assert.deepEqual(nativeImage.createFromBuffer(new AdmZip(output).getEntry(before.part).getData()).getSize(), { width: before.width, height: before.height });
    console.log(`check-blind-check-windows-ocr[${label}]: 通过（${before.text.replace(/\s+/g, ' ')} -> ${after.text.replace(/\s+/g, ' ')}）`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (!module.parent) {
  app.whenReady().then(() => {
    const packedRoot = process.env.YIBIAO_TEST_APP_ROOT;
    return packedRoot
      ? run(require(path.join(path.resolve(packedRoot), 'electron', 'services', 'blindCheckImageText.cjs')), 'final-package')
      : run();
  }).then(() => app.quit(), (error) => {
    console.error(error?.stack || error);
    app.exit(1);
  });
}

module.exports = { run };

