const {
  LOG_SOURCE,
  LOG_STATUS,
  MAX_ACTIVE_PROJECTS,
  MAX_TIMER_SPAN_MS,
  PROJECT_STATUS,
  TASK_STATUS,
  TIMER_STATUS
} = require('../domain/constants');
const { DomainError } = require('../domain/errors');
const { createId } = require('../domain/id');
const { clone, createCalendarEvent, createIdleTimer, createRepeatRule, createTimeLog } = require('../domain/entities');
const {
  createSkipOccurrenceException,
  intervalIntersectsRange,
  logicalOccurrenceKey,
  logicalOccurrenceStart,
  occurrenceKey,
  projectRule,
  projectRuleIntersectingRange
} = require('../domain/recurrence');
const { buildStatistics } = require('../domain/statistics');
const { buildTimeLogOverlapMetadata } = require('../domain/time-log-overlaps');
const { normalizeTags, tagsEqual } = require('../domain/tags');
const {
  calculateLogDurationMinutes,
  calculateLogTiming,
  calculatePausedDurationSeconds,
  inspectTimerAt,
  moveTimerToRecoveryDraft,
  isFiniteTimestamp
} = require('../domain/time');
const {
  canonicalizeRepeatPattern,
  requiredTitle,
  validLogTiming,
  validPriority,
  validTimeRange
} = require('../domain/validation');
const {
  ENTITY_COLLECTIONS,
  IMPORT_MODE,
  createImportAnalysis,
  resolveImportAnalysis
} = require('../repository/json-import');
const { normalizeJsonSnapshot, parseJsonSnapshot, persistedValueEquals } = require('../repository/json-snapshot');
const { displayLogTitle } = require('../utils/log-presentation');
const { exportJson } = require('./export-service');
const {
  buildTaskPlanStates,
  activeTimerMatchesEvent,
  activeTimerMatchesOccurrence
} = require('./task-plan-state');

function firstRuleOccurrence(rule) {
  const revision = rule.revisions[0];
  return projectRule(
    rule,
    revision.effectiveFrom,
    revision.effectiveFrom,
    []
  )[0] || null;
}

function localDayStart(timestamp) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

class ApplicationService {
  constructor(repository, options = {}) {
    this.repository = repository;
    this.now = options.now || Date.now;
    this.exportTempFileStore = options.exportTempFileStore || null;
    this.preferenceStore = options.preferenceStore || null;
    this.recoveryTimerSpanMs = Number.isFinite(options.recoveryTimerSpanMs) && options.recoveryTimerSpanMs > 0
      ? options.recoveryTimerSpanMs
      : MAX_TIMER_SPAN_MS;
    this.pendingJsonImport = null;
  }

  initialize() {
    this.repository.initialize();
    return this.recoverTimer();
  }

  snapshot() {
    return this.repository.read();
  }

  taskPlanStates(at = this.now()) {
    return buildTaskPlanStates(this.snapshot(), at);
  }

  resolvedTaskPlanStatus(task, state) {
    if (!state) return task.status;
    if (state.canAutoComplete) return TASK_STATUS.COMPLETED;
    if (state.entityPlans.length > 0 || state.activeRepeatRules.length > 0) {
      return TASK_STATUS.TODO;
    }
    return task.status;
  }

  reconcileTaskPlanStatuses(database, now, taskIds = null) {
    const restrictedTaskIds = taskIds ? new Set(taskIds.filter(Boolean)) : null;
    const states = buildTaskPlanStates(database, now);
    database.tasks.forEach((task) => {
      if (restrictedTaskIds && !restrictedTaskIds.has(task.id)) return;
      const state = states.get(task.id);
      if (!state) return;
      const nextStatus = this.resolvedTaskPlanStatus(task, state);
      if (nextStatus === task.status) return;
      task.status = nextStatus;
      task.completedAt = nextStatus === TASK_STATUS.COMPLETED ? now : null;
      task.updatedAt = now;
    });
  }

  refreshTaskPlanStatuses(at = this.now()) {
    const snapshot = this.snapshot();
    const states = buildTaskPlanStates(snapshot, at);
    const changedTaskIds = snapshot.tasks
      .filter((task) => this.resolvedTaskPlanStatus(task, states.get(task.id)) !== task.status)
      .map((task) => task.id);
    if (!changedTaskIds.length) return [];
    return this.repository.transaction((database) => {
      this.reconcileTaskPlanStatuses(database, at, changedTaskIds);
      return changedTaskIds;
    }, { updatedAt: at }).result;
  }

  taskIdsForRecord(database, record) {
    const taskIds = new Set();
    if (record && record.taskId) taskIds.add(record.taskId);
    if (record && record.calendarEventId) {
      const event = database.calendarEvents.find((item) => item.id === record.calendarEventId);
      if (event && event.taskId) taskIds.add(event.taskId);
    }
    if (record && record.originRuleId) {
      const rule = database.repeatRules.find((item) => item.id === record.originRuleId);
      (rule && rule.revisions || []).forEach((revision) => {
        if (revision.taskId) taskIds.add(revision.taskId);
      });
    }
    return Array.from(taskIds);
  }

  startTimerInDatabase(database, input, now) {
    if (database.recoveryDraft) {
      throw new DomainError('RECOVERY_DRAFT_PENDING', '有一条待修正的恢复草稿，请先处理');
    }
    if (database.timer.status !== TIMER_STATUS.IDLE) {
      throw new DomainError('TIMER_ALREADY_ACTIVE', '已有进行中的计时，请先结束当前计时');
    }
    const association = this.resolveNewRecordAssociations(database, input);
    database.timer = {
      status: TIMER_STATUS.RUNNING,
      startedAt: now,
      pausedAt: null,
      pauses: [],
      draft: {
        ...association,
        note: input.note || '',
        tags: normalizeTags(input.tags === undefined ? [] : input.tags)
      }
    };
    return database.timer;
  }

  startTaskPlanTimer(taskId, candidateId = null) {
    const now = this.now();
    return this.repository.transaction((database) => {
      this.requireEntity(database.tasks, taskId, '任务');
      const state = buildTaskPlanStates(database, now).get(taskId);
      if (state.timerMatchesTask) {
        throw new DomainError('TIMER_ALREADY_ACTIVE', '该任务已在计时，请前往计时页查看');
      }
      let candidate = candidateId
        ? state.candidates.find((item) => item.id === candidateId)
        : null;
      if (!candidate && !candidateId && state.candidates.length === 1) {
        [candidate] = state.candidates;
      }
      if (!candidate && !candidateId && state.candidates.length > 1) {
        throw new DomainError('TASK_PLAN_CANDIDATE_REQUIRED', '该任务关联多个可执行计划，请先选择一个');
      }
      if (!candidate) {
        throw new DomainError('TASK_PLAN_CANDIDATE_UNAVAILABLE', '该计划已记录或不再可执行');
      }
      const association = candidate.kind === 'event'
        ? { calendarEventId: candidate.calendarEventId }
        : {
          originRuleId: candidate.originRuleId,
          originOccurrenceId: candidate.originOccurrenceId
        };
      return this.startTimerInDatabase(database, association, now);
    }, { updatedAt: now }).result;
  }

  confirmTaskPlanCandidate(taskId, candidateId) {
    const now = this.now();
    return this.repository.transaction((database) => {
      this.requireEntity(database.tasks, taskId, '任务');
      const state = buildTaskPlanStates(database, now).get(taskId);
      const candidate = state && candidateId
        ? state.candidates.find((item) => item.id === candidateId)
        : null;
      if (!candidate) {
        throw new DomainError('TASK_PLAN_CANDIDATE_UNAVAILABLE', '该计划已记录或不再可执行');
      }
      if (candidate.kind === 'occurrence') {
        return this.confirmVirtualOccurrenceInDatabase(database, {
          ruleId: candidate.originRuleId,
          originOccurrenceId: candidate.originOccurrenceId,
          startedAt: candidate.startedAt
        }, now);
      }
      return this.confirmCalendarEventInDatabase(database, candidate.calendarEventId, now);
    }, { updatedAt: now }).result;
  }

  confirmCalendarEventInDatabase(database, eventId, now, input = {}) {
    const event = this.requireEntity(database.calendarEvents, eventId, '计划块');
    if (activeTimerMatchesEvent(database, event.id)) {
      throw new DomainError('PLAN_TIMER_ACTIVE', '该计划已经在计时了');
    }
    if (event.startedAt > now) {
      throw new DomainError('PLAN_NOT_STARTED', '计划尚未开始，暂不能确认完成');
    }
    const association = this.resolveNewRecordAssociations(database, {
      calendarEventId: event.id
    });
    const log = createTimeLog({
      ...association,
      startedAt: event.startedAt,
      endedAt: event.endedAt,
      durationMinutes: calculateLogDurationMinutes(event.startedAt, event.endedAt, []),
      note: input.note || event.title,
      status: LOG_STATUS.CONFIRMED,
      source: LOG_SOURCE.MANUAL,
      tags: input.tags
    }, now);
    database.timeLogs.push(log);
    this.reconcileTaskPlanStatuses(database, now, this.taskIdsForRecord(database, log));
    return log;
  }

  taskCompletionUndoPreview(taskId) {
    const state = buildTaskPlanStates(this.snapshot(), this.now()).get(taskId);
    if (!state || !state.completionUndoLog) {
      throw new DomainError('TASK_COMPLETION_EVIDENCE_NOT_FOUND', '找不到本次自动完成对应的时间记录');
    }
    return clone(state.completionUndoLog);
  }

