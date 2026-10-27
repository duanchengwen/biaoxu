// 隔离 Electron DOM 回归：Token 用量、暗标页数保护、GLM 免费模型选择。
// 仅使用临时 userData 与本地 IPC fixture；不读取真实密钥、不访问外网、不启动用户实例。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const root = path.resolve(__dirname, '..');
const artifactDir = path.join(root, 'qa', 'artifacts', 'cost-final-pages');
const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'bidxu-cost-final-pages-ui-'));
const { createConfigStore } = require(path.join(root, 'electron', 'services', 'configStore.cjs'));
const { registerConfigIpc } = require(path.join(root, 'electron', 'ipc', 'configIpc.cjs'));

let windowUnderTest = null;
let usageMode = 'reported';
let blindState = createBlindState();
const blindFixRequests = [];

app.setPath('userData', tempUserData);
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(webContents, expression, message, timeout = 12_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await webContents.executeJavaScript(`Boolean(${expression})`, true)) return;
    await delay(50);
  }
  throw new Error(message);
}

function handle(channel, callback) {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, callback);
}

function usageSummary({ unknown = false } = {}) {
  const values = unknown
    ? { inputTokens: 0, cachedInputTokens: 0, freshInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 }
    : { inputTokens: 5000, cachedInputTokens: 2000, freshInputTokens: 3000, outputTokens: 1200, reasoningTokens: 200, totalTokens: 6200 };
  return {
    recorded: true,
    taskId: 'qa-content-usage',
    taskType: 'content-generation',
    requestCount: 4,
    successRequestCount: unknown ? 2 : 3,
    failedRequestCount: 1,
    unknownTokenRequestCount: unknown ? 2 : 0,
    ...values,
    stages: [{
      stage: 'generating',
      requestCount: 4,
      successRequestCount: unknown ? 2 : 3,
      failedRequestCount: 1,
      unknownTokenRequestCount: unknown ? 2 : 0,
      ...values,
    }],
    updatedAt: new Date(0).toISOString(),
  };
}

function technicalPlanState() {
  const timestamp = new Date(0).toISOString();
  return {
    step: 'content-edit',
    tenderFile: {
      fileName: 'QA-Token用量.docx', markdownPath: 'D:\\isolated-test\\usage.md', markdownChars: 1200,
      contentHash: 'qa-usage', updatedAt: timestamp,
    },
    tenderFiles: [],
    bidTemplateExists: false,
    originalPlanFile: null,
    projectOverview: '',
    techRequirements: '',
    bidAnalysisMode: 'key',
    bidAnalysisSelectedTaskIds: [],
    bidAnalysisTasks: {},
    bidAnalysisProgress: 0,
    bidSectionMode: 'single',
    bidSections: [],
    bidSectionExtractionStatus: 'idle',
    outlineMode: 'standalone-technical',
    outlineExpansionMode: 'ai-complement',
    outlineWordControlOptions: {
      mode: 'pages', targetPages: 30, minimumPages: 0, maximumPages: 0,
      minimumWords: 12000, maximumWords: 18000, sectionWords: 2600,
    },
    outlineWordControlSnapshot: {
      mode: 'pages', targetPages: 30, minimumPages: 0, maximumPages: 0,
      minimumWords: 12000, maximumWords: 18000, sectionWords: 2600,
    },
    referenceKnowledgeDocumentIds: [],
    globalFactsMode: 'fabricate',
    globalFacts: [],
    exportTemplateId: 'qa-template',
    exportTemplateScope: 'ai-only',
    outlineData: {
      project_name: 'QA Token 用量',
      outline: [{ id: 'section-1', number: '1', title: '施工组织方案', description: '隔离验收章节', content_mode: 'ai-generate' }],
    },
    contentGenerationSections: {
      'section-1': { id: 'section-1', title: '施工组织方案', status: 'success', content: '' },
    },
    contentGenerationPlans: {},
    contentGenerationRuntime: {
      phase: 'word-completed',
      section_words: { 'section-1': 1260 },
      html_output: { workspace_dir: 'qa-workspace', word_output_dir: 'qa-word', word_sections: [] },
    },
    contentGenerationTask: {
      task_id: 'qa-content-usage', type: 'content-generation', status: 'success', progress: 100,
      logs: ['隔离 fixture 已完成'], started_at: timestamp, updated_at: timestamp,
      stats: { content: { generation_completed: true, consistency_status: 'completed' } },
      ...(usageMode === 'reported' ? { modelUsage: usageSummary() } : {}),
    },
  };
}

