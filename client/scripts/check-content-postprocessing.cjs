const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  protectSemanticBlocks,
  restoreSemanticBlocks,
  invalidateNaturalizeStateForChangedHtml,
  mergeNaturalizeState,
  naturalizeContentSections,
} = require('../electron/services/contentGenerationNaturalize.cjs');
const {
  measureDocumentPages,
  adjustContentToTargetPages,
} = require('../electron/services/contentGenerationPages.cjs');
const {
  extractConsistencyLedger,
  collectNaturalnessApprovedHashes,
  collectProtectedFactBlockIds,
} = require('../electron/services/contentGenerationConsistencyTools.cjs');

function writeWorkspace(directory, html) {
  fs.mkdirSync(path.join(directory, '正文'), { recursive: true });
  fs.writeFileSync(path.join(directory, '项目概述.md'), '某公共服务项目', 'utf8');
  fs.writeFileSync(path.join(directory, '全局事实设定.md'), '工期：30日', 'utf8');
  fs.writeFileSync(path.join(directory, '正文编排决策.json'), JSON.stringify({
    global_facts_requirements: '不得新增事实',
    targets: [{ id: 's1', number: '1.1', title: '实施方案', file: '正文/s1.html' }],
  }), 'utf8');
  fs.writeFileSync(path.join(directory, '正文', 's1.html'), html, 'utf8');
}

