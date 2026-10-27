// 图片画面文字检查/修复的 Main Task 与 Agent 接线回归。
// 全部依赖本地 stub，不调用模型或系统 OCR：node --test scripts/check-blind-check-image-workflow.cjs
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const AdmZip = require('adm-zip');

const taskPath = '../electron/services/blindCheckTask.cjs';
const fixTaskPath = '../electron/services/blindCheckFixTask.cjs';
const agentPath = '../electron/services/blindCheckAgent.cjs';
const realImageText = require('../electron/services/blindCheckImageText.cjs');
const { mapReport } = require(taskPath);

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

function rawEmptyReport() {
  return {
    summary: { high: 0, medium: 0, low: 0, total: 0 },
    stats: { paragraphs: 2, images: 2, rules_checked: 10 },
    rule_errors: [],
    groups: [],
  };
}

function coveredFact({ part = 'word/media/shared.png', hash = 'original-hash', text = '项目负责人：张三' } = {}) {
  return {
    part, status: 'covered', hash, text, width: 100, height: 30,
    regions: [{ text, x: 2, y: 2, width: 90, height: 20 }],
    references: [{ part: 'word/document.xml', locator: 'word/document.xml#image1', where: '正文第1个图片引用' }],
  };
}

test('检查 Task：OCR stats/groups 写入结果，并把同一份 facts 与图片问题完整传给 AI 复核', async () => {
  const facts = [coveredFact(), {
    part: 'word/media/vector.emf', status: 'unknown', hash: 'vector-hash', text: '', regions: [], reason: 'unsupported_format',
    references: [{ part: 'word/header1.xml', locator: 'word/header1.xml#image1', where: '页眉第1个图片引用' }],
  }];
  let reviewArgs;
  const imageModule = { ...realImageText, collectImageTextFacts: async () => facts };
  const agentModule = {
    agentActivityText: () => '',
    async runBlindCheckReviewAgent(args) {
      reviewArgs = args;
      return { review: { summary: '完成', clauses: [], verdicts: {}, issues: [] } };
    },
  };
  const { runBlindCheckTask } = loadFresh(taskPath, {
    './blindCheckImageText.cjs': imageModule,
    './blindCheckAgent.cjs': agentModule,
  });
  const checkpoints = [];
  const input = {
    source: 'source.docx', sourcePath: 'C:/not-read/source.docx', signature: 'sig-check', fileName: '测试.docx',
    presetName: '暗标', presetId: 'preset', sensitiveWords: ['张三'],
    profile: { image: { check_color: false, check_text: true }, privacy: { enable_builtin: true, keywords: [] } },
  };
  await runBlindCheckTask({
    agentService: {}, aiService: {}, payload: { aiReview: true }, taskControl: { signal: new AbortController().signal },
    workspaceStore: {
      prepareCheckInput: () => input,
      setAiReviewEnabled: () => {},
      readPresetTender: () => ({ fileName: '招标文件.docx', content: '不得出现人员姓名' }),
    },
    openXmlHelperService: { runBlindCheck: async () => rawEmptyReport() },
    updateTask: () => {},
    checkpointTask(task, state = {}) {
      checkpoints.push({ task, state });
      return { task: { task_id: 'task-check' } };
    },
  });

  const checked = checkpoints.find((item) => item.state.result?.status === 'success')?.state.result;
  assert.ok(checked, '程序结果应先落一个成功检查点');
  assert.deepEqual([checked.stats.imageOcrTotal, checked.stats.imageOcrChecked, checked.stats.imageOcrUnknown], [2, 1, 1]);
  assert.deepEqual(checked.groups.map((group) => group.ruleId), ['image.text_sensitive', 'image.ocr_unchecked']);
  assert.deepEqual(
    Object.fromEntries(['part', 'expectedText', 'sourceHash', 'text'].map((key) => [key, checked.groups[0].items[0][key]])),
    { part: 'word/media/shared.png', expectedText: '张三', sourceHash: 'original-hash', text: '张三' },
  );
  assert.equal(reviewArgs.taskId, 'task-check');
  assert.deepEqual(reviewArgs.imageTextFacts, facts);
  assert.deepEqual(reviewArgs.groups.map((group) => group.ruleId), ['image.text_sensitive', 'image.ocr_unchecked']);
  const finalReview = checkpoints.at(-1).state.review;
  assert.deepEqual([finalReview.status, finalReview.review.hasTender, finalReview.review.tenderName], ['success', true, '招标文件.docx']);
});

