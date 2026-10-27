// 省 Token 质量门禁独立协议测试：只用本地 mock，不调用真实模型或用户资料。
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  extractConsistencyLedger,
  collectNaturalnessApprovedHashes,
  collectProtectedFactBlockIds,
} = require('../electron/services/contentGenerationConsistencyTools.cjs');
const {
  protectSemanticBlocks,
  naturalizeContentSections,
} = require('../electron/services/contentGenerationNaturalize.cjs');
const { NATURAL_WRITING_STANDARD } = require('../electron/services/contentGenerationWritingStyle.cjs');

const root = path.resolve(__dirname, '..');
const hash = value => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');

function html(label) {
  return [
    '<!-- yibiao:block -->',
    '<p id="fact">我方承诺在30日内交付并完成验收。</p>',
    '<!-- yibiao:block -->',
    `<p id="editable">${label}，首先，我们将进一步认真开展相关工作。</p>`,
    '<!-- yibiao:block -->',
    '<table id="roles"><tbody><tr><td>岗位</td><td>职责</td></tr></tbody></table>',
    '<!-- yibiao:block -->',
    '<figure id="flow" data-yb-size="wide" data-yb-fit="contain"><img src="assets/flow.png" data-yb-asset-ref="assets/flow.png" alt="实施流程图"><figcaption>图1 实施流程图</figcaption></figure>',
  ].join('\n');
}

