const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const {
  AlignmentType,
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  PageBreak,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
} = require('docx');
const { readMicrosoftWordPages, adjustContentToTargetPages } = require('../electron/services/contentGenerationPages.cjs');

const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2X9sAAAAASUVORK5CYII=',
  'base64',
);

function contentParagraph(index) {
  return new Paragraph({
    children: [new TextRun(`第${index}项实施说明：项目团队依据实施目标组织工作，逐项明确责任边界、检查节点、记录要求和交付成果，并通过周例会复核执行偏差。`)],
    spacing: { after: 140, line: 360 },
  });
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yibiao-real-pages-'));
  try {
    const document = new Document({ sections: [{ children: [
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 4000 }, children: [new TextRun({ text: '真实分页回归项目', bold: true, size: 44 })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: '技术投标文件', size: 32 })] }),
      new Paragraph({ children: [new PageBreak()] }),
      new Paragraph({ heading: HeadingLevel.HEADING_1, text: '目录' }),
      new Paragraph('第一章 总体实施方案 ................................ 3'),
      new Paragraph('第二章 质量保障方案 ................................ 7'),
      new Paragraph({ children: [new PageBreak()] }),
      new Paragraph({ heading: HeadingLevel.HEADING_1, text: '第一章 总体实施方案' }),
      ...Array.from({ length: 65 }, (_value, index) => contentParagraph(index + 1)),
      new Table({ rows: [
        new TableRow({ children: ['阶段', '责任岗位', '检查记录'].map(text => new TableCell({ children: [new Paragraph(text)] })) }),
        ...Array.from({ length: 16 }, (_value, index) => new TableRow({ children: [
          new TableCell({ children: [new Paragraph(`阶段${index + 1}`)] }),
          new TableCell({ children: [new Paragraph('项目组')] }),
          new TableCell({ children: [new Paragraph(`第${index + 1}项记录`)] }),
        ] })),
      ] }),
      new Paragraph({ children: [new ImageRun({ data: tinyPng, type: 'png', transformation: { width: 240, height: 120 } })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, text: '图1 实施流程图' }),
      new Paragraph({ heading: HeadingLevel.HEADING_1, text: '第二章 质量保障方案' }),
      ...Array.from({ length: 45 }, (_value, index) => contentParagraph(index + 66)),
    ] }] });
    const buffer = await Packer.toBuffer(document);
    const file = path.join(directory, '完整导出.docx');
    fs.writeFileSync(file, buffer);

    const xml = new AdmZip(buffer).readAsText('word/document.xml');
    assert.match(xml, /真实分页回归项目/);
    assert.match(xml, /目录/);
    assert.match(xml, /<w:tbl[ >]/);
    assert.match(xml, /<w:drawing[ >]/);

    const measured = await readMicrosoftWordPages(file, new AbortController().signal);
    assert(measured.pages >= 4);
    let aiCalls = 0;
    const state = await adjustContentToTargetPages({
      aiService: { async chat() { aiCalls += 1; throw new Error('页数已匹配时不应调用模型'); } },
      exporter: { async build() { return { buffer, warnings: [] }; } },
      snapshot: {},
      workspaceDir: directory,
      sections: [],
      targetPages: measured.pages,
      signal: new AbortController().signal,
    });
    assert.equal(state.in_range, true);
    assert.equal(state.measured_pages, measured.pages);
    assert.equal(state.measurement_source, 'microsoft-word');
    assert.equal(aiCalls, 0);
    console.log(`real page closure passed: ${measured.pages} pages; cover, contents, headings, body, table and image share one Word measurement`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