  reopenTaskByRemovingCompletionLog(taskId, logId, confirmed) {
    if (confirmed !== true) {
      throw new DomainError('TASK_REOPEN_CONFIRMATION_REQUIRED', '重新打开任务会删除对应时间记录，需要二次确认');
    }
    const now = this.now();
    return this.repository.transaction((database) => {
      const task = this.requireEntity(database.tasks, taskId, '任务');
      const state = buildTaskPlanStates(database, now).get(taskId);
      const evidence = state && state.completionUndoLog;
      if (!evidence || evidence.id !== logId) {
        throw new DomainError('TASK_COMPLETION_EVIDENCE_CHANGED', '任务完成证据已变化，请刷新后重试');
      }
      database.timeLogs = database.timeLogs.filter((log) => log.id !== logId);
      task.status = TASK_STATUS.TODO;
      task.completedAt = null;
      task.updatedAt = now;
      this.reconcileTaskPlanStatuses(database, now, [taskId]);
      return { task, deletedLogId: logId };
    }, { updatedAt: now }).result;
  }

  storageUsage() {
    return clone(this.repository.getStorageUsage());
  }

  requirePendingJsonImport(token) {
    if (!this.pendingJsonImport || this.pendingJsonImport.token !== token) {
      throw new DomainError('IMPORT_PREVIEW_NOT_FOUND', '导入预览已失效，请重新选择文件');
    }
    return this.pendingJsonImport;
  }

  prepareJsonImport(jsonText) {
    const importedDatabase = parseJsonSnapshot(jsonText);
    const token = createId('import', this.now());
    this.pendingJsonImport = {
      token,
      importedDatabase,
      baselineDatabase: normalizeJsonSnapshot(this.snapshot()),
      analysis: null,
      resolved: null,
      preview: null
    };
    const sourceCounts = ENTITY_COLLECTIONS.reduce((counts, collection) => {
      counts[collection] = importedDatabase[collection].length;
      return counts;
    }, {});
    return {
      token,
      schemaVersion: importedDatabase.schemaVersion,
      sourceCounts
    };
  }

  previewJsonImport(token, options = {}) {
    const pending = this.requirePendingJsonImport(token);
    const analysis = createImportAnalysis(
      pending.baselineDatabase,
      pending.importedDatabase,
      { mode: options.mode, now: this.now() }
    );
    pending.analysis = analysis;
    pending.resolved = null;

    if (analysis.conflictCount && !options.conflictPolicy) {
      pending.preview = {
        mode: analysis.mode,
        conflictPolicy: null,
        conflictCount: analysis.conflictCount,
        identicalCount: analysis.identicalCount,
        addedCounts: clone(analysis.addedCounts),
        requiresConflictPolicy: true
      };
      return clone(pending.preview);
    }

    const resolved = resolveImportAnalysis(analysis, options.conflictPolicy);
    pending.resolved = resolved;
    pending.preview = {
      ...clone(resolved.summary),
      requiresConflictPolicy: false
    };
    return clone(pending.preview);
  }

  commitJsonImport(token) {
    const pending = this.requirePendingJsonImport(token);
    if (!pending.resolved || !pending.preview || pending.preview.requiresConflictPolicy) {
      throw new DomainError('IMPORT_PREVIEW_REQUIRED', '请先完成导入预览和冲突选择');
    }

    const current = normalizeJsonSnapshot(this.snapshot());
    if (!persistedValueEquals(current, pending.baselineDatabase)) {
      throw new DomainError('IMPORT_PREVIEW_STALE', '本地数据已变化，请重新预览后再导入');
    }

    const mode = pending.analysis.mode;
    const conflictPolicy = pending.preview.conflictPolicy;
    const analysis = createImportAnalysis(
      current,
      pending.importedDatabase,
      { mode, now: this.now() }
    );
    const resolved = resolveImportAnalysis(analysis, conflictPolicy);
    this.repository.replace(resolved.database, {
      clearMigrationBackup: mode === IMPORT_MODE.REPLACE
    });
    if (mode === IMPORT_MODE.REPLACE
      && this.preferenceStore
      && typeof this.preferenceStore.clearAllBestEffort === 'function') {
      this.preferenceStore.clearAllBestEffort();
    }
    this.pendingJsonImport = null;
    return clone(resolved.summary);
  }

  cancelJsonImport(token) {
    if (this.pendingJsonImport && this.pendingJsonImport.token === token) {
      this.pendingJsonImport = null;
    }
  }

  clearAllData(confirmed) {
    if (confirmed !== true) {
      throw new DomainError('CLEAR_CONFIRMATION_REQUIRED', '清空全部本地数据需要明确确认');
    }
    if (
      !this.exportTempFileStore
      || typeof this.exportTempFileStore.removeAllStrict !== 'function'
    ) {
      throw new DomainError(
        'EXPORT_TEMP_FILE_STORE_UNAVAILABLE',
        '无法确认临时导出文件已清理，数据未清空，请重试'
      );
    }
    try {
      this.exportTempFileStore.removeAllStrict();
    } catch (error) {
      throw new DomainError(
        'EXPORT_TEMP_FILE_CLEANUP_FAILED',
        '无法确认临时导出文件已清理，数据未清空，请重试'
      );
    }
    const capturedPreferences = this.preferenceStore
      && typeof this.preferenceStore.clearAllStrict === 'function'
      ? this.preferenceStore.clearAllStrict()
      : null;
    let database;
    try {
      database = this.repository.reset();
    } catch (error) {
      const preferencesRestored = !capturedPreferences
        || (typeof this.preferenceStore.restoreAllBestEffort === 'function'
          && this.preferenceStore.restoreAllBestEffort(capturedPreferences));
      if (!preferencesRestored) {
        if (error && typeof error.code === 'string' && typeof error.message === 'string') {
          error.message = `${error.message}；界面设置可能已重置，请重新进入核对`;
          throw error;
        }
        throw new DomainError(
          'CLEAR_PREFERENCE_RESTORE_UNCERTAIN',
          '业务资料库清空未完成，界面设置可能已重置，请重新进入核对并尽快导出'
        );
      }
      throw error;
    }
    this.pendingJsonImport = null;
    return {
      cleared: true,
      localProfileId: database.localProfile.id
    };
  }

  activeProjects(database) {
    return database.projects.filter((project) => project.status === PROJECT_STATUS.ACTIVE);
  }

  requireWishToProjectConversion(database, wishId) {
    const wish = this.requireEntity(database.wishes, wishId, '愿望');
    if (this.activeProjects(database).length >= MAX_ACTIVE_PROJECTS) {
      throw new DomainError('ACTIVE_PROJECT_LIMIT', '要保持专注，别贪多了~');
    }
    return wish;
  }

  requireEntity(items, id, label) {
    const entity = items.find((item) => item.id === id);
    if (!entity) {
      throw new DomainError('ENTITY_NOT_FOUND', `${label}不存在或已被删除`);
    }
    return entity;
  }

  requireTaskStatus(status) {
    if (!Object.values(TASK_STATUS).includes(status)) {
      throw new DomainError('TASK_STATUS_INVALID', '任务状态无效');
    }
    return status;
  }

  detachTaskReference(target, task) {
    if (!target || target.taskId !== task.id) return false;
    target.taskId = null;
    target.taskNameSnapshot = target.taskNameSnapshot || task.title;
    return true;
  }

  detachProjectReference(target, project) {
    if (!target || target.projectId !== project.id) return false;
    target.projectId = null;
    target.projectNameSnapshot = target.projectNameSnapshot || project.title;
    return true;
  }

  detachCalendarEventReference(target, event) {
    if (!target || target.calendarEventId !== event.id) return false;
    target.calendarEventId = null;
    target.calendarEventSummarySnapshot = target.calendarEventSummarySnapshot || event.title;
    return true;
  }

  calendarEventHasExecutionReferences(database, eventId) {
    const referencesEvent = (target) => Boolean(target && target.calendarEventId === eventId);
    return database.timeLogs.some(referencesEvent)
      || referencesEvent(database.timer && database.timer.draft)
      || referencesEvent(database.recoveryDraft && database.recoveryDraft.timer
        && database.recoveryDraft.timer.draft);
  }

  detachRepeatRuleReference(target, rule, options = {}) {
    if (!target) return false;
    let changed = false;
    if (target.originRuleId === rule.id) {
      target.originRuleId = null;
      if (options.clearOriginOccurrence === true) {
        target.originOccurrenceId = null;
      }
      target.originRuleSummarySnapshot = target.originRuleSummarySnapshot || rule.title;
      changed = true;
    }
    return changed;
  }

  originReferenceStartsAtOrAfter(target, ruleId, occurrenceStart) {
    if (!target || target.originRuleId !== ruleId) return false;
    const targetStart = logicalOccurrenceStart(ruleId, target.originOccurrenceId);
    return targetStart !== null && targetStart >= occurrenceStart;
  }

  ruleFollowingReferenceBlocksEdit(target, ruleId, occurrenceStart) {
    if (!target || target.originRuleId !== ruleId) return false;
    const targetStart = logicalOccurrenceStart(ruleId, target.originOccurrenceId);
    return targetStart === null || targetStart >= occurrenceStart;
  }

  ruleFollowingHasExecutionReferences(database, ruleId, occurrenceStart) {
    const blocksEdit = (target) => this.ruleFollowingReferenceBlocksEdit(
      target,
      ruleId,
      occurrenceStart
    );
    const activeTimerDraft = database.timer
      && database.timer.status !== TIMER_STATUS.IDLE
      ? database.timer.draft
      : null;
    const recoveryDraft = database.recoveryDraft
      && database.recoveryDraft.timer
      && database.recoveryDraft.timer.draft;
    return database.timeLogs.some(blocksEdit)
      || blocksEdit(activeTimerDraft)
      || blocksEdit(recoveryDraft);
  }