test('检查 Task：AI复核+多模态即使关闭本地文字检查也走模型主识别；程序only或关闭开关零模型调用', async () => {
  const run = async ({ aiReview, multimodal, checkText }) => {
    const localFacts = [coveredFact({ text: '本地文字：项目负责人 张三' })];
    const modelFacts = [{
      ...coveredFact({ text: '模型完整抄录：项目负责人 张三' }),
      primarySource: 'multimodal', modelText: '模型完整抄录：项目负责人 张三', identifiers: [{ text: '张三', kind: 'person' }],
      vision: { status: 'reviewed' },
    }];
    const calls = { local: [], model: [], review: [] };
    const imageModule = {
      ...realImageText,
      async collectImageTextFacts(file, options) { calls.local.push({ file, options }); return localFacts; },
      async collectModelImageTextFacts(file, options) { calls.model.push({ file, options }); return modelFacts; },
    };
    const agentModule = {
      agentActivityText: () => '',
      async runBlindCheckReviewAgent(args) {
        calls.review.push(args);
        return { review: { summary: '完成', clauses: [], verdicts: {}, issues: [] } };
      },
    };
    const { runBlindCheckTask } = loadFresh(taskPath, {
      './blindCheckImageText.cjs': imageModule,
      './blindCheckAgent.cjs': agentModule,
    });
    const input = {
      source: 'source.docx', sourcePath: 'C:/not-read/source.docx', signature: `sig-${aiReview}-${multimodal}-${checkText}`, fileName: '测试.docx',
      presetName: '暗标', presetId: 'preset', sensitiveWords: ['张三'],
      profile: { image: { check_color: false, check_text: checkText }, privacy: { enable_builtin: true, keywords: [] } },
    };
    const checkpoints = [];
    await runBlindCheckTask({
      agentService: {}, aiService: { getConfig: () => ({ multimodal_enabled: multimodal }) }, payload: { aiReview },
      taskControl: { signal: new AbortController().signal },
      workspaceStore: {
        prepareCheckInput: () => input,
        setAiReviewEnabled: () => {},
        readPresetTender: () => null,
      },
      openXmlHelperService: { runBlindCheck: async () => rawEmptyReport() },
      updateTask: () => {},
      checkpointTask(task, state = {}) {
        checkpoints.push({ task, state });
        return { task: { task_id: 'dispatch-task' } };
      },
    });
    return { calls, checkpoints };
  };

  const modelFirst = await run({ aiReview: true, multimodal: true, checkText: false });
  assert.deepEqual([modelFirst.calls.model.length, modelFirst.calls.local.length, modelFirst.calls.review.length], [1, 0, 1]);
  assert.equal(modelFirst.calls.model[0].options.auxiliaryOcr, false, '关闭本地文字检查只关闭辅助定位，不得关闭模型主识别');
  assert.strictEqual(modelFirst.calls.model[0].options.aiService.getConfig().multimodal_enabled, true);
  assert.deepEqual(modelFirst.calls.review[0].imageTextFacts.map((fact) => fact.primarySource), ['multimodal']);

  const programOnly = await run({ aiReview: false, multimodal: true, checkText: true });
  assert.deepEqual([programOnly.calls.model.length, programOnly.calls.local.length, programOnly.calls.review.length], [0, 1, 0],
    '仅程序检查即使配置支持多模态也不能调用模型');

  const disabled = await run({ aiReview: true, multimodal: false, checkText: true });
  assert.deepEqual([disabled.calls.model.length, disabled.calls.local.length, disabled.calls.review.length], [0, 1, 1],
    '关闭多模态后 AI 复核仍可基于程序结果运行，但主识别不得调用模型');
});

