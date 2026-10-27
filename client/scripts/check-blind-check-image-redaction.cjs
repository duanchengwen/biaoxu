// 暗标图片文字检查与像素脱敏的独立契约测试。
// 纯 Node 运行，不调用用户模型或系统 OCR：
//   node --test scripts/check-blind-check-image-redaction.cjs
//
// 样本覆盖正文图片、页眉图片、正文与页眉共享的同一 media part、不可 OCR 的矢量图，
// 并用可注入 OCR / PNG 编解码器验证真实像素改动、复检、原件不变和共享引用一致。
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');
const AdmZip = require('adm-zip');
const { recognizeImageWithModel } = require('../electron/services/blindCheckImageVision.cjs');

const {
  appendImageTextReport,
  collectImageTextFacts,
  collectModelImageTextFacts,
  locateTextRegions,
  redactImageTextCopy,
  verifyImageRedactions,
  verifyRedactionsWithVision,
} = require('../electron/services/blindCheckImageText.cjs');

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const WIDTH = 48;
const HEIGHT = 24;
const NAME_BOX = { x: 4, y: 4, width: 12, height: 8 };
const NEUTRAL_BOX = { x: 24, y: 4, width: 16, height: 8 };
const IMAGE_CASES = {
  'word/media/body.png': { marker: 10, name: '张伟', neutral: '施工流程' },
  'word/media/header.png': { marker: 20, name: '欧阳娜娜', neutral: '质量控制' },
  'word/media/shared.png': { marker: 30, name: '张伟', neutral: '进度计划' },
};

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** 测试专用无滤镜 RGBA PNG 编码；输入 bitmap 为 Electron 同口径的 BGRA。 */
function encodePng(bitmap, { width, height }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const source = (y * width + x) * 4;
      const target = row + 1 + x * 4;
      raw[target] = bitmap[source + 2];
      raw[target + 1] = bitmap[source + 1];
      raw[target + 2] = bitmap[source];
      raw[target + 3] = bitmap[source + 3];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 只解本测试 encodePng 生成的 8-bit RGBA、filter=0 PNG。 */
function decodePng(buffer) {
  assert.ok(buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), '样本必须保持 PNG 格式');
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.deepEqual([data[8], data[9]], [8, 6], '测试解码器只接受 RGBA PNG');
    } else if (type === 'IDAT') idat.push(data);
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bitmap = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    assert.equal(raw[row], 0, '测试 PNG 必须是 filter=0');
    for (let x = 0; x < width; x += 1) {
      const source = row + 1 + x * 4;
      const target = (y * width + x) * 4;
      bitmap[target] = raw[source + 2];
      bitmap[target + 1] = raw[source + 1];
      bitmap[target + 2] = raw[source];
      bitmap[target + 3] = raw[source + 3];
    }
  }
  return { width, height, bitmap };
}

function pixel(bitmap, width, x, y) {
  const start = (y * width + x) * 4;
  return [...bitmap.subarray(start, start + 4)];
}

function makeImage(marker) {
  const bitmap = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const index = (y * WIDTH + x) * 4;
      const inName = x >= NAME_BOX.x && x < NAME_BOX.x + NAME_BOX.width && y >= NAME_BOX.y && y < NAME_BOX.y + NAME_BOX.height;
      const inNeutral = x >= NEUTRAL_BOX.x && x < NEUTRAL_BOX.x + NEUTRAL_BOX.width && y >= NEUTRAL_BOX.y && y < NEUTRAL_BOX.y + NEUTRAL_BOX.height;
      const [red, green, blue] = inName ? [40, 40, 40] : inNeutral ? [75, 75, 75] : [245, 245, marker];
      bitmap[index] = blue;
      bitmap[index + 1] = green;
      bitmap[index + 2] = red;
      bitmap[index + 3] = 255;
    }
  }
  return encodePng(bitmap, { width: WIDTH, height: HEIGHT });
}

