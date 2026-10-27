const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createModelUsageLedger } = require('./modelUsageLedger.cjs');

test('persists per-task and per-stage usage without double counting request ids', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-model-usage-'));
  const ledger = createModelUsageLedger({ baseDir });
  const context = { taskId: 'task-1', taskType: 'content-generation', stage: 'auditing', source: 'pi-agent' };
  ledger.record({ requestId: 'req-1', context, status: 'success', provider: 'custom', model: 'glm-test', usage: {
    prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 70 },
  } });
  ledger.record({ requestId: 'req-1', context, status: 'success', usage: { prompt_tokens: 999 } });
  ledger.record({ requestId: 'req-2', context: { ...context, stage: 'naturalizing', source: 'direct' }, status: 'failed' });

  const summary = ledger.getTaskSummary('task-1');
  assert.deepEqual({
    requestCount: summary.requestCount,
    successRequestCount: summary.successRequestCount,
    failedRequestCount: summary.failedRequestCount,
    unknownTokenRequestCount: summary.unknownTokenRequestCount,
    inputTokens: summary.inputTokens,
    cachedInputTokens: summary.cachedInputTokens,
    freshInputTokens: summary.freshInputTokens,
    outputTokens: summary.outputTokens,
  }, { requestCount: 2, successRequestCount: 1, failedRequestCount: 1, unknownTokenRequestCount: 1,
    inputTokens: 100, cachedInputTokens: 70, freshInputTokens: 30, outputTokens: 20 });
  assert.equal(summary.stages.length, 2);

  const restored = createModelUsageLedger({ baseDir }).getTaskSummary('task-1');
  assert.equal(restored.requestCount, 2);
  const serialized = fs.readFileSync(fs.readdirSync(path.join(baseDir, 'tasks')).map(name => path.join(baseDir, 'tasks', name))[0], 'utf8');
  assert.doesNotMatch(serialized, /prompt|response|api.?key|workspace/i);
});

test('returns null for historical tasks without recorded requests', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-model-usage-empty-'));
  assert.equal(createModelUsageLedger({ baseDir }).getTaskSummary('historical-task'), null);
});

test('marks invalid and partial provider usage unknown while accepting explicit zero counters', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-model-usage-shapes-'));
  const ledger = createModelUsageLedger({ baseDir });
  const context = { taskId: 'task-shapes', taskType: 'content-generation', stage: 'generating' };
  ledger.record({ requestId: 'bad', context, status: 'success', usage: { foo: 123 } });
  ledger.record({ requestId: 'partial', context, status: 'success', usage: { prompt_tokens: 4, reasoning_tokens: 2 } });
  ledger.record({ requestId: 'zero', context, status: 'success', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
  ledger.record({ requestId: 'google', context, status: 'success', usage: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 } });

  const summary = ledger.getTaskSummary('task-shapes');
  assert.equal(summary.requestCount, 4);
  assert.equal(summary.unknownTokenRequestCount, 2);
  assert.equal(summary.inputTokens, 7, '已知的部分输入仍汇总，但 UI 必须同时显示 unknown 提示');
  assert.equal(summary.outputTokens, 2);
  assert.equal(summary.totalTokens, 9);
});
