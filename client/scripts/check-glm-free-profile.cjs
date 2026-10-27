const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConfigStore } = require('../electron/services/configStore.cjs');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bidxu-glm-profile-'));
const store = createConfigStore({ getPath: () => directory });
try {
  store.load();
  store.save({ text_model_provider: 'deepseek', api_key: 'fixture-paid-key', model_name: 'deepseek-chat' });
  store.save({ text_model_profiles: { glm: { api_key: 'fixture-free-key' } } });
  let config = store.load();
  assert.equal(config.text_model_provider, 'deepseek');
  assert.equal(config.api_key, 'fixture-paid-key');
  assert.equal(config.text_model_profiles.glm.api_key, 'fixture-free-key');
  store.save({ text_model_provider: 'glm' });
  config = store.load();
  assert.equal(config.api_key, 'fixture-free-key');
  assert.equal(config.model_name, 'glm-4.7-flash');
  assert.equal(config.base_url, 'https://open.bigmodel.cn/api/paas/v4');
  assert.equal(config.concurrency_limit, 1);
  assert.equal(config.multimodal_enabled, false);
  // The dedicated preset must never silently route a test to a paid variant.
  store.save({ model_name: 'glm-4.7-flashx', base_url: 'https://paid.invalid', multimodal_enabled: true,
    context_length_limit: 999999, output_token_limit: 999999 });
  config = store.load();
  assert.equal(config.model_name, 'glm-4.7-flash');
  assert.equal(config.base_url, 'https://open.bigmodel.cn/api/paas/v4');
  assert.equal(config.multimodal_enabled, false);
  assert.equal(config.context_length_limit, 200000);
  assert.equal(config.output_token_limit, 128000);
  store.save({ model_name: 'glm-4-flash-250414' });
  config = store.load();
  assert.equal(config.model_name, 'glm-4-flash-250414');
  assert.equal(config.context_length_limit, 128000);
  assert.equal(config.output_token_limit, 16000);
  store.save({ text_model_provider: 'deepseek' });
  config = store.load();
  assert.equal(config.api_key, 'fixture-paid-key');
  assert.equal(config.model_name, 'deepseek-chat');
  assert.equal(config.text_model_profiles.glm.api_key, 'fixture-free-key');
  console.log('GLM free profile: fixed free model, isolated credentials, switch-back and caps passed');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
