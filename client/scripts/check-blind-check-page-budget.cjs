// 暗标修复最终页数保护：全部使用本地 stub，不调用模型；真实 Word 分页另由 check-blind-check-fix-pages.cjs 覆盖。
// 用法（client 目录）：node --test scripts/check-blind-check-page-budget.cjs
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  assessFixPageBudget,
  buildFixPageGuard,
  normalizeFixPageBudget,
  pageBudgetFinding,
  runBlindCheckFixTask,
} = require('../electron/services/blindCheckFixTask.cjs');

function rawReport(groups = []) {
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  return {
    summary: { high: 0, medium: total, low: 0, total },
    stats: { paragraphs: 3, body_paragraphs: 3, rules_checked: 2 },
    rule_errors: [],
    groups,
  };
}

function rawLineBreakGroup(count = 1) {
  return {
    rule_id: 'text.linebreak', rule_title: '手动换行', category: 'text', severity: 'medium',
    message: '存在手动换行符', candidate: false, count,
    samples: [{ where: '正文第1段', text: '第一行↵第二行', detail: '软换行', origin: '', hint: '在 Word 中按版式逐处处理' }],
    items: [{ where: '正文第1段', text: '第一行↵第二行', detail: '软换行', locator: 'p1' }],
  };
}

function mappedLineBreakGroup(count = 1) {
  return {
    id: 'g0', ruleId: 'text.linebreak', ruleTitle: '手动换行', category: 'text', severity: 'medium',
    message: '存在手动换行符', candidate: false, count,
    samples: [{ where: '正文第1段', text: '第一行↵第二行', detail: '软换行', origin: '', hint: '在 Word 中按版式逐处处理' }],
    items: [{ where: '正文第1段', text: '第一行↵第二行', detail: '软换行', locator: 'p1' }],
  };
}

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function runScenario({ pageBudget, pageMeasurements, lineBreak = false }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'blind-page-budget-'));
  const sourcePath = path.join(directory, 'source.docx');
  const outputPath = path.join(directory, 'fixed.docx');
  fs.writeFileSync(sourcePath, Buffer.from('ORIGINAL-DOCX'));
  const sourceHash = sha(sourcePath);
  const input = {
    source: 'source.docx', sourcePath, output: 'fixed.docx', outputPath, signature: 'sig-pages', fileName: '页数测试.docx',
    sensitiveWords: [], fixRules: lineBreak ? ['text.linebreak'] : ['text.spaces'],
    profile: { image: { check_color: false, check_text: false }, privacy: { enable_builtin: true, keywords: [] } },
  };
  const checkGroups = lineBreak ? [mappedLineBreakGroup()] : [{
    id: 'g0', ruleId: 'text.spaces', ruleTitle: '空格', category: 'text', severity: 'medium', message: '存在多余空格',
    candidate: false, count: 1, samples: [{ where: '正文', text: '测 试', detail: '', origin: '', hint: '删除多余空格' }], items: [],
  }];
  const helperRules = [];
  let measurementIndex = 0;
  const checkpoints = [];
  await runBlindCheckFixTask({
    agentService: {}, aiService: {}, payload: { ai: false, ...(pageBudget ? { pageBudget } : {}) },
    taskControl: { signal: new AbortController().signal },
    workspaceStore: {
      prepareFixInput: () => input,
      loadBlindCheck: () => ({ result: { status: 'success', inputSignature: input.signature, groups: checkGroups }, review: { status: 'skipped' } }),
      setFixAiEnabled: () => {}, removeStaleFixedFiles: () => {},
    },
    openXmlHelperService: {
      async runBlindCheckFix(request) {
        helperRules.push([...request.fix_rules]);
        fs.writeFileSync(outputPath, Buffer.from(`FIXED-${helperRules.length}`));
        return {
          source_bytes: fs.statSync(sourcePath).size, output_bytes: fs.statSync(outputPath).size,
          fixes: lineBreak ? { 'text.linebreak': 1 } : { 'text.spaces': 1 },
          notes: [], heading_fallback: true,
          validation: { checked: true, original_errors: 0, fixed_errors: 0 }, after: rawReport(),
        };
      },
      async runBlindCheck() {
        helperRules.push([]);
        return rawReport(lineBreak ? [rawLineBreakGroup()] : []);
      },
    },
    pageMeasure: async () => {
      const next = pageMeasurements[measurementIndex++];
      if (next instanceof Error) throw next;
      return next;
    },
    updateTask: () => {},
    checkpointTask(task, state = {}) {
      checkpoints.push({ task, state });
      return { task: { task_id: 'fix-pages' } };
    },
  });
  const result = checkpoints.find((item) => item.state.fixResult?.status === 'success')?.state.fixResult;
  assert.equal(sha(sourcePath), sourceHash, '页数保护不得修改原文');
  return { directory, helperRules, result, checkpoints, measurementIndex };
}

