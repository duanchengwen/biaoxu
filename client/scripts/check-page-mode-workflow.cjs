// 篇幅双模式与独立页数优化 Task 回归。全部使用本地 stub，不调用模型或 Word。
//   node --test scripts/check-page-mode-workflow.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const taskPath = '../electron/services/contentGenerationTask.cjs';

function loadFresh(modulePath, mocks) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  const original = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
    return original.call(this, request, parent, isMain);
  };
  try { return require(resolved); }
  finally { Module._load = original; }
}

function createPlan(workspaceDir, {
  phase = 'word-completed',
  pageOptimizationOnly = false,
  pageOptimizationOptions,
  status = 'success',
} = {}) {
  return {
    outlineData: {
      project_name: '双模式测试项目', project_overview: '某公共服务项目',
      outline: [{ id: 's1', number: '1', title: '实施方案', content_mode: 'ai-generate', children: [] }],
    },
    globalFacts: [{ title: '工期', content: '30日' }],
    globalFactsTask: { status: 'success' },
    globalFactsMode: 'omit',
    contentGenerationOptions: { naturalizeWriting: true, imageQuantity: 0, tableRequirement: 'none', layoutCheck: false },
    outlineWordControlSnapshot: {
      mode: 'words', minimumWords: 12000, maximumWords: 18000, sectionWords: 2600,
      targetPages: 36, minimumPages: 30, maximumPages: 42,
    },
    contentGenerationSections: { s1: { id: 's1', title: '实施方案', status: 'success', content: '已生成正文' } },
    contentGenerationPlans: {},
    contentGenerationRuntime: {
      generation_started: true,
      phase,
      section_words: { s1: 100 },
      pending_item_ids: [],
      direct_generation_item_ids: [],
      touched_item_ids: [],
      completed_stages: ['planning'],
      page_optimization_only: pageOptimizationOnly,
      page_optimization_options: pageOptimizationOptions,
      html_output: { workspace_dir: workspaceDir, word_output_dir: path.join(workspaceDir, 'word'), word_sections: [] },
    },
    contentGenerationTask: { status, progress: status === 'paused' ? 70 : 100, stats: { content: {} } },
    referenceKnowledgeDocumentIds: [],
    exportTemplateId: 'template-test',
  };
}