  projectedRuleOccurrence(database, rule, occurrenceStart) {
    return projectRule(
      rule,
      occurrenceStart,
      occurrenceStart,
      database.occurrenceExceptions
    ).find((item) => item.occurrenceStart === occurrenceStart) || null;
  }

  detachAbandonedProjectDraftReferences(target, project, deletingTasks, invalidatedEvents, deletedRules) {
    if (!target) return;
    this.detachProjectReference(target, project);
    const task = deletingTasks.find((item) => item.id === target.taskId);
    if (task) this.detachTaskReference(target, task);
    const event = invalidatedEvents.find((item) => item.id === target.calendarEventId);
    if (event) this.detachCalendarEventReference(target, event);
    deletedRules.forEach((rule) => this.detachRepeatRuleReference(
      target,
      rule,
      { clearOriginOccurrence: true }
    ));
  }

  resolveAssociations(database, input = {}) {
    let project = null;
    let task = null;
    let event = null;
    if (input.projectId) {
      project = this.requireEntity(database.projects, input.projectId, '项目');
    }
    if (input.taskId) {
      task = this.requireEntity(database.tasks, input.taskId, '任务');
      if (!project && task.projectId) {
        project = this.requireEntity(database.projects, task.projectId, '项目');
      }
    }
    if (input.calendarEventId) {
      event = this.requireEntity(database.calendarEvents, input.calendarEventId, '计划块');
    }
    return {
      projectId: project ? project.id : null,
      projectNameSnapshot: project ? project.title : null,
      taskId: task ? task.id : null,
      taskNameSnapshot: task ? task.title : null,
      calendarEventId: event ? event.id : null,
      calendarEventSummarySnapshot: event ? event.title : null
    };
  }

  hasReferenceValue(value) {
    return value !== undefined && value !== null && value !== '';
  }

  rejectDirectPlanProject(input = {}) {
    if (this.hasReferenceValue(input.projectId)) {
      throw new DomainError(
        'PLAN_PROJECT_DIRECT_FORBIDDEN',
        '计划块只能关联任务，项目归属由任务推导'
      );
    }
  }

  rejectDirectRecordTaskOrProject(input = {}) {
    if (this.hasReferenceValue(input.projectId) || this.hasReferenceValue(input.taskId)) {
      throw new DomainError(
        'LOG_DIRECT_ASSOCIATION_FORBIDDEN',
        '时间记录只能关联计划块，不能直接关联项目或任务'
      );
    }
  }

  resolvePlanTaskAssociation(database, taskId) {
    if (!this.hasReferenceValue(taskId)) {
      throw new DomainError('PLAN_TASK_REQUIRED', '计划块必须关联任务');
    }
    const task = this.requireEntity(database.tasks, taskId, '任务');
    const project = task.projectId
      ? this.requireEntity(database.projects, task.projectId, '项目')
      : null;
    return {
      projectId: null,
      projectNameSnapshot: project ? project.title : null,
      taskId: task.id,
      taskNameSnapshot: task.title
    };
  }

  createTaskRecord(database, title, now, association = {}) {
    const task = {
      id: createId('task', now),
      title,
      status: TASK_STATUS.TODO,
      projectId: association.projectId || null,
      projectNameSnapshot: association.projectNameSnapshot || null,
      completedAt: null,
      createdAt: now,
      updatedAt: now
    };
    database.tasks.unshift(task);
    return task;
  }

  createPlanTaskFromTitle(database, title, now, association = {}) {
    return this.createTaskRecord(database, title, now, association);
  }

  resolveActiveTaskProjectAssociation(database, taskProjectId) {
    if (!this.hasReferenceValue(taskProjectId)) {
      return { projectId: null, projectNameSnapshot: null };
    }
    const project = this.requireEntity(database.projects, taskProjectId, '项目');
    if (project.status !== PROJECT_STATUS.ACTIVE) {
      throw new DomainError('PROJECT_NOT_ACTIVE', '只能关联活动项目');
    }
    return { projectId: project.id, projectNameSnapshot: project.title };
  }

  resolveCalendarEventRecordAssociation(database, calendarEventId) {
    if (!this.hasReferenceValue(calendarEventId)) {
      return {
        projectId: null,
        projectNameSnapshot: null,
        taskId: null,
        taskNameSnapshot: null,
        calendarEventId: null,
        calendarEventSummarySnapshot: null,
        originRuleId: null,
        originOccurrenceId: null,
        originRuleSummarySnapshot: null
      };
    }
    const event = this.requireEntity(database.calendarEvents, calendarEventId, '计划块');
    if (!event.taskId || !database.tasks.some((task) => task.id === event.taskId)) {
      throw new DomainError(
        'CALENDAR_EVENT_TASK_UNAVAILABLE',
        '该计划块关联的任务已失效，不能用于新的时间记录'
      );
    }
    const taskAssociation = this.resolvePlanTaskAssociation(database, event.taskId);
    return {
      projectId: null,
      projectNameSnapshot: taskAssociation.projectNameSnapshot,
      taskId: null,
      taskNameSnapshot: taskAssociation.taskNameSnapshot,
      calendarEventId: event.id,
      calendarEventSummarySnapshot: event.title,
      originRuleId: null,
      originOccurrenceId: null,
      originRuleSummarySnapshot: null
    };
  }

  resolveOriginOccurrenceRecordAssociation(database, originRuleId, originOccurrenceId) {
    const occurrenceStart = logicalOccurrenceStart(originRuleId, originOccurrenceId);
    if (occurrenceStart === null) {
      throw new DomainError('OCCURRENCE_REFERENCE_INVALID', '重复计划实例标识无效');
    }
    const rule = this.requireEntity(database.repeatRules, originRuleId, '重复规则');
    const occurrence = projectRule(
      rule,
      occurrenceStart,
      occurrenceStart,
      database.occurrenceExceptions
    ).find((item) => item.originOccurrenceId === originOccurrenceId);
    if (!occurrence) {
      throw new DomainError('OCCURRENCE_NOT_FOUND', '该重复实例已跳过、已修改或不再有效');
    }
    const taskAssociation = this.resolvePlanTaskAssociation(database, occurrence.taskId);
    return {
      projectId: null,
      projectNameSnapshot: taskAssociation.projectNameSnapshot,
      taskId: null,
      taskNameSnapshot: taskAssociation.taskNameSnapshot,
      calendarEventId: null,
      calendarEventSummarySnapshot: null,
      originRuleId: rule.id,
      originOccurrenceId: occurrence.originOccurrenceId,
      originRuleSummarySnapshot: rule.title
    };
  }

  emptyRecordPlanAssociation(current = {}) {
    return {
      projectId: null,
      projectNameSnapshot: current.projectNameSnapshot || null,
      taskId: null,
      taskNameSnapshot: current.taskNameSnapshot || null,
      calendarEventId: null,
      calendarEventSummarySnapshot: current.calendarEventSummarySnapshot || null,
      originRuleId: null,
      originOccurrenceId: null,
      originRuleSummarySnapshot: current.originRuleSummarySnapshot || null
    };
  }

  resolveRequestedRecordPlanAssociation(database, input = {}, current = {}) {
    const calendarEventId = this.hasReferenceValue(input.calendarEventId)
      ? input.calendarEventId
      : null;
    const originRuleId = this.hasReferenceValue(input.originRuleId)
      ? input.originRuleId
      : null;
    const originOccurrenceId = this.hasReferenceValue(input.originOccurrenceId)
      ? input.originOccurrenceId
      : null;
    if (calendarEventId && (originRuleId || originOccurrenceId)) {
      throw new DomainError(
        'PLAN_ASSOCIATION_CONFLICT',
        '计划块与重复计划实例只能选择一个'
      );
    }
    if (Boolean(originRuleId) !== Boolean(originOccurrenceId)) {
      throw new DomainError(
        'OCCURRENCE_REFERENCE_PAIR_REQUIRED',
        '重复计划关联必须同时提供规则与实例标识'
      );
    }
    if (calendarEventId) {
      if (
        calendarEventId === (current.calendarEventId || null)
        && !current.originRuleId
        && !current.originOccurrenceId
      ) {
        return this.preserveRecordPlanAssociation(database, current);
      }
      return this.resolveCalendarEventRecordAssociation(database, calendarEventId);
    }
    if (originRuleId) {
      if (
        originRuleId === (current.originRuleId || null)
        && originOccurrenceId === (current.originOccurrenceId || null)
        && !current.calendarEventId
      ) {
        return this.preserveRecordPlanAssociation(database, current);
      }
      return this.resolveOriginOccurrenceRecordAssociation(
        database,
        originRuleId,
        originOccurrenceId
      );
    }
    if (
      !current.calendarEventId
      && !current.originRuleId
      && this.hasReferenceValue(current.originOccurrenceId)
    ) {
      return this.preserveRecordPlanAssociation(database, current);
    }
    return this.emptyRecordPlanAssociation(current);
  }

  resolveNewRecordAssociations(database, input = {}) {
    this.rejectDirectRecordTaskOrProject(input);
    return this.resolveRequestedRecordPlanAssociation(database, input);
  }

  preserveRecordPlanAssociation(database, current = {}) {
    const event = current.calendarEventId
      ? database.calendarEvents.find((item) => item.id === current.calendarEventId)
      : null;
    const task = event && event.taskId
      ? database.tasks.find((item) => item.id === event.taskId)
      : null;
    const project = task && task.projectId
      ? database.projects.find((item) => item.id === task.projectId)
      : null;
    const hasConcretePlan = Boolean(event);
    return {
      projectId: null,
      projectNameSnapshot: hasConcretePlan
        ? (project ? project.title : null)
          || event.projectNameSnapshot
          || current.projectNameSnapshot
          || null
        : current.projectNameSnapshot || null,
      taskId: null,
      taskNameSnapshot: hasConcretePlan
        ? (task ? task.title : null)
          || event.taskNameSnapshot
          || current.taskNameSnapshot
          || null
        : current.taskNameSnapshot || null,
      calendarEventId: event ? event.id : null,
      calendarEventSummarySnapshot: current.calendarEventSummarySnapshot
        || (event ? event.title : null),
      originRuleId: hasConcretePlan ? null : current.originRuleId || null,
      originOccurrenceId: hasConcretePlan ? null : current.originOccurrenceId || null,
      originRuleSummarySnapshot: current.originRuleSummarySnapshot || null
    };
  }

