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
  createOccurrenceException,
  initialRuleOccurrenceStart,
  intervalIntersectsRange,
  logicalOccurrenceKey,
  logicalOccurrenceStart,
  occurrenceKey,
  projectRevisionStartedAt,
  projectRule,
  projectRuleIntersectingRange
} = require('../domain/recurrence');
const { buildStatistics } = require('../domain/statistics');
const { normalizeTags, tagsEqual } = require('../domain/tags');
const { calculateDurationMinutes, calculateTimerDurationMinutes, isFiniteTimestamp } = require('../domain/time');
const { requiredTitle, validInterval, validPercentage, validPriority, validRepeatFrequency, validTimeRange } = require('../domain/validation');
const {
  ENTITY_COLLECTIONS,
  IMPORT_MODE,
  createImportAnalysis,
  resolveImportAnalysis
} = require('../repository/json-import');
const { normalizeJsonSnapshot, parseJsonSnapshot, persistedValueEquals } = require('../repository/json-snapshot');
const { exportJson } = require('./export-service');

class ApplicationService {
  constructor(repository, options = {}) {
    this.repository = repository;
    this.now = options.now || Date.now;
    this.exportTempFileStore = options.exportTempFileStore || null;
    this.recoveryTimerSpanMs = Number.isFinite(options.recoveryTimerSpanMs) && options.recoveryTimerSpanMs > 0
      ? options.recoveryTimerSpanMs
      : MAX_TIMER_SPAN_MS;
    this.minimumRecoveryDurationMinutes = Number.isInteger(options.minimumRecoveryDurationMinutes) && options.minimumRecoveryDurationMinutes > 0
      ? options.minimumRecoveryDurationMinutes
      : 0;
    this.pendingJsonImport = null;
  }

  initialize() {
    this.repository.initialize();
    return this.recoverTimer(this.now());
  }

  snapshot() {
    return this.repository.read();
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
    const database = this.repository.reset();
    this.pendingJsonImport = null;
    return {
      cleared: true,
      localProfileId: database.localProfile.id
    };
  }

  activeProjects(database) {
    return database.projects.filter((project) => project.status === PROJECT_STATUS.ACTIVE);
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
    if (target.repeatRuleId === rule.id) {
      target.repeatRuleId = null;
      target.repeatRuleSummarySnapshot = target.repeatRuleSummarySnapshot || rule.title;
      changed = true;
    }
    return changed;
  }

  originReferenceMatchesOccurrence(target, ruleId, occurrenceStart) {
    return Boolean(
      target
      && target.originRuleId === ruleId
      && logicalOccurrenceStart(ruleId, target.originOccurrenceId) === occurrenceStart
    );
  }

  detachOccurrenceReference(target, rule, occurrenceStart, options = {}) {
    if (!this.originReferenceMatchesOccurrence(target, rule.id, occurrenceStart)) {
      return false;
    }
    target.originRuleId = null;
    if (options.clearOriginOccurrence === true) {
      target.originOccurrenceId = null;
    }
    target.originRuleSummarySnapshot = target.originRuleSummarySnapshot || rule.title;
    return true;
  }

  overrideSlotsForTasks(database, taskIds, excludedRuleIds = []) {
    const taskIdSet = new Set(taskIds);
    const excludedRuleIdSet = new Set(excludedRuleIds);
    const rulesById = new Map(database.repeatRules.map((rule) => [rule.id, rule]));
    return database.occurrenceExceptions
      .filter((exception) => (
        exception.kind === 'override'
        && exception.override
        && taskIdSet.has(exception.override.taskId)
        && !excludedRuleIdSet.has(exception.ruleId)
      ))
      .map((exception) => ({
        exception,
        rule: rulesById.get(exception.ruleId)
      }))
      .filter((slot) => slot.rule);
  }

