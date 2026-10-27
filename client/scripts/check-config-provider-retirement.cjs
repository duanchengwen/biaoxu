const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConfigStore } = require('../electron/services/configStore.cjs');

function createCase(initialConfig) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-config-retirement-'));
  const app = {
    getPath(name) {
      assert.equal(name, 'userData');
      return directory;
    },
  };
  if (initialConfig !== undefined) {
    fs.writeFileSync(path.join(directory, 'user_config.json'), JSON.stringify(initialConfig, null, 2), 'utf8');
  }
  return { directory, store: createConfigStore(app) };
}

function removeCase(testCase) {
  fs.rmSync(testCase.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function persisted(testCase) {
  return JSON.parse(fs.readFileSync(testCase.store.getConfigFilePath(), 'utf8'));
}

function main() {
  const fresh = createCase();
  try {
    const config = fresh.store.load();
    assert.equal(config.text_model_provider, 'custom');
    assert.equal(config.api_key, '');
    assert.equal(config.base_url, '');
    assert.equal(persisted(fresh).text_model_provider, 'custom');
  } finally {
    removeCase(fresh);
  }

  const retiredWithCustom = createCase({
    text_model_provider: 'official',
    api_key: 'official-flat-key-must-not-migrate',
    base_url: 'https://official-flat.invalid/v1',
    model_name: 'official-flat-model',
    text_model_profiles: {
      official: {
        api_key: 'official-profile-key-must-not-migrate',
        base_url: 'https://official-profile.invalid/v1',
        model_name: 'official-profile-model',
      },
      custom: {
        api_key: 'custom-preserved-key',
        base_url: 'https://custom-preserved.example/v1',
        model_name: 'custom-preserved-model',
        concurrency_limit: 3,
        request_mode: 'normal',
      },
    },
  });
  try {
    const config = retiredWithCustom.store.load();
    assert.equal(config.text_model_provider, 'custom');
    assert.equal(config.api_key, 'custom-preserved-key');
    assert.equal(config.base_url, 'https://custom-preserved.example/v1');
    assert.equal(config.model_name, 'custom-preserved-model');
    assert.equal(config.text_model_profiles.custom.api_key, 'custom-preserved-key');
    assert.equal(config.text_model_profiles.custom.base_url, 'https://custom-preserved.example/v1');
    assert.notEqual(config.text_model_profiles.custom.api_key, 'official-flat-key-must-not-migrate');
    assert.notEqual(config.text_model_profiles.custom.api_key, 'official-profile-key-must-not-migrate');
    assert.notEqual(config.text_model_profiles.custom.base_url, 'https://official-flat.invalid/v1');
    assert.notEqual(config.text_model_profiles.custom.base_url, 'https://official-profile.invalid/v1');
    const disk = persisted(retiredWithCustom);
    assert.equal(disk.text_model_provider, 'custom');
    assert.equal(disk.text_model_profiles.custom.api_key, 'custom-preserved-key');
    assert.equal(disk.text_model_profiles.custom.base_url, 'https://custom-preserved.example/v1');
  } finally {
    removeCase(retiredWithCustom);
  }

  const retiredWithoutCustom = createCase({
    text_model_provider: 'official',
    api_key: 'official-only-key-must-not-migrate',
    base_url: 'https://official-only.invalid/v1',
    model_name: 'official-only-model',
    text_model_profiles: {
      official: {
        api_key: 'official-profile-only-key',
        base_url: 'https://official-profile-only.invalid/v1',
        model_name: 'official-profile-only-model',
      },
    },
  });
  try {
    const config = retiredWithoutCustom.store.load();
    assert.equal(config.text_model_provider, 'custom');
    assert.equal(config.api_key, '');
    assert.equal(config.base_url, '');
    assert.equal(config.model_name, '');
    assert.equal(config.text_model_profiles.custom.api_key, '');
    assert.equal(config.text_model_profiles.custom.base_url, '');
  } finally {
    removeCase(retiredWithoutCustom);
  }

  const existingProvider = createCase({
    text_model_provider: 'deepseek',
    api_key: 'deepseek-preserved-key',
    model_name: 'deepseek-preserved-model',
    text_model_profiles: {
      deepseek: {
        api_key: 'deepseek-profile-key',
        model_name: 'deepseek-profile-model',
        concurrency_limit: 4,
      },
      custom: {
        api_key: 'separate-custom-key',
        base_url: 'https://separate-custom.example/v1',
        model_name: 'separate-custom-model',
      },
    },
  });
  try {
    const config = existingProvider.store.load();
    assert.equal(config.text_model_provider, 'deepseek');
    assert.equal(config.api_key, 'deepseek-preserved-key');
    assert.equal(config.model_name, 'deepseek-preserved-model');
    assert.equal(config.text_model_profiles.deepseek.api_key, 'deepseek-preserved-key');
    assert.equal(config.text_model_profiles.deepseek.model_name, 'deepseek-preserved-model');
    assert.equal(config.text_model_profiles.custom.api_key, 'separate-custom-key');
    assert.equal(config.text_model_profiles.custom.base_url, 'https://separate-custom.example/v1');
    assert.equal(persisted(existingProvider).text_model_provider, 'deepseek');
  } finally {
    removeCase(existingProvider);
  }

  console.log('config provider retirement checks passed');
}

main();
