const {
  APP_SCHEMA_VERSION,
  LOG_STATUS,
  TIMER_STATUS
} = require('./constants');
const { createId } = require('./id');
const { normalizeTags } = require('./tags');

function createInitialDatabase(now = Date.now()) {
  const profileId = createId('profile', now);
  return {
    schemaVersion: APP_SCHEMA_VERSION,
    localProfile: {
      id: profileId,
      createdAt: now,
      updatedAt: now
    },
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
    pausedAt: null,
    pauses: [],
    draft: {}
  };
}

function createTimeLog(input, now = Date.now(), options = {}) {
  return {
    id: createId('log', now),
    schemaVersion: APP_SCHEMA_VERSION,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationMinutes: input.durationMinutes,
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
    tags: normalizeTags(input.tags === undefined ? [] : input.tags, {
      enforceLimits: options.enforceTagLimits !== false
    }),
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
