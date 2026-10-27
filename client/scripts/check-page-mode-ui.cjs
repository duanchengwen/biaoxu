// 隔离的 Electron DOM 回归：真实 dist + preload，验证页数/字数双模式互斥展示与保存恢复。
// 只使用临时 userData 和本地 IPC stub，不访问用户配置或外网。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const root = path.resolve(__dirname, '..');
const { createConfigStore } = require(path.join(root, 'electron', 'services', 'configStore.cjs'));
const { registerConfigIpc } = require(path.join(root, 'electron', 'ipc', 'configIpc.cjs'));
const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), '投标宝-篇幅双模式-'));
let windowUnderTest = null;
let pageOptimizationRequest = null;

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

const initialWordControl = {
  mode: 'pages',
  targetPages: 100,
  minimumPages: 90,
  maximumPages: 110,
  minimumWords: 12_000,
  maximumWords: 18_000,
  sectionWords: 2_600,
};

const technicalPlanState = {
  step: 'generation-settings',
  tenderFile: {
    fileName: 'QA-篇幅双模式.docx', markdownPath: 'D:\\isolated-test\\page-mode.md', markdownChars: 1280,
    contentHash: 'qa-page-mode', updatedAt: new Date(0).toISOString(),
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
  outlineWordControlOptions: { ...initialWordControl },
  outlineWordControlSnapshot: undefined,
  referenceKnowledgeDocumentIds: [],
  globalFactsMode: 'fabricate',
  globalFacts: [],
  exportTemplateId: '',
  exportTemplateScope: 'ai-only',
  contentGenerationSections: {},
  contentGenerationPlans: {},
  contentGenerationRuntime: undefined,
  outlineData: null,
};

function installHarnessIpc() {
  const configStore = createConfigStore(app);
  const config = configStore.load();
  configStore.save({
    ...config,
    text_model_provider: 'custom',
    api_key: 'qa-isolated-key',
    model_name: 'qa-model',
    base_url: 'https://qa.invalid/v1',
    text_model_profiles: {
      ...config.text_model_profiles,
      custom: {
        ...config.text_model_profiles.custom,
        api_key: 'qa-isolated-key',
        model_name: 'qa-model',
        base_url: 'https://qa.invalid/v1',
      },
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
  handle('app:get-version', () => '0.2.0-page-mode-test');
  handle('license:get-status', () => ({ status: 'valid', sourceTrusted: true, plan: 'test', config: {} }));
  handle('agent:get-status', () => ({ status: 'idle' }));
  handle('agent:get-pending-question', () => null);
  handle('auto-confirmation:get-state', () => ({ enabled: false }));
  handle('auto-confirmation:set-enabled', (_event, enabled) => ({ enabled: Boolean(enabled) }));
  handle('tasks:get-active', () => []);
  handle('templates:list', () => []);
  handle('templates:get', (_event, templateId) => templateId === 'qa-template' ? { template_id: templateId, name: 'QA 模板' } : null);
  handle('tasks:start-content-generation', (_event, payload) => {
    pageOptimizationRequest = structuredClone(payload);
    return { task_id: 'qa-page-optimize', status: 'running' };
  });
  handle('technical-plan:load-state', () => structuredClone(technicalPlanState));
  handle('technical-plan:update-step', (_event, step) => {
    technicalPlanState.step = step;
    return { success: true };
  });
  handle('technical-plan:save-generation-config', (_event, partial) => {
    if (partial?.outlineWordControlOptions) {
      technicalPlanState.outlineWordControlOptions = {
        ...technicalPlanState.outlineWordControlOptions,
        ...partial.outlineWordControlOptions,
      };
    }
    Object.assign(technicalPlanState, partial || {});
    return structuredClone(technicalPlanState);
  });
}

async function openLengthTab(webContents) {
  await waitFor(webContents, `document.querySelector('.project-home-page') || document.querySelector('.generation-settings-page')`, '项目首页或生成设置页没有恢复');
  if (await webContents.executeJavaScript(`Boolean(document.querySelector('.project-home-page'))`)) {
    await waitFor(webContents, `[...document.querySelectorAll('button')].some((button) => button.textContent.includes('继续技术标编制'))`, '项目首页没有继续编制入口');
    await webContents.executeJavaScript(`[...document.querySelectorAll('button')].find((button) => button.textContent.includes('继续技术标编制')).click()`);
  }
  await waitFor(webContents, `[...document.querySelectorAll('button[role="tab"]')].some((button) => button.textContent.includes('目标篇幅'))`, '生成设置没有“目标篇幅”标签');
  await webContents.executeJavaScript(`[...document.querySelectorAll('button[role="tab"]')].find((button) => button.textContent.includes('目标篇幅')).click()`);
  await waitFor(webContents, `document.querySelector('[role="radiogroup"][aria-label="篇幅控制模式"]')`, '篇幅双模式控件未渲染');
}

async function modeState(webContents) {
  return webContents.executeJavaScript(`(() => {
    const labelInput = (text) => {
      const label = [...document.querySelectorAll('label')].find((node) => node.querySelector(':scope > span')?.textContent.trim() === text);
      return label?.querySelector('input')?.value ?? null;
    };
    const radios = [...document.querySelectorAll('[role="radiogroup"][aria-label="篇幅控制模式"] [role="radio"]')];
    return {
      pageChecked: radios.find((node) => node.textContent.includes('按页数'))?.getAttribute('aria-checked'),
      wordChecked: radios.find((node) => node.textContent.includes('按字数'))?.getAttribute('aria-checked'),
      targetPages: labelInput('目标页数'),
      minimumPages: labelInput('最少页数'),
      maximumPages: labelInput('最多页数'),
      minimumWords: labelInput('最少字数（万）'),
      maximumWords: labelInput('最多字数（万）'),
      sectionWords: labelInput('每小节建议字数（万）'),
      body: document.body.innerText,
    };
  })()`);
}

async function chooseMode(webContents, label) {
  await waitFor(webContents, `[...document.querySelectorAll('[role="radiogroup"][aria-label="篇幅控制模式"] [role="radio"]')].some((button) => button.textContent.includes('${label}') && !button.disabled)`, `${label}模式不可选择`);
  await webContents.executeJavaScript(`[...document.querySelectorAll('[role="radiogroup"][aria-label="篇幅控制模式"] [role="radio"]')].find((button) => button.textContent.includes('${label}')).click()`);
  const expected = label === '按页数' ? 'pages' : 'words';
  await waitFor(webContents, `[...document.querySelectorAll('[role="radiogroup"][aria-label="篇幅控制模式"] [role="radio"]')].find((button) => button.textContent.includes('${label}'))?.getAttribute('aria-checked') === 'true' && ${JSON.stringify(expected)} === ${JSON.stringify(expected)}`, `${label}模式未生效`);
  await delay(80);
}

async function setInput(webContents, label, value) {
  await waitFor(webContents, `[...document.querySelectorAll('label')].some((node) => node.querySelector(':scope > span')?.textContent.trim() === ${JSON.stringify(label)} && !node.querySelector('input')?.disabled)`, `${label}输入框不可用`);
  await webContents.executeJavaScript(`(() => {
    const label = [...document.querySelectorAll('label')].find((node) => node.querySelector(':scope > span')?.textContent.trim() === ${JSON.stringify(label)});
    const input = label.querySelector('input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
  })()`);
  await delay(120);
}

async function run() {
  installHarnessIpc();
  windowUnderTest = new BrowserWindow({
    show: false,
    width: 1360,
    height: 900,
    webPreferences: {
      preload: path.join(root, 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  windowUnderTest.webContents.session.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (_details, callback) => callback({ cancel: true }),
  );
  await windowUnderTest.loadFile(path.join(root, 'dist', 'index.html'));
  const webContents = windowUnderTest.webContents;
  await openLengthTab(webContents);

  let state = await modeState(webContents);
  assert.equal(state.pageChecked, 'true');
  assert.equal(state.wordChecked, 'false');
  assert.deepEqual([state.targetPages, state.minimumPages, state.maximumPages], ['100', '90', '110']);
  assert.deepEqual([state.minimumWords, state.maximumWords, state.sectionWords], [null, null, null], '页数模式不应同时显示字数字段');
  assert.match(state.body, /约\s*65,000\s*字/, '100 页应显示约 65,000 字规划参考');

  await chooseMode(webContents, '按字数');
  state = await modeState(webContents);
  assert.equal(state.wordChecked, 'true');
  assert.deepEqual([state.targetPages, state.minimumPages, state.maximumPages], [null, null, null], '字数模式不应同时显示页数字段');
  assert.deepEqual([state.minimumWords, state.maximumWords, state.sectionWords], ['1.2', '1.8', '0.26']);

  await setInput(webContents, '最少字数（万）', '2.2');
  await setInput(webContents, '最多字数（万）', '3.3');
  await setInput(webContents, '每小节建议字数（万）', '0.44');
  await chooseMode(webContents, '按页数');
  state = await modeState(webContents);
  assert.deepEqual([state.targetPages, state.minimumPages, state.maximumPages], ['100', '90', '110'], '编辑字数不应覆盖页数参数');

  await setInput(webContents, '目标页数', '96');
  await setInput(webContents, '最少页数', '92');
  await setInput(webContents, '最多页数', '108');
  await chooseMode(webContents, '按字数');
  state = await modeState(webContents);
  assert.deepEqual([state.minimumWords, state.maximumWords, state.sectionWords], ['2.2', '3.3', '0.44'], '编辑页数不应覆盖字数参数');

  webContents.reload();
  await openLengthTab(webContents);
  state = await modeState(webContents);
  assert.equal(state.wordChecked, 'true', '重载后应恢复最后保存的字数模式');
  assert.deepEqual([state.minimumWords, state.maximumWords, state.sectionWords], ['2.2', '3.3', '0.44']);
  await chooseMode(webContents, '按页数');
  state = await modeState(webContents);
  assert.deepEqual([state.targetPages, state.minimumPages, state.maximumPages], ['96', '92', '108'], '重载切回页数模式后应恢复独立页数值');

  assert.deepEqual(technicalPlanState.outlineWordControlOptions, {
    mode: 'pages',
    targetPages: 96,
    minimumPages: 92,
    maximumPages: 108,
    minimumWords: 22_000,
    maximumWords: 33_000,
    sectionWords: 4_400,
  });

  // 已有完整成稿的“篇幅优化”只提交临时页数参数，不覆盖生成设置中的两套持久值。
  technicalPlanState.step = 'content-edit';
  technicalPlanState.exportTemplateId = 'qa-template';
  technicalPlanState.outlineWordControlSnapshot = { ...technicalPlanState.outlineWordControlOptions };
  technicalPlanState.outlineData = {
    project_name: 'QA 篇幅优化',
    outline: [{ id: 'section-1', number: '1', title: '施工组织方案', description: '测试章节', content_mode: 'ai-generate' }],
  };
  technicalPlanState.contentGenerationSections = {
    'section-1': { id: 'section-1', title: '施工组织方案', status: 'success', content: '' },
  };
  technicalPlanState.contentGenerationTask = {
    task_id: 'qa-completed-content', type: 'content-generation', status: 'success', progress: 100,
    logs: ['隔离 fixture 已完成'], started_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
    stats: { content: { generation_completed: true } },
  };
  technicalPlanState.contentGenerationRuntime = {
    phase: 'word-completed',
    section_words: { 'section-1': 1260 },
    html_output: { workspace_dir: 'qa-workspace', word_output_dir: 'qa-word', word_sections: [] },
  };
  webContents.reload();
  await waitFor(webContents, `document.querySelector('.project-home-page')`, '重载后项目首页未渲染');
  await webContents.executeJavaScript(`[...document.querySelectorAll('button')].find((button) => button.textContent.includes('继续技术标编制')).click()`);
  await waitFor(webContents, `[...document.querySelectorAll('.content-assistant-panel button')].some((button) => button.textContent.trim() === '标书篇幅优化' && !button.disabled)`, 'HTML runtime 完整但 DB 正文为空时未启用篇幅优化入口');
  await webContents.executeJavaScript(`[...document.querySelectorAll('.content-assistant-panel button')].find((button) => button.textContent.trim() === '标书篇幅优化').click()`);
  await waitFor(webContents, `document.querySelector('[role="dialog"]')?.textContent.includes('标书文件篇幅优化')`, '篇幅优化对话框未打开');
  const optimizeDialogValues = await webContents.executeJavaScript(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const value = (text) => [...dialog.querySelectorAll('label')].find((node) => node.querySelector(':scope > span')?.textContent.trim() === text)?.querySelector('input')?.value;
    return [value('目标页数'), value('最少页数'), value('最多页数')];
  })()`);
  assert.deepEqual(optimizeDialogValues, ['96', '92', '108'], '篇幅优化应从生成快照带入页数参数');
  await setInput(webContents, '目标页数', '88');
  await setInput(webContents, '最少页数', '80');
  await setInput(webContents, '最多页数', '100');
  await webContents.executeJavaScript(`[...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent.trim() === '开始优化').click()`);
  await waitFor(webContents, `!document.querySelector('[role="dialog"]')`, '篇幅优化提交后对话框未关闭');
  assert.deepEqual(pageOptimizationRequest, {
    pageOptimizeOnly: true,
    pageOptimizationOptions: { targetPages: 88, minimumPages: 80, maximumPages: 100 },
  }, '篇幅优化必须提交独立临时参数');
  assert.deepEqual(technicalPlanState.outlineWordControlOptions, {
    mode: 'pages',
    targetPages: 96,
    minimumPages: 92,
    maximumPages: 108,
    minimumWords: 22_000,
    maximumWords: 33_000,
    sectionWords: 4_400,
  }, '临时篇幅优化参数不得覆盖生成设置');

  console.log('check-page-mode-ui: 通过');
  console.log(JSON.stringify({ mutuallyExclusive: true, pageValues: [96, 92, 108], wordValues: [22000, 33000, 4400], reloadRestored: true, pageOptimizeOnly: pageOptimizationRequest }));
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
