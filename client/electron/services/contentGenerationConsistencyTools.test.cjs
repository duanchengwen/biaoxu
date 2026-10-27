const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { CONSISTENCY_TOOLS, CONSISTENCY_ISSUES_FILE, createConsistencySemanticReviewRequest, buildConsistencySemanticReview, extractConsistencyLedger, refreshConsistencyAfterRepairs, collectNaturalnessApprovedHashes, combineRepairInstructions, SEMANTIC_REVIEW_FILE } = require('./contentGenerationConsistencyTools.cjs');

function fixture() {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-consistency-review-'));
  const sections = [
    { id: 's1', number: '1.1', title: '参数方案', file: '正文/s1.html' },
    { id: 's2', number: '1.2', title: '实施方案', file: '正文/s2.html' },
  ];
  fs.mkdirSync(path.join(workspaceDir, '正文'));
  fs.writeFileSync(path.join(workspaceDir, '正文编排决策.json'), JSON.stringify({ targets: sections, completed_sections: [] }));
  fs.writeFileSync(path.join(workspaceDir, '正文完整目录.json'), JSON.stringify({ outline: sections }));
  fs.writeFileSync(path.join(workspaceDir, '全局事实设定.md'), '工期以招标文件为准。');
  fs.writeFileSync(path.join(workspaceDir, '正文一致性事实台账.json'), JSON.stringify({
    version: 3,
    failures: {},
    sections: {
      s1: { version: 3, issues: [], naturalness: { status: 'pass', issues: [] }, facts: [
        { category: '技术参数', subject: '并发数', value: '100', block_id: 'p1', quote: '支持100并发' },
      ] },
      s2: { version: 3, issues: [], naturalness: { status: 'pass', issues: [] }, facts: [
        { category: '其他', subject: '系统最大并发能力', value: '200', block_id: 'p2', quote: '支持200并发' },
      ] },
    },
  }));
  return { workspaceDir };
}

test('consistency stage keeps explicit read fallback but removes general-purpose traversal tools', () => {
  assert.ok(CONSISTENCY_TOOLS.includes('read'));
  assert.ok(CONSISTENCY_TOOLS.includes('search-sections'));
  assert.ok(CONSISTENCY_TOOLS.includes('recheck-sections'));
  assert.ok(CONSISTENCY_TOOLS.includes('repair-sections'));
  for (const name of ['bash', 'grep', 'find', 'ls']) assert.ok(!CONSISTENCY_TOOLS.includes(name), `${name} must not bypass structured audit tools`);
});

test('semantic review sends all categories once, catches cross-category synonyms, and binds cache to global facts', async () => {
  const { workspaceDir } = fixture();
  const calls = [];
  const aiService = {
    async requestJson(request) {
      calls.push(request);
      const output = request.normalizer({ candidates: [{
        type: '跨小节矛盾', subject: '并发数', problem: '同一参数取值不同', suggestion: '核实统一值',
        evidence: [
          { fact_ref: 1 },
          { fact_ref: 2 },
        ],
      }] });
      request.validator(output);
      return output;
    },
  };
  const signal = new AbortController().signal;
  const first = await buildConsistencySemanticReview({ aiService, workspaceDir, signal });
  assert.equal(calls.length, 1);
  assert.equal(first.candidateCount, 1);
  assert.equal(calls[0].max_retries, 0, '完整事实不得在 JSON 校验失败后整包重复发送');
  const body = calls[0].messages.map(message => message.content).join('\n');
  assert.match(body, /支持100并发/);
  assert.match(body, /支持200并发/);
  assert.match(body, /技术参数/);
  assert.match(body, /其他/);
  assert.match(fs.readFileSync(path.join(workspaceDir, SEMANTIC_REVIEW_FILE), 'utf8'), /同一参数取值不同/);

  await buildConsistencySemanticReview({ aiService, workspaceDir, signal });
  assert.equal(calls.length, 1, '相同规则、全局事实和台账应复用全量语义比对结果');

  fs.writeFileSync(path.join(workspaceDir, '全局事实设定.md'), '工期以招标文件为准。\n系统并发口径以采购需求为准。');
  await buildConsistencySemanticReview({ aiService, workspaceDir, signal });
  assert.equal(calls.length, 2, '全局事实变化必须使语义审查缓存失效');
});

