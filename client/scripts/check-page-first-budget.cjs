// 页数优先预算契约：纯本地测试，不调用模型或 Word。
//   node scripts/check-page-first-budget.cjs
const assert = require('node:assert/strict');

const {
  WORDS_PER_PAGE,
  PAGE_WORD_TOLERANCE,
  derivePlanningWordControl,
  estimatePageWordBudget,
  isPageCountAccepted,
  normalizeWordControlOptions: normalizeStoredControl,
  pageAdjustmentTarget,
  resolvePageConstraint,
} = require('../electron/shared/pageBudget.mjs');
const { enforceMinimumLeafTarget, normalizeWordControlOptions, deriveTargetLeafCount } = require('../electron/services/outlineGenerationTaskV2.cjs');
const { __test__: content } = require('../electron/services/contentGenerationTask.cjs');
const { normalizePageOptimizationOptions } = require('../electron/services/contentGenerationTask.cjs');

assert.equal(WORDS_PER_PAGE, 650);
assert.equal(PAGE_WORD_TOLERANCE, 0.15);
assert.equal(estimatePageWordBudget(0), null);
assert.deepEqual(
  Object.fromEntries(Object.entries(estimatePageWordBudget(2)).filter(([key]) => ['targetPages', 'estimatedWords', 'minimumWords', 'maximumWords'].includes(key))),
  { targetPages: 2, estimatedWords: 1300, minimumWords: 1105, maximumWords: 1495 },
);

const stored = normalizeStoredControl({ mode: 'pages', targetPages: 1, minimumWords: 99999, maximumWords: 100000, sectionWords: 3000 });
assert.deepEqual(stored, {
  mode: 'pages',
  targetPages: 1,
  minimumPages: 0,
  maximumPages: 0,
  minimumWords: 99999,
  maximumWords: 100000,
  sectionWords: 3000,
}, '持久化规范化不得覆盖另一模式的手填值');
assert.deepEqual(Object.fromEntries(Object.entries(derivePlanningWordControl(stored)).filter(([key]) => [
  'mode', 'targetPages', 'minimumPages', 'maximumPages', 'minimumWords', 'maximumWords', 'sectionWords', 'planningPages',
].includes(key))), {
  mode: 'pages',
  targetPages: 1,
  minimumPages: 0,
  maximumPages: 0,
  minimumWords: 553,
  maximumWords: 748,
  sectionWords: 650,
  planningPages: 1,
});
const onePageOutlineControl = normalizeWordControlOptions(stored);
assert.equal(deriveTargetLeafCount(onePageOutlineControl), 1, '1页规划必须得到1个建议叶子，不能被范围取整误推到2个');

const pageControl = derivePlanningWordControl(content.normalizeOutlineWordControlSnapshot({
  mode: 'pages', targetPages: 0, minimumPages: 90, maximumPages: 110,
  minimumWords: 80000, maximumWords: 90000, sectionWords: 3000,
}));
assert.deepEqual({
  targetPages: pageControl.targetPages,
  planningPages: pageControl.planningPages,
  minimumWords: pageControl.minimumWords,
  maximumWords: pageControl.maximumWords,
  sectionWords: pageControl.sectionWords,
}, { targetPages: 0, planningPages: 100, minimumWords: 55250, maximumWords: 74750, sectionWords: 3000 });
assert.equal(content.getContentWordTarget(pageControl), 65000, '正文规划必须实际采用页数范围中点换算后的中心字数');
assert.equal(content.getContentWordTarget(derivePlanningWordControl(content.normalizeOutlineWordControlSnapshot({ mode: 'pages', targetPages: 1 }))), 650,
  '奇数页也必须直接使用页数乘650，不能用范围两端平均产生取整漂移');
assert.equal(content.shouldCheckTotalWords(pageControl, { targetItemId: '', targetCount: 1, totalCount: 1 }), false,
  '页数模式不得把估算字数当最终硬校正条件');
assert.equal(content.shouldCheckTotalWords({ mode: 'words', targetPages: 99 }, { targetItemId: '', targetCount: 1, totalCount: 1 }), true,
  '旧字数模式仍保留全文字数校正');

const rangeConstraint = resolvePageConstraint({ mode: 'pages', targetPages: 100, minimumPages: 90, maximumPages: 110 });
assert.equal(isPageCountAccepted(102, rangeConstraint), true, '区间优先时102页应直接验收，不得强追100页');
assert.equal(pageAdjustmentTarget(80, rangeConstraint), 90);
assert.equal(pageAdjustmentTarget(120, rangeConstraint), 110);
assert.throws(() => resolvePageConstraint({ mode: 'pages', targetPages: 80, minimumPages: 90, maximumPages: 110 }), /不能低于/);
const temporaryOptimization = normalizePageOptimizationOptions({ targetPages: 100, minimumPages: 90, maximumPages: 110 });
assert.deepEqual(temporaryOptimization, { targetPages: 100, minimumPages: 90, maximumPages: 110 });
const resumedRuntime = content.normalizeContentGenerationRuntime({
  phase: 'word-converting',
  page_optimization_only: true,
  page_optimization_options: temporaryOptimization,
});
assert.equal(resumedRuntime.phase, 'word-converting');
assert.equal(resumedRuntime.page_optimization_only, true);
assert.deepEqual(resumedRuntime.page_optimization_options, temporaryOptimization,
  '暂停/失败恢复必须保留临时篇幅优化参数，不能退回原字数模式');

const plans = new Map([
  ['a', { target_words: 2 }],
  ['b', { target_words: 1 }],
]);
content.allocateContentWordTargets(plans, pageControl, 2);
assert.equal([...plans.values()].reduce((sum, plan) => sum + plan.target_words, 0), 65000,
  '各正文小节预算之和必须等于页数换算中心字数');

assert.equal(enforceMinimumLeafTarget(1, 1, 3, 2), 7,
  '极小页数遇到必需技术分支时应调整为结构可实现值，不能卡在非法叶子数');

console.log('page-first budget checks passed');