function createBlindState(pageBudget) {
  const timestamp = new Date(0).toISOString();
  return {
    step: 'fix',
    presetTab: 'page',
    resultTab: 'all',
    file: { id: 'qa-blind', fileName: 'QA-暗标页数.docx', size: 1024, modifiedAt: timestamp, importedAt: timestamp },
    presetId: '',
    useCredentialWords: false,
    aiReviewEnabled: false,
    fixAiEnabled: false,
    result: { status: 'success', inputSignature: 'qa-blind-signature', groups: [] },
    review: { status: 'idle' },
    issues: [],
    fixRules: ['remove-author'],
    fixResult: pageBudget ? {
      status: 'success',
      inputSignature: 'qa-blind-signature',
      outputPath: 'D:\\isolated-test\\fixed.docx',
      groups: [],
      items: [{
        id: 'page-budget', category: 'page', severity: 'medium', message: '最终交付页数未通过实测预算',
        count: 1, fixed: 0, pending: 1, isNew: true, reason: pageBudget.reason, suggestion: '请人工复核篇幅',
        pendingOccurrences: [], edits: [],
      }],
      beforeSummary: { high: 0, medium: 0, low: 0, total: 0 },
      afterSummary: { high: 0, medium: 1, low: 0, total: 1 },
      pageBudget,
    } : { status: 'idle', groups: [] },
  };
}

function installHarnessIpc() {
  const configStore = createConfigStore(app);
  const initial = configStore.load();
  configStore.save({
    ...initial,
    text_model_provider: 'custom',
    api_key: 'qa-fixture-only',
    base_url: 'https://qa.invalid/v1',
    model_name: 'qa-model',
    text_model_profiles: {
      ...initial.text_model_profiles,
      custom: { ...initial.text_model_profiles.custom, api_key: 'qa-fixture-only', base_url: 'https://qa.invalid/v1', model_name: 'qa-model' },
      glm: { ...initial.text_model_profiles.glm, api_key: 'qa-glm-fixture-only' },
    },
  });
  registerConfigIpc({
    configStore,
    aiService: {
      listModels: async () => ({ success: true, models: [] }),
      getModelInfo: async () => ({ success: false, message: '隔离测试不调用模型' }),
    },
  });

  handle('workspace-database:get-status', () => ({ phase: 'ready', ready: true, message: '本地数据库已就绪' }));
  handle('ui:set-current-view', () => ({ success: true }));
  handle('app:get-version', () => '0.2.0-cost-final-pages-test');
  handle('license:get-status', () => ({ status: 'valid', sourceTrusted: true, plan: 'test', config: {} }));
  handle('agent:get-status', () => ({ status: 'idle' }));
  handle('agent:get-pending-question', () => null);
  handle('auto-confirmation:get-state', () => ({ enabled: false }));
  handle('auto-confirmation:set-enabled', (_event, enabled) => ({ enabled: Boolean(enabled) }));
  handle('tasks:get-active', () => []);
  handle('tasks:get-usage', () => {
    if (usageMode === 'error') throw new Error('QA fixture usage read failure');
    if (usageMode === 'historical') return null;
    if (usageMode === 'unknown') return usageSummary({ unknown: true });
    return usageSummary();
  });
  handle('templates:list', () => []);
  handle('templates:get', () => null);
  handle('system-fonts:list', () => ['Microsoft YaHei']);
  handle('technical-plan:load-state', () => structuredClone(technicalPlanState()));
  handle('technical-plan:update-step', () => ({ success: true }));
  handle('technical-plan:read-tender-markdown', () => '# QA 招标文件');

  handle('blind-check:load-state', () => structuredClone(blindState));
  handle('blind-check:list-presets', () => []);
  handle('blind-check:get-credential-words', () => []);
  handle('blind-check:get-input-signature', () => 'qa-blind-signature');
  handle('blind-check:get-tender-sources', () => null);
  handle('blind-check:save-ui-state', () => ({ success: true }));
  handle('tasks:start-blind-check-fix', (_event, payload) => {
    blindFixRequests.push(structuredClone(payload));
    return { task_id: `qa-blind-fix-${blindFixRequests.length}`, status: 'running' };
  });
}

async function setViewport(width, height, scaleFactor = 1) {
  windowUnderTest.setContentSize(Math.round(width / scaleFactor), Math.round(height / scaleFactor));
  windowUnderTest.webContents.setZoomFactor(scaleFactor);
  await delay(100);
}