test('semantic review records a full-ledger failure instead of treating it as clean', async () => {
  const { workspaceDir } = fixture();
  const result = await buildConsistencySemanticReview({
    aiService: { requestJson: async () => { throw new Error('offline'); } },
    workspaceDir,
    signal: new AbortController().signal,
  });
  assert.deepEqual(result.failedScopes, ['全部事实']);
  assert.match(fs.readFileSync(path.join(workspaceDir, SEMANTIC_REVIEW_FILE), 'utf8'), /必须回到原始事实台账覆盖全部类别及跨类别关系/);
});

test('semantic review refuses to truncate a complete ledger when model context is too small', async () => {
  const { workspaceDir } = fixture();
  let calls = 0;
  const result = await buildConsistencySemanticReview({
    aiService: {
      getConfig: () => ({ context_length_limit: 64 }),
      requestJson: async () => { calls += 1; return { candidates: [] }; },
    },
    workspaceDir,
    signal: new AbortController().signal,
  });
  assert.equal(calls, 0);
  assert.deepEqual(result.failedScopes, ['全部事实']);
  assert.match(fs.readFileSync(path.join(workspaceDir, SEMANTIC_REVIEW_FILE), 'utf8'), /未截断事实/);
});

test('semantic evidence may cite the second fact in one paragraph while program backfills exact source text', () => {
  const prepared = createConsistencySemanticReviewRequest({
    sections: [
      { id: 's1', number: '1', title: '团队' },
      { id: 's2', number: '2', title: '保障' },
    ],
    ledger: { sections: {
      s1: { facts: [
        { category: '人数与数量', subject: '管理人员', value: '2人', block_id: 'p1', quote: '管理人员2人' },
        { category: '人数与数量', subject: '团队总人数', value: '10人', block_id: 'p1', quote: '团队共10人' },
      ] },
      s2: { facts: [{ category: '其他', subject: '团队规模', value: '8人', block_id: 'p2', quote: '项目组8人' }] },
    } },
    globalFacts: '',
  });
  const raw = { candidates: [{
    type: '跨小节矛盾', subject: '团队规模', problem: '同一团队人数不同', suggestion: '核实统一值',
    evidence: [
      { fact_ref: 2 },
      { fact_ref: 3 },
    ],
  }] };
  const normalized = prepared.request.normalizer(raw);
  assert.doesNotThrow(() => prepared.request.validator(normalized));
  assert.deepEqual(normalized.candidates[0].evidence[0], {
    fact_ref: 2, section_id: 's1', block_id: 'p1', value: '10人', quote: '团队共10人',
  });

  const withCopiedText = structuredClone(raw);
  withCopiedText.candidates[0].evidence[0].quote = '模型重抄或编造摘录';
  assert.throws(() => prepared.request.validator(prepared.request.normalizer(withCopiedText)), /只能包含 fact_ref/);
  const unknownReference = structuredClone(raw);
  unknownReference.candidates[0].evidence[0].fact_ref = 999;
  assert.throws(() => prepared.request.validator(prepared.request.normalizer(unknownReference)), /fact_ref 必须来自/);
});

test('main-agent issue report contains all explicit issues but excludes the large fact inventory', async () => {
  const { workspaceDir } = fixture();
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  fs.writeFileSync(path.join(workspaceDir, '正文', 's1.html'), '<p id="p1">支持100并发</p>');
  fs.writeFileSync(path.join(workspaceDir, '正文', 's2.html'), '<p id="p2">支持200并发</p>');
  const stored = JSON.parse(fs.readFileSync(path.join(workspaceDir, '正文一致性事实台账.json'), 'utf8'));
  stored.sections.s1.hash = hash('<p id="p1">支持100并发</p>');
  stored.sections.s1.issues = [{ block_id: 'p1', type: '与全局事实冲突', problem: '并发口径不一致', evidence: '全局事实', suggestion: '核实统一值' }];
  stored.sections.s2.hash = hash('<p id="p2">支持200并发</p>');
  fs.writeFileSync(path.join(workspaceDir, '正文一致性事实台账.json'), JSON.stringify(stored));
  await extractConsistencyLedger({
    aiService: { requestJson: async () => { throw new Error('unchanged fixtures should not call AI'); } },
    workspaceDir,
    signal: new AbortController().signal,
  });
  const report = fs.readFileSync(path.join(workspaceDir, CONSISTENCY_ISSUES_FILE), 'utf8');
  assert.match(report, /并发口径不一致/);
  assert.doesNotMatch(report, /支持100并发|支持200并发/, '事实库存只留在完整台账和语义审查输入中');
});

