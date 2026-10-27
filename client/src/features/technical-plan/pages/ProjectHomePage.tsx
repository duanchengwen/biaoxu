import { useCallback, useEffect, useMemo, useState } from 'react';
import { isLibreOfficeRequiredMessage, ProgressBar, useDocumentParseNotice, useToast } from '../../../shared/ui';
import type { SectionId } from '../../../shared/types/navigation';
import type { BackgroundTaskState, TechnicalPlanState } from '../types';
import { getBidAnalysisTasks } from '../services/bidAnalysisWorkflow';
import { areBidAnalysisTasksReady } from '../services/technicalPlanPresentation.mjs';

interface ProjectHomePageProps {
  onNavigate: (section: SectionId) => void;
}

const stepLabels: Record<TechnicalPlanState['step'], string> = {
  'document-analysis': '导入招标文件',
  'generation-settings': '配置生成规则',
  'bid-analysis': '解析招标文件',
  'outline-generation': '编制技术标目录',
  'global-facts': '核定全局事实',
  'content-edit': '编制与审校正文',
  expand: '扩写改写',
};

const taskLabels: Array<[string, keyof TechnicalPlanState]> = [
  ['多标段识别', 'bidSectionExtractionTask'],
  ['招标文件解析', 'bidAnalysisTask'],
  ['目录生成', 'outlineGenerationTask'],
  ['目录调整', 'outlineAdjustmentTask'],
  ['全局事实生成', 'globalFactsTask'],
  ['全局事实调整', 'globalFactsAdjustmentTask'],
  ['正文生成', 'contentGenerationTask'],
];

const technicalPlanTaskTypes = new Set([
  'bid-section-extraction',
  'bid-analysis',
  'outline-generation',
  'outline-adjustment',
  'global-facts-generation',
  'global-facts-adjustment',
  'content-generation',
]);

function findActiveTask(state: TechnicalPlanState | null) {
  if (!state) return null;
  for (const [label, key] of taskLabels) {
    const task = state[key] as BackgroundTaskState | undefined;
    if (task && ['running', 'pausing', 'paused'].includes(task.status)) return { label, task };
  }
  return null;
}

