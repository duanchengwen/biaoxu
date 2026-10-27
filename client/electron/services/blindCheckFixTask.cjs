const fs = require('node:fs');
const path = require('node:path');
const { collectImageColorFacts, writeGrayscaleCopy } = require('./blindCheckImageColor.cjs');
const { agentActivityText, canResumeReviewAgent, runBlindCheckFixAgent } = require('./blindCheckAgent.cjs');
const { FIX_RULE_IDS } = require('./blindCheckPresets.cjs');
const { buildFixItems, buildIssueList, fixScope, issueSummary, newProblemGroups, pendingSummary, reviewForResult } = require('./blindCheckReview.cjs');
const { mapReport } = require('./blindCheckTask.cjs');
const { collectImageTextFacts, collectModelImageTextFacts, redactImageTextInCopy, appendImageTextReport, verifyImageRedactions, verifyRedactionsWithVision } = require('./blindCheckImageText.cjs');
const { measureDocumentPages } = require('./contentGenerationPages.cjs');
const { isPageCountAccepted, resolvePageConstraint } = require('../shared/pageBudget.mjs');

const FIXABLE_RULES = new Set(FIX_RULE_IDS);

function now() {
  return new Date().toISOString();
}

function normalizeFixPageBudget(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const constraint = resolvePageConstraint({
    mode: value.mode === 'words' ? 'words' : 'pages',
    targetPages: value.targetPages ?? value.target_pages,
    minimumPages: value.minimumPages ?? value.minimum_pages,
    maximumPages: value.maximumPages ?? value.maximum_pages,
  });
  return constraint.enabled ? constraint : null;
}

async function safeMeasurePages(file, signal, pageMeasure) {
  try {
    const measured = await pageMeasure(file, signal);
    const pages = Number(measured?.pages || 0);
    if (!Number.isInteger(pages) || pages <= 0) throw new Error('未返回有效页数');
    return {
      pages,
      source: String(measured?.source || 'unknown'),
      warning: String(measured?.warning || ''),
      error: '',
    };
  } catch (error) {
    signal?.throwIfAborted?.();
    return { pages: 0, source: 'unavailable', warning: '', error: error?.message || '无法实测页数' };
  }
}

function buildFixPageGuard(explicitConstraint, sourceMeasurement) {
  if (explicitConstraint) return { origin: 'explicit', constraint: explicitConstraint };
  if (sourceMeasurement.pages > 0) {
    return {
      origin: 'source',
      constraint: {
        enabled: true,
        kind: 'range',
        targetPages: sourceMeasurement.pages,
        minimumPages: 0,
        maximumPages: sourceMeasurement.pages,
        planningPages: sourceMeasurement.pages,
      },
    };
  }
  return { origin: 'source', constraint: { enabled: false, kind: 'none', targetPages: 0, minimumPages: 0, maximumPages: 0, planningPages: 0 } };
}

function exceedsFixPageUpperBound(pages, guard) {
  if (!guard?.constraint?.enabled || !(pages > 0)) return false;
  if (guard.constraint.kind === 'exact') return pages > guard.constraint.targetPages;
  return guard.constraint.maximumPages > 0 && pages > guard.constraint.maximumPages;
}

function pageRequirementText(guard) {
  const constraint = guard.constraint;
  if (guard.origin === 'source') return `不得超过原文 ${constraint.maximumPages} 页`;
  if (constraint.kind === 'exact') return `目标 ${constraint.targetPages} 页`;
  if (constraint.minimumPages > 0 && constraint.maximumPages > 0) return `${constraint.minimumPages}–${constraint.maximumPages} 页`;
  if (constraint.minimumPages > 0) return `不少于 ${constraint.minimumPages} 页`;
  return `不超过 ${constraint.maximumPages} 页`;
}

