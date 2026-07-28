const {
  APP_SCHEMA_VERSION,
  DEFAULT_CATEGORY_ID,
  DEFAULT_CATEGORY_NAME,
  LOG_STATUS,
  TIMER_STATUS
} = require('./constants');
const { createId } = require('./id');

function createInitialDatabase(now = Date.now()) {
  const profileId = createId('profile', now);
  return {
    schemaVersion: APP_SCHEMA_VERSION,
    localProfile: {
      id: profileId,
      createdAt: now,
      updatedAt: now
    },
    categories: [{
      id: DEFAULT_CATEGORY_ID,
      name: DEFAULT_CATEGORY_NAME,
      status: 'active',
      isSystem: true,
      createdAt: now,
      updatedAt: now
    }],
    wishes: [],
    projects: [],
    tasks: [],
    calendarEvents: [],
    repeatRules: [],
    occurrenceExceptions: [],
    timeLogs: [],
    timer: createIdleTimer(),
    recoveryDraft: null,
    createdAt: now,
    updatedAt: now
  };
}

function createIdleTimer() {
  return {
    status: TIMER_STATUS.IDLE,
    startedAt: null,
    endedAt: null,
    pausedAt: null,
    pauses: [],
    draft: {}
  };
}

function createTimeLog(input, now = Date.now()) {
  return {
    id: createId('log', now),
    schemaVersion: APP_SCHEMA_VERSION,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMinutes: input.durationMinutes,
    categoryId: input.categoryId || DEFAULT_CATEGORY_ID,
    categoryNameSnapshot: input.categoryNameSnapshot || DEFAULT_CATEGORY_NAME,
    projectId: input.projectId || null,
    projectNameSnapshot: input.projectNameSnapshot || null,
    taskId: input.taskId || null,
    taskNameSnapshot: input.taskNameSnapshot || null,
    calendarEventId: input.calendarEventId || null,
    calendarEventSummarySnapshot: input.calendarEventSummarySnapshot || null,
    note: input.note || '',
    status: input.status || LOG_STATUS.CONFIRMED,
    source: input.source,
    originRuleId: input.originRuleId || null,
    originOccurrenceId: input.originOccurrenceId || null,
    originRuleSummarySnapshot: input.originRuleSummarySnapshot || null,
    tags: Array.isArray(input.tags) ? input.tags : [],
    createdAt: now,
    updatedAt: now
  };
}

function createCalendarEvent(input, now = Date.now()) {
  return {
    id: createId('event', now),
    title: input.title,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    priority: input.priority,
    projectId: input.projectId || null,
    projectNameSnapshot: input.projectNameSnapshot || null,
    taskId: input.taskId || null,
    taskNameSnapshot: input.taskNameSnapshot || null,
    repeatRuleId: input.repeatRuleId || null,
    repeatRuleSummarySnapshot: input.repeatRuleSummarySnapshot || null,
    createdAt: now,
    updatedAt: now
  };
}

function createRepeatRule(input, now = Date.now()) {
  const revisionId = createId('revision', now);
  return {
    id: createId('rule', now),
    title: input.title,
    createdAt: now,
    updatedAt: now,
    revisions: [{
      id: revisionId,
      revision: 1,
      effectiveFrom: input.startedAt,
      effectiveUntil: null,
      frequency: input.frequency,
      interval: input.interval,
      weekdays: input.weekdays || [],
      monthDay: input.monthDay || null,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      priority: input.priority,
      projectId: input.projectId || null,
      projectNameSnapshot: input.projectNameSnapshot || null,
      taskId: input.taskId || null,
      taskNameSnapshot: input.taskNameSnapshot || null
    }]
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  createInitialDatabase,
  createIdleTimer,
  createTimeLog,
  createCalendarEvent,
  createRepeatRule,
  clone
};
