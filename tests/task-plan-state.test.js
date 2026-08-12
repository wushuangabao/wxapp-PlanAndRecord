const test = require('node:test');
const assert = require('node:assert/strict');

const { LOG_SOURCE, LOG_STATUS, TASK_STATUS, TIMER_STATUS } = require('../miniprogram/domain/constants');
const {
  createCalendarEvent,
  createInitialDatabase,
  createRepeatRule,
  createTimeLog
} = require('../miniprogram/domain/entities');
const { createSkipOccurrenceException, projectRuleIntersectingRange } = require('../miniprogram/domain/recurrence');
const {
  buildTaskPlanStates,
  inferCompletionUndoLog
} = require('../miniprogram/services/task-plan-state');

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

function localTimestamp(year, month, day, hour = 0, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

function task(id, title = id) {
  return {
    id,
    title,
    status: TASK_STATUS.TODO,
    projectId: null,
    projectNameSnapshot: null,
    completedAt: null,
    createdAt: 1,
    updatedAt: 1
  };
}

function eventFor(taskValue, id, startedAt, endedAt) {
  return {
    ...createCalendarEvent({
      title: id,
      startedAt,
      endedAt,
      priority: 1,
      taskId: taskValue.id,
      taskNameSnapshot: taskValue.title
    }, startedAt - 1),
    id
  };
}

function ruleFor(taskValue, id, startedAt, endedAt, input = {}) {
  return {
    ...createRepeatRule({
      title: id,
      startedAt,
      endedAt,
      priority: 1,
      frequency: input.frequency || 'daily',
      interval: input.interval || 1,
      weekdays: input.weekdays || [],
      monthDays: input.monthDays || [],
      taskId: taskValue.id,
      taskNameSnapshot: taskValue.title
    }, startedAt - 1),
    id
  };
}

function logForEvent(event, id, status, createdAt) {
  return {
    ...createTimeLog({
      startedAt: createdAt - MINUTE_MS,
      endedAt: createdAt,
      calendarEventId: event.id,
      calendarEventSummarySnapshot: event.title,
      taskNameSnapshot: event.taskNameSnapshot,
      status,
      source: LOG_SOURCE.MANUAL
    }, createdAt),
    id
  };
}

function logForOccurrence(occurrence, id, status, createdAt) {
  return {
    ...createTimeLog({
      startedAt: createdAt - MINUTE_MS,
      endedAt: createdAt,
      originRuleId: occurrence.ruleId,
      originOccurrenceId: occurrence.originOccurrenceId,
      originRuleSummarySnapshot: occurrence.title,
      taskNameSnapshot: occurrence.taskNameSnapshot,
      status,
      source: LOG_SOURCE.RULE
    }, createdAt),
    id
  };
}

test('任务计划状态：过期与未来实体计划都可执行，只有 confirmed 覆盖计划', () => {
  const now = localTimestamp(2026, 8, 12, 12);
  const database = createInitialDatabase(now);
  const value = task('task_entity', '实体任务');
  const past = eventFor(value, 'event_past', now - 3 * HOUR_MS, now - 2 * HOUR_MS);
  const future = eventFor(value, 'event_future', now + HOUR_MS, now + 2 * HOUR_MS);
  database.tasks.push(value);
  database.calendarEvents.push(past, future);
  database.timeLogs.push(logForEvent(past, 'log_candidate', LOG_STATUS.CANDIDATE, now - HOUR_MS));

  let state = buildTaskPlanStates(database, now).get(value.id);
  assert.deepEqual(state.pendingEntityPlans.map((item) => item.id), [past.id, future.id]);
  assert.deepEqual(state.candidates.map((item) => item.id), [`event:${past.id}`, `event:${future.id}`]);
  assert.equal(state.canAutoComplete, false);
  assert.equal(state.topVisible, true);

  database.timeLogs.push(
    logForEvent(past, 'log_past', LOG_STATUS.CONFIRMED, now + 10),
    logForEvent(future, 'log_future', LOG_STATUS.CONFIRMED, now + 20)
  );
  state = buildTaskPlanStates(database, now).get(value.id);
  assert.deepEqual(state.pendingEntityPlans, []);
  assert.equal(state.canAutoComplete, true);
  assert.equal(state.controlKind, 'checkbox');
});

test('任务计划状态：固定日程只在今天真实发生时进入顶部且全部记录后变淡', () => {
  const now = localTimestamp(2026, 8, 12, 12);
  const database = createInitialDatabase(now);
  const todayTask = task('task_today', '今日固定任务');
  const otherTask = task('task_other_day', '非今日固定任务');
  const todayRule = ruleFor(todayTask, 'rule_today', localTimestamp(2026, 8, 10, 9), localTimestamp(2026, 8, 10, 10));
  const tomorrowWeekday = new Date(localTimestamp(2026, 8, 13, 9)).getDay();
  const otherRule = ruleFor(
    otherTask,
    'rule_other_day',
    localTimestamp(2026, 8, 13, 9),
    localTimestamp(2026, 8, 13, 10),
    { frequency: 'weekly', weekdays: [tomorrowWeekday] }
  );
  database.tasks.push(todayTask, otherTask);
  database.repeatRules.push(todayRule, otherRule);

  let states = buildTaskPlanStates(database, now);
  let todayState = states.get(todayTask.id);
  assert.equal(todayState.todayOccurrences.length, 1);
  assert.equal(todayState.pendingTodayOccurrences.length, 1);
  assert.equal(todayState.topVisible, true);
  assert.equal(todayState.controlKind, 'timer');
  assert.equal(states.get(otherTask.id).topVisible, false);
  assert.equal(states.get(otherTask.id).controlKind, 'schedule');

  database.timeLogs.push(logForOccurrence(
    todayState.todayOccurrences[0],
    'log_today',
    LOG_STATUS.CONFIRMED,
    now
  ));
  todayState = buildTaskPlanStates(database, now).get(todayTask.id);
  assert.equal(todayState.pendingTodayOccurrences.length, 0);
  assert.equal(todayState.controlKind, 'recorded');
  assert.equal(todayState.topVisible, true);
});

test('任务计划状态：今天多实例必须全部 confirmed，skip 实例不参与', () => {
  const now = localTimestamp(2026, 8, 12, 12);
  const database = createInitialDatabase(now);
  const value = task('task_multi', '多实例任务');
  const morning = ruleFor(value, 'rule_morning', localTimestamp(2026, 8, 10, 9), localTimestamp(2026, 8, 10, 10));
  const evening = ruleFor(value, 'rule_evening', localTimestamp(2026, 8, 10, 19), localTimestamp(2026, 8, 10, 20));
  database.tasks.push(value);
  database.repeatRules.push(morning, evening);

  let state = buildTaskPlanStates(database, now).get(value.id);
  assert.equal(state.todayOccurrences.length, 2);
  database.timeLogs.push(logForOccurrence(state.todayOccurrences[0], 'log_one', LOG_STATUS.CONFIRMED, now));
  state = buildTaskPlanStates(database, now).get(value.id);
  assert.equal(state.controlKind, 'timer');
  assert.equal(state.pendingTodayOccurrences.length, 1);

  const skipped = state.pendingTodayOccurrences[0];
  database.occurrenceExceptions.push(createSkipOccurrenceException(skipped.ruleId, skipped.occurrenceStart, now));
  state = buildTaskPlanStates(database, now).get(value.id);
  assert.equal(state.todayOccurrences.length, 1);
  assert.equal(state.pendingTodayOccurrences.length, 0);
  assert.equal(state.controlKind, 'recorded');
});

test('任务计划状态：跨午夜实例与今天相交，活动或暂停计时命中任务', () => {
  const now = localTimestamp(2026, 8, 12, 0, 30);
  const database = createInitialDatabase(now);
  const value = task('task_overnight', '跨夜任务');
  const rule = ruleFor(
    value,
    'rule_overnight',
    localTimestamp(2026, 8, 11, 23),
    localTimestamp(2026, 8, 12, 1)
  );
  database.tasks.push(value);
  database.repeatRules.push(rule);
  const occurrence = projectRuleIntersectingRange(
    rule,
    localTimestamp(2026, 8, 12),
    localTimestamp(2026, 8, 13) - 1,
    []
  )[0];
  database.timer = {
    status: TIMER_STATUS.PAUSED,
    startedAt: now - 10 * MINUTE_MS,
    pausedAt: now,
    pauses: [],
    draft: {
      originRuleId: occurrence.ruleId,
      originOccurrenceId: occurrence.originOccurrenceId
    }
  };

  const state = buildTaskPlanStates(database, now).get(value.id);
  assert.equal(state.todayOccurrences.length, 2);
  assert.equal(state.timerMatchesTask, true);
  assert.equal(state.timerStatus, TIMER_STATUS.PAUSED);
  assert.equal(state.controlKind, 'timer');
  assert.equal(state.topVisible, true);
});

test('任务计划状态：撤销证据取各计划首次 confirmed 中最后形成的一条', () => {
  const now = localTimestamp(2026, 8, 12, 12);
  const database = createInitialDatabase(now);
  const value = task('task_undo', '撤销任务');
  const first = eventFor(value, 'event_first', now - 4 * HOUR_MS, now - 3 * HOUR_MS);
  const second = eventFor(value, 'event_second', now - 2 * HOUR_MS, now - HOUR_MS);
  const firstEvidence = logForEvent(first, 'log_first_evidence', LOG_STATUS.CONFIRMED, now + 10);
  const triggerEvidence = logForEvent(second, 'log_trigger', LOG_STATUS.CONFIRMED, now + 20);
  const laterExtra = logForEvent(first, 'log_later_extra', LOG_STATUS.CONFIRMED, now + 30);
  database.tasks.push(value);
  database.calendarEvents.push(first, second);
  database.timeLogs.push(firstEvidence, triggerEvidence, laterExtra);

  const state = buildTaskPlanStates(database, now).get(value.id);
  assert.equal(state.canAutoComplete, true);
  assert.equal(state.completionUndoLog.id, triggerEvidence.id);
  assert.equal(inferCompletionUndoLog(state).id, triggerEvidence.id);
});
