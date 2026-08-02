const {
  APP_SCHEMA_VERSION,
  LOG_SOURCE,
  LOG_STATUS,
  MAX_PLAN_PRIORITY,
  PROJECT_STATUS,
  REPEAT_FREQUENCY,
  TASK_STATUS,
  TIMER_STATUS
} = require('../domain/constants');
const { clone, createIdleTimer } = require('../domain/entities');
const { DomainError } = require('../domain/errors');
const { normalizeTags, tagsEqual } = require('../domain/tags');
const { calculateLogDurationMinutes, calculateTimerDurationMinutes, isFiniteTimestamp } = require('../domain/time');

const ROOT_COLLECTIONS = [
  'wishes',
  'projects',
  'tasks',
  'calendarEvents',
  'repeatRules',
  'occurrenceExceptions',
  'timeLogs'
];

const ROOT_FIELDS = [
  'schemaVersion', 'localProfile', ...ROOT_COLLECTIONS, 'timer', 'recoveryDraft', 'createdAt', 'updatedAt'
];

function invalidSchema() {
  throw new DomainError('IMPORT_SCHEMA_INVALID', '导入文件的数据结构无效');
}

function unsupportedSchema() {
  throw new DomainError('IMPORT_SCHEMA_UNSUPPORTED', '导入文件的数据版本暂不支持');
}

