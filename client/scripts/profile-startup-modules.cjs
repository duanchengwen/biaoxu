const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { performance } = require('node:perf_hooks');

// Only load service definitions. Do not create stores, read the user's configuration, or call models.
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bidxu-startup-modules-'));
app.setPath('userData', profileDir);
const originalLoad = Module._load;
const stack = [];
const timings = new Map();
Module._load = function profileModule(request, parent, isMain) {
  const frame = { start: performance.now(), children: 0 };
  stack.push(frame);
  try {
    return originalLoad.call(this, request, parent, isMain);
  } finally {
    const elapsed = performance.now() - frame.start;
    stack.pop();
    if (stack.length) stack[stack.length - 1].children += elapsed;
    const name = String(request);
    const previous = timings.get(name) || { total: 0, self: 0, count: 0 };
    previous.total += elapsed;
    previous.self += Math.max(0, elapsed - frame.children);
    previous.count += 1;
    timings.set(name, previous);
  }
};

app.whenReady().then(async () => {
  const start = performance.now();
  require('../electron/ipc/index.cjs');
  const total = performance.now() - start;
  Module._load = originalLoad;
  let piProfile;
  if (process.argv.includes('--pi')) {
    let previous = performance.now();
    let maxTickMs = 0;
    const heartbeat = setInterval(() => {
      const now = performance.now();
      maxTickMs = Math.max(maxTickMs, now - previous);
      previous = now;
    }, 10);
    const piStart = performance.now();
    await require('../electron/services/pi/piSessionFactory.cjs').loadPiModules();
    maxTickMs = Math.max(maxTickMs, performance.now() - previous);
    await new Promise(resolve => setImmediate(resolve));
    clearInterval(heartbeat);
    piProfile = { totalMs: Math.round(performance.now() - piStart), maxTickMs: Math.round(maxTickMs) };
  }
  console.log(JSON.stringify({ developmentRuntime: !app.isPackaged, executable: path.basename(process.execPath),
    totalMs: Math.round(total), piProfile, modules: [...timings.entries()]
    .map(([name, value]) => ({ name, totalMs: Math.round(value.total), selfMs: Math.round(value.self), count: value.count }))
    .sort((a, b) => b.selfMs - a.selfMs).slice(0, 20) }, null, 2));
  app.exit(0);
}).catch(error => {
  Module._load = originalLoad;
  console.error(error.message);
  app.exit(1);
});

app.on('quit', () => {
  if (profileDir.startsWith(path.join(os.tmpdir(), 'bidxu-startup-modules-'))) {
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
});
