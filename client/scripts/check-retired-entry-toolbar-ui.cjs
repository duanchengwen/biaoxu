// 隔离的 Electron DOM 验收：验证三个线上入口已退休、统计能力保留，
// 并在多种窗口/缩放组合下验证共享底部工具条不再遮挡正文。
// 只使用临时 userData、本地 IPC stub 和真实 dist/preload，不访问外网或用户数据。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const root = path.resolve(__dirname, '..');
const artifactDir = path.join(root, 'qa', 'artifacts', 'toolbar-drag');
const { createConfigStore } = require(path.join(root, 'electron', 'services', 'configStore.cjs'));
const { registerConfigIpc } = require(path.join(root, 'electron', 'ipc', 'configIpc.cjs'));
const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), '投标宝-入口与工具条-'));
let windowUnderTest = null;

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

const technicalPlanState = {
  step: 'generation-settings',
  tenderFile: {
    fileName: '隔离测试招标文件.docx',
    markdownPath: 'D:\\isolated-test\\tender.md',
    markdownChars: 1280,
    contentHash: 'isolated-test',
    updatedAt: new Date(0).toISOString(),
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
    mode: 'pages',
    targetPages: 100,
    minimumPages: 90,
    maximumPages: 110,
    minimumWords: 12_000,
    maximumWords: 18_000,
    sectionWords: 2_600,
  },
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
  registerConfigIpc({
    configStore,
    aiService: {
      listModels: async () => ({ success: true, models: [] }),
      getModelInfo: async () => ({ success: false, message: '隔离测试不调用模型' }),
    },
  });

  handle('workspace-database:get-status', () => ({ phase: 'ready', ready: true, message: '本地数据库已就绪' }));
  handle('ui:set-current-view', () => ({ success: true }));
  handle('app:get-version', () => '0.2.0-toolbar-test');
  handle('license:get-status', () => ({ status: 'valid', sourceTrusted: true, plan: 'test', config: {} }));
  handle('agent:get-status', () => ({ status: 'idle' }));
  handle('agent:get-pending-question', () => null);
  handle('auto-confirmation:get-state', () => ({ enabled: false }));
  handle('auto-confirmation:set-enabled', (_event, enabled) => ({ enabled: Boolean(enabled) }));
  handle('tasks:get-active', () => []);
  handle('templates:list', () => []);
  handle('knowledge-base:list', () => ({ folders: [], documents: [] }));
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
  handle('storage:get-usage', () => ({
    totalBytes: 1024,
    scannedAt: new Date(0).toISOString(),
    groups: [{
      id: 'protected',
      label: '受保护数据',
      description: '隔离测试数据',
      bytes: 1024,
      items: [{ id: 'config', label: '配置', description: '不会删除', bytes: 1024 }],
    }],
  }));
}