function duplicateId() {
  throw new DomainError('IMPORT_DUPLICATE_ID', '导入文件包含重复的实体标识');
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function requiredString(value) {
  return typeof value === 'string' && value.length > 0;
}

function nullableString(value) {
  return value === null || typeof value === 'string';
}

function hasReferenceValue(value) {
  return typeof value === 'string' && value.length > 0;
}

function validPlanAssociationShape(entity, { allowDetachedOccurrence = false } = {}) {
  const hasCalendarEvent = hasReferenceValue(entity.calendarEventId);
  const hasOriginRule = hasReferenceValue(entity.originRuleId);
  const hasOriginOccurrence = hasReferenceValue(entity.originOccurrenceId);
  if (hasCalendarEvent && (hasOriginRule || hasOriginOccurrence)) return false;
  if (hasOriginRule === hasOriginOccurrence) return true;
  return allowDetachedOccurrence && !hasOriginRule && hasOriginOccurrence;
}

function nullableTimestamp(value) {
  return value === null || isFiniteTimestamp(value);
}

function validEnum(value, values) {
  return Object.values(values).includes(value);
}

function validPriority(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_PLAN_PRIORITY;
}

function validTimeRange(startedAt, endedAt, { allowSameTime = false } = {}) {
  return isFiniteTimestamp(startedAt)
    && isFiniteTimestamp(endedAt)
    && (allowSameTime ? endedAt >= startedAt : endedAt > startedAt);
}

function validPauseRange(startedAt, endedAt) {
  return isFiniteTimestamp(startedAt) && isFiniteTimestamp(endedAt) && endedAt >= startedAt;
}

function requireFields(object, fields) {
  return isPlainObject(object) && fields.every((field) => hasOwn(object, field));
}

function pickKnownFields(object, fields) {
  if (!isPlainObject(object)) return object;
  return fields.reduce((result, field) => {
    if (hasOwn(object, field)) result[field] = object[field];
    return result;
  }, {});
}

function normalizeCollection(items, normalizeItem) {
  return Array.isArray(items) ? items.map(normalizeItem) : items;
}

function normalizeLocalProfile(profile) {
  return pickKnownFields(profile, ['id', 'createdAt', 'updatedAt']);
}

function normalizeWish(wish) {
  return pickKnownFields(wish, ['id', 'title', 'createdAt', 'updatedAt']);
}

function normalizeObjective(objective) {
  const normalized = pickKnownFields(objective, ['id', 'title', 'keyResults']);
  if (isPlainObject(normalized) && hasOwn(normalized, 'keyResults')) {
    normalized.keyResults = normalizeCollection(normalized.keyResults, (keyResult) => (
      pickKnownFields(keyResult, ['id', 'title', 'currentValue'])
    ));
  }
  return normalized;
}

function normalizeProject(project) {
  const normalized = pickKnownFields(project, ['id', 'title', 'deadlineAt', 'status', 'objectives', 'createdAt', 'updatedAt']);
  if (isPlainObject(normalized) && hasOwn(normalized, 'objectives')) {
    normalized.objectives = normalizeCollection(normalized.objectives, normalizeObjective);
  }
  return normalized;
}

function normalizeTask(task) {
  return pickKnownFields(task, ['id', 'title', 'status', 'projectId', 'projectNameSnapshot', 'completedAt', 'createdAt', 'updatedAt']);
}

function normalizeCalendarEvent(event) {
  return pickKnownFields(event, [
    'id', 'title', 'startedAt', 'endedAt', 'priority', 'projectId', 'projectNameSnapshot',
    'taskId', 'taskNameSnapshot', 'repeatRuleId', 'repeatRuleSummarySnapshot', 'createdAt', 'updatedAt'
  ]);
}

function normalizeRevision(revision) {
  return pickKnownFields(revision, [
    'id', 'revision', 'effectiveFrom', 'effectiveUntil', 'frequency', 'interval', 'weekdays',
    'monthDay', 'startedAt', 'endedAt', 'priority', 'projectId', 'projectNameSnapshot', 'taskId', 'taskNameSnapshot'
  ]);
}

function normalizeRepeatRule(rule) {
  const normalized = pickKnownFields(rule, ['id', 'title', 'revisions', 'createdAt', 'updatedAt']);
  if (isPlainObject(normalized) && hasOwn(normalized, 'revisions')) {
    normalized.revisions = normalizeCollection(normalized.revisions, normalizeRevision);
  }
  return normalized;
}

function normalizeOverride(override) {
  return pickKnownFields(override, [
    'title', 'projectId', 'projectNameSnapshot', 'taskId', 'taskNameSnapshot', 'startedAt', 'endedAt', 'priority'
  ]);
}

function normalizeOccurrenceException(exception) {
  const normalized = pickKnownFields(exception, ['id', 'ruleId', 'occurrenceStart', 'kind', 'override', 'createdAt', 'updatedAt']);
  if (isPlainObject(normalized) && hasOwn(normalized, 'override')) {
    normalized.override = normalizeOverride(normalized.override);
  }
  return normalized;
}

function normalizeTimeLog(log) {
  const normalized = pickKnownFields(log, [
    'id', 'schemaVersion', 'startedAt', 'endedAt', 'durationMinutes',
    'projectId', 'projectNameSnapshot', 'taskId', 'taskNameSnapshot', 'calendarEventId', 'calendarEventSummarySnapshot',
    'note', 'status', 'source', 'originRuleId', 'originOccurrenceId', 'originRuleSummarySnapshot', 'tags', 'createdAt', 'updatedAt'
  ]);
  if (isPlainObject(normalized) && hasOwn(normalized, 'tags')) {
    try {
      normalized.tags = normalizeTags(normalized.tags, { enforceLimits: false });
    } catch (error) {
      invalidSchema();
    }
  }
  return normalized;
}

function normalizeTimerDraft(draft) {
  const normalized = pickKnownFields(draft, [
    'projectId', 'projectNameSnapshot',
    'taskId', 'taskNameSnapshot', 'calendarEventId', 'calendarEventSummarySnapshot',
    'originRuleId', 'originOccurrenceId', 'originRuleSummarySnapshot', 'note', 'tags'
  ]);
  if (isPlainObject(normalized) && hasOwn(normalized, 'tags')) {
    try {
      normalized.tags = normalizeTags(normalized.tags, { enforceLimits: false });
    } catch (error) {
      invalidSchema();
    }
  }
  return normalized;
}

function normalizeTimerFields(timer) {
  const normalized = pickKnownFields(timer, ['status', 'startedAt', 'pausedAt', 'pauses', 'draft']);
  if (isPlainObject(normalized) && hasOwn(normalized, 'pauses')) {
    normalized.pauses = normalizeCollection(normalized.pauses, (pause) => pickKnownFields(pause, ['startedAt', 'endedAt']));
  }
  if (isPlainObject(normalized) && hasOwn(normalized, 'draft')) {
    normalized.draft = normalizeTimerDraft(normalized.draft);
  }
  return normalized;
}

function normalizeRecoveryDraft(recoveryDraft) {
  const normalized = pickKnownFields(recoveryDraft, ['reason', 'timer', 'candidatePreview', 'createdAt']);
  if (isPlainObject(normalized) && hasOwn(normalized, 'timer')) {
    normalized.timer = normalizeTimer(normalized.timer);
  }
  if (isPlainObject(normalized) && hasOwn(normalized, 'candidatePreview')) {
    normalized.candidatePreview = pickKnownFields(normalized.candidatePreview, [
      'startedAt', 'endedAt', 'durationMinutes', 'source'
    ]);
  }
  return normalized;
}

function legacyEndedCandidatePreview(timer, endedAt) {
  if (!isPlainObject(timer) || !validTimeRange(timer.startedAt, endedAt) || !Array.isArray(timer.pauses)) {
    return null;
  }
  let precedingEnd = timer.startedAt;
  for (const pause of timer.pauses) {
    if (!isPlainObject(pause)
      || !validPauseRange(pause.startedAt, pause.endedAt)
      || pause.startedAt < precedingEnd
      || pause.endedAt > endedAt) {
      return null;
    }
    precedingEnd = pause.endedAt;
  }
  const durationMinutes = calculateTimerDurationMinutes(timer.startedAt, endedAt, timer.pauses);
  return durationMinutes > 0
    ? {
      startedAt: timer.startedAt,
      endedAt,
      durationMinutes,
      source: LOG_SOURCE.TIMER
    }
    : null;
}

function normalizeLegacyTimer(timer) {
  if (!isPlainObject(timer)) {
    return { timer, changed: false, wasEnded: false, candidatePreview: null };
  }
  const hasLegacyEndedAt = hasOwn(timer, 'endedAt');
  const wasEnded = timer.status === 'ended';
  if (!hasLegacyEndedAt && !wasEnded) {
    return { timer, changed: false, wasEnded: false, candidatePreview: null };
  }

  const normalized = { ...timer };
  const endedAt = normalized.endedAt;
  delete normalized.endedAt;
  if (!wasEnded) {
    return { timer: normalized, changed: true, wasEnded: false, candidatePreview: null };
  }

  const candidatePreview = legacyEndedCandidatePreview(timer, endedAt);
  const pauses = Array.isArray(normalized.pauses)
    ? normalized.pauses.filter((pause) => isPlainObject(pause) && validPauseRange(pause.startedAt, pause.endedAt))
    : [];
  const draft = isPlainObject(normalized.draft) ? { ...normalized.draft } : {};
  if (!hasOwn(draft, 'tags')) draft.tags = [];
  return {
    timer: {
      ...normalized,
      status: TIMER_STATUS.IDLE,
      startedAt: nullableTimestamp(normalized.startedAt) ? normalized.startedAt : null,
      pausedAt: null,
      pauses,
      draft
    },
    changed: true,
    wasEnded: true,
    candidatePreview
  };
}

function createLegacyEndedRecoveryDraft(legacyTimer, createdAt) {
  const recoveryDraft = {
    reason: legacyTimer.candidatePreview
      ? '旧版已结束计时已转为待审核，请核实后确认记录'
      : '旧版已结束计时无法自动还原，请手工修正并确认记录',
    timer: legacyTimer.timer,
    createdAt
  };
  if (legacyTimer.candidatePreview) {
    recoveryDraft.candidatePreview = legacyTimer.candidatePreview;
  }
  return recoveryDraft;
}

function normalizeLegacyRecoveryDraft(recoveryDraft) {
  if (!isPlainObject(recoveryDraft) || !hasOwn(recoveryDraft, 'timer')) return recoveryDraft;
  const legacyTimer = normalizeLegacyTimer(recoveryDraft.timer);
  if (!legacyTimer.changed) return recoveryDraft;
  const normalized = { ...recoveryDraft, timer: legacyTimer.timer };
  if (legacyTimer.wasEnded && !hasOwn(normalized, 'candidatePreview') && legacyTimer.candidatePreview) {
    normalized.candidatePreview = legacyTimer.candidatePreview;
  }
  return normalized;
}

function normalizeLegacyTimerState(database) {
  if (!isPlainObject(database)) return database;
  const normalized = clone(database);
  if (hasOwn(normalized, 'timer')) {
    const legacyTimer = normalizeLegacyTimer(normalized.timer);
    if (legacyTimer.wasEnded) {
      normalized.timer = createIdleTimer();
      if (!hasOwn(normalized, 'recoveryDraft') || normalized.recoveryDraft === null) {
        normalized.recoveryDraft = createLegacyEndedRecoveryDraft(legacyTimer, normalized.updatedAt);
      }
    } else if (legacyTimer.changed) {
      normalized.timer = legacyTimer.timer;
    }
  }
  if (hasOwn(normalized, 'recoveryDraft') && normalized.recoveryDraft !== null) {
    normalized.recoveryDraft = normalizeLegacyRecoveryDraft(normalized.recoveryDraft);
  }
  return normalized;
}

function normalizeTimer(timer) {
  return normalizeTimerFields(normalizeLegacyTimer(timer).timer);
}

const COLLECTION_NORMALIZERS = {
  wishes: normalizeWish,
  projects: normalizeProject,
  tasks: normalizeTask,
  calendarEvents: normalizeCalendarEvent,
  repeatRules: normalizeRepeatRule,
  occurrenceExceptions: normalizeOccurrenceException,
  timeLogs: normalizeTimeLog
};

function normalizeJsonSnapshot(database) {
  const normalized = pickKnownFields(normalizeLegacyTimerState(database), ROOT_FIELDS);
  if (!isPlainObject(normalized)) return normalized;

  if (hasOwn(normalized, 'localProfile')) normalized.localProfile = normalizeLocalProfile(normalized.localProfile);
  ROOT_COLLECTIONS.forEach((collection) => {
    if (hasOwn(normalized, collection)) {
      normalized[collection] = normalizeCollection(normalized[collection], COLLECTION_NORMALIZERS[collection]);
    }
  });
  if (hasOwn(normalized, 'timer')) normalized.timer = normalizeTimer(normalized.timer);
  if (hasOwn(normalized, 'recoveryDraft') && normalized.recoveryDraft !== null) {
    normalized.recoveryDraft = normalizeRecoveryDraft(normalized.recoveryDraft);
  }
  return normalized;
}

function validateTimestamps(object) {
  return isFiniteTimestamp(object.createdAt) && isFiniteTimestamp(object.updatedAt);
}

function collectId(ids, id) {
  if (!requiredString(id)) invalidSchema();
  if (ids.has(id)) duplicateId();
  ids.add(id);
}

function validateLocalProfile(profile, ids) {
  if (!requireFields(profile, ['id', 'createdAt', 'updatedAt']) || !requiredString(profile.id) || !validateTimestamps(profile)) invalidSchema();
  collectId(ids, profile.id);
}

function validateWish(wish, ids) {
  if (!requireFields(wish, ['id', 'title', 'createdAt', 'updatedAt'])
    || !requiredString(wish.id) || !requiredString(wish.title) || !validateTimestamps(wish)) invalidSchema();
  collectId(ids, wish.id);
}

function validateObjective(objective, ids) {
  if (!requireFields(objective, ['id', 'title', 'keyResults'])
    || !requiredString(objective.id) || !requiredString(objective.title) || !Array.isArray(objective.keyResults)) invalidSchema();
  collectId(ids, objective.id);
  objective.keyResults.forEach((keyResult) => {
    if (!requireFields(keyResult, ['id', 'title', 'currentValue'])
      || !requiredString(keyResult.id) || !requiredString(keyResult.title)
      || !Number.isInteger(keyResult.currentValue) || keyResult.currentValue < 0 || keyResult.currentValue > 100) invalidSchema();
    collectId(ids, keyResult.id);
  });
}

function validateProject(project, ids) {
  if (!requireFields(project, ['id', 'title', 'deadlineAt', 'status', 'objectives', 'createdAt', 'updatedAt'])
    || !requiredString(project.id) || !requiredString(project.title) || !isFiniteTimestamp(project.deadlineAt)
    || !validEnum(project.status, PROJECT_STATUS) || !Array.isArray(project.objectives) || !validateTimestamps(project)) invalidSchema();
  collectId(ids, project.id);
  project.objectives.forEach((objective) => validateObjective(objective, ids));
}

function validateTask(task, ids) {
  if (!requireFields(task, ['id', 'title', 'status', 'projectId', 'projectNameSnapshot', 'completedAt', 'createdAt', 'updatedAt'])
    || !requiredString(task.id) || !requiredString(task.title) || !validEnum(task.status, TASK_STATUS)
    || !nullableString(task.projectId) || !nullableString(task.projectNameSnapshot) || !nullableTimestamp(task.completedAt)
    || !validateTimestamps(task)) invalidSchema();
  collectId(ids, task.id);
}

function validateCalendarEvent(event, ids) {
  const references = ['projectId', 'projectNameSnapshot', 'taskId', 'taskNameSnapshot', 'repeatRuleId', 'repeatRuleSummarySnapshot'];
  if (!requireFields(event, ['id', 'title', 'startedAt', 'endedAt', 'priority', ...references, 'createdAt', 'updatedAt'])
    || !requiredString(event.id) || !requiredString(event.title) || !validTimeRange(event.startedAt, event.endedAt)
    || !validPriority(event.priority) || !references.every((field) => nullableString(event[field])) || !validateTimestamps(event)) invalidSchema();
  collectId(ids, event.id);
}

function validateRevision(revision, ids, revisions) {
  const references = ['projectId', 'projectNameSnapshot', 'taskId', 'taskNameSnapshot'];
  if (!requireFields(revision, ['id', 'revision', 'effectiveFrom', 'effectiveUntil', 'frequency', 'interval', 'weekdays', 'monthDay', 'startedAt', 'endedAt', 'priority', ...references])
    || !requiredString(revision.id) || !Number.isInteger(revision.revision) || revision.revision < 1
    || revisions.has(revision.revision) || !isFiniteTimestamp(revision.effectiveFrom)
    || !nullableTimestamp(revision.effectiveUntil) || (revision.effectiveUntil !== null && revision.effectiveUntil < revision.effectiveFrom)
    || !validEnum(revision.frequency, REPEAT_FREQUENCY) || !Number.isInteger(revision.interval) || revision.interval < 1
    || !Array.isArray(revision.weekdays) || !revision.weekdays.every((weekday) => Number.isInteger(weekday) && weekday >= 0 && weekday <= 6)
    || new Set(revision.weekdays).size !== revision.weekdays.length
    || !(revision.monthDay === null || (Number.isInteger(revision.monthDay) && revision.monthDay >= 1 && revision.monthDay <= 31))
    || !validTimeRange(revision.startedAt, revision.endedAt) || !validPriority(revision.priority)
    || !references.every((field) => nullableString(revision[field]))) invalidSchema();
  revisions.add(revision.revision);
  collectId(ids, revision.id);
}

function validateRepeatRule(rule, ids) {
  if (!requireFields(rule, ['id', 'title', 'revisions', 'createdAt', 'updatedAt'])
    || !requiredString(rule.id) || !requiredString(rule.title) || !Array.isArray(rule.revisions) || !rule.revisions.length
    || !validateTimestamps(rule)) invalidSchema();
  collectId(ids, rule.id);
  const revisions = new Set();
  rule.revisions.forEach((revision) => validateRevision(revision, ids, revisions));
}

function validateOverride(override) {
  if (!isPlainObject(override)) invalidSchema();
  const optionalStringFields = ['title', 'projectId', 'projectNameSnapshot', 'taskId', 'taskNameSnapshot'];
  if (!optionalStringFields.every((field) => !hasOwn(override, field) || (field === 'title' ? typeof override[field] === 'string' : nullableString(override[field])))
    || (hasOwn(override, 'startedAt') && !isFiniteTimestamp(override.startedAt))
    || (hasOwn(override, 'endedAt') && !isFiniteTimestamp(override.endedAt))
    || (hasOwn(override, 'priority') && !validPriority(override.priority))
    || (hasOwn(override, 'startedAt') && hasOwn(override, 'endedAt') && !validTimeRange(override.startedAt, override.endedAt))) invalidSchema();
}

function validateOccurrenceException(exception, ids) {
  if (!requireFields(exception, ['id', 'ruleId', 'occurrenceStart', 'kind', 'override', 'createdAt', 'updatedAt'])
    || !requiredString(exception.id) || !requiredString(exception.ruleId) || !isFiniteTimestamp(exception.occurrenceStart)
    || !['skip', 'override'].includes(exception.kind) || !validateTimestamps(exception)) invalidSchema();
  if (exception.kind === 'skip' && exception.override !== null) invalidSchema();
  if (exception.kind === 'override') validateOverride(exception.override);
  collectId(ids, exception.id);
}

function validateTimeLog(log, ids) {
  const nullableFields = ['projectId', 'projectNameSnapshot', 'taskId', 'taskNameSnapshot', 'calendarEventId', 'calendarEventSummarySnapshot', 'originRuleId', 'originOccurrenceId', 'originRuleSummarySnapshot'];
  const maximumDurationMinutes = log.source === LOG_SOURCE.TIMER
    ? calculateTimerDurationMinutes(log.startedAt, log.endedAt, [])
    : calculateLogDurationMinutes(log.startedAt, log.endedAt, []);
  if (!requireFields(log, ['id', 'schemaVersion', 'startedAt', 'endedAt', 'durationMinutes', ...nullableFields, 'note', 'status', 'source', 'tags', 'createdAt', 'updatedAt'])
    || !requiredString(log.id) || log.schemaVersion !== APP_SCHEMA_VERSION || !validTimeRange(log.startedAt, log.endedAt, { allowSameTime: true })
    || !Number.isInteger(log.durationMinutes) || log.durationMinutes < 0
    || (log.startedAt === log.endedAt && log.durationMinutes !== 1)
    || log.durationMinutes > maximumDurationMinutes || !nullableFields.every((field) => nullableString(log[field]))
    || typeof log.note !== 'string' || !validEnum(log.status, LOG_STATUS) || !validEnum(log.source, LOG_SOURCE)
    || !validNormalizedTags(log.tags) || !validateTimestamps(log)
    || !validPlanAssociationShape(log, { allowDetachedOccurrence: true })) invalidSchema();
  collectId(ids, log.id);
}

function validNormalizedTags(tags) {
  if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string')) {
    return false;
  }
  try {
    return tagsEqual(tags, normalizeTags(tags, { enforceLimits: false }));
  } catch (error) {
    return false;
  }
}

