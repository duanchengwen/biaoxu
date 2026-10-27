#!/usr/bin/env node
'use strict';

// Read-only, content-free replay of a completed content-generation run. It reports only
// counts, token metadata already returned by the provider, and payload character sizes.
// It never prints prompts, model outputs, API keys, business text, or local paths.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    values[argv[index].slice(2)] = argv[index + 1];
    index += 1;
  }
  return values;
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function latestFile(directory, extension) {
  if (!fs.existsSync(directory)) return '';
  return fs.readdirSync(directory)
    .filter(name => !extension || name.endsWith(extension))
    .map(name => ({ file: path.join(directory, name), time: fs.statSync(path.join(directory, name)).mtimeMs }))
    .sort((left, right) => right.time - left.time)[0]?.file || '';
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  return Array.isArray(message?.content) ? message.content.map(item => item?.type === 'text' ? item.text || '' : '').join('\n') : '';
}

function toolCalls(message) {
  return Array.isArray(message?.content) ? message.content.filter(item => item?.type === 'toolCall') : [];
}

function emptyUsage() {
  return { turns: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 };
}

function addUsage(total, usage) {
  if (!usage || typeof usage !== 'object') return;
  total.turns += 1;
  total.inputTokens += Number(usage.input || usage.input_tokens || usage.prompt_tokens || 0);
  total.cachedInputTokens += Number(usage.cacheRead || usage.cached_tokens || usage.prompt_tokens_details?.cached_tokens || 0);
  total.outputTokens += Number(usage.output || usage.output_tokens || usage.completion_tokens || 0);
  total.reasoningTokens += Number(usage.reasoning || usage.reasoning_tokens || 0);
  total.totalTokens += Number(usage.totalTokens || usage.total_tokens || 0)
    || Number(usage.input || 0) + Number(usage.cacheRead || 0) + Number(usage.output || 0);
}

function classifyShell(argumentsValue) {
  const text = JSON.stringify(argumentsValue || '').toLowerCase();
  if (/\bnode(?:\.exe)?\b|\.c?js\b|json\.parse|convertfrom-json/.test(text)) return 'nodeOrJsonScript';
  if (/\brg(?:\.exe)?\b|\bgrep\b|select-string|get-content|findstr|\bhead\b|\btail\b/.test(text)) return 'searchOrRead';
  return 'other';
}

