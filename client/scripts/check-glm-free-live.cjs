// Explicit opt-in. The local in-memory relay holds the real credential and rejects paid models.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { app } = require('electron');

const relay = process.env.BIDXU_FREE_MODEL_RELAY;
if (!relay || new URL(relay).hostname !== '127.0.0.1') {
  console.error('Set BIDXU_FREE_MODEL_RELAY to the explicitly authorized local free-model relay. No API request sent.');
  app.exit(2);
} else {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bidxu-glm-live-'));
  app.setPath('userData', temporary);
  app.whenReady().then(async () => {
    const { createAiService } = require('../electron/services/aiService.cjs');
    const { createModelUsageLedger } = require('../electron/services/modelUsageLedger.cjs');
    const { createAgentOpenAiProxy } = require('../electron/services/agent/agentOpenAiProxy.cjs');
    const ledger = createModelUsageLedger({ app });
    const taskId = `free-model-live-${crypto.randomUUID()}`;
    const context = stage => ({ taskId, taskType: 'free-model-smoke', stage, source: 'direct' });
    let config = { text_model_provider: 'glm', base_url: relay, api_key: 'local-relay-fixture-only',
      model_name: 'glm-4-flash-250414', context_length_limit: 128000, output_token_limit: 256,
      concurrency_limit: 1, request_mode: 'normal', multimodal_enabled: false, developer_mode: false,
      temperature_enabled: false, reasoning_effort: '' };
    const service = createAiService({ app, configStore: { load: () => config }, modelUsageLedger: ledger });
    let proxy;
    try {
      const json = await service.requestJson({ messages: [{ role: 'user', content: '只输出JSON对象 {"status":"ok","days":30}，不要其他文字。' }],
        max_retries: 0, output_token_limit: 64, usage_context: context('json'),
        validator: value => { assert.equal(value.status, 'ok'); assert.equal(value.days, 30); } });
      assert.equal(json.days, 30);
      config = { ...config, request_mode: 'stream' };
      const text = await service.chat({ messages: [{ role: 'user', content: '只回复：测试通过' }],
        output_token_limit: 32, usage_context: context('stream') });
      assert.match(text, /测试通过/);
      config = { ...config, request_mode: 'normal' };
      proxy = createAgentOpenAiProxy({ app, aiService: service, runtime: { id: 'free-model-smoke', displayName: '免费模型隔离测试' },
        getActivityContext: () => ({ task_id: taskId, ai_request_activity: { getUsageContext: () => context('pi-tool-call') } }) });
      const info = await proxy.start();
      const response = await fetch(`${info.baseUrl}/v1/chat/completions`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${info.token}` },
        body: JSON.stringify({ model: 'ignored-fixture-model', stream: true,
          messages: [{ role: 'user', content: '必须调用 report_result 工具，将status设为ok，不要直接回答。' }],
          tools: [{ type: 'function', function: { name: 'report_result', description: '提交结果',
            parameters: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] } } }] }),
        signal: AbortSignal.timeout(90000) });
      const body = await response.text();
      assert.equal(response.status, 200, `Proxy status ${response.status}`);
      assert.match(body, /report_result/);
      await new Promise(resolve => setTimeout(resolve, 100));
      const summary = ledger.getTaskSummary(taskId);
      assert.equal(summary.requestCount, 3, 'direct JSON, stream, Pi proxy each counted exactly once');
      assert.equal(summary.unknownTokenRequestCount, 0, 'all three real provider replies have usage');
      assert.ok(summary.inputTokens > 0 && summary.outputTokens > 0);
      assert.equal(createModelUsageLedger({ app }).getTaskSummary(taskId).totalTokens, summary.totalTokens);
      console.log(JSON.stringify({ success: true, model: config.model_name, userData: 'isolated-temp',
        tests: ['json', 'stream', 'pi-tool-call', 'persisted-usage-with-developer-mode-off'], summary }));
    } finally {
      await proxy?.close();
      fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }).then(() => app.exit(0)).catch(error => { console.error(error.message); app.exit(1); });
}