function validateTimerDraft(draft) {
  if (!isPlainObject(draft)) invalidSchema();
  const nullableFields = [
    'projectId', 'projectNameSnapshot',
    'taskId', 'taskNameSnapshot', 'calendarEventId', 'calendarEventSummarySnapshot',
    'originRuleId', 'originOccurrenceId', 'originRuleSummarySnapshot'
  ];
  if (!nullableFields.every((field) => !hasOwn(draft, field) || nullableString(draft[field]))
    || (hasOwn(draft, 'note') && typeof draft.note !== 'string')
    || (hasOwn(draft, 'tags') && !validNormalizedTags(draft.tags))
    || !validPlanAssociationShape(draft)) invalidSchema();
}

function validateTimerStructure(timer) {
  if (hasOwn(timer, 'endedAt')
    || !requireFields(timer, ['status', 'startedAt', 'pausedAt', 'pauses', 'draft'])
    || !validEnum(timer.status, TIMER_STATUS) || !nullableTimestamp(timer.startedAt)
    || !nullableTimestamp(timer.pausedAt) || !Array.isArray(timer.pauses)) invalidSchema();
  timer.pauses.forEach((pause) => {
    if (!requireFields(pause, ['startedAt', 'endedAt']) || !validPauseRange(pause.startedAt, pause.endedAt)) invalidSchema();
  });
  validateTimerDraft(timer.draft);
  if (timer.status !== TIMER_STATUS.IDLE && !hasOwn(timer.draft, 'tags')) invalidSchema();
}

