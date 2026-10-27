import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { trackConfigUsage } from '../../../shared/analytics/analytics';
import { AppDialog, MarkdownEditor, MarkdownFullscreenViewer, MarkdownRenderer, ProgressBar, useToast } from '../../../shared/ui';
import { OUTLINE_CONTENT_MODE_LABELS } from '../../../shared/types';
import type { ClientConfig, OutlineContentMode, TechnicalPlanOutlineData as OutlineData, TechnicalPlanOutlineItem as OutlineItem, OutlineWordControlOptions } from '../../../shared/types';
import { countReadableWords } from '../../../shared/utils/wordCount';
import type { BackgroundTaskState, ContentGenerationOptions, ContentGenerationRuntimeState, ContentGenerationSectionStatus, ContentGenerationSections } from '../types';
import ContentWordPreview from '../components/ContentWordPreview';
import { normalizeContentGenerationOptions } from '../contentGenerationOptions';
import type { ExportFormatConfig } from '../../../shared/types/exportFormat';
import { DEFAULT_EXPORT_FORMAT } from '../../../shared/types/exportFormat';
import { buildExportFormatCssVars } from '../../../shared/utils/exportFormatCss';
import { formatOutlineTitle } from '../../../shared/utils/outlineNumbering';
import { getDefaultImageLayoutShares, type ImageLayoutKey } from '../../../../electron/shared/imageLayout/index.mjs';
import { isPageMeasurementStale, resolveNaturalizeAssistantState, resolvePageAssistantState, resolvePageOptimizationReadiness } from '../services/technicalPlanPresentation.mjs';

interface ContentEditPageProps {
  stepNumber: string;
  hasOriginalPlan: boolean;
  originalPlanContentHash?: string;
  outlineWordControlSnapshot?: OutlineWordControlOptions;
  outlineData: OutlineData | null;
  task?: BackgroundTaskState;
  contentGenerationRuntime?: ContentGenerationRuntimeState;
  contentGenerationOptions?: ContentGenerationOptions;
  exportTemplateId: string;
  sections: ContentGenerationSections;
  onOpenGenerationSettingsAppearance: () => void;
  onContentGenerationOptionsChange: (options: ContentGenerationOptions) => Promise<void>;
  onContentGenerationReset: () => Promise<void>;
  onContentSaved: (item: OutlineItem, content: string) => Promise<void> | void;
}

type TreeStatus = ContentGenerationSectionStatus | 'partial' | 'planning' | 'pending';

interface OutlineNodeMeta {
  status: TreeStatus;
  leafCount: number;
  words: number;
}

type ContentGenerationAction = 'start' | 'continue' | 'regenerate' | 'regenerate_section';

interface PageOptimizationDraft {
  targetPages: string;
  minimumPages: string;
  maximumPages: string;
}

function normalizePageOptimizationDraft(draft: PageOptimizationDraft) {
  const parse = (value: string) => {
    const normalized = value || '0';
    return /^\d+$/.test(normalized) && Number.isSafeInteger(Number(normalized)) ? Number(normalized) : null;
  };
  const targetPages = parse(draft.targetPages);
  const minimumPages = parse(draft.minimumPages);
  const maximumPages = parse(draft.maximumPages);
  if (targetPages === null || minimumPages === null || maximumPages === null) {
    throw new Error('页数只允许填写非负整数');
  }
  if (targetPages <= 0 && minimumPages <= 0 && maximumPages <= 0) {
    throw new Error('请至少填写目标、最少或最多页数中的一项');
  }
  if (minimumPages > 0 && maximumPages > 0 && minimumPages > maximumPages) {
    throw new Error('最少页数不能高于最多页数');
  }
  if (targetPages > 0 && minimumPages > 0 && targetPages < minimumPages) {
    throw new Error('目标页数不能低于最少页数');
  }
  if (targetPages > 0 && maximumPages > 0 && targetPages > maximumPages) {
    throw new Error('目标页数不能高于最多页数');
  }
  return { targetPages, minimumPages, maximumPages };
}

// 布局开关只上报当前配图比例档位可用的布局，档位份额为 0 的布局不计入统计。
function buildImageLayoutUsage(options: ContentGenerationOptions) {
  const defaultShares = getDefaultImageLayoutShares(options.imageQuantity);
  const usage = (key: ImageLayoutKey, enabled: boolean) => (defaultShares[key] > 0 ? enabled : undefined);
  return {
    image_layout_single: usage('single', options.useSingleImageLayout),
    image_layout_image_text: usage('imageText', options.useImageTextLayout),
    image_layout_three_images: usage('threeImages', options.useThreeImagesLayout),
    image_layout_four_images: usage('fourImages', options.useFourImagesLayout),
  };
}

const statusLabels: Record<TreeStatus, string> = {
  idle: '待生成',
  running: '生成中',
  success: '已生成',
  error: '失败',
  partial: '部分生成',
  planning: '编排中',
  pending: '待处理',
};

const pendingModeDescriptions: Record<Exclude<OutlineContentMode, 'ai-generate'>, string> = {
  'template-fill': '该小节已标记为模板填写，后续将从招标文件提取并填充内容。',
  'directory-generate': '该小节已标记为目录生成，不进入 AI 正文生成流程。',
  'manual-fill': '该小节已标记为人工填写，请在导出后补充内容。',
  other: '该小节采用其他处理模式，暂不进入 AI 正文生成流程。',
};

function collectLeafItems(items: OutlineItem[]): OutlineItem[] {
  return items.flatMap((item) => item.children?.length ? collectLeafItems(item.children) : [item]);
}

function findItem(items: OutlineItem[], id: string): OutlineItem | null {
  for (const item of items) {
    if (item.id === id) {
      return item;
    }

    if (item.children?.length) {
      const found = findItem(item.children, id);
      if (found) {
        return found;
      }
    }
  }

  return null;
}

function countWords(content: string) {
  return countReadableWords(content);
}

function getLeafContent(item: OutlineItem, sections: ContentGenerationSections) {
  const section = sections[item.id];
  return section && Object.prototype.hasOwnProperty.call(section, 'content')
    ? section.content || ''
    : item.content || '';
}

function getLeafStatus(item: OutlineItem, sections: ContentGenerationSections): TreeStatus {
  const section = sections[item.id];
  if (section?.status) {
    return section.status;
  }

  if (getLeafContent(item, sections).trim()) return 'success';
  return item.content_mode === 'ai-generate' ? 'idle' : 'pending';
}

function getTreeStatus(item: OutlineItem, sections: ContentGenerationSections): TreeStatus {
  if (!item.children?.length) {
    return getLeafStatus(item, sections);
  }

  const childStatuses = item.children.map((child) => getTreeStatus(child, sections));
  if (childStatuses.some((status) => status === 'running')) {
    return 'running';
  }
  if (childStatuses.every((status) => status === 'success')) {
    return 'success';
  }
  if (childStatuses.every((status) => status === 'pending')) {
    return 'pending';
  }
  if (childStatuses.some((status) => status === 'error')) {
    return 'error';
  }
  if (childStatuses.some((status) => status === 'success' || status === 'partial' || status === 'pending')) {
    return 'partial';
  }

  return 'idle';
}

function getParentStatus(childStatuses: TreeStatus[]): TreeStatus {
  if (childStatuses.some((status) => status === 'running')) return 'running';
  if (childStatuses.every((status) => status === 'success')) return 'success';
  if (childStatuses.every((status) => status === 'pending')) return 'pending';
  if (childStatuses.some((status) => status === 'error')) return 'error';
  if (childStatuses.some((status) => status === 'success' || status === 'partial' || status === 'pending')) return 'partial';
  if (childStatuses.some((status) => status === 'planning')) return 'planning';
  return 'idle';
}

function buildOutlineMeta(items: OutlineItem[], sections: ContentGenerationSections, planning: boolean, sectionWords: Record<string, number> = {}) {
  const meta = new Map<string, OutlineNodeMeta>();

  function visit(item: OutlineItem): OutlineNodeMeta {
    if (!item.children?.length) {
      const baseStatus = getLeafStatus(item, sections);
      const status: TreeStatus = planning && item.content_mode === 'ai-generate' && baseStatus === 'idle' ? 'planning' : baseStatus;
      const words = item.content_mode === 'ai-generate' ? sectionWords[item.id] || 0 : countWords(getLeafContent(item, sections));
      const nodeMeta: OutlineNodeMeta = { status, leafCount: 1, words };
      meta.set(item.id, nodeMeta);
      return nodeMeta;
    }

    const children = item.children.map(visit);
    const nodeMeta = {
      status: getParentStatus(children.map((child) => child.status)),
      leafCount: children.reduce((sum, child) => sum + child.leafCount, 0),
      words: children.reduce((sum, child) => sum + child.words, 0),
    };
    meta.set(item.id, nodeMeta);
    return nodeMeta;
  }

  items.forEach(visit);
  return meta;
}

