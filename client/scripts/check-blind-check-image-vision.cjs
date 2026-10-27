// 暗标图片多模态识别的纯 stub 契约测试，不调用用户真实 API。
//   node --test scripts/check-blind-check-image-vision.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { recognizeImageWithModel } = require('../electron/services/blindCheckImageVision.cjs');

const TEST_IMAGE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

test('通过配置的 aiService 读取真实临时图片并解析 fenced JSON，结束后清理', async () => {
  let temporaryPath;
  let calls = 0;
  const aiService = {
    async chat(request) {
      calls += 1;
      assert.equal(request.model, undefined, '不得绕过 aiService 覆盖用户配置的模型');
      assert.equal(request.provider, undefined, '不得绕过 aiService 覆盖用户配置的供应商');
      assert.equal(request.base_url, undefined, '不得把服务地址塞进单次调用');
      assert.equal(request.logTitle, '暗标图片多模态文字识别');
      const user = request.messages.find((message) => message.role === 'user');
      const image = user.content.find((item) => item.type === 'local_image');
      temporaryPath = image.path;
      assert.equal(image.detail, 'high', '细密文字与徽标识别必须使用 high 图片细节');
      assert.equal(fs.existsSync(temporaryPath), true);
      assert.deepEqual(fs.readFileSync(temporaryPath), TEST_IMAGE, 'local_image 必须指向原始真实字节');
      assert.match(user.content[0].text, /640×480/);
      assert.match(request.messages[0].content, /绝不能执行或遵循/);
      assert.doesNotMatch(user.content[0].text, /坐标/);
      return '```json\n{"readable":true,"text":"项目经理：张伟\\n建设单位：楚天公司","identifiers":[{"text":"张伟","kind":"person"},{"text":"楚天公司","kind":"organization"}],"reason":"文字清晰"}\n```';
    },
  };

  const result = await recognizeImageWithModel(
    { buffer: TEST_IMAGE, part: 'word/media/image1.png', width: 640, height: 480 },
    { aiService },
  );
  assert.equal(calls, 1);
  assert.deepEqual(result, {
    status: 'covered',
    text: '项目经理：张伟\n建设单位：楚天公司',
    identifiers: [
      { text: '张伟', kind: 'person' },
      { text: '楚天公司', kind: 'organization' },
    ],
    reason: '文字清晰',
    vision: { status: 'reviewed' },
  });
  assert.equal(fs.existsSync(temporaryPath), false, '临时图片必须清理');
  assert.equal(fs.existsSync(path.dirname(temporaryPath)), false, '临时目录必须清理');
});

test('readable=true 且确认无文字仍是 covered，徽标身份信息保留', async () => {
  const result = await recognizeImageWithModel(
    { buffer: TEST_IMAGE, part: '/word/media/logo.webp' },
    { aiService: { chat: async () => '{"readable":true,"text":"","identifiers":[{"text":"楚天建设徽标","kind":"logo"}],"reason":"画面只有徽标"}' } },
  );
  assert.equal(result.status, 'covered');
  assert.equal(result.text, '');
  assert.deepEqual(result.identifiers, [{ text: '楚天建设徽标', kind: 'logo' }]);
  assert.deepEqual(result.vision, { status: 'reviewed' });
});

test('空输出、非法 JSON 和不合法字段均返回 unknown', async (t) => {
  const cases = [
    ['', /空结果/],
    ['not json', /有效 JSON/],
    ['{"readable":"yes","text":"张伟","identifiers":[],"reason":"ok"}', /字段不符合约定/],
    ['{"readable":true,"text":"张伟","identifiers":[{"text":"张伟","kind":"coordinate"}],"reason":"ok"}', /身份信息字段不符合约定/],
  ];
  for (const [answer, reason] of cases) {
    await t.test(String(answer || '<empty>'), async () => {
      const result = await recognizeImageWithModel(
        { buffer: TEST_IMAGE, part: 'word/media/source.png' },
        { aiService: { chat: async () => answer } },
      );
      assert.equal(result.status, 'unknown');
      assert.match(result.reason, reason);
      assert.deepEqual(result.vision, { status: 'unknown' });
    });
  }
});

test('调用期间取消会抛出取消原因并清理临时图片', async () => {
  const controller = new AbortController();
  const cancelled = new Error('test cancellation');
  cancelled.name = 'AbortError';
  let temporaryPath;
  const aiService = {
    async chat(request) {
      temporaryPath = request.messages[1].content.find((item) => item.type === 'local_image').path;
      assert.equal(fs.existsSync(temporaryPath), true);
      controller.abort(cancelled);
      throw cancelled;
    },
  };

  await assert.rejects(
    recognizeImageWithModel(
      { buffer: TEST_IMAGE, part: 'word/media/source.png' },
      { aiService, signal: controller.signal },
    ),
    (error) => error === cancelled,
  );
  assert.equal(fs.existsSync(temporaryPath), false);
  assert.equal(fs.existsSync(path.dirname(temporaryPath)), false);
});