function validateTimer(timer) {
  validateTimerStructure(timer);

  if (timer.status === TIMER_STATUS.IDLE) {
    if (timer.startedAt !== null || timer.pausedAt !== null || timer.pauses.length) invalidSchema();
    return;
  }

  if (!isFiniteTimestamp(timer.startedAt)) invalidSchema();
  if (timer.status === TIMER_STATUS.RUNNING
    && timer.pausedAt !== null) invalidSchema();
  if (timer.status === TIMER_STATUS.PAUSED
    && (!isFiniteTimestamp(timer.pausedAt) || timer.pausedAt < timer.startedAt)) invalidSchema();

  let precedingEnd = timer.startedAt;
  timer.pauses.forEach((pause) => {
    if (pause.startedAt < precedingEnd) invalidSchema();
    if (timer.status === TIMER_STATUS.PAUSED && pause.endedAt > timer.pausedAt) invalidSchema();
    precedingEnd = pause.endedAt;
  });
  if (timer.status === TIMER_STATUS.PAUSED && timer.pausedAt < precedingEnd) invalidSchema();
}

function recoveryCandidateDurationUpperBound(timer, candidatePreview) {
  if (!isFiniteTimestamp(timer.startedAt)
    || candidatePreview.startedAt !== timer.startedAt
    || !Array.isArray(timer.pauses)) {
    return null;
  }

  let precedingEnd = timer.startedAt;
  const pauses = [];
  for (const pause of timer.pauses) {
    if (!requireFields(pause, ['startedAt', 'endedAt'])
      || !validPauseRange(pause.startedAt, pause.endedAt)
      || pause.startedAt < precedingEnd) {
      return null;
    }
    if (pause.startedAt < candidatePreview.endedAt) {
      pauses.push({
        startedAt: pause.startedAt,
        endedAt: Math.min(pause.endedAt, candidatePreview.endedAt)
      });
    }
    precedingEnd = pause.endedAt;
  }

  if (timer.status === TIMER_STATUS.RUNNING) {
    if (timer.pausedAt !== null) return null;
  } else if (timer.status === TIMER_STATUS.PAUSED) {
    if (!isFiniteTimestamp(timer.pausedAt) || timer.pausedAt < precedingEnd) return null;
    if (timer.pausedAt < candidatePreview.endedAt) {
      pauses.push({ startedAt: timer.pausedAt, endedAt: candidatePreview.endedAt });
    }
  } else if (timer.status !== TIMER_STATUS.IDLE || timer.pausedAt !== null) {
    return null;
  }

  return calculateTimerDurationMinutes(
    candidatePreview.startedAt,
    candidatePreview.endedAt,
    pauses
  );
}

