const test = require('node:test');
const assert = require('node:assert/strict');

const { LOG_SOURCE, LOG_STATUS } = require('../miniprogram/domain/constants');
const {
  createCalendarEvent,
  createIdleTimer,
  createInitialDatabase,
  createRepeatRule,
  createTimeLog
} = require('../miniprogram/domain/entities');
const {
  createSkipOccurrenceException,
  logicalOccurrenceKey,
  occurrenceKey,
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
  monthDays = [],
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
    monthDays,
    taskId,
    taskNameSnapshot
  }, startedAt - 1);
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
  database.tasks.push(task);
  database.repeatRules.push(rule);
  return { database, rule, startedAt };
}

test('未物化的重复规则实例只作为计划，不计入候选实际', () => {
  const { database, startedAt } = recurringDatabase();
  database.recoveryDraft = {
    reason: '待审核恢复预览',
    timer: createIdleTimer(),
    candidatePreview: {
      startedAt,
      endedAt: startedAt + HOUR_MS,
      pausedDurationSeconds: 0,
      durationMinutes: 60,
      source: LOG_SOURCE.TIMER
    },
    createdAt: startedAt
  };
  const options = {
    rangeStart: startedAt,
    rangeEnd: startedAt + 2 * DAY_MS
  };

  const confirmedOnly = buildStatistics(database, options);
  const withCandidates = buildStatistics(database, {
    ...options,
    includeCandidates: true
  });
  const virtualPlans = projectRule(
    database.repeatRules[0],
    startedAt,
    startedAt + 2 * DAY_MS,
    database.occurrenceExceptions
  );

  assert.equal(virtualPlans.every((item) => item.type === 'plan' && item.virtual), true);
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

test('重叠日志仍逐条累加全部统计值，但统计结果不再暴露 overlaps', () => {
  const startedAt = localTimestamp(2026, 7, 8, 9);
  const database = createInitialDatabase(startedAt - DAY_MS);
  database.timeLogs.push(
    createTimeLog({
      startedAt,
      endedAt: startedAt + 40 * MINUTE_MS,
      durationMinutes: 40,
      status: LOG_STATUS.CONFIRMED,
      source: LOG_SOURCE.MANUAL,
      tags: ['工作']
    }, startedAt),
    createTimeLog({
      startedAt: startedAt + 20 * MINUTE_MS,
      endedAt: startedAt + 50 * MINUTE_MS,
      durationMinutes: 30,
      status: LOG_STATUS.CONFIRMED,
      source: LOG_SOURCE.MANUAL,
      tags: ['工作']
    }, startedAt + MINUTE_MS)
  );

  const statistics = buildStatistics(database, {
    rangeStart: startedAt - 1,
    rangeEnd: startedAt + HOUR_MS
  });

  assert.equal(statistics.totalMinutes, 70);
  assert.equal(statistics.tags[0].durationMinutes, 70);
  assert.equal(statistics.weeklyReview.totalMinutes, 70);
  assert.equal(statistics.weeklyReview.logCount, 2);
  assert.equal(statistics.weeklyReview.nonPlannedMinutes, 70);
  assert.equal(Object.hasOwn(statistics, 'overlaps'), false);
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

test('单 revision 的 effectiveUntil 是固定日程投影边界', () => {
  const { database, rule, startedAt } = recurringDatabase();
  const finalOccurrenceStart = startedAt + DAY_MS;
  rule.revisions[0].effectiveUntil = finalOccurrenceStart;
  const skip = createSkipOccurrenceException(rule.id, finalOccurrenceStart, finalOccurrenceStart);

  assert.deepEqual(
    Object.keys(skip).sort(),
    ['createdAt', 'id', 'kind', 'occurrenceStart', 'ruleId', 'updatedAt']
  );
  assert.equal(skip.kind, 'skip');
  assert.deepEqual(
    projectRule(rule, startedAt, finalOccurrenceStart + DAY_MS, []).map((item) => item.occurrenceStart),
    [startedAt, finalOccurrenceStart]
  );
  assert.deepEqual(
    projectRule(rule, startedAt, finalOccurrenceStart + DAY_MS, [skip]).map((item) => item.occurrenceStart),
    [startedAt]
  );
  assert.deepEqual(
    projectRuleIntersectingRange(
      rule,
      finalOccurrenceStart + DAY_MS,
      finalOccurrenceStart + DAY_MS + HOUR_MS,
      []
    ),
    []
  );
});

test('单 revision 的双周多星期规则按计划统计投影', () => {
  const startedAt = localTimestamp(2026, 7, 6, 9);
  const database = createInitialDatabase(startedAt - DAY_MS);
  const task = {
    id: 'task_biweekly',
    title: '双周复盘',
    status: 'todo',
    projectId: null,
    projectNameSnapshot: null,
    completedAt: null,
    createdAt: startedAt - DAY_MS,
    updatedAt: startedAt - DAY_MS
  };
  const rule = createBoundaryRule({
    startedAt,
    endedAt: startedAt + HOUR_MS,
    frequency: 'weekly',
    weekdays: [1, 3],
    taskId: task.id,
    taskNameSnapshot: task.title
  });
  rule.revisions[0].interval = 2;
  database.tasks.push(task);
  database.repeatRules.push(rule);
  const rangeEnd = localTimestamp(2026, 7, 22, 10);

  assert.deepEqual(
    projectRule(rule, startedAt, rangeEnd, []).map((occurrence) => occurrence.occurrenceStart),
    [
      localTimestamp(2026, 7, 6, 9),
      localTimestamp(2026, 7, 8, 9),
      localTimestamp(2026, 7, 20, 9),
      localTimestamp(2026, 7, 22, 9)
    ]
  );
  const statistics = buildStatistics(database, {
    rangeStart: startedAt,
    rangeEnd
  });
  assert.deepEqual(
    statistics.planVariance.events.map((event) => event.plannedMinutes),
    [60, 60, 60, 60]
  );
  assert.equal(statistics.planVariance.nonPlannedMinutes, 0);
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


test('固定日程首项完全由 RepeatRule 投影并纳入计划统计', () => {
  const { database, startedAt } = recurringDatabase();
  const statistics = buildStatistics(database, {
    rangeStart: startedAt,
    rangeEnd: startedAt + HOUR_MS,
    includeCandidates: true
  });

  assert.equal(database.calendarEvents.length, 0);
  assert.equal(statistics.totalMinutes, 0);
  assert.equal(statistics.planVariance.events.length, 1);
  assert.equal(statistics.planVariance.events[0].plannedMinutes, 60);
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
      monthDays: [30]
    },
    {
      name: '跨年',
      startedAt: localTimestamp(2026, 12, 31, 23, 30),
      queryStart: localTimestamp(2027, 1, 1),
      frequency: 'monthly',
      monthDays: [31]
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

test('重复计划实例的项目归属由规则修订任务派生且不计为计划外', () => {
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

test('删除固定日程后的未来追溯日志仍计入实际但成为计划外且不恢复任务项目归属', () => {
  const startedAt = localTimestamp(2026, 7, 8, 9);
  const cutoffStart = addLocalDays(startedAt, 1);
  const futureStart = addLocalDays(cutoffStart, 1);
  const database = createInitialDatabase(startedAt - DAY_MS);
  const project = { id: 'project_detached_rule', title: '原计划项目', status: 'active' };
  const task = {
    id: 'task_detached_rule',
    title: '原计划任务',
    status: 'todo',
    projectId: project.id,
    projectNameSnapshot: project.title,
    completedAt: null
  };
  const rule = createRepeatRule({
    title: '每日计划',
    startedAt,
    endedAt: startedAt + HOUR_MS,
    priority: 1,
    frequency: 'daily',
    interval: 1,
    taskId: task.id,
    taskNameSnapshot: task.title
  }, startedAt - 1);
  const occurrences = projectRule(rule, startedAt, futureStart, []);
  const past = occurrences.find((item) => item.occurrenceStart === startedAt);
  const cutoff = occurrences.find((item) => item.occurrenceStart === cutoffStart);
  const future = occurrences.find((item) => item.occurrenceStart === futureStart);
  rule.revisions[0].effectiveUntil = cutoffStart - 1;
  database.projects.push(project);
  database.tasks.push(task);
  database.repeatRules.push(rule);
  database.timeLogs.push(
    createTimeLog({
      startedAt: past.startedAt,
      endedAt: past.endedAt - 30 * MINUTE_MS,
      durationMinutes: 30,
      status: LOG_STATUS.CONFIRMED,
      source: LOG_SOURCE.RULE,
      originRuleId: rule.id,
      originOccurrenceId: past.originOccurrenceId,
      originRuleSummarySnapshot: rule.title
    }, startedAt),
    createTimeLog({
      startedAt: cutoff.startedAt,
      endedAt: cutoff.endedAt - 30 * MINUTE_MS,
      durationMinutes: 30,
      status: LOG_STATUS.CONFIRMED,
      source: LOG_SOURCE.RULE,
      originRuleId: null,
      originOccurrenceId: cutoff.originOccurrenceId,
      originRuleSummarySnapshot: rule.title
    }, cutoffStart),
    createTimeLog({
      startedAt: future.startedAt,
      endedAt: future.endedAt - 30 * MINUTE_MS,
      durationMinutes: 30,
      status: LOG_STATUS.CONFIRMED,
      source: LOG_SOURCE.RULE,
      originRuleId: null,
      originOccurrenceId: future.originOccurrenceId,
      originRuleSummarySnapshot: rule.title
    }, futureStart)
  );

  const statistics = buildStatistics(database, {
    rangeStart: startedAt,
    rangeEnd: futureStart + HOUR_MS
  });
  const projectsById = new Map(statistics.projects.map((item) => [item.id, item]));

  assert.equal(statistics.totalMinutes, 90);
  assert.deepEqual(
    statistics.planVariance.events.map((item) => [item.eventId, item.plannedMinutes, item.actualMinutes]),
    [[past.originOccurrenceId, 60, 30]]
  );
  assert.equal(statistics.planVariance.nonPlannedMinutes, 60);
  assert.equal(statistics.weeklyReview.nonPlannedMinutes, 60);
  assert.equal(projectsById.get(project.id).durationMinutes, 30);
  assert.equal(projectsById.get('unassigned').durationMinutes, 60);
});

test('没有有效任务的旧重复规则不再投影新的虚拟计划实例', () => {
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
    monthDays: [1]
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

test('持久化日志与虚拟计划使用同一非零区间交集边界', () => {
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

test('每月多选日期在命中的周期月各投影一次，短月份跳过不存在日期', () => {
  const originalStart = localTimestamp(2026, 1, 1, 9);
  const rule = createBoundaryRule({
    startedAt: originalStart,
    endedAt: originalStart + 30 * MINUTE_MS,
    frequency: 'monthly',
    monthDays: [1, 15, 31]
  });
  rule.revisions[0].interval = 2;

  const occurrences = projectRule(
    rule,
    originalStart,
    localTimestamp(2026, 6, 1),
    []
  );

  assert.deepEqual(
    occurrences.map((occurrence) => occurrence.occurrenceStart),
    [
      localTimestamp(2026, 1, 1, 9),
      localTimestamp(2026, 1, 15, 9),
      localTimestamp(2026, 1, 31, 9),
      localTimestamp(2026, 3, 1, 9),
      localTimestamp(2026, 3, 15, 9),
      localTimestamp(2026, 3, 31, 9),
      localTimestamp(2026, 5, 1, 9),
      localTimestamp(2026, 5, 15, 9),
      localTimestamp(2026, 5, 31, 9)
    ]
  );
});
