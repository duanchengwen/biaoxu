const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { createOpenXmlHelperService } = require('../electron/services/openXmlHelperService.cjs');
const { createTechnicalPlanExport } = require('../electron/services/technicalPlanExport.cjs');
const { SYSTEM_EXPORT_TEMPLATES } = require('../electron/services/systemExportTemplates.cjs');
const { readMicrosoftWordPages, adjustContentToTargetPages } = require('../electron/services/contentGenerationPages.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-renderer-pages-'));
const workspaceDir = path.join(root, 'generation-workspace');
const bodyDir = path.join(workspaceDir, '正文');
fs.mkdirSync(path.join(workspaceDir, 'assets'), { recursive: true });
fs.mkdirSync(bodyDir, { recursive: true });

fs.writeFileSync(path.join(workspaceDir, 'assets', 'diagram.png'), Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2X9sAAAAASUVORK5CYII=',
  'base64',
));

const paragraph = '项目团队依据实施目标组织工作，逐项明确责任边界、检查节点、记录要求和交付成果，并通过周例会复核执行偏差。';
const sectionOne = [
  '<!-- yibiao:block -->',
  ...Array.from({ length: 45 }, (_value, index) => `<p id="s1-p${index + 1}">${paragraph.repeat(3)}</p>`),
  '<!-- yibiao:block -->',
  '<table id="s1-table"><thead><tr><th>阶段</th><th>责任岗位</th><th>检查记录</th></tr></thead><tbody>',
  ...Array.from({ length: 16 }, (_value, index) => `<tr><td>阶段${index + 1}</td><td>项目组</td><td>第${index + 1}项记录</td></tr>`),
  '</tbody></table>',
  '<!-- yibiao:block -->',
  '<figure id="s1-figure" data-yb-generation="original" data-yb-size="wide" data-yb-fit="contain"><img src="assets/diagram.png" data-yb-asset-ref="assets/diagram.png" alt="实施流程图"><figcaption>图1 实施流程图</figcaption></figure>',
].join('\n');
const sectionTwo = [
  '<!-- yibiao:block -->',
  ...Array.from({ length: 30 }, (_value, index) => `<p id="s2-p${index + 1}">${paragraph.repeat(2)}</p>`),
].join('\n');
fs.writeFileSync(path.join(bodyDir, 's1.html'), sectionOne, 'utf8');
fs.writeFileSync(path.join(bodyDir, 's2.html'), sectionTwo, 'utf8');

const outline = [
  { id: 's1', title: '总体实施方案', content_mode: 'ai-generate', children: [] },
  { id: 's2', title: '质量保障方案', content_mode: 'ai-generate', children: [] },
];
const app = {
  isPackaged: Boolean(String(process.env.YIBIAO_TEST_OPENXML_HELPER_DIR || '').trim()),
  getPath(name) {
    assert.equal(name, 'userData');
    return root;
  },
  getAppPath() {
    return path.resolve(__dirname, '..');
  },
};
const previousHelperDir = process.env.YIBIAO_OPENXML_HELPER_DIR;
if (app.isPackaged) process.env.YIBIAO_OPENXML_HELPER_DIR = path.resolve(process.env.YIBIAO_TEST_OPENXML_HELPER_DIR);
const template = SYSTEM_EXPORT_TEMPLATES.find(item => item.template_id === 'tpl-system-standard-bid');
const helper = createOpenXmlHelperService({ app, configStore: { load: () => ({}) } });
const exporter = createTechnicalPlanExport({
  technicalPlanStore: { loadTechnicalPlan: () => ({
    outlineData: { project_name: '产品导出真实分页回归项目', outline },
    exportTemplateId: template.template_id,
    exportTemplateScope: 'ai-only',
  }) },
  templateStore: { getTemplate: () => template },
  agentService: { loadPersistentTask: () => ({ paths: { workspaceDir } }) },
  openXmlHelperService: helper,
});

async function main() {
  try {
    const snapshot = exporter.prepare();
    const exported = await exporter.build(snapshot, { layoutCheck: false });
    assert.deepEqual(exported.warnings, []);
    const file = path.join(root, '技术标产品导出.docx');
    fs.writeFileSync(file, exported.buffer);

    const zip = new AdmZip(exported.buffer);
    const xml = zip.readAsText('word/document.xml');
    assert.match(xml, /产品导出真实分页回归项目/);
    assert.match(xml, /总体实施方案/);
    assert.match(xml, /质量保障方案/);
    assert.match(xml, /<w:tbl[ >]/);
    assert.match(xml, /<w:drawing[ >]/);

    const measured = await readMicrosoftWordPages(file, new AbortController().signal);
    assert(measured.pages > 1);
    let aiCalls = 0;
    const state = await adjustContentToTargetPages({
      aiService: { async chat() { aiCalls += 1; throw new Error('实测页数已匹配时不应调用模型'); } },
      exporter,
      snapshot,
      workspaceDir,
      sections: outline.map((item, index) => ({ section_id: item.id, number: String(index + 1), title: item.title, file: `正文/${item.id}.html` })),
      targetPages: measured.pages,
      signal: new AbortController().signal,
    });
    assert.equal(state.in_range, true);
    assert.equal(state.measured_pages, measured.pages);
    assert.equal(state.measurement_source, 'microsoft-word');
    assert.equal(aiCalls, 0);
    console.log(`technicalPlanExport -> OpenXmlHelper -> Word page closure passed: ${measured.pages} pages`);
  } finally {
    await helper.close();
    if (previousHelperDir === undefined) delete process.env.YIBIAO_OPENXML_HELPER_DIR;
    else process.env.YIBIAO_OPENXML_HELPER_DIR = previousHelperDir;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
