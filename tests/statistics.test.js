const test = require('node:test');
const assert = require('node:assert/strict');

const { LOG_SOURCE, LOG_STATUS } = require('../miniprogram/domain/constants');
const {
  createCalendarEvent,
  createInitialDatabase,
  createRepeatRule,
  createTimeLog
} = require('../miniprogram/domain/entities');
const { createOccurrenceException, projectRule } = require('../miniprogram/domain/recurrence');
const { buildStatistics, includedLogs } = require('../miniprogram/domain/statistics');

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function recurringDatabase(now = 1_700_000_000_000) {
  const database = createInitialDatabase(now);
  const startedAt = now + HOUR_MS;
  const endedAt = startedAt + HOUR_MS;
  const rule = createRepeatRule({
    title: '每日复盘',
    startedAt,
    endedAt,
    priority: 1,
    frequency: 'daily',
    interval: 1
  }, now + 1);
  const event = createCalendarEvent({
    title: rule.title,
    startedAt,
    endedAt,
    priority: 1,
    repeatRuleId: rule.id,
    repeatRuleSummarySnapshot: rule.title
  }, now + 2);
  database.repeatRules.push(rule);
  database.calendarEvents.push(event);
  return { database, rule, startedAt };
}

test('统计开启候选估算时按需纳入未物化的重复规则实例', () => {
  const { database, startedAt } = recurringDatabase();
  const options = {
    rangeStart: startedAt,
    rangeEnd: startedAt + 2 * DAY_MS
  };

  const confirmedOnly = buildStatistics(database, options);
  const withCandidates = buildStatistics(database, {
    ...options,
    includeCandidates: true
  });

  assert.equal(confirmedOnly.totalMinutes, 0);
  assert.equal(withCandidates.totalMinutes, 120);
  assert.equal(withCandidates.weeklyReview.logCount, 2);
  assert.deepEqual(
    withCandidates.categories.map((item) => [item.name, item.durationMinutes]),
    [['未分类', 120]]
  );
  assert.equal(withCandidates.planVariance.nonPlannedMinutes, 0);
});

test('统计不会重复计算已有计划块或已物化日志对应的重复实例', () => {
  const { database, rule, startedAt } = recurringDatabase();
  const occurrences = projectRule(
    rule,
    startedAt,
    startedAt + 2 * DAY_MS,
    database.occurrenceExceptions
  );
  const materialized = occurrences.find((item) => item.occurrenceStart === startedAt + DAY_MS);
  database.timeLogs.push(createTimeLog({
    startedAt: materialized.startedAt,
    endedAt: materialized.endedAt,
    durationMinutes: 60,
    note: materialized.title,
    status: LOG_STATUS.CONFIRMED,
    source: LOG_SOURCE.RULE,
    originRuleId: rule.id,
    originOccurrenceId: materialized.originOccurrenceId,
    originRuleSummarySnapshot: rule.title
  }, startedAt + 3 * DAY_MS));

  const statistics = buildStatistics(database, {
    rangeStart: startedAt,
    rangeEnd: startedAt + 2 * DAY_MS,
    includeCandidates: true
  });

  assert.equal(statistics.totalMinutes, 120);
  assert.equal(statistics.weeklyReview.logCount, 2);
});

test('统计按规则与原始发生时间跨修订去重已确认实例', () => {
  const { database, rule, startedAt } = recurringDatabase();
  const occurrenceStart = startedAt + DAY_MS;
  const oldOccurrence = projectRule(
    rule,
    occurrenceStart,
    occurrenceStart,
    database.occurrenceExceptions
  )[0];
  database.timeLogs.push(createTimeLog({
    startedAt: oldOccurrence.startedAt,
    endedAt: oldOccurrence.endedAt,
    durationMinutes: 60,
    note: oldOccurrence.title,
    status: LOG_STATUS.CONFIRMED,
    source: LOG_SOURCE.RULE,
    originRuleId: rule.id,
    originOccurrenceId: oldOccurrence.originOccurrenceId,
    originRuleSummarySnapshot: rule.title
  }, occurrenceStart + DAY_MS));

  const oldRevision = rule.revisions[0];
  oldRevision.effectiveUntil = occurrenceStart - 1;
  rule.revisions.push({
    ...oldRevision,
    id: 'revision_statistics_2',
    revision: 2,
    effectiveFrom: occurrenceStart,
    effectiveUntil: null
  });

  const statistics = buildStatistics(database, {
    rangeStart: occurrenceStart,
    rangeEnd: occurrenceStart + HOUR_MS,
    includeCandidates: true
  });

  assert.equal(statistics.totalMinutes, 60);
  assert.equal(statistics.weeklyReview.logCount, 1);
});