function validateRecoveryDraft(recoveryDraft) {
  if (recoveryDraft === null) return;
  if (!requireFields(recoveryDraft, ['reason', 'timer', 'createdAt'])
    || typeof recoveryDraft.reason !== 'string' || !isFiniteTimestamp(recoveryDraft.createdAt)) invalidSchema();
  validateTimerStructure(recoveryDraft.timer);
  if (hasOwn(recoveryDraft, 'candidatePreview')) {
    const preview = recoveryDraft.candidatePreview;
    if (!requireFields(preview, ['startedAt', 'endedAt', 'durationMinutes', 'source'])
      || !validTimeRange(preview.startedAt, preview.endedAt)
      || !Number.isInteger(preview.durationMinutes) || preview.durationMinutes <= 0
      || preview.source !== LOG_SOURCE.TIMER) invalidSchema();
    const durationUpperBound = recoveryCandidateDurationUpperBound(recoveryDraft.timer, preview);
    if (durationUpperBound === null || preview.durationMinutes > durationUpperBound) invalidSchema();
  }
}

function validateJsonSnapshot(database) {
  if (!requireFields(database, ROOT_FIELDS)) invalidSchema();
  if (!Number.isInteger(database.schemaVersion)) invalidSchema();
  if (database.schemaVersion !== APP_SCHEMA_VERSION) unsupportedSchema();
  if (!validateTimestamps(database)) invalidSchema();
  if (!ROOT_COLLECTIONS.every((field) => Array.isArray(database[field]))) invalidSchema();

  const ids = new Set();
  validateLocalProfile(database.localProfile, ids);
  database.wishes.forEach((wish) => validateWish(wish, ids));
  database.projects.forEach((project) => validateProject(project, ids));
  database.tasks.forEach((task) => validateTask(task, ids));
  database.calendarEvents.forEach((event) => validateCalendarEvent(event, ids));
  database.repeatRules.forEach((rule) => validateRepeatRule(rule, ids));
  database.occurrenceExceptions.forEach((exception) => validateOccurrenceException(exception, ids));
  database.timeLogs.forEach((log) => validateTimeLog(log, ids));
  validateTimer(database.timer);
  validateRecoveryDraft(database.recoveryDraft);
}