async function runVisionReview({ enabled, failVision = false, preRecognized = false }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-review-vision-'));
  const sourcePath = path.join(directory, 'source.docx');
  const zip = new AdmZip();
  zip.addFile('word/media/shared.png', Buffer.from('PNG-REAL-BYTES'));
  zip.addFile('word/media/other.jpg', Buffer.from('JPEG-REAL-BYTES'));
  zip.addFile('word/media/vector.emf', Buffer.from('EMF-REAL-BYTES'));
  zip.writeZip(sourcePath);
  const dump = {
    text: '[p1] 技术方案正文',
    images: [
      { id: 'img1', part: 'word/media/shared.png', name: '图片1', description: '', title: '' },
      { id: 'img2', part: 'word/media/shared.png', name: '共享图片重复引用', description: '', title: '' },
      { id: 'img3', part: 'word/media/other.jpg', name: '图片3', description: '', title: '' },
      { id: 'img4', part: 'word/media/vector.emf', name: '矢量图', description: '', title: '' },
      { id: 'img5', part: '', name: '文本框', description: '', title: '' },
    ],
  };
  const fakeType = new Proxy({}, { get: () => (..._args) => ({}) });
  const modelCalls = [];
  const aiService = {
    getConfig: () => ({ multimodal_enabled: enabled }),
    async chat(payload) {
      const content = payload.messages.find((message) => message.role === 'user').content;
      const localImage = content.find((item) => item.type === 'local_image');
      modelCalls.push({ ...payload, localImagePath: localImage?.path,
        localImageExistedDuringCall: Boolean(localImage?.path && fs.existsSync(localImage.path)),
        localImageBytes: localImage?.path && fs.existsSync(localImage.path) ? fs.readFileSync(localImage.path) : null });
      if (failVision) throw new Error('视觉模型超时');
      return '{"readable":true,"text":"施工流程图","identifiers":[],"reason":"画面清晰，未发现身份信息"}';
    },
  };
  let persistentState;
  let blockedBeforeInspect;
  const candidate = JSON.stringify({ summary: '图片复核完成', clauses: [], candidates: [], issues: [] });
  const agentService = {
    async runTask(options) {
      blockedBeforeInspect = options.validateOutput({ output_content: candidate });
      const tools = options.create_tools({ Type: fakeType, workspaceDir: directory });
      if (enabled && !preRecognized) {
        const inspect = tools.find((tool) => tool.name === 'inspect-image');
        for (const image of ['img1', 'img3']) {
          const result = await inspect.execute(`inspect-${image}`, { image, question: '检查匿名信息' });
          if (failVision) assert.deepEqual([result.details.status, result.details.part], ['unknown', image === 'img1' ? 'word/media/shared.png' : 'word/media/other.jpg']);
        }
      }
      const checked = options.validateOutput({ output_content: candidate });
      assert.deepEqual(checked.issues, []);
      return { validation_result: checked.value };
    },
    updatePersistentTask(_key, patch) { persistentState = { ...(persistentState || {}), ...patch }; },
  };
  const { runBlindCheckReviewAgent } = loadFresh(agentPath, {
    './agent/agentToolEnvironment.cjs': { NATIVE_AGENT_TOOLS: [] },
  });
  const result = await runBlindCheckReviewAgent({
    agentService,
    aiService,
    openXmlHelperService: { runBlindCheckDump: async () => dump },
    input: {
      source: 'source.docx', sourcePath, signature: 'sig-vision', presetName: '暗标', profile: { image: { check_text: true }, privacy: {} },
      sensitiveWords: [], presetSource: { fields: {}, manual: [], unspecified: [] },
    },
    groups: [],
    imageTextFacts: [coveredFact({ part: 'word/media/shared.png' }), coveredFact({ part: 'word/media/other.jpg' })]
      .map((fact) => preRecognized ? { ...fact, primarySource: 'multimodal', modelText: fact.text, vision: { status: 'reviewed' } } : fact),
    tender: null,
    taskId: 'review-vision',
    signal: new AbortController().signal,
    onActivity: () => {},
  });
  return { directory, sourcePath, dump, result, modelCalls, persistentState, blockedBeforeInspect };
}

