const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const electron = require('electron');

if (!electron?.app || !electron?.BrowserWindow) {
  throw new Error('请使用 Electron 运行 check-startup-performance.cjs');
}

const root = path.resolve(__dirname, '..');
const mainPath = path.join(root, 'electron', 'main.cjs');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bidxu-startup-qa-'));
const bootstrapUserData = path.join(tempRoot, 'bootstrap-user-data');
fs.mkdirSync(bootstrapUserData, { recursive: true });
electron.app.setPath('userData', bootstrapUserData);

const startedAt = performance.now();
const startedEpoch = Date.now();
const timings = {
  startedEpoch,
  ipcIndexRequireMs: null,
  mainRequireMs: null,
  electronReadyMs: null,
  windowCreatedMs: null,
  registerIpcHandlersMs: null,
  domReadyMs: null,
  didFinishLoadMs: null,
  firstPaintMs: null,
  databaseCheckingMs: null,
  sqliteSetupStartedMs: null,
  sqliteSetupMs: null,
  databaseServicesMs: null,
  databaseReadyMs: null,
  firstContentMs: null,
  gateFirstMs: null,
  appShellFirstMs: null,
};
const observations = {
  consoleErrors: [],
  preloadErrors: [],
  renderProcessGone: [],
  unresponsive: 0,
  statusEvents: [],
  eventLoopDriftMs: [],
  rendererPerformance: null,
  rendererLoop: null,
  ipcRoundTrip: null,
  ipcSmoke: null,
  runtime: null,
};

const elapsed = () => Number((performance.now() - startedAt).toFixed(3));
let mainWindow = null;
let completed = false;
let rendererReady = false;
let pollInFlight = false;
let pollTimer = null;
let timeoutTimer = null;

let lastTick = performance.now();
const eventLoopTimer = setInterval(() => {
  const now = performance.now();
  observations.eventLoopDriftMs.push(Math.max(0, now - lastTick - 2));
  lastTick = now;
}, 2);

function percentile(values, percent) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((percent / 100) * sorted.length) - 1))];
}

function summary(values) {
  const normalized = values.filter(Number.isFinite);
  return {
    count: normalized.length,
    p50: Number(percentile(normalized, 50).toFixed(3)),
    p95: Number(percentile(normalized, 95).toFixed(3)),
    max: Number(Math.max(0, ...normalized).toFixed(3)),
  };
}

function recordConsoleMessage(...args) {
  const details = args.find((item) => item && typeof item === 'object' && 'message' in item);
  const level = details?.level || args[1];
  const message = String(details?.message || args[2] || '');
  if (level === 'error' || /No handler registered|Error invoking remote method|preload|unhandled/i.test(message)) {
    observations.consoleErrors.push(message);
  }
}

async function collectRendererMetrics() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const webContents = mainWindow.webContents;
  observations.rendererPerformance = await webContents.executeJavaScript(`(() => {
    const navigation = performance.getEntriesByType('navigation')[0];
    const paint = performance.getEntriesByType('paint');
    const fcp = paint.find((entry) => entry.name === 'first-contentful-paint');
    return {
      timeOrigin: performance.timeOrigin,
      domInteractive: navigation?.domInteractive ?? null,
      domContentLoaded: navigation?.domContentLoadedEventEnd ?? null,
      loadEventEnd: navigation?.loadEventEnd ?? null,
      firstContentfulPaint: fcp?.startTime ?? null,
      bodyTextLength: document.body?.innerText?.length || 0,
      hasGate: Boolean(document.querySelector('.workspace-database-gate')),
      hasAppShell: Boolean(document.querySelector('.app-shell')),
    };
  })()`);

  observations.rendererLoop = await webContents.executeJavaScript(`(async () => {
    const samples = [];
    for (let index = 0; index < 100; index += 1) {
      const started = performance.now();
      await new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(index);
      });
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const pick = (percent) => samples[Math.min(samples.length - 1, Math.ceil(samples.length * percent) - 1)];
    return { count: samples.length, p50: pick(0.5), p95: pick(0.95), max: samples.at(-1) };
  })()`);

  observations.ipcRoundTrip = await webContents.executeJavaScript(`(async () => {
    const samples = [];
    for (let index = 0; index < 20; index += 1) {
      const started = performance.now();
      await window.yibiao.getVersion();
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const pick = (percent) => samples[Math.min(samples.length - 1, Math.ceil(samples.length * percent) - 1)];
    return { count: samples.length, p50: pick(0.5), p95: pick(0.95), max: samples.at(-1) };
  })()`);

  observations.ipcSmoke = await webContents.executeJavaScript(`(async () => {
    const checks = {};
    for (const [name, action] of Object.entries({
      version: () => window.yibiao.getVersion(),
      online: () => window.yibiao.requiredOnlineServices.getStatus(),
      database: () => window.yibiao.database.getStatus(),
      config: () => window.yibiao.config.load(),
      tasks: () => window.yibiao.tasks.getActiveTasks(),
    })) {
      try {
        await action();
        checks[name] = 'ok';
      } catch (error) {
        checks[name] = String(error?.message || error);
      }
    }
    return checks;
  })()`);
}

