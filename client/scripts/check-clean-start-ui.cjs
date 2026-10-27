// 隔离的 Electron DOM 回归：真实 dist + preload，只写临时 userData，不打开可见窗口，也不访问外网。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const sourceRoot = path.resolve(__dirname, '..');
// 可指向最终交付的 resources/app.asar，覆盖归档中的配置、IPC、preload 和页面。
const root = process.env.YIBIAO_TEST_APP_ROOT ? path.resolve(process.env.YIBIAO_TEST_APP_ROOT) : sourceRoot;
const { createConfigStore } = require(path.join(root, 'electron', 'services', 'configStore.cjs'));
const { registerConfigIpc } = require(path.join(root, 'electron', 'ipc', 'configIpc.cjs'));
const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), '投标宝-干净启动-'));
let windowUnderTest = null;

app.setPath('userData', tempUserData);
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(webContents, expression, message, timeout = 10_000) {
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

async function navigateToTextModel(webContents) {
  await waitFor(webContents, `document.querySelector('button[aria-label="设置"]')`, '首屏没有渲染设置入口');
  await webContents.executeJavaScript(`document.querySelector('button[aria-label="设置"]').click()`);
  await waitFor(webContents, `[...document.querySelectorAll('button[role="tab"]')].some((button) => button.textContent.trim() === '文本模型')`, '设置页没有渲染文本模型标签');
  await webContents.executeJavaScript(`[...document.querySelectorAll('button[role="tab"]')].find((button) => button.textContent.trim() === '文本模型').click()`);
  await waitFor(webContents, `document.querySelector('button[role="switch"][aria-label="当前文本模型支持读图"]')`, '文本模型页没有多模态开关');
}

async function run() {
  const appSource = fs.readFileSync(path.join(sourceRoot, 'src', 'App.tsx'), 'utf8');
  const providersSource = fs.readFileSync(path.join(sourceRoot, 'src', 'app', 'providers', 'AppProviders.tsx'), 'utf8');
  const sidebarSource = fs.readFileSync(path.join(sourceRoot, 'src', 'components', 'Sidebar.tsx'), 'utf8');
  const settingsSource = fs.readFileSync(path.join(sourceRoot, 'src', 'features', 'settings', 'pages', 'SettingsPage.tsx'), 'utf8');
  const mainIpcSource = [
    fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8'),
    fs.readFileSync(path.join(root, 'electron', 'ipc', 'index.cjs'), 'utf8'),
  ].join('\n');
  assert.doesNotMatch(appSource, /StartupAdvertisementDialog|UpdateNotifier|LicenseStatusPrompt|RequiredOnlineServicesPrompt|GpuHardwareAccelerationPrompt/);
  assert.doesNotMatch(providersSource, /DonationPromptProvider|UpdateNotifier/);
  assert.doesNotMatch(sidebarSource, /ChangelogDialog|useChangelogUnread|NoticeBoardDialog|useNoticeUnread|USER_GUIDE_URL/);
  assert.doesNotMatch(settingsSource, /wiki\.agnet\.top|使用文档/);
  assert.doesNotMatch(mainIpcSource, /registerOfficialAccountIpc|registerOfficialInvoiceIpc|createOfficialAccountService/);
  const providerListSource = settingsSource.match(/const textModelProviders[\s\S]*?\n\];/)?.[0] || '';
  assert.ok(providerListSource, '无法定位文本服务商列表');
  assert.doesNotMatch(providerListSource, /official|易标官方/);

  const configStore = createConfigStore(app);
  registerConfigIpc({
    configStore,
    aiService: {
      listModels: async () => ({ success: true, models: [] }),
      getModelInfo: async () => ({ success: false, message: '测试未调用模型' }),
    },
  });

  handle('workspace-database:get-status', () => ({ phase: 'ready', ready: true, message: '本地数据库已就绪' }));
  handle('ui:set-current-view', () => ({ success: true }));
  handle('app:get-version', () => '0.2.0-test');
  handle('license:get-status', () => ({ status: 'valid', sourceTrusted: true, plan: 'test', config: {} }));
  handle('agent:get-status', () => ({ status: 'idle' }));
  handle('agent:get-pending-question', () => null);
  handle('auto-confirmation:get-state', () => ({ enabled: false }));
  handle('auto-confirmation:set-enabled', (_event, enabled) => ({ enabled: Boolean(enabled) }));
  handle('tasks:get-active', () => []);
  handle('technical-plan:load-state', () => ({
    step: 'document-analysis', tenderFile: null, tenderFiles: [], originalPlanFile: null,
    projectOverview: '', techRequirements: '', bidAnalysisMode: 'key', bidAnalysisSelectedTaskIds: [],
    bidAnalysisTasks: {}, bidAnalysisProgress: 0, bidSectionMode: 'single', bidSections: [],
    bidSectionExtractionStatus: 'idle', outlineMode: 'standalone-technical', outlineExpansionMode: 'ai-complement',
    outlineWordControlOptions: { mode: 'words', targetPages: 0, minimumPages: 0, maximumPages: 0, minimumWords: 0, maximumWords: 0, sectionWords: 0 },
    referenceKnowledgeDocumentIds: [], globalFactsMode: 'fabricate', globalFacts: [], exportTemplateId: '',
    exportTemplateScope: 'ai-only', contentGenerationSections: {}, contentGenerationPlans: {}, outlineData: null,
  }));
  handle('duplicate-check:load-state', () => ({
    tenderFile: null,
    tenderFiles: [],
    bidFiles: [],
    step: 'upload',
    activeAnalysisTab: 'metadata',
  }));

  const initialConfig = configStore.load();
  assert.equal(initialConfig.text_model_provider, 'custom', '全新 userData 的默认文本服务商必须是 custom');
  assert.equal(initialConfig.multimodal_enabled, false, '全新 custom 配置的多模态开关默认应关闭');

  windowUnderTest = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      preload: path.join(root, 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 测试不应触发真实统计、更新或供应商请求。
  windowUnderTest.webContents.session.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (_details, callback) => callback({ cancel: true }),
  );

  await windowUnderTest.loadFile(path.join(root, 'dist', 'index.html'));
  const webContents = windowUnderTest.webContents;
  await waitFor(webContents, `document.querySelector('button[aria-label="设置"]')`, '应用首屏未完成渲染');
  await delay(350);

  const cleanStart = await webContents.executeJavaScript(`({
    dialogs: document.querySelectorAll('[role="dialog"]').length,
    body: document.body.innerText,
  })`);
  assert.equal(cleanStart.dialogs, 0, '全新启动不应出现主动弹窗');
  assert.doesNotMatch(cleanStart.body, /充值|易标官方\s*API|客户端授权提醒|联网服务不可用|GPU\s*硬件加速显示正常吗/);

  const sidebarFooterLabels = await webContents.executeJavaScript(`[...document.querySelectorAll('.sidebar-footer button')].map((button) => button.getAttribute('aria-label'))`);
  assert.deepEqual(sidebarFooterLabels, ['设置'], '侧栏底部只应保留设置，不应再出现文档、更新日志或公告');

  await webContents.executeJavaScript(`document.querySelector('button[aria-label="标书检查"]').click()`);
  await waitFor(webContents, `[...document.querySelectorAll('.secondary-menu-row')].some((button) => button.textContent.includes('标书查重'))`, '没有进入标书检查二级菜单');
  await webContents.executeJavaScript(`[...document.querySelectorAll('.secondary-menu-row')].find((button) => button.textContent.includes('标书查重')).click()`);
  await waitFor(webContents, `document.querySelector('.duplicate-check-page .floating-toolbar-dock')`, '标书查重页没有渲染共享底部工具条');
  const ordinaryToolbarLayouts = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    windowUnderTest.setSize(1280, 800);
    webContents.setZoomFactor(1);
    await delay(60);
    windowUnderTest.setSize(1024, 640);
    webContents.setZoomFactor(1.25);
    await webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    await delay(180);
    ordinaryToolbarLayouts.push(await webContents.executeJavaScript(`(async () => {
      const page = document.querySelector('.duplicate-check-page');
      const body = page?.querySelector('.duplicate-upload-body');
      const dock = page?.querySelector(':scope > .floating-toolbar-dock');
      const toolbar = dock?.querySelector('.floating-toolbar');
      if (!page || !body || !dock || !toolbar) return null;
      body.scrollTop = body.scrollHeight;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const toolbarRect = toolbar.getBoundingClientRect();
      const bodyRect = body.getBoundingClientRect();
      const guideEnd = body.querySelector('.duplicate-guide-list li:last-child') || body.querySelector('.duplicate-guide-panel');
      const guideEndRect = guideEnd?.getBoundingClientRect();
      const contentRects = [...page.children]
        .filter((child) => child !== dock)
        .map((child) => ({ className: child.className, rect: child.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 0 && rect.height > 0);
      const maxScrollLeft = Math.max(0, toolbar.scrollWidth - toolbar.clientWidth);
      toolbar.scrollLeft = maxScrollLeft;
      return {
        overlappingContent: contentRects
          .filter(({ rect }) => Math.max(0, Math.min(rect.bottom, toolbarRect.bottom) - Math.max(rect.top, toolbarRect.top)) > 0)
          .map(({ className, rect }) => ({ className, top: rect.top, bottom: rect.bottom, toolbarTop: toolbarRect.top, toolbarBottom: toolbarRect.bottom })),
        dockInsidePage: dock.getBoundingClientRect().bottom <= page.getBoundingClientRect().bottom + 1,
        horizontalEndReachable: Math.abs(toolbar.scrollLeft - maxScrollLeft) <= 1,
        guideEndReachable: Boolean(guideEndRect && guideEndRect.bottom <= bodyRect.bottom + 1 && guideEndRect.top >= bodyRect.top - 1),
        bodyAtEnd: Math.abs(body.scrollTop - Math.max(0, body.scrollHeight - body.clientHeight)) <= 1,
        diagnostics: {
          page: page.getBoundingClientRect().toJSON(),
          pageGridRows: getComputedStyle(page).gridTemplateRows,
          pageGap: getComputedStyle(page).gap,
          body: bodyRect.toJSON(),
          dock: dock.getBoundingClientRect().toJSON(),
          guideEnd: guideEndRect?.toJSON(),
        },
      };
    })()`));
  }
  ordinaryToolbarLayouts.forEach((ordinaryToolbarLayout, index) => {
    assert.ok(ordinaryToolbarLayout, `普通功能页第${index + 1}轮未渲染共享底部工具条布局`);
    assert.deepEqual(ordinaryToolbarLayout.overlappingContent, [], `普通功能页第${index + 1}轮内容不得被底部工具条覆盖：${JSON.stringify(ordinaryToolbarLayout)}`);
    assert.equal(ordinaryToolbarLayout.dockInsidePage, true, `普通功能页第${index + 1}轮工具条不得越出页面`);
    assert.equal(ordinaryToolbarLayout.horizontalEndReachable, true, `普通功能页第${index + 1}轮工具条末项不可达`);
    assert.equal(ordinaryToolbarLayout.bodyAtEnd, true, `普通功能页第${index + 1}轮内容区无法滚到底`);
    assert.equal(ordinaryToolbarLayout.guideEndReachable, true, `普通功能页第${index + 1}轮说明区末项滚到底后不可见`);
  });

  await navigateToTextModel(webContents);
  const textModelState = await webContents.executeJavaScript(`(() => {
    const providerRow = [...document.querySelectorAll('label.settings-row')]
      .find((row) => row.querySelector('strong')?.textContent.trim() === '服务提供商');
    const provider = providerRow?.querySelector('select');
    const multimodal = document.querySelector('button[role="switch"][aria-label="当前文本模型支持读图"]');
    return {
      provider: provider?.value,
      options: [...(provider?.options || [])].map((option) => ({ value: option.value, text: option.textContent.trim() })),
      multimodalChecked: multimodal?.getAttribute('aria-checked'),
      body: document.body.innerText,
      dialogs: document.querySelectorAll('[role="dialog"]').length,
    };
  })()`);
  assert.equal(textModelState.provider, 'custom');
  assert.equal(textModelState.options.some((option) => option.value === 'official' || /易标官方/.test(option.text)), false, '服务商下拉不得出现易标官方 API');
  assert.equal(textModelState.multimodalChecked, 'false');
  assert.equal(textModelState.dialogs, 0, '进入设置页不应触发弹窗');
  assert.doesNotMatch(textModelState.body, /充值|易标官方\s*API/);

  await delay(100);
  const toolbarLayout = await webContents.executeJavaScript(`(() => {
    const scroller = document.querySelector('.settings-page-scroll');
    const dock = document.querySelector('.settings-page > .floating-toolbar-dock');
    const toolbar = dock?.querySelector('.floating-toolbar');
    const shell = document.querySelector('.content-shell');
    if (!scroller || !dock || !toolbar || !shell) return null;
    scroller.scrollTop = scroller.scrollHeight;
    const settingRows = [...scroller.querySelectorAll('.settings-page-section > .settings-list:last-of-type > :last-child')];
    const lastSettingRow = settingRows.at(-1);
    const scrollerRect = scroller.getBoundingClientRect();
    const dockRect = dock.getBoundingClientRect();
    const toolbarRect = toolbar.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    const maxScrollLeft = Math.max(0, toolbar.scrollWidth - toolbar.clientWidth);
    toolbar.scrollLeft = maxScrollLeft;
    return {
      overlap: Math.max(0, Math.min(scrollerRect.bottom, toolbarRect.bottom) - Math.max(scrollerRect.top, toolbarRect.top)),
      lastSettingRowVisible: lastSettingRow ? lastSettingRow.getBoundingClientRect().bottom <= scrollerRect.bottom + 1 : false,
      dockAfterScroller: dockRect.top >= scrollerRect.bottom - 1,
      toolbarInsideShell: toolbarRect.left >= shellRect.left - 1 && toolbarRect.right <= shellRect.right + 1 && toolbarRect.bottom <= shellRect.bottom + 1,
      horizontalEndReachable: Math.abs(toolbar.scrollLeft - maxScrollLeft) <= 1,
    };
  })()`);
  assert.ok(toolbarLayout, '设置页未渲染共享底部工具条布局');
  assert.equal(toolbarLayout.overlap, 0, '设置内容滚动区不得被底部工具条覆盖');
  assert.equal(toolbarLayout.lastSettingRowVisible, true, '设置页滚到底后必须能看到当前设置卡片的真实末行');
  assert.equal(toolbarLayout.dockAfterScroller, true, '底部工具条必须占据设置页自身布局行');
  assert.equal(toolbarLayout.toolbarInsideShell, true, '窄高窗口和高缩放下工具条不得越出内容壳层');
  assert.equal(toolbarLayout.horizontalEndReachable, true, '窄屏下工具条首尾操作必须可横向滚动到达');

  await webContents.executeJavaScript(`document.querySelector('button[role="switch"][aria-label="当前文本模型支持读图"]').click()`);
  await waitFor(webContents, `document.querySelector('button[role="switch"][aria-label="当前文本模型支持读图"]').getAttribute('aria-checked') === 'true'`, '多模态开关没有切换为开启');
  await waitFor(webContents, `[...document.querySelectorAll('button')].some((button) => button.textContent.trim() === '保存' && !button.disabled)`, '设置修改后保存按钮没有启用');
  await webContents.executeJavaScript(`[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === '保存' && !button.disabled).click()`);

  const saveStarted = Date.now();
  while (Date.now() - saveStarted < 5_000 && configStore.load().multimodal_enabled !== true) await delay(50);
  const saved = configStore.load();
  assert.equal(saved.text_model_provider, 'custom');
  assert.equal(saved.multimodal_enabled, true, '保存后顶层多模态开关必须为 true');
  assert.equal(saved.text_model_profiles.custom.multimodal_enabled, true, '保存后 custom profile 多模态开关必须为 true');

  webContents.reload();
  await waitFor(webContents, `document.querySelector('button[aria-label="设置"]')`, '重载后应用没有恢复');
  await navigateToTextModel(webContents);
  const restored = await webContents.executeJavaScript(`document.querySelector('button[role="switch"][aria-label="当前文本模型支持读图"]').getAttribute('aria-checked')`);
  assert.equal(restored, 'true', '重载后多模态开关没有恢复保存状态');

  console.log('check-clean-start-ui: 通过');
  console.log(JSON.stringify({ staticRetired: true, cleanStartDialogs: 0, provider: 'custom', officialOption: false, multimodalSavedAndRestored: true }));
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