  resolveRecordUpdateAssociations(database, current = {}, input = {}) {
    this.rejectDirectRecordTaskOrProject(input);
    const planAssociationInputSpecified = [
      input.calendarEventId,
      input.originRuleId,
      input.originOccurrenceId
    ].some((value) => value !== undefined);
    const planAssociation = planAssociationInputSpecified
      ? this.resolveRequestedRecordPlanAssociation(database, input, current)
      : this.preserveRecordPlanAssociation(database, current);
    return planAssociation;
  }

  resolveUpdatedTags(currentTags, inputTags) {
    const current = Array.isArray(currentTags) ? currentTags : [];
    if (inputTags === undefined) {
      return current;
    }
    const normalizedWithoutLimits = normalizeTags(inputTags, { enforceLimits: false });
    if (tagsEqual(normalizedWithoutLimits, current)) {
      return current;
    }
    return normalizeTags(inputTags);
  }

  createWish(title) {
    const now = this.now();
    const normalized = requiredTitle(title, '愿望描述');
    return this.repository.transaction((database) => {
      const wish = { id: createId('wish', now), title: normalized, createdAt: now, updatedAt: now };
      database.wishes.push(wish);
      return wish;
    }).result;
  }

  updateWish(id, title) {
    const now = this.now();
    const normalized = requiredTitle(title, '愿望描述');
    return this.repository.transaction((database) => {
      const wish = this.requireEntity(database.wishes, id, '愿望');
      wish.title = normalized;
      wish.updatedAt = now;
      return wish;
    }).result;
  }

  deleteWish(id, confirmed) {
    if (!confirmed) {
      throw new DomainError('WISH_DELETE_CONFIRMATION_REQUIRED', '删除愿望需要二次确认');
    }
    return this.repository.transaction((database) => {
      const wish = this.requireEntity(database.wishes, id, '愿望');
      database.wishes = database.wishes.filter((item) => item.id !== id);
      return { id: wish.id, title: wish.title };
    }).result;
  }

  createProject(input) {
    const now = this.now();
    const title = requiredTitle(input.title, '项目名称');
    const deadlineAt = Number(input.deadlineAt);
    if (!isFiniteTimestamp(deadlineAt)) {
      throw new DomainError('DEADLINE_INVALID', '请设置有效的项目截止日期');
    }
    return this.repository.transaction((database) => {
      if (this.activeProjects(database).length >= MAX_ACTIVE_PROJECTS) {
        throw new DomainError('ACTIVE_PROJECT_LIMIT', `要保持专注，别贪多了~`);
      }
      const project = {
        id: createId('project', now),
        title,
        deadlineAt,
        status: PROJECT_STATUS.ACTIVE,
        createdAt: now,
        updatedAt: now
      };
      database.projects.push(project);
      return project;
    }).result;
  }

  validateWishToProject(wishId) {
    const wish = this.requireWishToProjectConversion(this.snapshot(), wishId);
    return { id: wish.id, title: wish.title };
  }

  convertWishToProject(wishId) {
    const now = this.now();
    return this.repository.transaction((database) => {
      const wish = this.requireWishToProjectConversion(database, wishId);
      const project = {
        id: createId('project', now),
        title: wish.title,
        deadlineAt: now + 24 * 60 * 60 * 1000,
        status: PROJECT_STATUS.ACTIVE,
        createdAt: now,
        updatedAt: now
      };
      database.projects.push(project);
      database.wishes = database.wishes.filter((item) => item.id !== wishId);
      return project;
    }).result;
  }

  updateProject(id, input) {
    const now = this.now();
    return this.repository.transaction((database) => {
      const project = this.requireEntity(database.projects, id, '项目');
      if (input.title !== undefined) {
        project.title = requiredTitle(input.title, '项目名称');
      }
      if (input.deadlineAt !== undefined) {
        if (!isFiniteTimestamp(Number(input.deadlineAt))) {
          throw new DomainError('DEADLINE_INVALID', '请设置有效的项目截止日期');
        }
        project.deadlineAt = Number(input.deadlineAt);
      }
      project.updatedAt = now;
      return project;
    }).result;
  }

  setProjectArchived(id, archived) {
    const now = this.now();
    return this.repository.transaction((database) => {
      const project = this.requireEntity(database.projects, id, '项目');
      project.status = archived ? PROJECT_STATUS.ARCHIVED : PROJECT_STATUS.ACTIVE;
      if (!archived && this.activeProjects(database).length > MAX_ACTIVE_PROJECTS) {
        throw new DomainError('ACTIVE_PROJECT_LIMIT', `活动项目最多为 ${MAX_ACTIVE_PROJECTS} 个`);
      }
      project.updatedAt = now;
      return project;
    }).result;
  }

  abandonProject(id, confirmed) {
    if (!confirmed) {
      throw new DomainError('ABANDON_CONFIRMATION_REQUIRED', '放弃项目需要明确确认删除范围');
    }
    const now = this.now();
    return this.repository.transaction((database) => {
      const project = this.requireEntity(database.projects, id, '项目');
      const projectTasks = database.tasks.filter((task) => task.projectId === id);
      const projectTaskIds = projectTasks.map((task) => task.id);
      const deletingTasks = projectTasks
        .filter((task) => task.status !== TASK_STATUS.COMPLETED);
      const deletingTaskIds = deletingTasks.map((task) => task.id);
      const relatedEvents = database.calendarEvents
        .filter((event) => projectTaskIds.includes(event.taskId));
      const relatedEventIds = relatedEvents.map((event) => event.id);
      const deletedEvents = relatedEvents.filter((event) => event.endedAt > now);
      const deletedEventIds = deletedEvents.map((event) => event.id);
      const deletedRules = database.repeatRules
        .filter((rule) => rule.revisions.some(
          (revision) => projectTaskIds.includes(revision.taskId)
        ));
      const deletedRuleIds = deletedRules.map((rule) => rule.id);
      const invalidatedDraftEvents = relatedEvents.filter((event) => (
        deletedEventIds.includes(event.id)
        || deletingTaskIds.includes(event.taskId)
      ));

      this.detachAbandonedProjectDraftReferences(
        database.timer && database.timer.draft,
        project,
        deletingTasks,
        invalidatedDraftEvents,
        deletedRules
      );
      if (database.recoveryDraft && database.recoveryDraft.timer) {
        this.detachAbandonedProjectDraftReferences(
          database.recoveryDraft.timer.draft,
          project,
          deletingTasks,
          invalidatedDraftEvents,
          deletedRules
        );
      }

      database.projects = database.projects.filter((item) => item.id !== id);
      database.tasks = database.tasks.filter((task) => {
        if (deletingTaskIds.includes(task.id)) {
          return false;
        }
        if (task.projectId === id) {
          task.projectNameSnapshot = project.title;
          task.projectId = null;
          task.updatedAt = now;
        }
        return true;
      });
      database.calendarEvents = database.calendarEvents.filter((event) => {
        if (deletedEventIds.includes(event.id)) {
          return false;
        }
        let changed = false;
        if (event.projectId === id) {
          event.projectNameSnapshot = event.projectNameSnapshot || project.title;
          event.projectId = null;
          changed = true;
        }
        if (relatedEventIds.includes(event.id)) {
          if (!event.projectNameSnapshot) {
            event.projectNameSnapshot = project.title;
            changed = true;
          }
          if (deletingTaskIds.includes(event.taskId)) {
            const task = deletingTasks.find((item) => item.id === event.taskId);
            event.taskNameSnapshot = event.taskNameSnapshot || (task ? task.title : '已删除任务');
            event.taskId = null;
            changed = true;
          }
        }
        if (changed) event.updatedAt = now;
        return true;
      });
      database.repeatRules = database.repeatRules.filter((rule) => !deletedRuleIds.includes(rule.id));
      database.repeatRules.forEach((rule) => {
        let changed = false;
        rule.revisions.forEach((revision) => {
          if (revision.projectId === id) {
            revision.projectNameSnapshot = revision.projectNameSnapshot || project.title;
            revision.projectId = null;
            changed = true;
          }
        });
        if (changed) rule.updatedAt = now;
      });
      database.occurrenceExceptions = database.occurrenceExceptions
        .filter((item) => !deletedRuleIds.includes(item.ruleId));
      database.timeLogs = database.timeLogs.filter((log) => {
        const related = relatedEventIds.includes(log.calendarEventId)
          || deletedRuleIds.includes(log.originRuleId);
        if (related && log.status === LOG_STATUS.CANDIDATE) {
          return false;
        }
        let changed = false;
        if (log.projectId === id) {
          log.projectNameSnapshot = log.projectNameSnapshot || project.title;
          log.projectId = null;
          changed = true;
        }
        if (deletingTaskIds.includes(log.taskId)) {
          const task = deletingTasks.find((item) => item.id === log.taskId);
          log.taskNameSnapshot = log.taskNameSnapshot || (task ? task.title : '已删除任务');
          log.taskId = null;
          changed = true;
        }
        if (deletedEventIds.includes(log.calendarEventId)) {
          const event = deletedEvents.find((item) => item.id === log.calendarEventId);
          changed = this.detachCalendarEventReference(log, event) || changed;
        }
        if (deletedRuleIds.includes(log.originRuleId)) {
          const rule = deletedRules.find((item) => item.id === log.originRuleId);
          changed = this.detachRepeatRuleReference(log, rule) || changed;
        }
        if (changed) log.updatedAt = now;
        return true;
      });
      return { projectTitle: project.title, deletedTaskCount: deletingTaskIds.length, deletedEventCount: deletedEventIds.length };
    }).result;
  }