const MarkdownContent = memo(function MarkdownContent({ content, onPreviewImage }: { content: string; onPreviewImage: (src: string, alt: string) => void }) {
  return (
    <MarkdownRenderer
      imageMode="preview"
      imageClassName="markdown-clickable-image"
      onPreviewImage={onPreviewImage}
    >
      {content}
    </MarkdownRenderer>
  );
});

function ContentEditPage({
  stepNumber,
  hasOriginalPlan,
  originalPlanContentHash,
  outlineWordControlSnapshot,
  outlineData,
  task,
  contentGenerationRuntime,
  contentGenerationOptions,
  exportTemplateId,
  sections,
  onOpenGenerationSettingsAppearance,
  onContentGenerationOptionsChange,
  onContentGenerationReset,
  onContentSaved,
}: ContentEditPageProps) {
  const { showToast } = useToast();
  const allLeaves = useMemo(() => outlineData?.outline ? collectLeafItems(outlineData.outline) : [], [outlineData]);
  const leaves = useMemo(() => allLeaves.filter((item) => item.content_mode === 'ai-generate'), [allLeaves]);
  const [selectedItemId, setSelectedItemId] = useState('');
  const [wordPreviewRequest, setWordPreviewRequest] = useState<{ sectionId: string; context: object; version: number }>();
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [draftContent, setDraftContent] = useState('');
  const [confirmRegenerateItem, setConfirmRegenerateItem] = useState<OutlineItem | null>(null);
  const [requirementItem, setRequirementItem] = useState<OutlineItem | null>(null);
  const [regenerateRequirement, setRegenerateRequirement] = useState('');
  const [statsCollapsed, setStatsCollapsed] = useState(false);
  const [progressNow, setProgressNow] = useState(Date.now);
  const [previewImage, setPreviewImage] = useState<{ src: string; alt: string } | null>(null);
  const [pausePending, setPausePending] = useState(false);
  const [developerStageActionPending, setDeveloperStageActionPending] = useState<'continue' | 'restart' | null>(null);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [resetPending, setResetPending] = useState(false);
  const [sectionSubmitting, setSectionSubmitting] = useState(false);
  const [templateRequiredDialogOpen, setTemplateRequiredDialogOpen] = useState(false);
  const [concurrencyWarning, setConcurrencyWarning] = useState('');
  const [aiImageUnavailableTarget, setAiImageUnavailableTarget] = useState<'generation' | 'section' | null>(null);
  const [generationSubmitting, setGenerationSubmitting] = useState(false);
  const [naturalizeDialogOpen, setNaturalizeDialogOpen] = useState(false);
  const [pageOptimizeDialogOpen, setPageOptimizeDialogOpen] = useState(false);
  const [pageOptimizationDraft, setPageOptimizationDraft] = useState<PageOptimizationDraft>({
    targetPages: String(outlineWordControlSnapshot?.targetPages || 0),
    minimumPages: String(outlineWordControlSnapshot?.minimumPages || 0),
    maximumPages: String(outlineWordControlSnapshot?.maximumPages || 0),
  });
  const generationStarting = useRef(false);
  const [exportFormat, setExportFormat] = useState<ExportFormatConfig>(DEFAULT_EXPORT_FORMAT);
  const [developerMode, setDeveloperMode] = useState(false);
  const firstLeafId = allLeaves[0]?.id || '';
  const selectedItem = outlineData?.outline && selectedItemId ? findItem(outlineData.outline, selectedItemId) : null;
  const selectedIsLeaf = Boolean(selectedItem && !selectedItem.children?.length);
  const selectedIsWord = selectedIsLeaf && selectedItem?.content_mode === 'ai-generate';
  // 清空、目录变化或新任务使旧预览失效；扫描和正式转换进度不触发临时转换。
  const hasContentTask = Boolean(task || contentGenerationRuntime?.html_output);
  const wordContentContext = useMemo(() => ({}), [outlineData, hasContentTask, task?.task_id]);
  const wordRequestVersion = wordPreviewRequest?.sectionId === selectedItemId && wordPreviewRequest.context === wordContentContext
    ? wordPreviewRequest.version : 0;
  const selectedContent = selectedItem && selectedIsLeaf ? getLeafContent(selectedItem, sections) : '';
  const exportFormatPreviewStyle = useMemo<CSSProperties>(() => buildExportFormatCssVars(exportFormat), [exportFormat]);
  const running = task?.status === 'running';
  const pausing = task?.status === 'pausing' || pausePending;
  const paused = task?.status === 'paused';
  const taskFailed = task?.status === 'error';
  const taskInFlight = running || pausing;
  const phaseVisible = taskInFlight || paused || taskFailed;
  useEffect(() => {
    if (!taskInFlight) return;
    setProgressNow(Date.now());
    const timer = window.setInterval(() => setProgressNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [taskInFlight]);
  const taskBlocksGeneration = taskInFlight || paused || sectionSubmitting || generationSubmitting;
  const contentStats = task?.stats?.content;
  const consistencyRemainingIssues = (contentStats?.consistency_remaining_issues || []).filter((issue) => issue.trim());
  const consistencyNeedsReview = consistencyRemainingIssues.length > 0;
  const consistencyCompleted = contentStats?.consistency_status === 'completed';
  const consistencyPassed = consistencyCompleted && !consistencyNeedsReview;
  const previewReadySectionIds = useMemo(() => new Set(contentStats?.preview_ready_section_ids || []), [contentStats?.preview_ready_section_ids]);
  const originalRestoration = hasOriginalPlan && typeof contentStats?.original_restoration?.total_words === 'number' && contentStats.original_restoration.source_hash === originalPlanContentHash
    ? contentStats?.original_restoration : undefined;
  const developerStageGate = developerMode && paused ? contentStats?.developer_stage_gate : undefined;
  const progressDetail = task?.progress_detail || contentStats?.output_progress;
  const planning = phaseVisible && contentStats?.phase === 'planning';
  const restoring = phaseVisible && contentStats?.phase === 'restoring';
  const auditing = phaseVisible && contentStats?.phase === 'auditing';
  const tableCleaning = phaseVisible && contentStats?.phase === 'table-cleaning';
  const layoutChecking = phaseVisible && contentStats?.phase === 'layout-checking';
  const naturalizing = phaseVisible && contentStats?.phase === 'naturalizing';
  const pageAdjusting = phaseVisible && contentStats?.phase === 'page-adjusting';
  const contentCorrecting = auditing || tableCleaning;
  const sectionWords = contentGenerationRuntime?.section_words;
  const outlineMeta = useMemo(() => outlineData?.outline ? buildOutlineMeta(outlineData.outline, sections, planning, sectionWords) : new Map<string, OutlineNodeMeta>(), [outlineData, planning, sections, sectionWords]);
  const contentSummary = useMemo(() => leaves.reduce((summary, item) => {
    const status = getLeafStatus(item, sections);
    return {
      completedCount: summary.completedCount + (status === 'success' ? 1 : 0),
      failedCount: summary.failedCount + (status === 'error' ? 1 : 0),
      totalWords: summary.totalWords + (outlineMeta.get(item.id)?.words || 0),
    };
  }, { completedCount: 0, failedCount: 0, totalWords: 0 }), [leaves, outlineMeta, sections]);
  const { completedCount, failedCount, totalWords } = contentSummary;
  const pageOptimizationReadiness = resolvePageOptimizationReadiness({
    taskStatus: task?.status,
    sectionIds: leaves.map((item) => item.id),
    sections,
    runtime: contentGenerationRuntime,
  });
  const hasEditablePageOptimizationSource = pageOptimizationReadiness.ready;
  const pageOptimizationDisabledReason = sectionSubmitting || generationSubmitting
    ? '当前操作结束后才可执行篇幅优化'
    : pageOptimizationReadiness.reason;
  const modeCounts = allLeaves.reduce<Record<OutlineContentMode, number>>((counts, item) => {
    if (item.content_mode) counts[item.content_mode] += 1;
    return counts;
  }, { 'ai-generate': 0, 'template-fill': 0, 'directory-generate': 0, 'manual-fill': 0, other: 0 });
  const pendingCount = modeCounts['template-fill'] + modeCounts['directory-generate'] + modeCounts['manual-fill'] + modeCounts.other;
  const progress = leaves.length ? Math.round((completedCount / leaves.length) * 100) : 0;
  const planningTotal = contentStats?.planning_total || leaves.length;
  const planningCompleted = contentStats?.planning_completed || 0;
  const planningProgress = planningTotal ? Math.round((planningCompleted / planningTotal) * 100) : 0;
  const minimumWords = contentStats?.minimum_words ?? outlineWordControlSnapshot?.minimumWords ?? 0;
  const maximumWords = contentStats?.maximum_words ?? outlineWordControlSnapshot?.maximumWords ?? 0;
  const currentWords = contentStats?.current_words ?? totalWords;
  const retryingTableCleanup = taskFailed && contentStats?.phase === 'table-cleaning';
  const retryingLayoutCheck = taskFailed && contentStats?.phase === 'layout-checking';
  const retryingNaturalize = taskFailed && contentStats?.phase === 'naturalizing';
  const retryingPageAdjustment = taskFailed && contentStats?.phase === 'page-adjusting';
  const exportRepairing = contentStats?.phase === 'export-repair';
  const retryingExportRepair = taskFailed && exportRepairing;
  const exportRepairCompleted = task?.status === 'success' && exportRepairing;
  const retryingWordConversion = taskFailed && ['sections-completed', 'word-converting'].includes(contentStats?.phase || '');
  const retryingConsistency = taskFailed && contentStats?.phase === 'auditing';
  const retryingSectionModification = taskFailed && Boolean(contentGenerationRuntime?.target_item_id) && contentStats?.phase === 'generating';
  const retryingBodyGeneration = taskFailed && !contentGenerationRuntime?.target_item_id && contentStats?.phase === 'generating';
  const latestTaskLog = task?.logs?.[task.logs.length - 1] || '';
  const taskErrorMessage = task?.error || latestTaskLog || '正文生成任务失败';
  // 单轮审计：先并发核对各小节事实，再由主 Agent 跨节比对并统一修复。
  const consistencyStatus = contentStats?.consistency_status || 'extracting';
  const consistencyExtractCompleted = contentStats?.consistency_extract_completed || 0;
  const consistencyExtractTotal = contentStats?.consistency_extract_total || 0;
  const auditProgress = consistencyStatus === 'completed' ? 100 : consistencyStatus === 'running' ? 60
    : consistencyExtractTotal ? Math.round((consistencyExtractCompleted / consistencyExtractTotal) * 50) : 0;
  const tableCleanupTotal = contentStats?.table_cleanup_total || 0;
  const tableCleanupCompleted = contentStats?.table_cleanup_completed || 0;
  const tableCleanupProgress = tableCleanupTotal ? Math.round((tableCleanupCompleted / tableCleanupTotal) * 100) : 0;
  const auditCorrectionCount = consistencyStatus === 'completed' ? '已完成' : consistencyStatus === 'running' ? '比对修复中'
    : `${consistencyExtractCompleted}/${consistencyExtractTotal}`;
  const contentCorrectionProgress = tableCleaning ? tableCleanupProgress : auditProgress;
  const contentCorrectionCount = tableCleaning
    ? tableCleanupTotal ? `${tableCleanupCompleted}/${tableCleanupTotal}` : '检查中'
    : auditCorrectionCount;
  const wordTargetText = minimumWords > 0 && maximumWords > 0 ? `${minimumWords} 至 ${maximumWords} 字` : minimumWords > 0 ? `不少于 ${minimumWords} 字` : maximumWords > 0 ? `不超过 ${maximumWords} 字` : '未限制';
  const pageAssistantState = resolvePageAssistantState(contentStats, outlineWordControlSnapshot);
  const {
    measuredPages,
    requirementText: pageRequirementText,
    accepted: pageCountAccepted,
    measurementLabel: pageMeasurementLabel,
  } = pageAssistantState;
  const pageMeasurementStale = isPageMeasurementStale(sections, task?.updated_at, measuredPages);
  const naturalizeAssistantState = resolveNaturalizeAssistantState(contentStats, naturalizing);
  const naturalizeFailed = naturalizeAssistantState.failed;
  const htmlOutputProgress = progressDetail?.mode === 'html' || progressDetail?.mode === 'html-single';
  const currentProgressDetail = (phaseVisible || htmlOutputProgress) && progressDetail?.phase === contentStats?.phase ? progressDetail : undefined;
  // 任务成功且 Word 全部转换后展示整体完成信号，只改页面文案，不改变后端阶段和进度计算。
  const contentCompleted = htmlOutputProgress && task?.status === 'success' && currentProgressDetail?.phase === 'word-completed';
  const singleSectionCompleted = contentCompleted && currentProgressDetail?.mode === 'html-single';
  const completedLabel = singleSectionCompleted ? '小节修改完成' : '全部完成';
  const completedImageCount = Object.values(contentStats?.workflow_progress?.steps['generating/0/images']?.items || {})
    .filter((item) => item.status === 'success').length;
  const completedDescription = singleSectionCompleted
    ? '小节修改完成，Word 已更新。'
    : `正文生成全部完成：共 ${currentProgressDetail?.total || 0} 个小节，实际 ${contentStats?.generated_html_words || 0} 字${completedImageCount ? `，新增配图 ${completedImageCount} 张` : ''}，Word 已全部生成。`;
  const displayProgress = htmlOutputProgress ? task?.progress || 0 : currentProgressDetail ? currentProgressDetail.phase_progress : planning ? planningProgress : contentCorrecting ? contentCorrectionProgress : progress;
  const displayProgressLabel = exportRepairCompleted ? '导出修复结束' : contentCompleted ? completedLabel : currentProgressDetail ? currentProgressDetail.phase_label : planning ? '编排统计' : restoring ? '原方案还原' : contentCorrecting ? '内容矫正' : '生成统计';
  // 编辑类步骤按累计完成数展示，不以随分批派发增长的已派发数作分母。
  const displayProgressCount = exportRepairing
    ? exportRepairCompleted ? '已结束' : taskFailed ? '失败' : paused ? '已暂停' : '处理中'
    : currentProgressDetail?.cumulative && currentProgressDetail.unit
    ? `已完成 ${currentProgressDetail.completed} ${currentProgressDetail.unit}${currentProgressDetail.failed ? `，失败 ${currentProgressDetail.failed} ${currentProgressDetail.unit}` : ''}`
    : currentProgressDetail?.unit
    ? `${currentProgressDetail.completed}/${currentProgressDetail.total}${currentProgressDetail.unit}`
    : currentProgressDetail?.indeterminate ? '处理中' : auditing ? auditCorrectionCount : htmlOutputProgress && currentProgressDetail
    ? `${currentProgressDetail.completed}/${currentProgressDetail.total}`
    : planning
    ? `${planningCompleted}/${planningTotal}`
    : restoring && currentProgressDetail
      ? `${currentProgressDetail.completed}/${currentProgressDetail.total}`
    : contentCorrecting
      ? contentCorrectionCount
          : `${completedCount}/${leaves.length}`;
  const progressPhaseLabel = exportRepairCompleted ? '导出修复结束' : contentCompleted ? completedLabel : currentProgressDetail ? currentProgressDetail.phase_label : planning ? '正文编排' : restoring ? '原方案还原' : contentCorrecting ? '内容矫正' : '正文生成';
  const progressTone = planning || contentCompleted || exportRepairCompleted
    ? 'success'
    : contentCorrecting
      ? 'sky'
      : 'primary';
  const progressActive = taskInFlight && (htmlOutputProgress || planning || restoring || contentCorrecting || naturalizing || pageAdjusting);
  const stepSeconds = currentProgressDetail?.started_at
    ? Math.max(0, Math.floor(((taskInFlight ? progressNow : Date.parse(task?.updated_at || currentProgressDetail.started_at)) - Date.parse(currentProgressDetail.started_at)) / 1000)) : 0;
  const workflowDescription = currentProgressDetail?.started_at ? [
    currentProgressDetail.step_label,
    currentProgressDetail.unit
      ? `成功 ${currentProgressDetail.completed}${currentProgressDetail.cumulative ? '' : `/${currentProgressDetail.total}`} ${currentProgressDetail.unit}` : '',
    currentProgressDetail.running ? `处理中 ${currentProgressDetail.running}（含队列等待）` : '',
    currentProgressDetail.pending ? `待处理 ${currentProgressDetail.pending}` : '',
    currentProgressDetail.failed ? `失败或待修复 ${currentProgressDetail.failed}` : '',
    currentProgressDetail.cancelled ? `已中断 ${currentProgressDetail.cancelled}` : '',
    currentProgressDetail.detail_text, currentProgressDetail.activity,
    `本次步骤用时 ${Math.floor(stepSeconds / 60)}分${stepSeconds % 60}秒`,
  ].filter(Boolean).join('；') : '';
  const progressDescription = developerStageGate
    ? `${progressPhaseLabel}阶段已完成。可继续下一阶段，或从正文编排重新执行全部阶段。`
    : taskFailed
    ? taskErrorMessage
    : exportRepairing
    ? exportRepairCompleted ? '导出修复已结束，请重新点击导出。'
      : paused ? '导出修复已暂停，继续时沿用原正文会话。'
      : pausing ? '正在暂停导出修复。'
      : currentProgressDetail?.step_label || '正在修复导出正文。'
    : contentCompleted
    ? completedDescription
    : workflowDescription
    ? `${paused ? '已暂停：' : ''}${workflowDescription}`
    : naturalizing
    ? `${paused ? '已暂停：' : ''}AI 去痕审校 ${contentStats?.naturalize_completed || 0}/${contentStats?.naturalize_total || 0} 个小节${contentStats?.naturalize_failed ? `，${contentStats.naturalize_failed} 节保留原文待复核` : ''}。`
    : pageAdjusting
    ? `${paused ? '已暂停：' : ''}目标 ${contentStats?.target_pages || outlineWordControlSnapshot?.targetPages || 0} 页${contentStats?.measured_pages ? `，当前实测 ${contentStats.measured_pages} 页` : '，正在组装整本 Word 并实际分页'}。${contentStats?.page_adjustment_warning || ''}`
    : layoutChecking
    ? `${paused ? '已暂停：' : ''}${currentProgressDetail?.step_label || '正在检测页栏留白'}，补写 ${contentStats?.layout_completed || 0}/${contentStats?.layout_total || 0} 个小节。`
    : htmlOutputProgress && currentProgressDetail && ['generating', 'sections-completed', 'word-converting', 'word-completed'].includes(currentProgressDetail.phase)
    ? `${paused ? '已暂停：' : ''}${currentProgressDetail.phase_label}，${currentProgressDetail.phase === 'generating' ? '已保存' : '已完成'} ${currentProgressDetail.completed}/${currentProgressDetail.total} 个小节。`
    : planning
    ? paused ? `正文生成已暂停在编排阶段，已完成 ${planningCompleted}/${planningTotal} 个小节。` : `正在编排正文结构，已完成 ${planningCompleted}/${planningTotal} 个小节。`
    : restoring
      ? paused
        ? `正文生成已暂停在原方案还原阶段，已完成 ${progressDetail?.completed || 0}/${progressDetail?.total || 0} 个小节。`
        : `${progressDetail?.step_label || '正在还原原方案内容'}，已完成 ${progressDetail?.completed || 0}/${progressDetail?.total || 0} 个小节。`
    : auditing
      ? `${paused ? '已暂停：' : ''}${consistencyStatus === 'extracting'
        ? `一致性审计：正在并发核对小节事实，已完成 ${consistencyExtractCompleted}/${consistencyExtractTotal} 个小节。`
        : `一致性审计：主 Agent 跨节比对并统一修复。${contentStats?.consistency_summary || ''}`}`
      : tableCleaning
        ? `${paused ? '已暂停：' : ''}将数据表格转换为普通文字，保留图片表格。${tableCleanupTotal ? `已处理 ${tableCleanupCompleted}/${tableCleanupTotal} 个小节。` : '正在检查本次正文。'}`
          : pausing
            ? '正在暂停正文生成，已发出的 AI 请求完成后会停止调度新任务。'
            : running
              ? latestTaskLog || '正文生成任务正在运行。'
              : paused
                ? '正文生成已暂停，可点击继续。'
                : completedCount
                  ? `已生成 ${completedCount} 个小节，共 ${totalWords} 字。`
                  : '点击生成正文后，目录会实时显示每个小节状态。';
  const selectedStatus = selectedItem ? outlineMeta.get(selectedItem.id)?.status || 'idle' : 'idle';
  const generationButtonLabel = pausing
    ? '正在暂停中...'
    : running
      ? '暂停'
      : paused
        ? '继续'
        : retryingExportRepair
          ? '重试导出修复'
        : retryingSectionModification
          ? '重试小节修改'
        : retryingBodyGeneration
          ? '重试正文生成'
        : retryingConsistency
          ? '继续一致性审计'
        : retryingNaturalize
          ? '继续 AI 去痕'
        : retryingPageAdjustment
          ? '继续页数校正'
        : retryingWordConversion
          ? '重试 Word 转换'
        : retryingTableCleanup
          ? '重试去表格'
        : retryingLayoutCheck
          ? '重试格式自检'
          : completedCount === leaves.length && leaves.length
              ? '重新生成正文'
              : completedCount > 0
                ? '继续生成正文'
                : '生成正文';
  const editing = Boolean(selectedItem && selectedIsLeaf && editingItemId === selectedItem.id);
  const handlePreviewImage = useCallback((src: string, alt: string) => setPreviewImage({ src, alt }), []);

  useEffect(() => {
    if (!outlineData?.outline?.length) {
      setSelectedItemId('');
      return;
    }

    if (!selectedItemId || !findItem(outlineData.outline, selectedItemId)) {
      setSelectedItemId(firstLeafId || outlineData.outline[0].id);
    }
  }, [firstLeafId, outlineData, selectedItemId]);

  useEffect(() => {
    window.yibiao?.config.load()
      .then((config) => {
        setDeveloperMode(Boolean(config.developer_mode));
        if (config.export_format) {
          setExportFormat(config.export_format);
        }
      })
      .catch((error) => console.warn('读取开发者模式失败', error));
  }, []);

  useEffect(() => {
    if (task?.status !== 'running') {
      setPausePending(false);
    }
    if (task?.status !== 'paused') {
      setDeveloperStageActionPending(null);
    }
  }, [task?.status]);

  useEffect(() => {
    if (!selectedItem || selectedItem.id === editingItemId) {
      return;
    }
    setEditingItemId(null);
    setIsPreviewing(false);
    setDraftContent('');
  }, [editingItemId, selectedItem]);

  const pauseGeneration = async () => {
    if (!running) {
      return;
    }

    setPausePending(true);
    try {
      await window.yibiao?.tasks.pauseContentGeneration();
      showToast('正在暂停正文生成，当前 AI 请求完成后会停止调度新任务', 'info');
    } catch (error) {
      setPausePending(false);
      showToast(error instanceof Error ? error.message : '暂停正文生成失败', 'error');
    }
  };

  const resumeGeneration = async () => {
    if (!paused) {
      return;
    }

    if (developerStageGate) setDeveloperStageActionPending('continue');
    try {
      await window.yibiao?.tasks.startContentGeneration({
        resume: true,
        ...(developerStageGate ? { developerStageAction: 'continue', developerStage: developerStageGate } : {}),
      });
      showToast(developerStageGate ? '已开始执行下一阶段' : '已继续正文生成任务', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '继续正文生成失败', 'error');
    } finally {
      setDeveloperStageActionPending(null);
    }
  };

  // 新建正文会话前确认“版式模板”中保存的模板仍然存在。
  const ensureValidContentTemplate = async () => {
    const template = exportTemplateId ? await window.yibiao?.templates.get(exportTemplateId) : null;
    if (template) return true;
    setTemplateRequiredDialogOpen(true);
    return false;
  };

  // 开发者阶段停点直接复用全量重新生成，不保留当前阶段产物。
  const restartContentGeneration = async () => {
    if (!developerStageGate || developerStageActionPending) return;
    try {
      if (!await ensureValidContentTemplate()) return;
      setDeveloperStageActionPending('restart');
      setEditingItemId(null);
      setIsPreviewing(false);
      setDraftContent('');
      await window.yibiao?.tasks.startContentGeneration({ developerRestart: true, regenerate: true });
      showToast('已从正文编排重新执行全部阶段', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '重新执行正文生成失败', 'error');
    } finally {
      setDeveloperStageActionPending(null);
    }
  };

  // 停止当前任务并清空正文阶段，供开发者从头重试完整流程。
  const resetContentGeneration = async () => {
    if (resetPending) return;
    setResetPending(true);
    try {
      setEditingItemId(null);
      setIsPreviewing(false);
      setDraftContent('');
      await onContentGenerationReset();
      setResetDialogOpen(false);
      showToast('正文阶段已重置', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '重置正文阶段失败', 'error');
    } finally {
      setResetPending(false);
    }
  };

  // 失败重试续接原正文会话及后处理阶段，转换失败则只续转 Word。
  const retryFailedSections = async () => {
    if (taskBlocksGeneration || (!retryingWordConversion && !retryingConsistency && !retryingSectionModification && !retryingBodyGeneration && !retryingTableCleanup && !retryingLayoutCheck && !retryingNaturalize && !retryingPageAdjustment && !retryingExportRepair)) return;
    try {
      await window.yibiao?.tasks.startContentGeneration({ retryFailedSections: true });
      trackConfigUsage({ content_generation_action: 'retry_failed_sections' });
      showToast(retryingExportRepair ? '导出修复已从原会话继续' : retryingPageAdjustment ? '目标页数校正已从实测进度继续' : retryingNaturalize ? 'AI 去痕审校已从已完成小节继续' : retryingLayoutCheck ? '格式自检已从原进度继续' : retryingTableCleanup ? '去表格已从原会话继续' : retryingSectionModification ? '小节修改已从原会话继续' : retryingBodyGeneration ? '正文生成已从原会话继续' : retryingConsistency ? '一致性审计已从原会话继续' : retryingWordConversion ? 'Word 转换重试已在后台启动' : '失败小节重试任务已在后台启动', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动失败小节重试失败', 'error');
    }
  };

  // 暂停继续与失败重试按当前阶段处理，避免修复失败误入重新生成。
  const handleGenerationButtonClick = () => {
    if (running) {
      void pauseGeneration();
      return;
    }
    if (paused) {
      void resumeGeneration();
      return;
    }
    if (retryingWordConversion || retryingConsistency || retryingSectionModification || retryingBodyGeneration || retryingTableCleanup || retryingLayoutCheck || retryingNaturalize || retryingPageAdjustment || retryingExportRepair) {
      void retryFailedSections();
      return;
    }
    void startGeneration();
  };

  const launchContentGeneration = async ({
    savedGenerationOptions,
    config,
    regenerate,
    contentGenerationAction,
  }: {
    savedGenerationOptions: ContentGenerationOptions;
    config?: ClientConfig | null;
    regenerate: boolean;
    contentGenerationAction: ContentGenerationAction;
  }) => {
    if (!outlineData?.outline?.length) {
      showToast('请先生成目录', 'info');
      return;
    }

    if (regenerate) {
      setEditingItemId(null);
      setIsPreviewing(false);
      setDraftContent('');
    }

    await window.yibiao?.tasks.startContentGeneration({
      regenerate,
      generationOptions: savedGenerationOptions,
    });
    trackConfigUsage({
      table_requirement: savedGenerationOptions.tableRequirement,
      use_mermaid_images: savedGenerationOptions.useMermaidImages,
      use_ai_images: savedGenerationOptions.useAiImages,
      image_quantity: savedGenerationOptions.imageQuantity,
      ...buildImageLayoutUsage(savedGenerationOptions),
      content_generation_action: contentGenerationAction,
      enable_consistency_audit: true,
      consistency_repair_mode: 'agent',
      enable_original_plan_coverage_audit: false,
    }, config);
    showToast(regenerate ? '正文重新生成任务已在后台启动' : '正文生成任务已在后台启动', 'success');
  };

  // AI 生图开启但生图模型不可用时先弹窗提醒；用户继续后直接关闭本项目 AI 生图，编排阶段不再安排 AI 图片。
  const resolveAiImageOptions = async (
    options: ContentGenerationOptions,
    imageModelAvailable: boolean,
    target: 'generation' | 'section',
    disableAiImages: boolean,
  ) => {
    if (options.imageQuantity <= 0 || !options.useAiImages) return options;
    if (disableAiImages) {
      const nextOptions = { ...options, useAiImages: false };
      await onContentGenerationOptionsChange(nextOptions);
      return nextOptions;
    }
    if (imageModelAvailable) return options;
    setAiImageUnavailableTarget(target);
    return null;
  };

  // 启动前提醒当前模型并发偏低；用户确认后仍使用最新配置，重复点击不重复提交。
  const startGeneration = async (confirmedConcurrency = false, disableAiImages = false) => {
    if (generationStarting.current || taskBlocksGeneration || (concurrencyWarning && !confirmedConcurrency)) return;
    if (!outlineData?.outline?.length) {
      showToast('请先生成目录', 'info');
      return;
    }

    generationStarting.current = true;
    setGenerationSubmitting(true);
    if (confirmedConcurrency) setConcurrencyWarning('');
    try {
      if (!await ensureValidContentTemplate()) return;
      const config = await window.yibiao?.config.load();
      if (config && !confirmedConcurrency && (config.concurrency_limit < 50 || config.image_model.concurrency_limit < 50)) {
        setConcurrencyWarning(`当前设置的文本模型并发${config.concurrency_limit}，生图模型并发${config.image_model.concurrency_limit}，建议设置50或更高，否则生成速度会比较慢`);
        return;
      }
      const nextImageModelStatus = config?.image_model?.status || 'untested';
      const nextImageModelAvailable = nextImageModelStatus === 'available';
      const savedGenerationOptions = await resolveAiImageOptions(
        normalizeContentGenerationOptions(contentGenerationOptions, nextImageModelAvailable),
        nextImageModelAvailable,
        'generation',
        disableAiImages,
      );
      if (!savedGenerationOptions) return;
      const regenerate = leaves.length > 0 && completedCount === leaves.length;
      const contentGenerationAction: ContentGenerationAction = regenerate
          ? 'regenerate'
          : completedCount > 0
            ? 'continue'
            : 'start';
      await launchContentGeneration({ savedGenerationOptions, config, regenerate, contentGenerationAction });
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动正文生成任务失败', 'error');
    } finally {
      generationStarting.current = false;
      setGenerationSubmitting(false);
    }
  };

  const openPageOptimizationDialog = () => {
    setPageOptimizationDraft({
      targetPages: String(outlineWordControlSnapshot?.targetPages || 0),
      minimumPages: String(outlineWordControlSnapshot?.minimumPages || 0),
      maximumPages: String(outlineWordControlSnapshot?.maximumPages || 0),
    });
    setPageOptimizeDialogOpen(true);
  };

  // 只对当前项目已有的完整 HTML 成稿做实排篇幅优化；篇幅变化节由后台做有限事实与文风复核。
  const startPageOptimization = async () => {
    if (taskBlocksGeneration || !hasEditablePageOptimizationSource) return;
    let pageOptimizationOptions: ReturnType<typeof normalizePageOptimizationDraft>;
    try {
      pageOptimizationOptions = normalizePageOptimizationDraft(pageOptimizationDraft);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '页数设置无效', 'error');
      return;
    }

    setGenerationSubmitting(true);
    try {
      if (!await ensureValidContentTemplate()) return;
      await window.yibiao?.tasks.startContentGeneration({
        pageOptimizeOnly: true,
        pageOptimizationOptions,
      });
      setPageOptimizeDialogOpen(false);
      showToast('标书文件篇幅优化已在后台启动', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动篇幅优化失败', 'error');
    } finally {
      setGenerationSubmitting(false);
    }
  };

  // 已有成稿可单独重做自然化审校；正文逐节安全写回，随后按保存的目标页数重新实测并转换 Word。
  const startNaturalization = async () => {
    if (taskBlocksGeneration || completedCount !== leaves.length || !leaves.length) return;
    setGenerationSubmitting(true);
    try {
      if (!await ensureValidContentTemplate()) return;
      await window.yibiao?.tasks.startContentGeneration({ naturalize: true });
      setNaturalizeDialogOpen(false);
      showToast('AI 去痕审校已在后台启动', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动 AI 去痕审校失败', 'error');
    } finally {
      setGenerationSubmitting(false);
    }
  };

  const startSectionRegeneration = async (disableAiImages = false) => {
    if (taskBlocksGeneration || !outlineData?.outline?.length || !requirementItem) {
      return;
    }

    setSectionSubmitting(true);
    try {
      const config = await window.yibiao?.config.load();
      const nextImageModelStatus = config?.image_model?.status || 'untested';
      const nextImageModelAvailable = nextImageModelStatus === 'available';
      const savedGenerationOptions = await resolveAiImageOptions(
        normalizeContentGenerationOptions(contentGenerationOptions, nextImageModelAvailable),
        nextImageModelAvailable,
        'section',
        disableAiImages,
      );
      if (!savedGenerationOptions) return;
      await window.yibiao?.tasks.startContentGeneration({
        regenerate: true,
        targetItemId: requirementItem.id,
        requirement: regenerateRequirement,
      });
      trackConfigUsage({
        table_requirement: savedGenerationOptions.tableRequirement,
        use_mermaid_images: savedGenerationOptions.useMermaidImages,
        use_ai_images: savedGenerationOptions.useAiImages,
        content_generation_action: 'regenerate_section',
        enable_consistency_audit: false,
        consistency_repair_mode: 'agent',
        enable_original_plan_coverage_audit: false,
      }, config);
      setSelectedItemId(requirementItem.id);
      setRequirementItem(null);
      setRegenerateRequirement('');
      showToast('小节重新生成任务已在后台启动', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '启动小节重新生成失败', 'error');
    } finally {
      setSectionSubmitting(false);
    }
  };

  const startEditingContent = () => {
    if (taskBlocksGeneration) {
      showToast('请先完成当前正文生成任务，再编辑正文', 'info');
      return;
    }

    if (!selectedItem || !selectedIsLeaf) {
      showToast('请选择一个叶子小节后再编辑正文', 'info');
      return;
    }

    setEditingItemId(selectedItem.id);
    setIsPreviewing(false);
    setDraftContent(selectedContent);
  };

  const togglePreview = () => {
    setIsPreviewing((prev) => !prev);
  };

  const cancelEditingContent = () => {
    setEditingItemId(null);
    setIsPreviewing(false);
    setDraftContent('');
  };

  const saveEditingContent = async () => {
    if (taskBlocksGeneration) {
      showToast('当前正文生成任务正在运行或已暂停，暂不能保存正文', 'info');
      return;
    }

    if (!selectedItem || !selectedIsLeaf || !outlineData?.outline?.length) {
      return;
    }

    try {
      await onContentSaved(selectedItem, draftContent);
      setEditingItemId(null);
      setIsPreviewing(false);
      showToast('正文已保存', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '正文保存失败', 'error');
    }
  };

  // 每次明确点击都读取最新正文；重复点击同一小节也生成新的临时 Word。
  const selectOutlineItem = (item: OutlineItem) => {
    setSelectedItemId(item.id);
    if (!item.children?.length && item.content_mode === 'ai-generate') {
      setWordPreviewRequest((previous) => ({ sectionId: item.id, context: wordContentContext, version: (previous?.version || 0) + 1 }));
    }
  };

  const renderTree = (items: OutlineItem[], level = 0): ReactNode => items.map((item) => {
    const meta = outlineMeta.get(item.id);
    const status = meta?.status || 'idle';
    const isLeaf = !item.children?.length;
    const previewReady = isLeaf && item.content_mode === 'ai-generate' && previewReadySectionIds.has(item.id);
    const leafCount = meta?.leafCount || 0;
    const words = meta?.words || 0;
    const modeLabel = isLeaf && item.content_mode ? OUTLINE_CONTENT_MODE_LABELS[item.content_mode] : '';

    return (
      <div className="content-outline-node" key={item.id} style={{ '--content-level': level } as CSSProperties}>
        <button
          type="button"
          className={`content-outline-item is-${status}${selectedItemId === item.id ? ' is-active' : ''}`}
          onClick={() => selectOutlineItem(item)}
        >
          <span className="content-outline-dot" aria-hidden="true" />
          <span className="content-outline-text">
            <strong>{formatOutlineTitle(item.number, item.title, exportFormat.headings[Math.min(level, 5)])}</strong>
            <small>{isLeaf ? item.content_mode === 'ai-generate' ? `${modeLabel} · ${status === 'success' ? '已完成' : statusLabels[status]} · ${previewReady ? '可预览' : 'Word 预览'}` : `${modeLabel || '未标记'} · ${statusLabels[status]} · ${words} 字` : `${leafCount} 个小节`}</small>
          </span>
          {isLeaf && item.content_mode === 'ai-generate' && (status === 'success' || status === 'error') ? (
            <Popover.Root
              open={!taskBlocksGeneration && confirmRegenerateItem?.id === item.id}
              onOpenChange={(open) => setConfirmRegenerateItem(open && !taskBlocksGeneration ? item : null)}
            >
              <Popover.Trigger asChild>
                <em
                  className={taskBlocksGeneration ? undefined : 'is-clickable'}
                  aria-disabled={taskBlocksGeneration}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (taskBlocksGeneration) event.preventDefault();
                  }}
                >重新生成</em>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content className="content-regenerate-popover" side="top" align="end" sideOffset={8}>
                  <strong>重新生成此小节？</strong>
                  <span>{status === 'error' ? '将重新尝试生成失败的小节。' : '将覆盖当前正文内容。'}</span>
                  <div>
                    <button
                      type="button"
                      className="primary-action"
                      disabled={taskBlocksGeneration}
                      onClick={() => {
                        setRequirementItem(item);
                        setRegenerateRequirement('');
                        setConfirmRegenerateItem(null);
                      }}
                    >是</button>
                    <Popover.Close className="secondary-action" type="button">否</Popover.Close>
                  </div>
                  <Popover.Arrow className="content-regenerate-popover-arrow" />
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          ) : (
            <em>{isLeaf && item.content_mode === 'ai-generate' ? '查看 Word' : statusLabels[status]}</em>
          )}
        </button>
        {item.children?.length ? renderTree(item.children, level + 1) : null}
      </div>
    );
  });

  if (!outlineData?.outline?.length) {
    return (
      <div className="plan-step-body content-generation-page">
        <section className="markdown-empty-state content-generation-empty">
          <strong>暂无目录</strong>
          <p>请先在目录生成步骤完成技术方案目录，再进入正文生成。</p>
        </section>
      </div>
    );
  }

  return (
    <div className="plan-step-body content-generation-page">
      <section className="content-generation-command-bar">
        <div>
          <span className="section-kicker">STEP {stepNumber}</span>
          <strong>正文生成</strong>
          <p>只对标记为“AI生成”的叶子小节生成正文，其他模式保留为待处理。</p>
        </div>
        <div className="content-generation-stats" aria-label="正文生成统计">
          <span><strong>{leaves.length}</strong> 个 AI 小节</span>
          {typeof contentStats?.word_conversion_completed === 'number' && <span><strong>{contentStats.word_conversion_completed}</strong> 本次 Word 已转换</span>}
          <span title={`模板填写 ${modeCounts['template-fill']}，目录生成 ${modeCounts['directory-generate']}，人工填写 ${modeCounts['manual-fill']}，其他模式 ${modeCounts.other}`}><strong>{pendingCount}</strong> 待处理</span>
          {hasOriginalPlan && (
            <span title="按原方案导入的图片引用统计，回填时同时核对本地资源；原图不受新增配图数量设置影响。">
              原方案图片 <strong>{originalRestoration && typeof originalRestoration.total_images === 'number'
                ? `${originalRestoration.restored_images}/${originalRestoration.total_images}` : '待统计'}</strong>
            </span>
          )}
          {hasOriginalPlan && (
            <span title={originalRestoration
              ? `已回填 ${originalRestoration.restored_words.toLocaleString()} / 原文共 ${originalRestoration.total_words.toLocaleString()} 字。已还原原文字数 ÷ 原方案总字数，使用相同可读字数口径，不计新增目录标题和结构标记，不代表后续扩写的内容保留率。${originalRestoration.rate === null ? '没有可统计内容。' : ''}`
              : '原方案还原完成后统计。'}>
              原方案还原率 <strong>{originalRestoration
                ? originalRestoration.rate === null ? '—' : `${originalRestoration.rate.toFixed(1)}%`
                : '待统计'}</strong>
            </span>
          )}
        </div>
        <div className="content-generation-actions">
          {developerMode && (
            <button
              type="button"
              className="danger-action"
              onClick={() => setResetDialogOpen(true)}
              disabled={resetPending}
            >
              {resetPending ? '正在重置...' : '重置正文阶段'}
            </button>
          )}
          {developerStageGate ? (
            <>
              <button
                type="button"
                className="secondary-action"
                onClick={() => void restartContentGeneration()}
                disabled={Boolean(developerStageActionPending)}
              >
                {developerStageActionPending === 'restart' ? '正在重新执行...' : '从正文编排重新执行'}
              </button>
              <button
                type="button"
                className="primary-action"
                onClick={() => void resumeGeneration()}
                disabled={Boolean(developerStageActionPending)}
              >
                {developerStageActionPending === 'continue' ? '正在继续...' : '继续下一阶段'}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="primary-action" onClick={handleGenerationButtonClick} disabled={generationSubmitting || sectionSubmitting || pausing || !leaves.length}>
                {generationButtonLabel}
              </button>
            </>
          )}
        </div>
      </section>

      <section className="content-generation-workspace">
        <aside className="content-outline-panel">
          <div className="analysis-result-head">
            <strong>标书目录</strong>
            <span>{leaves.length} 个小节</span>
          </div>
          <div className={`content-outline-stats${statsCollapsed ? ' is-collapsed' : ''}`}>
            <button type="button" onClick={() => setStatsCollapsed((prev) => !prev)} aria-expanded={!statsCollapsed}>
              <span>{displayProgressLabel}</span>
              <strong>{displayProgressCount}</strong>
              <em>{statsCollapsed ? '展开' : '折叠'}</em>
            </button>
            {!statsCollapsed && (
              <div className="content-outline-stats-body">
                <ProgressBar value={displayProgress} tone={progressTone} active={progressActive} label={`${progressPhaseLabel}进度 ${displayProgress}%`} />
                <p>{progressDescription}</p>
                {failedCount > 0 && <small>失败 {failedCount} 个小节</small>}
              </div>
            )}
          </div>
          <div className="content-outline-list">
            {renderTree(outlineData.outline)}
          </div>
        </aside>

        <article className="content-reader-panel">
          <div className="content-reader-head">
            <div>
              <span className="section-kicker">正文内容</span>
              <strong>{selectedItem ? `${selectedItem.number} ${selectedItem.title}` : '选择小节'}</strong>
              <p>{selectedItem?.description || '选择左侧目录项查看生成正文。'}</p>
            </div>
            <div className="content-reader-actions">
              <span className={`content-status-badge is-${selectedIsWord ? 'pending' : selectedStatus}`}>{selectedIsWord ? 'Word 只读预览' : statusLabels[selectedStatus]}</span>
              {selectedIsWord ? null : editing ? (
                <>
                  <button type="button" className={isPreviewing ? 'secondary-action' : 'primary-action'} onClick={togglePreview}>
                    {isPreviewing ? '编辑' : '预览'}
                  </button>
                  <button type="button" className="primary-action" onClick={saveEditingContent} disabled={taskBlocksGeneration}>保存</button>
                  <button type="button" className="secondary-action" onClick={cancelEditingContent}>取消</button>
                </>
              ) : (
                <button type="button" className="secondary-action" onClick={startEditingContent} disabled={!selectedItem || !selectedIsLeaf || taskBlocksGeneration}>编辑</button>
              )}
            </div>
          </div>

          {selectedItem && selectedIsWord ? (
            <ContentWordPreview key={selectedItem.id} sectionId={selectedItem.id} requestVersion={wordRequestVersion} contentContext={wordContentContext} />
          ) : selectedItem && selectedIsLeaf && editing && !isPreviewing ? (
            <MarkdownEditor
              value={draftContent}
              onChange={setDraftContent}
              placeholder="输入 Markdown 正文..."
              disabled={taskBlocksGeneration}
            />
          ) : selectedItem && selectedIsLeaf && editing && isPreviewing ? (
            <MarkdownFullscreenViewer className="markdown-viewer content-generation-output export-format-preview" style={exportFormatPreviewStyle} title="正文预览全屏查看">
              {draftContent.trim() ? (
                <MarkdownContent content={draftContent} onPreviewImage={handlePreviewImage} />
              ) : (
                <p className="content-editor-empty">暂无预览内容</p>
              )}
            </MarkdownFullscreenViewer>
          ) : selectedItem && selectedIsLeaf && selectedContent.trim() ? (
            <MarkdownFullscreenViewer className="markdown-viewer content-generation-output export-format-preview" style={exportFormatPreviewStyle} title={`${selectedItem.number} ${selectedItem.title}全屏查看`}>
              <MarkdownContent content={selectedContent} onPreviewImage={handlePreviewImage} />
            </MarkdownFullscreenViewer>
          ) : selectedItem && selectedIsLeaf ? (
            <div className="markdown-empty-state content-generation-empty">
              <strong>{getLeafStatus(selectedItem, sections) === 'error'
                ? sections[selectedItem.id]?.error || '正文生成失败'
                : selectedItem.content_mode === 'ai-generate' ? '正文待生成' : '该小节等待后续处理'}</strong>
              <p>{selectedItem.content_mode && selectedItem.content_mode !== 'ai-generate'
                ? `${pendingModeDescriptions[selectedItem.content_mode]}${selectedItem.content_mode === 'other' && selectedItem.content_mode_note ? ` ${selectedItem.content_mode_note}` : ''}`
                : taskInFlight ? '如果该小节正在生成，模型返回内容后会实时显示在这里。' : paused ? '任务已暂停，可点击继续。' : '点击生成正文后，后台会按 AI 生成小节生成内容。'}</p>
            </div>
          ) : (
            <div className="markdown-empty-state content-generation-empty">
              <strong>当前是目录分组</strong>
              <p>该目录下包含 {selectedItem?.children ? collectLeafItems(selectedItem.children).length : 0} 个小节，请选择叶子小节查看具体正文。</p>
            </div>
          )}
        </article>

        <aside className="content-assistant-panel" aria-label="编制助手">
          <div className="content-assistant-head">
            <span className="section-kicker">编制助手</span>
            <strong>篇幅与审校</strong>
            <p>只显示当前工作区的真实生成与实排结果。</p>
          </div>

          <section className="content-assistant-card is-page-count">
            <div className="content-assistant-card-head">
              <span>目标篇幅</span>
              <em className={pageCountAccepted && !pageMeasurementStale ? 'is-success' : measuredPages > 0 ? 'is-warning' : ''}>
                {pageMeasurementStale
                  ? '正文已修改'
                  : measuredPages > 0 ? pageCountAccepted ? '最近实排达标' : '待复核' : '待实排'}
              </em>
            </div>
            <dl className="content-assistant-metrics">
              <div><dt>页数要求</dt><dd>{pageRequirementText}</dd></div>
              <div><dt>最近实排</dt><dd>{measuredPages > 0 ? `${measuredPages} 页` : '—'}</dd></div>
              <div><dt>计页方式</dt><dd>{pageMeasurementLabel}</dd></div>
            </dl>
            {contentStats?.page_adjustment_warning && <p className="content-assistant-warning">{contentStats.page_adjustment_warning}</p>}
            {measuredPages > 0 && <small>正文或导出模板变更后，需要重新实排才能确认最终页数。</small>}
            <button
              type="button"
              className="secondary-action"
              onClick={openPageOptimizationDialog}
              disabled={Boolean(pageOptimizationDisabledReason)}
              aria-describedby={pageOptimizationDisabledReason ? 'page-optimize-disabled-reason' : undefined}
            >
              标书篇幅优化
            </button>
            {pageOptimizationDisabledReason && <small id="page-optimize-disabled-reason">{pageOptimizationDisabledReason}</small>}
          </section>

          <section className="content-assistant-card">
            <div className="content-assistant-card-head">
              <span>写作审校</span>
              <em className={naturalizeAssistantState.tone === 'neutral' ? '' : `is-${naturalizeAssistantState.tone}`}>
                {naturalizeAssistantState.label
                  || (contentGenerationOptions?.naturalizeWriting !== false ? '首稿按需审校' : '可手动全篇审校')}
              </em>
            </div>
            <strong>标准首稿与按需审校</strong>
            <p>{contentGenerationOptions?.naturalizeWriting !== false
              ? '首稿按自然文风标准生成，并合并事实一致性审查；系统只重写未通过、未知或内容变化的小节。需要时可手动发起全篇 AI 去痕复审。'
              : '首稿仍按自然表达与事实要求生成；自动文风重写已关闭，事实一致性审查仍按流程执行。需要时可手动发起全篇 AI 去痕复审。'}</p>
            <button
              type="button"
              className="secondary-action"
              onClick={() => setNaturalizeDialogOpen(true)}
              disabled={taskBlocksGeneration || completedCount !== leaves.length || !leaves.length}
            >
              重新执行 AI 去痕
            </button>
            {naturalizeFailed ? <small>{naturalizeFailed} 个小节保留原文，需要人工复核。</small> : null}
          </section>

          <section className="content-assistant-card is-checks">
            <div className="content-assistant-card-head">
              <span>成稿检查</span>
              <em>{completedCount}/{leaves.length} 小节</em>
            </div>
            <ul>
              <li className={consistencyPassed ? 'is-complete' : consistencyNeedsReview ? 'is-warning' : ''}>
                <span aria-hidden="true">•</span>
                <div>
                  <strong>事实一致性</strong>
                  <small>{consistencyNeedsReview
                    ? `${consistencyRemainingIssues.length} 项仍需人工复核`
                    : consistencyCompleted ? '已完成跨节比对' : auditing ? '正在核对' : '随正文任务执行'}</small>
                  {consistencyNeedsReview && (
                    <details className="content-consistency-issues">
                      <summary>查看待复核详情</summary>
                      <div>
                        {consistencyRemainingIssues.map((issue, index) => <p key={`${index}-${issue}`}>{issue}</p>)}
                      </div>
                    </details>
                  )}
                </div>
              </li>
              <li className={contentCompleted ? 'is-complete' : ''}>
                <span aria-hidden="true">•</span>
                <div><strong>Word 转换</strong><small>{contentCompleted ? '已生成当前成稿' : '正文完成后转换'}</small></div>
              </li>
              <li>
                <span aria-hidden="true">•</span>
                <div><strong>暗标合规</strong><small>导出后可进入暗标合规检查</small></div>
              </li>
            </ul>
          </section>
        </aside>
      </section>

      <AppDialog
        open={pageOptimizeDialogOpen}
        onOpenChange={(open) => !generationSubmitting && setPageOptimizeDialogOpen(open)}
        kicker="成稿实排"
        title="标书文件篇幅优化"
        description="基于当前项目已生成的正文和当前导出模板进行优化，不会重新生成目录或整本正文，也不会读取任意外部 Word 的手工修改。系统只对篇幅优化中发生变化的小节补做有限事实与文风复核，必要修复后再实测一次页数，不会整本重写。执行前会保留当前正文备份；优先用本机 Microsoft Word 实排，不可用时采用内置布局并提示差异，导出后需复核。无法达到目标时会明确提示并保留可复核版本。"
        cardClassName="content-page-optimize-card"
        preventClose={generationSubmitting}
        actions={(
          <>
            <button type="button" className="secondary-action" onClick={() => setPageOptimizeDialogOpen(false)} disabled={generationSubmitting}>取消</button>
            <button type="button" className="primary-action" onClick={() => void startPageOptimization()} disabled={generationSubmitting}>{generationSubmitting ? '正在启动...' : '开始优化'}</button>
          </>
        )}
      >
        <div className="content-page-optimize-form">
          <label>
            <span>目标页数</span>
            <div><input inputMode="numeric" min="0" step="1" value={pageOptimizationDraft.targetPages} disabled={generationSubmitting} onChange={(event) => /^\d*$/.test(event.target.value) && setPageOptimizationDraft((current) => ({ ...current, targetPages: event.target.value }))} /><span>页</span></div>
            <small>填 0 表示不单独指定目标。</small>
          </label>
          <label>
            <span>最少页数</span>
            <div><input inputMode="numeric" min="0" step="1" value={pageOptimizationDraft.minimumPages} disabled={generationSubmitting} onChange={(event) => /^\d*$/.test(event.target.value) && setPageOptimizationDraft((current) => ({ ...current, minimumPages: event.target.value }))} /><span>页</span></div>
            <small>有页数范围时，范围优先验收。</small>
          </label>
          <label>
            <span>最多页数</span>
            <div><input inputMode="numeric" min="0" step="1" value={pageOptimizationDraft.maximumPages} disabled={generationSubmitting} onChange={(event) => /^\d*$/.test(event.target.value) && setPageOptimizationDraft((current) => ({ ...current, maximumPages: event.target.value }))} /><span>页</span></div>
            <small>目标页数必须落在已设范围内。</small>
          </label>
        </div>
        <p className="content-page-optimize-note">本次临时参数不会覆盖“生成设置 → 目标篇幅”中保存的页数模式或字数模式配置。</p>
      </AppDialog>

      <AppDialog
        open={naturalizeDialogOpen}
        onOpenChange={(open) => !generationSubmitting && setNaturalizeDialogOpen(open)}
        kicker="成稿审校"
        title="重新执行 AI 去痕？"
        description="本操作会对全部 AI 正文小节执行付费复审，压缩套话、重复和机械句式，并保护事实、数值、承诺、表格和图片；会产生额外模型调用和费用。完成后会重新转换 Word，并继续执行已设置的页数实排验收。它不保证通过任何 AI 检测器；校验失败的小节会保留原文并标记待复核。"
        actions={(
          <>
            <button type="button" className="secondary-action" onClick={() => setNaturalizeDialogOpen(false)} disabled={generationSubmitting}>取消</button>
            <button type="button" className="primary-action" onClick={() => void startNaturalization()} disabled={generationSubmitting}>{generationSubmitting ? '正在启动...' : '开始审校'}</button>
          </>
        )}
      />

      <AppDialog
        open={Boolean(concurrencyWarning)}
        onOpenChange={(open) => { if (!open) setConcurrencyWarning(''); }}
        title="生成速度提醒"
        description={concurrencyWarning}
        actions={(
          <>
            <button type="button" className="secondary-action" onClick={() => setConcurrencyWarning('')}>取消</button>
            <button type="button" className="primary-action" disabled={generationSubmitting} onClick={() => void startGeneration(true)}>继续生成</button>
          </>
        )}
      />

      <AppDialog
        open={Boolean(aiImageUnavailableTarget)}
        onOpenChange={(open) => { if (!open) setAiImageUnavailableTarget(null); }}
        title="AI 生图不可用"
        description="您启用了AI生图，但检测结果显示不可用。继续生成将关闭本项目的AI生图，改用其他已开启的图片类型，是否继续"
        actions={(
          <>
            <button type="button" className="secondary-action" onClick={() => setAiImageUnavailableTarget(null)}>取消</button>
            <button
              type="button"
              className="primary-action"
              disabled={generationSubmitting || sectionSubmitting}
              onClick={() => {
                const target = aiImageUnavailableTarget;
                setAiImageUnavailableTarget(null);
                void (target === 'section' ? startSectionRegeneration(true) : startGeneration(true, true));
              }}
            >
              继续
            </button>
          </>
        )}
      />

      <AppDialog
        open={templateRequiredDialogOpen}
        onOpenChange={setTemplateRequiredDialogOpen}
        kicker="正文生成"
        title="未选择有效的正文模板"
        description="正文生成前，请先在 STEP 02“版式模板”中选择有效的正文模板。"
        actions={(
          <button
            type="button"
            className="primary-action"
            onClick={() => {
              setTemplateRequiredDialogOpen(false);
              onOpenGenerationSettingsAppearance();
            }}
          >
            确定
          </button>
        )}
      />

      <Dialog.Root
        open={resetDialogOpen}
        onOpenChange={(open) => {
          if (!resetPending) setResetDialogOpen(open);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="content-regenerate-card">
            <div className="content-regenerate-card-head">
              <Dialog.Title>重置正文阶段？</Dialog.Title>
              <Dialog.Description>
                将停止当前正文任务，并清空已生成正文、生成进度、正文编排缓存。目录、全局事实及 Step 02 生成设置会保留。
              </Dialog.Description>
            </div>
            <div className="content-regenerate-actions">
              <Dialog.Close className="secondary-action" type="button" disabled={resetPending}>取消</Dialog.Close>
              <button type="button" className="danger-action" onClick={() => void resetContentGeneration()} disabled={resetPending}>
                {resetPending ? '正在重置...' : '确认重置'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root
        open={Boolean(requirementItem)}
        onOpenChange={(open) => {
          if (!open) {
            setRequirementItem(null);
            setRegenerateRequirement('');
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="content-regenerate-modal" />
          <Dialog.Content className="content-regenerate-card">
            <div className="content-regenerate-card-head">
              <span className="section-kicker">重新生成</span>
              <Dialog.Title>{requirementItem?.number} {requirementItem?.title}</Dialog.Title>
              <Dialog.Description>输入本次重新生成的具体要求，AI 会只覆盖当前小节正文。</Dialog.Description>
            </div>
            <textarea
              value={regenerateRequirement}
              onChange={(event) => setRegenerateRequirement(event.target.value)}
              placeholder="例如：强化实施步骤，减少背景描述，突出设备配置与运维响应。"
            />
            <div className="content-regenerate-actions">
              <Dialog.Close className="secondary-action" type="button">取消</Dialog.Close>
              <button type="button" className="primary-action" onClick={() => void startSectionRegeneration()} disabled={taskBlocksGeneration}>开始重新生成</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root open={Boolean(previewImage)} onOpenChange={(open) => !open && setPreviewImage(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="image-preview-modal" />
          <Dialog.Content className="image-preview-card">
            <Dialog.Close className="image-preview-close" type="button" aria-label="关闭图片预览">×</Dialog.Close>
            <Dialog.Title>{previewImage?.alt || '图片预览'}</Dialog.Title>
            {previewImage && <img src={previewImage.src} alt={previewImage.alt} />}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

export default ContentEditPage;
