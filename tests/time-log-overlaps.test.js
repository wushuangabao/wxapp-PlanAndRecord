const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTimeLogOverlapMetadata } = require('../miniprogram/domain/time-log-overlaps');

function log(id, status, startedAt, endedAt, extra = {}) {
  return { id, status, startedAt, endedAt, ...extra };
}

function plainMetadata(logs) {
  return Object.fromEntries(buildTimeLogOverlapMetadata(logs));
}

test('confirmed 与 confirmed 双向累计实际重叠数', () => {
  assert.deepEqual(plainMetadata([
    log('a', 'confirmed', 1_000, 5_000),
    log('b', 'confirmed', 4_000, 8_000)
  ]), {
    a: { totalCount: 1, confirmedCount: 1, candidateCount: 0 },
    b: { totalCount: 1, confirmedCount: 1, candidateCount: 0 }
  });
});

test('confirmed 与 candidate 分别按对方状态累计', () => {
  assert.deepEqual(plainMetadata([
    log('confirmed', 'confirmed', 1_000, 5_000),
    log('candidate', 'candidate', 4_000, 8_000)
  ]), {
    confirmed: { totalCount: 1, confirmedCount: 0, candidateCount: 1 },
    candidate: { totalCount: 1, confirmedCount: 1, candidateCount: 0 }
  });
});

test('candidate 与 candidate 双向累计候选重叠数', () => {
  assert.deepEqual(plainMetadata([
    log('a', 'candidate', 1_000, 5_000),
    log('b', 'candidate', 4_000, 8_000)
  ]), {
    a: { totalCount: 1, confirmedCount: 0, candidateCount: 1 },
    b: { totalCount: 1, confirmedCount: 0, candidateCount: 1 }
  });
});

test('按原始 timestamp 识别一秒重叠，不受分钟数及暂停时长影响', () => {
  assert.deepEqual(plainMetadata([
    log('one-second', 'confirmed', 1_000, 3_000, {
      durationMinutes: 1,
      pausedDurationSeconds: 1
    }),
    log('one-second-peer', 'candidate', 2_000, 4_000, {
      durationMinutes: 100,
      pausedDurationSeconds: 99
    })
  ]), {
    'one-second': { totalCount: 1, confirmedCount: 0, candidateCount: 1 },
    'one-second-peer': { totalCount: 1, confirmedCount: 1, candidateCount: 0 }
  });
});

test('三方重叠时每对只比较一次并分别累计对方状态', () => {
  assert.deepEqual(plainMetadata([
    log('a', 'confirmed', 1_000, 10_000),
    log('b', 'candidate', 2_000, 9_000),
    log('c', 'confirmed', 3_000, 8_000)
  ]), {
    a: { totalCount: 2, confirmedCount: 1, candidateCount: 1 },
    b: { totalCount: 2, confirmedCount: 2, candidateCount: 0 },
    c: { totalCount: 2, confirmedCount: 1, candidateCount: 1 }
  });
});

test('首尾相邻、零时长、倒序时间都不产生假重叠', () => {
  assert.equal(buildTimeLogOverlapMetadata([
    log('a', 'confirmed', 1_000, 2_000),
    log('adjacent', 'candidate', 2_000, 3_000),
    log('zero', 'confirmed', 1_500, 1_500),
    log('reversed', 'candidate', 2_500, 2_000)
  ]).size, 0);
});

test('virtual、plan、recovery preview 与未知状态不参与重叠', () => {
  const persisted = log('persisted', 'confirmed', 1_000, 5_000);
  assert.equal(buildTimeLogOverlapMetadata([
    persisted,
    log('virtual', 'candidate', 2_000, 3_000, { virtual: true }),
    log('plan', 'plan', 2_000, 3_000),
    { id: 'recovery', startedAt: 2_000, endedAt: 3_000, source: 'timer' },
    log('unknown', 'draft', 2_000, 3_000)
  ]).size, 0);
});