  createTask(input) {
    const now = this.now();
    const title = requiredTitle(input.title, '任务标题');
    return this.repository.transaction((database) => {
      const association = input.projectId ? this.resolveAssociations(database, input) : {};
      return this.createTaskRecord(database, title, now, association);
    }).result;
  }

  updateTask(id, input) {
    const inputFields = Object.keys(input);
    if (inputFields.length === 1 && input.status === TASK_STATUS.COMPLETED) {
      const task = this.requireEntity(this.snapshot().tasks, id, '任务');
      if (task.status === TASK_STATUS.COMPLETED) return task;
    }
    const now = this.now();
    return this.repository.transaction((database) => {
      const task = this.requireEntity(database.tasks, id, '任务');
      if (input.title !== undefined) {
        task.title = requiredTitle(input.title, '任务标题');
      }
      if (input.projectId !== undefined) {
        const association = input.projectId ? this.resolveAssociations(database, input) : { projectId: null, projectNameSnapshot: null };
        task.projectId = association.projectId;
        task.projectNameSnapshot = association.projectNameSnapshot;
      }
      if (input.status !== undefined) {
        const nextStatus = this.requireTaskStatus(input.status);
        if (nextStatus === TASK_STATUS.COMPLETED && task.status !== TASK_STATUS.COMPLETED) {
          task.completedAt = now;
        } else if (nextStatus === TASK_STATUS.TODO) {
          task.completedAt = null;
        }
        task.status = nextStatus;
      }
      task.updatedAt = now;
      return task;
    }).result;
  }

  deleteTask(id, confirmed) {
    if (confirmed !== true) {
      throw new DomainError('TASK_DELETE_CONFIRMATION_REQUIRED', '删除任务需要二次确认');
    }
    const now = this.now();
    return this.repository.transaction((database) => {
      const task = this.requireEntity(database.tasks, id, '任务');
      const taskEvents = database.calendarEvents.filter((event) => event.taskId === id);
      const deletedEvents = taskEvents.filter((event) => event.endedAt > now);
      const deletedEventIds = deletedEvents.map((event) => event.id);
      const deletedRules = database.repeatRules
        .filter((rule) => rule.revisions.some((revision) => revision.taskId === id));
      const deletedRuleIds = deletedRules.map((rule) => rule.id);
      database.calendarEvents = database.calendarEvents.filter((event) => {
        if (deletedEventIds.includes(event.id)) return false;
        let changed = this.detachTaskReference(event, task);
        if (changed) event.updatedAt = now;
        return true;
      });
      database.repeatRules = database.repeatRules.filter((rule) => !deletedRuleIds.includes(rule.id));
      database.occurrenceExceptions = database.occurrenceExceptions.filter((exception) => !deletedRuleIds.includes(exception.ruleId));
      database.timeLogs.forEach((log) => {
        let changed = this.detachTaskReference(log, task);
        if (log.calendarEventId && deletedEventIds.includes(log.calendarEventId)) {
          log.calendarEventSummarySnapshot = log.calendarEventSummarySnapshot || '已删除计划';
          log.calendarEventId = null;
          changed = true;
        }
        if (log.originRuleId && deletedRuleIds.includes(log.originRuleId)) {
          log.originRuleSummarySnapshot = log.originRuleSummarySnapshot || '已删除重复规则';
          log.originRuleId = null;
          changed = true;
        }
        if (changed) log.updatedAt = now;
      });
      this.detachTaskReference(database.timer.draft, task);
      taskEvents.forEach((event) => this.detachCalendarEventReference(database.timer.draft, event));
      deletedRules.forEach((rule) => this.detachRepeatRuleReference(
        database.timer.draft,
        rule,
        { clearOriginOccurrence: true }
      ));
      if (database.recoveryDraft && database.recoveryDraft.timer) {
        this.detachTaskReference(database.recoveryDraft.timer.draft, task);
        taskEvents.forEach((event) => this.detachCalendarEventReference(database.recoveryDraft.timer.draft, event));
        deletedRules.forEach((rule) => this.detachRepeatRuleReference(
          database.recoveryDraft.timer.draft,
          rule,
          { clearOriginOccurrence: true }
        ));
      }
      database.tasks = database.tasks.filter((item) => item.id !== id);
      return { id: task.id, title: task.title };
    }).result;
  }

  createCalendarEvent(input) {
    const now = this.now();
    this.rejectDirectPlanProject(input);
    const title = requiredTitle(input.title, '计划标题');
    const startedAt = Number(input.startedAt);
    const endedAt = Number(input.endedAt);
    validTimeRange(startedAt, endedAt, '计划时间');
    return this.repository.transaction((database) => {
      const association = this.resolvePlanTaskAssociation(database, input.taskId);
      const event = createCalendarEvent({ ...input, ...association, title, startedAt, endedAt, priority: validPriority(input.priority) }, now);
      database.calendarEvents.push(event);
      this.reconcileTaskPlanStatuses(database, now, [event.taskId]);
      return event;
    }).result;
  }

  createCalendarEventWithNewTask(input) {
    const now = this.now();
    this.rejectDirectPlanProject(input);
    const title = requiredTitle(input.title, '计划标题');
    const startedAt = Number(input.startedAt);
    const endedAt = Number(input.endedAt);
    validTimeRange(startedAt, endedAt, '计划时间');
    return this.repository.transaction((database) => {
      const taskAssociation = this.resolveActiveTaskProjectAssociation(database, input.taskProjectId);
      const task = this.createPlanTaskFromTitle(database, title, now, taskAssociation);
      const association = this.resolvePlanTaskAssociation(database, task.id);
      const event = createCalendarEvent({
        ...input,
        ...association,
        title,
        startedAt,
        endedAt,
        priority: validPriority(input.priority)
      }, now);
      database.calendarEvents.push(event);
      this.reconcileTaskPlanStatuses(database, now, [task.id]);
      return { task, event };
    }).result;
  }

  updateCalendarEvent(id, input) {
    const now = this.now();
    this.rejectDirectPlanProject(input);
    return this.repository.transaction((database) => {
      const event = this.requireEntity(database.calendarEvents, id, '计划块');
      const previousTaskId = event.taskId;
      const eventTaskExists = event.taskId
        && database.tasks.some((task) => task.id === event.taskId);
      if (!eventTaskExists && event.endedAt <= now) {
        throw new DomainError(
          'CALENDAR_EVENT_READ_ONLY',
          '历史计划块关联的任务已失效，只能查看，不能编辑'
        );
      }
      const startedAt = input.startedAt === undefined ? event.startedAt : Number(input.startedAt);
      const endedAt = input.endedAt === undefined ? event.endedAt : Number(input.endedAt);
      validTimeRange(startedAt, endedAt, '计划时间');
      const association = this.resolvePlanTaskAssociation(
        database,
        input.taskId === undefined ? event.taskId : input.taskId
      );
      event.title = input.title === undefined ? event.title : requiredTitle(input.title, '计划标题');
      event.startedAt = startedAt;
      event.endedAt = endedAt;
      event.priority = input.priority === undefined ? event.priority : validPriority(input.priority);
      event.projectId = association.projectId;
      event.projectNameSnapshot = association.projectNameSnapshot;
      event.taskId = association.taskId;
      event.taskNameSnapshot = association.taskNameSnapshot;
      event.updatedAt = now;
      this.reconcileTaskPlanStatuses(database, now, [previousTaskId, event.taskId]);
      return event;
    }).result;
  }

  enableRecurringForCalendarEvent(id, input) {
    const now = this.now();
    this.rejectDirectPlanProject(input);
    const title = requiredTitle(input.title, '固定日程标题');
    const startedAt = Number(input.startedAt);
    const endedAt = Number(input.endedAt);
    validTimeRange(startedAt, endedAt, '固定日程时间');
    const priority = validPriority(input.priority);
    const pattern = canonicalizeRepeatPattern(input);
    return this.repository.transaction((database) => {
      const event = this.requireEntity(database.calendarEvents, id, '计划块');
      const previousTaskId = event.taskId;
      const eventTaskExists = event.taskId
        && database.tasks.some((task) => task.id === event.taskId);
      if (!eventTaskExists && event.endedAt <= now) {
        throw new DomainError(
          'CALENDAR_EVENT_READ_ONLY',
          '历史计划块关联的任务已失效，只能查看，不能编辑'
        );
      }
      const association = this.resolvePlanTaskAssociation(
        database,
        input.taskId === undefined ? event.taskId : input.taskId
      );
      const originalEventPreserved = this.calendarEventHasExecutionReferences(database, event.id);
      const rule = createRepeatRule({
        ...input,
        ...association,
        title,
        startedAt,
        endedAt,
        priority,
        ...pattern
      }, now);

      event.title = title;
      event.startedAt = startedAt;
      event.endedAt = endedAt;
      event.priority = priority;
      event.projectId = association.projectId;
      event.projectNameSnapshot = association.projectNameSnapshot;
      event.taskId = association.taskId;
      event.taskNameSnapshot = association.taskNameSnapshot;
      event.updatedAt = now;
      if (!originalEventPreserved) {
        database.calendarEvents = database.calendarEvents.filter((item) => item.id !== event.id);
      }
      database.repeatRules.push(rule);
      this.reconcileTaskPlanStatuses(database, now, [previousTaskId, association.taskId]);
      return {
        event: originalEventPreserved ? event : null,
        rule,
        occurrence: firstRuleOccurrence(rule),
        originalEventPreserved
      };
    }).result;
  }