  convertOverrideSlotsToSkips(slots, now) {
    slots.forEach(({ exception }) => {
      exception.kind = 'skip';
      exception.override = null;
      exception.updatedAt = now;
    });
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

  createProject(input) {
    const now = this.now();
    const title = requiredTitle(input.title, '项目名称');
    const deadlineAt = Number(input.deadlineAt);
    if (!isFiniteTimestamp(deadlineAt)) {
      throw new DomainError('DEADLINE_INVALID', '请设置有效的项目截止日期');
    }
    const objectives = this.normalizeObjectives(input.objectives || [], now);
    if (!objectives.length || !objectives.some((objective) => objective.keyResults.length)) {
      throw new DomainError('OKR_REQUIRED', '新建项目至少需要一个包含关键结果的目标');
    }
    return this.repository.transaction((database) => {
      if (this.activeProjects(database).length >= MAX_ACTIVE_PROJECTS) {
        throw new DomainError('ACTIVE_PROJECT_LIMIT', `活动项目最多为 ${MAX_ACTIVE_PROJECTS} 个，请先归档或放弃项目`);
      }
      const project = {
        id: createId('project', now),
        title,
        deadlineAt,
        status: PROJECT_STATUS.ACTIVE,
        objectives,
        createdAt: now,
        updatedAt: now
      };
      database.projects.push(project);
      return project;
    }).result;
  }

  convertWishToProject(wishId) {
    const now = this.now();
    return this.repository.transaction((database) => {
      const wish = this.requireEntity(database.wishes, wishId, '愿望');
      if (this.activeProjects(database).length >= MAX_ACTIVE_PROJECTS) {
        throw new DomainError('ACTIVE_PROJECT_LIMIT', `活动项目最多为 ${MAX_ACTIVE_PROJECTS} 个，请先归档或放弃项目`);
      }
      const project = {
        id: createId('project', now),
        title: wish.title,
        deadlineAt: now + 24 * 60 * 60 * 1000,
        status: PROJECT_STATUS.ACTIVE,
        objectives: [],
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
      if (input.objectives !== undefined) {
        project.objectives = this.normalizeObjectives(input.objectives, now);
      }
      project.updatedAt = now;
      return project;
    }).result;
  }

  normalizeObjectives(objectives, now) {
    return objectives.map((objective) => ({
      id: objective.id || createId('objective', now),
      title: requiredTitle(objective.title, '目标名称'),
      keyResults: (objective.keyResults || []).map((keyResult) => ({
        id: keyResult.id || createId('key-result', now),
        title: requiredTitle(keyResult.title, '关键结果标题'),
        currentValue: validPercentage(keyResult.currentValue, '关键结果当前值')
      }))
    }));
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
      const overrideSlots = this.overrideSlotsForTasks(
        database,
        projectTaskIds,
        deletedRuleIds
      );
      this.convertOverrideSlotsToSkips(overrideSlots, now);
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
      overrideSlots.forEach(({ exception, rule }) => this.detachOccurrenceReference(
        database.timer && database.timer.draft,
        rule,
        exception.occurrenceStart,
        { clearOriginOccurrence: true }
      ));
      if (database.recoveryDraft && database.recoveryDraft.timer) {
        this.detachAbandonedProjectDraftReferences(
          database.recoveryDraft.timer.draft,
          project,
          deletingTasks,
          invalidatedDraftEvents,
          deletedRules
        );
        overrideSlots.forEach(({ exception, rule }) => this.detachOccurrenceReference(
          database.recoveryDraft.timer.draft,
          rule,
          exception.occurrenceStart,
          { clearOriginOccurrence: true }
        ));
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
        if (event.repeatRuleId && deletedRuleIds.includes(event.repeatRuleId)) {
          const rule = deletedRules.find((item) => item.id === event.repeatRuleId);
          event.repeatRuleSummarySnapshot = event.repeatRuleSummarySnapshot
            || (rule ? rule.title : '已删除重复规则');
          event.repeatRuleId = null;
          changed = true;
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
      database.occurrenceExceptions.forEach((exception) => {
        if (exception.override && exception.override.projectId === id) {
          exception.override.projectNameSnapshot = exception.override.projectNameSnapshot
            || project.title;
          exception.override.projectId = null;
          exception.updatedAt = now;
        }
      });
      database.timeLogs = database.timeLogs.filter((log) => {
        const overrideSlot = overrideSlots.find(({ exception, rule }) => (
          this.originReferenceMatchesOccurrence(log, rule.id, exception.occurrenceStart)
        ));
        const related = relatedEventIds.includes(log.calendarEventId)
          || deletedRuleIds.includes(log.originRuleId)
          || Boolean(overrideSlot);
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
        if (overrideSlot) {
          changed = this.detachOccurrenceReference(
            log,
            overrideSlot.rule,
            overrideSlot.exception.occurrenceStart
          ) || changed;
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
    const status = input.status === undefined ? TASK_STATUS.TODO : this.requireTaskStatus(input.status);
    return this.repository.transaction((database) => {
      const association = input.projectId ? this.resolveAssociations(database, input) : {};
      const task = {
        id: createId('task', now),
        title,
        status,
        projectId: association.projectId || null,
        projectNameSnapshot: association.projectNameSnapshot || null,
        completedAt: null,
        createdAt: now,
        updatedAt: now
      };
      database.tasks.unshift(task);
      return task;
    }).result;
  }

  updateTask(id, input) {
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
        task.status = this.requireTaskStatus(input.status);
        task.completedAt = task.status === TASK_STATUS.COMPLETED ? now : null;
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
      const overrideSlots = this.overrideSlotsForTasks(database, [id], deletedRuleIds);
      this.convertOverrideSlotsToSkips(overrideSlots, now);

      database.calendarEvents = database.calendarEvents.filter((event) => {
        if (deletedEventIds.includes(event.id)) return false;
        let changed = this.detachTaskReference(event, task);
        if (event.repeatRuleId && deletedRuleIds.includes(event.repeatRuleId)) {
          event.repeatRuleSummarySnapshot = event.repeatRuleSummarySnapshot || '已删除重复规则';
          event.repeatRuleId = null;
          changed = true;
        }
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
        overrideSlots.forEach(({ exception, rule }) => {
          changed = this.detachOccurrenceReference(
            log,
            rule,
            exception.occurrenceStart
          ) || changed;
        });
        if (changed) log.updatedAt = now;
      });
      this.detachTaskReference(database.timer.draft, task);
      taskEvents.forEach((event) => this.detachCalendarEventReference(database.timer.draft, event));
      deletedRules.forEach((rule) => this.detachRepeatRuleReference(
        database.timer.draft,
        rule,
        { clearOriginOccurrence: true }
      ));
      overrideSlots.forEach(({ exception, rule }) => this.detachOccurrenceReference(
        database.timer.draft,
        rule,
        exception.occurrenceStart,
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
        overrideSlots.forEach(({ exception, rule }) => this.detachOccurrenceReference(
          database.recoveryDraft.timer.draft,
          rule,
          exception.occurrenceStart,
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
      return event;
    }).result;
  }

  updateCalendarEvent(id, input) {
    const now = this.now();
    this.rejectDirectPlanProject(input);
    return this.repository.transaction((database) => {
      const event = this.requireEntity(database.calendarEvents, id, '计划块');
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
      return event;
    }).result;
  }

  deleteCalendarEvent(id, confirmed) {
    if (!confirmed) {
      throw new DomainError('DELETE_CONFIRMATION_REQUIRED', '删除计划块需要二次确认');
    }
    const now = this.now();
    return this.repository.transaction((database) => {
      const event = this.requireEntity(database.calendarEvents, id, '计划块');
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
    const frequency = validRepeatFrequency(input.frequency);
    const interval = validInterval(input.interval);
    return this.repository.transaction((database) => {
      const association = this.resolvePlanTaskAssociation(database, input.taskId);
      const rule = createRepeatRule({
        ...input,
        ...association,
        title,
        startedAt,
        endedAt,
        priority: validPriority(input.priority),
        frequency,
        interval,
        weekdays: (input.weekdays || []).map(Number),
        monthDay: input.monthDay ? Number(input.monthDay) : null
      }, now);
      const event = createCalendarEvent({
        ...association,
        title,
        startedAt,
        endedAt,
        priority: validPriority(input.priority),
        repeatRuleId: rule.id,
        repeatRuleSummarySnapshot: title
      }, now);
      database.repeatRules.push(rule);
      database.calendarEvents.push(event);
      return { rule, event };
    }).result;
  }

  reviseRuleFollowing(ruleId, occurrenceStart, input) {
    const now = this.now();
    this.rejectDirectPlanProject(input);
    return this.repository.transaction((database) => {
      const rule = this.requireEntity(database.repeatRules, ruleId, '重复规则');
      const activeRevision = rule.revisions.find((revision) => revision.effectiveFrom <= occurrenceStart && (!revision.effectiveUntil || revision.effectiveUntil >= occurrenceStart));
      if (!activeRevision) {
        throw new DomainError('OCCURRENCE_NOT_FOUND', '找不到需要修订的重复实例');
      }
      const startedAt = input.startedAt === undefined
        ? projectRevisionStartedAt(activeRevision, occurrenceStart)
        : Number(input.startedAt);
      const originalDuration = activeRevision.endedAt - activeRevision.startedAt;
      const endedAt = input.endedAt === undefined ? startedAt + originalDuration : Number(input.endedAt);
      validTimeRange(startedAt, endedAt, '重复规则时间');
      const replaceActiveRevision = occurrenceStart === activeRevision.effectiveFrom;
      const nextRevision = Math.max(...rule.revisions.map((item) => item.revision)) + 1;
      if (replaceActiveRevision) {
        rule.revisions = rule.revisions.filter((item) => item.id !== activeRevision.id);
      } else {
        activeRevision.effectiveUntil = occurrenceStart - 1;
      }
      const revision = {
        ...activeRevision,
        ...this.resolvePlanTaskAssociation(
          database,
          input.taskId === undefined ? activeRevision.taskId : input.taskId
        ),
        id: createId('revision', now),
        revision: nextRevision,
        effectiveFrom: occurrenceStart,
        effectiveUntil: null,
        frequency: input.frequency === undefined ? activeRevision.frequency : validRepeatFrequency(input.frequency),
        interval: input.interval === undefined ? activeRevision.interval : validInterval(input.interval),
        weekdays: input.weekdays === undefined ? activeRevision.weekdays : input.weekdays.map(Number),
        monthDay: input.monthDay === undefined ? activeRevision.monthDay : Number(input.monthDay),
        startedAt,
        endedAt,
        priority: input.priority === undefined ? activeRevision.priority : validPriority(input.priority)
      };
      rule.revisions.push(revision);
      rule.updatedAt = now;
      return revision;
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
      const exception = createOccurrenceException(ruleId, occurrenceStart, 'skip', null, now);
      database.occurrenceExceptions.push(exception);
      return exception;
    }).result;
  }

  overrideOccurrence(ruleId, occurrenceStart, input) {
    this.rejectDirectPlanProject(input);
    const startedAt = Number(input.startedAt);
    const endedAt = Number(input.endedAt);
    validTimeRange(startedAt, endedAt, '单次修改时间');
    const title = requiredTitle(input.title, '计划标题');
    const priority = validPriority(input.priority);
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
        throw new DomainError('OCCURRENCE_NOT_FOUND', '找不到需要修改的重复实例');
      }
      const taskAssociation = this.resolvePlanTaskAssociation(
        database,
        input.taskId === undefined ? occurrence.taskId : input.taskId
      );
      database.occurrenceExceptions = database.occurrenceExceptions.filter(
        (item) => !(item.ruleId === ruleId && item.occurrenceStart === occurrenceStart)
      );
      const exception = createOccurrenceException(ruleId, occurrenceStart, 'override', {
        title,
        startedAt,
        endedAt,
        priority,
        ...taskAssociation
      }, now);
      database.occurrenceExceptions.push(exception);
      return exception;
    }).result;
  }

  planAssociationCandidates(rangeStart, rangeEnd) {
    const database = this.snapshot();
    const validTaskIds = new Set(database.tasks.map((task) => task.id));
    const repeatRulesById = new Map(database.repeatRules.map((rule) => [rule.id, rule]));
    const materializedEventOccurrences = new Set(database.calendarEvents
      .filter((event) => event.repeatRuleId)
      .map((event) => {
        const occurrenceStart = initialRuleOccurrenceStart(
          repeatRulesById.get(event.repeatRuleId)
        );
        return occurrenceStart === null
          ? null
          : occurrenceKey(event.repeatRuleId, occurrenceStart);
      })
      .filter(Boolean));
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
      .filter((item) => item.taskId && validTaskIds.has(item.taskId))
      .filter((item) => !materializedEventOccurrences.has(occurrenceKey(
        item.ruleId,
        item.occurrenceStart
      )));
    return concreteEvents
      .concat(recurringOccurrences)
      .sort((first, second) => first.startedAt - second.startedAt);
  }

  timeline(rangeStart, rangeEnd) {
    const database = this.snapshot();
    const validTaskIds = new Set(database.tasks.map((task) => task.id));
    const repeatRulesById = new Map(database.repeatRules.map((rule) => [rule.id, rule]));
    const materializedEventOccurrences = new Set(database.calendarEvents
      .filter((event) => event.repeatRuleId)
      .map((event) => {
        const rule = repeatRulesById.get(event.repeatRuleId);
        const occurrenceStart = initialRuleOccurrenceStart(rule);
        return occurrenceStart === null
          ? null
          : occurrenceKey(event.repeatRuleId, occurrenceStart);
      })
      .filter(Boolean));
    const materializedLogicalOccurrences = new Set(database.timeLogs
      .map((log) => logicalOccurrenceKey(log.originRuleId, log.originOccurrenceId))
      .filter(Boolean));
    const eventEntries = database.calendarEvents
      .filter((event) => intervalIntersectsRange(event, rangeStart, rangeEnd))
      .map((event) => ({ ...event, type: 'plan', virtual: false }));
    const logEntries = database.timeLogs
      .filter((log) => intervalIntersectsRange(log, rangeStart, rangeEnd))
      .map((log) => ({ ...log, type: log.status, title: log.taskNameSnapshot || log.note || '时间记录', virtual: false }));
    const virtualEntries = database.repeatRules
      .flatMap((rule) => projectRuleIntersectingRange(
        rule,
        rangeStart,
        rangeEnd,
        database.occurrenceExceptions
      ))
      .filter((item) => item.taskId && validTaskIds.has(item.taskId))
      .filter((item) => !materializedEventOccurrences.has(occurrenceKey(
        item.ruleId,
        item.occurrenceStart
      )))
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
    return this.repository.transaction((database) => {
      const rule = this.requireEntity(database.repeatRules, input.ruleId, '重复规则');
      const occurrenceStart = input.occurrenceStart === undefined
        ? (logicalOccurrenceStart(input.ruleId, input.originOccurrenceId) || input.startedAt)
        : input.occurrenceStart;
      const occurrence = projectRule(rule, occurrenceStart, occurrenceStart, database.occurrenceExceptions)
        .find((item) => item.originOccurrenceId === input.originOccurrenceId);
      if (!occurrence) {
        throw new DomainError('OCCURRENCE_NOT_FOUND', '该重复实例已跳过、已修改或不再有效');
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
        durationMinutes: calculateDurationMinutes(occurrence.startedAt, occurrence.endedAt, []),
        note: input.note || occurrence.title,
        status: LOG_STATUS.CONFIRMED,
        source: LOG_SOURCE.RULE,
        originRuleId: rule.id,
        originOccurrenceId: occurrence.originOccurrenceId,
        originRuleSummarySnapshot: rule.title,
        tags: input.tags
      }, now);
      database.timeLogs.push(log);
      return log;
    }).result;
  }

  createManualLog(input) {
    const now = this.now();
    const startedAt = Number(input.startedAt);
    const endedAt = Number(input.endedAt);
    validTimeRange(startedAt, endedAt, '手工补录时间');
    return this.repository.transaction((database) => {
      const association = this.resolveNewRecordAssociations(database, input);
      const log = createTimeLog({
        ...association,
        startedAt,
        endedAt,
        durationMinutes: calculateDurationMinutes(startedAt, endedAt, []),
        note: input.note || '',
        tags: input.tags,
        status: LOG_STATUS.CONFIRMED,
        source: LOG_SOURCE.MANUAL
      }, now);
      database.timeLogs.push(log);
      return { log, hasOverlap: this.hasOverlap(database.timeLogs, log) };
    }).result;
  }

  hasOverlap(logs, target) {
    return logs.some((item) => item.id !== target.id && item.startedAt < target.endedAt && target.startedAt < item.endedAt);
  }

  updateLog(id, input) {
    const now = this.now();
    return this.repository.transaction((database) => {
      const log = this.requireEntity(database.timeLogs, id, '时间记录');
      const startedAt = input.startedAt === undefined ? log.startedAt : Number(input.startedAt);
      const endedAt = input.endedAt === undefined ? log.endedAt : Number(input.endedAt);
      validTimeRange(startedAt, endedAt, '记录时间');
      const association = this.resolveRecordUpdateAssociations(database, log, input);
      const tags = this.resolveUpdatedTags(log.tags, input.tags);
      Object.assign(log, association, {
        startedAt,
        endedAt,
        durationMinutes: calculateDurationMinutes(startedAt, endedAt, []),
        note: input.note === undefined ? log.note : input.note,
        tags,
        status: log.status === LOG_STATUS.CANDIDATE ? LOG_STATUS.CONFIRMED : log.status,
        updatedAt: now
      });
      return { log, hasOverlap: this.hasOverlap(database.timeLogs, log) };
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
      return log;
    }).result;
  }

  deleteLog(id, confirmed) {
    if (!confirmed) {
      throw new DomainError('DELETE_CONFIRMATION_REQUIRED', '删除时间记录需要二次确认');
    }
    return this.repository.transaction((database) => {
      this.requireEntity(database.timeLogs, id, '时间记录');
      database.timeLogs = database.timeLogs.filter((item) => item.id !== id);
      return { id };
    }).result;
  }

  startTimer(input = {}) {
    const now = this.now();
    return this.repository.transaction((database) => {
      if (database.timer.status !== TIMER_STATUS.IDLE) {
        throw new DomainError('TIMER_ALREADY_ACTIVE', '已有进行中的计时，请先结束或生成记录');
      }
      const association = this.resolveNewRecordAssociations(database, input);
      database.timer = {
        status: TIMER_STATUS.RUNNING,
        startedAt: now,
        endedAt: null,
        pausedAt: null,
        pauses: [],
        draft: {
          ...association,
          note: input.note || '',
          tags: normalizeTags(input.tags === undefined ? [] : input.tags)
        }
      };
      database.recoveryDraft = null;
      return database.timer;
    }).result;
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
    const now = this.now();
    return this.repository.transaction((database) => {
      if (database.timer.status !== TIMER_STATUS.RUNNING) {
        throw new DomainError('TIMER_NOT_RUNNING', '只有运行中的计时可以暂停');
      }
      database.timer.status = TIMER_STATUS.PAUSED;
      database.timer.pausedAt = now;
      return database.timer;
    }).result;
  }

  resumeTimer() {
    const now = this.now();
    return this.repository.transaction((database) => {
      if (database.timer.status !== TIMER_STATUS.PAUSED || !isFiniteTimestamp(database.timer.pausedAt)) {
        throw new DomainError('TIMER_NOT_PAUSED', '没有可恢复的暂停计时');
      }
      database.timer.pauses.push({ startedAt: database.timer.pausedAt, endedAt: now });
      database.timer.status = TIMER_STATUS.RUNNING;
      database.timer.pausedAt = null;
      return database.timer;
    }).result;
  }

  finishTimer() {
    const now = this.now();
    return this.repository.transaction((database) => {
      if (database.timer.status === TIMER_STATUS.IDLE || database.timer.status === TIMER_STATUS.ENDED) {
        throw new DomainError('TIMER_NOT_ACTIVE', '没有可结束的计时');
      }
      if (database.timer.status === TIMER_STATUS.PAUSED) {
        database.timer.pauses.push({ startedAt: database.timer.pausedAt, endedAt: now });
        database.timer.pausedAt = null;
      }
      database.timer.status = TIMER_STATUS.ENDED;
      database.timer.endedAt = now;
      return database.timer;
    }).result;
  }

  generateTimerRecord() {
    const now = this.now();
    return this.repository.transaction((database) => {
      const timer = database.timer;
      if (timer.status !== TIMER_STATUS.ENDED) {
        throw new DomainError('TIMER_NOT_ENDED', '请先结束计时，再生成记录');
      }
      const durationMinutes = calculateTimerDurationMinutes(timer.startedAt, timer.endedAt, timer.pauses);
      const association = this.resolveRecordUpdateAssociations(database, timer.draft, {});
      const log = createTimeLog({
        ...timer.draft,
        ...association,
        startedAt: timer.startedAt,
        endedAt: timer.endedAt,
        durationMinutes,
        status: LOG_STATUS.CONFIRMED,
        source: LOG_SOURCE.TIMER
      }, now, { enforceTagLimits: false });
      database.timeLogs.push(log);
      database.timer = createIdleTimer();
      return { log, hasOverlap: this.hasOverlap(database.timeLogs, log) };
    }).result;
  }

  createRecoveryConfirmedLog(input) {
    const now = this.now();
    const startedAt = Number(input.startedAt);
    const endedAt = Number(input.endedAt);
    validTimeRange(startedAt, endedAt, '恢复记录时间');
    return this.repository.transaction((database) => {
      const recoveryDraft = database.recoveryDraft;
      if (!recoveryDraft || !recoveryDraft.timer) {
        throw new DomainError('RECOVERY_DRAFT_NOT_FOUND', '没有需要修正的恢复草稿');
      }
      const originalDraft = recoveryDraft.timer.draft || {};
      const association = this.resolveRecordUpdateAssociations(database, originalDraft, input);
      const tags = this.resolveUpdatedTags(originalDraft.tags, input.tags);
      const log = createTimeLog({
        ...association,
        startedAt,
        endedAt,
        durationMinutes: calculateDurationMinutes(startedAt, endedAt, []),
        note: input.note === undefined ? (originalDraft.note || '') : input.note,
        tags,
        status: LOG_STATUS.CONFIRMED,
        source: LOG_SOURCE.TIMER
      }, now, { enforceTagLimits: false });
      database.timeLogs.push(log);
      database.recoveryDraft = null;
      return log;
    }).result;
  }

  simulateTimerRecoveryFailureForDebug() {
    const snapshot = this.snapshot();
    if (snapshot.recoveryDraft) {
      throw new DomainError('DEBUG_RECOVERY_DRAFT_EXISTS', '已有待修正的恢复草稿，请先完成修正后再测试');
    }
    if (!snapshot.timer || snapshot.timer.status !== TIMER_STATUS.IDLE) {
      throw new DomainError('DEBUG_TIMER_TEST_REQUIRES_IDLE', '请先生成当前计时记录，再测试计时失败');
    }

    const now = this.now();
    this.repository.transaction((database) => {
      database.timer = {
        ...createIdleTimer(),
        status: TIMER_STATUS.RUNNING,
        startedAt: now - 10 * 60 * 1_000,
        pausedAt: now,
        draft: {
          note: '开发调试：计时状态异常',
          tags: []
        }
      };
    });
    return this.recoverTimer(now);
  }

  recoverTimer(now) {
    const currentTimer = this.snapshot().timer;
    if (!currentTimer || currentTimer.status === TIMER_STATUS.IDLE || currentTimer.status === TIMER_STATUS.ENDED) {
      return { state: 'unchanged', timer: currentTimer };
    }
    return this.repository.transaction((database) => {
      const timer = database.timer;
      timer.draft = {
        ...timer.draft,
        ...this.resolveRecordUpdateAssociations(database, timer.draft, {})
      };
      const pausesAreValid = Array.isArray(timer.pauses) && timer.pauses.every((pause, index, pauses) => {
        const precedingEnd = index === 0 ? timer.startedAt : pauses[index - 1].endedAt;
        return isFiniteTimestamp(pause.startedAt) && isFiniteTimestamp(pause.endedAt) && pause.endedAt >= pause.startedAt && pause.startedAt >= precedingEnd && pause.endedAt <= now;
      });
      const basicValid = isFiniteTimestamp(timer.startedAt) && now >= timer.startedAt;
      const precedingPauseEnd = pausesAreValid && timer.pauses.length
        ? timer.pauses[timer.pauses.length - 1].endedAt
        : timer.startedAt;
      const statusFieldsValid = timer.status === TIMER_STATUS.RUNNING
        ? timer.endedAt === null && timer.pausedAt === null
        : timer.status === TIMER_STATUS.PAUSED && timer.endedAt === null;
      const activePauseValid = timer.status === TIMER_STATUS.RUNNING
        ? timer.pausedAt === null
        : timer.status === TIMER_STATUS.PAUSED
          && isFiniteTimestamp(timer.pausedAt)
          && timer.pausedAt >= precedingPauseEnd
          && timer.pausedAt <= now;
      if (basicValid && pausesAreValid && statusFieldsValid && activePauseValid && now - timer.startedAt <= this.recoveryTimerSpanMs) {
        return { state: 'resumed', timer };
      }
      database.timer = createIdleTimer();
      if (!basicValid || !pausesAreValid || !statusFieldsValid || !activePauseValid) {
        database.recoveryDraft = { reason: '时间戳无法还原，请手工修正并确认记录', timer, createdAt: now };
        return { state: 'draft', recoveryDraft: database.recoveryDraft };
      }
      const endedAt = Math.min(now, timer.startedAt + this.recoveryTimerSpanMs);
      const pauses = timer.pauses.filter((pause) => pause.startedAt < endedAt).map((pause) => ({
        startedAt: pause.startedAt,
        endedAt: Math.min(pause.endedAt, endedAt)
      }));
      if (timer.status === TIMER_STATUS.PAUSED && timer.pausedAt < endedAt) {
        pauses.push({ startedAt: timer.pausedAt, endedAt });
      }
      const durationMinutes = Math.max(
        this.minimumRecoveryDurationMinutes,
        calculateDurationMinutes(timer.startedAt, endedAt, pauses)
      );
      if (durationMinutes <= 0) {
        database.recoveryDraft = { reason: '可恢复时间无效，请手工修正并确认记录', timer, createdAt: now };
        return { state: 'draft', recoveryDraft: database.recoveryDraft };
      }
      const log = createTimeLog({
        ...timer.draft,
        startedAt: timer.startedAt,
        endedAt,
        durationMinutes,
        status: LOG_STATUS.CANDIDATE,
        source: LOG_SOURCE.TIMER
      }, now, { enforceTagLimits: false });
      database.timeLogs.push(log);
      return { state: 'candidate', log };
    }).result;
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