async function runScenario({ payload, plan, pageChanged = false }) {
  const calls = { generation: 0, naturalize: 0, consistencyReview: 0, pageAdjust: [], convert: 0, checkpoints: [], updates: [] };
  const originalControl = structuredClone(plan.outlineWordControlSnapshot);
  const result = {
    workspaceDir: plan.contentGenerationRuntime.html_output.workspace_dir,
    sections: [{ section_id: 's1', number: '1', title: '实施方案', file: '正文/s1.html', words: 100 }],
  };
  const { runContentGenerationTask } = loadFresh(taskPath, {
    './contentGenerationAgent.cjs': {
      CONTENT_GENERATION_AGENT_TASK_KEY: 'content-generation',
      CONTINUE_PROMPT: '继续',
      wasStagePrompted: () => false,
      buildContentGenerationFiles: () => { throw new Error('篇幅优化不得构造新正文输入'); },
      async runContentGenerationAgent() { calls.generation += 1; throw new Error('篇幅优化不得生成初稿'); },
      readContentGenerationResult: () => structuredClone(result),
    },
    './contentGenerationOutput.cjs': {
      scanGeneratedSections: () => [],
      async convertContentSections({ result: output, onProgress }) {
        calls.convert += 1;
        const converted = output.sections.map((section) => ({ section_id: section.section_id, file: `${section.section_id}.docx` }));
        onProgress?.(converted);
        return converted;
      },
    },
    './technicalPlanExport.cjs': {
      createTechnicalPlanExport: () => ({ prepare: () => ({ snapshot: true }) }),
    },
    './contentGenerationNaturalize.cjs': {
      async naturalizeContentSections() { calls.naturalize += 1; throw new Error('篇幅优化不得运行去痕'); },
      invalidateNaturalizeStateForChangedHtml(previousState) { return previousState; },
      mergeNaturalizeState(_previousState, partialState) { return partialState; },
    },
    './contentGenerationConsistencyTools.cjs': {
      async extractConsistencyLedger() {
        calls.consistencyReview += 1;
        return { version: 3, sections: { s1: { version: 3, hash: 'reviewed', issues: [], facts: [], naturalness: { status: 'needs_revision', issues: [{ problem: '待改进' }] } } }, failures: {} };
      },
      collectNaturalnessApprovedHashes() { return {}; },
      collectProtectedFactBlockIds() { return {}; },
    },
    './contentGenerationPages.cjs': {
      async adjustContentToTargetPages(options) {
        calls.pageAdjust.push(options);
        if (pageChanged) fs.appendFileSync(path.join(result.workspaceDir, '正文', 's1.html'), '\n<p>页数校正改写</p>', 'utf8');
        const state = {
          status: 'completed', measured_pages: 102, measurement_source: 'microsoft-word', in_range: true,
          target_pages: options.targetPages, minimum_pages: options.minimumPages, maximum_pages: options.maximumPages,
          completed_section_ids: pageChanged ? ['s1'] : [],
        };
        options.onProgress?.(state);
        return state;
      },
    },
  });

  const workspaceStore = { loadTechnicalPlan: () => plan };
  await runContentGenerationTask({
    aiService: { getConfig: () => ({ concurrency_limit: 1, developer_mode: false }) },
    agentService: { hasPersistentTaskSession: () => false, updatePersistentTask: () => {}, loadPersistentTask: () => null },
    workspaceStore,
    knowledgeBaseService: {},
    templateStore: { getTemplate: () => ({}) },
    openXmlHelperService: {},
    updateTask(task, state, event, options) { calls.updates.push({ task, state, event, options }); },
    checkpointTask(task, state, event) { calls.checkpoints.push({ task, state, event }); },
    payload,
    taskControl: { signal: new AbortController().signal, isPauseRequested: () => false },
    previousState: payload.resume ? plan : undefined,
  });
  assert.deepEqual(plan.outlineWordControlSnapshot, originalControl, '临时篇幅优化不得改写原生成设置');
  assert.ok([...calls.checkpoints, ...calls.updates].every((entry) => !entry.state?.outlineWordControlSnapshot),
    '任务检查点不得用临时页数参数覆盖原字数/页数设置');
  return calls;
}