  deleteCalendarEvent(id, confirmed) {
    if (!confirmed) {
      throw new DomainError('DELETE_CONFIRMATION_REQUIRED', '删除计划块需要二次确认');
    }
    const now = this.now();
    return this.repository.transaction((database) => {
      const event = this.requireEntity(database.calendarEvents, id, '计划块');
      const affectedTaskId = event.taskId;
      database.calendarEvents = database.calendarEvents.filter((item) => item.id !== id);
      database.timeLogs.forEach((log) => {
        if (log.calendarEventId !== id) return;
        log.calendarEventSummarySnapshot = log.calendarEventSummarySnapshot || event.title;
        log.calendarEventId = null;
        log.updatedAt = now;
      });
      this.detachCalendarEventReference(database.timer && database.timer.draft, event);
      if (database.recoveryDraft && database.recoveryDraft.timer) {
        this.detachCalendarEventReference(database.recoveryDraft.timer.draft, event);
      }
      this.reconcileTaskPlanStatuses(database, now, [affectedTaskId]);
      return { id };
    }).result;
  }

  createRecurringPlan(input) {
    const now = this.now();
    this.rejectDirectPlanProject(input);
    const title = requiredTitle(input.title, '固定日程标题');
    const startedAt = Number(input.startedAt);
    const endedAt = Number(input.endedAt);
    validTimeRange(startedAt, endedAt, '固定日程时间');
    const pattern = canonicalizeRepeatPattern(input);
    return this.repository.transaction((database) => {
      const association = this.resolvePlanTaskAssociation(database, input.taskId);
      const rule = createRepeatRule({
        ...input,
        ...association,
        title,
        startedAt,
        endedAt,
        priority: validPriority(input.priority),
        ...pattern
      }, now);
      database.repeatRules.push(rule);
      this.reconcileTaskPlanStatuses(database, now, [association.taskId]);
      return { rule, occurrence: firstRuleOccurrence(rule) };
    }).result;
  }

  createRecurringPlanWithNewTask(input) {
    const now = this.now();
    this.rejectDirectPlanProject(input);
    const title = requiredTitle(input.title, '固定日程标题');
    const startedAt = Number(input.startedAt);
    const endedAt = Number(input.endedAt);
    validTimeRange(startedAt, endedAt, '固定日程时间');
    const pattern = canonicalizeRepeatPattern(input);
    return this.repository.transaction((database) => {
      const taskAssociation = this.resolveActiveTaskProjectAssociation(database, input.taskProjectId);
      const task = this.createPlanTaskFromTitle(database, title, now, taskAssociation);
      const association = this.resolvePlanTaskAssociation(database, task.id);
      const rule = createRepeatRule({
        ...input,
        ...association,
        title,
        startedAt,
        endedAt,
        priority: validPriority(input.priority),
        ...pattern
      }, now);
      database.repeatRules.push(rule);
      this.reconcileTaskPlanStatuses(database, now, [task.id]);
      return { task, rule, occurrence: firstRuleOccurrence(rule) };
    }).result;
  }

  canEditRuleFollowing(ruleId, occurrenceStart, snapshot = null) {
    const database = snapshot || this.snapshot();
    const boundary = Number(occurrenceStart);
    if (!isFiniteTimestamp(boundary)) return false;
    const rule = database.repeatRules.find((item) => item.id === ruleId);
    if (!rule || !this.projectedRuleOccurrence(database, rule, boundary)) return false;
    return !this.ruleFollowingHasExecutionReferences(database, rule.id, boundary);
  }

  editRuleFollowing(ruleId, occurrenceStart, input) {
    const now = this.now();
    this.rejectDirectPlanProject(input);
    const boundary = Number(occurrenceStart);
    if (!isFiniteTimestamp(boundary)) {
      throw new DomainError('OCCURRENCE_NOT_FOUND', '找不到需要编辑的重复实例');
    }
    const title = requiredTitle(input.title, '固定日程标题');
    const startedAt = Number(input.startedAt);
    const endedAt = Number(input.endedAt);
    validTimeRange(startedAt, endedAt, '固定日程时间');
    if (localDayStart(startedAt) < localDayStart(boundary)) {
      throw new DomainError(
        'RULE_EDIT_START_BEFORE_BOUNDARY',
        '编辑后的开始日期不能早于所选固定日程'
      );
    }
    const priority = validPriority(input.priority);
    const pattern = canonicalizeRepeatPattern(input);

    return this.repository.transaction((database) => {
      const rule = this.requireEntity(database.repeatRules, ruleId, '重复规则');
      const occurrence = this.projectedRuleOccurrence(database, rule, boundary);
      if (!occurrence) {
        throw new DomainError('OCCURRENCE_NOT_FOUND', '找不到需要编辑的重复实例');
      }
      if (this.ruleFollowingHasExecutionReferences(database, rule.id, boundary)) {
        throw new DomainError(
          'RULE_FOLLOWING_HAS_EXECUTION_REFERENCES',
          '本次及后续已有记录或计时关联，不能编辑固定日程'
        );
      }

      const previousRevision = rule.revisions[0];
      const previousTaskIds = (rule.revisions || []).map((revision) => revision.taskId);
      const association = this.resolvePlanTaskAssociation(database, input.taskId);
      const hasPastOccurrence = projectRule(
        rule,
        previousRevision.effectiveFrom,
        boundary - 1,
        []
      ).length > 0;

      if (hasPastOccurrence) {
        previousRevision.effectiveUntil = boundary - 1;
        rule.updatedAt = now;
      } else {
        database.repeatRules = database.repeatRules.filter((item) => item.id !== rule.id);
      }
      database.occurrenceExceptions = database.occurrenceExceptions.filter((item) => (
        item.ruleId !== rule.id || item.occurrenceStart < boundary
      ));

      const nextRule = createRepeatRule({
        ...input,
        ...association,
        title,
        startedAt,
        endedAt,
        priority,
        ...pattern
      }, now);
      database.repeatRules.push(nextRule);
      this.reconcileTaskPlanStatuses(
        database,
        now,
        previousTaskIds.concat(association.taskId)
      );
      return {
        previousRuleId: rule.id,
        occurrenceStart: boundary,
        removedPreviousRule: !hasPastOccurrence,
        rule: nextRule,
        occurrence: firstRuleOccurrence(nextRule)
      };
    }).result;
  }

  skipOccurrence(ruleId, occurrenceStart) {
    const now = this.now();
    return this.repository.transaction((database) => {
      const rule = this.requireEntity(database.repeatRules, ruleId, '重复规则');
      const occurrence = projectRule(
        rule,
        occurrenceStart,
        occurrenceStart,
        database.occurrenceExceptions
      ).find((item) => item.occurrenceStart === occurrenceStart);
      if (!occurrence) {
        throw new DomainError('OCCURRENCE_NOT_FOUND', '找不到需要跳过的重复实例');
      }
      if (!occurrence.taskId || !database.tasks.some((task) => task.id === occurrence.taskId)) {
        throw new DomainError(
          'OCCURRENCE_TASK_UNAVAILABLE',
          '该重复实例没有有效任务，不能写入跳过标记'
        );
      }
      database.occurrenceExceptions = database.occurrenceExceptions.filter((item) => !(item.ruleId === ruleId && item.occurrenceStart === occurrenceStart));
      const exception = createSkipOccurrenceException(ruleId, occurrenceStart, now);
      database.occurrenceExceptions.push(exception);
      return exception;
    }).result;
  }

  deleteRuleFollowing(ruleId, occurrenceStart, confirmed) {
    if (confirmed !== true) {
      throw new DomainError(
        'RULE_DELETE_CONFIRMATION_REQUIRED',
        '删除本次及后续需要二次确认'
      );
    }
    const now = this.now();
    return this.repository.transaction((database) => {
      const rule = this.requireEntity(database.repeatRules, ruleId, '重复规则');
      const affectedTaskIds = (rule.revisions || []).map((revision) => revision.taskId);
      const occurrence = projectRule(
        rule,
        occurrenceStart,
        occurrenceStart,
        database.occurrenceExceptions
      ).find((item) => item.occurrenceStart === occurrenceStart);
      if (!occurrence) {
        throw new DomainError('OCCURRENCE_NOT_FOUND', '找不到需要删除的重复实例');
      }

      const revision = rule.revisions[0];
      const hasPastOccurrence = projectRule(
        rule,
        revision.effectiveFrom,
        occurrenceStart - 1,
        []
      ).length > 0;

      if (hasPastOccurrence) {
        revision.effectiveUntil = occurrenceStart - 1;
        rule.updatedAt = now;
      } else {
        database.repeatRules = database.repeatRules.filter((item) => item.id !== rule.id);
      }

      database.occurrenceExceptions = database.occurrenceExceptions.filter((item) => (
        item.ruleId !== rule.id
        || (hasPastOccurrence && item.occurrenceStart < occurrenceStart)
      ));

      database.timeLogs.forEach((log) => {
        if (!this.originReferenceStartsAtOrAfter(log, rule.id, occurrenceStart)) return;
        this.detachRepeatRuleReference(log, rule);
        log.updatedAt = now;
      });

      const detachActiveDraft = (draft) => {
        if (!this.originReferenceStartsAtOrAfter(draft, rule.id, occurrenceStart)) return;
        this.detachRepeatRuleReference(draft, rule, { clearOriginOccurrence: true });
      };
      detachActiveDraft(database.timer && database.timer.draft);
      detachActiveDraft(database.recoveryDraft && database.recoveryDraft.timer
        && database.recoveryDraft.timer.draft);

      this.reconcileTaskPlanStatuses(database, now, affectedTaskIds);
      return { ruleId, occurrenceStart, removedRule: !hasPastOccurrence };
    }).result;
  }