function imageDrawing(rid, id) {
  // alt 故意只放中性文字：改 alt 不能冒充画面文字脱敏。
  return `<w:p><w:r><w:drawing><wp:inline><wp:docPr id="${id}" name="图片 ${id}" descr="技术示意图"/><a:graphic><a:graphicData><a:blip r:embed="${rid}"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

function relationship(id, type, target) {
  return `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`;
}

function relationships(items) {
  return `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join('')}</Relationships>`;
}

function buildFixture(directory, name = '图片文字脱敏样本.docx') {
  const zip = new AdmZip();
  const body = [
    '<w:p><w:r><w:t>项目负责人：张伟</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>项目负责人职责、施工方案、质量保证、中华人民共和国</w:t></w:r></w:p>',
    imageDrawing('rIdBody', 1),
    imageDrawing('rIdShared', 2),
    imageDrawing('rIdVector', 3),
    '<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>',
  ].join('');
  zip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>`, 'utf8'));
  zip.addFile('word/header1.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:hdr ${W}>${imageDrawing('rIdHeaderImage', 4)}${imageDrawing('rIdHeaderShared', 5)}</w:hdr>`, 'utf8'));
  zip.addFile('word/_rels/document.xml.rels', Buffer.from(relationships([
    relationship('rIdBody', 'image', 'media/body.png'),
    relationship('rIdShared', 'image', 'media/shared.png'),
    relationship('rIdVector', 'image', 'media/vector.emf'),
    relationship('rIdHeader', 'header', 'header1.xml'),
  ]), 'utf8'));
  zip.addFile('word/_rels/header1.xml.rels', Buffer.from(relationships([
    relationship('rIdHeaderImage', 'image', 'media/header.png'),
    relationship('rIdHeaderShared', 'image', 'media/shared.png'),
  ]), 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from(relationships([
    `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/>`,
  ]), 'utf8'));
  zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="emf" ContentType="image/x-emf"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>`, 'utf8'));
  for (const [part, item] of Object.entries(IMAGE_CASES)) zip.addFile(part, makeImage(item.marker));
  zip.addFile('word/media/vector.emf', Buffer.from('not-a-raster-emf-test-fixture', 'ascii'));
  // 没有 OOXML 关系的媒体不属于文档可见图片，不应被 OCR。
  zip.addFile('word/media/unreferenced.png', makeImage(40));
  zip.addFile('docProps/thumbnail.png', makeImage(50));
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  zip.writeZip(file);
  return file;
}

function inferImage(bitmap) {
  const marker = pixel(bitmap, WIDTH, 0, 0)[0];
  return Object.entries(IMAGE_CASES).find(([, item]) => item.marker === marker);
}

function regionMatchesOriginal(bitmap, box, original = [40, 40, 40, 255]) {
  let equal = 0;
  let total = 0;
  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      total += 1;
      if (pixel(bitmap, WIDTH, x, y).every((value, index) => value === original[index])) equal += 1;
    }
  }
  return equal / total > 0.9;
}

/**
 * OCR 假实现不依赖调用参数形状：从任意参数里找 bitmap/buffer/part。
 * 画面的姓名框被真正改像素后，复检仍能识别中性文字，但不再返回姓名。
 */
function createOcr({ stickyName = false, throwOnCall = 0, throwOnPartCall = {} } = {}) {
  const calls = [];
  const partCalls = new Map();
  const ocr = async (...args) => {
    const objects = args.filter((value) => value && typeof value === 'object' && !Buffer.isBuffer(value));
    const context = Object.assign({}, ...objects);
    const buffer = args.find(Buffer.isBuffer) || context.buffer || context.data;
    const decoded = context.bitmap ? { width: context.width, height: context.height, bitmap: context.bitmap } : decodePng(buffer);
    const inferred = inferImage(decoded.bitmap);
    assert.ok(inferred, '测试 OCR 应只收到三张有关系的 PNG');
    const [part, item] = inferred;
    calls.push({ part, args });
    partCalls.set(part, (partCalls.get(part) || 0) + 1);
    if (throwOnCall && calls.length === throwOnCall) throw new Error('模拟 OCR 失败');
    if (throwOnPartCall[part] === partCalls.get(part)) throw new Error('模拟 OCR 复检失败');
    const nameVisible = stickyName || regionMatchesOriginal(decoded.bitmap, NAME_BOX);
    const regions = [
      ...(nameVisible ? [{ text: item.name, ...NAME_BOX, confidence: 0.99 }] : []),
      { text: item.neutral, ...NEUTRAL_BOX, confidence: 0.98 },
    ];
    return { width: decoded.width, height: decoded.height, text: regions.map((region) => region.text).join(' '), regions };
  };
  ocr.calls = calls;
  return ocr;
}

function factByPart(facts) {
  return Object.fromEntries(facts.map((fact) => [fact.part, fact]));
}

function zipEntries(file) {
  return Object.fromEntries(new AdmZip(file).getEntries().filter((entry) => !entry.isDirectory).map((entry) => [entry.entryName.replace(/\\/g, '/'), entry.getData()]));
}

function changedRatio(before, after, box) {
  let changed = 0;
  let total = 0;
  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      total += 1;
      if (!pixel(before, WIDTH, x, y).every((value, index) => value === pixel(after, WIDTH, x, y)[index])) changed += 1;
    }
  }
  return changed / total;
}

function assertOutsideUnchanged(before, after, message) {
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      // 生产实现可向外扩 1px 覆盖文字抗锯齿，安全边界外仍必须逐像素不变。
      const inside = x >= NAME_BOX.x - 1 && x < NAME_BOX.x + NAME_BOX.width + 1 && y >= NAME_BOX.y - 1 && y < NAME_BOX.y + NAME_BOX.height + 1;
      if (!inside) assert.deepEqual(pixel(after, WIDTH, x, y), pixel(before, WIDTH, x, y), `${message}：框外像素 (${x},${y}) 被改动`);
    }
  }
}

test('recognizeImageWithModel：把真实本地图片交给配置模型并严格解析文字与身份信息', async () => {
  const buffer = makeImage(10);
  let temporaryImage;
  const result = await recognizeImageWithModel({ buffer, part: 'word/media/body.png', width: WIDTH, height: HEIGHT }, {
    aiService: {
      async chat(payload) {
        const content = payload.messages.find((message) => message.role === 'user').content;
        const image = content.find((item) => item.type === 'local_image');
        temporaryImage = image.path;
        assert.ok(fs.existsSync(temporaryImage));
        assert.ok(fs.readFileSync(temporaryImage).equals(buffer));
        assert.equal(image.detail, 'high');
        assert.match(content.find((item) => item.type === 'text').text, /逐字抄录.*人名.*单位.*徽标/);
        return '```json\n{"readable":true,"text":"项目负责人：张伟 华中建设公司","identifiers":[{"text":"张伟","kind":"person"},{"text":"华中建设公司","kind":"organization"}],"reason":"画面清晰"}\n```';
      },
    },
  });
  assert.deepEqual(result, {
    status: 'covered', text: '项目负责人：张伟 华中建设公司',
    identifiers: [{ text: '张伟', kind: 'person' }, { text: '华中建设公司', kind: 'organization' }],
    reason: '画面清晰', vision: { status: 'reviewed' },
  });
  assert.equal(fs.existsSync(temporaryImage), false, '模型调用结束后临时图片必须删除');
});

test('recognizeImageWithModel：空响应、非法字段和异常都保守 unknown，不伪造模型覆盖', async () => {
  const image = { buffer: makeImage(10), part: 'word/media/body.png', width: WIDTH, height: HEIGHT };
  for (const answer of ['', '{"readable":true,"text":"张伟","identifiers":[]}', '{"readable":true,"text":"张伟","identifiers":[{"text":"张伟","kind":"unknown-kind"}],"reason":"清晰"}']) {
    const result = await recognizeImageWithModel(image, { aiService: { chat: async () => answer } });
    assert.equal(result.status, 'unknown');
    assert.equal(result.vision.status, 'unknown');
    assert.match(result.reason, /须人工复核|字段不符合约定/);
  }
  const failed = await recognizeImageWithModel(image, { aiService: { chat: async () => { throw new Error('模型超时'); } } });
  assert.equal(failed.status, 'unknown');
  assert.equal(failed.vision.status, 'unknown');
  assert.match(failed.reason, /未能完成图片识别/);
});

test('collectImageTextFacts：按 media part 去重，保留正文/页眉全部引用，矢量和 OCR 空结果不伪报已覆盖', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '暗标图片文字检查-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = buildFixture(directory);
  const ocr = createOcr();
  const facts = await collectImageTextFacts(source, { ocr, decode: decodePng });
  const byPart = factByPart(facts);

  assert.deepEqual(Object.keys(byPart).sort(), [...Object.keys(IMAGE_CASES), 'word/media/vector.emf'].sort(), '只处理文档关系实际引用的图片');
  assert.equal(ocr.calls.length, 3, '共享图片按 media part 只 OCR 一次，矢量图不送 OCR');
  for (const [part, item] of Object.entries(IMAGE_CASES)) {
    const fact = byPart[part];
    assert.equal(fact.status, 'covered', `${part} 应完成 OCR`);
    assert.match(fact.text, new RegExp(item.name));
    assert.equal(fact.width, WIDTH);
    assert.equal(fact.height, HEIGHT);
    assert.match(fact.hash, /^[a-f0-9]{64}$/);
    assert.ok(fact.regions.some((region) => region.text === item.name && region.width > 0 && region.height > 0), `${part} 应有姓名坐标`);
    assert.ok(fact.references.length >= 1 && fact.references.every((reference) => reference.part && reference.locator && reference.where), `${part} 引用应可追溯`);
  }
  assert.deepEqual(new Set(byPart['word/media/shared.png'].references.map((item) => item.part)), new Set(['word/document.xml', 'word/header1.xml']), '共享媒体必须保留正文和页眉两处引用');
  assert.equal(byPart['word/media/vector.emf'].status, 'unknown');
  assert.match(byPart['word/media/vector.emf'].reason, /不支持|矢量|EMF|OCR/i);

  const emptyFacts = await collectImageTextFacts(source, {
    decode: decodePng,
    ocr: async () => ({ width: WIDTH, height: HEIGHT, text: '', regions: [] }),
  });
  for (const fact of emptyFacts.filter((item) => item.part.endsWith('.png'))) {
    assert.equal(fact.status, 'unknown', `OCR 空返回不得将 ${fact.part} 伪报为无问题`);
  }

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(collectImageTextFacts(source, { ocr, decode: decodePng, signal: controller.signal }), /取消|abort/i);
});

test('collectModelImageTextFacts：多模态先逐图主识别，本地只补风险项坐标且不能覆盖模型文字', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '暗标多模态主识别-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = buildFixture(directory);
  const sequence = [];
  const visionCalls = [];
  const vision = async ({ part, buffer, width, height }) => {
    sequence.push(`vision:${part}`);
    visionCalls.push({ part, buffer, width, height });
    if (part === 'word/media/body.png') return {
      status: 'covered', text: '模型完整抄录：项目负责人 张伟', identifiers: [{ text: '张伟', kind: 'person' }],
      reason: '画面清晰', vision: { status: 'reviewed' },
    };
    if (part === 'word/media/header.png') return {
      status: 'covered', text: '模型完整抄录：华中建设公司 质量控制', identifiers: [{ text: '华中建设公司', kind: 'organization' }],
      reason: '画面清晰', vision: { status: 'reviewed' },
    };
    return { status: 'covered', text: '模型完整抄录：进度计划', identifiers: [], reason: '画面清晰', vision: { status: 'reviewed' } };
  };
  const baseOcr = createOcr();
  const ocr = async (...args) => {
    const value = await baseOcr(...args);
    sequence.push(`local:${baseOcr.calls.at(-1).part}`);
    return value;
  };
  const facts = await collectModelImageTextFacts(source, {
    aiService: { getConfig: () => ({ multimodal_enabled: true }) },
    vision,
    decode: decodePng,
    ocr,
    sensitiveWords: ['张伟'],
    auxiliaryOcr: true,
  });
  const byPart = factByPart(facts);

  assert.deepEqual(visionCalls.map((call) => call.part).sort(), Object.keys(IMAGE_CASES).sort(), '每个可读媒体 part 应先由模型读取一次，共享引用去重');
  assert.ok(visionCalls.every((call) => Buffer.isBuffer(call.buffer) && call.width === WIDTH && call.height === HEIGHT));
  assert.equal(sequence.findIndex((entry) => entry.startsWith('local:')) > sequence.map((entry) => entry.startsWith('vision:')).lastIndexOf(true), true,
    '所有模型主识别必须先于本地辅助 OCR');
  assert.deepEqual(baseOcr.calls.map((call) => call.part).sort(), ['word/media/body.png', 'word/media/header.png'],
    '只有模型识别到风险或显式敏感词的图片才需要本地定位，纯中性图片不得重复 OCR');

  assert.equal(byPart['word/media/body.png'].primarySource, 'multimodal');
  assert.equal(byPart['word/media/body.png'].text, '模型完整抄录：项目负责人 张伟');
  assert.equal(byPart['word/media/body.png'].modelText, '模型完整抄录：项目负责人 张伟');
  assert.match(byPart['word/media/body.png'].localText, /张伟.*施工流程/);
  assert.ok(byPart['word/media/body.png'].regions.length > 0, '本地 OCR 只提供坐标');
  assert.deepEqual(byPart['word/media/header.png'].identifiers, [{ text: '华中建设公司', kind: 'organization' }]);
  assert.equal(byPart['word/media/header.png'].text, '模型完整抄录：华中建设公司 质量控制', '本地 OCR 不得覆盖成功的模型抄录');
  assert.equal(byPart['word/media/shared.png'].text, '模型完整抄录：进度计划');
  assert.equal(byPart['word/media/shared.png'].localText, undefined, '无风险模型结果不调用本地辅助 OCR');
  assert.equal(byPart['word/media/vector.emf'].status, 'unknown');
  assert.equal(byPart['word/media/vector.emf'].vision.status, 'unknown');

  const report = appendImageTextReport({ groups: [], stats: {} }, facts, {
    sensitiveWords: ['张伟'], profile: { privacy: { enable_builtin: true, keywords: [], whitelist: [] } },
  });
  assert.deepEqual(new Set(report.groups.map((group) => group.ruleId)), new Set(['image.text_sensitive', 'image.identity_candidate', 'image.ocr_unchecked']));
  assert.deepEqual([report.stats.imageVisionTotal, report.stats.imageVisionChecked, report.stats.imageOcrFallback], [4, 3, 0]);
});

test('collectModelImageTextFacts：模型失败才明确 local-fallback；关闭多模态直接本地且零模型调用', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '暗标多模态兜底-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = buildFixture(directory);
  let modelCalls = 0;
  const fallbackOcr = createOcr();
  const facts = await collectModelImageTextFacts(source, {
    aiService: { getConfig: () => ({ multimodal_enabled: true }) },
    decode: decodePng,
    ocr: fallbackOcr,
    auxiliaryOcr: true,
    async vision({ part }) {
      modelCalls += 1;
      if (part === 'word/media/body.png') return { status: 'unknown', text: '', identifiers: [], reason: '模型超时', vision: { status: 'unknown' } };
      return { status: 'covered', text: '模型确认无身份信息', identifiers: [], reason: '清晰', vision: { status: 'reviewed' } };
    },
  });
  const body = factByPart(facts)['word/media/body.png'];
  assert.equal(modelCalls, 3);
  assert.equal(body.primarySource, 'local-fallback');
  assert.equal(body.status, 'covered');
  assert.equal(body.vision.status, 'unknown', '本地兜底不能伪装成模型已核验');
  assert.equal(body.modelText, '');
  assert.match(body.localText, /张伟.*施工流程/);
  assert.equal(body.text, body.localText);
  assert.match(body.reason, /多模态主识别失败.*本地 OCR 兜底/);
  const fallbackReport = appendImageTextReport({ groups: [], stats: {} }, facts, {
    sensitiveWords: [], profile: { privacy: { enable_builtin: true, keywords: [], whitelist: [] } },
  });
  assert.equal(fallbackReport.stats.imageVisionChecked, 2);
  assert.equal(fallbackReport.stats.imageOcrFallback, 1);
  assert.ok(fallbackReport.stats.imageOcrUnknown >= 2, '本地兜底和不支持图片都必须计入未完全核验覆盖');
  assert.ok(fallbackReport.groups.some((group) => group.ruleId === 'image.ocr_unchecked'), 'fallback 必须进入待复核组');

  let disabledModelCalls = 0;
  const localOcr = createOcr();
  const disabled = await collectModelImageTextFacts(source, {
    aiService: {
      getConfig: () => ({ multimodal_enabled: false }),
      chat: async () => { disabledModelCalls += 1; throw new Error('关闭时不应调用'); },
    },
    decode: decodePng,
    ocr: localOcr,
  });
  assert.equal(disabledModelCalls, 0);
  assert.equal(localOcr.calls.length, 3);
  assert.ok(disabled.every((fact) => fact.primarySource === undefined), '关闭多模态时必须保持纯本地事实结构');
});

test('collectModelImageTextFacts：同任务同hash复用已尝试结果；新任务、像素变化才重新读图', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '暗标多模态缓存-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = buildFixture(directory);
  const makeVision = (calls) => async ({ part }) => {
    calls.push(part);
    return { status: 'covered', text: `模型抄录 ${part}`, identifiers: [], reason: '清晰', vision: { status: 'reviewed' } };
  };
  const firstCalls = [];
  const initial = await collectModelImageTextFacts(source, {
    aiService: { getConfig: () => ({ multimodal_enabled: true }) }, vision: makeVision(firstCalls), decode: decodePng, auxiliaryOcr: false,
  });
  assert.equal(firstCalls.length, 3);
  assert.ok(initial.filter((fact) => fact.part.endsWith('.png')).every((fact) => fact.vision.attempted === true));

  const reusedCalls = [];
  const reused = await collectModelImageTextFacts(source, {
    aiService: { getConfig: () => ({ multimodal_enabled: true }) }, vision: makeVision(reusedCalls), decode: decodePng,
    auxiliaryOcr: false, previousFacts: initial,
  });
  assert.equal(reusedCalls.length, 0, '同一任务内相同 part+hash 的 reviewed 结果不得重复收费调用');
  assert.deepEqual(reused.filter((fact) => fact.part.endsWith('.png')).map((fact) => fact.modelText),
    initial.filter((fact) => fact.part.endsWith('.png')).map((fact) => fact.modelText));

  const fallbackPrevious = initial.map((fact) => fact.part === 'word/media/body.png'
    ? { ...fact, primarySource: 'local-fallback', status: 'covered', vision: { status: 'unknown', attempted: true } }
    : fact);
  const fallbackCalls = [];
  const fallbackReused = await collectModelImageTextFacts(source, {
    aiService: { getConfig: () => ({ multimodal_enabled: true }) }, vision: makeVision(fallbackCalls), decode: decodePng,
    auxiliaryOcr: false, previousFacts: fallbackPrevious,
  });
  assert.deepEqual(fallbackCalls, [], '同一任务内明确 attempted 的 unknown/local-fallback 也应复用，避免重复费用');
  assert.equal(factByPart(fallbackReused)['word/media/body.png'].primarySource, 'local-fallback');

  const unknownPrevious = initial.map((fact) => fact.part === 'word/media/header.png'
    ? { ...fact, status: 'unknown', text: '', modelText: '', reason: '本次任务已读图但无法确认', vision: { status: 'unknown', attempted: true } }
    : fact);
  const unknownCalls = [];
  const unknownReused = await collectModelImageTextFacts(source, {
    aiService: { getConfig: () => ({ multimodal_enabled: true }) }, vision: makeVision(unknownCalls), decode: decodePng,
    auxiliaryOcr: false, previousFacts: unknownPrevious,
  });
  assert.deepEqual(unknownCalls, [], '同任务同哈希的 attempted unknown 也不重复收费');
  assert.equal(factByPart(unknownReused)['word/media/header.png'].status, 'unknown');

  const newTaskCalls = [];
  await collectModelImageTextFacts(source, {
    aiService: { getConfig: () => ({ multimodal_enabled: true }) }, vision: makeVision(newTaskCalls), decode: decodePng,
    auxiliaryOcr: false,
  });
  assert.equal(newTaskCalls.length, 3, '显式新任务没有 previousFacts，不得把旧任务 unknown 当成跨任务缓存');

  const changedZip = new AdmZip(source);
  changedZip.updateFile('word/media/body.png', makeImage(11));
  changedZip.writeZip(source);
  const changedCalls = [];
  const changed = await collectModelImageTextFacts(source, {
    aiService: { getConfig: () => ({ multimodal_enabled: true }) }, vision: makeVision(changedCalls), decode: decodePng,
    auxiliaryOcr: false, previousFacts: initial,
  });
  assert.deepEqual(changedCalls, ['word/media/body.png'], '媒体像素哈希变化必须重新调用模型，其他未变 part 继续复用');
  assert.notEqual(factByPart(changed)['word/media/body.png'].hash, factByPart(initial)['word/media/body.png'].hash);
});

test('collectModelImageTextFacts：超大图模型成功仍做本地小字对比，差异只警告不覆盖主文本', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '暗标大图辅助核验-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = buildFixture(directory);
  const localOcr = createOcr();
  const facts = await collectModelImageTextFacts(source, {
    aiService: { getConfig: () => ({ multimodal_enabled: true }) },
    decode: (buffer) => ({ ...decodePng(buffer), width: 3000, height: 2200 }),
    ocr: localOcr,
    vision: async ({ part }) => ({ status: 'covered', text: `模型主抄录 ${part}`, identifiers: [], reason: '清晰', vision: { status: 'reviewed' } }),
  });
  assert.equal(localOcr.calls.length, 3, '超过 2048 像素的可读图全部需要本地 OCR 小字辅助对比');
  const body = factByPart(facts)['word/media/body.png'];
  assert.equal(body.text, '模型主抄录 word/media/body.png', '本地识别不得覆盖模型主文本');
  assert.match(body.localText, /张伟.*施工流程/);
  assert.match(body.auxiliaryWarning, /大图小字.*模型可能遗漏/);
  const report = appendImageTextReport({ groups: [], stats: {} }, facts, {
    sensitiveWords: [], profile: { privacy: { enable_builtin: true, keywords: [], whitelist: [] } },
  });
  assert.ok(report.groups.some((group) => group.ruleId === 'image.ocr_unchecked'
    && group.items.some((item) => item.part === body.part && /大图小字/.test(item.detail))), '辅助差异必须进未核验组');
});

test('locateTextRegions：中文 OCR 合并词只定位明确姓名子区间，不整块清空', () => {
  const fact = {
    status: 'covered',
    angle: 0,
    regions: [{ text: '项目负责人张伟', x: 10, y: 5, width: 70, height: 12 }],
  };
  const boxes = locateTextRegions(fact, '张伟');
  assert.equal(boxes.length, 1);
  assert.ok(boxes[0].x > 10 && boxes[0].width < 70, JSON.stringify(boxes));
  assert.equal(Math.round(boxes[0].x), 60, '七个汉字中只覆盖末尾两个字');
  assert.equal(Math.round(boxes[0].width), 20);
  // 带标点的 OCR 词无法按等宽汉字安全切分时，应拒绝自动涂抹而不是清空整行。
  assert.deepEqual(locateTextRegions({ ...fact, regions: [{ ...fact.regions[0], text: '项目负责人：张伟' }] }, '张伟'), []);
});

test('appendImageTextReport：不把任意中文当姓名，只有明确词或角色上下文进入对应检查组', () => {
  const facts = [{
    part: 'word/media/body.png', status: 'covered', hash: 'hash', width: 100, height: 30,
    text: '施工方案 质量保证 中华人民共和国 项目负责人：张伟', regions: [{ text: '施工方案', x: 1, y: 1, width: 20, height: 8 }],
    references: [{ part: 'word/document.xml', locator: 'word/document.xml#image1', where: '正文第1个图片引用' }],
  }];
  const base = { groups: [], stats: {} };
  const profile = { privacy: { enable_builtin: true, keywords: [], whitelist: [] } };
  const withoutList = appendImageTextReport(base, facts, { profile, sensitiveWords: [] });
  assert.deepEqual(withoutList.groups.map((group) => group.ruleId), ['image.person_name_candidate']);
  assert.deepEqual(withoutList.groups[0].items.map((item) => item.expectedText), ['张伟']);
  assert.equal(withoutList.groups[0].candidate, true, '角色标签姓名只能先作为候选，需 AI/人工确认');
  assert.ok(withoutList.groups.every((group) => !group.items.some((item) => /施工方案|中华人民共和国/.test(item.expectedText))), '普通中文和专业术语不能被屏蔽');

  const explicit = appendImageTextReport(base, facts, { profile, sensitiveWords: ['质量保证'] });
  assert.deepEqual(explicit.groups.map((group) => group.ruleId), ['image.text_sensitive', 'image.person_name_candidate']);
  assert.deepEqual(explicit.groups[0].items.map((item) => item.expectedText), ['质量保证']);
});

test('appendImageTextReport：模型 identifiers 遵循内建规则、联系方式、单位、忽略与白名单开关并去重', () => {
  const facts = [{
    part: 'word/media/identity.png', status: 'covered', hash: 'identity-hash', width: 200, height: 80,
    primarySource: 'multimodal', vision: { status: 'reviewed', attempted: true },
    text: '项目负责人：张伟 13812345678 test@example.com 华中建设有限公司 安全监督部门', regions: [],
    identifiers: [
      { text: '张伟', kind: 'person' }, { text: ' 张伟 ', kind: 'person' },
      { text: '13812345678', kind: 'phone' }, { text: 'test@example.com', kind: 'email' },
      { text: '华中建设有限公司', kind: 'organization' }, { text: '安全监督部门', kind: 'organization' },
      { text: '华中建设徽标', kind: 'logo' },
    ],
    references: [{ part: 'word/document.xml', locator: 'word/document.xml#image1', where: '正文第1个图片引用' }],
  }];
  const base = { groups: [], stats: {} };
  const controlled = appendImageTextReport(base, facts, { sensitiveWords: [], profile: { privacy: {
    enable_builtin: true, check_phone: false, check_email: false, check_company_suffix: true,
    ignore_orgs: ['安全监督部门'], whitelist: [], keywords: [],
  } } });
  const candidate = controlled.groups.find((group) => group.ruleId === 'image.person_name_candidate');
  const identity = controlled.groups.find((group) => group.ruleId === 'image.identity_candidate');
  assert.deepEqual(candidate.items.map((item) => item.text), ['张伟'], '同kind+规范化文本必须去重，角色启发不能再添一条');
  assert.deepEqual(identity.items.map((item) => [item.kind, item.text]), [['organization', '华中建设有限公司'], ['logo', '华中建设徽标']]);
  assert.ok(!controlled.groups.some((group) => group.items.some((item) => /13812345678|test@example\.com|安全监督部门/.test(item.text))), '关闭或忽略的 identifier 不得进问题');

  const disabled = appendImageTextReport(base, facts, { sensitiveWords: ['华中建设有限公司'], profile: { privacy: {
    enable_builtin: false, whitelist: [], keywords: [],
  } } });
  assert.deepEqual(disabled.groups.map((group) => group.ruleId), ['image.text_sensitive'], '关闭内建隐私规则后，identifier 和角色姓名均不产生候选，但用户明确词仍有效');

  const whitelisted = appendImageTextReport(base, facts, { sensitiveWords: [], profile: { privacy: {
    enable_builtin: true, check_phone: false, check_email: false, check_company_suffix: false,
    whitelist: ['张伟', '华中建设徽标'], keywords: [],
  } } });
  assert.ok(!whitelisted.groups.some((group) => ['image.person_name_candidate', 'image.identity_candidate'].includes(group.ruleId)), '白名单与单位开关必须抑制对应 identifiers');
});

test('verifyImageRedactions：同一媒体分次遮盖必须沿连续哈希链核到最终文件，断链或最终未知不放行', () => {
  const records = [
    { part: 'word/media/shared.png', beforeHash: 'hash-a', afterHash: 'hash-b', status: 'fixed', redacted: [{ x: 1 }], requests: [{ expectedText: '张三', issue: 'g1' }] },
    { part: 'word/media/shared.png', beforeHash: 'hash-b', afterHash: 'hash-c', status: 'fixed', redacted: [{ x: 2 }], requests: [{ expectedText: '李四', issue: 'a1' }] },
  ];
  const covered = [{ part: 'word/media/shared.png', status: 'covered', hash: 'hash-c', text: '施工方案' }];
  const verified = verifyImageRedactions(records, covered);
  assert.deepEqual(verified.map((record) => [record.status, record.afterHash]), [['fixed', 'hash-c'], ['fixed', 'hash-c']]);

  const broken = verifyImageRedactions([{ ...records[0] }, { ...records[1], beforeHash: 'other' }], covered);
  assert.deepEqual(broken.map((record) => record.status), ['pending', 'fixed'], '断链时前一条记录不能借后一次修改冒充最终证据');
  const unknown = verifyImageRedactions(records, [{ ...covered[0], status: 'unknown', text: '', reason: 'empty_result' }]);
  assert.deepEqual(unknown.map((record) => record.status), ['unknown', 'unknown']);
});

test('verifyRedactionsWithVision：开启时按媒体 part 传真实 local_image，absent 才保留 fixed；关闭时完全不调用', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '暗标多模态复检-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = buildFixture(directory);
  const records = [{
    part: 'word/media/body.png', beforeHash: 'before', afterHash: 'after', status: 'fixed',
    requests: [{ expectedText: '张伟', issue: 'g1' }], redacted: [{ x: 1, y: 1, width: 2, height: 2 }],
  }, {
    part: 'word/media/body.png', beforeHash: 'before-2', afterHash: 'after', status: 'fixed',
    requests: [{ expectedText: '李四', issue: 'a1' }], redacted: [{ x: 3, y: 1, width: 2, height: 2 }],
  }];
  let disabledCalls = 0;
  const disabled = await verifyRedactionsWithVision(source, records, {
    aiService: { getConfig: () => ({ multimodal_enabled: false }), chat: async () => { disabledCalls += 1; } },
  });
  assert.strictEqual(disabled, records);
  assert.equal(disabledCalls, 0, '多模态开关关闭时不得调用视觉模型');

  const calls = [];
  const progress = [];
  const verified = await verifyRedactionsWithVision(source, records, {
    aiService: {
      getConfig: () => ({ multimodal_enabled: true }),
      async chat(payload) {
        calls.push(payload);
        const content = payload.messages.find((message) => message.role === 'user').content;
        const image = content.find((item) => item.type === 'local_image');
        assert.ok(image?.path && fs.existsSync(image.path), '必须把最终 DOCX 中解出的真实图片传给模型');
        assert.ok(new AdmZip(source).getEntry('word/media/body.png').getData().equals(fs.readFileSync(image.path)));
        assert.match(content.find((item) => item.type === 'text').text, /张伟.*李四/);
        return JSON.stringify({ target_status: 'absent', reason: '目标文字均不存在' });
      },
    },
    onProgress: (done, total) => progress.push([done, total]),
  });
  assert.equal(calls.length, 1, '同一媒体 part 多条记录只调用一次视觉复检');
  assert.deepEqual(progress, [[1, 1]]);
  assert.deepEqual(verified.map((record) => [record.status, record.vision]), [['fixed', 'absent'], ['fixed', 'absent']]);
});

test('verifyRedactionsWithVision：present 降为 pending，unknown/异常降为 unknown 并保留原证据待复核', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '暗标多模态异常-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = buildFixture(directory);
  const record = {
    part: 'word/media/body.png', beforeHash: 'before', afterHash: 'after', status: 'fixed',
    requests: [{ expectedText: '张伟', issue: 'g1' }], redacted: [{ x: 1, y: 1, width: 2, height: 2 }],
  };
  const run = (chat) => verifyRedactionsWithVision(source, [record], {
    aiService: { getConfig: () => ({ multimodal_enabled: true }), chat },
  });
  const present = (await run(async () => '```json\n{"target_status":"present","reason":"仍可见"}\n```'))[0];
  assert.deepEqual([present.status, present.vision], ['pending', 'present']);
  assert.match(present.reason, /仍发现目标文字/);

  const unknown = (await run(async () => JSON.stringify({ target_status: 'unknown', reason: '图片模糊' })))[0];
  assert.deepEqual([unknown.status, unknown.vision, unknown.beforeHash, unknown.requests], ['unknown', 'unknown', 'before', record.requests]);
  assert.match(unknown.reason, /人工核验/);

  const failed = (await run(async () => { throw new Error('模型超时'); }))[0];
  assert.deepEqual([failed.status, failed.vision, failed.afterHash, failed.requests], ['unknown', 'unknown', 'after', record.requests], '模型异常不能抹掉 OCR/hash 原证据，也不能继续报 fixed');
});

test('redactImageTextCopy：真正改坐标框内像素，共享引用一致，原件与无关 part 不变', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '暗标图片脱敏-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = buildFixture(directory);
  const target = path.join(directory, '脱敏副本.docx');
  const sourceHash = sha256(fs.readFileSync(source));
  const beforeEntries = zipEntries(source);
  const beforeFacts = await collectImageTextFacts(source, { ocr: createOcr(), decode: decodePng });
  const requests = Object.entries(IMAGE_CASES).map(([part, item]) => ({
    part,
    expectedText: item.name,
    sourceHash: beforeFacts.find((fact) => fact.part === part).hash,
    issue: `issue-${item.marker}`,
  }));
  // 不支持的矢量图要显式返回 unknown，不能静默当作 fixed。
  requests.push({ part: 'word/media/vector.emf', expectedText: '张伟', issue: 'issue-vector' });

  const result = await redactImageTextCopy(source, target, requests, {
    ocr: createOcr(),
    decode: decodePng,
    encode: (bitmap, options) => encodePng(bitmap, options),
  });
  assert.equal(sha256(fs.readFileSync(source)), sourceHash, '修复绝不能改写原件');
  assert.ok(fs.existsSync(target), '应另写修复副本');

  const images = factByPart(result.images);
  const afterFacts = factByPart(result.facts);
  const afterEntries = zipEntries(target);
  for (const [part, item] of Object.entries(IMAGE_CASES)) {
    assert.equal(images[part].status, 'fixed', `${part} 必须以修改后复检为准`);
    assert.notEqual(images[part].beforeHash, images[part].afterHash, `${part} 不能只改 alt 或处理记录`);
    assert.equal(afterFacts[part].status, 'covered');
    assert.doesNotMatch(afterFacts[part].text, new RegExp(item.name), `${part} 复检不应再有姓名`);
    assert.match(afterFacts[part].text, new RegExp(item.neutral), `${part} 中性画面文字应保留`);
    const before = decodePng(beforeEntries[part]);
    const after = decodePng(afterEntries[part]);
    assert.deepEqual([after.width, after.height], [before.width, before.height], `${part} 尺寸不得变`);
    assert.ok(changedRatio(before.bitmap, after.bitmap, NAME_BOX) >= 0.9, `${part} OCR 坐标框至少 90% 像素应被遮挡`);
    assertOutsideUnchanged(before.bitmap, after.bitmap, part);
  }
  assert.equal(images['word/media/vector.emf'].status, 'unknown');
  assert.ok(afterEntries['word/media/vector.emf'].equals(beforeEntries['word/media/vector.emf']), '不支持的矢量图不得盲改字节');

  const allowedChanges = new Set(Object.keys(IMAGE_CASES));
  for (const [entry, bytes] of Object.entries(beforeEntries)) {
    if (!allowedChanges.has(entry)) assert.ok(afterEntries[entry].equals(bytes), `无关 ZIP part 必须原样保留：${entry}`);
  }
  assert.equal(Object.keys(afterEntries).filter((entry) => entry === 'word/media/shared.png').length, 1, '共享媒体不应拆成多份');
  assert.ok(afterEntries['word/_rels/document.xml.rels'].equals(beforeEntries['word/_rels/document.xml.rels']));
  assert.ok(afterEntries['word/_rels/header1.xml.rels'].equals(beforeEntries['word/_rels/header1.xml.rels']));
  assert.match(afterEntries['word/document.xml'].toString('utf8'), /项目负责人：张伟/, '图片工具不得误改正文');
  // 中性中文不得因“全中文”策略被清空。
  assert.match(afterEntries['word/document.xml'].toString('utf8'), /项目负责人职责、施工方案、质量保证、中华人民共和国/);
});

test('redactImageTextCopy：修改后 OCR 仍命中或 OCR 异常时不得伪报 fixed', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '暗标图片复检-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = buildFixture(directory);
  const part = 'word/media/body.png';
  const request = [{ part, expectedText: '张伟', issue: 'a1' }];

  const sticky = await redactImageTextCopy(source, path.join(directory, '复检仍命中.docx'), request, {
    ocr: createOcr({ stickyName: true }),
    decode: decodePng,
    encode: (bitmap, options) => encodePng(bitmap, options),
  });
  const stickyImage = sticky.images.find((image) => image.part === part);
  assert.notEqual(stickyImage.status, 'fixed', '复检仍识别到姓名时，不采信 Agent/disposition 的 fixed 说法');
  assert.match(factByPart(sticky.facts)[part].text, /张伟/);

  const failingOcr = createOcr({ throwOnPartCall: { [part]: 2 } });
  const failedRecheck = await redactImageTextCopy(source, path.join(directory, '复检异常.docx'), request, {
    ocr: failingOcr,
    decode: decodePng,
    encode: (bitmap, options) => encodePng(bitmap, options),
  });
  const failedImage = failedRecheck.images.find((image) => image.part === part);
  assert.notEqual(failedImage.status, 'fixed', 'OCR 复检异常只能是 unknown/error/pending');
  assert.ok(['unknown', 'error', 'pending'].includes(failedImage.status), JSON.stringify(failedImage));
});

test('redactImageTextCopy：图片哈希已变或 OCR 找不到精确文字时拒绝盲涂像素', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '暗标图片过期保护-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = buildFixture(directory);
  const original = zipEntries(source)['word/media/body.png'];

  const staleOutput = path.join(directory, '过期哈希.docx');
  const stale = await redactImageTextCopy(source, staleOutput, [{
    part: 'word/media/body.png', expectedText: '张伟', sourceHash: '0'.repeat(64), issue: 'a1',
  }], { ocr: createOcr(), decode: decodePng, encode: (bitmap, options) => encodePng(bitmap, options) });
  assert.equal(stale.images[0].status, 'pending');
  assert.match(stale.images[0].reason, /已变化|重新检查/);
  assert.ok(zipEntries(staleOutput)['word/media/body.png'].equals(original), '过期坐标不得改像素');

  const absentOutput = path.join(directory, '文字不匹配.docx');
  const absent = await redactImageTextCopy(source, absentOutput, [{
    part: 'word/media/body.png', expectedText: '王强', issue: 'a2',
  }], { ocr: createOcr(), decode: decodePng, encode: (bitmap, options) => encodePng(bitmap, options) });
  assert.equal(absent.images[0].status, 'pending');
  assert.match(absent.images[0].reason, /无法可靠定位|未修改/);
  assert.ok(zipEntries(absentOutput)['word/media/body.png'].equals(original), '未命中目标文字时不得改像素');
});