function textHash(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function createPostPagePlan(workspaceDir, {
  postPageReviewState,
  naturalizeState,
  naturalizeWriting = true,
  phase = 'word-completed',
  status = 'success',
} = {}) {
  const plan = createPlan(workspaceDir, { phase, status });
  plan.outlineData.outline = [
    { id: 's1', number: '1', title: '本轮正文', content_mode: 'ai-generate', children: [] },
    { id: 's2', number: '2', title: '历史参考小节', content_mode: 'ai-generate', children: [] },
  ];
  plan.outlineWordControlSnapshot = {
    ...plan.outlineWordControlSnapshot,
    mode: 'pages', targetPages: 100, minimumPages: 90, maximumPages: 110,
  };
  plan.contentGenerationOptions.naturalizeWriting = naturalizeWriting;
  plan.contentGenerationSections = {
    s1: { id: 's1', title: '本轮正文', status: 'success', content: '' },
    s2: { id: 's2', title: '历史参考小节', status: 'success', content: '' },
  };
  plan.contentGenerationRuntime.section_words = { s1: 100, s2: 100 };
  plan.contentGenerationRuntime.post_page_review_state = postPageReviewState;
  plan.contentGenerationRuntime.naturalize_state = naturalizeState;
  plan.contentGenerationRuntime.page_adjust_state = phase === 'page-adjusting'
    ? { status: 'completed', completed_section_ids: ['s2'], measured_pages: 102, measurement_source: 'microsoft-word', in_range: true }
    : undefined;
  return plan;
}

async function runPostPageScenario({
  verdict = 'pass',
  resumeStage = '',
  naturalizeWriting = true,
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `yibiao-post-page-${verdict}-`));
  fs.mkdirSync(path.join(directory, '正文'), { recursive: true });
  fs.writeFileSync(path.join(directory, '正文', 's1.html'), '<p id="s1">本轮正文保持不变。</p>', 'utf8');
  const originalS2 = '<p id="fact">历史参考小节承诺30日内交付。</p>\n<p id="style">首先进一步切实推进相关工作。</p>';
  const adjustedS2 = `${originalS2}\n<p id="page">页数扩缩后的新增内容。</p>`;
  fs.writeFileSync(path.join(directory, '正文', 's2.html'), resumeStage ? adjustedS2 : originalS2, 'utf8');
  fs.mkdirSync(path.join(directory, 'word'), { recursive: true });

  const adjustedHash = textHash(adjustedS2);
  const resumeNaturalizeState = resumeStage === 'naturalizing'
    ? {
      status: 'completed', section_ids: ['s2'], completed_section_ids: ['s2'], skipped_section_ids: [],
      processed_section_ids: ['s2'], processed_hashes: { s2: adjustedHash }, stale_section_ids: [], failures: {},
    }
    : undefined;
  const resumeReviewState = resumeStage
    ? {
      status: resumeStage,
      changed_section_ids: ['s2'],
      ...(resumeStage === 'naturalizing' ? { fact_pending: [], approved_hashes: {} } : {}),
    }
    : undefined;
  const plan = createPostPagePlan(directory, {
    phase: resumeStage ? 'page-adjusting' : 'word-completed',
    status: resumeStage ? 'paused' : 'success',
    postPageReviewState: resumeReviewState,
    naturalizeState: resumeNaturalizeState,
    naturalizeWriting,
  });
  const calls = {
    events: [], checkpoints: [], paidReview: 0, paidRewrite: 0,
    extractInvocations: 0, naturalizeInvocations: 0, pageAdjust: 0, finalMeasure: 0, convert: 0,
  };
  const result = () => ({
    workspaceDir: directory,
    sections: [
      { section_id: 's1', number: '1', title: '本轮正文', file: '正文/s1.html', words: 100 },
      { section_id: 's2', number: '2', title: '历史参考小节', file: '正文/s2.html', words: 100 },
    ],
  });

  try {
    const { runContentGenerationTask } = loadFresh(taskPath, {
      './contentGenerationAgent.cjs': {
        CONTENT_GENERATION_AGENT_TASK_KEY: 'content-generation', CONTINUE_PROMPT: '继续', wasStagePrompted: () => false,
        buildContentGenerationFiles: () => { throw new Error('篇幅优化不得重建初稿'); },
        runContentGenerationAgent: async () => { throw new Error('篇幅优化不得调用正文 Agent'); },
        readContentGenerationResult: () => result(),
      },
      './contentGenerationOutput.cjs': {
        scanGeneratedSections: () => [],
        async convertContentSections({ result: output, onProgress }) {
          calls.convert += 1;
          calls.events.push('word-convert');
          const latest = calls.checkpoints.at(-1)?.state?.contentGenerationRuntime?.post_page_review_state;
          assert.equal(latest?.status, 'completed', 'Word 转换必须发生在变化小节复核最终检查点之后');
          const converted = output.sections.map(section => ({ section_id: section.section_id, file: `${section.section_id}.docx` }));
          onProgress?.(converted);
          return converted;
        },
      },
      './technicalPlanExport.cjs': { createTechnicalPlanExport: () => ({ prepare: () => ({ snapshot: true }) }) },
      './contentGenerationConsistencyTools.cjs': {
        async extractConsistencyLedger(options) {
          calls.extractInvocations += 1;
          calls.events.push('review');
          assert.deepEqual(options.sectionIds, ['s2'], '页改后只能复核真实变化的小节');
          // reviewing 恢复仍进入读取台账函数，但同哈希台账应避免新的付费 requestJson。
          if (resumeStage !== 'reviewing') calls.paidReview += 1;
          const issues = verdict === 'fact_issue'
            ? [{ block_id: 'fact', type: '与全局事实冲突', problem: '交付期限与事实设定冲突' }]
            : [];
          return {
            version: 3,
            sections: { s2: { hash: textHash(fs.readFileSync(path.join(directory, '正文', 's2.html'), 'utf8')), issues, facts: [], naturalness: { status: verdict === 'pass' ? 'pass' : 'needs_revision', issues: verdict === 'pass' ? [] : [{ block_id: 'style', problem: '套话' }] } } },
            failures: {},
          };
        },
        collectNaturalnessApprovedHashes() {
          return verdict === 'pass'
            ? { s2: textHash(fs.readFileSync(path.join(directory, '正文', 's2.html'), 'utf8')) }
            : {};
        },
        collectProtectedFactBlockIds() { return { s2: ['fact'] }; },
      },
      './contentGenerationNaturalize.cjs': {
        invalidateNaturalizeStateForChangedHtml(previousState) {
          return previousState || { status: 'running', section_ids: [], completed_section_ids: [], skipped_section_ids: [], processed_section_ids: [], processed_hashes: {}, stale_section_ids: ['s2'], failures: {} };
        },
        mergeNaturalizeState(previousState, partialState) {
          return partialState || previousState;
        },
        async naturalizeContentSections(options) {
          calls.naturalizeInvocations += 1;
          calls.events.push('naturalize');
          if (resumeStage === 'naturalizing') {
            assert.equal(options.previousState.processed_hashes.s2, adjustedHash);
            return structuredClone(options.previousState);
          }
          if (verdict === 'pass') {
            assert.ok(options.approvedHashes.s2, '文风 pass 且哈希匹配必须直接复用同次复核结果');
            return {
              status: 'completed', section_ids: ['s2'], completed_section_ids: [], skipped_section_ids: ['s2'],
              processed_section_ids: ['s2'], processed_hashes: { s2: options.approvedHashes.s2 }, stale_section_ids: [], failures: {},
            };
          }
          calls.paidRewrite += 1;
          fs.appendFileSync(path.join(directory, '正文', 's2.html'), '\n<p id="naturalized">去痕后的自然表述。</p>', 'utf8');
          const state = {
            status: 'completed', section_ids: ['s2'], completed_section_ids: ['s2'], skipped_section_ids: [],
            processed_section_ids: ['s2'], processed_hashes: { s2: textHash(fs.readFileSync(path.join(directory, '正文', 's2.html'), 'utf8')) }, stale_section_ids: [], failures: {},
          };
          options.onProgress?.(state);
          return state;
        },
      },
      './contentGenerationPages.cjs': {
        async adjustContentToTargetPages(options) {
          calls.pageAdjust += 1;
          calls.events.push('page-adjust');
          if (!resumeStage) fs.writeFileSync(path.join(directory, '正文', 's2.html'), adjustedS2, 'utf8');
          const state = {
            status: 'completed', measured_pages: 102, measurement_source: 'microsoft-word', in_range: true,
            target_pages: options.targetPages, minimum_pages: options.minimumPages, maximum_pages: options.maximumPages,
            completed_section_ids: ['s2'],
          };
          options.onProgress?.(state);
          return state;
        },
        async measureContentDocumentPages() {
          calls.finalMeasure += 1;
          calls.events.push('final-measure');
          return { pages: 103, source: 'microsoft-word' };
        },
      },
    });

    const workspaceStore = { loadTechnicalPlan: () => plan };
    await runContentGenerationTask({
      aiService: { getConfig: () => ({ concurrency_limit: 1, developer_mode: false }) },
      agentService: { hasPersistentTaskSession: () => false, updatePersistentTask: () => {}, loadPersistentTask: () => null },
      workspaceStore, knowledgeBaseService: {}, templateStore: { getTemplate: () => ({}) }, openXmlHelperService: {},
      updateTask() {},
      checkpointTask(task, state, event) {
        calls.checkpoints.push({ task, state: structuredClone(state), event });
        if (state?.contentGenerationRuntime?.post_page_review_state?.status === 'completed'
          && !calls.events.includes('post-review-completed')) calls.events.push('post-review-completed');
      },
      payload: resumeStage
        ? { resume: true }
        : { pageOptimizeOnly: true, pageOptimizationOptions: { targetPages: 100, minimumPages: 90, maximumPages: 110 } },
      taskControl: { signal: new AbortController().signal, isPauseRequested: () => false },
      previousState: resumeStage ? plan : undefined,
    });
    return { calls, finalRuntime: calls.checkpoints.at(-1).state.contentGenerationRuntime };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('独立篇幅优化：只复用已成功 HTML 做页数闭环，不生成初稿、不去痕、不改原设置', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-page-optimize-only-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, '正文'), { recursive: true });
  fs.writeFileSync(path.join(directory, '正文', 's1.html'), '<p>已生成正文</p>');
  const options = { targetPages: 100, minimumPages: 90, maximumPages: 110 };
  const plan = createPlan(directory);
  const calls = await runScenario({ payload: { pageOptimizeOnly: true, pageOptimizationOptions: options }, plan });
  assert.deepEqual([calls.generation, calls.naturalize, calls.pageAdjust.length, calls.convert], [0, 0, 1, 1]);
  assert.deepEqual({
    targetPages: calls.pageAdjust[0].targetPages,
    minimumPages: calls.pageAdjust[0].minimumPages,
    maximumPages: calls.pageAdjust[0].maximumPages,
  }, options);
  const finalRuntime = calls.checkpoints.at(-1).state.contentGenerationRuntime;
  assert.equal(finalRuntime.page_optimization_only, false, '独立优化成功后必须清掉续跑标志');
  assert.deepEqual(finalRuntime.page_optimization_options, options, '完成记录保留本次临时验收参数供审计');
});