function parseJsonSnapshot(jsonText) {
  if (typeof jsonText !== 'string') {
    throw new DomainError('IMPORT_JSON_INVALID', '导入文件不是有效的 JSON 文本');
  }
  let database;
  try {
    database = JSON.parse(jsonText);
  } catch (error) {
    throw new DomainError('IMPORT_JSON_INVALID', 'JSON 文件无法解析，请检查文件是否完整');
  }
  const normalized = normalizeJsonSnapshot(database);
  validateJsonSnapshot(normalized);
  return clone(normalized);
}

function persistedValueEquals(first, second) {
  if (Object.is(first, second)) return true;
  if (Array.isArray(first) || Array.isArray(second)) {
    return Array.isArray(first)
      && Array.isArray(second)
      && first.length === second.length
      && first.every((value, index) => persistedValueEquals(value, second[index]));
  }
  if (first && second && typeof first === 'object' && typeof second === 'object') {
    const firstKeys = Object.keys(first).sort();
    const secondKeys = Object.keys(second).sort();
    return persistedValueEquals(firstKeys, secondKeys)
      && firstKeys.every((key) => persistedValueEquals(first[key], second[key]));
  }
  return false;
}

module.exports = {
  normalizeLegacyTimerState,
  normalizeJsonSnapshot,
  parseJsonSnapshot,
  validateJsonSnapshot,
  persistedValueEquals
};
