// 标序亮色主题独立 DOM 验收：真实 dist + preload，只使用临时 userData 和本地 IPC stub。
// 不调用真实模型、不访问用户资料、不打开可见窗口，也不执行打包。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const {
  Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType,
} = require('docx');

const root = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(root, '..');
const artifactDir = path.join(root, 'qa', 'artifacts', 'branding-theme');
const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'bidxu-branding-theme-'));
const { createConfigStore } = require(path.join(root, 'electron', 'services', 'configStore.cjs'));
const { registerConfigIpc } = require(path.join(root, 'electron', 'ipc', 'configIpc.cjs'));

let windowUnderTest = null;
let importTenderCalls = 0;
let technicalPlanLoads = 0;
let previewDocxBytes = null;
let technicalPlanState = emptyTechnicalPlanState();

app.setPath('userData', tempUserData);
app.commandLine.appendSwitch('disable-gpu');

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

function emptyTechnicalPlanState() {
  return {
    step: 'document-analysis',
    tenderFile: null,
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
      mode: 'pages', targetPages: 100, minimumPages: 90, maximumPages: 110,
      minimumWords: 12_000, maximumWords: 18_000, sectionWords: 2_600,
    },
    referenceKnowledgeDocumentIds: [],
    globalFactsMode: 'fabricate',
    globalFacts: [],
    exportTemplateId: '',
    exportTemplateScope: 'ai-only',
    contentGenerationSections: {},
    contentGenerationPlans: {},
    outlineData: null,
  };
}

function richTechnicalPlanState() {
  const state = emptyTechnicalPlanState();
  const timestamp = new Date(0).toISOString();
  const first = {
    sourceId: 'qa-source-a', fileName: 'QA-真实状态-2026.docx',
    markdownPath: 'D:\\isolated-test\\qa-real-state.md', markdownChars: 50_000,
    contentHash: 'qa-real-state-a', updatedAt: timestamp, selectedSectionTitle: '第一标段',
  };
  Object.assign(state, {
    step: 'content-edit',
    tenderFile: first,
    tenderFiles: [
      first,
      {
        sourceId: 'qa-source-b', fileName: 'QA-补充材料.docx',
        markdownPath: 'D:\\isolated-test\\qa-supplement.md', markdownChars: 30_235,
        contentHash: 'qa-real-state-b', updatedAt: timestamp,
      },
    ],
    contentGenerationTask: {
      task_id: 'qa-running-content', type: 'content-generation', status: 'running', progress: 37,
      logs: ['QA-RUNNING-LOG-37'], started_at: timestamp, updated_at: timestamp,
    },
  });
  return state;
}

function completedTechnicalPlanState() {
  const state = richTechnicalPlanState();
  const timestamp = new Date(0).toISOString();
  state.contentGenerationTask = {
    task_id: 'qa-completed-content', type: 'content-generation', status: 'success', progress: 100,
    logs: ['隔离 fixture 正文生成已完成'], started_at: timestamp, updated_at: timestamp,
    stats: { content: {
      generation_completed: true,
      consistency_status: 'completed',
      consistency_remaining_issues: ['section-1：交付期限与全局事实不一致，待人工复核'],
    } },
  };
  state.exportTemplateId = 'qa-template';
  state.outlineWordControlSnapshot = { ...state.outlineWordControlOptions };
  state.outlineData = {
    project_name: 'QA 真实正文工作区',
    outline: [{ id: 'section-1', number: '1', title: '施工组织方案', description: '隔离验收章节', content_mode: 'ai-generate' }],
  };
  state.contentGenerationSections = {
    'section-1': {
      id: 'section-1', title: '施工组织方案', status: 'success',
      // 生产协议不在 SQLite 状态里保存 AI 正文；正文只存在会话 HTML 工作区。
      content: '',
    },
  };
  state.contentGenerationRuntime = {
    phase: 'word-completed',
    section_words: { 'section-1': 1260 },
    html_output: { workspace_dir: 'qa-workspace', word_output_dir: 'qa-word', word_sections: [] },
  };
  return state;
}

function emptyCredentialSnapshot() {
  return {
    profile: {
      companyName: '', unifiedSocialCreditCode: '', phone: '', email: '', legalRepresentative: '',
      registeredCapital: '', operatingPeriodStart: '', operatingPeriodEnd: '', address: '', businessScope: '',
      industry: '', companyType: '', insuredEmployeeCount: '', companyIntro: '', taxCertificateDate: '',
      taxCertificateNote: '', auditReportDate: '', auditReportNote: '', socialSecurityCertificateDate: '',
      socialSecurityCertificateNote: '', bankAccountName: '', bankAccountNumber: '', bankName: '',
      bankRoutingNumber: '', watermarkEnabled: false, watermarkContent: '', createdAt: '', updatedAt: '',
    },
    certificates: [], employees: [], projects: [], otherMaterials: [], images: [],
  };
}

async function buildPreviewDocx() {
  const document = new Document({
    sections: [{
      children: [
        new Paragraph({ children: [new TextRun({ text: '施工组织方案', bold: true, size: 32 })] }),
        new Paragraph('本节采用分区施工、节点验收和闭环整改机制，所有记录均来自隔离验收 fixture。'),
        new Paragraph('关键控制：施工前交底，施工中巡检，完成后按检查表验收。'),
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({ children: [new TableCell({ children: [new Paragraph('阶段')] }), new TableCell({ children: [new Paragraph('验收要求')] })] }),
            new TableRow({ children: [new TableCell({ children: [new Paragraph('施工准备')] }), new TableCell({ children: [new Paragraph('资料与人员到位')] })] }),
            new TableRow({ children: [new TableCell({ children: [new Paragraph('过程检查')] }), new TableCell({ children: [new Paragraph('问题闭环并留痕')] })] }),
          ],
        }),
      ],
    }],
  });
  return new Uint8Array(await Packer.toBuffer(document));
}