test('恢复 page-adjusting：从 runtime 恢复临时区间，不回退到原 words/pages 设置', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-page-adjust-resume-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, '正文'), { recursive: true });
  fs.writeFileSync(path.join(directory, '正文', 's1.html'), '<p>已生成正文</p>');
  const options = { targetPages: 72, minimumPages: 68, maximumPages: 76 };
  const plan = createPlan(directory, { phase: 'page-adjusting', pageOptimizationOnly: true, pageOptimizationOptions: options, status: 'paused' });
  const calls = await runScenario({ payload: { resume: true }, plan });
  assert.deepEqual([calls.generation, calls.naturalize, calls.pageAdjust.length], [0, 0, 1]);
  assert.deepEqual({
    targetPages: calls.pageAdjust[0].targetPages,
    minimumPages: calls.pageAdjust[0].minimumPages,
    maximumPages: calls.pageAdjust[0].maximumPages,
  }, options);
});

test('恢复 word-converting：已完成页数调整时只转 Word，不重复付费调整或误跑生成/去痕', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-page-convert-resume-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, '正文'), { recursive: true });
  fs.writeFileSync(path.join(directory, '正文', 's1.html'), '<p>已生成正文</p>');
  const options = { targetPages: 60, minimumPages: 58, maximumPages: 63 };
  const plan = createPlan(directory, { phase: 'word-converting', pageOptimizationOnly: true, pageOptimizationOptions: options, status: 'paused' });
  const calls = await runScenario({ payload: { resume: true }, plan });
  assert.deepEqual([calls.generation, calls.naturalize, calls.pageAdjust.length, calls.convert], [0, 0, 0, 1]);
  const finalRuntime = calls.checkpoints.at(-1).state.contentGenerationRuntime;
  assert.equal(finalRuntime.page_optimization_only, false);
  assert.deepEqual(finalRuntime.page_optimization_options, options);
});

