export function areBidAnalysisTasksReady(tasks = {}, taskDefinitions = []) {
  return taskDefinitions.every((task) => {
    const result = tasks[task.id];
    return result?.status === 'success' && String(result.content || '').trim().length > 0;
  });
}

export function resolvePageAssistantState(contentStats = {}, snapshot) {
  const hasTaskConstraint = [contentStats.target_pages, contentStats.minimum_pages, contentStats.maximum_pages]
    .some((value) => Number(value || 0) > 0);
  const useSavedConstraint = !hasTaskConstraint && snapshot?.mode === 'pages';
  const targetPages = hasTaskConstraint ? Number(contentStats.target_pages || 0) : useSavedConstraint ? Number(snapshot.targetPages || 0) : 0;
  const minimumPages = hasTaskConstraint ? Number(contentStats.minimum_pages || 0) : useSavedConstraint ? Number(snapshot.minimumPages || 0) : 0;
  const maximumPages = hasTaskConstraint ? Number(contentStats.maximum_pages || 0) : useSavedConstraint ? Number(snapshot.maximumPages || 0) : 0;
  const measuredPages = Number(contentStats.measured_pages || 0);
  const requirementText = minimumPages > 0 || maximumPages > 0
    ? `${minimumPages > 0 ? minimumPages : '不限下限'} – ${maximumPages > 0 ? maximumPages : '不限上限'} 页`
    : targetPages > 0 ? `${targetPages} 页` : '未设置';
  const acceptedByValue = measuredPages > 0 && (minimumPages > 0 || maximumPages > 0
    ? (minimumPages <= 0 || measuredPages >= minimumPages) && (maximumPages <= 0 || measuredPages <= maximumPages)
    : targetPages > 0 && measuredPages === targetPages);
  const measurementLabel = contentStats.page_measurement_source === 'microsoft-word'
    ? 'Microsoft Word 实排'
    : contentStats.page_measurement_source === 'docx-editor'
      ? '内置布局计页'
      : '等待成稿实排';
  return {
    targetPages,
    minimumPages,
    maximumPages,
    measuredPages,
    requirementText,
    accepted: acceptedByValue && contentStats.page_verified === true,
    measurementLabel,
  };
}

export function resolveNaturalizeAssistantState(contentStats = {}, naturalizing = false) {
  const total = Number(contentStats.naturalize_total || 0);
  const completed = Number(contentStats.naturalize_completed || 0);
  const failed = Number(contentStats.naturalize_failed || 0);
  const complete = total > 0 && completed >= total;
  return {
    total,
    completed,
    failed,
    complete,
    tone: naturalizing ? 'running' : failed > 0 ? 'warning' : complete ? 'success' : 'neutral',
    label: naturalizing
      ? '进行中'
      : total > 0
        ? `${completed}/${total}${failed > 0 ? '，待复核' : complete ? '，已完成' : ''}`
        : '',
  };
}

export function isPageMeasurementStale(sections = {}, taskUpdatedAt = '', measuredPages = 0) {
  if (Number(measuredPages || 0) <= 0) return false;
  const measuredAt = Date.parse(taskUpdatedAt || '') || 0;
  const latestSectionUpdate = Math.max(0, ...Object.values(sections).map((section) => Date.parse(section?.updated_at || '') || 0));
  return latestSectionUpdate > 0 && latestSectionUpdate > measuredAt;
}

export function resolvePageOptimizationReadiness({ taskStatus, sectionIds = [], sections = {}, runtime } = {}) {
  if (['running', 'pausing'].includes(taskStatus)) {
    return { ready: false, reason: '当前正文任务结束后才可执行篇幅优化' };
  }
  if (taskStatus === 'paused') {
    return { ready: false, reason: '请先继续并完成已暂停的正文任务' };
  }
  if (sectionIds.length === 0) {
    return { ready: false, reason: '请先生成目录和正文' };
  }
  if (taskStatus !== 'success') {
    return { ready: false, reason: '最近一次正文任务尚未成功完成' };
  }
  const incompleteIds = sectionIds.filter((id) => sections[id]?.status !== 'success');
  if (incompleteIds.length > 0) {
    return { ready: false, reason: `需先完成全部正文生成（当前 ${sectionIds.length - incompleteIds.length}/${sectionIds.length} 节）` };
  }
  if (!String(runtime?.html_output?.workspace_dir || '').trim()) {
    return { ready: false, reason: '未找到当前成稿的 HTML 工作区，请先完成正文生成' };
  }
  const registeredWordIds = new Set((runtime.html_output.word_sections || [])
    .filter((entry) => String(entry?.section_id || '').trim() && String(entry?.file || '').trim())
    .map((entry) => entry.section_id));
  const missingArtifactIds = sectionIds.filter((id) => Number(runtime.section_words?.[id] || 0) <= 0 && !registeredWordIds.has(id));
  if (missingArtifactIds.length > 0) {
    return {
      ready: false,
      reason: `当前成稿产物登记不完整，${missingArtifactIds.length} 个小节需重新生成或转换 Word`,
    };
  }
  return { ready: true, reason: '' };
}
