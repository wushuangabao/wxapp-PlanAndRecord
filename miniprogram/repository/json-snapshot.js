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
const {
  calculateLogDurationMinutes,
  calculatePausedDurationSeconds,
  calculateTimerDurationMinutes,
  isFiniteTimestamp
} = require('../domain/time');
const { materializeOccurrenceOverride } = require('../domain/recurrence');
const {
  canonicalizeRepeatPattern,
  normalizeSnapshotTitles,
  requiredTitle,
  validLogTiming
} = require('../domain/validation');

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

function validTitle(value) {
  try {
    return requiredTitle(value) === value;
  } catch (error) {
    return false;
  }
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
  const normalized = pickKnownFields(revision, [
    'id', 'revision', 'effectiveFrom', 'effectiveUntil', 'frequency', 'interval', 'weekdays',
    'monthDay', 'startedAt', 'endedAt', 'priority', 'projectId', 'projectNameSnapshot', 'taskId', 'taskNameSnapshot'
  ]);
  if (isPlainObject(normalized)
    && ['frequency', 'interval', 'weekdays', 'monthDay'].every((field) => hasOwn(normalized, field))) {
    try {
      Object.assign(normalized, canonicalizeRepeatPattern(normalized));
    } catch (error) {
      invalidSchema();
    }
  }
  return normalized;
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
    'id', 'schemaVersion', 'startedAt', 'endedAt', 'pausedDurationSeconds', 'durationMinutes',
    'projectId', 'projectNameSnapshot', 'taskId', 'taskNameSnapshot', 'calendarEventId', 'calendarEventSummarySnapshot',
    'note', 'status', 'source', 'originRuleId', 'originOccurrenceId', 'originRuleSummarySnapshot', 'tags', 'createdAt', 'updatedAt'
  ]);
  if (isPlainObject(normalized) && !hasOwn(normalized, 'pausedDurationSeconds')) {
    normalized.pausedDurationSeconds = 0;
    if (hasOwn(normalized, 'durationMinutes')
      && Number.isInteger(normalized.durationMinutes)
      && normalized.durationMinutes >= 0) {
      normalized.durationMinutes = calculateLogDurationMinutes(
        normalized.startedAt,
        normalized.endedAt,
        []
      );
    }
  }
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
      'startedAt', 'endedAt', 'pausedDurationSeconds', 'durationMinutes', 'source'
    ]);
    if (isPlainObject(normalized.candidatePreview)
      && !hasOwn(normalized.candidatePreview, 'pausedDurationSeconds')) {
      normalized.candidatePreview.pausedDurationSeconds = 0;
    }
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
  const pausedDurationSeconds = calculatePausedDurationSeconds(timer.pauses);
  const durationMinutes = calculateTimerDurationMinutes(timer.startedAt, endedAt, timer.pauses);
  return durationMinutes > 0
    ? {
      startedAt: timer.startedAt,
      endedAt,
      pausedDurationSeconds,
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
  if (Array.isArray(normalized.repeatRules) && Array.isArray(normalized.occurrenceExceptions)) {
    normalized.occurrenceExceptions.forEach((exception) => {
      if (!isPlainObject(exception) || exception.kind !== 'override') return;
      const rules = normalized.repeatRules.filter((rule) => (
        isPlainObject(rule) && rule.id === exception.ruleId
      ));
      if (rules.length !== 1) invalidSchema();
      exception.override = materializeOccurrenceOverride(rules[0], exception);
    });
  }
  if (hasOwn(normalized, 'timer')) normalized.timer = normalizeTimer(normalized.timer);
  if (hasOwn(normalized, 'recoveryDraft') && normalized.recoveryDraft !== null) {
    normalized.recoveryDraft = normalizeRecoveryDraft(normalized.recoveryDraft);
  }
  return normalizeSnapshotTitles(normalized);
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
    || !requiredString(wish.id) || !validTitle(wish.title) || !validateTimestamps(wish)) invalidSchema();
  collectId(ids, wish.id);
}

function validateObjective(objective, ids) {
  if (!requireFields(objective, ['id', 'title', 'keyResults'])
    || !requiredString(objective.id) || !validTitle(objective.title) || !Array.isArray(objective.keyResults)) invalidSchema();
  collectId(ids, objective.id);
  objective.keyResults.forEach((keyResult) => {
    if (!requireFields(keyResult, ['id', 'title', 'currentValue'])
      || !requiredString(keyResult.id) || !validTitle(keyResult.title)
      || !Number.isInteger(keyResult.currentValue) || keyResult.currentValue < 0 || keyResult.currentValue > 100) invalidSchema();
    collectId(ids, keyResult.id);
  });
}