function installHarnessIpc() {
  const configStore = createConfigStore(app);
  const initialConfig = configStore.load();
  configStore.save({
    ...initialConfig,
    text_model_provider: 'custom',
    api_key: 'qa-isolated-key',
    model_name: 'qa-isolated-model',
    base_url: 'https://qa.invalid/v1',
    text_model_profiles: {
      ...initialConfig.text_model_profiles,
      custom: {
        ...initialConfig.text_model_profiles.custom,
        api_key: 'qa-isolated-key',
        model_name: 'qa-isolated-model',
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
  handle('app:get-version', () => '0.2.0-brand-test');
  handle('license:get-status', () => ({ status: 'valid', sourceTrusted: true, plan: 'test', config: {} }));
  handle('agent:get-status', () => ({ status: 'idle' }));
  handle('agent:get-pending-question', () => null);
  handle('auto-confirmation:get-state', () => ({ enabled: false }));
  handle('auto-confirmation:set-enabled', (_event, enabled) => ({ enabled: Boolean(enabled) }));
  handle('tasks:get-active', () => []);
  handle('templates:list', () => []);
  handle('templates:get', (_event, templateId) => templateId === 'qa-template' ? { template_id: templateId, template_name: 'QA 模板' } : null);
  handle('system-fonts:list', () => ['Microsoft YaHei']);

  handle('technical-plan:load-state', () => {
    technicalPlanLoads += 1;
    return structuredClone(technicalPlanState);
  });
  handle('technical-plan:load-generation-config', () => structuredClone(technicalPlanState));
  handle('technical-plan:import-tender-document', () => {
    importTenderCalls += 1;
    return { success: false, message: '已取消选择' };
  });
  handle('technical-plan:update-step', (_event, step) => {
    technicalPlanState.step = step;
    return { success: true };
  });
  handle('technical-plan:save-generation-config', () => structuredClone(technicalPlanState));
  handle('technical-plan:read-tender-markdown', () => ({ markdown: '# QA 招标文件' }));
  handle('technical-plan:read-tender-source-markdown', () => ({ markdown: '# QA 招标文件' }));
  handle('technical-plan:preview-content-word', () => previewDocxBytes);

  handle('feasibility-report:load-state', () => ({
    step: 'materials', sourceFiles: [], analysisMarkdown: '', outlineTemplate: 'government', targetWords: 30_000,
    referenceDocumentIds: [], keyParametersMarkdown: '', outlineData: null,
    projectInfo: { projectName: '', constructionUnit: '', location: '', industry: '', investmentAmount: '', constructionPeriod: '', projectBackground: '', constructionScale: '', constructionContent: '', expectedBenefits: '', otherRequirements: '' },
  }));

  handle('knowledge-base:list', () => ({ folders: [], documents: [] }));
  handle('knowledge-base:search', () => ({ items: [], total: 0, page: 1, pageSize: 20 }));
  handle('credential-library:load', () => emptyCredentialSnapshot());
  handle('plugins:getAvailablePlugins', () => []);

  handle('duplicate-check:load-state', () => ({
    tenderFile: null, tenderFiles: [], bidFiles: [], step: 'upload', activeAnalysisTab: 'metadata',
  }));
  handle('rejection-check:load-state', () => ({
    step: 'documents', tenderDocument: null, tenderDocuments: [], bidDocuments: [],
    activeDocumentTab: 'tender', activeResultTab: 'analysis', activeCheckResultTab: 'rejection',
    customCheckItems: [], checkOptions: {},
  }));
  handle('rejection-check:save-ui-state', () => ({ success: true }));
  handle('rejection-check:update-state', () => ({ success: true }));
  handle('blind-check:load-state', () => ({
    step: 'upload', presetTab: 'page', resultTab: 'all', file: null, presetId: '', useCredentialWords: false,
    aiReviewEnabled: true, fixAiEnabled: true, result: { status: 'idle', groups: [] },
    review: { status: 'idle' }, issues: [], fixRules: [], fixResult: { status: 'idle', groups: [] },
  }));
  handle('blind-check:list-presets', () => []);
  handle('blind-check:get-credential-words', () => []);
  handle('blind-check:get-tender-sources', () => null);
  handle('blind-check:save-ui-state', () => ({ success: true }));
}

function assertStaticBrandContract() {
  const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
  const index = read('index.html');
  const packageJson = JSON.parse(read('package.json'));
  const main = read('electron/main.cjs');
  const sidebar = read('src/components/Sidebar.tsx');
  const preload = read('electron/preload.cjs');
  const svg = read('assets/bidxu-mark.svg');

  assert.match(index, /<title>标序<\/title>/, '网页标题未切换为标序');
  assert.match(index, /bidxu-mark\.svg/, '网页图标没有指向标序品牌资源');
  assert.equal(packageJson.build.productName, '标序');
  assert.match(packageJson.description, /标序 BIDXU/);
  assert.match(main, /app\.setName\(['"]标序['"]\)/, 'Electron 应用名未切换为标序');
  assert.match(main, /bidxu-icon\.ico/, 'Windows 主窗口图标未切换为标序图标');
  assert.match(sidebar, /<strong>标序<\/strong>[\s\S]*?<span>BIDXU<\/span>/, '侧栏品牌不是标序 / BIDXU');
  assert.match(preload, /appName:\s*['"]标序['"]/, 'preload 暴露的应用名仍不是标序');

  // 内部桥接和自定义资源协议是稳定接口，品牌改造不能顺手改名破坏兼容。
  assert.match(preload, /exposeInMainWorld\(['"]yibiao['"]/);
  assert.match(main, /yibiao-asset/);
  assert.match(main, /OpenBidKit-TouBiaoBao/, '必须保留已有 userData 目录以免用户配置丢失');

  assert.match(svg, /viewBox="0 0 128 128"/);
  assert.doesNotMatch(svg, /易标|投标宝/);
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    const filePath = path.join(root, 'assets', `bidxu-icon-${size}.png`);
    const image = nativeImage.createFromPath(filePath);
    assert.equal(image.isEmpty(), false, `${size}px 品牌 PNG 无法读取`);
    assert.deepEqual(image.getSize(), { width: size, height: size }, `${size}px 品牌 PNG 尺寸错误`);
  }
  for (const fileName of ['bidxu-icon.ico', 'bidxu-icon.icns']) {
    const stat = fs.statSync(path.join(root, 'assets', fileName));
    assert.ok(stat.size > 1024, `${fileName} 不是有效的非空图标资源`);
  }

  const previewScript = fs.readFileSync(path.join(workspaceRoot, '开发预览-标序.cmd'), 'utf8');
  assert.match(previewScript, /dist\\index\.html/);
  assert.match(previewScript, /electron\\dist\\electron\.exe/);
  assert.match(previewScript, /ELECTRON_RUN_AS_NODE=/);
  assert.match(previewScript, /ELECTRON_RENDERER_URL=/);
  assert.match(previewScript, /Get-CimInstance Win32_Process/);
  assert.match(previewScript, /不执行打包/);
  assert.doesNotMatch(previewScript, /npm\s+run\s+dist|electron-builder|Remove-Item|taskkill/i, '开发预览入口不得打包、删除或强退现有窗口');
}

async function clickButtonByText(webContents, text) {
  await waitFor(webContents, `[...document.querySelectorAll('button')].some((button) => button.textContent.includes(${JSON.stringify(text)}))`, `找不到按钮“${text}”`);
  await webContents.executeJavaScript(`[...document.querySelectorAll('button')].find((button) => button.textContent.includes(${JSON.stringify(text)})).click()`);
}

async function clickTopNav(webContents, label) {
  await waitFor(webContents, `document.querySelector('button[aria-label=${JSON.stringify(label)}]')`, `找不到一级导航“${label}”`);
  await webContents.executeJavaScript(`document.querySelector('button[aria-label=${JSON.stringify(label)}]').click()`);
  await delay(100);
}

async function openSecondary(webContents, parent, child, selector) {
  await clickTopNav(webContents, parent);
  await waitFor(webContents, `[...document.querySelectorAll('.secondary-menu-row')].some((button) => button.textContent.includes(${JSON.stringify(child)}))`, `“${parent}”下找不到“${child}”`);
  await webContents.executeJavaScript(`[...document.querySelectorAll('.secondary-menu-row')].find((button) => button.textContent.includes(${JSON.stringify(child)})).click()`);
  await waitFor(webContents, `document.querySelector(${JSON.stringify(selector)})`, `“${child}”页面未渲染 ${selector}`);
  await delay(120);
}

async function assertVisibleBrand(webContents, context) {
  const snapshot = await webContents.executeJavaScript(`({
    title: document.title,
    body: document.body.innerText,
    brand: document.querySelector('.brand-copy')?.innerText || '',
    dialogs: document.querySelectorAll('[role="dialog"]').length,
  })`);
  assert.equal(snapshot.title, '标序', `${context} 的 document.title 不正确`);
  assert.match(snapshot.brand, /标序[\s\S]*BIDXU/, `${context} 侧栏品牌缺失`);
  assert.doesNotMatch(snapshot.body, /易标|投标宝/, `${context} 仍显示旧品牌`);
  return snapshot;
}

async function auditLayout(webContents, context) {
  const result = await webContents.executeJavaScript(`(() => {
    const shell = document.querySelector('.content-shell');
    const sidebar = document.querySelector('.sidebar');
    const page = document.querySelector('.project-home-page, .technical-workbench, .knowledge-page, .credential-library-page, .plugins-page, .resources-page, .duplicate-check-page, .rejection-check-page, .blind-check-page, .template-library-page, .settings-page');
    if (!shell || !sidebar || !page) return null;
    const shellRect = shell.getBoundingClientRect();
    const pageRect = page.getBoundingClientRect();
    const dock = page.querySelector(':scope > .floating-toolbar-dock');
    const toolbar = dock?.querySelector('.floating-toolbar');
    const contentRects = dock ? [...page.children]
      .filter((child) => child !== dock)
      .map((child) => child.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0) : [];
    const toolbarRect = toolbar?.getBoundingClientRect();
    const overlap = toolbarRect ? contentRects.reduce((max, rect) => Math.max(max,
      Math.max(0, Math.min(rect.bottom, toolbarRect.bottom) - Math.max(rect.top, toolbarRect.top))
      * Math.max(0, Math.min(rect.right, toolbarRect.right) - Math.max(rect.left, toolbarRect.left))), 0) : 0;
    if (toolbar) toolbar.scrollLeft = Math.max(0, toolbar.scrollWidth - toolbar.clientWidth);
    const sidebarCopies = [...sidebar.querySelectorAll('.nav-copy, .settings-copy')]
      .filter((copy) => copy.getClientRects().length > 0)
      .map((copy) => {
        const strong = copy.querySelector('strong');
        const small = copy.querySelector('small');
        return {
          title: strong?.textContent?.trim() || '',
          description: small?.textContent?.trim() || '',
          descriptionDisplay: small ? getComputedStyle(small).display : '',
          titleFits: !strong || strong.scrollWidth <= strong.clientWidth + 1,
          descriptionFits: !small || (small.scrollWidth <= small.clientWidth + 1 && small.scrollHeight <= small.clientHeight + 1),
        };
      });
    const stages = page.querySelector('.technical-workflow-stages');
    const stageButtons = stages ? [...stages.querySelectorAll('.technical-workflow-stage')] : [];
    let stageAccess = null;
    if (stages && stageButtons.length) {
      const originalScrollLeft = stages.scrollLeft;
      const stagesRect = stages.getBoundingClientRect();
      const activeRect = stages.querySelector('.technical-workflow-stage.is-active')?.getBoundingClientRect();
      const activeVisibleByDefault = !activeRect || (activeRect.left >= stagesRect.left - 1 && activeRect.right <= stagesRect.right + 1);
      stages.scrollLeft = 0;
      const firstRect = stageButtons[0].getBoundingClientRect();
      stages.scrollLeft = Math.max(0, stages.scrollWidth - stages.clientWidth);
      const lastRect = stageButtons.at(-1).getBoundingClientRect();
      const copies = stageButtons.map((button) => ({
        title: button.querySelector('strong')?.textContent?.trim() || '',
        titleSize: Number.parseFloat(getComputedStyle(button.querySelector('strong')).fontSize),
        detailSize: Number.parseFloat(getComputedStyle(button.querySelector('small')).fontSize),
        titleFits: button.querySelector('strong').scrollWidth <= button.querySelector('strong').clientWidth + 1,
        detailFits: button.querySelector('small').scrollWidth <= button.querySelector('small').clientWidth + 1,
      }));
      stageAccess = {
        firstReachable: firstRect.left >= stagesRect.left - 1 && firstRect.right <= stagesRect.right + 1,
        lastReachable: lastRect.left >= stagesRect.left - 1 && lastRect.right <= stagesRect.right + 1,
        activeVisibleByDefault,
        atEnd: Math.abs(stages.scrollLeft - Math.max(0, stages.scrollWidth - stages.clientWidth)) <= 1,
        copies,
      };
      // 首尾可达性检查不能污染下一视口的“默认可见”状态。
      stages.scrollLeft = originalScrollLeft;
    }
    const dockStyle = dock ? getComputedStyle(dock) : null;
    const toolbarStyle = toolbar ? getComputedStyle(toolbar) : null;
    const outlineWorkspace = page.querySelector('.outline-generation-workspace');
    let outlineWorkspaceAccess = null;
    if (outlineWorkspace) {
      const originalScrollLeft = outlineWorkspace.scrollLeft;
      const workspaceRect = outlineWorkspace.getBoundingClientRect();
      const panels = [...outlineWorkspace.children].filter((node) => node.getClientRects().length > 0);
      outlineWorkspace.scrollLeft = 0;
      const firstPanelRect = panels[0]?.getBoundingClientRect();
      outlineWorkspace.scrollLeft = Math.max(0, outlineWorkspace.scrollWidth - outlineWorkspace.clientWidth);
      const lastPanelRect = panels.at(-1)?.getBoundingClientRect();
      outlineWorkspaceAccess = {
        firstReachable: !firstPanelRect || (firstPanelRect.left >= workspaceRect.left - 1 && firstPanelRect.right <= workspaceRect.right + 1),
        lastReachable: !lastPanelRect || (lastPanelRect.left >= workspaceRect.left - 1 && lastPanelRect.right <= workspaceRect.right + 1),
        atEnd: Math.abs(outlineWorkspace.scrollLeft - Math.max(0, outlineWorkspace.scrollWidth - outlineWorkspace.clientWidth)) <= 1,
      };
      outlineWorkspace.scrollLeft = originalScrollLeft;
    }
    return {
      shell: { left: shellRect.left, top: shellRect.top, right: shellRect.right, bottom: shellRect.bottom },
      page: { left: pageRect.left, top: pageRect.top, right: pageRect.right, bottom: pageRect.bottom },
      bodyScrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      bodyScrollY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      pageChildren: [...page.children].map((child) => {
        const rect = child.getBoundingClientRect();
        return { className: child.className, top: rect.top, bottom: rect.bottom, height: rect.height };
      }),
      pageInsideShell: pageRect.left >= shellRect.left - 1 && pageRect.top >= shellRect.top - 1
        && pageRect.right <= shellRect.right + 1 && pageRect.bottom <= shellRect.bottom + 1,
      dockInsidePage: !dock || (dock.getBoundingClientRect().bottom <= pageRect.bottom + 1 && dock.getBoundingClientRect().left >= pageRect.left - 1),
      toolbarOverlapArea: overlap,
      toolbarEndReachable: !toolbar || Math.abs(toolbar.scrollLeft - Math.max(0, toolbar.scrollWidth - toolbar.clientWidth)) <= 1,
      sidebarWidth: sidebar.getBoundingClientRect().width,
      sidebarCopies,
      stageAccess,
      outlineWorkspaceAccess,
      floatingCard: !dock ? null : {
        dockRect: (() => { const rect = dock.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, height: rect.height }; })(),
        dockBackground: dockStyle.backgroundColor,
        dockBorderTop: dockStyle.borderTopWidth,
        dockShadow: dockStyle.boxShadow,
        toolbarBackground: toolbarStyle.backgroundColor,
        toolbarRadius: Number.parseFloat(toolbarStyle.borderRadius),
        toolbarShadow: toolbarStyle.boxShadow,
        toolbarPosition: toolbarStyle.position,
        toolbarWidth: toolbarRect.width,
        dockWidth: dock.getBoundingClientRect().width,
      },
    };
  })()`);
  assert.ok(result, `${context} 缺少内容壳层或页面根节点`);
  assert.equal(result.pageInsideShell, true, `${context} 页面越出内容壳层：${JSON.stringify(result)}`);
  assert.ok(result.bodyScrollX <= 1 && result.bodyScrollY <= 1, `${context} 出现窗口级滚动，应使用页面内部滚动：${JSON.stringify(result)}`);
  assert.equal(result.dockInsidePage, true, `${context} 底部工具条越出页面：${JSON.stringify(result)}`);
  assert.equal(result.toolbarOverlapArea, 0, `${context} 底部工具条覆盖正文`);
  assert.equal(result.toolbarEndReachable, true, `${context} 窄屏工具条末项不可达`);
  assert.ok(result.sidebarWidth >= 220, `${context} 展开侧栏宽度不足：${result.sidebarWidth}`);
  for (const copy of result.sidebarCopies) {
    assert.notEqual(copy.descriptionDisplay, 'none', `${context} 侧栏说明被隐藏：${copy.title}`);
    assert.equal(copy.titleFits, true, `${context} 侧栏标题被截断：${copy.title}`);
    assert.equal(copy.descriptionFits, true, `${context} 侧栏说明被截断：${copy.description}`);
  }
  if (result.stageAccess) {
    assert.equal(result.stageAccess.firstReachable, true, `${context} 顶部第一阶段不可达`);
    assert.equal(result.stageAccess.lastReachable, true, `${context} 顶部最后阶段不可滚动到达`);
    assert.equal(result.stageAccess.activeVisibleByDefault, true, `${context} 当前阶段默认不可见`);
    assert.equal(result.stageAccess.atEnd, true, `${context} 顶部步骤条无法滚到末端`);
    for (const copy of result.stageAccess.copies) {
      assert.ok(copy.titleSize >= 15, `${context} 顶部步骤标题字号过小：${JSON.stringify(copy)}`);
      assert.ok(copy.detailSize >= 12, `${context} 顶部步骤说明字号过小：${JSON.stringify(copy)}`);
      assert.equal(copy.titleFits, true, `${context} 顶部步骤标题被截断：${copy.title}`);
      assert.equal(copy.detailFits, true, `${context} 顶部步骤说明被截断：${copy.title}`);
    }
  }
  if (result.outlineWorkspaceAccess) {
    assert.equal(result.outlineWorkspaceAccess.firstReachable, true, `${context} 目录工作区首栏不可达`);
    assert.equal(result.outlineWorkspaceAccess.lastReachable, true, `${context} 目录工作区末栏不可横向到达`);
    assert.equal(result.outlineWorkspaceAccess.atEnd, true, `${context} 目录工作区无法滚至末栏`);
  }
  if (result.floatingCard) {
    assert.equal(result.floatingCard.dockBackground, 'rgba(0, 0, 0, 0)', `${context} dock 不应绘制全宽背景`);
    assert.equal(result.floatingCard.dockBorderTop, '0px', `${context} dock 不应绘制全宽顶边线`);
    assert.equal(result.floatingCard.dockShadow, 'none', `${context} dock 不应绘制全宽阴影`);
    assert.notEqual(result.floatingCard.toolbarBackground, 'rgba(0, 0, 0, 0)', `${context} 浮动卡片缺少实体底色`);
    assert.ok(result.floatingCard.toolbarRadius >= 12, `${context} 浮动卡片圆角不足`);
    assert.notEqual(result.floatingCard.toolbarShadow, 'none', `${context} 浮动卡片缺少阴影`);
    assert.ok(!['fixed', 'absolute'].includes(result.floatingCard.toolbarPosition), `${context} 浮动卡片脱离布局流`);
    assert.ok(result.floatingCard.toolbarWidth <= result.floatingCard.dockWidth + 1, `${context} 浮动卡片越出 dock`);
  }
}

async function saveScreenshot(webContents, name) {
  fs.mkdirSync(artifactDir, { recursive: true });
  // 隐藏窗口的合成帧会比 DOM 更新慢一拍；等待稳定帧并保持隐藏捕获，避免截到前一条路由。
  webContents.invalidate();
  await webContents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  await delay(300);
  const image = await webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
  assert.equal(image.isEmpty(), false, `${name} 截图为空`);
  fs.writeFileSync(path.join(artifactDir, name), image.toPNG());
}

async function setViewport(webContents, width, height, zoomFactor) {
  windowUnderTest.setSize(width, height);
  webContents.setZoomFactor(zoomFactor);
  await delay(180);
}

async function auditThreeViewports(webContents, context) {
  const viewports = [
    { width: 1280, height: 800, zoom: 1, label: '1280x800' },
    { width: 1024, height: 640, zoom: 1, label: '1024x640' },
    { width: 1024, height: 640, zoom: 1.25, label: '1024x640@125%' },
    { width: 1280, height: 720, zoom: 1.5, label: '1280x720@150%' },
    { width: 1280, height: 800, zoom: 1.5, label: '1280x800@150%' },
  ];
  for (const viewport of viewports) {
    await setViewport(webContents, viewport.width, viewport.height, viewport.zoom);
    await auditLayout(webContents, `${context} ${viewport.label}`);
  }
  await setViewport(webContents, 1280, 800, 1);
}

async function auditOutlineReadability(webContents) {
  const result = await webContents.executeJavaScript(`(() => {
    const head = document.querySelector('.outline-tree-head');
    const titleBlock = head?.querySelector(':scope > div:first-child');
    const title = titleBlock?.querySelector('strong');
    const summary = titleBlock?.querySelector('span');
    const tools = head?.querySelector('.outline-tree-tools');
    const buttons = tools ? [...tools.querySelectorAll('button')] : [];
    const stages = document.querySelector('.technical-workflow-stages');
    const stageButtons = stages ? [...stages.querySelectorAll('.technical-workflow-stage')] : [];
    if (!head || !titleBlock || !title || !summary || !tools || !buttons.length || !stages || stageButtons.length !== 4) return null;

    const originalToolsScroll = tools.scrollLeft;
    const toolsRect = tools.getBoundingClientRect();
    tools.scrollLeft = 0;
    const firstButtonRect = buttons[0].getBoundingClientRect();
    tools.scrollLeft = Math.max(0, tools.scrollWidth - tools.clientWidth);
    const lastButtonRect = buttons.at(-1).getBoundingClientRect();
    tools.scrollLeft = originalToolsScroll;

    const stagesRect = stages.getBoundingClientRect();
    const firstStageRect = stageButtons[0].getBoundingClientRect();
    const lastStageRect = stageButtons.at(-1).getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    const summaryRect = summary.getBoundingClientRect();
    return {
      titleWidth: titleRect.width,
      summaryWidth: summaryRect.width,
      titleFits: title.scrollWidth <= title.clientWidth + 1,
      summaryFits: summary.scrollWidth <= summary.clientWidth + 1,
      firstButtonReachable: firstButtonRect.left >= toolsRect.left - 1 && firstButtonRect.right <= toolsRect.right + 1,
      lastButtonReachable: lastButtonRect.left >= toolsRect.left - 1 && lastButtonRect.right <= toolsRect.right + 1,
      toolsAtEnd: Math.abs(tools.scrollLeft - originalToolsScroll) <= 1,
      allStagesVisible: stages.scrollWidth <= stages.clientWidth + 1
        && firstStageRect.left >= stagesRect.left - 1
        && lastStageRect.right <= stagesRect.right + 1,
    };
  })()`);
  assert.ok(result, `1280x800 目录页缺少标题、操作区或四阶段：${JSON.stringify(result)}`);
  assert.ok(result.titleWidth >= 72 && result.summaryWidth >= 72,
    `1280x800 目录标题区被压成逐字窄列：${JSON.stringify(result)}`);
  assert.equal(result.titleFits, true, `1280x800 “目录结构”标题被裁切：${JSON.stringify(result)}`);
  assert.equal(result.summaryFits, true, `1280x800 一级目录统计被裁切：${JSON.stringify(result)}`);
  assert.equal(result.firstButtonReachable, true, `1280x800 目录首操作不可达：${JSON.stringify(result)}`);
  assert.equal(result.lastButtonReachable, true, `1280x800 目录末操作不可达：${JSON.stringify(result)}`);
  assert.equal(result.toolsAtEnd, true, `目录操作可达性检查没有恢复滚动状态：${JSON.stringify(result)}`);
  assert.equal(result.allStagesVisible, true, `1280x800 顶部四阶段不能同屏完整显示：${JSON.stringify(result)}`);
}

async function run() {
  assertStaticBrandContract();
  previewDocxBytes = await buildPreviewDocx();
  installHarnessIpc();
  windowUnderTest = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    backgroundColor: '#f4f8ff',
    webPreferences: {
      preload: path.join(root, 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
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

  await waitFor(webContents, `document.querySelector('.project-home-page') && !document.body.innerText.includes('正在读取本地工作区')`, '空状态首页未完成真实状态读取');
  const emptyHome = await webContents.executeJavaScript(`({ body: document.body.innerText, dialogs: document.querySelectorAll('[role="dialog"]').length })`);
  assert.match(emptyHome.body, /尚未导入招标文件/);
  assert.match(emptyHome.body, /首页不会生成演示项目或虚构进度/);
  assert.doesNotMatch(emptyHome.body, /QA-真实状态-2026|80,235|QA-RUNNING-LOG-37/);
  assert.equal(emptyHome.dialogs, 0, '新首页空状态不应主动弹窗');
  await assertVisibleBrand(webContents, '空状态首页');
  await auditThreeViewports(webContents, '空状态首页');
  await saveScreenshot(webContents, 'home-empty-1280x800.png');

  await clickButtonByText(webContents, '选择文件');
  await delay(100);
  assert.equal(importTenderCalls, 1, '首页“选择文件”没有调用真实 importTenderDocument IPC');

  technicalPlanState = richTechnicalPlanState();
  webContents.reload();
  await waitFor(webContents, `document.querySelector('#project-home-title') && document.body.innerText.includes('QA-真实状态-2026.docx')`, '真实工作区状态未回填首页');
  const richHome = await webContents.executeJavaScript(`document.body.innerText`);
  assert.match(richHome, /QA-真实状态-2026\.docx/);
  assert.match(richHome, /2\s*份文件\s*·\s*80,235\s*字/);
  assert.match(richHome, /投标范围：第一标段/);
  assert.match(richHome, /正文生成/);
  assert.match(richHome, /QA-RUNNING-LOG-37/);
  const progressLabel = await webContents.executeJavaScript(`document.querySelector('[aria-label="正文生成进度 37%"]')?.getAttribute('aria-label') || ''`);
  assert.equal(progressLabel, '正文生成进度 37%', '首页没有用真实任务进度渲染 ProgressBar');
  await saveScreenshot(webContents, 'home-workspace-1280x800.png');

  // 非技术标事件必须忽略；持续技术标进度事件要按固定窗口周期刷新，不能因 trailing debounce 永远推迟。
  const nonTechnicalBaseline = technicalPlanLoads;
  for (let index = 0; index < 8; index += 1) {
    webContents.send('tasks:event', { task: { type: 'duplicate-analysis', status: 'running', progress: index } });
  }
  await delay(850);
  assert.equal(technicalPlanLoads, nonTechnicalBaseline, '非技术标任务事件不应触发首页 loadState');
  const technicalBaseline = technicalPlanLoads;
  for (let index = 0; index < 20; index += 1) {
    webContents.send('tasks:event', { task: { type: 'content-generation', status: 'running', progress: index } });
    await delay(100);
  }
  await delay(850);
  const technicalRefreshes = technicalPlanLoads - technicalBaseline;
  assert.ok(technicalRefreshes >= 2 && technicalRefreshes <= 4,
    `持续2秒技术标事件应周期合并刷新2-4次，实际 ${technicalRefreshes} 次`);

  // 业务主路由必须仍可达；每次进入都验证品牌和页面根节点。
  await clickButtonByText(webContents, '继续技术标编制');
  await waitFor(webContents, `document.querySelector('.technical-workbench')`, '技术标工作台不可达');
  await assertVisibleBrand(webContents, '技术标工作台');
  await auditThreeViewports(webContents, '技术标工作台');

  await clickTopNav(webContents, '项目');
  await waitFor(webContents, `document.querySelector('.project-home-page')`, '项目首页不可达');
  technicalPlanState = { ...richTechnicalPlanState(), step: 'document-analysis', contentGenerationTask: undefined };
  await clickButtonByText(webContents, '继续技术标编制');
  await waitFor(webContents, `document.querySelector('.document-analysis-page')`, '招标文件上传步骤不可达');
  await auditThreeViewports(webContents, '招标文件上传步骤');

  await clickTopNav(webContents, '项目');
  await waitFor(webContents, `document.querySelector('.project-home-page')`, '目录测试返回项目首页失败');
  technicalPlanState = completedTechnicalPlanState();
  technicalPlanState.step = 'outline-generation';
  await clickButtonByText(webContents, '继续技术标编制');
  await waitFor(webContents, `document.querySelector('.outline-generation-page')`, '目录步骤不可达');
  await auditThreeViewports(webContents, '目录步骤');
  await auditOutlineReadability(webContents);
  await saveScreenshot(webContents, 'outline-1280x800.png');
  await setViewport(webContents, 1424, 880, 1);
  await saveScreenshot(webContents, 'outline-1424x880.png');
  await setViewport(webContents, 1280, 800, 1);

  await clickTopNav(webContents, '项目');
  await waitFor(webContents, `document.querySelector('.project-home-page')`, '可研测试返回项目首页失败');
  await clickButtonByText(webContents, '可行性研究报告');
  await waitFor(webContents, `document.querySelector('.technical-workbench')`, '可研报告工作台不可达');
  await assertVisibleBrand(webContents, '可研报告工作台');
  await auditThreeViewports(webContents, '可研报告工作台');

  const routes = [
    ['资料库', '文档知识库', '.knowledge-page'],
    ['资料库', '资信库', '.credential-library-page'],
    ['资料库', '插件管理', '.plugins-page'],
    ['资料库', '精选资源', '.resources-page'],
    ['标书检查', '标书查重', '.duplicate-check-page'],
    ['标书检查', '废标项检查', '.rejection-check-page'],
    ['标书检查', '暗标合规检查', '.blind-check-page'],
  ];
  for (const [parent, child, selector] of routes) {
    await openSecondary(webContents, parent, child, selector);
    await assertVisibleBrand(webContents, child);
    await auditThreeViewports(webContents, child);
  }
  const blindBody = await webContents.executeJavaScript(`document.querySelector('.blind-check-page')?.innerText || ''`);
  assert.match(blindBody, /选择标书|导入/);
  assert.match(blindBody, /AI 复核/);

  await clickTopNav(webContents, '模板');
  await waitFor(webContents, `document.querySelector('.template-library-page')`, '模板页不可达');
  await assertVisibleBrand(webContents, '模板页');
  await auditThreeViewports(webContents, '模板页');

  await clickTopNav(webContents, '设置');
  await waitFor(webContents, `document.querySelector('.settings-page')`, '设置页不可达');
  await assertVisibleBrand(webContents, '设置页');
  await auditThreeViewports(webContents, '设置页');
  // 精选资源页被测试主动断网后会留下错误 toast；显式关闭，仅为得到无测试噪声的设置页视觉证据。
  await webContents.executeJavaScript(`[...document.querySelectorAll('.app-toast-close')].forEach((button) => button.click())`);
  await waitFor(webContents, `!document.querySelector('.app-toast')`, '测试网络错误提示未能关闭');
  await saveScreenshot(webContents, 'settings-general-1280x800.png');

  technicalPlanState = completedTechnicalPlanState();
  await setViewport(webContents, 1280, 800, 1);
  await clickTopNav(webContents, '项目');
  await waitFor(webContents, `document.querySelector('.project-home-page')`, '完成态首页未渲染');
  await clickButtonByText(webContents, '继续技术标编制');
  await waitFor(webContents, `document.querySelector('.content-generation-page')`, '完整正文页未渲染');
  const contentBody = await webContents.executeJavaScript(`document.querySelector('.content-generation-page')?.innerText || ''`);
  assert.match(contentBody, /标书篇幅优化/);
  assert.match(contentBody, /重新执行 AI 去痕/);
  assert.match(contentBody, /1 项仍需人工复核/);
  const consistencyCard = await webContents.executeJavaScript(`(() => {
    const item = [...document.querySelectorAll('.content-assistant-card.is-checks li')]
      .find((node) => node.textContent.includes('事实一致性'));
    return item ? { className: item.className, text: item.textContent } : null;
  })()`);
  assert.ok(consistencyCard, '成稿检查没有事实一致性状态');
  assert.match(consistencyCard.className, /is-warning/, `存在 remaining_issues 时没有显示待复核警告：${JSON.stringify(consistencyCard)}`);
  assert.doesNotMatch(consistencyCard.className, /is-complete/, `存在 remaining_issues 时仍误显示绿色通过：${JSON.stringify(consistencyCard)}`);
  assert.match(consistencyCard.text, /1 项仍需人工复核/);
  await assertVisibleBrand(webContents, '完整正文页');
  await auditThreeViewports(webContents, '完整正文页');
  await saveScreenshot(webContents, 'content-edit-1280x800.png');

  const previewReload = await webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('.content-word-preview button')].find((node) => node.textContent.includes('重新加载'));
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(previewReload, true, '正文页没有可触发的 Word 预览重新加载入口');
  await waitFor(webContents, `document.querySelector('.content-word-editor')`, '测试 DOCX 未进入真实 Word 预览组件', 20_000);
  await waitFor(webContents, `document.querySelector('.content-word-editor') && !document.querySelector('.content-word-preview .content-word-status')`, '测试 DOCX 预览未完成解析', 20_000);
  const wordPreview = await webContents.executeJavaScript(`(() => {
    const host = document.querySelector('.content-word-editor');
    const preview = document.querySelector('.content-word-preview');
    if (!host || !preview) return null;
    const rect = host.getBoundingClientRect();
    const previewRect = preview.getBoundingClientRect();
    return {
      childCount: host.querySelectorAll('*').length,
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      inside: rect.left >= previewRect.left - 1 && rect.top >= previewRect.top - 1
        && rect.right <= previewRect.right + 1 && rect.bottom <= previewRect.bottom + 1,
    };
  })()`);
  assert.ok(wordPreview && wordPreview.childCount > 5, `Word 预览没有渲染实际页面节点：${JSON.stringify(wordPreview)}`);
  assert.equal(wordPreview.inside, true, `Word 纸面越出正文预览容器：${JSON.stringify(wordPreview)}`);
  await saveScreenshot(webContents, 'content-word-preview-1280x800.png');

  // 对话框必须挂在页面之上且不越出可视区。
  const optimizeButtonState = await webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('.content-assistant-panel button')].find((node) => node.textContent.trim() === '标书篇幅优化');
    return button ? { text: button.textContent.trim(), disabled: button.disabled, describedBy: button.getAttribute('aria-describedby'), reason: document.querySelector('#page-optimize-disabled-reason')?.textContent || '' } : null;
  })()`);
  assert.ok(optimizeButtonState, '正文助手缺少篇幅优化按钮');
  assert.equal(optimizeButtonState.disabled, false, `完整正文不应禁用篇幅优化：${JSON.stringify(optimizeButtonState)}`);
  await webContents.executeJavaScript(`[...document.querySelectorAll('.content-assistant-panel button')].find((button) => button.textContent.trim() === '标书篇幅优化').click()`);
  await waitFor(webContents, `document.querySelector('[role="dialog"]')`, '篇幅优化对话框未打开');
  const dialogGeometry = await webContents.executeJavaScript(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const rect = dialog.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight };
  })()`);
  assert.ok(dialogGeometry.left >= 0 && dialogGeometry.top >= 0 && dialogGeometry.right <= dialogGeometry.width + 1 && dialogGeometry.bottom <= dialogGeometry.height + 1,
    `篇幅优化对话框越出视口：${JSON.stringify(dialogGeometry)}`);
  await webContents.executeJavaScript(`[...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent.trim() === '取消')?.click()`);
  await waitFor(webContents, `!document.querySelector('[role="dialog"]')`, '篇幅优化对话框无法取消');
  const naturalizeButton = await webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('button')].find((node) => node.textContent.includes('重新执行 AI 去痕'));
    return button ? { disabled: button.disabled, text: button.textContent.trim() } : null;
  })()`);
  assert.ok(naturalizeButton, '正文助手缺少重新执行 AI 去痕入口');
  assert.equal(naturalizeButton.disabled, false, '完整正文不应禁用重新执行 AI 去痕');
  await webContents.executeJavaScript(`[...document.querySelectorAll('button')].find((button) => button.textContent.includes('重新执行 AI 去痕')).click()`);
  await waitFor(webContents, `document.querySelector('[role="dialog"]')?.textContent.includes('重新执行 AI 去痕')`, 'AI 去痕确认对话框未打开');

  console.log('check-branding-theme-ui: 通过');
  console.log(JSON.stringify({
    brand: '标序 / BIDXU', emptyHomeReal: true, richHomeReal: true, technicalEventRefreshes: technicalRefreshes,
    mainRoutes: routes.length + 5,
    viewports: ['1280x800', '1024x640', '1024x640@125%', '1280x720@150%', '1280x800@150%'],
    screenshots: fs.readdirSync(artifactDir).filter((name) => name.endsWith('.png')),
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