test('复核 Agent：开启多模态后每个可读媒体 part 必须 inspect-image，传真实 local_image；缺图阻塞提交', async (t) => {
  const state = await runVisionReview({ enabled: true });
  t.after(() => fs.rmSync(state.directory, { recursive: true, force: true }));
  assert.equal(state.blockedBeforeInspect.value, null);
  assert.match(state.blockedBeforeInspect.issues[0].message, /还有 2 张图片未调用 inspect-image/);
  assert.equal(state.modelCalls.length, 2, '共享媒体两处引用只需按 part 看一次，EMF 和文本框不调用模型');
  const expected = new Map([['.png', 'PNG-REAL-BYTES'], ['.jpg', 'JPEG-REAL-BYTES']]);
  for (const call of state.modelCalls) {
    const content = call.messages.find((message) => message.role === 'user').content;
    const localImage = content.find((item) => item.type === 'local_image');
    assert.equal(call.localImageExistedDuringCall, true, 'modelimage 在模型调用时必须是实际解出的本地图片');
    assert.equal(call.localImageBytes.toString('utf8'), expected.get(path.extname(localImage.path)));
    assert.equal(fs.existsSync(call.localImagePath), false, '模型调用结束后应清理临时图片');
    assert.equal(localImage.detail, 'high', '暗标图片主识别必须用 high 细节读图');
    assert.match(content.find((item) => item.type === 'text').text, /逐字抄录.*人名.*单位.*徽标/);
  }
  assert.deepEqual(state.persistentState.image_vision, { 'word/media/shared.png': 'reviewed', 'word/media/other.jpg': 'reviewed' });
  assert.ok(state.result.review);
});

test('复核 Agent：关闭多模态不调用视觉模型；模型异常记录 unknown，不伪造成 reviewed', async (t) => {
  const disabled = await runVisionReview({ enabled: false });
  t.after(() => fs.rmSync(disabled.directory, { recursive: true, force: true }));
  assert.equal(disabled.blockedBeforeInspect.value.summary, '图片复核完成', '关闭开关时不要求调用 inspect-image');
  assert.equal(disabled.modelCalls.length, 0);
  assert.deepEqual(disabled.persistentState.image_vision, {});

  const failed = await runVisionReview({ enabled: true, failVision: true });
  t.after(() => fs.rmSync(failed.directory, { recursive: true, force: true }));
  assert.equal(failed.modelCalls.length, 2);
  assert.deepEqual(failed.persistentState.image_vision, { 'word/media/shared.png': 'unknown', 'word/media/other.jpg': 'unknown' });
});

test('复核 Agent：模型主识别已覆盖的媒体复用 reviewed 证据，不再逐图重复调用', async (t) => {
  const state = await runVisionReview({ enabled: true, preRecognized: true });
  t.after(() => fs.rmSync(state.directory, { recursive: true, force: true }));
  assert.equal(state.blockedBeforeInspect.value.summary, '图片复核完成', '主识别已覆盖全部可读媒体时不应阻塞提交');
  assert.equal(state.modelCalls.length, 0, '已识别图片不得再次调用 inspect-image');
  assert.deepEqual(state.persistentState.image_vision, {
    'word/media/shared.png': 'reviewed',
    'word/media/other.jpg': 'reviewed',
  });
});

