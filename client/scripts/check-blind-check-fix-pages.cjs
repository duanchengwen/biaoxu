// 真实 Word 分页回归：构造大量带段前/段后间距的软换行，走真实 OpenXmlHelper 后由 Word COM 重新分页。
// 开发客户端运行时请先把 helper 隔离构建，并设置 YIBIAO_OPENXML_HELPER_DIR，避免触碰用户正在使用的 helper。
// 用法（client 目录）：node --test scripts/check-blind-check-fix-pages.cjs
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const AdmZip = require('adm-zip');
const { Document, LineRuleType, Packer, Paragraph, TextRun } = require('docx');
const { createOpenXmlHelperService } = require('../electron/services/openXmlHelperService.cjs');
const { normalizeProfile } = require('../electron/services/blindCheckPresets.cjs');
const { readMicrosoftWordPages } = require('../electron/services/contentGenerationPages.cjs');
const { runBlindCheckFixTask } = require('../electron/services/blindCheckFixTask.cjs');
const { mapReport } = require('../electron/services/blindCheckTask.cjs');

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function documentXml(file) {
  return new AdmZip(file).getEntry('word/document.xml').getData().toString('utf8');
}

test('真实 Word：软换行转段不重复段前段后间距，修复副本不比原文增页且原件不变', { timeout: 180000 }, async (t) => {
  if (process.platform !== 'win32') return t.skip('仅 Windows 可使用 Microsoft Word COM 实测分页');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '暗标真实分页-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, 'workspace');
  const sourceDir = path.join(workspace, 'blind-check', 'source');
  fs.mkdirSync(sourceDir, { recursive: true });
  const paragraphs = [];
  for (let index = 1; index <= 90; index += 1) {
    paragraphs.push(new Paragraph({
      widowControl: false,
      spacing: { before: 240, after: 240, line: 360, lineRule: LineRuleType.EXACT },
      children: [1, 2, 3, 4].map((line) => new TextRun({
        text: `第${index}项技术措施第${line}行，保持关键事实、承诺和版式。`,
        break: line === 1 ? 0 : 1,
      })),
    }));
  }
  const source = 'blind-check/source/软换行分页.docx';
  const sourcePath = path.join(workspace, source);
  fs.writeFileSync(sourcePath, await Packer.toBuffer(new Document({ sections: [{ children: paragraphs }] })));
  const output = 'blind-check/fixed/软换行分页.docx';
  const outputPath = path.join(workspace, output);
  const beforeHash = sha(sourcePath);
  const app = {
    isPackaged: Boolean(process.env.YIBIAO_OPENXML_HELPER_DIR),
    getPath: () => directory,
    getAppPath: () => path.join(__dirname, '..'),
  };
  const service = createOpenXmlHelperService({ app });
  try {
    const profile = normalizeProfile({ image: { check_color: false, check_text: false } });
    const checked = mapReport(await service.runBlindCheck({ source, profile, sensitive_words: [], image_facts: [] }));
    assert.equal(checked.groups.find(group => group.ruleId === 'text.linebreak')?.count, 90, '检查按存在问题的段落计数');
    const checkpoints = [];
    const input = {
      source, sourcePath, output, outputPath, signature: 'real-word-pages', fileName: '软换行分页.docx',
      profile, sensitiveWords: [], fixRules: ['text.linebreak'],
    };
    await runBlindCheckFixTask({
      agentService: {}, aiService: {}, payload: { ai: false }, taskControl: { signal: new AbortController().signal },
      workspaceStore: {
        prepareFixInput: () => input,
        loadBlindCheck: () => ({ result: { status: 'success', inputSignature: input.signature, groups: checked.groups }, review: { status: 'skipped' } }),
        setFixAiEnabled: () => {}, removeStaleFixedFiles: () => {},
      },
      openXmlHelperService: service,
      updateTask: () => {},
      checkpointTask(task, state = {}) {
        checkpoints.push({ task, state });
        return { task: { task_id: 'real-word-pages' } };
      },
      pageMeasure: readMicrosoftWordPages,
    });
    const result = checkpoints.find(item => item.state.fixResult?.status === 'success')?.state.fixResult;
    assert.equal(sha(sourcePath), beforeHash, '原件字节不得改变');
    assert.equal(result.status, 'success');
    assert.equal(result.fixes['text.linebreak'], 270);
    assert.deepEqual(result.groups.filter(group => group.ruleId === 'text.linebreak'), []);
    assert.equal(result.pageBudget.origin, 'source');
    assert.equal(result.pageBudget.accepted, true);
    assert.ok(result.pageBudget.final.pages <= result.pageBudget.source.pages,
      `修复前 ${result.pageBudget.source.pages} 页，修复后 ${result.pageBudget.final.pages} 页，软换行修复不得让文档增页`);
    assert.equal(result.pageBudget.source.source, 'microsoft-word');
    assert.equal(result.pageBudget.final.source, 'microsoft-word');
    assert.ok(!result.groups.some(group => group.ruleId === 'page.delivery_budget'), 'Word 实测合格时不得新增页数待处理项');
    const fixedXml = documentXml(outputPath);
    assert.ok((fixedXml.match(/w:before="0"/g) || []).length >= 270, '拆分内部段前间距应显式清零');
    assert.ok((fixedXml.match(/w:after="0"/g) || []).length >= 270, '拆分内部段后间距应显式清零');
    if (process.env.YIBIAO_BLIND_PAGE_ARTIFACT_DIR) {
      const artifactDir = path.resolve(process.env.YIBIAO_BLIND_PAGE_ARTIFACT_DIR);
      fs.mkdirSync(artifactDir, { recursive: true });
      fs.copyFileSync(sourcePath, path.join(artifactDir, 'source.docx'));
      fs.copyFileSync(outputPath, path.join(artifactDir, 'fixed.docx'));
      fs.writeFileSync(path.join(artifactDir, 'page-result.json'), `${JSON.stringify(result.pageBudget, null, 2)}\n`, 'utf8');
    }
    t.diagnostic(`Microsoft Word 实测：原文 ${result.pageBudget.source.pages} 页，最终暗标修复副本 ${result.pageBudget.final.pages} 页`);
  } finally {
    await service.closeBlindCheck();
    await service.close();
  }
});