function validateProject(project, ids) {
  if (!requireFields(project, ['id', 'title', 'deadlineAt', 'status', 'objectives', 'createdAt', 'updatedAt'])
    || !requiredString(project.id) || !validTitle(project.title) || !isFiniteTimestamp(project.deadlineAt)
    || !validEnum(project.status, PROJECT_STATUS) || !Array.isArray(project.objectives) || !validateTimestamps(project)) invalidSchema();
  collectId(ids, project.id);
  project.objectives.forEach((objective) => validateObjective(objective, ids));
}

function validateTask(task, ids) {
  const completionStateValid = (task.status === TASK_STATUS.TODO && task.completedAt === null)
    || (task.status === TASK_STATUS.COMPLETED && isFiniteTimestamp(task.completedAt));
  if (!requireFields(task, ['id', 'title', 'status', 'projectId', 'projectNameSnapshot', 'completedAt', 'createdAt', 'updatedAt'])
    || !requiredString(task.id) || !validTitle(task.title) || !validEnum(task.status, TASK_STATUS)
    || !nullableString(task.projectId) || !nullableString(task.projectNameSnapshot) || !nullableTimestamp(task.completedAt)
    || !completionStateValid || !validateTimestamps(task)) invalidSchema();
  collectId(ids, task.id);
}

function validateCalendarEvent(event, ids) {
  const references = ['projectId', 'projectNameSnapshot', 'taskId', 'taskNameSnapshot', 'repeatRuleId', 'repeatRuleSummarySnapshot'];
  if (!requireFields(event, ['id', 'title', 'startedAt', 'endedAt', 'priority', ...references, 'createdAt', 'updatedAt'])
    || !requiredString(event.id) || !validTitle(event.title) || !validTimeRange(event.startedAt, event.endedAt)
    || !validPriority(event.priority) || !references.every((field) => nullableString(event[field])) || !validateTimestamps(event)) invalidSchema();
  collectId(ids, event.id);
}

function validateRevision(revision, ids, revisions) {
  const references = ['projectId', 'projectNameSnapshot', 'taskId', 'taskNameSnapshot'];
  let canonicalPattern;
  try {
    canonicalPattern = canonicalizeRepeatPattern(revision);
  } catch (error) {
    invalidSchema();
  }
  const patternIsCanonical = canonicalPattern.frequency === revision.frequency
    && canonicalPattern.interval === revision.interval
    && canonicalPattern.monthDay === revision.monthDay
    && persistedValueEquals(canonicalPattern.weekdays, revision.weekdays);
  if (!requireFields(revision, ['id', 'revision', 'effectiveFrom', 'effectiveUntil', 'frequency', 'interval', 'weekdays', 'monthDay', 'startedAt', 'endedAt', 'priority', ...references])
    || !requiredString(revision.id) || !Number.isInteger(revision.revision) || revision.revision < 1
    || revisions.has(revision.revision) || !isFiniteTimestamp(revision.effectiveFrom)
    || !nullableTimestamp(revision.effectiveUntil) || (revision.effectiveUntil !== null && revision.effectiveUntil < revision.effectiveFrom)
    || !validEnum(revision.frequency, REPEAT_FREQUENCY) || !patternIsCanonical
    || !validTimeRange(revision.startedAt, revision.endedAt) || !validPriority(revision.priority)
    || !references.every((field) => nullableString(revision[field]))) invalidSchema();
  revisions.add(revision.revision);
  collectId(ids, revision.id);
}

function validateRepeatRule(rule, ids) {
  if (!requireFields(rule, ['id', 'title', 'revisions', 'createdAt', 'updatedAt'])
    || !requiredString(rule.id) || !validTitle(rule.title) || !Array.isArray(rule.revisions) || !rule.revisions.length
    || !validateTimestamps(rule)) invalidSchema();
  collectId(ids, rule.id);
  const revisions = new Set();
  rule.revisions.forEach((revision) => validateRevision(revision, ids, revisions));
  rule.revisions.forEach((first, firstIndex) => {
    rule.revisions.slice(firstIndex + 1).forEach((second) => {
      const firstUntil = first.effectiveUntil === null ? Number.POSITIVE_INFINITY : first.effectiveUntil;
      const secondUntil = second.effectiveUntil === null ? Number.POSITIVE_INFINITY : second.effectiveUntil;
      if (first.effectiveFrom <= secondUntil && second.effectiveFrom <= firstUntil) invalidSchema();
    });
  });
}

function validateOverride(override) {
  const fields = [
    'title', 'startedAt', 'endedAt', 'priority',
    'projectId', 'projectNameSnapshot', 'taskId', 'taskNameSnapshot'
  ];
  const nullableFields = ['projectId', 'projectNameSnapshot', 'taskId', 'taskNameSnapshot'];
  if (!requireFields(override, fields)
    || !validTitle(override.title)
    || !validTimeRange(override.startedAt, override.endedAt)
    || !validPriority(override.priority)
    || !nullableFields.every((field) => nullableString(override[field]))) invalidSchema();
}