function assertStaticContract() {
  const sidebar = fs.readFileSync(path.join(root, 'src', 'components', 'Sidebar.tsx'), 'utf8');
  const menuConfig = fs.readFileSync(path.join(root, 'src', 'app', 'menuConfig.ts'), 'utf8');
  const settings = fs.readFileSync(path.join(root, 'src', 'features', 'settings', 'pages', 'SettingsPage.tsx'), 'utf8');
  const analytics = fs.readFileSync(path.join(root, 'src', 'shared', 'analytics', 'analytics.ts'), 'utf8');
  const contentEdit = fs.readFileSync(path.join(root, 'src', 'features', 'technical-plan', 'pages', 'ContentEditPage.tsx'), 'utf8');

  assert.doesNotMatch(sidebar, /ChangelogDialog|useChangelogUnread|NoticeBoardDialog|useNoticeUnread/);
  assert.doesNotMatch(sidebar, /wiki\.agnet\.top|aria-label=["'](?:使用文档|帮助文档|更新日志|公告)["']/);
  assert.doesNotMatch(settings, /wiki\.agnet\.top|about-links-label["'>\s]*使用文档/);
  assert.match(sidebar, /<strong>标序<\/strong>[\s\S]*?<span>BIDXU<\/span>/, '侧栏品牌未切换为标序 / BIDXU');
  for (const label of ['项目', '资料库', '标书检查', '模板']) {
    assert.match(menuConfig, new RegExp(`label: '${label}'`), `缺少一级导航“${label}”`);
  }
  assert.doesNotMatch(menuConfig, /id: 'resource-download',[\s\S]{0,80}label:/, '资源下载仍作为独立一级导航');
  assert.match(menuConfig, /id: 'plugin-manager'/, '插件管理没有保留在二级入口');
  assert.match(menuConfig, /id: 'resources'/, '精选资源没有保留在二级入口');

  // 只退休入口，不得连匿名统计、任务统计或诊断能力一起删掉。
  assert.match(analytics, /export function trackAppOpen\(/);
  assert.match(analytics, /export function trackPageView\(/);
  assert.match(analytics, /export function trackConfigUsage\(/);
  assert.match(analytics, /export function trackResourceClick\(/);
  assert.match(settings, /Token 统计小窗/);
  assert.match(settings, /agent-diagnostic-section/);
  assert.match(contentEdit, /aria-label="正文生成统计"/);
}

async function navigateToSettings(webContents, tabLabel = '通用') {
  await waitFor(webContents, `document.querySelector('button[aria-label="设置"]')`, '没有设置入口');
  await webContents.executeJavaScript(`document.querySelector('button[aria-label="设置"]').click()`);
  await waitFor(webContents, `document.querySelector('.settings-page-scroll')`, '设置页没有渲染滚动容器');
  if (tabLabel) {
    await waitFor(webContents, `[...document.querySelectorAll('button[role="tab"]')].some((button) => button.textContent.trim() === ${JSON.stringify(tabLabel)})`, `设置页没有“${tabLabel}”标签`);
    await webContents.executeJavaScript(`[...document.querySelectorAll('button[role="tab"]')].find((button) => button.textContent.trim() === ${JSON.stringify(tabLabel)}).click()`);
    await delay(120);
  }
}

async function navigateToLengthSettings(webContents) {
  const technicalPlanVisible = await webContents.executeJavaScript(`[...document.querySelectorAll('button')].some((button) => button.textContent.includes('投标文件'))`);
  if (!technicalPlanVisible) {
    await waitFor(webContents, `document.querySelector('button[aria-label="项目"]')`, '没有项目菜单');
    await webContents.executeJavaScript(`document.querySelector('button[aria-label="项目"]').click()`);
    await waitFor(webContents, `[...document.querySelectorAll('button')].some((button) => button.textContent.includes('继续技术标编制'))`, '项目首页没有继续编制入口');
    await webContents.executeJavaScript(`[...document.querySelectorAll('button')].find((button) => button.textContent.includes('继续技术标编制')).click()`);
  }
  if (await webContents.executeJavaScript(`[...document.querySelectorAll('button')].some((button) => button.textContent.includes('投标文件编制'))`)) {
    await webContents.executeJavaScript(`[...document.querySelectorAll('button')].find((button) => button.textContent.includes('投标文件编制')).click()`);
  }
  await waitFor(webContents, `[...document.querySelectorAll('button[role="tab"]')].some((button) => button.textContent.includes('目标篇幅'))`, '生成设置没有“目标篇幅”标签');
  await webContents.executeJavaScript(`[...document.querySelectorAll('button[role="tab"]')].find((button) => button.textContent.includes('目标篇幅')).click()`);
  await waitFor(webContents, `document.querySelector('.generation-settings-panel') && document.querySelector('[role="toolbar"][aria-label="技术方案工具条"]')`, '技术方案页或工具条未渲染');
  await delay(120);
}

async function applyViewport(windowHandle, webContents, viewport) {
  webContents.setZoomFactor(viewport.zoom);
  windowHandle.setSize(viewport.width, viewport.height, false);
  await delay(220);
}

async function saveScreenshot(webContents, name) {
  fs.mkdirSync(artifactDir, { recursive: true });
  webContents.invalidate();
  await webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await delay(220);
  const image = await webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
  assert.equal(image.isEmpty(), false, `${name} 截图为空`);
  fs.writeFileSync(path.join(artifactDir, name), image.toPNG());
}

async function readGeometry(webContents, scrollSelector, toolbarLabel, endSelector = '') {
  return webContents.executeJavaScript(`(async () => {
    const scroll = document.querySelector(${JSON.stringify(scrollSelector)});
    const toolbar = document.querySelector('[role="toolbar"][aria-label=${JSON.stringify(toolbarLabel)}]');
    const dock = toolbar?.closest('.floating-toolbar-dock');
    const toolbarScroll = toolbar?.querySelector('.floating-toolbar-scroll') || toolbar;
    if (!scroll || !toolbar || !dock || !toolbarScroll) return null;
    // 设置页/生成设置页可能在进入后异步补齐本地配置。连续多帧追到新的末端，
    // 避免先滚动、后内容增高造成“差一行”的假失败。
    for (let index = 0; index < 4; index += 1) {
      scroll.scrollTop = scroll.scrollHeight;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
    const visibleChildren = [...scroll.children].filter((node) => node.getClientRects().length > 0);
    const last = ${JSON.stringify(endSelector)} ? document.querySelector(${JSON.stringify(endSelector)}) : visibleChildren.at(-1);
    const scrollRect = scroll.getBoundingClientRect();
    const lastRect = last?.getBoundingClientRect();
    const toolbarRect = toolbar.getBoundingClientRect();
    const dockRect = dock.getBoundingClientRect();
    const area = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
      * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const buttons = [...toolbarScroll.querySelectorAll('button')];
    toolbarScroll.scrollLeft = 0;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const firstAtStart = buttons.at(0)?.getBoundingClientRect();
    toolbarScroll.scrollLeft = toolbarScroll.scrollWidth;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const lastAtEnd = buttons.at(-1)?.getBoundingClientRect();
    const refreshedToolbarRect = toolbar.getBoundingClientRect();
    const compact = (rect) => rect ? ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }) : null;
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollTop: scroll.scrollTop,
      scrollMax: Math.max(0, scroll.scrollHeight - scroll.clientHeight),
      scrollHeight: scroll.scrollHeight,
      clientHeight: scroll.clientHeight,
      toolbarScrollWidth: toolbarScroll.scrollWidth,
      toolbarClientWidth: toolbarScroll.clientWidth,
      toolbarPosition: getComputedStyle(toolbar).position,
      scrollRect: compact(scrollRect),
      lastRect: compact(lastRect),
      toolbarRect: compact(refreshedToolbarRect),
      dockRect: compact(dockRect),
      lastToolbarOverlap: lastRect ? area(lastRect, refreshedToolbarRect) : -1,
      scrollToolbarOverlap: area(scrollRect, refreshedToolbarRect),
      firstReachable: Boolean(firstAtStart && firstAtStart.left >= refreshedToolbarRect.left - 1 && firstAtStart.right <= refreshedToolbarRect.right + 1),
      lastReachable: Boolean(lastAtEnd && lastAtEnd.left >= refreshedToolbarRect.left - 1 && lastAtEnd.right <= refreshedToolbarRect.right + 1),
    };
  })()`);
}

async function pointerDrag(webContents, deltaX, deltaY) {
  const point = await webContents.executeJavaScript(`(() => {
    const handle = document.querySelector('.floating-toolbar-drag-handle');
    if (!handle) return null;
    const rect = handle.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
  assert.ok(point, '没有找到工具条专用拖动把手');
  webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
  webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  for (let index = 1; index <= 4; index += 1) {
    webContents.sendInputEvent({
      type: 'mouseMove',
      x: Math.round(point.x + deltaX * index / 4),
      y: Math.round(point.y + deltaY * index / 4),
      movementX: Math.round(deltaX / 4),
      movementY: Math.round(deltaY / 4),
    });
    await delay(20);
  }
  await webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  // 隐藏 offscreen 窗口不会像可见 OS 窗口那样把窗口外 mouseUp 可靠送回捕获节点；
  // 用移动后的真实把手中心释放，仍由 Electron 真实 mouse 输入触发生产 onPointerUp。
  const release = await webContents.executeJavaScript(`(() => {
    const rect = document.querySelector('.floating-toolbar-drag-handle')?.getBoundingClientRect();
    return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null;
  })()`);
  assert.ok(release, '拖动后把手消失');
  webContents.sendInputEvent({ type: 'mouseUp', x: release.x, y: release.y, button: 'left', clickCount: 1 });
  await delay(100);
}

async function readFloatingToolbarState(webContents) {
  return webContents.executeJavaScript(`(() => {
    const toolbar = document.querySelector('.floating-toolbar');
    const dock = document.querySelector('.floating-toolbar-dock');
    const shell = document.querySelector('.content-shell');
    const handle = document.querySelector('.floating-toolbar-drag-handle');
    if (!toolbar || !dock || !shell || !handle) return null;
    const compact = (node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const style = getComputedStyle(toolbar);
    const ancestorStyles = [];
    for (let node = toolbar.parentElement; node && ancestorStyles.length < 6; node = node.parentElement) {
      const computed = getComputedStyle(node);
      ancestorStyles.push({ className: node.className, transform: computed.transform, contain: computed.contain, zoom: computed.zoom });
    }
    return {
      floating: toolbar.classList.contains('is-floating'),
      dragging: toolbar.classList.contains('is-dragging'),
      toolbar: compact(toolbar), dock: compact(dock), shell: compact(shell),
      innerWidth, innerHeight, devicePixelRatio,
      handleLabel: handle.getAttribute('aria-label'),
      inlineStyle: { left: toolbar.style.left, top: toolbar.style.top, maxWidth: toolbar.style.maxWidth },
      computedStyle: {
        left: style.left, top: style.top, width: style.width, minWidth: style.minWidth,
        maxWidth: style.maxWidth, boxSizing: style.boxSizing, transform: style.transform,
      },
      ancestorStyles,
    };
  })()`);
}

function assertFloatingInside(state, label) {
  assert.ok(state?.floating, `${label}：工具条没有进入用户选择的浮动态`);
  assert.equal(state.dragging, false, `${label}：鼠标释放后仍残留拖动态`);
  const left = Math.max(0, state.shell.left) + 7;
  const top = Math.max(0, state.shell.top) + 7;
  const right = Math.min(state.innerWidth, state.shell.right) - 7;
  const bottom = Math.min(state.innerHeight, state.shell.bottom) - 7;
  assert.ok(state.toolbar.left >= left - 1 && state.toolbar.top >= top - 1
    && state.toolbar.right <= right + 1 && state.toolbar.bottom <= bottom + 1,
  `${label}：浮动工具条未限制在工作区/视口交集：${JSON.stringify(state)}`);
}

async function assertFloatingToolbarDrag(windowHandle, webContents) {
  await applyViewport(windowHandle, webContents, { width: 1280, height: 720, zoom: 1 });
  const docked = await readFloatingToolbarState(webContents);
  assert.ok(docked, '生成设置页没有共享工具条');
  assert.equal(docked.floating, false, '工具条默认不应是覆盖层');
  assert.ok(docked.dock.height <= 52, `默认 dock 不够紧凑：${JSON.stringify(docked)}`);
  assert.ok(docked.toolbar.height <= 46, `默认卡片不够紧凑：${JSON.stringify(docked)}`);
  await saveScreenshot(webContents, 'toolbar-default-dock-1280x720.png');

  // 普通按钮点击不得被误判为拖动；测试数据位于隔离 userData。
  const ordinaryClicked = await webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('.floating-toolbar-scroll button:not(:disabled)')]
      .find((node) => /^(?:下一项|上一项|上一步|下一步)/.test(node.textContent.trim()));
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(ordinaryClicked, true, '没有可安全点击的普通工具条导航按钮');
  await delay(600);
  let state = await readFloatingToolbarState(webContents);
  assert.equal(state?.floating, false, '普通工具条按钮点击被误判为拖动');

  await pointerDrag(webContents, 1, 1);
  state = await readFloatingToolbarState(webContents);
  assert.equal(state?.floating, false, '小于 3px 的把手位移不应激活浮动态');

  const beforeDrag = state.toolbar;
  await pointerDrag(webContents, -140, -120);
  state = await readFloatingToolbarState(webContents);
  assertFloatingInside(state, '二维拖动');
  assert.ok(Math.abs(state.toolbar.left - beforeDrag.left) > 20 && Math.abs(state.toolbar.top - beforeDrag.top) > 20,
    `工具条没有同时发生横向和纵向移动：${JSON.stringify({ beforeDrag, after: state.toolbar })}`);
  await saveScreenshot(webContents, 'toolbar-user-dragged-middle-1280x720.png');

  // 展开/收起侧栏后仍应保持浮动态并重新钳位到工作区。
  await webContents.executeJavaScript(`document.querySelector('button[aria-label="收起菜单"]')?.click()`);
  await delay(180);
  assertFloatingInside(await readFloatingToolbarState(webContents), '收起侧栏后');
  await webContents.executeJavaScript(`document.querySelector('button[aria-label="展开菜单"]')?.click()`);
  await delay(180);
  assertFloatingInside(await readFloatingToolbarState(webContents), '展开侧栏后');

  await applyViewport(windowHandle, webContents, { width: 1024, height: 640, zoom: 1.25 });
  await delay(250);
  assertFloatingInside(await readFloatingToolbarState(webContents), '1024x640@125% 缩放后');

  // 极端拖动必须 clamp，而不是越过窗口/工作区。
  await pointerDrag(webContents, 3000, 3000);
  assertFloatingInside(await readFloatingToolbarState(webContents), '右下边界 clamp');
  await pointerDrag(webContents, -3000, -3000);
  assertFloatingInside(await readFloatingToolbarState(webContents), '左上边界 clamp');

  // Escape/Home/双击均为显式归位路径；这里分别验证 Escape 与双击。
  await webContents.executeJavaScript(`document.querySelector('.floating-toolbar-drag-handle')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await delay(100);
  assert.equal((await readFloatingToolbarState(webContents))?.floating, false, 'Escape 未使工具条归位');
  // sendInputEvent 使用窗口 DIP；高缩放后直接传 DOM CSS 坐标会让测试鼠标错过把手。
  // 双击路径切回 100% 再发真实输入，产品在 125% 下的既有浮动 clamp 已在上方单独断言。
  await applyViewport(windowHandle, webContents, { width: 1280, height: 720, zoom: 1 });
  await pointerDrag(webContents, 100, -100);
  assertFloatingInside(await readFloatingToolbarState(webContents), '双击归位前');
  await webContents.executeJavaScript(`document.querySelector('.floating-toolbar-drag-handle')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await delay(100);
  assert.equal((await readFloatingToolbarState(webContents))?.floating, false, '双击把手未使工具条归位');

  await pointerDrag(webContents, -100, -90);
  assertFloatingInside(await readFloatingToolbarState(webContents), '跨页前');
  await navigateToSettings(webContents, '通用');
  state = await readFloatingToolbarState(webContents);
  assert.ok(state && !state.floating, '跨页面后新的工具条没有安全恢复到 dock');
}

function assertGeometry(result, label) {
  assert.ok(result, `${label}：没有取得布局数据`);
  assert.ok(result.clientHeight > 0 && result.scrollHeight >= result.clientHeight, `${label}：滚动容器尺寸无效`);
  assert.ok(Math.abs(result.scrollTop - result.scrollMax) <= 2, `${label}：滚动容器无法到达末端 ${JSON.stringify(result)}`);
  assert.ok(result.lastRect, `${label}：没有末行内容`);
  assert.ok(result.lastRect.bottom <= result.scrollRect.bottom + 2, `${label}：滚到底后最后一行仍不可见`);
  assert.ok(result.lastRect.bottom >= result.scrollRect.top, `${label}：最后一行落在可视区上方`);
  assert.equal(result.lastToolbarOverlap, 0, `${label}：工具条遮挡最后一行`);
  assert.equal(result.scrollToolbarOverlap, 0, `${label}：工具条仍覆盖正文滚动区`);
  assert.ok(result.scrollRect.bottom <= result.dockRect.top + 2, `${label}：工具条没有占据独立布局行`);
  assert.ok(result.toolbarRect.left >= -1 && result.toolbarRect.right <= result.innerWidth + 1, `${label}：工具条横向越出窗口`);
  assert.ok(result.toolbarRect.top >= -1 && result.toolbarRect.bottom <= result.innerHeight + 1, `${label}：工具条纵向越出窗口`);
  assert.ok(result.toolbarRect.width <= result.dockRect.width + 2, `${label}：工具条宽于可用停靠区`);
  assert.ok(result.firstReachable, `${label}：窄宽时无法查看第一个工具条按钮`);
  assert.ok(result.lastReachable, `${label}：窄宽时无法横向滚到最后一个工具条按钮`);
  assert.notEqual(result.toolbarPosition, 'fixed', `${label}：工具条仍是 fixed 覆盖层`);
  assert.notEqual(result.toolbarPosition, 'absolute', `${label}：工具条仍是 absolute 覆盖层`);
}

async function assertRetiredEntries(webContents) {
  const home = await webContents.executeJavaScript(`(() => ({
    labels: [...document.querySelectorAll('button,a')].map((node) => (node.getAttribute('aria-label') || node.textContent || '').trim()),
    urls: [...document.querySelectorAll('a[href]')].map((node) => node.href),
    body: document.body.innerText,
    brand: document.querySelector('.brand-copy')?.innerText || '',
    projectHome: Boolean(document.querySelector('.project-home-page #project-home-title')),
  }))()`);
  assert.match(home.brand, /标序[\s\S]*BIDXU/, '真实首屏没有显示标序 / BIDXU 品牌');
  for (const label of ['项目', '资料库', '标书检查', '模板', '设置']) {
    assert.equal(home.labels.some((value) => value === label), true, `首屏缺少一级导航“${label}”`);
  }
  assert.equal(home.projectHome, true, '默认项目路由没有渲染真实工作区首页');
  for (const label of ['使用文档', '帮助文档', '更新日志', '公告']) {
    assert.equal(home.labels.some((value) => value === label), false, `首屏仍有“${label}”入口`);
  }
  assert.equal(home.urls.some((url) => /wiki\.agnet\.top/i.test(url)), false, '首屏仍有使用文档链接');

  await navigateToSettings(webContents, '关于');
  const about = await webContents.executeJavaScript(`(() => ({
    body: document.body.innerText,
    urls: [...document.querySelectorAll('a[href]')].map((node) => node.href),
  }))()`);
  assert.doesNotMatch(about.body, /使用文档|帮助文档|更新日志|(?:^|\n)公告(?:\n|$)/);
  assert.equal(about.urls.some((url) => /wiki\.agnet\.top/i.test(url)), false, '关于页仍有使用文档链接');
  assert.match(about.body, /匿名埋点只用于了解功能使用情况/, '关于页的匿名统计说明被误删');
  assert.match(about.body, /开源项目/, '关于页上游开源归属入口被误删');
  assert.match(about.body, /OpenBidKit_Yibiao（AGPL-3\.0）/, '关于页上游项目与许可证归属不完整');
}

async function assertDialogLayering(webContents) {
  await navigateToSettings(webContents, '通用');
  await waitFor(webContents, `[...document.querySelectorAll('button')].some((button) => button.textContent.trim() === '查看与清理')`, '没有存储空间对话框入口');
  await webContents.executeJavaScript(`[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === '查看与清理').click()`);
  await waitFor(webContents, `document.querySelector('[role="dialog"]')?.textContent.includes('存储空间')`, '真实 AppDialog 未打开');
  const state = await webContents.executeJavaScript(`(() => {
    const toolbar = document.querySelector('[role="toolbar"][aria-label="设置保存工具条"]');
    const dialog = document.querySelector('[role="dialog"]');
    const overlay = document.querySelector('.app-dialog-modal');
    const toolbarRect = toolbar?.getBoundingClientRect();
    const dialogRect = dialog?.getBoundingClientRect();
    const point = toolbarRect ? document.elementFromPoint(toolbarRect.left + toolbarRect.width / 2, toolbarRect.top + toolbarRect.height / 2) : null;
    const z = (element) => {
      const value = Number.parseInt(element ? getComputedStyle(element).zIndex : '', 10);
      return Number.isFinite(value) ? value : 0;
    };
    return {
      dialogRect: dialogRect ? { left: dialogRect.left, top: dialogRect.top, right: dialogRect.right, bottom: dialogRect.bottom } : null,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      dialogZ: z(dialog),
      overlayZ: z(overlay),
      toolbarZ: z(toolbar),
      toolbarBlocked: Boolean(toolbar && point && !toolbar.contains(point)),
    };
  })()`);
  assert.ok(state.dialogRect, 'Dialog 没有可测量的卡片');
  assert.ok(state.dialogRect.left >= -1 && state.dialogRect.right <= state.innerWidth + 1, 'Dialog 横向越出窗口');
  assert.ok(state.dialogRect.top >= -1 && state.dialogRect.bottom <= state.innerHeight + 1, 'Dialog 纵向越出窗口');
  assert.ok(state.overlayZ > state.toolbarZ, 'Dialog 遮罩层级没有高于工具条');
  assert.ok(state.dialogZ > state.toolbarZ, 'Dialog 卡片层级没有高于工具条');
  assert.equal(state.toolbarBlocked, true, 'Dialog 打开时工具条仍可直接命中');
  await webContents.executeJavaScript(`[...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent.trim() === '关闭').click()`);
  await waitFor(webContents, `!document.querySelector('[role="dialog"]')`, 'Dialog 关闭操作失效');
}

async function run() {
  assertStaticContract();
  installHarnessIpc();
  windowUnderTest = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    webPreferences: {
      preload: path.join(root, 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 隐藏验收窗仍应按真实可见窗口执行 resize/clamp 计时器，避免 Chromium 后台节流制造假失败。
      backgroundThrottling: false,
      offscreen: true,
    },
  });
  windowUnderTest.webContents.session.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (_details, callback) => callback({ cancel: true }),
  );
  await windowUnderTest.loadFile(path.join(root, 'dist', 'index.html'));
  const webContents = windowUnderTest.webContents;
  await waitFor(webContents, `document.querySelector('button[aria-label="设置"]')`, '真实 dist 首屏未渲染');
  console.log('toolbar-ui progress: dist loaded');
  await assertRetiredEntries(webContents);
  console.log('toolbar-ui progress: retired entries');

  const viewports = [
    { width: 1280, height: 720, zoom: 1, label: '1280x720@100%' },
    { width: 1024, height: 640, zoom: 1, label: '1024x640@100%' },
    { width: 1280, height: 720, zoom: 1.5, label: '1280x720@150%' },
  ];
  const results = [];

  await navigateToSettings(webContents, '文本模型');
  for (const viewport of viewports) {
    await applyViewport(windowUnderTest, webContents, viewport);
    const geometry = await readGeometry(
      webContents,
      '.settings-page-scroll',
      '设置保存工具条',
      '.settings-page-section > .settings-list:last-of-type > :last-child',
    );
    assertGeometry(geometry, `设置页 ${viewport.label}`);
    results.push({ page: 'settings', viewport: viewport.label, geometry });
    console.log(`toolbar-ui progress: settings ${viewport.label}`);
  }

  await navigateToLengthSettings(webContents);
  for (const viewport of viewports) {
    await applyViewport(windowUnderTest, webContents, viewport);
    const geometry = await readGeometry(webContents, '.generation-settings-panel', '技术方案工具条');
    assertGeometry(geometry, `生成设置页 ${viewport.label}`);
    results.push({ page: 'generation-settings', viewport: viewport.label, geometry });
    console.log(`toolbar-ui progress: generation-settings ${viewport.label}`);
  }

  await assertFloatingToolbarDrag(windowUnderTest, webContents);
  console.log('toolbar-ui progress: floating drag');

  await applyViewport(windowUnderTest, webContents, viewports[2]);
  await assertDialogLayering(webContents);

  console.log('check-retired-entry-toolbar-ui: 通过');
  console.log(JSON.stringify({
    retiredEntries: ['使用文档/帮助文档', '更新日志', '公告'],
    analyticsRetained: true,
    viewports: viewports.map((item) => item.label),
    pages: ['settings', 'generation-settings'],
    floatingToolbarDrag: 'handle-only, threshold, 2D, clamp, resize, sidebar, reset, route-reset',
    dialogLayering: true,
    layouts: results.map(({ page, viewport, geometry }) => ({
      page,
      viewport,
      scrollable: geometry.scrollHeight > geometry.clientHeight,
      horizontalOverflow: geometry.toolbarScrollWidth > geometry.toolbarClientWidth,
      lastToolbarOverlap: geometry.lastToolbarOverlap,
      scrollToolbarOverlap: geometry.scrollToolbarOverlap,
    })),
  }));
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