function sha(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function runFixScenario(finalOcr, { ai = false, multimodal = false, vision = 'absent' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-image-workflow-'));
  const sourcePath = path.join(directory, 'source.docx');
  const outputPath = path.join(directory, 'fixed.docx');
  const sourceBytes = Buffer.from('ORIGINAL-DOCX-BYTES');
  fs.writeFileSync(sourcePath, sourceBytes);
  const originalHash = 'ocr-original-hash';
  const afterHash = 'ocr-after-hash';
  const initialFact = coveredFact({ hash: originalHash });
  const finalFact = finalOcr === 'unknown'
    ? { ...coveredFact({ hash: afterHash, text: '' }), status: 'unknown', text: '', regions: [], reason: 'empty_result' }
    : coveredFact({ hash: afterHash, text: finalOcr === 'still' ? '项目负责人：张三' : '技术方案说明' });
  let collectCalls = 0;
  const modelCollectCalls = [];
  let helperFixPayload;
  let redactRequests;
  const visionCalls = [];
  const imageModule = {
    ...realImageText,
    async collectImageTextFacts() {
      collectCalls += 1;
      // 模型优先时初次主识别不调用 local，第一次 local 已是最终像素复检；
      // 仅程序路径仍先读原图、修复后再读最终图。
      return !multimodal && collectCalls === 1 ? [initialFact] : [finalFact];
    },
    async collectModelImageTextFacts(docxPath, options) {
      modelCollectCalls.push({ docxPath, options });
      const fact = modelCollectCalls.length === 1 ? initialFact : finalFact;
      return [{ ...fact, primarySource: 'multimodal', modelText: fact.text, identifiers: [], vision: { status: 'reviewed' } }];
    },
    async redactImageTextInCopy(docxPath, requests) {
      redactRequests = requests;
      assert.equal(docxPath, outputPath);
      fs.writeFileSync(docxPath, Buffer.from('REDACTED-DOCX-BYTES'));
      return {
        images: [{ part: initialFact.part, beforeHash: originalHash, afterHash, status: 'fixed', requests, redacted: [{ x: 1, y: 1, width: 5, height: 5 }] }],
        facts: [finalFact],
      };
    },
    async verifyRedactionsWithVision(docxPath, records, options) {
      visionCalls.push({ docxPath, records, options });
      return records.map((record) => vision === 'absent' ? { ...record, vision: 'absent' } : {
        ...record,
        vision,
        status: vision === 'present' ? 'pending' : 'unknown',
        reason: vision === 'present' ? '多模态复检仍发现目标文字，不能判定已修复' : '多模态复检无法确认画面，须人工核验',
      });
    },
  };
  const { runBlindCheckFixTask } = loadFresh(fixTaskPath, {
    './blindCheckImageText.cjs': imageModule,
    './blindCheckAgent.cjs': { agentActivityText: () => '', canResumeReviewAgent: () => false, runBlindCheckFixAgent: async () => { throw new Error('仅程序修复不应调用 Agent'); } },
    './blindCheckTask.cjs': { mapReport },
  });
  const imageGroup = {
    id: 'g0', ruleId: 'image.text_sensitive', ruleTitle: '图片画面存在敏感文字', category: 'image', severity: 'high',
    candidate: false, message: '图片画面存在敏感文字', count: 1,
    items: [{ locator: 'img1', where: '正文图片', text: '张三', expectedText: '张三', part: initialFact.part, sourceHash: originalHash, detail: '命中姓名' }],
    samples: [{ where: '正文图片', text: '张三', detail: '命中姓名', hint: '遮盖' }],
  };
  const input = {
    source: 'source.docx', sourcePath, output: 'fixed.docx', outputPath, signature: 'sig-fix', fileName: '测试.docx',
    sensitiveWords: ['张三'], fixRules: ['image.text_sensitive', 'text.spaces'],
    profile: { image: { check_color: false, check_text: true }, privacy: { enable_builtin: true, keywords: [] } },
  };
  const checkpoints = [];
  await runBlindCheckFixTask({
    agentService: {}, aiService: { getConfig: () => ({ multimodal_enabled: multimodal }) }, payload: { ai }, taskControl: { signal: new AbortController().signal },
    pageMeasure: async () => ({ pages: 3, source: 'microsoft-word' }),
    workspaceStore: {
      prepareFixInput: () => input,
      loadBlindCheck: () => ({ result: { status: 'success', inputSignature: input.signature, groups: [imageGroup] }, review: { status: 'skipped' } }),
      setFixAiEnabled: () => {},
      removeStaleFixedFiles: () => {},
    },
    openXmlHelperService: {
      async runBlindCheckFix(payload) {
        helperFixPayload = payload;
        fs.copyFileSync(sourcePath, outputPath);
        return {
          source_bytes: fs.statSync(sourcePath).size, output_bytes: fs.statSync(outputPath).size,
          fixes: { 'text.spaces': 0 }, notes: [], heading_fallback: true,
          validation: { checked: true, original_errors: 0, fixed_errors: 0 }, after: rawEmptyReport(),
        };
      },
    },
    updateTask: () => {},
    checkpointTask(task, state = {}) {
      checkpoints.push({ task, state });
      return { task: { task_id: 'task-fix' } };
    },
  });
  const result = checkpoints.find((item) => item.state.fixResult?.status === 'success')?.state.fixResult;
  return { directory, sourcePath, outputPath, sourceBytes, input, result, helperFixPayload, redactRequests, visionCalls, modelCollectCalls };
}

test('修复 Task：image.text_sensitive 不传 C#，原件不变，最终 OCR/hash 证据使逐项对账成功', async (t) => {
  const state = await runFixScenario('clean');
  t.after(() => fs.rmSync(state.directory, { recursive: true, force: true }));
  assert.deepEqual(state.helperFixPayload.fix_rules, ['text.spaces']);
  assert.deepEqual(state.redactRequests, [{
    part: 'word/media/shared.png', expectedText: '张三', originalHash: 'ocr-original-hash',
    sourceHash: 'ocr-original-hash', issue: 'g0',
  }]);
  assert.deepEqual(fs.readFileSync(state.sourcePath), state.sourceBytes, '原文档字节不得变化');
  assert.notDeepEqual(fs.readFileSync(state.outputPath), state.sourceBytes, '只修改修复副本');
  assert.deepEqual([state.result.items[0].fixed, state.result.items[0].pending], [1, 0]);
  assert.equal(state.result.fixes['image.text_sensitive'], 1);
  assert.deepEqual(state.result.afterSummary, { high: 0, medium: 0, low: 0, total: 0 });
});

for (const finalOcr of ['unknown', 'still']) {
  test(`修复 Task：最终 OCR ${finalOcr === 'unknown' ? '未知' : '仍命中'}时不得把初次遮盖记录伪报成功`, async (t) => {
    const state = await runFixScenario(finalOcr);
    t.after(() => fs.rmSync(state.directory, { recursive: true, force: true }));
    assert.deepEqual(fs.readFileSync(state.sourcePath), state.sourceBytes);
    const originalItem = state.result.items.find((item) => item.id === 'g0');
    assert.deepEqual([originalItem.fixed, originalItem.pending], [0, 1]);
    assert.equal(state.result.fixes['image.text_sensitive'], 0, '最终复检失败后修复计数也必须回退');
  });
}

test('修复 Task：只有 ai+多模态开关同时开启才做最终视觉复核，并以 absent/present/unknown 决定入账', async (t) => {
  const disabled = await runFixScenario('clean', { ai: true, multimodal: false });
  t.after(() => fs.rmSync(disabled.directory, { recursive: true, force: true }));
  assert.equal(disabled.visionCalls.length, 0);
  assert.deepEqual([disabled.result.items[0].fixed, disabled.result.fixes['image.text_sensitive']], [1, 1], '关闭开关时沿用 OCR/hash 证据，不调用视觉模型');

  const absent = await runFixScenario('clean', { ai: true, multimodal: true, vision: 'absent' });
  t.after(() => fs.rmSync(absent.directory, { recursive: true, force: true }));
  assert.equal(absent.visionCalls.length, 1);
  assert.ok(absent.modelCollectCalls.length >= 2, '多模态 AI 修复必须对实际副本做主识别和最终主识别');
  assert.ok(absent.modelCollectCalls.every((call) => call.docxPath === absent.outputPath));
  assert.equal(absent.visionCalls[0].docxPath, absent.outputPath);
  assert.deepEqual([absent.result.items[0].fixed, absent.result.items[0].pending, absent.result.fixes['image.text_sensitive']], [1, 0, 1]);

  for (const vision of ['present', 'unknown']) {
    const state = await runFixScenario('clean', { ai: true, multimodal: true, vision });
    t.after(() => fs.rmSync(state.directory, { recursive: true, force: true }));
    assert.equal(state.visionCalls.length, 1);
    assert.deepEqual([state.result.items[0].fixed, state.result.items[0].pending, state.result.fixes['image.text_sensitive']], [0, 1, 0]);
    assert.match(state.result.items[0].reason, vision === 'present' ? /仍发现目标文字/ : /无法确认画面/);
    assert.match(state.result.items[0].suggestion, /人工查看.*word\/media\/shared\.png/);
  }
});

test('修复 Agent：只允许遮盖该 issue 已核实的 content 摘录，并把像素证据带回 Task', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-agent-image-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const outputPath = path.join(directory, 'fixed.docx');
  fs.writeFileSync(outputPath, 'copy');
  const redaction = {
    part: 'word/media/shared.png', beforeHash: 'before', afterHash: 'after', status: 'fixed',
    requests: [{ part: 'word/media/shared.png', expectedText: '张伟', issue: 'a1' }], redacted: [{ x: 1, y: 1, width: 5, height: 5 }],
  };
  let redactionCalls = 0;
  const finalFacts = [coveredFact({ hash: 'after', text: '技术方案说明' })];
  const imageModule = {
    ...realImageText,
    collectImageTextFacts: async () => finalFacts,
    async redactImageTextInCopy(docxPath, requests) {
      redactionCalls += 1;
      assert.equal(docxPath, outputPath);
      assert.deepEqual(requests, [{ part: redaction.part, expectedText: '张伟', issue: 'a1' }]);
      return { images: [redaction], facts: finalFacts };
    },
  };
  const { runBlindCheckFixAgent } = loadFresh(agentPath, {
    './blindCheckImageText.cjs': imageModule,
    './agent/agentToolEnvironment.cjs': { NATIVE_AGENT_TOOLS: [] },
  });
  const review = {
    verdicts: {}, clauses: [],
    issues: [{
      id: 'a1', title: '图片泄露姓名', severity: 'high', category: 'image', basis: '不得出现人员姓名', detail: '图片有姓名', suggestion: '遮盖',
      locations: [{ target: 'img1', text: '张伟', image_part: 'content' }],
    }],
  };
  const fakeType = new Proxy({}, { get: () => (..._args) => ({}) });
  let activeTools;
  const agentService = {
    loadPersistentTask: () => ({ state: { review_images: [{ id: 'img1', part: redaction.part }] }, paths: { workspaceDir: directory } }),
    updatePersistentTask: () => {},
    async runTask(options) {
      activeTools = options.active_tools;
      const tools = options.create_tools({ Type: fakeType, workspaceDir: directory });
      const redact = tools.find((tool) => tool.name === 'redact-image-text');
      await assert.rejects(() => redact.execute('bad', { issue: 'a1', image: 'img1', text: '张' }), /只能遮盖该问题已确认/);
      await redact.execute('ok', { issue: 'a1', image: 'img1', text: '张伟' });
      const disposition = { summary: '已处理', items: [{ id: 'a1', action: 'fixed', reason: '', suggestion: '' }], clauses: [] };
      const checked = await options.validateOutput({ output_content: JSON.stringify(disposition) });
      assert.deepEqual(checked.issues, []);
      return { validation_result: checked.value };
    },
  };
  const result = await runBlindCheckFixAgent({
    agentService,
    aiService: {},
    openXmlHelperService: { runBlindCheck: async () => ({ groups: [], stats: {}, summary: { high: 0, medium: 0, low: 0, total: 0 } }) },
    input: {
      source: 'source.docx', output: 'fixed.docx', outputPath, signature: 'sig', fixRules: [], sensitiveWords: ['张伟'],
      profile: { image: { check_text: true }, privacy: { enable_builtin: true, keywords: [] } },
    },
    checkGroups: [],
    review,
    afterGroups: [],
    fixedDump: { text: '[p1] 正文', images: [{ id: 'img1', part: redaction.part }] },
    fixedSource: 'fixed.docx',
    imageFacts: [],
    imageTextFacts: [coveredFact({ text: '项目负责人：张伟' })],
    mapReport: (value) => value,
    fixableRules: new Set(),
    taskId: 'agent-fix',
    signal: new AbortController().signal,
    onActivity: () => {},
  });
  assert.ok(activeTools.includes('redact-image-text'));
  assert.equal(redactionCalls, 1);
  assert.deepEqual(result.imageRedactions, [redaction]);
  assert.deepEqual(result.edits, [{ issue: 'a1', op: 'redact_image_text', target: 'img1', before: '张伟', after: '', verified: true }]);
});
