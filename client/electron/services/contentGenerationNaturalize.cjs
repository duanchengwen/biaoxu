const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { load } = require('cheerio');
const { extractAiSource } = require('../utils/aiSourceExtraction.cjs');
const { assertHtmlStructure } = require('../utils/htmlStructure.cjs');
const { imageStructure } = require('./contentGenerationEditTools.cjs');
const { countHtmlWords } = require('./contentGenerationWordTools.cjs');
const { runAiBatch, requestWithFollowUp, writeHtml } = require('./contentGenerationAiBatch.cjs');
const { sharedPrefixMessages } = require('../utils/promptPrefixCache.cjs');
const { NATURAL_WRITING_STANDARD } = require('./contentGenerationWritingStyle.cjs');

const KEEP_PATTERN = /<!--\s*yibiao:natural-keep-(\d+)\s*-->/g;
// 含明确事实、承诺、表格或图片的顶层块完全不交给润色模型，安全优先于改写覆盖率。
const CRITICAL_TEXT = /(?:\d|【[^】]*(?:待填|待确认)[^】]*】|承诺|保证|确保|不得|必须|工期|期限|交付|验收|质量目标|安全目标|响应时间|质保|保修)/;
const EXPLICIT_FACT_TEXT = /(?:实施地点|服务地点|交付地点|部署地点|地址|位置|区域|名称|单位|主体|责任方|甲方|乙方|采购人|供应商|我方|项目团队|项目经理).{0,24}(?:为|是|由|位于|负责|承担|审批|确认|提供|组织|包括|包含)/;

function protectSemanticBlocks(html, protectedBlockIds = []) {
  const $ = load(String(html || '').replace(/\r\n/g, '\n'), null, false);
  const blocks = [];
  const protectedIds = new Set((protectedBlockIds || []).map(id => String(id || '').trim()).filter(Boolean));
  $.root().children().each((_index, node) => {
    if (node.type !== 'tag') return;
    const element = $(node);
    const hasProtectedId = protectedIds.has(element.attr('id'))
      || element.find('[id]').toArray().some(child => protectedIds.has($(child).attr('id')));
    const fixed = element.is('figure, img, table') || element.find('figure, img, table').length > 0
      || hasProtectedId || CRITICAL_TEXT.test(element.text()) || EXPLICIT_FACT_TEXT.test(element.text());
    if (!fixed) return;
    blocks.push($.html(node));
    element.replaceWith(`<!-- yibiao:natural-keep-${blocks.length} -->`);
  });
  return { text: $.html(), blocks };
}

function restoreSemanticBlocks(text, blocks) {
  const found = [...String(text || '').matchAll(KEEP_PATTERN)].map(match => Number(match[1]));
  if (found.length !== blocks.length || found.some((value, index) => value !== index + 1)) {
    throw new Error('事实、承诺、表格或图片占位必须按原顺序各保留一次');
  }
  return String(text).replace(KEEP_PATTERN, (_match, index) => blocks[Number(index) - 1]);
}

function createNaturalizeState(sectionIds, previous) {
  const ids = [...new Set(sectionIds.map(value => String(value || '').trim()).filter(Boolean))];
  const saved = previous && typeof previous === 'object' ? previous : {};
  return {
    status: saved.status === 'completed' ? 'completed' : 'running',
    section_ids: ids,
    completed_section_ids: (saved.completed_section_ids || []).filter(id => ids.includes(id)),
    skipped_section_ids: (saved.skipped_section_ids || []).filter(id => ids.includes(id)),
    stale_section_ids: (saved.stale_section_ids || []).filter(id => ids.includes(id)),
    processed_section_ids: (saved.processed_section_ids || []).filter(id => ids.includes(id)),
    processed_hashes: Object.fromEntries(Object.entries(saved.processed_hashes || {}).filter(([id, hash]) => ids.includes(id) && typeof hash === 'string' && hash)),
    failures: Object.fromEntries(Object.entries(saved.failures || {}).filter(([id]) => ids.includes(id))),
  };
}

const NATURALIZE_SYSTEM = `你是投标技术文件审校编辑。请对一个小节做自然化审校：
${NATURAL_WRITING_STANDARD}
1. 按上述标准删除或合并需要修改的套话、重复观点、机械排比和空泛过渡，改善中文词序和段落衔接。
2. 不新增、删除或改变任何事实、数值、单位、日期、范围、责任、承诺、时限、结论和占位标记。
3. 不改变表格、图片、图注、图片提示词及其位置。形如 <!-- yibiao:natural-keep-1 --> 的注释代表受保护内容，必须按原顺序各保留一次，不得修改、复制或删除。
4. 保持受限 HTML；不得输出章节标题、Markdown、代码围栏或解释。以 <!-- yibiao:block --> 开头，保留已有元素 id，除空元素外写完整结束标签。
5. 这是一项写作质量审校，不得声称或尝试保证通过任何所谓 AI 检测器。
只输出审校后的完整小节 HTML。`;

