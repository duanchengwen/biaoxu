const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createSqliteDatabase, schemaVersion } = require('../electron/services/sqliteDatabase.cjs');
const { createTechnicalPlanStore } = require('../electron/services/technicalPlanStore.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-v45-'));
const app = {
  getPath(name) {
    assert.equal(name, 'userData');
    return root;
  },
  once() {},
};
const agentService = {
  deletePersistentTask() {},
};
const services = {
  app,
  fileService: {},
  agentService,
  taskLogStore: {},
  configStore: { load: () => ({}) },
};

function openStore() {
  const database = createSqliteDatabase(app);
  return {
    database,
    store: createTechnicalPlanStore({ ...services, db: database.db }),
  };
}

try {
  assert.equal(schemaVersion, 45);
  const baselinePath = path.join(root, 'workspace-schema.sqlite');
  const baseline = new Database(baselinePath);
  baseline.exec(fs.readFileSync(path.resolve(__dirname, '..', '..', 'sql', 'workspace_schema.sql'), 'utf8'));
  assert.equal(baseline.pragma('user_version', { simple: true }), 45);
  const baselineColumns = new Set(baseline.pragma('table_info(technical_plan_generation_config)').map(row => row.name));
  assert(baselineColumns.has('target_pages'));
  assert(baselineColumns.has('word_control_mode'));
  assert(baselineColumns.has('minimum_pages'));
  assert(baselineColumns.has('maximum_pages'));
  assert(baselineColumns.has('naturalize_writing'));
  baseline.close();

  const initial = openStore();
  const databasePath = initial.database.path;
  initial.database.close();

  // 模拟用户从 v42 升级：无目标页数的旧项目应保持字数模式。
  const legacy = new Database(databasePath);
  legacy.exec(`
    ALTER TABLE technical_plan_generation_config DROP COLUMN target_pages;
    ALTER TABLE technical_plan_generation_config DROP COLUMN naturalize_writing;
    ALTER TABLE technical_plan_generation_config DROP COLUMN word_control_mode;
    ALTER TABLE technical_plan_generation_config DROP COLUMN minimum_pages;
    ALTER TABLE technical_plan_generation_config DROP COLUMN maximum_pages;
    PRAGMA user_version = 42;
  `);
  legacy.close();

  const migrated = openStore();
  const columns = new Set(migrated.database.db.pragma('table_info(technical_plan_generation_config)').map(row => row.name));
  assert(columns.has('target_pages'));
  assert(columns.has('naturalize_writing'));
  assert(columns.has('word_control_mode'));
  assert(columns.has('minimum_pages'));
  assert(columns.has('maximum_pages'));
  assert.equal(migrated.database.db.pragma('user_version', { simple: true }), 45);

  const defaults = migrated.store.loadGenerationConfig();
  assert.equal(defaults.outlineWordControlOptions.mode, 'words');
  assert.equal(defaults.outlineWordControlOptions.targetPages, 0);
  assert.equal(defaults.contentGenerationOptions.naturalizeWriting, true);
  migrated.store.saveGenerationConfig({
    outlineWordControlOptions: {
      ...defaults.outlineWordControlOptions,
      mode: 'pages',
      minimumWords: 12345,
      maximumWords: 23456,
      sectionWords: 1777,
      targetPages: 100,
      minimumPages: 90,
      maximumPages: 110,
    },
    contentGenerationOptions: { ...defaults.contentGenerationOptions, naturalizeWriting: false },
  });
  migrated.database.close();

  const recovered = openStore();
  const saved = recovered.store.loadGenerationConfig();
  assert.equal(saved.outlineWordControlOptions.mode, 'pages');
  assert.equal(saved.outlineWordControlOptions.targetPages, 100);
  assert.equal(saved.outlineWordControlOptions.minimumPages, 90);
  assert.equal(saved.outlineWordControlOptions.maximumPages, 110);
  assert.deepEqual({
    minimumWords: saved.outlineWordControlOptions.minimumWords,
    maximumWords: saved.outlineWordControlOptions.maximumWords,
    sectionWords: saved.outlineWordControlOptions.sectionWords,
  }, {
    minimumWords: 12345,
    maximumWords: 23456,
    sectionWords: 1777,
  }, '切换页数模式不得覆盖用户手填的字数配置');
  assert.equal(saved.contentGenerationOptions.naturalizeWriting, false);
  recovered.database.close();

  // 模拟带既有 target_pages 的 v43：升级后自动判定为页数模式。
  const v43 = new Database(databasePath);
  v43.exec(`
    ALTER TABLE technical_plan_generation_config DROP COLUMN word_control_mode;
    ALTER TABLE technical_plan_generation_config DROP COLUMN minimum_pages;
    ALTER TABLE technical_plan_generation_config DROP COLUMN maximum_pages;
    UPDATE technical_plan_generation_config SET target_pages = 88;
    PRAGMA user_version = 43;
  `);
  v43.close();
  const inferred = openStore();
  const inferredConfig = inferred.store.loadGenerationConfig().outlineWordControlOptions;
  assert.equal(inferredConfig.mode, 'pages');
  assert.equal(inferredConfig.targetPages, 88);
  assert.equal(inferredConfig.minimumWords, 12345);
  assert.equal(inferredConfig.maximumWords, 23456);
  inferred.database.close();

  // 模拟已经运行 v44、但尚无暗标页数验收列的用户数据库：v45 必须幂等补列，
  // 不能要求用户重新导入或重新修复既有文档。
  const v44 = new Database(databasePath);
  v44.exec(`
    ALTER TABLE blind_check_fix_results DROP COLUMN page_budget_json;
    PRAGMA user_version = 44;
  `);
  v44.close();
  const pageBudgetMigrated = openStore();
  const fixColumns = new Set(pageBudgetMigrated.database.db.pragma('table_info(blind_check_fix_results)').map(row => row.name));
  assert(fixColumns.has('page_budget_json'));
  assert.equal(pageBudgetMigrated.database.db.pragma('user_version', { simple: true }), 45);
  pageBudgetMigrated.database.close();
  console.log('target pages schema and recovery checks passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
