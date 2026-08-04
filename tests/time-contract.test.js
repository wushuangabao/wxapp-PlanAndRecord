const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateLogTiming,
  calculatePausedDurationSeconds
} = require('../miniprogram/domain/time');
const { validLogTiming } = require('../miniprogram/domain/validation');
const { createTimeLog } = require('../miniprogram/domain/entities');

test('20 秒记录向上取整为 1 分钟', () => {
  assert.deepEqual(calculateLogTiming(1_000, 21_000, 0), {
    intervalTotalSeconds: 20,
    pausedDurationSeconds: 0,
    activeDurationSeconds: 20,
    durationMinutes: 1
  });
});

test('暂停秒数从区间总秒数扣除', () => {
  assert.equal(calculateLogTiming(1_000, 121_999, 61).durationMinutes, 1);
});

test('区间总秒数必须严格大于暂停秒数', () => {
  assert.throws(() => validLogTiming(1_000, 61_000, 60));
  assert.throws(() => validLogTiming(1_000, 1_999, 0));
});

test('暂停累计毫秒统一向下取整', () => {
  assert.equal(calculatePausedDurationSeconds([
    { startedAt: 1_000, endedAt: 1_999 },
    { startedAt: 2_000, endedAt: 3_001 }
  ]), 2);
});

test('暂停秒数只接受非负整数', () => {
  for (const pausedDurationSeconds of [-1, 0.5, '0']) {
    assert.throws(() => validLogTiming(1_000, 61_000, pausedDurationSeconds));
  }
});

test('TimeLog 实体显式保存暂停秒数并忽略伪造分钟数', () => {
  const log = createTimeLog({
    startedAt: 1_000,
    endedAt: 121_999,
    pausedDurationSeconds: 61,
    durationMinutes: 999,
    source: 'manual'
  }, 10_000);

  assert.equal(log.pausedDurationSeconds, 61);
  assert.equal(log.durationMinutes, 1);
});

test('TimeLog 实体缺省暂停为 0 并拒绝无有效秒的记录', () => {
  const log = createTimeLog({ startedAt: 1_000, endedAt: 21_000, source: 'manual' }, 10_000);
  assert.equal(log.pausedDurationSeconds, 0);
  assert.equal(log.durationMinutes, 1);
  assert.throws(
    () => createTimeLog({ startedAt: 1_000, endedAt: 61_000, pausedDurationSeconds: 60, source: 'manual' }, 10_000),
    (error) => error.code === 'LOG_TIMING_INVALID'
  );
});