test('关闭自动 AI 去痕后：页改仍复核事实，但不主动做文风改写', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-page-review-no-naturalize-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, '正文'), { recursive: true });
  fs.writeFileSync(path.join(directory, '正文', 's1.html'), '<p>已生成正文</p>');
  const options = { targetPages: 100, minimumPages: 90, maximumPages: 110 };
  const plan = createPlan(directory);
  plan.contentGenerationOptions.naturalizeWriting = false;
  const calls = await runScenario({
    payload: { pageOptimizeOnly: true, pageOptimizationOptions: options },
    plan,
    pageChanged: true,
  });
  assert.deepEqual([calls.generation, calls.consistencyReview, calls.naturalize, calls.pageAdjust.length, calls.convert], [0, 1, 0, 1, 1]);
  const finalRuntime = calls.checkpoints.at(-1).state.contentGenerationRuntime;
  assert.equal(finalRuntime.post_page_review_state.status, 'completed');
  assert.equal(finalRuntime.post_page_review_state.style_rewrite_disabled, true);
  assert.deepEqual(finalRuntime.post_page_review_state.style_pending, ['s1']);
});

test('页改后同次复核为 pass：不重复改写/计页，完成检查点早于 Word', async () => {
  const { calls, finalRuntime } = await runPostPageScenario({ verdict: 'pass' });
  assert.deepEqual({
    paidReview: calls.paidReview,
    paidRewrite: calls.paidRewrite,
    pageAdjust: calls.pageAdjust,
    finalMeasure: calls.finalMeasure,
    convert: calls.convert,
  }, { paidReview: 1, paidRewrite: 0, pageAdjust: 1, finalMeasure: 0, convert: 1 });
  assert.ok(calls.events.indexOf('post-review-completed') < calls.events.indexOf('word-convert'));
  assert.equal(finalRuntime.post_page_review_state.status, 'completed');
  assert.deepEqual(finalRuntime.post_page_review_state.fact_pending, []);
  assert.equal(finalRuntime.post_page_review_state.page_verified, true);
});