  planAssociationCandidates(rangeStart, rangeEnd) {
    const database = this.snapshot();
    const validTaskIds = new Set(database.tasks.map((task) => task.id));
    const concreteEvents = database.calendarEvents
      .filter((event) => event.taskId && validTaskIds.has(event.taskId))
      .filter((event) => intervalIntersectsRange(event, rangeStart, rangeEnd))
      .map((event) => ({ ...event, type: 'plan', virtual: false }));
    const recurringOccurrences = database.repeatRules
      .flatMap((rule) => projectRuleIntersectingRange(
        rule,
        rangeStart,
        rangeEnd,
        database.occurrenceExceptions
      ))
      .filter((item) => item.taskId && validTaskIds.has(item.taskId));
    return concreteEvents
      .concat(recurringOccurrences)
      .sort((first, second) => first.startedAt - second.startedAt);
  }

  timeline(rangeStart, rangeEnd) {
    const database = this.snapshot();
    const validTaskIds = new Set(database.tasks.map((task) => task.id));
    const materializedLogicalOccurrences = new Set(database.timeLogs
      .map((log) => logicalOccurrenceKey(log.originRuleId, log.originOccurrenceId))
      .filter(Boolean));
    const eventEntries = database.calendarEvents
      .filter((event) => intervalIntersectsRange(event, rangeStart, rangeEnd))
      .map((event) => ({ ...event, type: 'plan', virtual: false }));
    const rangedLogs = database.timeLogs
      .filter((log) => intervalIntersectsRange(log, rangeStart, rangeEnd));
    const overlapMetadata = buildTimeLogOverlapMetadata(rangedLogs);
    const logEntries = rangedLogs.map((log) => {
      const overlapMeta = overlapMetadata.get(log.id);
      return {
        ...log,
        type: log.status,
        title: displayLogTitle(log),
        virtual: false,
        ...(overlapMeta ? { overlapMeta } : {})
      };
    });
    const virtualEntries = database.repeatRules
      .flatMap((rule) => projectRuleIntersectingRange(
        rule,
        rangeStart,
        rangeEnd,
        database.occurrenceExceptions
      ))
      .filter((item) => item.taskId && validTaskIds.has(item.taskId))
      .filter((item) => !database.timeLogs.some((log) => (
        log.originRuleId === item.ruleId
        && log.originOccurrenceId === item.originOccurrenceId
      )))
      .filter((item) => !materializedLogicalOccurrences.has(occurrenceKey(
        item.ruleId,
        item.occurrenceStart
      )));
    return eventEntries.concat(logEntries, virtualEntries).sort((first, second) => first.startedAt - second.startedAt);
  }

  confirmVirtualOccurrence(input) {
    const now = this.now();
    return this.repository.transaction((database) => (
      this.confirmVirtualOccurrenceInDatabase(database, input, now)
    )).result;
  }

  confirmVirtualOccurrenceInDatabase(database, input, now) {
    const rule = this.requireEntity(database.repeatRules, input.ruleId, '重复规则');
    const occurrenceStart = input.occurrenceStart === undefined
      ? (logicalOccurrenceStart(input.ruleId, input.originOccurrenceId) || input.startedAt)
      : input.occurrenceStart;
    const occurrence = projectRule(rule, occurrenceStart, occurrenceStart, database.occurrenceExceptions)
      .find((item) => item.originOccurrenceId === input.originOccurrenceId);
    if (!occurrence) {
      throw new DomainError('OCCURRENCE_NOT_FOUND', '该重复实例已跳过、已修改或不再有效');
    }
    if (activeTimerMatchesOccurrence(database, rule.id, occurrence.originOccurrenceId)) {
      throw new DomainError('OCCURRENCE_TIMER_ACTIVE', '该计划已经在计时了');
    }
    if (occurrence.startedAt > now) {
      throw new DomainError('PLAN_NOT_STARTED', '计划尚未开始，暂不能确认完成');
    }
    const occurrenceLogicalKey = occurrenceKey(rule.id, occurrence.occurrenceStart);
    if (database.timeLogs.some((log) => (
      log.originRuleId === rule.id
      && (
        log.originOccurrenceId === occurrence.originOccurrenceId
        || logicalOccurrenceKey(log.originRuleId, log.originOccurrenceId) === occurrenceLogicalKey
      )
    ))) {
      throw new DomainError('OCCURRENCE_ALREADY_CONFIRMED', '该重复实例已确认，不能重复生成记录');
    }
    const association = this.resolveNewRecordAssociations(database, {
      originRuleId: rule.id,
      originOccurrenceId: occurrence.originOccurrenceId
    });
    const log = createTimeLog({
      ...association,
      startedAt: occurrence.startedAt,
      endedAt: occurrence.endedAt,
      durationMinutes: calculateLogDurationMinutes(occurrence.startedAt, occurrence.endedAt, []),
      note: input.note || occurrence.title,
      status: LOG_STATUS.CONFIRMED,
      source: LOG_SOURCE.RULE,
      originRuleId: rule.id,
      originOccurrenceId: occurrence.originOccurrenceId,
      originRuleSummarySnapshot: rule.title,
      tags: input.tags
    }, now);
    database.timeLogs.push(log);
    this.reconcileTaskPlanStatuses(database, now, this.taskIdsForRecord(database, log));
    return log;
  }

  createManualLog(input) {
    const now = this.now();
    const startedAt = Number(input.startedAt);
    const endedAt = Number(input.endedAt);
    validTimeRange(startedAt, endedAt, '手工补录时间', { allowSameTime: true });
    return this.repository.transaction((database) => {
      const association = this.resolveNewRecordAssociations(database, input);
      const log = createTimeLog({
        ...association,
        startedAt,
        endedAt,
        pausedDurationSeconds: input.pausedDurationSeconds === undefined
          ? 0
          : input.pausedDurationSeconds,
        note: input.note || '',
        tags: input.tags,
        status: LOG_STATUS.CONFIRMED,
        source: LOG_SOURCE.MANUAL
      }, now);
      database.timeLogs.push(log);
      this.reconcileTaskPlanStatuses(database, now, this.taskIdsForRecord(database, log));
      return { log };
    }).result;
  }

  updateLog(id, input) {
    const now = this.now();
    return this.repository.transaction((database) => {
      const log = this.requireEntity(database.timeLogs, id, '时间记录');
      const affectedTaskIds = new Set(this.taskIdsForRecord(database, log));
      const startedAt = input.startedAt === undefined ? log.startedAt : Number(input.startedAt);
      const endedAt = input.endedAt === undefined ? log.endedAt : Number(input.endedAt);
      validTimeRange(startedAt, endedAt, '记录时间', { allowSameTime: true });
      const pausedDurationSeconds = input.pausedDurationSeconds === undefined
        ? log.pausedDurationSeconds
        : input.pausedDurationSeconds;
      const timing = validLogTiming(startedAt, endedAt, pausedDurationSeconds);
      const association = this.resolveRecordUpdateAssociations(database, log, input);
      const tags = this.resolveUpdatedTags(log.tags, input.tags);
      Object.assign(log, association, {
        startedAt,
        endedAt,
        pausedDurationSeconds,
        durationMinutes: timing.durationMinutes,
        note: input.note === undefined ? log.note : input.note,
        tags,
        status: log.status === LOG_STATUS.CANDIDATE ? LOG_STATUS.CONFIRMED : log.status,
        updatedAt: now
      });
      this.taskIdsForRecord(database, log).forEach((taskId) => affectedTaskIds.add(taskId));
      this.reconcileTaskPlanStatuses(database, now, Array.from(affectedTaskIds));
      return { log };
    }).result;
  }

  confirmCandidateLog(id) {
    const now = this.now();
    return this.repository.transaction((database) => {
      const log = this.requireEntity(database.timeLogs, id, '候选记录');
      if (log.status !== LOG_STATUS.CANDIDATE) {
        throw new DomainError('LOG_NOT_CANDIDATE', '只有候选记录可以核实');
      }
      const association = this.resolveRecordUpdateAssociations(database, log, {});
      if (association.originRuleId && !association.originOccurrenceId) {
        association.originRuleId = null;
      }
      Object.assign(log, association, {
        status: LOG_STATUS.CONFIRMED,
        updatedAt: now
      });
      this.reconcileTaskPlanStatuses(database, now, this.taskIdsForRecord(database, log));
      return log;
    }).result;
  }

  deleteLog(id, confirmed) {
    if (!confirmed) {
      throw new DomainError('DELETE_CONFIRMATION_REQUIRED', '删除时间记录需要二次确认');
    }
    const now = this.now();
    return this.repository.transaction((database) => {
      const log = this.requireEntity(database.timeLogs, id, '时间记录');
      const affectedTaskIds = this.taskIdsForRecord(database, log);
      database.timeLogs = database.timeLogs.filter((item) => item.id !== id);
      this.reconcileTaskPlanStatuses(database, now, affectedTaskIds);
      return { id };
    }, { updatedAt: now }).result;
  }

  startTimer(input = {}) {
    const now = this.now();
    return this.repository.transaction(
      (database) => this.startTimerInDatabase(database, input, now),
      { updatedAt: now }
    ).result;
  }

  updateTimerDraft(input) {
    return this.repository.transaction((database) => {
      if (database.timer.status === TIMER_STATUS.IDLE) {
        throw new DomainError('TIMER_NOT_ACTIVE', '没有可编辑的计时记录');
      }
      const association = this.resolveRecordUpdateAssociations(database, database.timer.draft, input);
      const tags = this.resolveUpdatedTags(database.timer.draft.tags, input.tags);
      database.timer.draft = {
        ...database.timer.draft,
        ...association,
        note: input.note === undefined ? database.timer.draft.note : input.note,
        tags
      };
      return database.timer;
    }).result;
  }