async function main() {
  const critical = '<!-- yibiao:block -->\n<p id="p1">我方承诺在30日内交付并完成验收。</p>\n<!-- yibiao:block -->\n<p id="p2">首先，我们将进一步认真开展相关工作，切实保障工作顺利推进。</p>\n<!-- yibiao:block -->\n<table id="t1"><tbody><tr><td>岗位</td><td>职责</td></tr></tbody></table>';
  const protectedContent = protectSemanticBlocks(critical);
  assert.equal(protectedContent.blocks.length, 2, '事实承诺块和表格应被保护');
  assert.equal(restoreSemanticBlocks(protectedContent.text, protectedContent.blocks), critical);
  assert.throws(() => restoreSemanticBlocks(protectedContent.text.replace('natural-keep-1', 'natural-keep-2'), protectedContent.blocks));
  const factOnly = '<!-- yibiao:block -->\n<p id="location">实施地点为武汉市。</p>\n<!-- yibiao:block -->\n<p id="owner">甲方负责审批。</p>\n<!-- yibiao:block -->\n<p id="ledger-fact">设备部署在指定场所。</p>';
  const protectedFacts = protectSemanticBlocks(factOnly, ['ledger-fact']);
  assert.equal(protectedFacts.blocks.length, 3, '明确地点/责任事实及台账标记段必须整块保护');
  assert.equal(restoreSemanticBlocks(protectedFacts.text, protectedFacts.blocks), factOnly);

  const naturalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-natural-test-'));
  try {
    writeWorkspace(naturalDir, critical);
    const second = critical.replace('进一步认真开展相关工作', '针对第二节开展专项协同');
    fs.writeFileSync(path.join(naturalDir, '正文', 's2.html'), second, 'utf8');
    const requests = [];
    const aiService = {
      async chat(request) {
        requests.push(request);
        return '<!-- yibiao:block -->\n<!-- yibiao:natural-keep-1 -->\n<!-- yibiao:block -->\n<p id="p2">项目团队按任务分工推进工作，并在关键节点核对完成情况。</p>\n<!-- yibiao:block -->\n<!-- yibiao:natural-keep-2 -->';
      },
    };
    const states = [];
    const state = await naturalizeContentSections({
      aiService,
      workspaceDir: naturalDir,
      sections: [
        { section_id: 's1', number: '1.1', title: '实施方案', file: '正文/s1.html' },
        { section_id: 's2', number: '1.2', title: '协同方案', file: '正文/s2.html' },
      ],
      signal: new AbortController().signal,
      onProgress: value => states.push(structuredClone(value)),
    });
    const result = fs.readFileSync(path.join(naturalDir, '正文', 's1.html'), 'utf8');
    assert.equal(state.status, 'completed');
    assert.deepEqual(state.completed_section_ids, ['s1', 's2']);
    assert.match(result, /我方承诺在30日内交付并完成验收/);
    assert.match(result, /<table id="t1">/);
    assert.match(result, /项目团队按任务分工推进工作/);
    assert.ok(states.length >= 2, '自然化应持续提供可恢复检查点');
    assert.equal(requests.length, 2, '两个小节应各发起一次去痕请求');
    assert.ok(requests.every(request => request.messages.length === 3), '消息应拆为 system、公共前缀和单节内容');
    assert.equal(requests[0].messages[1].content, requests[1].messages[1].content, '两节公共前缀必须逐字相同');
    assert.match(requests[0].messages[1].content, /项目概述：\n某公共服务项目/);
    assert.match(requests[0].messages[1].content, /全局事实设定：\n工期：30日/);
    assert.match(requests[0].messages[1].content, /事实缺失处理要求：\n不得新增事实/);
    assert.doesNotMatch(requests[0].messages[1].content, /当前小节|当前 HTML|进一步认真开展相关工作|针对第二节开展专项协同/);
    assert.match(requests[0].messages[2].content, /当前小节：1\.1 实施方案/);
    assert.match(requests[0].messages[2].content, /进一步认真开展相关工作/);
    assert.doesNotMatch(requests[0].messages[2].content, /针对第二节开展专项协同/);
    assert.match(requests[1].messages[2].content, /当前小节：1\.2 协同方案/);
    assert.match(requests[1].messages[2].content, /针对第二节开展专项协同/);
    assert.doesNotMatch(requests[1].messages[2].content, /进一步认真开展相关工作/);
  } finally {
    fs.rmSync(naturalDir, { recursive: true, force: true });
  }

  const reviewedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-natural-reviewed-test-'));
  try {
    const first = critical;
    const second = critical.replace('进一步认真开展相关工作', '首先，其次，再次，全面推进各项相关工作');
    writeWorkspace(reviewedDir, first);
    fs.writeFileSync(path.join(reviewedDir, '正文', 's2.html'), second, 'utf8');
    fs.writeFileSync(path.join(reviewedDir, '正文编排决策.json'), JSON.stringify({
      global_facts_requirements: '不得新增事实',
      targets: [
        { id: 's1', number: '1.1', title: '实施方案', file: '正文/s1.html' },
        { id: 's2', number: '1.2', title: '协同方案', file: '正文/s2.html' },
      ],
    }), 'utf8');
    const reviewRequests = [];
    const reviewAi = {
      async chat(request) {
        reviewRequests.push({ kind: 'warmup', request });
        return 'OK';
      },
      async requestJson(request) {
        reviewRequests.push({ kind: 'review', request });
        const raw = request.logTitle.includes('1.1')
          ? { issues: [], facts: [{ category: '日期与期限', subject: '交付期限', value: '30日', block_id: 'B1', quote: '30日内交付' }], naturalness: { status: 'pass', issues: [] } }
          : { issues: [], facts: [{ category: '日期与期限', subject: '交付期限', value: '30日', block_id: 'B1', quote: '30日内交付' }], naturalness: { status: 'needs_revision', issues: [{ block_id: 'B2', type: '机械句式', problem: '过渡词机械堆叠' }] } };
        const normalized = request.normalizer(raw);
        request.validator(normalized);
        return normalized;
      },
    };
    await extractConsistencyLedger({
      aiService: reviewAi,
      workspaceDir: reviewedDir,
      signal: new AbortController().signal,
    });
    const modelReviews = reviewRequests.filter(item => item.kind === 'review');
    assert.equal(modelReviews.length, 2, '文风结论应复用两节既有一致性核对调用，不新增逐节模型调用');
    assert.equal(reviewRequests.filter(item => item.kind === 'warmup').length, 1, '只保留一致性核对原有公共前缀预热');
    assert.ok(modelReviews.every(item => item.request.messages[0].content.includes('自然文风审查')), '一致性核对应在同一响应中返回文风结论');
    const missingNaturalness = modelReviews[0].request.normalizer({ issues: [], facts: [] });
    modelReviews[0].request.validator(missingNaturalness);
    assert.equal(missingNaturalness.naturalness.status, 'unknown', '缺失文风字段必须安全回退 unknown，不得假定通过');
    assert.throws(() => modelReviews[0].request.validator(modelReviews[0].request.normalizer({ issues: [] })),
      /facts 必须为数组且不得省略/, '新增文风字段不得弱化原 facts 数组契约');
    assert.throws(() => modelReviews[0].request.validator({
      issues: [], facts: [], naturalness: { status: 'pass', issues: [{ block_id: 'p2', type: '套话', problem: '仍有套话' }] },
    }), /通过时 issues 必须为空/, '文风结论的结构和状态必须接受程序校验');
    const reviewedSections = [
      { section_id: 's1', number: '1.1', title: '实施方案', file: '正文/s1.html' },
      { section_id: 's2', number: '1.2', title: '协同方案', file: '正文/s2.html' },
    ];
    const approved = collectNaturalnessApprovedHashes(reviewedDir, reviewedSections);
    assert.deepEqual(Object.keys(approved), ['s1'], '只有明确 pass 的小节可以复用文风审查');
    assert.deepEqual(collectProtectedFactBlockIds(reviewedDir, reviewedSections), { s1: ['p1'], s2: ['p1'] }, '事实台账段落 ID 应提供给后续整块保护');
    const ledgerFile = path.join(reviewedDir, '正文一致性事实台账.json');
    const ledgerWithIssue = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    ledgerWithIssue.sections.s1.issues = [{ block_id: 'p1', type: '与全局事实冲突', problem: '交付期限冲突', evidence: '事实设定', suggestion: '统一期限' }];
    fs.writeFileSync(ledgerFile, JSON.stringify(ledgerWithIssue), 'utf8');
    assert.deepEqual(collectNaturalnessApprovedHashes(reviewedDir, reviewedSections), {}, '存在未解决事实问题时不得仅凭文风 pass 跳过去痕或标为通过');
    ledgerWithIssue.sections.s1.issues = [];
    fs.writeFileSync(ledgerFile, JSON.stringify(ledgerWithIssue), 'utf8');
    fs.appendFileSync(path.join(reviewedDir, '正文', 's1.html'), '\n<!-- changed-after-review -->', 'utf8');
    assert.deepEqual(collectNaturalnessApprovedHashes(reviewedDir, reviewedSections), {}, '审查后 HTML 变化必须让哈希批准失效');
    fs.writeFileSync(path.join(reviewedDir, '正文', 's1.html'), first, 'utf8');

    const naturalizeCalls = [];
    const naturalizeState = await naturalizeContentSections({
      aiService: {
        async chat(request) {
          naturalizeCalls.push(request);
          return '<!-- yibiao:block -->\n<!-- yibiao:natural-keep-1 -->\n<!-- yibiao:block -->\n<p id="p2">项目团队按任务分工推进，并在关键节点核对完成情况。</p>\n<!-- yibiao:block -->\n<!-- yibiao:natural-keep-2 -->';
        },
      },
      workspaceDir: reviewedDir,
      sections: reviewedSections,
      signal: new AbortController().signal,
      approvedHashes: approved,
    });
    assert.equal(naturalizeCalls.length, 1, '审查通过且哈希未变的小节不得重复调用去痕模型');
    assert.deepEqual(naturalizeState.skipped_section_ids, ['s1']);
    assert.deepEqual(naturalizeState.completed_section_ids, ['s2']);
    assert.equal(fs.readFileSync(path.join(reviewedDir, '正文', 's1.html'), 'utf8'), first, '复用审查结论时正文必须逐字保留');
    assert.match(fs.readFileSync(path.join(reviewedDir, '正文', 's2.html'), 'utf8'), /我方承诺在30日内交付并完成验收/);

    let resumedCalls = 0;
    const resumed = await naturalizeContentSections({
      aiService: { async chat() { resumedCalls += 1; throw new Error('未变化小节不应重复调用'); } },
      workspaceDir: reviewedDir,
      sections: reviewedSections,
      signal: new AbortController().signal,
      previousState: naturalizeState,
    });
    assert.equal(resumedCalls, 0, '恢复任务应按落盘哈希复用已处理小节');
    assert.equal(resumed.status, 'completed');
    fs.writeFileSync(path.join(reviewedDir, '正文', 's2.html'), second, 'utf8');
    const invalidated = invalidateNaturalizeStateForChangedHtml(resumed, reviewedDir, reviewedSections, ['s2']);
    assert.deepEqual(invalidated.stale_section_ids, ['s2'], '页数等后续改写必须让原文风审查状态失效');
    assert.deepEqual(invalidated.processed_section_ids, ['s1'], '改写后不得继续把该节标成已完成自然化审校');
    const mergedCheckpoint = mergeNaturalizeState(invalidated, {
      status: 'completed', section_ids: ['s2'], completed_section_ids: ['s2'], skipped_section_ids: [], stale_section_ids: [],
      processed_section_ids: ['s2'], processed_hashes: { s2: 'new-hash' }, failures: {},
    });
    assert.deepEqual(mergedCheckpoint.processed_section_ids, ['s1', 's2'], '变化节检查点合并不得丢失其他已审小节');
    let changedCalls = 0;
    const changed = await naturalizeContentSections({
      aiService: { async chat() {
        changedCalls += 1;
        return '<!-- yibiao:block -->\n<!-- yibiao:natural-keep-1 -->\n<!-- yibiao:block -->\n<p id="p2">项目团队围绕节点推进协同任务，并核对完成情况。</p>\n<!-- yibiao:block -->\n<!-- yibiao:natural-keep-2 -->';
      } },
      workspaceDir: reviewedDir,
      sections: reviewedSections,
      signal: new AbortController().signal,
      previousState: invalidated,
    });
    assert.equal(changedCalls, 1, '已处理小节后来发生变化时必须让检查点哈希失效并重新审校');
    assert.equal(changed.failures.s2, undefined);
  } finally {
    fs.rmSync(reviewedDir, { recursive: true, force: true });
  }

  const failedNaturalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-natural-failed-test-'));
  try {
    writeWorkspace(failedNaturalDir, critical);
    fs.writeFileSync(path.join(failedNaturalDir, '正文', 's2.html'), critical, 'utf8');
    const failed = await naturalizeContentSections({
      aiService: { async chat(request) {
        return request.logTitle.includes('1.1')
          ? '<!-- yibiao:block -->\n<p id="p2">遗漏了全部保护块。</p>'
          : '<!-- yibiao:block -->\n<!-- yibiao:natural-keep-1 -->\n<!-- yibiao:block -->\n<p id="p2">项目团队按节点落实任务，并核对成果。</p>\n<!-- yibiao:block -->\n<!-- yibiao:natural-keep-2 -->';
      } },
      workspaceDir: failedNaturalDir,
      sections: [
        { section_id: 's1', number: '1.1', title: '实施方案', file: '正文/s1.html' },
        { section_id: 's2', number: '1.2', title: '协同方案', file: '正文/s2.html' },
      ],
      signal: new AbortController().signal,
    });
    assert.ok(failed.failures.s1, '校验失败应明确记录待复核原因');
    assert.equal(fs.readFileSync(path.join(failedNaturalDir, '正文', 's1.html'), 'utf8'), critical, '去痕失败必须保留原文');
    assert.deepEqual(failed.completed_section_ids, ['s2'], '一个小节失败不得阻断其他小节完成');
    assert.match(fs.readFileSync(path.join(failedNaturalDir, '正文', 's2.html'), 'utf8'), /项目团队按节点落实任务/);
  } finally {
    fs.rmSync(failedNaturalDir, { recursive: true, force: true });
  }

  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-natural-legacy-test-'));
  try {
    writeWorkspace(legacyDir, critical);
    let legacyCalls = 0;
    const legacy = await naturalizeContentSections({
      aiService: { async chat() {
        legacyCalls += 1;
        return '<!-- yibiao:block -->\n<!-- yibiao:natural-keep-1 -->\n<!-- yibiao:block -->\n<p id="p2">项目团队按节点推进任务，并核对成果。</p>\n<!-- yibiao:block -->\n<!-- yibiao:natural-keep-2 -->';
      } },
      workspaceDir: legacyDir,
      sections: [{ section_id: 's1', number: '1.1', title: '实施方案', file: '正文/s1.html' }],
      signal: new AbortController().signal,
      previousState: { status: 'completed', section_ids: ['s1'], completed_section_ids: ['s1'], processed_section_ids: ['s1'], failures: {} },
    });
    assert.equal(legacyCalls, 1, '旧检查点没有HTML哈希时必须保守重审一次，不得仅按ID复用');
    assert.ok(legacy.processed_hashes.s1);
  } finally {
    fs.rmSync(legacyDir, { recursive: true, force: true });
  }

  const selectedReviewDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-selected-review-test-'));
  try {
    writeWorkspace(selectedReviewDir, critical);
    fs.writeFileSync(path.join(selectedReviewDir, '正文', 's2.html'), critical.replace('进一步认真开展相关工作', '针对变化小节完善执行安排'), 'utf8');
    fs.writeFileSync(path.join(selectedReviewDir, '正文编排决策.json'), JSON.stringify({
      global_facts_requirements: '不得新增事实',
      targets: [{ id: 's1', number: '1.1', title: '实施方案', file: '正文/s1.html' }],
      completed_sections: [{ id: 's2', number: '1.2', title: '变化小节', file: '正文/s2.html' }],
    }), 'utf8');
    let selectedReviewCalls = 0;
    const selectedReviewAi = {
      async chat() { return 'OK'; },
      async requestJson(request) {
        selectedReviewCalls += 1;
        const issues = selectedReviewCalls === 3
          ? [{ block_id: 'B1', type: '与全局事实冲突', problem: '页改后交付期限冲突', evidence: '全局事实', suggestion: '恢复30日' }] : [];
        const normalized = request.normalizer({ issues, facts: [], naturalness: { status: 'pass', issues: [] } });
        request.validator(normalized);
        return normalized;
      },
    };
    await extractConsistencyLedger({
      aiService: selectedReviewAi,
      workspaceDir: selectedReviewDir,
      signal: new AbortController().signal,
    });
    assert.equal(selectedReviewCalls, 2);
    fs.appendFileSync(path.join(selectedReviewDir, '正文', 's2.html'), '\n<!-- page-adjusted -->', 'utf8');
    await extractConsistencyLedger({
      aiService: selectedReviewAi,
      workspaceDir: selectedReviewDir,
      signal: new AbortController().signal,
      sectionIds: ['s2'],
    });
    assert.equal(selectedReviewCalls, 3, '页数改写后应只复核指定的变化小节');
    const selectedLedger = JSON.parse(fs.readFileSync(path.join(selectedReviewDir, '正文一致性事实台账.json'), 'utf8'));
    assert.equal(selectedLedger.sections.s2.issues.length, 1, '变化的历史参考小节必须转为本轮目标，不得强制清空事实问题');
    await extractConsistencyLedger({
      aiService: selectedReviewAi,
      workspaceDir: selectedReviewDir,
      signal: new AbortController().signal,
      sectionIds: ['s2'],
    });
    assert.equal(selectedReviewCalls, 3, '恢复时指定小节哈希未变不得重复请求模型');
  } finally {
    fs.rmSync(selectedReviewDir, { recursive: true, force: true });
  }

  const preferred = await measureDocumentPages('unused.docx', new AbortController().signal, {
    wordMeasure: async () => ({ pages: 12, source: 'microsoft-word' }),
    layoutDocument: async () => { throw new Error('不应调用降级布局'); },
  });
  assert.deepEqual(preferred, { pages: 12, source: 'microsoft-word' });
  const fallback = await measureDocumentPages('unused.docx', new AbortController().signal, {
    wordMeasure: async () => { throw new Error('Word 未安装'); },
    layoutDocument: async () => ({ pages: [{}, {}, {}] }),
  });
  assert.equal(fallback.pages, 3);
  assert.equal(fallback.source, 'docx-editor');
  assert.match(fallback.warning, /可能不同/);

  const rangeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-page-range-test-'));
  try {
    const original = `<!-- yibiao:block -->\n<p id="p1">${'项目团队围绕实施目标细化工作内容。'.repeat(18)}</p>`;
    writeWorkspace(rangeDir, original);
    let aiCalls = 0;
    const rangeState = await adjustContentToTargetPages({
      aiService: { async chat() { aiCalls += 1; throw new Error('区间内不应调用模型'); } },
      exporter: { async build() { return { buffer: Buffer.from('docx'), warnings: [] }; } },
      snapshot: {}, workspaceDir: rangeDir,
      sections: [{ section_id: 's1', number: '1.1', title: '实施方案', file: '正文/s1.html' }],
      targetPages: 100, minimumPages: 90, maximumPages: 110,
      signal: new AbortController().signal,
      wordMeasure: async () => ({ pages: 102, source: 'microsoft-word' }),
      layoutDocument: async () => { throw new Error('不应降级'); },
    });
    assert.equal(rangeState.in_range, true);
    assert.equal(rangeState.measured_pages, 102);
    assert.equal(aiCalls, 0);
  } finally {
    fs.rmSync(rangeDir, { recursive: true, force: true });
  }

  const shrinkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-page-range-shrink-test-'));
  try {
    const protectedFact = '<p id="fact">我方承诺在30日内交付并完成验收。</p>';
    const protectedTable = '<table id="roles"><tbody><tr><td>岗位</td><td>职责</td></tr><tr><td>项目经理</td><td>统筹检查</td></tr></tbody></table>';
    const protectedFigure = '<figure id="flow" data-yb-size="wide" data-yb-fit="contain"><img src="assets/flow.png" data-yb-asset-ref="assets/flow.png" alt="实施流程图"><figcaption>图1 实施流程图</figcaption></figure>';
    const editable = '<p id="editable">' + '首先，我们将进一步认真开展相关工作，切实推动方案有序运行。'.repeat(22) + '</p>';
    const firstOriginal = ['<!-- yibiao:block -->', protectedFact, '<!-- yibiao:block -->', editable,
      '<!-- yibiao:block -->', protectedTable, '<!-- yibiao:block -->', protectedFigure].join('\n');
    const secondOriginal = '<!-- yibiao:block -->\n<p id="second">' + '项目团队持续优化工作流程并做好过程记录。'.repeat(24) + '</p>';
    writeWorkspace(shrinkDir, firstOriginal);
    fs.writeFileSync(path.join(shrinkDir, '正文', 's2.html'), secondOriginal, 'utf8');
    let measureIndex = 0;
    const calls = [];
    const state = await adjustContentToTargetPages({
      aiService: {
        async chat(request) {
          calls.push(request);
          if (/s2|失败小节/.test(request.logTitle)) throw new Error('模拟单节压缩失败');
          return ['<!-- yibiao:block -->', '<!-- yibiao:natural-keep-1 -->', '<!-- yibiao:block -->',
            '<p id="editable">' + '项目团队按责任分工推进实施，在检查节点核对记录和交付成果。'.repeat(13) + '</p>',
            '<!-- yibiao:block -->', '<!-- yibiao:natural-keep-2 -->', '<!-- yibiao:block -->', '<!-- yibiao:natural-keep-3 -->'].join('\n');
        },
      },
      exporter: { async build() { return { buffer: Buffer.from('docx'), warnings: [] }; } },
      snapshot: {}, workspaceDir: shrinkDir,
      sections: [
        { section_id: 's1', number: '1.1', title: '实施方案', file: '正文/s1.html' },
        { section_id: 's2', number: '1.2', title: '失败小节', file: '正文/s2.html' },
      ],
      targetPages: 100, minimumPages: 90, maximumPages: 110,
      signal: new AbortController().signal,
      wordMeasure: async () => ({ pages: [150, 108][Math.min(measureIndex++, 1)], source: 'microsoft-word' }),
      layoutDocument: async () => { throw new Error('不应降级'); },
    });
    const firstAfter = fs.readFileSync(path.join(shrinkDir, '正文', 's1.html'), 'utf8');
    const secondAfter = fs.readFileSync(path.join(shrinkDir, '正文', 's2.html'), 'utf8');
    assert.equal(state.status, 'completed');
    assert.equal(state.in_range, true, '范围外高于上限时应压缩到范围内');
    assert.equal(state.measured_pages, 108);
    assert.equal(state.direction, 'shrink');
    assert.equal(state.failures.s1, undefined, JSON.stringify(state.failures));
    assert.ok(state.failures.s2, '单个小节失败必须记录，不得让整个篇幅任务失败');
    assert.match(state.warning, /1 个小节.*保留了原文.*人工复核/);
    assert.ok(firstAfter.length < firstOriginal.length, '成功小节应真实压缩并写回');
    assert.match(firstAfter, /我方承诺在30日内交付并完成验收/);
    assert.match(firstAfter, /<table id="roles">/);
    assert.match(firstAfter, /<figure id="flow"[^>]*>/);
    assert.match(firstAfter, /data-yb-asset-ref="assets\/flow\.png"/);
    assert.equal(secondAfter, secondOriginal, '失败小节必须保留校正前原文');
    assert.ok(calls.length >= 2);
    assert.ok(calls.every(request => request.messages[0].content.includes('自然文风质量标准')), '页数扩缩模型也必须复用自然文风标准');
  } finally {
    fs.rmSync(shrinkDir, { recursive: true, force: true });
  }

  const pageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-page-test-'));
  try {
    const original = `<!-- yibiao:block -->\n<p id="p1">${'项目团队围绕实施目标细化工作内容。'.repeat(18)}</p>`;
    writeWorkspace(pageDir, original);
    let measureIndex = 0;
    const measurements = [4, 5];
    const pageState = await adjustContentToTargetPages({
      aiService: { async chat() { return `<!-- yibiao:block -->\n<p id="p1">${'项目团队围绕实施目标细化任务、责任分工、检查节点和交付成果。'.repeat(23)}</p>`; } },
      exporter: { async build() { return { buffer: Buffer.from('docx'), warnings: [] }; } },
      snapshot: {},
      workspaceDir: pageDir,
      sections: [{ section_id: 's1', number: '1.1', title: '实施方案', file: '正文/s1.html' }],
      targetPages: 5,
      signal: new AbortController().signal,
      wordMeasure: async () => ({ pages: measurements[Math.min(measureIndex++, measurements.length - 1)], source: 'microsoft-word' }),
      layoutDocument: async () => { throw new Error('不应降级'); },
    });
    assert.equal(pageState.status, 'completed');
    assert.equal(pageState.in_range, true);
    assert.equal(pageState.measured_pages, 5);
    assert.equal(pageState.measurement_source, 'microsoft-word');
    assert.notEqual(fs.readFileSync(path.join(pageDir, '正文', 's1.html'), 'utf8'), original, `页数闭环应写回通过复测的正文：${JSON.stringify(pageState)}`);
  } finally {
    fs.rmSync(pageDir, { recursive: true, force: true });
  }

  const partialPageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-page-partial-test-'));
  try {
    const original = `<!-- yibiao:block -->\n<p id="p1">${'项目团队围绕实施目标细化工作内容。'.repeat(18)}</p>`;
    writeWorkspace(partialPageDir, original);
    let measureIndex = 0;
    const pageState = await adjustContentToTargetPages({
      aiService: { async chat() { return '<!-- yibiao:block -->\n<p id="p1"></p>'; } },
      exporter: { async build() { return { buffer: Buffer.from('docx'), warnings: [] }; } },
      snapshot: {}, workspaceDir: partialPageDir,
      sections: [{ section_id: 's1', number: '1.1', title: '实施方案', file: '正文/s1.html' }],
      targetPages: 5, signal: new AbortController().signal,
      wordMeasure: async () => ({ pages: [4, 5][Math.min(measureIndex++, 1)], source: 'microsoft-word' }),
      layoutDocument: async () => { throw new Error('不应降级'); },
    });
    assert.equal(pageState.in_range, true);
    assert.match(pageState.warning, /保留了原文.*人工复核/);
    assert.equal(fs.readFileSync(path.join(partialPageDir, '正文', 's1.html'), 'utf8'), original);
  } finally {
    fs.rmSync(partialPageDir, { recursive: true, force: true });
  }

  const rollbackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-page-rollback-test-'));
  try {
    const original = `<!-- yibiao:block -->\n<p id="p1">${'项目团队围绕实施目标细化工作内容。'.repeat(18)}</p>`;
    writeWorkspace(rollbackDir, original);
    let measureIndex = 0;
    const pageState = await adjustContentToTargetPages({
      aiService: { async chat() { return `<!-- yibiao:block -->\n<p id="p1">${'项目团队围绕实施目标细化任务、检查节点和成果。'.repeat(24)}</p>`; } },
      exporter: { async build() { return { buffer: Buffer.from('docx'), warnings: [] }; } },
      snapshot: {}, workspaceDir: rollbackDir,
      sections: [{ section_id: 's1', number: '1.1', title: '实施方案', file: '正文/s1.html' }],
      targetPages: 5, signal: new AbortController().signal,
      wordMeasure: async () => ({ pages: [4, 3][Math.min(measureIndex++, 1)], source: 'microsoft-word' }),
      layoutDocument: async () => { throw new Error('不应降级'); },
    });
    assert.equal(pageState.in_range, false);
    assert.match(pageState.warning, /已恢复/);
    assert.equal(fs.readFileSync(path.join(rollbackDir, '正文', 's1.html'), 'utf8'), original, '复测变差应回滚本轮正文');
  } finally {
    fs.rmSync(rollbackDir, { recursive: true, force: true });
  }

  console.log('content post-processing checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