function validateOccurrenceException(exception, ids) {
  if (!requireFields(exception, ['id', 'ruleId', 'occurrenceStart', 'kind', 'override', 'createdAt', 'updatedAt'])
    || !requiredString(exception.id) || !requiredString(exception.ruleId) || !isFiniteTimestamp(exception.occurrenceStart)
    || !['skip', 'override'].includes(exception.kind) || !validateTimestamps(exception)) invalidSchema();
  if (exception.kind === 'skip' && exception.override !== null) invalidSchema();
  if (exception.kind === 'override') validateOverride(exception.override);
  collectId(ids, exception.id);
}

function validateOccurrenceOverrideRules(database) {
  database.occurrenceExceptions.forEach((exception) => {
    if (exception.kind !== 'override') return;
    const rules = database.repeatRules.filter((rule) => rule.id === exception.ruleId);
    if (rules.length !== 1) invalidSchema();
    const materialized = materializeOccurrenceOverride(rules[0], exception);
    if (!persistedValueEquals(exception.override, materialized)) invalidSchema();
  });
}

function validateTimeLog(log, ids) {
  const nullableFields = ['projectId', 'projectNameSnapshot', 'taskId', 'taskNameSnapshot', 'calendarEventId', 'calendarEventSummarySnapshot', 'originRuleId', 'originOccurrenceId', 'originRuleSummarySnapshot'];
  if (!requireFields(log, ['id', 'schemaVersion', 'startedAt', 'endedAt', 'pausedDurationSeconds', 'durationMinutes', ...nullableFields, 'note', 'status', 'source', 'tags', 'createdAt', 'updatedAt'])) {
    invalidSchema();
  }
  let timing;
  try {
    timing = validLogTiming(log.startedAt, log.endedAt, log.pausedDurationSeconds);
  } catch (error) {
    invalidSchema();
  }
  if (!requiredString(log.id) || log.schemaVersion !== APP_SCHEMA_VERSION
    || log.durationMinutes !== timing.durationMinutes
    || !nullableFields.every((field) => nullableString(log[field]))
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

function validateRecoveryTimerStructure(timer) {
  if (!isPlainObject(timer)
    || hasOwn(timer, 'endedAt')
    || !requireFields(timer, ['status', 'startedAt', 'pausedAt', 'pauses', 'draft'])
    || !validEnum(timer.status, TIMER_STATUS)
    || !nullableTimestamp(timer.startedAt)
    || !nullableTimestamp(timer.pausedAt)
    || !Array.isArray(timer.pauses)) invalidSchema();
  timer.pauses.forEach((pause) => {
    if (!isPlainObject(pause)
      || !requireFields(pause, ['startedAt', 'endedAt'])
      || !isFiniteTimestamp(pause.startedAt)
      || !isFiniteTimestamp(pause.endedAt)) invalidSchema();
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

function recoveryCandidateTiming(timer, candidatePreview) {
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

  const pausedDurationSeconds = calculatePausedDurationSeconds(pauses);
  try {
    const timing = validLogTiming(
      candidatePreview.startedAt,
      candidatePreview.endedAt,
      pausedDurationSeconds
    );
    return {
      pausedDurationSeconds,
      durationMinutes: timing.durationMinutes
    };
  } catch (error) {
    return null;
  }
}

function validateRecoveryDraft(recoveryDraft) {
  if (recoveryDraft === null) return;
  if (!requireFields(recoveryDraft, ['reason', 'timer', 'createdAt'])
    || typeof recoveryDraft.reason !== 'string' || !isFiniteTimestamp(recoveryDraft.createdAt)) invalidSchema();
  validateRecoveryTimerStructure(recoveryDraft.timer);
  if (hasOwn(recoveryDraft, 'candidatePreview')) {
    const preview = recoveryDraft.candidatePreview;
    if (!requireFields(preview, ['startedAt', 'endedAt', 'pausedDurationSeconds', 'durationMinutes', 'source'])
      || !validTimeRange(preview.startedAt, preview.endedAt)
      || !Number.isInteger(preview.pausedDurationSeconds) || preview.pausedDurationSeconds < 0
      || !Number.isInteger(preview.durationMinutes) || preview.durationMinutes <= 0
      || preview.source !== LOG_SOURCE.TIMER) invalidSchema();
    const timing = recoveryCandidateTiming(recoveryDraft.timer, preview);
    if (timing === null
      || preview.pausedDurationSeconds !== timing.pausedDurationSeconds
      || preview.durationMinutes !== timing.durationMinutes) invalidSchema();
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
  validateOccurrenceOverrideRules(database);
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
  validateOccurrenceOverrideRules,
  persistedValueEquals
};