async function saveScreenshot(webContents, name) {
  fs.mkdirSync(artifactDir, { recursive: true });
  await webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await delay(120);
  if (name.includes('dialog')) {
    webContents.debugger.attach('1.3');
    try {
      const result = await webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.join(artifactDir, name), Buffer.from(result.data, 'base64'));
    } finally {
      webContents.debugger.detach();
    }
    return;
  }
  fs.writeFileSync(path.join(artifactDir, name), (await webContents.capturePage()).toPNG());
}

async function clickTopNav(webContents, label) {
  await waitFor(webContents, `document.querySelector('button[aria-label=${JSON.stringify(label)}]')`, `找不到主导航“${label}”`);
  await webContents.executeJavaScript(`document.querySelector('button[aria-label=${JSON.stringify(label)}]').click()`);
}

async function openContentPage(webContents) {
  await waitFor(webContents, `document.querySelector('.project-home-page')`, '项目首页未渲染');
  await waitFor(webContents, `[...document.querySelectorAll('button')].some((button) => button.textContent.includes('继续技术标编制'))`, '没有继续技术标入口');
  await webContents.executeJavaScript(`[...document.querySelectorAll('button')].find((button) => button.textContent.includes('继续技术标编制')).click()`);
  await waitFor(webContents, `document.querySelector('[aria-label="本次任务 Token 用量"]')`, 'Token 用量卡未渲染');
}

async function reloadContent(webContents, mode) {
  usageMode = mode;
  await windowUnderTest.loadFile(path.join(root, 'dist', 'index.html'));
  await openContentPage(webContents);
  return webContents.executeJavaScript(`document.querySelector('[aria-label="本次任务 Token 用量"]').innerText`);
}

