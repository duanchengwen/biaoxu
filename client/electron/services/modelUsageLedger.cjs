const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getModelUsageDir } = require('../utils/paths.cjs');
const { normalizeTokenUsage } = require('./textTokenStatsStore.cjs');

const LEDGER_VERSION = 1;

function safeText(value, maxLength = 160) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeUsageContext(value = {}) {
  return {
    taskId: safeText(value.taskId || value.task_id),
    taskType: safeText(value.taskType || value.task_type),
    stage: safeText(value.stage) || 'unspecified',
    source: safeText(value.source) || 'direct',
  };
}

function hasValidNumber(source, keys) {
  return keys.some(key => {
    const value = source?.[key];
    return value !== undefined && value !== null && Number.isFinite(Number(value)) && Number(value) >= 0;
  });
}

// A random non-empty object or a reasoning/cache-only fragment is not a complete usage
// report. Input and output must both be explicitly present (zero is valid); otherwise
// known partial counters are still accumulated but the request is marked unknown.
function hasCompleteTokenUsage(source) {
  if (!source || typeof source !== 'object') return false;
  const hasInput = hasValidNumber(source, [
    'prompt_tokens', 'promptTokens', 'promptTokenCount', 'toolUsePromptTokenCount',
  ]);
  const hasOutput = hasValidNumber(source, [
    'completion_tokens', 'completionTokens', 'completionTokenCount', 'candidatesTokenCount',
  ]);
  return hasInput && hasOutput;
}

function createCounters() {
  return {
    requestCount: 0,
    successRequestCount: 0,
    failedRequestCount: 0,
    unknownTokenRequestCount: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    freshInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

function addEvent(counters, event) {
  counters.requestCount += 1;
  if (event.status === 'success') counters.successRequestCount += 1;
  else counters.failedRequestCount += 1;
  if (!event.usageReported) counters.unknownTokenRequestCount += 1;
  counters.inputTokens += event.inputTokens;
  counters.cachedInputTokens += event.cachedInputTokens;
  counters.freshInputTokens += event.freshInputTokens;
  counters.outputTokens += event.outputTokens;
  counters.reasoningTokens += event.reasoningTokens;
  counters.totalTokens += event.totalTokens;
}

function summarizeLedger(ledger) {
  if (!ledger || !Object.keys(ledger.requests || {}).length) return null;
  const total = createCounters();
  const stages = new Map();
  for (const event of Object.values(ledger.requests)) {
    addEvent(total, event);
    if (!stages.has(event.stage)) stages.set(event.stage, { stage: event.stage, ...createCounters() });
    addEvent(stages.get(event.stage), event);
  }
  return {
    recorded: true,
    taskId: ledger.taskId,
    taskType: ledger.taskType || '',
    ...total,
    stages: [...stages.values()],
    updatedAt: ledger.updatedAt || '',
  };
}

function createModelUsageLedger({ app, baseDir } = {}) {
  const rootDir = baseDir || getModelUsageDir(app);
  const tasksDir = path.join(rootDir, 'tasks');
  const cache = new Map();

  function fileForTask(taskId) {
    const digest = crypto.createHash('sha256').update(taskId).digest('hex');
    return path.join(tasksDir, `${digest}.json`);
  }

  function read(taskId) {
    if (cache.has(taskId)) return cache.get(taskId);
    const file = fileForTask(taskId);
    let ledger = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed?.version === LEDGER_VERSION && parsed.taskId === taskId && parsed.requests && typeof parsed.requests === 'object') ledger = parsed;
    } catch {}
    cache.set(taskId, ledger);
    return ledger;
  }

  function write(ledger) {
    fs.mkdirSync(tasksDir, { recursive: true });
    const file = fileForTask(ledger.taskId);
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(ledger), 'utf8');
    fs.renameSync(temporary, file);
    cache.set(ledger.taskId, ledger);
  }

  function record(request = {}) {
    const context = normalizeUsageContext(request.context);
    const requestId = safeText(request.requestId || request.request_id, 200);
    if (!context.taskId || !requestId) return null;
    const current = read(context.taskId) || {
      version: LEDGER_VERSION,
      taskId: context.taskId,
      taskType: context.taskType,
      createdAt: new Date().toISOString(),
      updatedAt: '',
      requests: {},
    };
    if (current.requests[requestId]) return summarizeLedger(current);
    const usageSource = request.usage;
    const usageReported = hasCompleteTokenUsage(usageSource);
    const usage = normalizeTokenUsage(usageSource);
    const inputTokens = usage.prompt_tokens;
    const cachedInputTokens = Math.min(inputTokens, usage.cached_tokens);
    const event = {
      requestId,
      stage: context.stage,
      source: context.source,
      status: request.status === 'success' ? 'success' : 'failed',
      provider: safeText(request.provider),
      model: safeText(request.model),
      usageReported,
      inputTokens,
      cachedInputTokens,
      freshInputTokens: Math.max(0, inputTokens - cachedInputTokens),
      outputTokens: usage.completion_tokens,
      reasoningTokens: usage.reasoning_tokens,
      totalTokens: usage.total_tokens,
      recordedAt: new Date().toISOString(),
    };
    current.taskType ||= context.taskType;
    current.updatedAt = event.recordedAt;
    current.requests[requestId] = event;
    write(current);
    return summarizeLedger(current);
  }

  return {
    record,
    getTaskSummary(taskId) {
      const normalized = safeText(taskId, 200);
      return normalized ? summarizeLedger(read(normalized)) : null;
    },
  };
}

module.exports = {
  createModelUsageLedger,
  hasCompleteTokenUsage,
  normalizeUsageContext,
  summarizeLedger,
};
