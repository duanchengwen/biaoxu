const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { extractAiSource } = require('../utils/aiSourceExtraction.cjs');
const { assertHtmlStructure } = require('../utils/htmlStructure.cjs');
const { imageStructure } = require('./contentGenerationEditTools.cjs');
const { countHtmlWords } = require('./contentGenerationWordTools.cjs');
const { runAiBatch, requestWithFollowUp, writeHtml } = require('./contentGenerationAiBatch.cjs');
const { sharedPrefixMessages } = require('../utils/promptPrefixCache.cjs');
const { protectSemanticBlocks, restoreSemanticBlocks } = require('./contentGenerationNaturalize.cjs');
const { NATURAL_WRITING_STANDARD } = require('./contentGenerationWritingStyle.cjs');
const { readWordLayout } = require('./contentGenerationLayout.cjs');
const {
  isPageCountAccepted,
  pageAdjustmentTarget,
  pageCountDistance,
  resolvePageConstraint,
} = require('../shared/pageBudget.mjs');

const MAX_ROUNDS = 2;
const MEASURE_TIMEOUT_MS = 120000;

function runPowerShell(script, env, signal) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), MEASURE_TIMEOUT_MS);
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(signal.reason || new Error('页数实测已取消'));
      if (code !== 0) return reject(new Error((stderr || stdout || 'Microsoft Word 计页失败').trim().slice(-500)));
      resolve(stdout.trim());
    });
  });
}

// Word COM 会真正重新分页；不读取 docProps/app.xml 中可能陈旧的 Pages 缓存。
async function readMicrosoftWordPages(file, signal) {
  if (process.platform !== 'win32') throw new Error('当前系统不支持 Microsoft Word COM 计页');
  const script = `$ErrorActionPreference='Stop'
$word=$null
$doc=$null
try {
  $word=New-Object -ComObject Word.Application
  $word.Visible=$false
  $word.DisplayAlerts=0
  $doc=$word.Documents.Open($env:YIBIAO_PAGE_DOCX,$false,$true)
  $doc.Repaginate()
  $pages=$doc.ComputeStatistics(2)
  @{pages=[int]$pages}|ConvertTo-Json -Compress
} finally {
  if ($doc -ne $null) { $doc.Close($false); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($doc) }
  if ($word -ne $null) { $word.Quit(); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) }
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}`;
  const output = await runPowerShell(script, { YIBIAO_PAGE_DOCX: path.resolve(file) }, signal);
  const match = output.match(/\{[^\r\n]*"pages"\s*:\s*(\d+)[^\r\n]*\}/);
  const pages = match ? Number(JSON.parse(match[0]).pages) : 0;
  if (!Number.isInteger(pages) || pages <= 0) throw new Error('Microsoft Word 未返回有效页数');
  return { pages, source: 'microsoft-word' };
}

async function measureDocumentPages(file, signal, { wordMeasure = readMicrosoftWordPages, layoutDocument = readWordLayout } = {}) {
  try {
    return await wordMeasure(file, signal);
  } catch (wordError) {
    signal?.throwIfAborted?.();
    const layout = await layoutDocument(file, signal);
    const pages = Array.isArray(layout?.pages) ? layout.pages.length : 0;
    if (!pages) throw new Error(`无法实测 Word 页数；Microsoft Word：${wordError.message}；内置编辑器：未返回有效分页`);
    return {
      pages,
      source: 'docx-editor',
      warning: `Microsoft Word 计页不可用，已采用内置编辑器实际布局（${wordError.message}）；与 Word/WPS 的逐页结果可能不同，导出后请复核。`,
    };
  }
}

async function exportAndMeasure({ exporter, snapshot, directory, signal, wordMeasure, layoutDocument, onActivity }) {
  signal?.throwIfAborted?.();
  onActivity?.({ message: '正在按当前模板组装整本 Word 并重新分页' });
  const output = await exporter.build(snapshot, { layoutCheck: false });
  const file = path.join(directory, `目标页数实测-${Date.now()}.docx`);
  fs.writeFileSync(file, output.buffer);
  const measured = await measureDocumentPages(file, signal, { wordMeasure, layoutDocument });
  return { ...measured, export_warnings: output.warnings || [] };
}

