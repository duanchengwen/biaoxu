// 实际 app.asar 回归：生产 ImageText 和 PowerShell 脚本均从归档加载，
// 再执行 Windows.Media.Ocr -> 像素遮盖 -> OCR 复检的完整原生链路。
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');
const asar = require('@electron/asar');
const AdmZip = require('adm-zip');
const { run } = require('./check-blind-check-windows-ocr.cjs');

const root = path.resolve(__dirname, '..');

async function runModelDispatchSmoke(implementation) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-asar-vision-dispatch-'));
  try {
    const docx = path.join(directory, 'vision.docx');
    const zip = new AdmZip();
    zip.addFile('word/document.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><w:body><w:p><w:r><w:drawing><a:blip r:embed="rIdImage"/></w:drawing></w:r></w:p></w:body></w:document>'));
    zip.addFile('word/_rels/document.xml.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/identity.png"/></Relationships>'));
    zip.addFile('word/media/identity.png', Buffer.from('asar-vision-stub-image'));
    zip.writeZip(docx);

    const calls = [];
    const facts = await implementation.collectModelImageTextFacts(docx, {
      aiService: { getConfig: () => ({ multimodal_enabled: true }) },
      decode: async () => ({ width: 80, height: 30 }),
      auxiliaryOcr: false,
      vision: async (image) => {
        calls.push(image);
        return {
          status: 'covered', text: '模型抄录：项目负责人张伟', identifiers: [{ text: '张伟', kind: 'person' }],
          reason: '图片清晰', vision: { status: 'reviewed' },
        };
      },
    });
    assert.equal(calls.length, 1, 'ASAR 中模型主识别应对媒体 part 调度一次 stub');
    assert.equal(calls[0].part, 'word/media/identity.png');
    assert.equal(Buffer.compare(calls[0].buffer, Buffer.from('asar-vision-stub-image')), 0);
    assert.equal(facts[0].primarySource, 'multimodal');
    assert.equal(facts[0].modelText, '模型抄录：项目负责人张伟');
    assert.deepEqual(facts[0].identifiers, [{ text: '张伟', kind: 'person' }]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function main() {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-asar-ocr-stage-'));
  const serviceDir = path.join(staging, 'electron', 'services');
  const artifactDirectory = path.resolve(root, '..', 'qa', 'artifacts', 'asar-ocr-smoke');
  fs.mkdirSync(artifactDirectory, { recursive: true });
  const archive = path.join(artifactDirectory, `app-${crypto.randomUUID()}.asar`);
  const moduleInArchive = path.join(archive, 'electron', 'services', 'blindCheckImageText.cjs');
  const visionModuleInArchive = path.join(archive, 'electron', 'services', 'blindCheckImageVision.cjs');
  const scriptInArchive = path.join(archive, 'electron', 'services', 'blindCheckWindowsOcr.ps1');
  const spawnEvidence = [];
  try {
    fs.mkdirSync(serviceDir, { recursive: true });
    fs.copyFileSync(path.join(root, 'electron', 'services', 'blindCheckImageText.cjs'), path.join(serviceDir, 'blindCheckImageText.cjs'));
    fs.copyFileSync(path.join(root, 'electron', 'services', 'blindCheckImageVision.cjs'), path.join(serviceDir, 'blindCheckImageVision.cjs'));
    fs.copyFileSync(path.join(root, 'electron', 'services', 'blindCheckWindowsOcr.ps1'), path.join(serviceDir, 'blindCheckWindowsOcr.ps1'));
    // Electron 默认把 *.asar 当虚拟目录；打包器读写归档本体时临时关闭该补丁。
    process.noAsar = true;
    await asar.createPackage(staging, archive);

    assert.ok(fs.statSync(archive).isFile(), 'app.asar 没有生成');
    assert.ok(asar.listPackage(archive).some((entry) => /blindCheckImageText\.cjs$/.test(entry)));
    assert.ok(asar.listPackage(archive).some((entry) => /blindCheckImageVision\.cjs$/.test(entry)));
    assert.ok(asar.listPackage(archive).some((entry) => /blindCheckWindowsOcr\.ps1$/.test(entry)));
    process.noAsar = false;
    assert.ok(fs.readFileSync(moduleInArchive).includes(Buffer.from('Materialize the')),
      'Electron 没有从 app.asar 读到最新 ImageText 修复');
    assert.ok(fs.readFileSync(scriptInArchive).length > 100, 'Electron 没有从 app.asar 读到 OCR 脚本');

    // ImageText 在 require 时解构 spawn；此处只为记录生产模块真正传给 PowerShell 的 -File 路径。
    const originalSpawn = childProcess.spawn;
    childProcess.spawn = (command, args, options) => {
      const fileIndex = Array.isArray(args) ? args.indexOf('-File') : -1;
      if (fileIndex >= 0) {
        const script = args[fileIndex + 1];
        spawnEvidence.push(script);
        assert.doesNotMatch(script, /\.asar(?:[\\/]|$)/i, 'PowerShell -File 不能接收 app.asar 虚拟路径');
        assert.ok(fs.statSync(script).isFile(), `PowerShell -File 必须是实体脚本：${script}`);
        assert.match(path.basename(script), /^ocr\.ps1$/i);
      }
      return originalSpawn(command, args, options);
    };

    // 生产安装包会把依赖一并装入 app.asar；精简测试归档只收三份目标文件，
    // 依赖从本项目 node_modules 解析，不影响 __dirname 仍位于 app.asar 内这一关键条件。
    process.env.NODE_PATH = [path.join(root, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
    Module._initPaths();

    let implementation;
    try {
      implementation = require(moduleInArchive);
    } finally {
      childProcess.spawn = originalSpawn;
    }
    assert.match(require.resolve(moduleInArchive), /\.asar[\\/]electron[\\/]services[\\/]blindCheckImageText\.cjs$/i);
    assert.match(require.resolve(visionModuleInArchive), /\.asar[\\/]electron[\\/]services[\\/]blindCheckImageVision\.cjs$/i);
    assert.equal(typeof require(visionModuleInArchive).recognizeImageWithModel, 'function');

    await runModelDispatchSmoke(implementation);
    await run(implementation, 'app.asar');
    assert.ok(spawnEvidence.length >= 3, `预期修复前、遮盖前和修复后均调用真实 OCR，实际 ${spawnEvidence.length} 次`);
    assert.ok(spawnEvidence.every((script) => fs.existsSync(script) === false), 'OCR job 完成后应清理实体临时脚本');
    console.log(`check-blind-check-windows-ocr-asar: 通过（ImageVision 调度 stub + 真实 OCR ${spawnEvidence.length} 次，PowerShell 均使用实体临时脚本）`);
    console.log(`ASAR=${archive}`);
  } finally {
    process.noAsar = false;
    fs.rmSync(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

app.whenReady().then(main).then(() => app.quit(), (error) => {
  console.error(error?.stack || error);
  app.exit(1);
});