test('统计不会让格式异常的导入实例 ID 误命中逻辑去重键', () => {
  const { database, rule, startedAt } = recurringDatabase();
  const occurrenceStart = startedAt + DAY_MS;
  database.timeLogs.push(createTimeLog({
    startedAt: occurrenceStart - 2 * HOUR_MS,
    endedAt: occurrenceStart - HOUR_MS,
    durationMinutes: 60,
    note: '异常实例 ID 的历史日志',
    status: LOG_STATUS.CONFIRMED,
    source: LOG_SOURCE.RULE,
    originRuleId: rule.id,
    originOccurrenceId: `${rule.id}:not-a-revision:${occurrenceStart}`,
    originRuleSummarySnapshot: rule.title
  }, occurrenceStart + DAY_MS));

  const statistics = buildStatistics(database, {
    rangeStart: occurrenceStart,
    rangeEnd: occurrenceStart + HOUR_MS,
    includeCandidates: true
  });

  assert.equal(statistics.totalMinutes, 60);
  assert.equal(statistics.weeklyReview.logCount, 1);
});

test('统计按单次改期后的最终区间纳入或排除虚拟候选', () => {
  const movedOut = recurringDatabase();
  const originalStart = movedOut.startedAt + DAY_MS;
  movedOut.database.occurrenceExceptions.push(createOccurrenceException(
    movedOut.rule.id,
    originalStart,
    'override',
    {
      title: '移出范围',
      startedAt: originalStart + 4 * DAY_MS,
      endedAt: originalStart + 4 * DAY_MS + HOUR_MS,
      priority: 1
    },
    originalStart
  ));

  assert.equal(includedLogs(
    movedOut.database,
    originalStart,
    originalStart + HOUR_MS,
    true
  ).length, 0);

  const movedIn = recurringDatabase();
  const targetStart = movedIn.startedAt + DAY_MS;
  const movedOccurrenceStart = movedIn.startedAt + 2 * DAY_MS;
  movedIn.database.occurrenceExceptions.push(
    createOccurrenceException(movedIn.rule.id, targetStart, 'skip', null, targetStart),
    createOccurrenceException(
      movedIn.rule.id,
      movedOccurrenceStart,
      'override',
      {
        title: '移入范围',
        startedAt: targetStart + 15 * 60 * 1000,
        endedAt: targetStart + 75 * 60 * 1000,
        priority: 1
      },
      movedOccurrenceStart
    )
  );

  const movedInLogs = includedLogs(
    movedIn.database,
    targetStart,
    targetStart + HOUR_MS,
    true
  );
  assert.deepEqual(
    movedInLogs.map((log) => [log.occurrenceStart, log.startedAt, log.durationMinutes]),
    [[movedOccurrenceStart, targetStart + 15 * 60 * 1000, 60]]
  );
});

test('已物化计划块按原始发生时间抑制单次改期后的虚拟候选', () => {
  const { database, rule, startedAt } = recurringDatabase();
  database.occurrenceExceptions.push(createOccurrenceException(
    rule.id,
    startedAt,
    'override',
    {
      title: '首项改期',
      startedAt: startedAt + 2 * HOUR_MS,
      endedAt: startedAt + 3 * HOUR_MS,
      priority: 1
    },
    startedAt
  ));

  const logs = includedLogs(
    database,
    startedAt,
    startedAt + 4 * HOUR_MS,
    true
  );

  assert.equal(logs.length, 0);
});