const normalizedReply = label => [
  '<!-- yibiao:block -->',
  '<!-- yibiao:natural-keep-1 -->',
  '<!-- yibiao:block -->',
  `<p id="editable">${label}按责任分工推进，并在节点核对成果。</p>`,
  '<!-- yibiao:block -->',
  '<!-- yibiao:natural-keep-2 -->',
  '<!-- yibiao:block -->',
  '<!-- yibiao:natural-keep-3 -->',
].join('\n');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bidxu-token-quality-'));
  const sections = [
    { section_id: 's1', id: 's1', number: '1.1', title: '明确通过', file: '正文/s1.html' },
    { section_id: 's2', id: 's2', number: '1.2', title: '兼容旧响应', file: '正文/s2.html' },
    { section_id: 's3', id: 's3', number: '1.3', title: '需要修改', file: '正文/s3.html' },
  ];
  const originals = Object.fromEntries(sections.map(section => [section.id, html(section.title)]));
  try {
    fs.mkdirSync(path.join(directory, '正文'), { recursive: true });
    fs.writeFileSync(path.join(directory, '项目概述.md'), '隔离测试项目', 'utf8');
    fs.writeFileSync(path.join(directory, '全局事实设定.md'), '工期：30日', 'utf8');
    fs.writeFileSync(path.join(directory, '正文编排决策.json'), JSON.stringify({
      global_facts_requirements: '不得新增没有依据的事实',
      targets: sections.map(({ id, number, title, file }) => ({ id, number, title, file })),
    }), 'utf8');
    for (const section of sections) fs.writeFileSync(path.join(directory, section.file), originals[section.id], 'utf8');

    let warmups = 0;
    let reviews = 0;
    const captured = [];
    await extractConsistencyLedger({
      workspaceDir: directory,
      signal: new AbortController().signal,
      aiService: {
        async chat() { warmups += 1; return 'OK'; },
        async requestJson(request) {
          reviews += 1;
          captured.push(request);
          const common = {
            issues: [],
            facts: [{ category: '日期与期限', subject: '工期', value: '30日', block_id: 'B1', quote: '30日内交付' }],
          };
          const raw = request.logTitle.includes('1.1')
            ? { ...common, naturalness: { status: 'pass', issues: [] } }
            : request.logTitle.includes('1.2')
              ? common // 模拟尚未支持 naturalness 字段的兼容供应商响应。
              : { ...common, naturalness: { status: 'needs_revision', issues: [{ block_id: 'B2', type: '套话', problem: '套话明显' }] } };
          const output = request.normalizer(raw);
          request.validator(output);
          return output;
        },
      },
    });

    assert.equal(reviews, sections.length, 'N 个小节必须仍只有 N 次一致性 requestJson');
    assert.equal(warmups, 1, '公共前缀预热次数不得随 naturalness 增加');
    assert.ok(captured.every(request => request.messages.length === 3), '一致性输入应保持公共前缀与单节内容分离');
    assert.ok(captured.every(request => request.messages[0].content.includes('自然文风审查')),
      'naturalness 必须合并在既有一致性响应中');
    assert.throws(() => captured[0].validator(captured[0].normalizer({ issues: [], naturalness: { status: 'pass', issues: [] } })),
      /facts 必须为数组且不得省略/, '节省调用不得放宽 facts 必填契约');

    const ledgerPath = path.join(directory, '正文一致性事实台账.json');
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(ledger.sections.s2.naturalness.status, 'unknown', '缺 naturalness 必须保守标 unknown');
    assert.deepEqual(Object.keys(collectNaturalnessApprovedHashes(directory, sections)), ['s1'],
      '只有 pass + 空 issues + v3 + 当前 SHA 匹配的小节可复用');
    assert.equal(ledger.sections.s1.hash, hash(originals.s1), '批准结论必须绑定正文 SHA-256');
    assert.deepEqual(collectProtectedFactBlockIds(directory, sections).s1, ['fact'],
      '模型台账返回的事实 block_id 必须进入后处理保护清单');
    const explicitFact = '<!-- yibiao:block -->\n<p id="place">实施地点为武汉市。</p>\n<!-- yibiao:block -->\n<p id="plain">团队开展协同工作。</p>';
    const protectedByLedger = protectSemanticBlocks(explicitFact, ['place']);
    assert.equal(protectedByLedger.blocks.length, 1, '无数字地点事实应能按台账 block_id 原样保护');
    assert.match(protectedByLedger.blocks[0], /实施地点为武汉市/);
    assert.equal(protectSemanticBlocks(explicitFact).blocks.length, 1, '明确地点/责任表达还应有本地规则兜底');

    // unknown 与 needs_revision 均走完整去痕；明确 pass 的小节逐字保留。
    const automaticCalls = [];
    const automatic = await naturalizeContentSections({
      workspaceDir: directory,
      sections,
      signal: new AbortController().signal,
      approvedHashes: collectNaturalnessApprovedHashes(directory, sections),
      aiService: { async chat(request) {
        automaticCalls.push(request);
        return normalizedReply(request.logTitle.includes('1.2') ? '兼容旧响应' : '需要修改');
      } },
    });
    assert.equal(automaticCalls.length, 2, `unknown/needs_revision 都不得跳过去痕，也不得增加额外判定请求：${JSON.stringify(automatic)}`);
    assert.deepEqual(automatic.skipped_section_ids, ['s1']);
    assert.equal(fs.readFileSync(path.join(directory, sections[0].file), 'utf8'), originals.s1,
      '复用通过结论不得改写正文');
    for (const id of ['s2', 's3']) {
      const output = fs.readFileSync(path.join(directory, `正文/${id}.html`), 'utf8');
      assert.match(output, /我方承诺在30日内交付并完成验收/);
      assert.match(output, /<table id="roles">/);
      assert.match(output, /data-yb-asset-ref="assets\/flow\.png"/);
    }

    // 手动全篇入口不传批准项，必须逐节重做，不因台账 pass 而少请求。
    for (const section of sections) fs.writeFileSync(path.join(directory, section.file), originals[section.id], 'utf8');
    let manualCalls = 0;
    await naturalizeContentSections({
      workspaceDir: directory,
      sections,
      signal: new AbortController().signal,
      approvedHashes: {},
      aiService: { async chat(request) { manualCalls += 1; return normalizedReply(request.logTitle); } },
    });
    assert.equal(manualCalls, sections.length, '手动全篇 AI 去痕必须逐节执行');

    // v2 之前的断点没有 processed_hashes；升级后必须保守重审，不能只凭 section id 跳过。
    fs.writeFileSync(path.join(directory, sections[0].file), originals.s1, 'utf8');
    let legacyResumeCalls = 0;
    const legacyResume = await naturalizeContentSections({
      workspaceDir: directory,
      sections: [sections[0]],
      signal: new AbortController().signal,
      previousState: {
        status: 'completed', section_ids: ['s1'], completed_section_ids: ['s1'],
        skipped_section_ids: [], stale_section_ids: [], processed_section_ids: ['s1'], processed_hashes: {}, failures: {},
      },
      aiService: { async chat() { legacyResumeCalls += 1; return normalizedReply('旧检查点重审'); } },
    });
    assert.equal(legacyResumeCalls, 1, '旧无哈希检查点必须保守重审一次');
    assert.deepEqual(legacyResume.completed_section_ids, ['s1']);

    // 旧版台账和正文哈希变化都不能继续授权跳过。
    for (const section of sections) fs.writeFileSync(path.join(directory, section.file), originals[section.id], 'utf8');
    const altered = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    altered.sections.s1.version = 2;
    fs.writeFileSync(ledgerPath, JSON.stringify(altered, null, 2), 'utf8');
    assert.deepEqual(collectNaturalnessApprovedHashes(directory, sections), {}, '旧台账版本不得批准复用');
    altered.sections.s1.version = 3;
    fs.writeFileSync(ledgerPath, JSON.stringify(altered, null, 2), 'utf8');
    fs.appendFileSync(path.join(directory, sections[0].file), '\n<!-- external-change -->', 'utf8');
    assert.deepEqual(collectNaturalnessApprovedHashes(directory, sections), {}, '审查后正文变化必须使批准失效');

    // 流程顺序：自然化/复用 -> 页数实排扩缩 -> 最终 Word 转换。
    const taskSource = fs.readFileSync(path.join(root, 'electron/services/contentGenerationTask.cjs'), 'utf8');
    const naturalizeAt = taskSource.indexOf('const shouldNaturalize');
    const pagesAt = taskSource.indexOf('const shouldAdjustPages', naturalizeAt);
    const wordAt = taskSource.indexOf("contentStats.phase = 'word-converting'", pagesAt);
    assert.ok(naturalizeAt >= 0 && pagesAt > naturalizeAt && wordAt > pagesAt,
      '最终流程必须保持自然化 -> 页数优化 -> Word 转换顺序');
    assert.match(taskSource, /approvedHashes:\s*naturalizeOnly\s*\?\s*\{\}\s*:\s*collectNaturalnessApprovedHashes/,
      '手动与自动批准边界未在任务接线中体现');
    assert.match(taskSource, /invalidateNaturalizeStateForChangedHtml\([\s\S]*?\[\.\.\.changedPageIds\]/,
      '页数改写后必须撤销所有哈希变化小节的已审状态');
    const postPageReviewAt = taskSource.indexOf("status: 'reviewing'", pagesAt);
    const finalPageMeasureAt = taskSource.indexOf('measureContentDocumentPages', postPageReviewAt);
    assert.ok(postPageReviewAt > pagesAt && finalPageMeasureAt > postPageReviewAt && wordAt > finalPageMeasureAt,
      '页数改写后必须先复核变化小节，必要改写后仅再实测，最后才转换 Word');
    assert.match(taskSource, /factPendingIds[\s\S]*?styleReviewSections\s*=\s*changedSections\.filter/,
      '事实冲突或复核失败的小节不得仅按文风结论标记通过');
    for (const relative of [
      'electron/services/contentGenerationAgent.cjs',
      'electron/services/contentGenerationNaturalize.cjs',
      'electron/services/contentGenerationPages.cjs',
    ]) {
      const source = fs.readFileSync(path.join(root, relative), 'utf8');
      assert.match(source, /NATURAL_WRITING_STANDARD/, `${relative} 未复用统一自然文风口径`);
    }
    assert.match(NATURAL_WRITING_STANDARD, /事实、责任、承诺和验收表达应准确保留/);

    console.log('check-token-quality-gates: 通过');
    console.log(JSON.stringify({ sections: sections.length, consistencyRequestJson: reviews, warmups,
      automaticNaturalizeCalls: automaticCalls.length, manualNaturalizeCalls: manualCalls,
      legacyCheckpointRechecked: true, protected: ['台账事实', '显式地点/责任', '事实/承诺', '表格', '图片'],
      finalOrder: ['naturalize', 'page-adjust', 'word-convert'] }));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