test('post-repair refresh rechecks only changed html and replaces stale fact issues before naturalize gate', async () => {
  const { workspaceDir } = fixture();
  const oldHtml = '<p id="p1">工期为20日。</p>';
  const repairedHtml = '<p id="p1">工期为30日。</p>';
  const unchangedHtml = '<p id="p2">服务地点为武汉市。</p>';
  fs.writeFileSync(path.join(workspaceDir, '正文', 's1.html'), repairedHtml);
  fs.writeFileSync(path.join(workspaceDir, '正文', 's2.html'), unchangedHtml);
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  fs.writeFileSync(path.join(workspaceDir, '正文一致性事实台账.json'), JSON.stringify({
    version: 3,
    failures: {},
    sections: {
      s1: { version: 3, hash: hash(oldHtml), reference: false,
        issues: [{ type: '与全局事实冲突', problem: '旧问题' }], facts: [], naturalness: { status: 'pass', issues: [] } },
      s2: { version: 3, hash: hash(unchangedHtml), reference: false,
        issues: [], facts: [], naturalness: { status: 'pass', issues: [] } },
    },
  }));
  let calls = 0;
  const refreshed = await refreshConsistencyAfterRepairs({
    workspaceDir,
    signal: new AbortController().signal,
    aiService: {
      async requestJson(request) {
        calls += 1;
        const output = request.normalizer({
          issues: [],
          facts: [{ category: '日期与期限', subject: '工期', value: '30日', block_id: 'B1', quote: '工期为30日' }],
          naturalness: { status: 'pass', issues: [] },
        });
        request.validator(output);
        return output;
      },
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(refreshed.recheckedIds, ['s1']);
  assert.deepEqual(refreshed.failedIds, []);
  assert.deepEqual(refreshed.remainingIssueIds, []);
  assert.deepEqual(Object.keys(collectNaturalnessApprovedHashes(workspaceDir, [
    { id: 's1', file: '正文/s1.html' }, { id: 's2', file: '正文/s2.html' },
  ])).sort(), ['s1', 's2']);

  await refreshConsistencyAfterRepairs({
    workspaceDir,
    signal: new AbortController().signal,
    aiService: { requestJson: async () => { calls += 1; } },
  });
  assert.equal(calls, 1, '恢复时 hash 未变不得重复付费复核');
});

test('fact repair folds only explicit naturalness issues into the same scoped edit request', () => {
  const factInstruction = '将工期按统一口径修正为30日。';
  const combined = combineRepairInstructions(factInstruction, {
    naturalness: {
      status: 'needs_revision',
      issues: [{ block_id: 'p3', type: '机械句式', problem: '连续三段使用相同句式' }],
    },
  });
  assert.match(combined, /将工期按统一口径修正为30日/);
  assert.match(combined, /\[p3\] 机械句式/);
  assert.match(combined, /不得改变任何事实、数值、工期、范围、责任、承诺、表格、图片或图注/);

  assert.equal(combineRepairInstructions(factInstruction, {
    naturalness: { status: 'pass', issues: [] },
  }), factInstruction, '已通过文风审查的事实修复不得附加一次无意义的文风任务');
  assert.equal(combineRepairInstructions(factInstruction, {
    naturalness: { status: 'unknown', issues: [] },
  }), factInstruction, '未知文风状态留给既有去痕门禁，不在事实修复阶段猜测通过或新增请求');
});