function assessFixPageBudget({ guard, sourceMeasurement, finalMeasurement, lineBreakFallback }) {
  const requirement = guard.constraint.enabled ? pageRequirementText(guard) : '与原文页数保持一致';
  let accepted = false;
  let reason = '';
  if (!guard.constraint.enabled) {
    reason = `原文页数无法实测，不能建立默认“不增页”预算：${sourceMeasurement.error || '原因未知'}`;
  } else if (finalMeasurement.error) {
    reason = `修复副本无法实测页数：${finalMeasurement.error}`;
  } else if (finalMeasurement.source !== 'microsoft-word') {
    reason = `修复副本仅由${finalMeasurement.source === 'docx-editor' ? '内置编辑器' : finalMeasurement.source}完成分页，尚未经过 Microsoft Word 实测`;
  } else if (guard.origin === 'source' && sourceMeasurement.source !== 'microsoft-word') {
    reason = '原文未经过 Microsoft Word 实测，无法可靠确认修复副本没有增页';
  } else {
    accepted = isPageCountAccepted(finalMeasurement.pages, guard.constraint);
    if (!accepted) reason = `${requirement}，修复副本经 Microsoft Word 实测为 ${finalMeasurement.pages} 页`;
  }
  return {
    origin: guard.origin,
    requirement,
    constraint: guard.constraint,
    source: sourceMeasurement,
    final: finalMeasurement,
    accepted,
    lineBreakFallback: lineBreakFallback || null,
    reason,
  };
}

function pageBudgetFinding(status) {
  if (status.accepted) return null;
  const sourceText = status.source.pages > 0 ? `原文 ${status.source.pages} 页` : '原文页数未知';
  const finalText = status.final.pages > 0 ? `修复副本 ${status.final.pages} 页` : '修复副本页数未知';
  return {
    id: 'page-delivery-budget',
    ruleId: 'page.delivery_budget',
    ruleTitle: '最终交付页数预算',
    category: 'page',
    severity: 'medium',
    message: '最终交付页数未通过实测预算',
    candidate: false,
    count: 1,
    samples: [{
      where: '全文',
      text: `${sourceText}，${finalText}；要求${status.requirement}`,
      detail: status.reason,
      origin: '',
      hint: '请在 Microsoft Word 中复核分页，并只精简非关键冗余内容；不得恢复已脱敏信息，也不得用缩小字号或页边距规避页数要求',
    }],
    items: [],
  };
}

function mapFixReport(report) {
  const after = mapReport(report?.after);
  const validation = report?.validation || {};
  return {
    sourceBytes: Number(report?.source_bytes || 0),
    outputBytes: Number(report?.output_bytes || 0),
    fixes: report?.fixes || {},
    notes: Array.isArray(report?.notes) ? report.notes.map(String) : [],
    // 删除了原文赖以认标题的目录时为 false：之后复查、导出结构和编辑修复副本都要沿用，标题认法才与检查时一致。
    headingFallback: report?.heading_fallback !== false,
    validation: {
      checked: Boolean(validation.checked),
      skippedReason: String(validation.skipped_reason || ''),
      originalErrors: Number(validation.original_errors || 0),
      fixedErrors: Number(validation.fixed_errors || 0),
    },
    afterSummary: after.summary,
    afterStats: after.stats,
    groups: after.groups,
  };
}

/** 修复阶段能否续接 AI 复核会话：选择了 AI 修复，且当前检查条件的复核已成功、会话还在。 */
function reviewForFix(state, input, agentService, ai) {
  if (!ai) return { review: null, reason: '本次选择仅程序修复' };
  const review = state.review;
  if (review?.status !== 'success' || review.inputSignature !== input.signature || !review.review) {
    return { review: null, reason: review?.status === 'error' ? 'AI 复核失败，本次只做了程序修复' : 'AI 复核尚未完成，本次只做了程序修复' };
  }
  if (!canResumeReviewAgent(agentService, input.signature)) return { review: null, reason: 'AI 复核会话已失效，请重新检查后再修复' };
  return { review: review.review, reason: '' };
}

/**
 * 暗标自动修复任务：只修复与当前检查条件一致的成功结果对应的文档。
 * 修复范围取自最终问题清单（复核后的检查结论）：开着的修复项覆盖的问题，选了 AI 修复时再加上没有修复项覆盖的问题。
 * 助手在工作区写出副本、校验并复查，原文件不改动；选了 AI 修复时续接复核会话处理程序修不了的问题，
 * 最后只对修复范围逐条对账。进度只推送不落库，完成时一次提交。
 */