function buildNaturalizeSharedInput(workspaceDir) {
  const read = name => fs.readFileSync(path.join(workspaceDir, name), 'utf8');
  const decisions = JSON.parse(read('正文编排决策.json'));
  return [
    `项目概述：\n${read('项目概述.md')}`,
    `全局事实设定：\n${read('全局事实设定.md')}`,
    `事实缺失处理要求：\n${decisions.global_facts_requirements || '不得新增没有依据的事实。'}`,
  ].join('\n\n');
}

function buildNaturalizeItemInput(section, protectedHtml) {
  return [
    `当前小节：${section.number || ''} ${section.title || section.id}`,
    `当前 HTML：\n${protectedHtml}`,
  ].join('\n\n');
}

function validateNaturalizedHtml(original, candidate) {
  const html = String(candidate || '').trim();
  if (!html.startsWith('<!-- yibiao:block -->') || html.includes('```')) throw new Error('结果不是有效的受限 HTML 正文');
  assertHtmlStructure(html, { checkSourceCompleteness: true });
  if (imageStructure(html) !== imageStructure(original)) throw new Error('图片或图片表格结构与原文不一致');
  if (!countHtmlWords(html)) throw new Error('审校结果没有有效正文');
  return html;
}

const hashHtml = html => crypto.createHash('sha256').update(String(html || ''), 'utf8').digest('hex');

// 页数扩缩等后续阶段可能再次改写正文。哈希不再匹配时撤销“已完成/已复用”的文风状态，
// 不能因为该小节此前审过就把改写后的新文本继续标为已审；旧状态无哈希时对明确改写 ID 保守失效。
function invalidateNaturalizeStateForChangedHtml(previousState, workspaceDir, sections, changedSectionIds = []) {
  if (!previousState || typeof previousState !== 'object') return previousState;
  const state = createNaturalizeState((sections || []).map(section => section.section_id || section.id), previousState);
  const byId = new Map((sections || []).map(section => [section.section_id || section.id, section]));
  const explicitlyChanged = new Set(changedSectionIds || []);
  const stale = new Set(state.stale_section_ids || []);
  for (const id of state.processed_section_ids) {
    const section = byId.get(id);
    if (!section) continue;
    const savedHash = state.processed_hashes[id];
    const currentHash = hashHtml(fs.readFileSync(path.join(workspaceDir, section.file), 'utf8'));
    if ((savedHash && savedHash !== currentHash) || (!savedHash && explicitlyChanged.has(id))) stale.add(id);
  }
  if (!stale.size) return state;
  const active = id => !stale.has(id);
  return {
    ...state,
    completed_section_ids: state.completed_section_ids.filter(active),
    skipped_section_ids: state.skipped_section_ids.filter(active),
    processed_section_ids: state.processed_section_ids.filter(active),
    processed_hashes: Object.fromEntries(Object.entries(state.processed_hashes).filter(([id]) => active(id))),
    failures: Object.fromEntries(Object.entries(state.failures).filter(([id]) => active(id))),
    stale_section_ids: [...stale],
  };
}

function mergeNaturalizeState(previousState, partialState) {
  if (!previousState || typeof previousState !== 'object') return partialState;
  if (!partialState || typeof partialState !== 'object') return previousState;
  const replaced = new Set(partialState.section_ids || []);
  const mergeIds = key => [...new Set([
    ...(previousState[key] || []).filter(id => !replaced.has(id)),
    ...(partialState[key] || []),
  ])];
  const mergeMap = key => ({
    ...Object.fromEntries(Object.entries(previousState[key] || {}).filter(([id]) => !replaced.has(id))),
    ...(partialState[key] || {}),
  });
  return {
    ...previousState,
    ...partialState,
    section_ids: mergeIds('section_ids'),
    completed_section_ids: mergeIds('completed_section_ids'),
    skipped_section_ids: mergeIds('skipped_section_ids'),
    stale_section_ids: mergeIds('stale_section_ids'),
    processed_section_ids: mergeIds('processed_section_ids'),
    processed_hashes: mergeMap('processed_hashes'),
    failures: mergeMap('failures'),
  };
}

