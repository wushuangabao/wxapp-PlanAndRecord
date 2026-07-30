const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const { LOG_SOURCE, LOG_STATUS } = require('../miniprogram/domain/constants');
const {
  createCalendarEvent,
  createInitialDatabase,
  createRepeatRule,
  createTimeLog
} = require('../miniprogram/domain/entities');
const {
  createOccurrenceException,
  logicalOccurrenceKey,
  occurrenceKey,
  projectRevisionStartedAt,
  projectRule,
  projectRuleIntersectingRange
} = require('../miniprogram/domain/recurrence');
const { buildStatistics, includedLogs } = require('../miniprogram/domain/statistics');

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

function localTimestamp(year, month, day, hour = 0, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

function addLocalDays(timestamp, days) {
  const date = new Date(timestamp);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

function createBoundaryRule({
  startedAt,
  endedAt,
  frequency,
  weekdays = [],
  monthDay = null,
  taskId = null,
  taskNameSnapshot = null
}) {
  return createRepeatRule({
    title: '跨边界事项',
    startedAt,
    endedAt,
    priority: 1,
    frequency,
    interval: 1,
    weekdays,
    monthDay,
    taskId,
    taskNameSnapshot
  }, startedAt - 1);
}

function reviseTestRule(rule, effectiveFrom, startedAt, overrides = {}) {
  const activeRevision = rule.revisions.find((revision) => (
    revision.effectiveFrom <= effectiveFrom
    && (!revision.effectiveUntil || revision.effectiveUntil >= effectiveFrom)
  ));
  const duration = activeRevision.endedAt - activeRevision.startedAt;
  activeRevision.effectiveUntil = effectiveFrom - 1;
  const revision = {
    ...activeRevision,
    ...overrides,
    id: `revision_test_${rule.revisions.length + 1}`,
    revision: Math.max(...rule.revisions.map((item) => item.revision)) + 1,
    effectiveFrom,
    effectiveUntil: null,
    startedAt,
    endedAt: startedAt + duration
  };
  rule.revisions.push(revision);
  return revision;
}

function recurringDatabase(now = 1_700_000_000_000) {
  const database = createInitialDatabase(now);
  const startedAt = now + HOUR_MS;
  const endedAt = startedAt + HOUR_MS;
  const task = {
    id: 'task_recurring',
    title: '每日复盘任务',
    status: 'todo',
    projectId: null,
    projectNameSnapshot: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now
  };
  const rule = createRepeatRule({
    title: '每日复盘',
    startedAt,
    endedAt,
    priority: 1,
    frequency: 'daily',
    interval: 1,
    taskId: task.id,
    taskNameSnapshot: task.title
  }, now + 1);
  const event = createCalendarEvent({
    title: rule.title,
    startedAt,
    endedAt,
    priority: 1,
    taskId: task.id,
    taskNameSnapshot: task.title,
    repeatRuleId: rule.id,
    repeatRuleSummarySnapshot: rule.title
  }, now + 2);
  database.tasks.push(task);
  database.repeatRules.push(rule);
  database.calendarEvents.push(event);
  return { database, rule, startedAt };
}

test('未物化的重复规则实例只作为计划，不计入候选实际', () => {
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
  assert.equal(withCandidates.totalMinutes, 0);
  assert.equal(withCandidates.weeklyReview.logCount, 0);
  assert.deepEqual(withCandidates.tags, []);
  assert.equal(Object.hasOwn(withCandidates, 'categories'), false);
  assert.equal(
    withCandidates.planVariance.events.reduce((total, item) => total + item.plannedMinutes, 0),
    180
  );
  assert.equal(
    withCandidates.planVariance.events.every((item) => item.actualMinutes === 0),
    true
  );
  assert.equal(withCandidates.planVariance.nonPlannedMinutes, 0);
});

test('标签投入按日志标签分别累计，同一日志同一标签只计一次且无标签使用独立桶', () => {
  const startedAt = localTimestamp(2026, 7, 8, 9);
  const database = createInitialDatabase(startedAt - DAY_MS);
  [
    { minutes: 30, tags: ['AI', '复盘'] },
    { minutes: 20, tags: ['AI', 'AI'] },
    { minutes: 15, tags: [] },
    { minutes: 10, tags: ['无标签'] }
  ].forEach((item, index) => {
    const logStartedAt = startedAt + index * HOUR_MS;
    database.timeLogs.push(createTimeLog({
      startedAt: logStartedAt,
      endedAt: logStartedAt + item.minutes * MINUTE_MS,
      durationMinutes: item.minutes,
      status: LOG_STATUS.CONFIRMED,
      source: LOG_SOURCE.MANUAL,
      tags: item.tags
    }, logStartedAt));
  });

  const statistics = buildStatistics(database, {
    rangeStart: startedAt,
    rangeEnd: startedAt + 4 * HOUR_MS
  });

  assert.equal(statistics.totalMinutes, 75);
  assert.deepEqual(
    statistics.tags.map((item) => ({
      tag: item.tag,
      name: item.name,
      isUntagged: item.isUntagged,
      durationMinutes: item.durationMinutes,
      count: item.count
    })),
    [
      { tag: 'AI', name: 'AI', isUntagged: false, durationMinutes: 50, count: 2 },
      { tag: '复盘', name: '复盘', isUntagged: false, durationMinutes: 30, count: 1 },
      { tag: null, name: '无标签', isUntagged: true, durationMinutes: 15, count: 1 },
      { tag: '无标签', name: '无标签', isUntagged: false, durationMinutes: 10, count: 1 }
    ]
  );
});

test('已物化日志只计一次，其他重复计划不会虚增实际投入', () => {
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

  assert.equal(statistics.totalMinutes, 60);
  assert.equal(statistics.weeklyReview.logCount, 1);
  assert.equal(
    statistics.planVariance.events.reduce((total, item) => total + item.actualMinutes, 0),
    60
  );
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
    effectiveUntil: null,
    startedAt: occurrenceStart,
    endedAt: occurrenceStart + HOUR_MS
  });

  const statistics = buildStatistics(database, {
    rangeStart: occurrenceStart,
    rangeEnd: occurrenceStart + HOUR_MS,
    includeCandidates: true
  });

  assert.equal(statistics.totalMinutes, 60);
  assert.equal(statistics.weeklyReview.logCount, 1);
});