async function runBlindCheckFixTask({ agentService, aiService, workspaceStore, openXmlHelperService, updateTask, checkpointTask, payload, taskControl,
  pageMeasure = measureDocumentPages }) {
  const input = workspaceStore.prepareFixInput();
  if (!input.source || !input.signature) throw new Error('请先选择要检查的投标文件');
  const state = workspaceStore.loadBlindCheck();
  const checkResult = state.result;
  if (checkResult.status !== 'success' || checkResult.inputSignature !== input.signature) {
    throw new Error('请先完成当前文件和格式预设的检查，再进行修复');
  }
  if (state.review?.status === 'running') throw new Error('AI 复核还在进行，请等复核完成后再修复');
  // 启动前用户在弹窗里选择仅程序修复或程序修复 + AI 修复，记下来作为下次的默认选项。
  const ai = payload?.ai === true;
  // 只有调用方显式传入 pageBudget 时才继承技术标页数要求，避免把当前项目预算套到任意上传文件。
  // 未传时在任务内实测所选源文件，以“修复副本不得比原文增页”作为保守默认值。
  const explicitPageBudget = normalizeFixPageBudget(payload?.pageBudget);
  const modelFirst = ai && aiService.getConfig?.().multimodal_enabled === true;
  workspaceStore.setFixAiEnabled(ai);
  // 问题清单按检查结论（复核后的结果），与本次是否选 AI 修复无关；续用复核会话只在选了 AI 修复且会话还在时。
  const checkReview = reviewForResult(checkResult, state.review);
  const scope = fixScope(buildIssueList(checkResult.groups, checkReview), { fixRules: input.fixRules, fixableRules: FIXABLE_RULES, ai });
  const beforeSummary = issueSummary(scope);
  const { review, reason } = reviewForFix(state, input, agentService, ai);

  const logs = [`开始修复「${input.fileName}」，本次修复范围共 ${beforeSummary.total} 处问题。`];
  const runningResult = {
    status: 'running',
    inputSignature: input.signature,
    fixRules: input.fixRules,
    output: input.output,
    // 修复前是修复范围的处数，修复后是待人工处理的处数（含修复后新出现的）。
    beforeSummary,
    error: null,
    groups: [],
    items: [],
    agent: null,
    updatedAt: now(),
  };
  const { task } = checkpointTask({ status: 'running', progress: 1, logs }, { fixResult: runningResult });

  // 彩色图片转灰度要解码像素，助手不做：先在修复副本旁写出灰度副本作为助手的修复源，修复结束后删除。
  const graySource = input.output.replace(/\.docx$/i, '.gray.docx');
  const grayPath = input.outputPath.replace(/\.docx$/i, '.gray.docx');
  try {
    updateTask({ status: 'running', progress: 1, logs: [...logs, '正在实测原文页数，建立最终交付页数预算'] });
    const sourcePageMeasurement = await safeMeasurePages(input.sourcePath, taskControl.signal, pageMeasure);
    const pageGuard = buildFixPageGuard(explicitPageBudget, sourcePageMeasurement);
    if (pageGuard.constraint.enabled) {
      logs.push(`页数预算：${pageRequirementText(pageGuard)}${pageGuard.origin === 'source' ? '（未显式指定预算，默认不增页）' : '（调用方显式指定）'}。`);
    } else {
      logs.push(`原文页数无法实测：${sourcePageMeasurement.error}；最终结果将保留页数待人工复核项。`);
    }
    // 复查时彩色图片规则需要 Main 的像素抽样结论，与检查任务一致；转过灰度的图片按非彩色复查。
    let imageFacts = input.profile.image.check_color ? await collectImageColorFacts(input.sourcePath, { signal: taskControl.signal }) : [];
    const colorParts = input.fixRules.includes('image.color') ? imageFacts.filter((fact) => fact.color).map((fact) => fact.part) : [];
    let grayParts = [];
    if (colorParts.length) {
      updateTask({ status: 'running', progress: 1, logs: [...logs, `正在把 ${colorParts.length} 张彩色图片转为灰度`] });
      grayParts = await writeGrayscaleCopy(input.sourcePath, grayPath, colorParts, { signal: taskControl.signal });
      imageFacts = imageFacts.map((fact) => (grayParts.includes(fact.part) ? { ...fact, color: false, color_ratio: 0 } : fact));
    }
    // 没有勾选任何修复项时跳过程序修复，直接从原文件复制一份副本交给 AI 处理和对账。
    let mapped;
    let lineBreakFallback = null;
    const helperFixRules = input.fixRules.filter((rule) => rule !== 'image.text_sensitive');
    const runProgramFix = async (rules) => {
      if (rules.length) {
        const report = await openXmlHelperService.runBlindCheckFix({
          source: grayParts.length ? graySource : input.source,
          output: input.output,
          profile: input.profile,
          sensitive_words: input.sensitiveWords,
          image_facts: imageFacts,
          fix_rules: rules,
        }, {
          signal: taskControl.signal,
          onProgress: ({ frac, label }) => {
            updateTask({ status: 'running', progress: Math.max(1, Math.min(60, Math.round(frac * 60))), logs: [...logs, label] });
          },
        });
        return mapFixReport(report);
      }
      // 副本目录平时由助手写出副本时创建，首次使用或重置后还不存在。
      fs.mkdirSync(path.dirname(input.outputPath), { recursive: true });
      fs.copyFileSync(grayParts.length ? grayPath : input.sourcePath, input.outputPath);
      const after = mapReport(await openXmlHelperService.runBlindCheck({
        source: input.output, profile: input.profile, sensitive_words: input.sensitiveWords, image_facts: imageFacts,
      }, { signal: taskControl.signal }));
      return {
        sourceBytes: fs.statSync(input.sourcePath).size, outputBytes: fs.statSync(input.outputPath).size, fixes: {}, notes: [], headingFallback: true,
        validation: { checked: false, skippedReason: '没有勾选程序修复项', originalErrors: 0, fixedErrors: 0 },
        afterSummary: after.summary, afterStats: after.stats, groups: after.groups,
      };
    };
    mapped = await runProgramFix(helperFixRules);
    // 大量软换行拆段是历史页数膨胀的主要来源。若它使修复副本超过上限，从同一原件重做一次并保留
    // text.linebreak 为待人工项；不能为追页数去缩字体、改页边距，或把其他脱敏修复撤回。
    if (helperFixRules.includes('text.linebreak') && Number(mapped.fixes['text.linebreak'] || 0) > 0 && pageGuard.constraint.enabled) {
      const firstMeasurement = await safeMeasurePages(input.outputPath, taskControl.signal, pageMeasure);
      if (exceedsFixPageUpperBound(firstMeasurement.pages, pageGuard)) {
        const skipped = Number(mapped.fixes['text.linebreak'] || 0);
        const withoutLineBreaks = helperFixRules.filter((rule) => rule !== 'text.linebreak');
        logs.push(`手动换行拆段后实测 ${firstMeasurement.pages} 页，超过${pageRequirementText(pageGuard)}；已从原件重做并保留 ${skipped} 处手动换行待人工处理。`);
        mapped = await runProgramFix(withoutLineBreaks);
        mapped.notes = [...mapped.notes, `为保持最终页数预算，未自动拆分 ${skipped} 处手动换行；这些问题仍列为待人工处理。`];
        lineBreakFallback = { skipped, measuredPages: firstMeasurement.pages, measurementSource: firstMeasurement.source };
      }
    }
    if (grayParts.length) {
      mapped.fixes = { ...mapped.fixes, 'image.color': grayParts.length };
      // 助手的修复源是灰度副本，文件大小按原文件计。
      mapped.sourceBytes = fs.statSync(input.sourcePath).size;
    }
    let imageTextFacts = [];
    let imageRedactions = [];
    if (modelFirst || input.profile.image.check_text !== false) {
      updateTask({ status: 'running', progress: 61, logs: [...logs, modelFirst ? '正在使用配置的多模态模型主识别修复副本画面' : '正在本地识别修复副本中的图片文字'] });
      imageTextFacts = await (modelFirst ? collectModelImageTextFacts : collectImageTextFacts)(input.outputPath, { aiService, sensitiveWords: input.sensitiveWords,
        auxiliaryOcr: input.profile.image.check_text !== false, signal: taskControl.signal });
      if (input.fixRules.includes('image.text_sensitive')) {
        const requests = checkResult.groups.filter((group) => group.ruleId === 'image.text_sensitive')
          .flatMap((group) => group.items.map((item) => ({ part: item.part, expectedText: item.expectedText || item.text,
            originalHash: item.sourceHash, sourceHash: imageTextFacts.find((fact) => fact.part === item.part)?.hash, issue: group.id })));
        if (requests.length) {
          updateTask({ status: 'running', progress: 62, logs: [...logs, '正在遮盖图片实际画面中的敏感文字并重新识别；原文档不变'] });
          const redacted = await redactImageTextInCopy(input.outputPath, requests, { signal: taskControl.signal });
          imageTextFacts = modelFirst ? await collectModelImageTextFacts(input.outputPath, { aiService, sensitiveWords: input.sensitiveWords,
            auxiliaryOcr: input.profile.image.check_text !== false, previousFacts: imageTextFacts, signal: taskControl.signal }) : redacted.facts;
          imageRedactions.push(...redacted.images);
          mapped.fixes['image.text_sensitive'] = redacted.images.filter((record) => record.status === 'fixed').reduce((sum, record) => sum + record.requests.length, 0);
        }
      }
      const after = appendImageTextReport({ groups: mapped.groups, stats: mapped.afterStats }, imageTextFacts, input);
      mapped.groups = after.groups; mapped.afterStats = after.stats; mapped.afterSummary = after.summary;
    }
    const changed = Object.values(mapped.fixes).reduce((sum, value) => sum + Number(value || 0), 0);
    logs.push(`程序修复完成：共修改 ${changed} 处。`);

    let agent = { status: 'skipped', reason, summary: '', edits: [] };
    let finalGroups = mapped.groups;
    let finalStats = mapped.afterStats;
    let finalDump = null;
    let reviewImages = [];
    let dispositions = new Map();
    let refreshedClauses = [];
    if (review) {
      const agentLogs = [...logs, 'AI 正在处理程序修不了的问题，通常需要几分钟。'];
      updateTask({ status: 'running', progress: 65, logs: agentLogs });
      try {
        const fixedDump = await openXmlHelperService.runBlindCheckDump({
          source: input.output, profile: input.profile, sensitive_words: input.sensitiveWords, image_facts: [], heading_fallback: mapped.headingFallback,
        }, { signal: taskControl.signal });
        const result = await runBlindCheckFixAgent({
          agentService,
          aiService,
          openXmlHelperService,
          input,
          checkGroups: checkResult.groups,
          review,
          afterGroups: mapped.groups,
          fixedDump,
          fixedSource: input.output,
          headingFallback: mapped.headingFallback,
          imageFacts,
          imageTextFacts,
          mapReport,
          fixableRules: FIXABLE_RULES,
          taskId: task.task_id,
          signal: taskControl.signal,
          onActivity(event) {
            const text = agentActivityText(event, '处理结果');
            if (text) updateTask({ status: 'running', progress: 65, logs: [...agentLogs, text] });
          },
        });
        if (result.skipped) {
          agent = { status: 'skipped', reason: result.reason, summary: '', edits: [] };
        } else {
          agent = { status: 'success', reason: '', summary: result.disposition.summary, edits: result.edits };
          dispositions = new Map(result.disposition.items.map((item) => [item.id, item]));
          finalGroups = result.finalReport.groups;
          finalStats = result.finalReport.stats;
          finalDump = result.finalDump;
          reviewImages = result.reviewImages;
          refreshedClauses = result.disposition.clauses;
          imageRedactions.push(...(result.imageRedactions || []));
        }
      } catch (error) {
        if (taskControl.signal.aborted) throw error;
        // AI 修复失败时副本可能已有部分修改：重新复查并读取副本正文，程序问题和 AI 补充的问题都按实际状态对账，失败前的修改照常记录。
        const final = mapReport(await openXmlHelperService.runBlindCheck({
          source: input.output, profile: input.profile, sensitive_words: input.sensitiveWords, image_facts: imageFacts, heading_fallback: mapped.headingFallback,
        }, { signal: taskControl.signal }));
        finalGroups = final.groups;
        finalStats = final.stats;
        finalDump = await openXmlHelperService.runBlindCheckDump({
          source: input.output, profile: input.profile, sensitive_words: input.sensitiveWords, image_facts: [], heading_fallback: mapped.headingFallback,
        }, { signal: taskControl.signal });
        reviewImages = error?.partial?.reviewImages || [];
        imageRedactions.push(...(error?.partial?.imageRedactions || []));
        agent = { status: 'error', reason: '', error: error?.message || 'AI 修复失败', summary: '', edits: error?.partial?.edits || [] };
      }
    }

    // Never infer pixel repair from disappearing group counts or an AI assertion.
    // Re-read the exact final saved file after all text/image edits have finished.
    if (input.profile.image.check_text !== false || modelFirst) {
      const localVerification = await collectImageTextFacts(input.outputPath, { signal: taskControl.signal });
      imageTextFacts = modelFirst ? await collectModelImageTextFacts(input.outputPath, { aiService, sensitiveWords: input.sensitiveWords,
        auxiliaryOcr: input.profile.image.check_text !== false, previousFacts: imageTextFacts, signal: taskControl.signal }) : localVerification;
      const final = appendImageTextReport({ groups: finalGroups, stats: finalStats }, imageTextFacts, input);
      finalGroups = final.groups; finalStats = final.stats;
      imageRedactions = verifyImageRedactions(imageRedactions, localVerification);
      if (ai && aiService.getConfig?.().multimodal_enabled) {
        imageRedactions = await verifyRedactionsWithVision(input.outputPath, imageRedactions, { aiService, signal: taskControl.signal,
          onProgress: (done, total) => updateTask({ status: 'running', progress: 95, logs: [...logs, `正在使用配置的多模态模型复核修复后实际图片（${done}/${total}）`] }) });
      }
      const verified = new Set(imageRedactions.filter((record) => record.status === 'fixed')
        .flatMap((record) => record.requests.map((request) => `${record.part}\0${request.issue}\0${request.expectedText}`)));
      mapped.fixes['image.text_sensitive'] = verified.size;
      logs.push(modelFirst
        ? `最终多模态主识别：${final.stats.imageVisionChecked || 0}/${imageTextFacts.length} 张，本地兜底 ${final.stats.imageOcrFallback || 0} 张；仅像素与模型复检均通过才计入修复。`
        : `最终本地图片文字复检：${final.stats.imageOcrChecked}/${final.stats.imageOcrTotal} 张，未核验 ${final.stats.imageOcrUnknown} 张（待人工确认）。`);
    }

    updateTask({ status: 'running', progress: 96, logs: [...logs, '正在使用 Microsoft Word 实测最终修复副本页数'] });
    const finalPageMeasurement = await safeMeasurePages(input.outputPath, taskControl.signal, pageMeasure);
    const pageBudget = assessFixPageBudget({
      guard: pageGuard,
      sourceMeasurement: sourcePageMeasurement,
      finalMeasurement: finalPageMeasurement,
      lineBreakFallback,
    });
    const pageFinding = pageBudgetFinding(pageBudget);
    if (pageFinding) {
      finalGroups = [...finalGroups, pageFinding];
      logs.push(`页数预算待人工处理：${pageBudget.reason}。`);
    } else {
      logs.push(`最终页数验收通过：${pageBudget.requirement}，Microsoft Word 实测 ${finalPageMeasurement.pages} 页。`);
    }

    // 选了 AI 修复却没能完成（失败或会话失效）时，原本交给 AI 的问题在待人工的原因里写明。
    const unavailable = ai ? (agent.status === 'error' ? agent.error : agent.status === 'skipped' ? agent.reason : '') : '';
    const items = buildFixItems({
      scope,
      checkGroups: checkResult.groups,
      review: checkReview,
      finalGroups,
      newGroups: newProblemGroups(checkResult.groups, finalGroups),
      dispositions,
      edits: agent.edits,
      refreshedClauses,
      unavailable,
      finalDumpText: finalDump?.text,
      reviewImages,
      finalImages: finalDump?.images,
      imageRedactions,
    });
    const afterSummary = pendingSummary(items);
    const fixedCount = items.reduce((sum, item) => sum + item.fixed, 0);
    const summary = `修复完成：已修复 ${fixedCount} 处，待人工处理 ${afterSummary.total} 处${unavailable ? `（自动修复未完成：${unavailable}）` : ''}。`;
    checkpointTask(
      { status: 'success', progress: 100, logs: [...logs, ...(agent.summary ? [`AI 处理：${agent.summary}`] : []), summary], error: undefined },
      // outputPath 只用于推送给页面打开副本；落库时按工作区相对路径保存，读取时再拼成绝对路径。
      {
        fixResult: {
          ...runningResult,
          ...mapped,
          afterSummary,
          afterStats: finalStats,
          groups: finalGroups,
          items,
          agent,
          pageBudget,
          outputBytes: fs.statSync(input.outputPath).size,
          outputPath: input.outputPath,
          status: 'success',
          updatedAt: now(),
        },
      },
    );
    workspaceStore.removeStaleFixedFiles();
  } catch (error) {
    if (taskControl.signal.aborted) throw error;
    const message = error?.message || '暗标自动修复失败';
    checkpointTask(
      { status: 'error', progress: 100, logs: [...logs, '修复失败。'], error: message },
      { fixResult: { ...runningResult, status: 'error', error: message, updatedAt: now() } },
    );
  } finally {
    fs.rmSync(grayPath, { force: true });
  }
}

module.exports = {
  assessFixPageBudget,
  buildFixPageGuard,
  exceedsFixPageUpperBound,
  normalizeFixPageBudget,
  pageBudgetFinding,
  runBlindCheckFixTask,
};