async function naturalizeContentSections({ aiService, workspaceDir, sections, signal, previousState, approvedHashes = {}, onProgress = () => {} }) {
  let state = createNaturalizeState(sections.map(section => section.section_id || section.id), previousState);
  const targetById = new Map(sections.map(section => [section.section_id || section.id, section]));
  const currentHashes = Object.fromEntries(state.section_ids.flatMap(id => {
    const section = targetById.get(id);
    if (!section) return [];
    return [[id, hashHtml(fs.readFileSync(path.join(workspaceDir, section.file), 'utf8'))]];
  }));

  // 只复用带落盘哈希且仍匹配的检查点；旧检查点没有哈希时保守重审一次，不能仅凭 ID 把变化正文标成已审。
  const processed = new Set(state.processed_section_ids.filter(id => state.processed_hashes[id] && state.processed_hashes[id] === currentHashes[id]));
  const completed = new Set(state.completed_section_ids.filter(id => processed.has(id)));
  const skipped = new Set(state.skipped_section_ids.filter(id => processed.has(id)));
  const stale = new Set(state.stale_section_ids.filter(id => !processed.has(id)));
  const failures = Object.fromEntries(Object.entries(state.failures).filter(([id]) => processed.has(id)));
  const processedHashes = Object.fromEntries(Object.entries(state.processed_hashes).filter(([id, hash]) => processed.has(id) && hash === currentHashes[id]));

  // 自动流程只复用同一次一致性模型调用明确判定 pass 且仍绑定当前 HTML 哈希的结论；手动全篇入口不传 approvedHashes。
  for (const id of state.section_ids) {
    if (!processed.has(id) && approvedHashes[id] && approvedHashes[id] === currentHashes[id]) {
      processed.add(id);
      skipped.add(id);
      stale.delete(id);
      processedHashes[id] = currentHashes[id];
    }
  }
  state = {
    ...state,
    status: processed.size === state.section_ids.length ? 'completed' : 'running',
    completed_section_ids: [...completed],
    skipped_section_ids: [...skipped],
    stale_section_ids: [...stale],
    processed_section_ids: [...processed],
    processed_hashes: processedHashes,
    failures,
  };
  // 手动重做时由调用方不传 previousState；恢复任务只处理尚未落盘或处理后发生变化的小节。
  if (state.status === 'completed') {
    onProgress(state);
    return state;
  }
  const pending = state.section_ids.filter(id => !state.processed_section_ids.includes(id)).map(id => targetById.get(id)).filter(Boolean);
  // 公共材料每批只读取一次，并作为逐字相同的独立消息；变化的小节标题和 HTML 只放在末尾消息。
  const sharedInput = pending.length ? buildNaturalizeSharedInput(workspaceDir) : '';
  const save = next => {
    state = next;
    onProgress(state);
  };
  const markFailure = (section, error) => {
    const id = section.section_id || section.id;
    const message = `${error?.message || error}，已保留原文，建议人工复核`;
    const file = path.join(workspaceDir, section.file);
    save({ ...state,
      processed_section_ids: [...new Set([...state.processed_section_ids, id])],
      processed_hashes: { ...state.processed_hashes, [id]: hashHtml(fs.readFileSync(file, 'utf8')) },
      failures: { ...state.failures, [id]: message },
    });
  };
  onProgress(state);
  try {
    await runAiBatch({
      items: pending,
      signal,
      async run(section, guard) {
        const id = section.section_id || section.id;
        const file = path.join(workspaceDir, section.file);
        const original = fs.readFileSync(file, 'utf8');
        const protectedContent = protectSemanticBlocks(original, section.protected_block_ids);
        const best = await requestWithFollowUp({
          aiService,
          guard,
          logTitle: `技术标AI去痕-${section.number || id}-${section.title || ''}`,
          messages: sharedPrefixMessages(NATURALIZE_SYSTEM, sharedInput, buildNaturalizeItemInput(section, protectedContent.text)),
          evaluate(reply) {
            const restored = restoreSemanticBlocks(extractAiSource(reply, 'html').trim(), protectedContent.blocks);
            try {
              const html = validateNaturalizedHtml(original, restored);
              return { accept: true, value: html };
            } catch (error) {
              return { feedback: `上次结果不可用：${error.message}。请在保留全部占位和事实的前提下重新输出完整 HTML。`, reason: error.message };
            }
          },
        });
        guard.signal.throwIfAborted();
        writeHtml(file, best);
        save({ ...state,
          completed_section_ids: [...new Set([...state.completed_section_ids, id])],
          processed_section_ids: [...new Set([...state.processed_section_ids, id])],
          processed_hashes: { ...state.processed_hashes, [id]: hashHtml(best) },
          stale_section_ids: state.stale_section_ids.filter(key => key !== id),
          failures: Object.fromEntries(Object.entries(state.failures).filter(([key]) => key !== id)),
        });
      },
      onError(section, error, { cancelled }) {
        if (!cancelled) markFailure(section, error);
      },
    });
  } catch (error) {
    if (signal.aborted) throw error;
    for (const section of pending) {
      const id = section.section_id || section.id;
      if (!state.processed_section_ids.includes(id)) markFailure(section, error);
    }
  }
  save({ ...state, status: 'completed' });
  return state;
}

module.exports = {
  protectSemanticBlocks,
  restoreSemanticBlocks,
  createNaturalizeState,
  validateNaturalizedHtml,
  invalidateNaturalizeStateForChangedHtml,
  mergeNaturalizeState,
  naturalizeContentSections,
};