test('默认不增页：软换行拆段超出原文页数时从原件重做，软换行仍明确待人工', async (t) => {
  const state = await runScenario({
    lineBreak: true,
    pageMeasurements: [
      { pages: 10, source: 'microsoft-word' },
      { pages: 20, source: 'microsoft-word' },
      { pages: 10, source: 'microsoft-word' },
    ],
  });
  t.after(() => fs.rmSync(state.directory, { recursive: true, force: true }));
  assert.deepEqual(state.helperRules, [['text.linebreak'], []], '只选软换行时，超页回退应复制原件并重新检查，而不是保留第一次膨胀副本');
  assert.equal(state.result.pageBudget.origin, 'source');
  assert.equal(state.result.pageBudget.accepted, true);
  assert.deepEqual(state.result.pageBudget.lineBreakFallback, { skipped: 1, measuredPages: 20, measurementSource: 'microsoft-word' });
  const lineBreak = state.result.items.find((item) => item.message === '存在手动换行符');
  assert.deepEqual([lineBreak.fixed, lineBreak.pending], [0, 1], '回退跳过软换行后必须保留为未完成，不得全绿');
  assert.ok(state.result.notes.some((note) => /未自动拆分 1 处手动换行/.test(note)));
  assert.equal(state.result.afterSummary.total, 1);
});

test('显式任务页数范围：最终超上限时保留安全副本并新增人工待处理项，不伪报成功', async (t) => {
  const state = await runScenario({
    pageBudget: { mode: 'pages', targetPages: 10, minimumPages: 9, maximumPages: 11 },
    pageMeasurements: [{ pages: 10, source: 'microsoft-word' }, { pages: 12, source: 'microsoft-word' }],
  });
  t.after(() => fs.rmSync(state.directory, { recursive: true, force: true }));
  assert.equal(state.result.status, 'success', '安全修复副本仍应可供用户保存');
  assert.equal(state.result.pageBudget.origin, 'explicit');
  assert.equal(state.result.pageBudget.accepted, false);
  assert.equal(state.result.pageBudget.final.pages, 12);
  const pageItem = state.result.items.find((item) => item.message === '最终交付页数未通过实测预算');
  assert.ok(pageItem && pageItem.pending === 1 && pageItem.isNew, JSON.stringify(state.result.items));
  assert.match(pageItem.reason, /修复后新出现/);
  assert.match(pageItem.suggestion, /不得恢复已脱敏信息/);
  assert.ok(fs.existsSync(state.result.outputPath), '超页时不删除修复副本');
});

test('计页不可用或不是 Microsoft Word 时保守待复核；显式 target-only 使用精确验收', async () => {
  const sourceUnavailable = { pages: 0, source: 'unavailable', warning: '', error: 'Word 未安装' };
  const finalWord = { pages: 8, source: 'microsoft-word', warning: '', error: '' };
  const defaultStatus = assessFixPageBudget({
    guard: buildFixPageGuard(null, sourceUnavailable), sourceMeasurement: sourceUnavailable, finalMeasurement: finalWord,
  });
  assert.equal(defaultStatus.accepted, false);
  assert.match(defaultStatus.reason, /不能建立默认“不增页”预算/);
  assert.ok(pageBudgetFinding(defaultStatus));

  const exact = normalizeFixPageBudget({ mode: 'pages', targetPages: 8 });
  assert.equal(exact.kind, 'exact');
  const exactStatus = assessFixPageBudget({
    guard: buildFixPageGuard(exact, sourceUnavailable), sourceMeasurement: sourceUnavailable, finalMeasurement: finalWord,
  });
  assert.equal(exactStatus.accepted, true, '显式页数预算不应依赖任意源文件与当前项目的隐式关联');

  const editorStatus = assessFixPageBudget({
    guard: buildFixPageGuard(exact, { pages: 8, source: 'docx-editor', warning: 'fallback', error: '' }),
    sourceMeasurement: { pages: 8, source: 'docx-editor', warning: 'fallback', error: '' },
    finalMeasurement: { pages: 8, source: 'docx-editor', warning: 'fallback', error: '' },
  });
  assert.equal(editorStatus.accepted, false);
  assert.match(editorStatus.reason, /尚未经过 Microsoft Word 实测/);
  assert.throws(() => normalizeFixPageBudget({ mode: 'pages', minimumPages: 12, maximumPages: 10 }), /最少页数不能高于最多页数/);
});
