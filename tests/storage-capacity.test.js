const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DATABASE_STORAGE_LIMIT_BYTES,
  TOTAL_STORAGE_LIMIT_BYTES,
  STORAGE_WARNING_RATIO,
  utf8ByteLength,
  buildStorageUsage,
  isLikelyCapacityFailure
} = require('../miniprogram/repository/storage-capacity');

test('UTF-8 字节数覆盖 ASCII、汉字和代理对', () => {
  assert.equal(utf8ByteLength('A'), 1);
  assert.equal(utf8ByteLength('时'), 3);
  assert.equal(utf8ByteLength('😀'), 4);
});

test('主资料库达到 90% 时生成预警读模型', () => {
  const json = JSON.stringify({
    value: 'x'.repeat(Math.ceil(DATABASE_STORAGE_LIMIT_BYTES * STORAGE_WARNING_RATIO))
  });
  const usage = buildStorageUsage(json, { currentSize: 2048, limitSize: 10240 });

  assert.equal(usage.warning, true);
  assert.equal(usage.exceeded, false);
  assert.equal(usage.databaseLimitBytes, DATABASE_STORAGE_LIMIT_BYTES);
  assert.equal(usage.totalBytes, 2048 * 1024);
  assert.equal(usage.totalLimitBytes, TOTAL_STORAGE_LIMIT_BYTES);
});

test('主资料库超过 1MB 时标记超限且百分比最多展示 100', () => {
  const usage = buildStorageUsage('x'.repeat(DATABASE_STORAGE_LIMIT_BYTES + 1));

  assert.equal(usage.exceeded, true);
  assert.equal(usage.percent, 100);
  assert.equal(usage.totalBytes, null);
  assert.equal(usage.totalLimitBytes, TOTAL_STORAGE_LIMIT_BYTES);
});

test('容量失败只根据安全错误元信息或接近上限的候选判断', () => {
  assert.equal(isLikelyCapacityFailure(new Error('storage quota exceeded'), 1), true);
  assert.equal(isLikelyCapacityFailure({ errMsg: 'setStorage:fail max size reached' }, 1), true);
  assert.equal(
    isLikelyCapacityFailure(new Error('write failed'), DATABASE_STORAGE_LIMIT_BYTES * 0.9),
    true
  );
  assert.equal(isLikelyCapacityFailure(new Error('write failed'), 1024), false);
});