test('格式异常且不在范围内的历史实例日志不会替代当前计划实例', () => {
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

  assert.equal(statistics.totalMinutes, 0);
  assert.equal(statistics.weeklyReview.logCount, 0);
  assert.equal(statistics.planVariance.events.length, 1);
  assert.equal(statistics.planVariance.events[0].actualMinutes, 0);
});

test('统计按单次改期后的最终区间纳入或排除重复计划，但不伪造实际日志', () => {
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

  const movedOutStatistics = buildStatistics(movedOut.database, {
    rangeStart: originalStart,
    rangeEnd: originalStart + HOUR_MS,
    includeCandidates: true
  });
  assert.equal(movedOutStatistics.totalMinutes, 0);
  assert.deepEqual(movedOutStatistics.planVariance.events, []);

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

  const movedInStatistics = buildStatistics(movedIn.database, {
    rangeStart: targetStart,
    rangeEnd: targetStart + HOUR_MS,
    includeCandidates: true
  });
  assert.equal(movedInStatistics.totalMinutes, 0);
  assert.equal(movedInStatistics.planVariance.events.length, 1);
  assert.deepEqual(
    [
      movedInStatistics.planVariance.events[0].title,
      movedInStatistics.planVariance.events[0].plannedMinutes,
      movedInStatistics.planVariance.events[0].actualMinutes
    ],
    ['移入范围', 60, 0]
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

test('重复规则的种子计划块改时后仍按最早逻辑 occurrenceStart 抑制首项', () => {
  const { database, startedAt } = recurringDatabase();
  database.calendarEvents[0].startedAt = startedAt + 6 * HOUR_MS;
  database.calendarEvents[0].endedAt = startedAt + 7 * HOUR_MS;

  const logs = includedLogs(
    database,
    startedAt,
    startedAt + HOUR_MS,
    true
  );

  assert.equal(logs.length, 0);
});

test('查询级重复投影纳入跨日、周、月、年范围起点的完整候选', async (context) => {
  const cases = [
    {
      name: '跨日',
      startedAt: localTimestamp(2026, 7, 7, 23, 30),
      queryStart: localTimestamp(2026, 7, 8),
      frequency: 'daily'
    },
    {
      name: '跨周',
      startedAt: localTimestamp(2026, 7, 5, 23, 30),
      queryStart: localTimestamp(2026, 7, 6),
      frequency: 'weekly',
      weekdays: [new Date(localTimestamp(2026, 7, 5)).getDay()]
    },
    {
      name: '跨月',
      startedAt: localTimestamp(2026, 4, 30, 23, 30),
      queryStart: localTimestamp(2026, 5, 1),
      frequency: 'monthly',
      monthDay: 30
    },
    {
      name: '跨年',
      startedAt: localTimestamp(2026, 12, 31, 23, 30),
      queryStart: localTimestamp(2027, 1, 1),
      frequency: 'monthly',
      monthDay: 31
    }
  ];

  for (const boundaryCase of cases) {
    await context.test(boundaryCase.name, () => {
      const rule = createBoundaryRule({
        ...boundaryCase,
        endedAt: boundaryCase.queryStart + 30 * MINUTE_MS
      });
      const occurrences = projectRuleIntersectingRange(
        rule,
        boundaryCase.queryStart,
        boundaryCase.queryStart + 15 * MINUTE_MS,
        []
      );

      assert.equal(occurrences.length, 1);
      assert.equal(occurrences[0].occurrenceStart, boundaryCase.startedAt);
      assert.equal(occurrences[0].startedAt, boundaryCase.startedAt);
      assert.equal(occurrences[0].endedAt, boundaryCase.queryStart + 30 * MINUTE_MS);
    });
  }
});

test('统计跨范围起点的重复计划时保留完整计划时长且不计为实际', () => {
  const queryStart = localTimestamp(2026, 7, 8);
  const startedAt = localTimestamp(2026, 7, 7, 23, 30);
  const database = createInitialDatabase(startedAt - 2);
  const task = {
    id: 'task_boundary',
    title: '跨边界任务',
    status: 'todo',
    projectId: null,
    projectNameSnapshot: null,
    completedAt: null,
    createdAt: startedAt - 1,
    updatedAt: startedAt - 1
  };
  database.tasks.push(task);
  database.repeatRules.push(createBoundaryRule({
    startedAt,
    endedAt: queryStart + 30 * MINUTE_MS,
    frequency: 'daily',
    taskId: task.id,
    taskNameSnapshot: task.title
  }));

  const statistics = buildStatistics(database, {
    rangeStart: queryStart,
    rangeEnd: queryStart + 15 * MINUTE_MS,
    includeCandidates: true
  });

  assert.equal(statistics.totalMinutes, 0);
  assert.equal(statistics.weeklyReview.logCount, 0);
  assert.equal(statistics.planVariance.events.length, 1);
  assert.equal(statistics.planVariance.events[0].plannedMinutes, 60);
  assert.equal(statistics.planVariance.events[0].actualMinutes, 0);
});

test('项目统计只沿计划块到任务再到项目派生，忽略日志旧直接关联', () => {
  const startedAt = localTimestamp(2026, 7, 8, 9);
  const database = createInitialDatabase(startedAt - DAY_MS);
  const project = { id: 'project_plan', title: '计划项目', status: 'active' };
  const task = {
    id: 'task_plan',
    title: '计划任务',
    status: 'todo',
    projectId: project.id,
    projectNameSnapshot: project.title,
    completedAt: null
  };
  const event = createCalendarEvent({
    title: '任务计划块',
    startedAt,
    endedAt: startedAt + HOUR_MS,
    priority: 1,
    taskId: task.id,
    taskNameSnapshot: task.title
  }, startedAt - 1);
  database.projects.push(project);
  database.tasks.push(task);
  database.calendarEvents.push(event);
  database.timeLogs.push(
    createTimeLog({
      startedAt,
      endedAt: startedAt + HOUR_MS,
      durationMinutes: 60,
      calendarEventId: event.id,
      calendarEventSummarySnapshot: event.title,
      projectId: 'project_legacy_wrong',
      projectNameSnapshot: '错误旧项目',
      taskId: 'task_legacy_wrong',
      taskNameSnapshot: '错误旧任务',
      status: LOG_STATUS.CONFIRMED,
      source: LOG_SOURCE.MANUAL
    }, startedAt + HOUR_MS),
    createTimeLog({
      startedAt: startedAt + HOUR_MS,
      endedAt: startedAt + HOUR_MS + 30 * MINUTE_MS,
      durationMinutes: 30,
      projectId: project.id,
      projectNameSnapshot: project.title,
      taskId: task.id,
      taskNameSnapshot: task.title,
      status: LOG_STATUS.CONFIRMED,
      source: LOG_SOURCE.MANUAL
    }, startedAt + 2 * HOUR_MS)
  );

  const statistics = buildStatistics(database, {
    rangeStart: startedAt,
    rangeEnd: startedAt + 2 * HOUR_MS
  });
  const projectsById = new Map(statistics.projects.map((item) => [item.id, item]));

  assert.equal(projectsById.get(project.id).durationMinutes, 60);
  assert.equal(projectsById.get('unassigned').durationMinutes, 30);
  assert.equal(statistics.planVariance.nonPlannedMinutes, 30);
});

test('重复计划实例的项目归属由规则修订任务派生且不计为非计划实际', () => {
  const seedStart = localTimestamp(2026, 7, 8, 9);
  const occurrenceStart = seedStart + DAY_MS;
  const database = createInitialDatabase(seedStart - DAY_MS);
  const project = { id: 'project_rule', title: '重复计划项目', status: 'active' };
  const task = {
    id: 'task_rule',
    title: '重复计划任务',
    status: 'todo',
    projectId: project.id,
    projectNameSnapshot: project.title,
    completedAt: null
  };
  const rule = createRepeatRule({
    title: '每日计划',
    startedAt: seedStart,
    endedAt: seedStart + HOUR_MS,
    priority: 1,
    frequency: 'daily',
    interval: 1,
    taskId: task.id,
    taskNameSnapshot: task.title
  }, seedStart - 1);
  const occurrence = projectRule(rule, occurrenceStart, occurrenceStart, [])[0];
  database.projects.push(project);
  database.tasks.push(task);
  database.repeatRules.push(rule);
  database.timeLogs.push(createTimeLog({
    startedAt: occurrence.startedAt,
    endedAt: occurrence.endedAt,
    durationMinutes: 60,
    status: LOG_STATUS.CONFIRMED,
    source: LOG_SOURCE.RULE,
    originRuleId: rule.id,
    originOccurrenceId: occurrence.originOccurrenceId,
    originRuleSummarySnapshot: rule.title
  }, occurrenceStart + HOUR_MS));

  const statistics = buildStatistics(database, {
    rangeStart: occurrenceStart,
    rangeEnd: occurrenceStart + HOUR_MS
  });

  assert.deepEqual(
    statistics.projects.map((item) => [item.id, item.durationMinutes]),
    [[project.id, 60]]
  );
  assert.equal(statistics.planVariance.nonPlannedMinutes, 0);
  assert.equal(statistics.planVariance.events.length, 1);
  assert.equal(statistics.planVariance.events[0].actualMinutes, 60);
});

test('没有有效任务的旧重复规则不再投影新的候选计划实例', () => {
  const startedAt = localTimestamp(2026, 7, 8, 9);
  const database = createInitialDatabase(startedAt - DAY_MS);
  database.repeatRules.push(createBoundaryRule({
    startedAt,
    endedAt: startedAt + HOUR_MS,
    frequency: 'daily'
  }));

  const statistics = buildStatistics(database, {
    rangeStart: startedAt,
    rangeEnd: startedAt + DAY_MS,
    includeCandidates: true
  });

  assert.equal(statistics.totalMinutes, 0);
  assert.deepEqual(statistics.planVariance.events, []);
});

test('查询级重复投影按修订实际时长回看超过 24 小时的候选', () => {
  const startedAt = localTimestamp(2026, 1, 1, 8);
  const endedAt = localTimestamp(2026, 1, 3, 8);
  const queryStart = localTimestamp(2026, 1, 3);
  const rule = createBoundaryRule({
    startedAt,
    endedAt,
    frequency: 'monthly',
    monthDay: 1
  });

  const occurrences = projectRuleIntersectingRange(
    rule,
    queryStart,
    queryStart + 30 * MINUTE_MS,
    []
  );

  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].occurrenceStart, startedAt);
  assert.equal(occurrences[0].endedAt - occurrences[0].startedAt, 48 * HOUR_MS);
});

test('区间交集排除恰好结束于起点的候选，并纳入恰好开始于终点的候选', () => {
  const queryStart = localTimestamp(2026, 7, 8);
  const startedAt = queryStart - HOUR_MS;
  const endingAtStartRule = createBoundaryRule({
    startedAt,
    endedAt: queryStart,
    frequency: 'daily'
  });

  assert.deepEqual(
    projectRuleIntersectingRange(endingAtStartRule, queryStart, queryStart + 15 * MINUTE_MS, []),
    []
  );

  const queryEnd = queryStart + 15 * MINUTE_MS;
  const startingAtEndRule = createBoundaryRule({
    startedAt: queryEnd,
    endedAt: queryEnd + HOUR_MS,
    frequency: 'daily'
  });
  assert.equal(
    projectRuleIntersectingRange(startingAtEndRule, queryStart, queryEnd, []).length,
    1
  );
});

test('持久化日志与虚拟候选使用同一非零区间交集边界', () => {
  const rangeStart = localTimestamp(2026, 7, 8);
  const rangeEnd = rangeStart + HOUR_MS;
  const database = createInitialDatabase(rangeStart - DAY_MS);
  database.timeLogs.push(
    createTimeLog({
      startedAt: rangeStart - HOUR_MS,
      endedAt: rangeStart,
      durationMinutes: 60,
      note: '恰好结束于范围起点',
      status: LOG_STATUS.CONFIRMED,
      source: LOG_SOURCE.MANUAL
    }, rangeStart - 1),
    createTimeLog({
      startedAt: rangeEnd,
      endedAt: rangeEnd + HOUR_MS,
      durationMinutes: 60,
      note: '恰好开始于范围终点',
      status: LOG_STATUS.CONFIRMED,
      source: LOG_SOURCE.MANUAL
    }, rangeStart)
  );

  const logs = includedLogs(database, rangeStart, rangeEnd, false);

  assert.deepEqual(logs.map((log) => log.note), ['恰好开始于范围终点']);
});

test('后续修订前移或后移开始时间时保留首项逻辑归属并可按最终区间查询', async (context) => {
  const originalStart = localTimestamp(2026, 7, 7, 9);
  const occurrenceStart = addLocalDays(originalStart, 1);
  const cases = [
    { name: '前移到 08:00', displayStart: localTimestamp(2026, 7, 8, 8) },
    { name: '后移到 10:00', displayStart: localTimestamp(2026, 7, 8, 10) }
  ];

  for (const revisionCase of cases) {
    await context.test(revisionCase.name, () => {
      const rule = createBoundaryRule({
        startedAt: originalStart,
        endedAt: originalStart + 30 * MINUTE_MS,
        frequency: 'daily'
      });
      const beforeRevision = projectRule(rule, occurrenceStart, occurrenceStart, [])[0];
      reviseTestRule(rule, occurrenceStart, revisionCase.displayStart);

      const exact = projectRule(rule, occurrenceStart, occurrenceStart, []);
      const queried = projectRuleIntersectingRange(
        rule,
        revisionCase.displayStart,
        revisionCase.displayStart + 30 * MINUTE_MS,
        []
      );

      assert.equal(exact.length, 1);
      assert.equal(exact[0].occurrenceStart, occurrenceStart);
      assert.equal(exact[0].startedAt, revisionCase.displayStart);
      assert.equal(queried.length, 1);
      assert.equal(queried[0].occurrenceStart, occurrenceStart);
      assert.equal(exact[0].occurrenceKey, beforeRevision.occurrenceKey);
      assert.equal(
        logicalOccurrenceKey(rule.id, exact[0].originOccurrenceId),
        occurrenceKey(rule.id, occurrenceStart)
      );
    });
  }
});

test('连续修订只改其他字段时可复用上一修订的最终墙钟映射', () => {
  const originalStart = localTimestamp(2026, 7, 7, 9);
  const firstRevisionStart = addLocalDays(originalStart, 1);
  const secondRevisionStart = addLocalDays(originalStart, 2);
  const rule = createBoundaryRule({
    startedAt: originalStart,
    endedAt: originalStart + 30 * MINUTE_MS,
    frequency: 'daily'
  });
  const firstRevision = reviseTestRule(
    rule,
    firstRevisionStart,
    localTimestamp(2026, 7, 8, 8)
  );
  const inheritedStartedAt = projectRevisionStartedAt(firstRevision, secondRevisionStart);
  reviseTestRule(rule, secondRevisionStart, inheritedStartedAt, { priority: 2 });

  const occurrences = projectRule(
    rule,
    secondRevisionStart,
    addLocalDays(secondRevisionStart, 1),
    []
  );

  assert.equal(inheritedStartedAt, localTimestamp(2026, 7, 9, 8));
  assert.deepEqual(
    occurrences.map((occurrence) => [
      occurrence.occurrenceStart,
      occurrence.startedAt,
      occurrence.priority
    ]),
    [
      [localTimestamp(2026, 7, 9, 9), localTimestamp(2026, 7, 9, 8), 2],
      [localTimestamp(2026, 7, 10, 9), localTimestamp(2026, 7, 10, 8), 2]
    ]
  );
});

test('更早实例改变后续开始时间后，既有 override 仍按原 occurrenceStart 投影', () => {
  const originalStart = localTimestamp(2026, 7, 7, 9);
  const revisionStart = addLocalDays(originalStart, 1);
  const overrideOccurrenceStart = addLocalDays(originalStart, 3);
  const overrideStartedAt = localTimestamp(2026, 7, 10, 15);
  const rule = createBoundaryRule({
    startedAt: originalStart,
    endedAt: originalStart + 30 * MINUTE_MS,
    frequency: 'daily'
  });
  const exception = createOccurrenceException(
    rule.id,
    overrideOccurrenceStart,
    'override',
    {
      title: '已改期实例',
      startedAt: overrideStartedAt,
      endedAt: overrideStartedAt + HOUR_MS,
      priority: 1
    },
    revisionStart - 1
  );

  reviseTestRule(rule, revisionStart, revisionStart + HOUR_MS);

  const exact = projectRule(
    rule,
    overrideOccurrenceStart,
    overrideOccurrenceStart,
    [exception]
  );
  const queried = projectRuleIntersectingRange(
    rule,
    overrideStartedAt,
    overrideStartedAt + HOUR_MS,
    [exception]
  );

  assert.equal(exact.length, 1);
  assert.equal(exact[0].occurrenceStart, overrideOccurrenceStart);
  assert.equal(exact[0].startedAt, overrideStartedAt);
  assert.equal(queried.length, 1);
  assert.equal(queried[0].occurrenceStart, overrideOccurrenceStart);
});

test('更早实例改变后续开始时间后，既有 skip 仍按逻辑 occurrenceStart 生效', () => {
  const originalStart = localTimestamp(2026, 7, 7, 9);
  const revisionStart = addLocalDays(originalStart, 1);
  const skippedOccurrenceStart = addLocalDays(originalStart, 3);
  const rule = createBoundaryRule({
    startedAt: originalStart,
    endedAt: originalStart + 30 * MINUTE_MS,
    frequency: 'daily'
  });
  const exception = createOccurrenceException(
    rule.id,
    skippedOccurrenceStart,
    'skip',
    null,
    revisionStart - 1
  );

  reviseTestRule(rule, revisionStart, revisionStart + HOUR_MS);

  assert.deepEqual(
    projectRule(rule, skippedOccurrenceStart, skippedOccurrenceStart, [exception]),
    []
  );
  assert.deepEqual(
    projectRuleIntersectingRange(
      rule,
      skippedOccurrenceStart + HOUR_MS,
      skippedOccurrenceStart + 90 * MINUTE_MS,
      [exception]
    ),
    []
  );
});

test('改为不包含原日期的每周节奏后，既有 override 保留但普通日期和 skip 不生成实例', () => {
  const originalStart = localTimestamp(2026, 7, 6, 9);
  const revisionStart = localTimestamp(2026, 7, 7, 9);
  const overrideOccurrenceStart = localTimestamp(2026, 7, 10, 9);
  const overrideStartedAt = localTimestamp(2026, 7, 10, 15);
  const ordinaryFriday = localTimestamp(2026, 7, 17, 9);
  const scheduledMonday = localTimestamp(2026, 7, 13, 9);
  const rule = createBoundaryRule({
    startedAt: originalStart,
    endedAt: originalStart + 30 * MINUTE_MS,
    frequency: 'daily'
  });
  const override = createOccurrenceException(
    rule.id,
    overrideOccurrenceStart,
    'override',
    {
      title: '改频前已改期',
      startedAt: overrideStartedAt,
      endedAt: overrideStartedAt + HOUR_MS,
      priority: 1
    },
    revisionStart - 2
  );
  const skip = createOccurrenceException(
    rule.id,
    ordinaryFriday,
    'skip',
    null,
    revisionStart - 1
  );
  reviseTestRule(rule, revisionStart, revisionStart, {
    frequency: 'weekly',
    weekdays: [1]
  });

  const exactOverride = projectRule(
    rule,
    overrideOccurrenceStart,
    overrideOccurrenceStart,
    [override, skip]
  );
  const queriedOverride = projectRuleIntersectingRange(
    rule,
    overrideStartedAt,
    overrideStartedAt + HOUR_MS,
    [override, skip]
  );

  assert.equal(exactOverride.length, 1);
  assert.equal(exactOverride[0].occurrenceStart, overrideOccurrenceStart);
  assert.equal(exactOverride[0].startedAt, overrideStartedAt);
  assert.equal(queriedOverride.length, 1);
  assert.equal(queriedOverride[0].occurrenceStart, overrideOccurrenceStart);
  assert.deepEqual(projectRule(rule, ordinaryFriday, ordinaryFriday, []), []);
  assert.deepEqual(projectRule(rule, ordinaryFriday, ordinaryFriday, [skip]), []);
  assert.equal(projectRule(rule, scheduledMonday, scheduledMonday, []).length, 1);
});

test('每两周多星期规则修订开始时间后保持逻辑星期节奏', () => {
  const originalStart = localTimestamp(2026, 7, 6, 9);
  const revisionStart = localTimestamp(2026, 7, 8, 9);
  const rule = createBoundaryRule({
    startedAt: originalStart,
    endedAt: originalStart + 30 * MINUTE_MS,
    frequency: 'weekly',
    weekdays: [1, 3]
  });
  rule.revisions[0].interval = 2;
  reviseTestRule(rule, revisionStart, revisionStart + HOUR_MS);

  const occurrences = projectRule(
    rule,
    revisionStart,
    localTimestamp(2026, 7, 23),
    []
  );

  assert.deepEqual(
    occurrences.map((occurrence) => occurrence.occurrenceStart),
    [
      localTimestamp(2026, 7, 8, 9),
      localTimestamp(2026, 7, 20, 9),
      localTimestamp(2026, 7, 22, 9)
    ]
  );
  assert.equal(occurrences.every((occurrence) => new Date(occurrence.startedAt).getHours() === 10), true);
});

test('每月 31 日规则修订开始时间后保持逻辑月度节奏', () => {
  const originalStart = localTimestamp(2026, 1, 31, 9);
  const revisionStart = localTimestamp(2026, 3, 31, 9);
  const rule = createBoundaryRule({
    startedAt: originalStart,
    endedAt: originalStart + 30 * MINUTE_MS,
    frequency: 'monthly',
    monthDay: 31
  });
  reviseTestRule(rule, revisionStart, revisionStart - HOUR_MS);

  const occurrences = projectRule(
    rule,
    revisionStart,
    localTimestamp(2026, 6, 1),
    []
  );

  assert.deepEqual(
    occurrences.map((occurrence) => occurrence.occurrenceStart),
    [
      localTimestamp(2026, 3, 31, 9),
      localTimestamp(2026, 5, 31, 9)
    ]
  );
  assert.equal(occurrences.every((occurrence) => new Date(occurrence.startedAt).getHours() === 8), true);
});

test('跨夏令时将后续实例整体后移一天时保持本地墙钟并可按最终区间查询', () => {
  const script = `
    const { createRepeatRule } = require('./miniprogram/domain/entities');
    const {
      projectRule,
      projectRuleIntersectingRange
    } = require('./miniprogram/domain/recurrence');

    const timestamp = (year, month, day, hour, minute = 0) =>
      new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
    const originalStart = timestamp(2026, 3, 6, 9);
    const revisionStart = timestamp(2026, 3, 7, 9);
    const displayStart = timestamp(2026, 3, 8, 9);
    const rule = createRepeatRule({
      title: 'DST 日程',
      startedAt: originalStart,
      endedAt: originalStart + 30 * 60 * 1000,
      priority: 1,
      frequency: 'daily',
      interval: 1
    }, originalStart - 1);
    const oldRevision = rule.revisions[0];
    oldRevision.effectiveUntil = revisionStart - 1;
    rule.revisions.push({
      ...oldRevision,
      id: 'revision_dst_2',
      revision: 2,
      effectiveFrom: revisionStart,
      effectiveUntil: null,
      startedAt: displayStart,
      endedAt: timestamp(2026, 3, 8, 9, 30)
    });

    const projected = projectRule(
      rule,
      revisionStart,
      timestamp(2026, 3, 9, 9),
      []
    );
    const queried = projectRuleIntersectingRange(
      rule,
      timestamp(2026, 3, 10, 8, 45),
      timestamp(2026, 3, 10, 9, 15),
      []
    );
    process.stdout.write(JSON.stringify({
      offsets: [
        new Date(revisionStart).getTimezoneOffset(),
        new Date(displayStart).getTimezoneOffset()
      ],
      projected: projected.map((occurrence) => ({
        logicalDay: new Date(occurrence.occurrenceStart).getDate(),
        displayDay: new Date(occurrence.startedAt).getDate(),
        displayHour: new Date(occurrence.startedAt).getHours()
      })),
      queried: queried.map((occurrence) => ({
        logicalDay: new Date(occurrence.occurrenceStart).getDate(),
        displayDay: new Date(occurrence.startedAt).getDate(),
        displayHour: new Date(occurrence.startedAt).getHours()
      }))
    }));
  `;
  const result = JSON.parse(execFileSync(
    process.execPath,
    ['-e', script],
    {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, TZ: 'America/New_York' },
      encoding: 'utf8'
    }
  ));

  assert.notEqual(result.offsets[0], result.offsets[1]);
  assert.deepEqual(
    result.projected,
    [
      { logicalDay: 7, displayDay: 8, displayHour: 9 },
      { logicalDay: 8, displayDay: 9, displayHour: 9 },
      { logicalDay: 9, displayDay: 10, displayHour: 9 }
    ]
  );
  assert.deepEqual(
    result.queried,
    [{ logicalDay: 9, displayDay: 10, displayHour: 9 }]
  );
});