async function finish(error) {
  if (completed) return;
  completed = true;
  clearInterval(eventLoopTimer);
  clearInterval(pollTimer);
  clearTimeout(timeoutTimer);

  let finalError = error || null;
  if (!finalError) {
    try {
      const { getOpenXmlHelperDebugExecutablePath } = require('../electron/utils/paths.cjs');
      const debugHelperPath = getOpenXmlHelperDebugExecutablePath();
      observations.runtime = {
        executable: process.execPath,
        executableName: path.basename(process.execPath),
        isPackaged: electron.app.isPackaged,
        developmentRuntime: electron.app.isPackaged === false && path.basename(process.execPath).toLowerCase() === 'electron.exe',
        openXmlHelperPath: debugHelperPath,
        openXmlHelperExists: fs.existsSync(debugHelperPath),
      };
      await collectRendererMetrics();
      assert.ok(timings.ipcIndexRequireMs >= 0, '未记录 ipc/index 导入耗时');
      assert.ok(timings.registerIpcHandlersMs >= 0, '未记录同步 IPC/服务注册耗时');
      assert.ok(timings.sqliteSetupMs >= 0, '未记录 SQLite 初始化耗时');
      assert.ok(timings.databaseServicesMs >= timings.sqliteSetupMs, '数据库服务总耗时小于 SQLite 初始化耗时');
      assert.ok(timings.firstPaintMs !== null || observations.rendererPerformance?.firstContentfulPaint !== null, '未观察到 Renderer 首帧');
      assert.equal(observations.rendererPerformance?.hasAppShell, true, '数据库 ready 后没有渲染 AppShell');
      assert.ok(observations.rendererPerformance?.bodyTextLength > 0, '首屏正文为空');
      assert.equal(observations.preloadErrors.length, 0, `preload 错误：${observations.preloadErrors.join('；')}`);
      assert.equal(observations.renderProcessGone.length, 0, 'Renderer 异常退出');
      assert.equal(observations.unresponsive, 0, '主窗口曾进入 unresponsive');
      assert.deepEqual(Object.values(observations.ipcSmoke || {}), ['ok', 'ok', 'ok', 'ok', 'ok']);
      assert.equal(observations.runtime.developmentRuntime, true, '开发启动器被误判为安装包运行时');
      assert.equal(observations.runtime.openXmlHelperExists, true, `开发 OpenXML Helper 不存在：${debugHelperPath}`);
      assert.match(observations.runtime.openXmlHelperPath, /[/\\]bin[/\\]Debug[/\\]net10\.0[/\\]OpenXmlHelper(?:\.exe)?$/i,
        `开发态没有选择 Debug OpenXML Helper：${observations.runtime.openXmlHelperPath}`);
      assert.equal(observations.consoleErrors.some((message) => /No handler registered|Error invoking remote method/i.test(message)), false,
        `发现首屏 IPC 缺失：${observations.consoleErrors.join('；')}`);
    } catch (assertionError) {
      finalError = assertionError;
    }
  }

  const result = {
    ok: !finalError,
    error: finalError ? String(finalError.stack || finalError) : null,
    isolation: {
      tempRoot,
      actualUserData: electron.app.getPath('userData'),
      realUserDataUntouched: electron.app.getPath('userData').startsWith(tempRoot),
      network: 'offline-stubbed',
      window: 'hidden-offscreen',
    },
    timings,
    eventLoop: summary(observations.eventLoopDriftMs),
    observations,
  };
  process.stdout.write(`check-startup-performance: ${result.ok ? '通过' : '失败'}\n${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;

  setTimeout(() => electron.app.exit(result.ok ? 0 : 1), 50);
}

const realElectron = electron;
const appProxy = new Proxy(realElectron.app, {
  get(target, property) {
    if (property === 'getPath') {
      return (name) => (name === 'appData' ? tempRoot : target.getPath(name));
    }
    if (property === 'setPath') {
      return (name, value) => {
        if (name === 'userData') {
          const requestedName = path.basename(String(value || 'OpenBidKit-TouBiaoBao')) || 'OpenBidKit-TouBiaoBao';
          const isolated = path.join(tempRoot, requestedName);
          fs.mkdirSync(isolated, { recursive: true });
          return target.setPath(name, isolated);
        }
        return target.setPath(name, value);
      };
    }
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

const netProxy = new Proxy(realElectron.net, {
  get(target, property) {
    if (property === 'fetch') {
      return async () => { throw new Error('QA_OFFLINE_NETWORK'); };
    }
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

const BrowserWindowProxy = new Proxy(realElectron.BrowserWindow, {
  construct(target, args) {
    const options = { ...(args[0] || {}) };
    options.show = false;
    options.webPreferences = {
      ...(options.webPreferences || {}),
      backgroundThrottling: false,
      offscreen: true,
    };
    const win = Reflect.construct(target, [options], target);
    if (!mainWindow && options.title === '标序') {
      mainWindow = win;
      timings.windowCreatedMs = elapsed();
      win.webContents.session.webRequest.onBeforeRequest(
        { urls: ['http://*/*', 'https://*/*'] },
        (_details, callback) => callback({ cancel: true }),
      );
      win.webContents.on('paint', () => {
        if (timings.firstPaintMs === null) timings.firstPaintMs = elapsed();
      });
      win.webContents.on('dom-ready', () => {
        if (timings.domReadyMs === null) timings.domReadyMs = elapsed();
        rendererReady = true;
      });
      win.webContents.on('did-finish-load', () => {
        if (timings.didFinishLoadMs === null) timings.didFinishLoadMs = elapsed();
      });
      win.webContents.on('console-message', (_event, ...messageArgs) => recordConsoleMessage(...messageArgs));
      win.webContents.on('preload-error', (_event, preloadPath, preloadError) => {
        observations.preloadErrors.push(`${preloadPath}: ${preloadError?.message || preloadError}`);
      });
      win.webContents.on('render-process-gone', (_event, details) => observations.renderProcessGone.push(details));
      win.on('unresponsive', () => { observations.unresponsive += 1; });
      const originalSend = win.webContents.send.bind(win.webContents);
      win.webContents.send = (channel, ...sendArgs) => {
        if (channel === 'workspace-database:status') {
          const status = sendArgs[0] || {};
          observations.statusEvents.push({ atMs: elapsed(), phase: status.phase, ready: status.ready });
          if (status.phase === 'checking' && timings.databaseCheckingMs === null) timings.databaseCheckingMs = elapsed();
          if (status.phase === 'ready' && timings.databaseReadyMs === null) {
            timings.databaseReadyMs = elapsed();
            if (timings.sqliteSetupStartedMs !== null) {
              timings.databaseServicesMs = Number((timings.databaseReadyMs - timings.sqliteSetupStartedMs).toFixed(3));
            }
          }
        }
        return originalSend(channel, ...sendArgs);
      };
    }
    return win;
  },
  get(target, property) {
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

const electronProxy = {
  ...realElectron,
  app: appProxy,
  BrowserWindow: BrowserWindowProxy,
  net: netProxy,
};

global.fetch = async () => { throw new Error('QA_OFFLINE_NETWORK'); };

const originalLoad = Module._load;
Module._load = function instrumentedLoad(request, parent, isMain) {
  if (request === 'electron') return electronProxy;

  const before = performance.now();
  const loaded = originalLoad.call(this, request, parent, isMain);
  const duration = performance.now() - before;

  if (parent?.filename === mainPath && request === './ipc/index.cjs') {
    timings.ipcIndexRequireMs = Number(duration.toFixed(3));
    const originalRegister = loaded.registerIpcHandlers;
    return {
      ...loaded,
      registerIpcHandlers(options) {
        const started = performance.now();
        const result = originalRegister(options);
        timings.registerIpcHandlersMs = Number((performance.now() - started).toFixed(3));
        return result;
      },
    };
  }

  if (/[/\\]services[/\\]sqliteDatabase\.cjs$/.test(parent ? Module._resolveFilename(request, parent, isMain) : '')) {
    const originalCreate = loaded.createSqliteDatabase;
    if (typeof originalCreate === 'function') {
      return {
        ...loaded,
        createSqliteDatabase(app, options) {
          timings.sqliteSetupStartedMs = elapsed();
          const started = performance.now();
          const result = originalCreate(app, options);
          timings.sqliteSetupMs = Number((performance.now() - started).toFixed(3));
          return result;
        },
      };
    }
  }

  return loaded;
};

electron.app.whenReady().then(() => {
  timings.electronReadyMs = elapsed();
});

const mainRequireStarted = performance.now();
try {
  require(mainPath);
  timings.mainRequireMs = Number((performance.now() - mainRequireStarted).toFixed(3));
} catch (error) {
  void finish(error);
}

pollTimer = setInterval(async () => {
  if (completed || pollInFlight || !rendererReady || !mainWindow || mainWindow.isDestroyed()) return;
  pollInFlight = true;
  try {
    const firstContent = await mainWindow.webContents.executeJavaScript(`(() => ({
      hasGate: Boolean(document.querySelector('.workspace-database-gate')),
      hasAppShell: Boolean(document.querySelector('.app-shell')),
      bodyTextLength: document.body?.innerText?.length || 0,
    }))()`);
    if (firstContent.bodyTextLength > 0 && timings.firstContentMs === null) timings.firstContentMs = elapsed();
    if (firstContent.hasGate && timings.gateFirstMs === null) timings.gateFirstMs = elapsed();
    if (firstContent.hasAppShell && timings.appShellFirstMs === null) timings.appShellFirstMs = elapsed();
    if (firstContent.hasAppShell && timings.databaseReadyMs !== null) void finish();
  } catch {}
  finally { pollInFlight = false; }
}, 20);

timeoutTimer = setTimeout(() => {
  void finish(new Error('启动基线 30 秒内未达到数据库 ready + AppShell'));
}, 30_000);
