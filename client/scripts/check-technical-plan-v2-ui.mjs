import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  areBidAnalysisTasksReady,
  isPageMeasurementStale,
  resolveNaturalizeAssistantState,
  resolvePageAssistantState,
  resolvePageOptimizationReadiness,
} from '../src/features/technical-plan/services/technicalPlanPresentation.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const clientRoot = path.resolve(scriptDir, '..');

const requiredThree = [
  { id: 'projectOverview' },
  { id: 'techRequirements' },
  { id: 'projectInfo' },
];
const readyResults = Object.fromEntries(requiredThree.map(({ id }) => [id, { status: 'success', content: `${id} content` }]));
assert.equal(areBidAnalysisTasksReady(readyResults, requiredThree), true, '实际必需任务成功且非空时应就绪');
assert.equal(areBidAnalysisTasksReady({ ...readyResults, techRequirements: { status: 'success', content: '  ' } }, requiredThree), false, '空结果不能标记解析完成');

const projectHomeSource = await readFile(path.join(clientRoot, 'src/features/technical-plan/pages/ProjectHomePage.tsx'), 'utf8');
assert.match(projectHomeSource, /getBidAnalysisTasks\('key'\)/, '首页必须复用现有必做任务定义');
assert.doesNotMatch(projectHomeSource, /scoringStandards/, '首页不能硬编不存在的解析任务 ID');
assert.match(projectHomeSource, /technicalPlanTaskTypes\.has\(taskType\)/, '首页必须过滤非技术标后台事件');
assert.match(projectHomeSource, /}, 700\)/, '高频技术标事件必须合并刷新');
assert.match(projectHomeSource, /loadInFlight/, '首页必须防止 loadState 并行覆盖');

const wordMode = resolvePageAssistantState(undefined, {
  mode: 'words',
  targetPages: 100,
  minimumPages: 90,
  maximumPages: 110,
});
assert.equal(wordMode.requirementText, '未设置', '字数模式不能把独立保存的页数值当成当前约束');

const pageMode = resolvePageAssistantState(undefined, {
  mode: 'pages',
  targetPages: 100,
  minimumPages: 90,
  maximumPages: 110,
});
assert.equal(pageMode.requirementText, '90 – 110 页');

const staleMeasurement = resolvePageAssistantState({
  target_pages: 20,
  measured_pages: 20,
  page_verified: false,
  page_measurement_source: 'microsoft-word',
}, undefined);
assert.equal(staleMeasurement.accepted, false, '数值相等但未验证的旧实排不能显示达标');

const verifiedRange = resolvePageAssistantState({
  minimum_pages: 90,
  maximum_pages: 110,
  measured_pages: 102,
  page_verified: true,
  page_measurement_source: 'microsoft-word',
}, undefined);
assert.equal(verifiedRange.accepted, true, '经验证的区间内实排应显示符合要求');
assert.equal(verifiedRange.measurementLabel, 'Microsoft Word 实排');
assert.equal(isPageMeasurementStale({
  sectionA: { updated_at: '2026-10-26T10:01:00.000Z' },
}, '2026-10-26T10:00:00.000Z', 102), true, '正文在最近实排后修改时不能继续显示当前达标');
assert.equal(isPageMeasurementStale({
  sectionA: { updated_at: '2026-10-26T09:59:00.000Z' },
}, '2026-10-26T10:00:00.000Z', 102), false);

assert.equal(resolveNaturalizeAssistantState({
  naturalize_total: 5,
  naturalize_completed: 5,
  naturalize_failed: 1,
}).tone, 'warning', '去痕完成但有失败小节时必须显示待复核');
assert.equal(resolveNaturalizeAssistantState({
  naturalize_total: 5,
  naturalize_completed: 3,
  naturalize_failed: 0,
}).tone, 'neutral', '去痕未完成不能显示成功');
assert.equal(resolveNaturalizeAssistantState({
  naturalize_total: 5,
  naturalize_completed: 5,
  naturalize_failed: 0,
}).tone, 'success', '去痕全部完成且无失败时才显示成功');

const htmlRuntime = {
  section_words: { sectionA: 620, sectionB: 580 },
  html_output: { workspace_dir: 'D:/fixture/agent-workspace', word_sections: [] },
};
const emptyDbSections = {
  sectionA: { status: 'success', content: '' },
  sectionB: { status: 'success', content: '' },
};
assert.deepEqual(resolvePageOptimizationReadiness({
  taskStatus: 'success',
  sectionIds: ['sectionA', 'sectionB'],
  sections: emptyDbSections,
  runtime: htmlRuntime,
}), { ready: true, reason: '' }, '正式协议中 DB 正文为空，但 HTML runtime 权威产物完整时必须可以优化');

const missingRuntime = resolvePageOptimizationReadiness({
  taskStatus: 'success',
  sectionIds: ['sectionA'],
  sections: { sectionA: { status: 'success', content: '旧数据库正文' } },
});
assert.equal(missingRuntime.ready, false);
assert.match(missingRuntime.reason, /HTML 工作区/, '只有旧正文字段但缺少 HTML runtime 不能放行');

const partialSections = resolvePageOptimizationReadiness({
  taskStatus: 'success',
  sectionIds: ['sectionA', 'sectionB'],
  sections: { sectionA: { status: 'success' }, sectionB: { status: 'idle' } },
  runtime: htmlRuntime,
});
assert.equal(partialSections.ready, false);
assert.match(partialSections.reason, /1\/2 节/, '部分小节未成功时必须给出精确进度');

assert.equal(resolvePageOptimizationReadiness({
  taskStatus: 'running',
  sectionIds: ['sectionA'],
  sections: { sectionA: { status: 'success' } },
  runtime: htmlRuntime,
}).ready, false, '任务进行中不能启动篇幅优化');

assert.equal(resolvePageOptimizationReadiness({
  taskStatus: 'success',
  sectionIds: ['sectionA'],
  sections: { sectionA: { status: 'success', content: '' } },
  runtime: {
    section_words: {},
    html_output: { workspace_dir: 'D:/fixture/agent-workspace', word_sections: [{ section_id: 'sectionA', file: 'sectionA.docx' }] },
  },
}).ready, true, '有效 Word 登记可作为 section_words 的权威产物备选证据');

assert.match(resolvePageOptimizationReadiness({
  taskStatus: 'success',
  sectionIds: ['sectionA'],
  sections: { sectionA: { status: 'success' } },
  runtime: { section_words: {}, html_output: { workspace_dir: 'D:/fixture/agent-workspace', word_sections: [] } },
}).reason, /产物登记不完整/, '缺小节字数与 Word 登记时必须给出精确原因');

console.log('technical-plan v2 UI state checks passed');