test('页改后需润色：只改变化历史小节且只复测一次，随后才转 Word', async () => {
  const { calls, finalRuntime } = await runPostPageScenario({ verdict: 'needs_revision' });
  assert.deepEqual({
    paidReview: calls.paidReview,
    paidRewrite: calls.paidRewrite,
    pageAdjust: calls.pageAdjust,
    finalMeasure: calls.finalMeasure,
    convert: calls.convert,
  }, { paidReview: 1, paidRewrite: 1, pageAdjust: 1, finalMeasure: 1, convert: 1 });
  assert.deepEqual(calls.events.filter(item => ['page-adjust', 'review', 'naturalize', 'final-measure', 'post-review-completed', 'word-convert'].includes(item)),
    ['page-adjust', 'review', 'naturalize', 'final-measure', 'post-review-completed', 'word-convert']);
  assert.equal(finalRuntime.post_page_review_state.status, 'completed');
  assert.equal(finalRuntime.post_page_review_state.final_pages, 103);
});

test('页改后事实冲突：不能被文风结论覆盖，不改写且 Word 仍在待复核检查点后生成', async () => {
  const { calls, finalRuntime } = await runPostPageScenario({ verdict: 'fact_issue' });
  assert.equal(calls.paidReview, 1);
  assert.equal(calls.naturalizeInvocations, 0);
  assert.equal(calls.paidRewrite, 0);
  assert.equal(calls.finalMeasure, 0);
  assert.equal(calls.convert, 1);
  assert.deepEqual(finalRuntime.post_page_review_state.fact_pending.map(item => item.section_id), ['s2']);
  assert.ok(calls.events.indexOf('post-review-completed') < calls.events.indexOf('word-convert'));
});

test('页改复核恢复：reviewing/naturalizing 均不重复产生付费模型请求', async () => {
  const reviewing = await runPostPageScenario({ verdict: 'pass', resumeStage: 'reviewing' });
  assert.equal(reviewing.calls.extractInvocations, 1, 'reviewing 恢复应读取同哈希台账');
  assert.equal(reviewing.calls.paidReview, 0, '同哈希台账恢复不得重复 requestJson');
  assert.equal(reviewing.calls.paidRewrite, 0);
  assert.equal(reviewing.calls.convert, 1);

  const naturalizing = await runPostPageScenario({ verdict: 'needs_revision', resumeStage: 'naturalizing' });
  assert.equal(naturalizing.calls.extractInvocations, 0, 'naturalizing 恢复应复用已完成结构化复核');
  assert.equal(naturalizing.calls.paidReview, 0);
  assert.equal(naturalizing.calls.naturalizeInvocations, 1, '应进入哈希恢复函数确认落盘状态');
  assert.equal(naturalizing.calls.paidRewrite, 0, '已处理且哈希一致的小节不得重复付费改写');
  assert.equal(naturalizing.calls.finalMeasure, 1, '恢复后只执行改写后的最终一次页数实测');
  assert.equal(naturalizing.calls.convert, 1);
});

test('words 模式无页约束：恢复 Word 转换不得附加页数调整/复核/去痕调用', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-words-no-page-post-review-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, '正文'), { recursive: true });
  fs.writeFileSync(path.join(directory, '正文', 's1.html'), '<p>字数模式正文</p>', 'utf8');
  const plan = createPlan(directory, { phase: 'word-converting', status: 'paused' });
  const calls = await runScenario({ payload: { resume: true }, plan });
  assert.deepEqual([calls.pageAdjust.length, calls.consistencyReview, calls.naturalize, calls.convert], [0, 0, 0, 1]);
});
