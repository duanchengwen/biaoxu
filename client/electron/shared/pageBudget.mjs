export const WORDS_PER_PAGE = 650;
export const PAGE_WORD_TOLERANCE = 0.15;
export const DEFAULT_SECTION_WORDS = 3000;
export const PAGE_BUDGET_DISCLAIMER = '字数仅按每页约650字粗略估算，实际页数受模板、字号、行距、表格和图片影响；成稿后优先使用 Microsoft Word 实测分页，不可用时采用内置编辑器布局并提示与 Word/WPS 可能存在差异。';

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

export function estimatePageWordBudget(targetPages) {
  const pages = nonNegativeInteger(targetPages);
  if (pages <= 0) return null;
  const estimatedWords = pages * WORDS_PER_PAGE;
  const tolerancePercent = PAGE_WORD_TOLERANCE * 100;
  return Object.freeze({
    targetPages: pages,
    estimatedWords,
    minimumWords: Math.round(estimatedWords * (100 - tolerancePercent) / 100),
    maximumWords: Math.round(estimatedWords * (100 + tolerancePercent) / 100),
    wordsPerPage: WORDS_PER_PAGE,
    tolerance: PAGE_WORD_TOLERANCE,
    disclaimer: PAGE_BUDGET_DISCLAIMER,
  });
}

// 两套用户输入必须独立保存。旧快照没有 mode 时只做兼容推断，不改写另一套输入。
export function normalizeWordControlOptions(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const targetPages = nonNegativeInteger(source.targetPages);
  const minimumPages = nonNegativeInteger(source.minimumPages);
  const maximumPages = nonNegativeInteger(source.maximumPages);
  const inferredMode = targetPages > 0 || minimumPages > 0 || maximumPages > 0 ? 'pages' : 'words';
  return {
    mode: source.mode === 'pages' || source.mode === 'words' ? source.mode : inferredMode,
    minimumWords: nonNegativeInteger(source.minimumWords),
    maximumWords: nonNegativeInteger(source.maximumWords),
    sectionWords: nonNegativeInteger(source.sectionWords),
    targetPages,
    minimumPages,
    maximumPages,
  };
}

export function validateWordControlOptions(value) {
  const options = normalizeWordControlOptions(value);
  if (options.mode === 'words') {
    if (options.minimumWords > 0 && options.maximumWords > 0 && options.minimumWords > options.maximumWords) {
      throw new Error('最少字数不能高于最多字数');
    }
    return options;
  }
  if (options.minimumPages > 0 && options.maximumPages > 0 && options.minimumPages > options.maximumPages) {
    throw new Error('最少页数不能高于最多页数');
  }
  if (options.targetPages > 0 && options.minimumPages > 0 && options.targetPages < options.minimumPages) {
    throw new Error('目标页数不能低于最少页数');
  }
  if (options.targetPages > 0 && options.maximumPages > 0 && options.targetPages > options.maximumPages) {
    throw new Error('目标页数不能高于最多页数');
  }
  return options;
}

// 有上下限时它们是最终验收口径；target 仅用作范围内的初稿规划参考。
export function resolvePageConstraint(value) {
  const options = validateWordControlOptions(value);
  const enabled = options.mode === 'pages'
    && (options.targetPages > 0 || options.minimumPages > 0 || options.maximumPages > 0);
  const hasRange = options.minimumPages > 0 || options.maximumPages > 0;
  const planningPages = options.targetPages > 0
    ? options.targetPages
    : options.minimumPages > 0 && options.maximumPages > 0
      ? Math.round((options.minimumPages + options.maximumPages) / 2)
      : options.minimumPages || options.maximumPages || 0;
  return Object.freeze({
    enabled,
    kind: hasRange ? 'range' : enabled ? 'exact' : 'none',
    targetPages: options.targetPages,
    minimumPages: options.minimumPages,
    maximumPages: options.maximumPages,
    planningPages,
  });
}

export function isPageCountAccepted(actualPages, constraintOrOptions) {
  const actual = nonNegativeInteger(actualPages);
  const constraint = constraintOrOptions?.kind ? constraintOrOptions : resolvePageConstraint(constraintOrOptions);
  if (!constraint.enabled || actual <= 0) return false;
  if (constraint.kind === 'exact') return actual === constraint.targetPages;
  return (constraint.minimumPages <= 0 || actual >= constraint.minimumPages)
    && (constraint.maximumPages <= 0 || actual <= constraint.maximumPages);
}

export function pageCountDistance(actualPages, constraintOrOptions) {
  const actual = nonNegativeInteger(actualPages);
  const constraint = constraintOrOptions?.kind ? constraintOrOptions : resolvePageConstraint(constraintOrOptions);
  if (!constraint.enabled || actual <= 0) return Number.POSITIVE_INFINITY;
  if (constraint.kind === 'exact') return Math.abs(actual - constraint.targetPages);
  if (constraint.minimumPages > 0 && actual < constraint.minimumPages) return constraint.minimumPages - actual;
  if (constraint.maximumPages > 0 && actual > constraint.maximumPages) return actual - constraint.maximumPages;
  return 0;
}

export function pageAdjustmentTarget(actualPages, constraintOrOptions) {
  const actual = nonNegativeInteger(actualPages);
  const constraint = constraintOrOptions?.kind ? constraintOrOptions : resolvePageConstraint(constraintOrOptions);
  if (constraint.kind === 'exact') return constraint.targetPages;
  if (constraint.minimumPages > 0 && actual < constraint.minimumPages) return constraint.minimumPages;
  if (constraint.maximumPages > 0 && actual > constraint.maximumPages) return constraint.maximumPages;
  return constraint.planningPages;
}

/** 只在目录/正文规划的内存对象上应用页数折算预算，不得把返回值写回用户配置。 */
export function derivePlanningWordControl(value) {
  const options = validateWordControlOptions(value);
  if (options.mode !== 'pages') return { ...options, planningPages: 0, pageBudget: null };
  const constraint = resolvePageConstraint(options);
  const budget = estimatePageWordBudget(constraint.planningPages);
  return {
    ...options,
    minimumWords: budget?.minimumWords || 0,
    maximumWords: budget?.maximumWords || 0,
    sectionWords: budget ? Math.min(DEFAULT_SECTION_WORDS, budget.estimatedWords) : 0,
    planningPages: constraint.planningPages,
    pageBudget: budget,
  };
}