function ProjectHomePage({ onNavigate }: ProjectHomePageProps) {
  const [state, setState] = useState<TechnicalPlanState | null>(null);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const { showToast } = useToast();
  const { showDocumentParseNotice } = useDocumentParseNotice();

  const refreshState = useCallback(async () => {
    if (!window.yibiao?.technicalPlan) return;
    const latest = await window.yibiao.technicalPlan.loadState();
    setState(latest);
  }, []);

  useEffect(() => {
    let mounted = true;
    let loadInFlight = false;
    let reloadAfterCurrent = false;
    let refreshTimer: number | undefined;
    const load = async () => {
      if (loadInFlight) {
        reloadAfterCurrent = true;
        return;
      }
      loadInFlight = true;
      try {
        const latest = await window.yibiao?.technicalPlan.loadState();
        if (mounted && latest) setState(latest);
      } catch (error) {
        if (mounted) showToast(error instanceof Error ? error.message : '读取当前技术标失败', 'error');
      } finally {
        loadInFlight = false;
        if (mounted) setLoading(false);
        if (mounted && reloadAfterCurrent) {
          reloadAfterCurrent = false;
          void load();
        }
      }
    };
    const scheduleRefresh = (immediate: boolean) => {
      if (immediate) {
        if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
        refreshTimer = undefined;
        void load();
        return;
      }
      // 合并一个时间窗内的事件，而不是不断后移计时器；连续进度也必须定期刷新。
      if (refreshTimer !== undefined) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        void load();
      }, 700);
    };
    void load();
    const unsubscribe = window.yibiao?.tasks?.onTaskEvent<TechnicalPlanState>((event) => {
      const taskType = event.task?.type || '';
      if (!technicalPlanTaskTypes.has(taskType) && !event.technicalPlan && !event.technicalPlanPatch) return;
      const terminal = event.task?.status === 'success' || event.task?.status === 'error' || event.task?.status === 'paused';
      scheduleRefresh(terminal);
    });
    return () => {
      mounted = false;
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      unsubscribe?.();
    };
  }, [showToast]);

  const activeTask = useMemo(() => findActiveTask(state), [state]);
  const tenderFiles = state?.tenderFiles || [];
  const parsedCharacters = tenderFiles.length
    ? tenderFiles.reduce((total, file) => total + (file.markdownChars || 0), 0)
    : state?.tenderFile?.markdownChars || 0;
  const bidReady = Boolean(state && areBidAnalysisTasksReady(state.bidAnalysisTasks, getBidAnalysisTasks('key')));
  const factsReady = Boolean(state?.globalFacts.length && state.globalFactsTask?.status === 'success');
  const contentReady = Boolean(state?.contentGenerationTask?.status === 'success'
    && state.contentGenerationTask.stats?.content?.generation_completed);
  const stages = [
    { label: '导入标书', complete: Boolean(state?.tenderFile) },
    { label: '解析与规划', complete: bidReady },
    { label: '目录与事实', complete: Boolean(state?.outlineData && factsReady) },
    { label: '正文与审校', complete: contentReady },
  ];

  const importTender = async () => {
    if (importing) return;
    setImporting(true);
    try {
      const result = await window.yibiao?.technicalPlan.importTenderDocument();
      if (!result?.success) {
        const message = result?.message || '未导入文件';
        if (message === '已取消选择') return;
        if (isLibreOfficeRequiredMessage(message)) {
          showDocumentParseNotice(message);
          return;
        }
        showToast(message, 'error');
        return;
      }
      await refreshState();
      showToast(result.message || '招标文件已导入', 'success');
      onNavigate('technical-plan');
    } catch (error) {
      const message = error instanceof Error ? error.message : '招标文件导入失败';
      if (isLibreOfficeRequiredMessage(message)) showDocumentParseNotice(message);
      else showToast(message, 'error');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="page-stack project-home-page">
      <section className="project-home-hero" aria-labelledby="project-home-title">
        <div className="project-home-hero-copy">
          <span className="section-kicker">标序 BIDXU</span>
          <h1 id="project-home-title">从招标文件到可审校的技术标成稿</h1>
          <p>在一个本地工作区内完成解析、目录、事实核定、正文生成、篇幅优化与导出检查。</p>
          <div className="project-home-hero-actions">
            {state?.tenderFile ? (
              <button type="button" className="primary-action" onClick={() => onNavigate('technical-plan')}>继续技术标编制</button>
            ) : (
              <button type="button" className="primary-action" onClick={() => void importTender()} disabled={importing || loading}>
                {importing ? '正在解析...' : '导入招标文件'}
              </button>
            )}
            <button type="button" className="secondary-action" onClick={() => onNavigate('feasibility-report')}>可行性研究报告</button>
          </div>
        </div>
        <div className="project-home-hero-mark" aria-hidden="true">
          <span>BID</span>
          <strong>技术标</strong>
          <small>编制 · 审校 · 导出</small>
        </div>
      </section>

      <section className="project-home-workspace" aria-labelledby="project-home-workspace-title">
        <header>
          <div>
            <span className="section-kicker">当前工作区</span>
            <h2 id="project-home-workspace-title">{state?.tenderFile ? state.tenderFile.fileName : '尚未导入招标文件'}</h2>
          </div>
          {state?.tenderFile && <button type="button" className="text-button" onClick={() => onNavigate('technical-plan')}>打开工作台</button>}
        </header>

        {loading ? (
          <div className="project-home-loading" role="status">正在读取本地工作区…</div>
        ) : state?.tenderFile ? (
          <div className="project-home-workspace-body">
            <div className="project-home-document-card">
              <div className="project-home-document-icon" aria-hidden="true">DOC</div>
              <div>
                <strong title={state.tenderFile.fileName}>{state.tenderFile.fileName}</strong>
                <span>{Math.max(1, tenderFiles.length)} 份文件 · {parsedCharacters.toLocaleString('zh-CN')} 字</span>
                {state.tenderFile.selectedSectionTitle && <small>投标范围：{state.tenderFile.selectedSectionTitle}</small>}
              </div>
            </div>
            <div className="project-home-stage-list" aria-label="当前技术标进度">
              {stages.map((stage, index) => (
                <div className={stage.complete ? 'is-complete' : ''} key={stage.label}>
                  <span aria-hidden="true">{stage.complete ? '✓' : index + 1}</span>
                  <strong>{stage.label}</strong>
                </div>
              ))}
            </div>
            <div className="project-home-status-card">
              <span>{activeTask ? '后台任务' : '当前进度'}</span>
              <strong>{activeTask ? activeTask.label : stepLabels[state.step]}</strong>
              {activeTask ? (
                <>
                  <ProgressBar value={activeTask.task.progress || 0} active={activeTask.task.status !== 'paused'} label={`${activeTask.label}进度 ${activeTask.task.progress || 0}%`} />
                  <small>{activeTask.task.status === 'paused'
                    ? '任务已暂停，进入工作台后可继续。'
                    : activeTask.task.logs[activeTask.task.logs.length - 1] || '任务正在进行。'}</small>
                </>
              ) : (
                <small>进入技术标工作台可继续当前步骤。</small>
              )}
            </div>
          </div>
        ) : (
          <div className="project-home-empty">
            <div className="project-home-document-icon" aria-hidden="true">01</div>
            <div><strong>先导入真实招标文件</strong><p>首页不会生成演示项目或虚构进度，导入后才会展示当前标书概览。</p></div>
            <button type="button" className="secondary-action" onClick={() => void importTender()} disabled={importing}>选择文件</button>
          </div>
        )}
      </section>

      <section className="project-home-tools" aria-label="常用入口">
        <button type="button" onClick={() => onNavigate('knowledge-base')}>
          <span>参考资料</span><strong>知识库</strong><small>管理正文可引用的本地资料</small>
        </button>
        <button type="button" onClick={() => onNavigate('template-settings')}>
          <span>导出准备</span><strong>模板设置</strong><small>配置实际 Word 版式与导出样式</small>
        </button>
        <button type="button" onClick={() => onNavigate('blind-check')}>
          <span>导出后</span><strong>暗标合规检查</strong><small>对真实成稿执行暗标规则检查</small>
        </button>
      </section>
    </div>
  );
}

export default ProjectHomePage;