async function setInput(webContents, label, value) {
  await webContents.executeJavaScript(`(() => {
    const root = document.querySelector('[role="dialog"]');
    const input = [...root.querySelectorAll('label')].find((node) => node.querySelector(':scope > span')?.textContent.trim() === ${JSON.stringify(label)})?.querySelector('input');
    if (!input) throw new Error('找不到输入框：${label}');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await delay(60);
}

async function openBlindFixDialog(webContents) {
  await clickTopNav(webContents, '标书检查');
  await waitFor(webContents, `[...document.querySelectorAll('.secondary-menu-row')].some((button) => button.textContent.includes('暗标合规检查'))`, '没有暗标合规入口');
  await webContents.executeJavaScript(`[...document.querySelectorAll('.secondary-menu-row')].find((button) => button.textContent.includes('暗标合规检查')).click()`);
  await waitFor(webContents, `document.querySelector('.blind-check-page')`, '暗标页面未渲染');
  try {
    await waitFor(webContents, `[...document.querySelectorAll('button')].some((button) => (button.textContent.includes('开始修复') || button.textContent.includes('重新修复')) && !button.disabled)`, '开始修复不可用');
  } catch (error) {
    const diagnostic = await webContents.executeJavaScript(`({
      body: document.querySelector('.blind-check-page')?.innerText,
      buttons: [...document.querySelectorAll('.blind-check-page button')].map((button) => ({ text: button.textContent.trim(), disabled: button.disabled, title: button.title }))
    })()`);
    throw new Error(`${error.message}\n${JSON.stringify(diagnostic, null, 2)}`);
  }
  await webContents.executeJavaScript(`[...document.querySelectorAll('.blind-check-page button')].find((button) => (button.textContent.includes('开始修复') || button.textContent.includes('重新修复')) && !button.disabled).click()`);
  await waitFor(webContents, `document.querySelector('.blind-check-fix-page-guard')`, '页数保护未渲染');
}

async function chooseProgramFix(webContents) {
  await webContents.executeJavaScript(`[...document.querySelectorAll('[aria-label="修复方式"] button')].find((button) => button.textContent.includes('仅程序修复')).click()`);
  await delay(100);
}

async function run() {
  installHarnessIpc();
  windowUnderTest = new BrowserWindow({
    show: false,
    width: 1424,
    height: 880,
    webPreferences: {
      preload: path.join(root, 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  windowUnderTest.webContents.session.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (_details, callback) => callback({ cancel: true }),
  );
  await windowUnderTest.loadFile(path.join(root, 'dist', 'index.html'));
  const webContents = windowUnderTest.webContents;

  await openContentPage(webContents);
  let text = await webContents.executeJavaScript(`document.querySelector('[aria-label="本次任务 Token 用量"]').innerText`);
  assert.match(text, /输入 Token\s*5,000/);
  assert.match(text, /输出 Token\s*1,200/);
  assert.match(text, /缓存输入\s*2,000/);
  assert.match(text, /4 次请求/);
  assert.match(text, /已报告合计 6,200 Token/);
  await webContents.executeJavaScript(`document.querySelector('.content-task-usage-stages').open = true`);
  await waitFor(webContents, `document.querySelector('[aria-label="本次任务 Token 用量"]').innerText.includes('正文生成')`, '阶段用量没有展开');
  await saveScreenshot(webContents, 'usage-reported-1424x880.png');

  text = await reloadContent(webContents, 'unknown');
  assert.match(text, /未报告/);
  assert.match(text, /不代表未报告请求免费/);
  await saveScreenshot(webContents, 'usage-unknown-1424x880.png');

  text = await reloadContent(webContents, 'historical');
  assert.match(text, /历史版本未保存的数据无法补算/);
  assert.match(text, /不代表本次调用免费/);
  await saveScreenshot(webContents, 'usage-historical-1424x880.png');

  text = await reloadContent(webContents, 'error');
  assert.match(text, /暂时无法读取/);
  assert.match(text, /重新读取/);
  await saveScreenshot(webContents, 'usage-error-1424x880.png');

  await setViewport(1280, 800, 1);
  await openBlindFixDialog(webContents);
  let guardText = await webContents.executeJavaScript(`document.querySelector('.blind-check-fix-page-guard').innerText`);
  assert.match(guardText, /默认保护：不超过原文件实测页数/);
  assert.match(guardText, /不套用其他技术标项目/);
  await chooseProgramFix(webContents);
  assert.deepEqual(blindFixRequests.at(-1), { ai: false }, '页数全空时必须省略 pageBudget');

  await openBlindFixDialog(webContents);
  await webContents.executeJavaScript(`document.querySelector('.blind-check-fix-page-guard details').open = true`);
  await setInput(webContents, '最少页数', '20');
  await setInput(webContents, '最多页数', '10');
  const invalidCount = blindFixRequests.length;
  await chooseProgramFix(webContents);
  assert.equal(blindFixRequests.length, invalidCount, '无效页数不应启动任务');
  await waitFor(webContents, `document.querySelector('[role="dialog"]') && document.body.innerText.includes('最少页数不能大于最多页数')`, '无效范围没有明确提示');
  await setInput(webContents, '目标页数', '12');
  await setInput(webContents, '最少页数', '10');
  await setInput(webContents, '最多页数', '15');
  const dialogVisual = await webContents.executeJavaScript(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const rect = dialog?.getBoundingClientRect();
    const style = dialog ? getComputedStyle(dialog) : null;
    return dialog ? { text: dialog.innerText, width: rect.width, height: rect.height, display: style.display, visibility: style.visibility, opacity: style.opacity } : null;
  })()`);
  assert.ok(dialogVisual && dialogVisual.width > 0 && dialogVisual.height > 0 && dialogVisual.display !== 'none' && dialogVisual.visibility !== 'hidden', '页数设置对话框视觉上不可见');
  assert.match(dialogVisual.text, /目标页数\s*最少页数\s*最多页数/);
  await saveScreenshot(webContents, 'blind-page-budget-dialog-1280x800.png');
  await chooseProgramFix(webContents);
  assert.deepEqual(blindFixRequests.at(-1), {
    ai: false,
    pageBudget: { mode: 'pages', targetPages: 12, minimumPages: 10, maximumPages: 15 },
  });

  blindState = createBlindState({
    origin: 'source',
    requirement: '修复后不得超过原文件 10 页',
    constraint: { enabled: true, kind: 'range', targetPages: 10, minimumPages: 0, maximumPages: 10, planningPages: 10 },
    source: { pages: 10, source: 'word', warning: '', error: '' },
    final: { pages: 12, source: 'word', warning: '', error: '' },
    accepted: false,
    reason: '修复后 12 页，超过原文件实测上限 10 页。',
  });
  await windowUnderTest.loadFile(path.join(root, 'dist', 'index.html'));
  await openBlindFixDialog(webContents);
  await webContents.executeJavaScript(`[...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent.trim() === '取消').click()`);
  await waitFor(webContents, `document.querySelector('[aria-label="修复后页数验收"]')`, '超页验收结果未显示');
  const budgetResult = await webContents.executeJavaScript(`document.querySelector('[aria-label="修复后页数验收"]').innerText`);
  assert.match(budgetResult, /页数需要人工处理/);
  assert.match(budgetResult, /原文件\s*10 页/);
  assert.match(budgetResult, /修复后\s*12 页/);
  assert.match(budgetResult, /超过原文件实测上限 10 页/);
  await saveScreenshot(webContents, 'blind-page-budget-warning-1280x800.png');

  await clickTopNav(webContents, '设置');
  await waitFor(webContents, `document.querySelector('.settings-page')`, '设置页未渲染');
  await webContents.executeJavaScript(`[...document.querySelectorAll('button[role="tab"]')].find((button) => button.textContent.trim() === '文本模型').click()`);
  await waitFor(webContents, `[...document.querySelectorAll('.settings-row')].some((row) => row.textContent.includes('服务提供商'))`, '文本模型设置未渲染');
  const providerOptions = await webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.settings-row')].find((node) => node.textContent.includes('服务提供商'));
    return [...row.querySelector('select').options].map((option) => ({ value: option.value, text: option.textContent }));
  })()`);
  assert.ok(providerOptions.some((option) => option.value === 'glm' && option.text.includes('免费测试')));
  assert.ok(providerOptions.some((option) => option.value === 'custom'), '自定义付费接口必须保留');
  assert.ok(providerOptions.some((option) => option.value === 'deepseek'), '第三方付费服务配置必须保留');
  assert.ok(!providerOptions.some((option) => option.value === 'official'), '官方收费入口不应恢复');
  await webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.settings-row')].find((node) => node.textContent.includes('服务提供商'));
    const select = row.querySelector('select');
    select.value = 'glm';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(webContents, `[...document.querySelectorAll('.settings-row')].some((row) => row.textContent.includes('模型名称') && row.textContent.includes('GLM-4.7-Flash'))`, 'GLM 免费型号没有显示');
  let glmState = await webContents.executeJavaScript(`(() => {
    const row = (label) => [...document.querySelectorAll('.settings-row')].find((node) => node.querySelector('strong')?.textContent.trim() === label);
    const model = row('模型名称').querySelector('select');
    return {
      options: [...model.options].map((option) => ({ value: option.value, text: option.textContent })),
      value: model.value,
      context: row('上下文长度限制').querySelector('input').value,
      output: row('输出token上限').querySelector('input').value,
      multimodalDisabled: document.querySelector('[aria-label="当前文本模型支持读图"]').disabled,
      body: document.querySelector('.settings-page').innerText,
    };
  })()`);
  assert.deepEqual(glmState.options.map((option) => option.value), ['glm-4.7-flash', 'glm-4-flash-250414']);
  assert.ok(glmState.options.every((option) => option.text.includes('免费')));
  assert.equal(glmState.value, 'glm-4.7-flash');
  assert.equal(glmState.context, '200000');
  assert.equal(glmState.output, '128000');
  assert.equal(glmState.multimodalDisabled, true);
  assert.match(glmState.body, /不能用它们验收图片中的暗标问题/);
  await webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.settings-row')].find((node) => node.querySelector('strong')?.textContent.trim() === '模型名称');
    const select = row.querySelector('select');
    select.value = 'glm-4-flash-250414';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(webContents, `[...document.querySelectorAll('.settings-row')].find((node) => node.querySelector('strong')?.textContent.trim() === '上下文长度限制')?.querySelector('input')?.value === '128000'`, '切换轻量型号后上限未收敛');
  glmState = await webContents.executeJavaScript(`(() => {
    const row = (label) => [...document.querySelectorAll('.settings-row')].find((node) => node.querySelector('strong')?.textContent.trim() === label);
    return { context: row('上下文长度限制').querySelector('input').value, output: row('输出token上限').querySelector('input').value };
  })()`);
  assert.deepEqual(glmState, { context: '128000', output: '16000' });
  await setViewport(1424, 880, 1);
  await saveScreenshot(webContents, 'glm-free-models-1424x880.png');

  console.log('check-cost-final-pages-ui: 通过');
  console.log(JSON.stringify({
    usage: ['reported', 'unknown', 'historical', 'error'],
    blindFixRequests,
    blindPageBudgetWarning: budgetResult,
    glmProviderOptions: providerOptions.map((option) => option.value),
    glmLegacyLimits: glmState,
    artifacts: artifactDir,
  }, null, 2));
}

app.whenReady()
  .then(run)
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error?.stack || error);
    app.exit(1);
  });

app.on('before-quit', () => {
  try { windowUnderTest?.destroy(); } catch {}
  try { fs.rmSync(tempUserData, { recursive: true, force: true }); } catch {}
});