function estimateTextTokens(text) {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of String(text || '')) {
    if (character.codePointAt(0) <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return nonAscii + Math.ceil(ascii / 3);
}

function sessionSummary(sessionFile) {
  if (!sessionFile || !fs.existsSync(sessionFile)) return null;
  const rows = fs.readFileSync(sessionFile, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const overall = emptyUsage();
  const audit = emptyUsage();
  const shellTurns = emptyUsage();
  const tools = {};
  const shellClasses = { searchOrRead: 0, nodeOrJsonScript: 0, other: 0 };
  let auditStarted = false;
  for (const row of rows) {
    const message = row.message;
    if (message?.role === 'user') {
      const text = messageText(message);
      if (text.includes('一致性审计') && text.includes('事实台账')) auditStarted = true;
      continue;
    }
    if (message?.role !== 'assistant') continue;
    addUsage(overall, message.usage);
    if (auditStarted) addUsage(audit, message.usage);
    const calls = toolCalls(message);
    for (const call of calls) tools[call.name] = (tools[call.name] || 0) + 1;
    const shellCalls = calls.filter(call => call.name === 'bash');
    if (shellCalls.length) {
      addUsage(shellTurns, message.usage);
      for (const call of shellCalls) shellClasses[classifyShell(call.arguments)] += 1;
    }
  }
  return { rowCount: rows.length, overall, audit, shellTurns, tools, shellClasses };
}

function workspaceSummary(workspaceDir) {
  const decisions = readJson(path.join(workspaceDir, '正文编排决策.json'), { targets: [] });
  const ledger = readJson(path.join(workspaceDir, '正文一致性事实台账.json'), { sections: {}, failures: {} });
  const repairs = readJson(path.join(workspaceDir, '程序清单', '一致性修复结果.json'), { results: [] });
  const sections = Object.entries(ledger.sections || {});
  let issueCount = 0;
  let factCount = 0;
  let factPayloadCharacters = 0;
  for (const [, entry] of sections) {
    issueCount += Array.isArray(entry.issues) ? entry.issues.length : 0;
    for (const fact of entry.facts || []) {
      factCount += 1;
      factPayloadCharacters += JSON.stringify(fact).length;
    }
  }
  const semanticFullLedgerRequests = sections.length >= 2 && factCount >= 2 ? 1 : 0;
  const targetById = new Map((decisions.targets || []).map(target => [target.id, target]));
  const aliases = new Map(sections.map(([id], index) => [id, `S${index + 1}`]));
  const compactInput = {
    sections: sections.map(([id, entry]) => {
      const target = targetById.get(id) || {};
      return [aliases.get(id), id, target.number || '', target.title || '', entry.reference ? 1 : 0];
    }),
    facts: (() => {
      let factIndex = 0;
      return sections.flatMap(([id, entry]) => (entry.facts || []).map(fact => [
        ++factIndex, aliases.get(id), fact.category, fact.subject, fact.value, fact.block_id || '', fact.quote || '',
      ]));
    })(),
  };
  const globalFacts = (() => { try { return fs.readFileSync(path.join(workspaceDir, '全局事实设定.md'), 'utf8'); } catch { return ''; } })();
  const compactPayload = JSON.stringify(compactInput);
  const repairedIds = (repairs.results || []).filter(item => item.status === 'success').map(item => item.section_id);
  const repairedEntries = repairedIds.map(id => ledger.sections?.[id]).filter(Boolean);
  const naturalness = {
    pass: repairedEntries.filter(entry => entry.naturalness?.status === 'pass' && !(entry.naturalness?.issues || []).length).length,
    needsRevision: repairedEntries.filter(entry => entry.naturalness?.status === 'needs_revision').length,
    unknown: repairedEntries.filter(entry => !['pass', 'needs_revision'].includes(entry.naturalness?.status)).length,
  };
  let changedSectionCharacters = 0;
  for (const target of decisions.targets || []) {
    if (!repairedIds.includes(target.id)) continue;
    try { changedSectionCharacters += fs.readFileSync(path.join(workspaceDir, target.file), 'utf8').length; } catch {}
  }
  return {
    targetSections: (decisions.targets || []).length,
    ledgerSections: sections.length,
    ledgerFailures: Object.keys(ledger.failures || {}).length,
    issueCount,
    factCount,
    factPayloadCharacters,
    compactSemanticInputCharacters: compactPayload.length,
    globalFactsCharacters: globalFacts.length,
    compactSemanticEstimatedTokens: estimateTextTokens(`${globalFacts}\n${compactPayload}`),
    semanticFullLedgerRequests,
    repairedSections: repairedIds.length,
    changedSectionReviewRequests: repairedIds.length,
    changedSectionCharacters,
    repairedNaturalness: naturalness,
    combinedStyleEditsDoNotAddRequests: naturalness.needsRevision,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const defaultRoot = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'OpenBidKit-TouBiaoBao', 'agent-runtime', 'pi', 'tasks', 'technical-plan-content-generation');
  const taskRoot = path.resolve(args['task-root'] || defaultRoot);
  const state = readJson(path.join(taskRoot, 'task-state.json'), {});
  const sessionFile = args.session ? path.resolve(args.session)
    : (state.session_file && fs.existsSync(state.session_file) ? state.session_file : latestFile(path.join(taskRoot, 'sessions'), '.jsonl'));
  const workspaceDir = args.workspace ? path.resolve(args.workspace) : path.join(taskRoot, 'workspace');
  const report = {
    mode: 'read-only-offline-replay',
    privacy: 'counts-and-token-metadata-only',
    session: sessionSummary(sessionFile),
    workspace: workspaceSummary(workspaceDir),
    comparisonNotes: [
      'Historical provider token fields are reported as-is; cached input is not assigned a price or assumed discount.',
      'Structured review request counts are an upper-bound schedule, not a claimed billing reduction.',
      'The single semantic review includes every extracted fact across categories; failure explicitly falls back to the complete raw ledger.',
      'Changed sections still receive one structured fact/naturalness review. Style issues are attached to an existing fact-repair edit, not a second full-section rewrite.',
    ],
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main();