  pauseTimer() {
    const capturedNow = this.now();
    return this.repository.transaction((database) => {
      if (database.timer.status !== TIMER_STATUS.RUNNING) {
        throw new DomainError('TIMER_NOT_RUNNING', '只有运行中的计时可以暂停');
      }
      const inspection = inspectTimerAt(database.timer, capturedNow);
      if (!inspection.valid) {
        return moveTimerToRecoveryDraft(database, database.timer, capturedNow, inspection.reason);
      }
      database.timer.status = TIMER_STATUS.PAUSED;
      database.timer.pausedAt = capturedNow;
      return database.timer;
    }, { updatedAt: capturedNow }).result;
  }

  resumeTimer() {
    const capturedNow = this.now();
    return this.repository.transaction((database) => {
      if (database.timer.status !== TIMER_STATUS.PAUSED) {
        throw new DomainError('TIMER_NOT_PAUSED', '没有可恢复的暂停计时');
      }
      const inspection = inspectTimerAt(database.timer, capturedNow);
      if (!inspection.valid) {
        return moveTimerToRecoveryDraft(database, database.timer, capturedNow, inspection.reason);
      }
      database.timer.pauses.push({ startedAt: database.timer.pausedAt, endedAt: capturedNow });
      database.timer.status = TIMER_STATUS.RUNNING;
      database.timer.pausedAt = null;
      return database.timer;
    }, { updatedAt: capturedNow }).result;
  }

  finishTimer(input = {}) {
    const capturedNow = this.now();
    return this.repository.transaction((database) => {
      const timer = database.timer;
      if (timer.status === TIMER_STATUS.IDLE) {
        throw new DomainError('TIMER_NOT_ACTIVE', '没有可结束的计时');
      }
      const inspection = inspectTimerAt(timer, capturedNow);
      if (!inspection.valid) {
        return moveTimerToRecoveryDraft(database, timer, capturedNow, inspection.reason);
      }
      const pauses = timer.status === TIMER_STATUS.PAUSED
        ? timer.pauses.concat({ startedAt: timer.pausedAt, endedAt: capturedNow })
        : timer.pauses;
      const pausedDurationSeconds = calculatePausedDurationSeconds(pauses);
      const timing = calculateLogTiming(timer.startedAt, capturedNow, pausedDurationSeconds);
      if (timing.intervalTotalSeconds <= pausedDurationSeconds) {
        return moveTimerToRecoveryDraft(
          database,
          timer,
          capturedNow,
          '暂停时长不小于计时区间，请手工修正并确认记录'
        );
      }
      const association = this.resolveRecordUpdateAssociations(database, timer.draft, input);
      const tags = this.resolveUpdatedTags(timer.draft.tags, input.tags);
      const draft = {
        ...timer.draft,
        ...association,
        note: input.note === undefined ? timer.draft.note : input.note,
        tags
      };
      const log = createTimeLog({
        ...draft,
        startedAt: timer.startedAt,
        endedAt: capturedNow,
        pausedDurationSeconds,
        status: LOG_STATUS.CONFIRMED,
        source: LOG_SOURCE.TIMER
      }, capturedNow, { enforceTagLimits: false });
      database.timeLogs.push(log);
      database.timer = createIdleTimer();
      this.reconcileTaskPlanStatuses(database, capturedNow, this.taskIdsForRecord(database, log));
      return { log };
    }, { updatedAt: capturedNow }).result;
  }

  createRecoveryConfirmedLog(input) {
    const now = this.now();
    const startedAt = Number(input.startedAt);
    const endedAt = Number(input.endedAt);
    validTimeRange(startedAt, endedAt, '恢复记录时间', { allowSameTime: true });
    return this.repository.transaction((database) => {
      const recoveryDraft = database.recoveryDraft;
      if (!recoveryDraft || !recoveryDraft.timer) {
        throw new DomainError('RECOVERY_DRAFT_NOT_FOUND', '没有需要修正的恢复草稿');
      }
      const originalDraft = recoveryDraft.timer.draft || {};
      const association = this.resolveRecordUpdateAssociations(database, originalDraft, input);
      const tags = this.resolveUpdatedTags(originalDraft.tags, input.tags);
      const candidatePreview = recoveryDraft.candidatePreview;
      const keepsCandidatePreviewTiming = Boolean(candidatePreview
        && candidatePreview.source === LOG_SOURCE.TIMER
        && candidatePreview.startedAt === startedAt
        && candidatePreview.endedAt === endedAt);
      const pausedDurationSeconds = input.pausedDurationSeconds === undefined
        ? (keepsCandidatePreviewTiming ? (candidatePreview.pausedDurationSeconds || 0) : 0)
        : input.pausedDurationSeconds;
      const log = createTimeLog({
        ...association,
        startedAt,
        endedAt,
        pausedDurationSeconds,
        note: input.note === undefined ? (originalDraft.note || '') : input.note,
        tags,
        status: LOG_STATUS.CONFIRMED,
        source: LOG_SOURCE.TIMER
      }, now, { enforceTagLimits: false });
      database.timeLogs.push(log);
      database.recoveryDraft = null;
      this.reconcileTaskPlanStatuses(database, now, this.taskIdsForRecord(database, log));
      return log;
    }).result;
  }

  discardRecoveryDraft() {
    return this.repository.transaction((database) => {
      if (!database.recoveryDraft) {
        throw new DomainError('RECOVERY_DRAFT_NOT_FOUND', '没有需要放弃的恢复草稿');
      }
      database.recoveryDraft = null;
      return { discarded: true };
    }).result;
  }

  simulateTimerRecoveryFailureForDebug() {
    const snapshot = this.snapshot();
    if (snapshot.recoveryDraft) {
      throw new DomainError('DEBUG_RECOVERY_DRAFT_EXISTS', '已有待修正的恢复草稿，请先完成修正后再测试');
    }
    if (!snapshot.timer || snapshot.timer.status !== TIMER_STATUS.IDLE) {
      throw new DomainError('DEBUG_TIMER_TEST_REQUIRES_IDLE', '请先结束当前计时，再测试计时失败');
    }

    const now = this.now();
    return this.repository.transaction((database) => {
      const timer = {
        ...createIdleTimer(),
        status: TIMER_STATUS.RUNNING,
        startedAt: now - 10 * 60 * 1_000,
        pausedAt: now,
        draft: {
          note: '开发调试：计时状态异常',
          tags: []
        }
      };
      database.timer = createIdleTimer();
      database.recoveryDraft = {
        reason: '时间戳无法还原，请手工修正并确认记录',
        timer,
        createdAt: now
      };
      return { state: 'draft', recoveryDraft: database.recoveryDraft };
    }).result;
  }

  recoverTimer() {
    const capturedNow = this.now();
    const current = this.snapshot();
    const currentTimer = current.timer;
    if (!currentTimer || currentTimer.status === TIMER_STATUS.IDLE) {
      return { state: 'unchanged', timer: currentTimer };
    }
    const currentInspection = inspectTimerAt(currentTimer, capturedNow);
    if (currentInspection.valid
      && capturedNow - currentTimer.startedAt <= this.recoveryTimerSpanMs) {
      const resolvedDraft = {
        ...currentTimer.draft,
        ...this.resolveRecordUpdateAssociations(current, currentTimer.draft, {})
      };
      if (persistedValueEquals(resolvedDraft, currentTimer.draft)) {
        return { state: 'resumed', timer: currentTimer };
      }
    }
    return this.repository.transaction((database) => {
      const timer = database.timer;
      const inspection = inspectTimerAt(timer, capturedNow);
      if (!inspection.valid) {
        return moveTimerToRecoveryDraft(database, timer, capturedNow, inspection.reason);
      }
      if (capturedNow - timer.startedAt <= this.recoveryTimerSpanMs) {
        timer.draft = {
          ...timer.draft,
          ...this.resolveRecordUpdateAssociations(database, timer.draft, {})
        };
        return { state: 'resumed', timer };
      }
      const endedAt = timer.startedAt + this.recoveryTimerSpanMs;
      const pauses = timer.pauses.filter((pause) => pause.startedAt < endedAt).map((pause) => ({
        startedAt: pause.startedAt,
        endedAt: Math.min(pause.endedAt, endedAt)
      }));
      if (timer.status === TIMER_STATUS.PAUSED && timer.pausedAt < endedAt) {
        pauses.push({ startedAt: timer.pausedAt, endedAt });
      }
      const pausedDurationSeconds = calculatePausedDurationSeconds(pauses);
      const timing = calculateLogTiming(timer.startedAt, endedAt, pausedDurationSeconds);
      if (timing.intervalTotalSeconds <= pausedDurationSeconds) {
        return moveTimerToRecoveryDraft(
          database,
          timer,
          capturedNow,
          '暂停时长不小于计时区间，请手工修正并确认记录'
        );
      }
      const result = moveTimerToRecoveryDraft(
        database,
        timer,
        capturedNow,
        '计时超过恢复时间窗口，系统已生成候选，请核实后确认记录'
      );
      if (result.timerDiscarded) return result;
      result.recoveryDraft.candidatePreview = {
        startedAt: timer.startedAt,
        endedAt,
        pausedDurationSeconds,
        durationMinutes: timing.durationMinutes,
        source: LOG_SOURCE.TIMER
      };
      return result;
    }, { updatedAt: capturedNow }).result;
  }

  statistics(options) {
    return buildStatistics(this.snapshot(), options);
  }

  exportJson() {
    return exportJson(this.snapshot());
  }
}

module.exports = {
  ApplicationService
};