async function measureContentDocumentPages({ exporter, snapshot, signal, wordMeasure, layoutDocument, onActivity }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-page-recheck-'));
  try {
    return await exportAndMeasure({ exporter, snapshot, directory, signal, wordMeasure, layoutDocument, onActivity });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

function buildPageJobs(sections, workspaceDir, ratio) {
  return sections.flatMap(section => {
    const original = fs.readFileSync(path.join(workspaceDir, section.file), 'utf8');
    const protectedContent = protectSemanticBlocks(original, section.protected_block_ids);
    const editableWords = countHtmlWords(protectedContent.text);
    const fromWords = countHtmlWords(original);
    if (editableWords < 80) return [];
    const targetEditableWords = Math.max(80, Math.round(editableWords * ratio));
    if (Math.abs(targetEditableWords - editableWords) < 60) return [];
    return [{ section_id: section.section_id, number: section.number, title: section.title, file: section.file,
      protected_block_ids: section.protected_block_ids || [],
      from_words: fromWords, editable_words: editableWords, target_editable_words: targetEditableWords,
      target_words: fromWords - editableWords + targetEditableWords }];
  });
}

function pageAdjustSystem(direction) {
  return `你是投标技术文件篇幅编辑。请${direction === 'expand' ? '扩写' : '缩写'}一个小节，以协助整本 Word 达到目标页数。
${direction === 'expand'
    ? '补充与本节直接相关且可执行的措施、条件、责任分工、检查方法或交付成果；不得重复已有内容凑篇幅。'
    : '删除套话、重复和冗余修饰，合并相近说明；不得删除实质措施、条件、责任分工和验收要求。'}
${NATURAL_WRITING_STANDARD}
扩缩后的正文必须继续符合以上标准。
不得新增、删除或改变事实、数值、单位、日期、范围、承诺、期限和结论。形如 <!-- yibiao:natural-keep-1 --> 的受保护块必须按原顺序各保留一次，不得修改、复制或删除；其中含表格、图片及关键事实。
保持受限 HTML，以 <!-- yibiao:block --> 开头，保留已有元素 id，不输出标题、Markdown、代码围栏或解释。只输出改写后的完整小节 HTML。`;
}

async function rewritePageJobs({ aiService, workspaceDir, jobs, direction, signal, state, save }) {
  await runAiBatch({
    items: jobs.filter(job => !state.processed_section_ids.includes(job.section_id)),
    signal,
    async run(job, guard) {
      const file = path.join(workspaceDir, job.file);
      const original = fs.readFileSync(file, 'utf8');
      const protectedContent = protectSemanticBlocks(original, job.protected_block_ids);
      const best = await requestWithFollowUp({
        aiService,
        guard,
        logTitle: `目标页数校正-${job.number || job.section_id}-${job.title || ''}`,
        messages: sharedPrefixMessages(pageAdjustSystem(direction), '', `本节：${job.number || ''} ${job.title || job.section_id}\n当前可改文字 ${countHtmlWords(protectedContent.text)} 字，目标约 ${job.target_editable_words} 字。\n\n当前 HTML：\n${protectedContent.text}`),
        evaluate(reply) {
          let html;
          try {
            html = restoreSemanticBlocks(extractAiSource(reply, 'html').trim(), protectedContent.blocks);
            assertHtmlStructure(html, { checkSourceCompleteness: true });
            if (imageStructure(html) !== imageStructure(original)) throw new Error('图片或图片表格结构与原文不一致');
          } catch (error) {
            return { feedback: `上次结果不可用：${error.message}。请保留全部受保护块，重新输出完整 HTML。`, reason: error.message };
          }
          const words = countHtmlWords(html);
          const distance = Math.abs(words - job.target_words);
          const moved = direction === 'expand' ? words > job.from_words : words < job.from_words;
          const feedback = `当前小节共 ${words} 字，目标约 ${job.target_words} 字。请继续${words > job.target_words ? '压缩' : '补充'}并重新输出完整 HTML。`;
          if (!moved) return { feedback, reason: '篇幅没有向目标方向变化' };
          if (distance <= Math.max(80, Math.round(Math.abs(job.target_editable_words - job.editable_words) * 0.25))) return { accept: true, value: html };
          return { value: html, distance, feedback, reason: feedback };
        },
      });
      guard.signal.throwIfAborted();
      writeHtml(file, best);
      state = { ...state,
        completed_section_ids: [...new Set([...state.completed_section_ids, job.section_id])],
        processed_section_ids: [...new Set([...state.processed_section_ids, job.section_id])],
      };
      save(state);
    },
    onError(job, error, { cancelled }) {
      if (cancelled) return;
      state = { ...state,
        processed_section_ids: [...new Set([...state.processed_section_ids, job.section_id])],
        failures: { ...state.failures, [job.section_id]: `${error?.message || error}，已保留校正前正文，建议人工复核` },
      };
      save(state);
    },
  });
  return state;
}

function backupRound(workspaceDir, jobs, round) {
  const directory = path.join(workspaceDir, '程序清单', '页数校正备份', `round-${round}`);
  fs.mkdirSync(directory, { recursive: true });
  for (const job of jobs) fs.copyFileSync(path.join(workspaceDir, job.file), path.join(directory, `${encodeURIComponent(job.section_id)}.html`));
  return directory;
}

function restoreRound(workspaceDir, jobs, directory) {
  for (const job of jobs) {
    const backup = path.join(directory, `${encodeURIComponent(job.section_id)}.html`);
    if (fs.existsSync(backup)) fs.copyFileSync(backup, path.join(workspaceDir, job.file));
  }
}

function pageRequirementLabel(constraint) {
  return constraint.kind === 'range'
    ? `${constraint.minimumPages || '不限下限'}–${constraint.maximumPages || '不限上限'} 页范围`
    : `目标 ${constraint.targetPages} 页`;
}

async function adjustContentToTargetPages({ aiService, exporter, snapshot, workspaceDir, sections, targetPages,
  minimumPages = 0, maximumPages = 0, signal,
  previousState, onProgress = () => {}, onActivity, wordMeasure, layoutDocument }) {
  const constraint = resolvePageConstraint({ mode: 'pages', targetPages, minimumPages, maximumPages });
  if (!constraint.enabled) throw new Error('页数校正至少需要目标页数或一个页数边界');
  const requirement = pageRequirementLabel(constraint);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-page-count-'));
  let state = previousState && typeof previousState === 'object' ? { ...previousState } : {
    status: 'measuring', round: 0, measurements: [], jobs: [],
    completed_section_ids: [], processed_section_ids: [], failures: {}, warnings: [],
  };
  state = { ...state, target_pages: constraint.targetPages, minimum_pages: constraint.minimumPages,
    maximum_pages: constraint.maximumPages, planning_pages: constraint.planningPages, constraint_kind: constraint.kind };
  const save = next => { state = next; onProgress(state); };
  const warn = message => { state = { ...state, warnings: [...new Set([...(state.warnings || []), message])] }; };
  try {
    for (;;) {
      signal?.throwIfAborted?.();
      if (!state.round_start_pages) {
        let measured;
        try {
          measured = await exportAndMeasure({ exporter, snapshot, directory, signal, wordMeasure, layoutDocument, onActivity });
        } catch (error) {
          if (signal?.aborted) throw error;
          warn(`页数要求无法实测：${error.message}。正文保持不变，请导出后人工复核。`);
          save({ ...state, status: 'completed', in_range: false, warning: state.warnings.at(-1) });
          return state;
        }
        if (measured.warning) warn(measured.warning);
        const measurements = [...(state.measurements || []), { round: state.round, pages: measured.pages, source: measured.source }];
        state = { ...state, measured_pages: measured.pages, measurement_source: measured.source, measurements,
          round_start_pages: measured.pages, round_start_distance: pageCountDistance(measured.pages, constraint) };
        save(state);
      }
      if (isPageCountAccepted(state.measured_pages, constraint)) {
        const failureCount = Object.keys(state.failures || {}).length;
        if (failureCount) warn(`${failureCount} 个小节在页数校正时改写失败并保留了原文；实测页数已符合要求，相关小节仍需人工复核。`);
        save({ ...state, status: 'completed', in_range: true, warning: state.warnings?.at(-1) });
        return state;
      }
      if (state.round >= MAX_ROUNDS) {
        warn(`${requirement}，当前实测 ${state.measured_pages} 页；已达到自动校正轮数上限，正文已保留，请导出后人工复核。`);
        save({ ...state, status: 'completed', in_range: false, warning: state.warnings.at(-1) });
        return state;
      }
      const continuingRound = state.status === 'adjusting' && Array.isArray(state.jobs) && state.jobs.length > 0;
      const round = continuingRound ? state.round : state.round + 1;
      const adjustmentTarget = pageAdjustmentTarget(state.measured_pages, constraint);
      const direction = state.measured_pages < adjustmentTarget ? 'expand' : 'shrink';
      // 页数含封面和标题，按正文页的剩余比例分配；仅用于生成改写目标，最终仍以真实分页复测为准。
      const ratio = Math.max(0.45, Math.min(1.8, (adjustmentTarget - 1) / Math.max(1, state.measured_pages - 1)));
      const jobs = continuingRound ? state.jobs : buildPageJobs(sections, workspaceDir, ratio);
      if (!jobs.length) {
        warn(`${requirement}，当前实测 ${state.measured_pages} 页；没有足够的非关键文字可安全扩缩，正文保持不变，请人工复核。`);
        save({ ...state, status: 'completed', in_range: false, warning: state.warnings.at(-1) });
        return state;
      }
      const backupDir = continuingRound && state.backup_dir ? state.backup_dir : backupRound(workspaceDir, jobs, round);
      state = { ...state, status: 'adjusting', round, direction, jobs, backup_dir: backupDir,
        processed_section_ids: continuingRound ? state.processed_section_ids : [],
        completed_section_ids: continuingRound ? state.completed_section_ids : [],
        failures: continuingRound ? state.failures : {},
      };
      save(state);
      try {
        state = await rewritePageJobs({ aiService, workspaceDir, jobs, direction, signal, state, save });
      } catch (error) {
        if (signal?.aborted) throw error;
        warn(`第 ${round} 轮页数校正未完成：${error.message}。失败小节保留校正前正文，请人工复核。`);
      }
      let measured;
      try {
        measured = await exportAndMeasure({ exporter, snapshot, directory, signal, wordMeasure, layoutDocument, onActivity });
      } catch (error) {
        if (signal?.aborted) throw error;
        restoreRound(workspaceDir, jobs, backupDir);
        warn(`第 ${round} 轮改写后无法复测页数，已恢复本轮校正前正文：${error.message}。请人工复核。`);
        save({ ...state, status: 'completed', in_range: false, warning: state.warnings.at(-1) });
        return state;
      }
      if (measured.warning) warn(measured.warning);
      const distance = pageCountDistance(measured.pages, constraint);
      if (distance >= state.round_start_distance) {
        restoreRound(workspaceDir, jobs, backupDir);
        warn(`第 ${round} 轮改写未使实测页数更接近要求，已恢复本轮校正前正文；${requirement}，当前 ${state.round_start_pages} 页，请人工复核。`);
        save({ ...state, status: 'completed', measured_pages: state.round_start_pages, in_range: false, warning: state.warnings.at(-1) });
        return state;
      }
      state = { ...state, status: 'measuring', measured_pages: measured.pages, measurement_source: measured.source,
        measurements: [...state.measurements, { round, pages: measured.pages, source: measured.source }],
        round_start_pages: measured.pages, round_start_distance: distance, jobs: [], backup_dir: '', processed_section_ids: [] };
      save(state);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

module.exports = {
  readMicrosoftWordPages,
  measureDocumentPages,
  measureContentDocumentPages,
  buildPageJobs,
  adjustContentToTargetPages,
};
