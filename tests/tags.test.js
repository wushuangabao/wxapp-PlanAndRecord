const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeTag,
  normalizeTags,
  parseTagsText,
  formatTagsText,
  tagsEqual
} = require('../miniprogram/domain/tags');
const {
  createInitialDatabase,
  createTimeLog
} = require('../miniprogram/domain/entities');

test('标签使用 NFKC 和统一空白规范化，保留大小写并按首次出现顺序去重', () => {
  assert.deepEqual(
    normalizeTags([' ＡＩ ', '深  度', 'AI', 'ai', '\t深　度\n', '']),
    ['AI', '深 度', 'ai']
  );
  assert.equal(normalizeTag('　周　复盘　'), '周 复盘');
});

test('标签文本同时支持中英文逗号并复用领域规范化', () => {
  assert.deepEqual(
    parseTagsText(' ＡＩ，深  度,AI，ai，'),
    ['AI', '深 度', 'ai']
  );
});

test('标签文本用 CSV 风格引号可逆表示标签内部的逗号和双引号', () => {
  const tags = ['a,b', '复,盘', '含"引号', '普通'];
  const text = '"a,b"，"复,盘"，"含""引号"，普通';

  assert.equal(formatTagsText(tags), text);
  assert.deepEqual(parseTagsText(text), tags);
  assert.deepEqual(parseTagsText('"复，盘"'), ['复,盘']);
  assert.throws(
    () => parseTagsText('"未闭合，标签'),
    (error) => error.code === 'TAGS_TEXT_INVALID'
  );
});

test('用户标签最多十个且每个规范化后最多五个汉字单位或十个英文字符', () => {
  assert.deepEqual(normalizeTags(['一二三四五']), ['一二三四五']);
  assert.deepEqual(normalizeTags(['abcdefghij']), ['abcdefghij']);
  assert.deepEqual(normalizeTags(['1234567890']), ['1234567890']);
  assert.deepEqual(normalizeTags(['Ａ１b２C３d４E５']), ['A1b2C3d4E5']);
  assert.deepEqual(normalizeTags(['-_.!@#$%^&']), ['-_.!@#$%^&']);
  assert.deepEqual(normalizeTags(['学习abcdef']), ['学习abcdef']);
  assert.deepEqual(normalizeTags(['😀😀😀😀😀']), ['😀😀😀😀😀']);
  assert.throws(
    () => normalizeTags(['一二三四五六']),
    (error) => error.code === 'TAG_TOO_LONG'
  );
  assert.throws(
    () => normalizeTags(['一二abcdefg']),
    (error) => error.code === 'TAG_TOO_LONG'
  );
  assert.throws(
    () => normalizeTags(['abcdefghijk']),
    (error) => error.code === 'TAG_TOO_LONG'
  );
  assert.throws(
    () => normalizeTags(['12345678901']),
    (error) => error.code === 'TAG_TOO_LONG'
  );
  assert.throws(
    () => normalizeTags(Array.from({ length: 11 }, (_, index) => String(index))),
    (error) => error.code === 'TAG_COUNT_EXCEEDED'
      && error.message === '一条记录最多添加 10 个标签，请先移除一个标签后再添加'
  );
});

test('不限额规范化供 JSON 导入使用，但仍拒绝非字符串标签', () => {
  const oversized = Array.from({ length: 11 }, (_, index) => `超长标签${index}`);
  assert.deepEqual(
    normalizeTags(oversized, { enforceLimits: false }),
    oversized
  );
  assert.throws(
    () => normalizeTags(['有效', 1], { enforceLimits: false }),
    (error) => error.code === 'TAGS_INVALID'
  );
});

test('标签相等比较保留数组顺序和大小写语义', () => {
  assert.equal(tagsEqual(['AI', '复盘'], ['AI', '复盘']), true);
  assert.equal(tagsEqual(['AI', '复盘'], ['复盘', 'AI']), false);
  assert.equal(tagsEqual(['AI'], ['ai']), false);
});

test('初始数据库不再包含分类集合，TimeLog 只持久化规范化标签', () => {
  const database = createInitialDatabase(1_700_000_000_000);
  const log = createTimeLog({
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_060_000,
    durationMinutes: 1,
    source: 'manual',
    tags: [' ＡＩ ', '', 'AI']
  }, 1_700_000_060_000);

  assert.equal(Object.hasOwn(database, 'categories'), false);
  assert.equal(Object.hasOwn(log, 'categoryId'), false);
  assert.equal(Object.hasOwn(log, 'categoryNameSnapshot'), false);
  assert.deepEqual(log.tags, ['AI']);
  assert.throws(
    () => createTimeLog({
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_060_000,
      durationMinutes: 1,
      source: 'manual',
      tags: null
    }, 1_700_000_060_000),
    (error) => error.code === 'TAGS_INVALID'
  );
});
