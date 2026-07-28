const {
  DEFAULT_CATEGORY_ID,
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
const { createOccurrenceException, projectRule } = require('../domain/recurrence');
const { buildStatistics } = require('../domain/statistics');
const { calculateDurationMinutes, isFiniteTimestamp } = require('../domain/time');
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
    this.pendingJsonImport = null;
    const database = this.repository.reset();
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
    const category = input.categoryId
      ? this.requireEntity(database.categories, input.categoryId, '分类')
      : database.categories.find((item) => item.id === DEFAULT_CATEGORY_ID);
    if (category.status !== 'active') {
      throw new DomainError('CATEGORY_ARCHIVED', '归档分类不能用于新记录');
    }
    return {
      categoryId: category.id,
      categoryNameSnapshot: category.name,
      projectId: project ? project.id : null,
      projectNameSnapshot: project ? project.title : null,
      taskId: task ? task.id : null,
      taskNameSnapshot: task ? task.title : null,
      calendarEventId: event ? event.id : null,
      calendarEventSummarySnapshot: event ? event.title : null
    };
  }

  createCategory(name) {
    const now = this.now();
    const normalized = requiredTitle(name, '分类名称');
    return this.repository.transaction((database) => {
      if (database.categories.some((item) => item.name === normalized)) {
        throw new DomainError('CATEGORY_DUPLICATED', '分类名称已存在');
      }
      const category = {
        id: createId('category', now),
        name: normalized,
        status: 'active',
        isSystem: false,
        createdAt: now,
        updatedAt: now
      };
      database.categories.push(category);
      return category;
    }).result;
  }

  renameCategory(id, name) {
    const normalized = requiredTitle(name, '分类名称');
    const now = this.now();
    return this.repository.transaction((database) => {
      const category = this.requireEntity(database.categories, id, '分类');
      if (database.categories.some((item) => item.id !== id && item.name === normalized)) {
        throw new DomainError('CATEGORY_DUPLICATED', '分类名称已存在');
      }
      category.name = normalized;
      category.updatedAt = now;
      return category;
    }).result;
  }

  archiveCategory(id) {
    const now = this.now();
    return this.repository.transaction((database) => {
      const category = this.requireEntity(database.categories, id, '分类');
      if (category.isSystem) {
        throw new DomainError('CATEGORY_SYSTEM', '“未分类”不可归档');
      }
      category.status = 'archived';
      category.updatedAt = now;
      return category;
    }).result;
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
      const deletingTaskIds = database.tasks
        .filter((task) => task.projectId === id && task.status !== TASK_STATUS.COMPLETED)
        .map((task) => task.id);
      const deletedEventIds = database.calendarEvents
        .filter((event) => (event.projectId === id || deletingTaskIds.includes(event.taskId)) && event.endedAt > now)
        .map((event) => event.id);
      const deletedRuleIds = database.repeatRules
        .filter((rule) => rule.revisions.some((revision) => revision.projectId === id || deletingTaskIds.includes(revision.taskId)))
        .map((rule) => rule.id);

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
        if (event.projectId === id || deletingTaskIds.includes(event.taskId)) {
          if (event.projectId === id) {
            event.projectNameSnapshot = project.title;
            event.projectId = null;
          }
          if (deletingTaskIds.includes(event.taskId)) {
            event.taskNameSnapshot = event.taskNameSnapshot || '已删除任务';
            event.taskId = null;
          }
          if (event.repeatRuleId && deletedRuleIds.includes(event.repeatRuleId)) {
            event.repeatRuleSummarySnapshot = event.repeatRuleSummarySnapshot || '已删除重复规则';
            event.repeatRuleId = null;
          }
          event.updatedAt = now;
        }
        return true;
      });
      database.repeatRules = database.repeatRules.filter((rule) => !deletedRuleIds.includes(rule.id));
      database.occurrenceExceptions = database.occurrenceExceptions.filter((item) => !deletedRuleIds.includes(item.ruleId));
      database.timeLogs = database.timeLogs.filter((log) => {
        const related = log.projectId === id || deletingTaskIds.includes(log.taskId) || deletedEventIds.includes(log.calendarEventId) || deletedRuleIds.includes(log.originRuleId);
        if (related && log.status === LOG_STATUS.CANDIDATE) {
          return false;
        }
        if (related && log.status === LOG_STATUS.CONFIRMED) {
          if (log.projectId === id) {
            log.projectNameSnapshot = log.projectNameSnapshot || project.title;
            log.projectId = null;
          }
          if (deletingTaskIds.includes(log.taskId)) {
            log.taskNameSnapshot = log.taskNameSnapshot || '已删除任务';
            log.taskId = null;
          }
          if (deletedEventIds.includes(log.calendarEventId)) {
            log.calendarEventSummarySnapshot = log.calendarEventSummarySnapshot || '已删除计划';
            log.calendarEventId = null;
          }
          if (deletedRuleIds.includes(log.originRuleId)) {
            log.originRuleSummarySnapshot = log.originRuleSummarySnapshot || '已删除重复规则';
            log.originRuleId = null;
          }
          log.updatedAt = now;
        }
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
      const task = {
        id: createId('task', now),
        title,
        status: input.status || TASK_STATUS.INBOX,
        projectId: association.projectId || null,
        projectNameSnapshot: association.projectNameSnapshot || null,
        completedAt: null,
        createdAt: now,
        updatedAt: now
      };
      database.tasks.push(task);
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
      if (input.status) {
        task.status = input.status;
        task.completedAt = input.status === TASK_STATUS.COMPLETED ? now : null;
      }
      task.updatedAt = now;
      return task;
    }).result;
  }

  createCalendarEvent(input) {
    const now = this.now();
    const title = requiredTitle(input.title, '计划标题');
    const startedAt = Number(input.startedAt);
    const endedAt = Number(input.endedAt);
    validTimeRange(startedAt, endedAt, '计划时间');
    return this.repository.transaction((database) => {
      const association = this.resolveAssociations(database, input);
      const event = createCalendarEvent({ ...input, ...association, title, startedAt, endedAt, priority: validPriority(input.priority) }, now);
      database.calendarEvents.push(event);
      return event;
    }).result;
  }

  updateCalendarEvent(id, input) {
    const now = this.now();
    return this.repository.transaction((database) => {
      const event = this.requireEntity(database.calendarEvents, id, '计划块');
      const startedAt = input.startedAt === undefined ? event.startedAt : Number(input.startedAt);
      const endedAt = input.endedAt === undefined ? event.endedAt : Number(input.endedAt);
      validTimeRange(startedAt, endedAt, '计划时间');
      const association = this.resolveAssociations(database, {
        projectId: input.projectId === undefined ? event.projectId : input.projectId,
        taskId: input.taskId === undefined ? event.taskId : input.taskId,
        calendarEventId: undefined,
        categoryId: DEFAULT_CATEGORY_ID
      });
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
      return { id };
    }).result;
  }

  createRecurringPlan(input) {
    const now = this.now();
    const title = requiredTitle(input.title, '固定日程标题');
    const startedAt = Number(input.startedAt);
    const endedAt = Number(input.endedAt);
    validTimeRange(startedAt, endedAt, '固定日程时间');
    const frequency = validRepeatFrequency(input.frequency);
    const interval = validInterval(input.interval);
    return this.repository.transaction((database) => {
      const association = this.resolveAssociations(database, input);
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
    return this.repository.transaction((database) => {
      const rule = this.requireEntity(database.repeatRules, ruleId, '重复规则');
      const activeRevision = rule.revisions.find((revision) => revision.effectiveFrom <= occurrenceStart && (!revision.effectiveUntil || revision.effectiveUntil >= occurrenceStart));
      if (!activeRevision) {
        throw new DomainError('OCCURRENCE_NOT_FOUND', '找不到需要修订的重复实例');
      }
      const startedAt = input.startedAt === undefined ? occurrenceStart : Number(input.startedAt);
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

  saveOccurrenceException(ruleId, occurrenceStart, kind, override) {
    const now = this.now();
    return this.repository.transaction((database) => {
      this.requireEntity(database.repeatRules, ruleId, '重复规则');
      database.occurrenceExceptions = database.occurrenceExceptions.filter((item) => !(item.ruleId === ruleId && item.occurrenceStart === occurrenceStart));
      const exception = createOccurrenceException(ruleId, occurrenceStart, kind, override, now);
      database.occurrenceExceptions.push(exception);
      return exception;
    }).result;
  }

  skipOccurrence(ruleId, occurrenceStart) {
    return this.saveOccurrenceException(ruleId, occurrenceStart, 'skip');
  }

  overrideOccurrence(ruleId, occurrenceStart, input) {
    const startedAt = Number(input.startedAt);
    const endedAt = Number(input.endedAt);
    validTimeRange(startedAt, endedAt, '单次修改时间');
    return this.saveOccurrenceException(ruleId, occurrenceStart, 'override', {
      title: requiredTitle(input.title, '计划标题'),
      startedAt,
      endedAt,
      priority: validPriority(input.priority),
      projectId: input.projectId || null,
      projectNameSnapshot: input.projectNameSnapshot || null,
      taskId: input.taskId || null,
      taskNameSnapshot: input.taskNameSnapshot || null
    });
  }

  timeline(rangeStart, rangeEnd) {
    const database = this.snapshot();
    const eventEntries = database.calendarEvents
      .filter((event) => event.endedAt >= rangeStart && event.startedAt <= rangeEnd)
      .map((event) => ({ ...event, type: 'plan', virtual: false }));
    const logEntries = database.timeLogs
      .filter((log) => log.endedAt >= rangeStart && log.startedAt <= rangeEnd)
      .map((log) => ({ ...log, type: log.status, title: log.taskNameSnapshot || log.note || '时间记录', virtual: false }));
    const virtualEntries = database.repeatRules.flatMap((rule) => projectRule(rule, rangeStart, rangeEnd, database.occurrenceExceptions))
      .filter((item) => !database.calendarEvents.some((event) => event.repeatRuleId === item.ruleId && event.startedAt === item.startedAt))
      .filter((item) => !database.timeLogs.some((log) => log.originRuleId === item.ruleId && log.originOccurrenceId === item.originOccurrenceId));
    return eventEntries.concat(logEntries, virtualEntries).sort((first, second) => first.startedAt - second.startedAt);
  }

  confirmVirtualOccurrence(input) {
    const now = this.now();
    return this.repository.transaction((database) => {
      const rule = this.requireEntity(database.repeatRules, input.ruleId, '重复规则');
      const occurrenceStart = input.occurrenceStart || input.startedAt;
      const occurrence = projectRule(rule, occurrenceStart, occurrenceStart, database.occurrenceExceptions)
        .find((item) => item.originOccurrenceId === input.originOccurrenceId);
      if (!occurrence) {
        throw new DomainError('OCCURRENCE_NOT_FOUND', '该重复实例已跳过、已修改或不再有效');
      }
      if (database.timeLogs.some((log) => log.originRuleId === rule.id && log.originOccurrenceId === occurrence.originOccurrenceId)) {
        throw new DomainError('OCCURRENCE_ALREADY_CONFIRMED', '该重复实例已确认，不能重复生成记录');
      }
      const association = this.resolveAssociations(database, { projectId: occurrence.projectId, taskId: occurrence.taskId, categoryId: input.categoryId });
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
        tags: input.tags || []
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
      const association = this.resolveAssociations(database, input);
      const log = createTimeLog({
        ...association,
        startedAt,
        endedAt,
        durationMinutes: calculateDurationMinutes(startedAt, endedAt, []),
        note: input.note || '',
        tags: input.tags || [],
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
      const association = this.resolveAssociations(database, {
        projectId: input.projectId === undefined ? log.projectId : input.projectId,
        taskId: input.taskId === undefined ? log.taskId : input.taskId,
        calendarEventId: input.calendarEventId === undefined ? log.calendarEventId : input.calendarEventId,
        categoryId: input.categoryId === undefined ? log.categoryId : input.categoryId
      });
      Object.assign(log, association, {
        startedAt,
        endedAt,
        durationMinutes: calculateDurationMinutes(startedAt, endedAt, []),
        note: input.note === undefined ? log.note : input.note,
        tags: input.tags === undefined ? log.tags : input.tags,
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
      log.status = LOG_STATUS.CONFIRMED;
      log.updatedAt = now;
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
      const association = this.resolveAssociations(database, input);
      database.timer = {
        status: TIMER_STATUS.RUNNING,
        startedAt: now,
        endedAt: null,
        pausedAt: null,
        pauses: [],
        draft: { ...association, note: input.note || '', tags: input.tags || [] }
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
      const association = this.resolveAssociations(database, input);
      database.timer.draft = {
        ...database.timer.draft,
        ...association,
        note: input.note === undefined ? database.timer.draft.note : input.note,
        tags: input.tags === undefined ? database.timer.draft.tags : input.tags
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
      const durationMinutes = calculateDurationMinutes(timer.startedAt, timer.endedAt, timer.pauses);
      if (durationMinutes <= 0) {
        throw new DomainError('TIMER_DURATION_INVALID', '计时时长无效，请改为手工补录');
      }
      const log = createTimeLog({
        ...timer.draft,
        startedAt: timer.startedAt,
        endedAt: timer.endedAt,
        durationMinutes,
        status: LOG_STATUS.CONFIRMED,
        source: LOG_SOURCE.TIMER
      }, now);
      database.timeLogs.push(log);
      database.timer = createIdleTimer();
      return { log, hasOverlap: this.hasOverlap(database.timeLogs, log) };
    }).result;
  }

  recoverTimer(now) {
    const currentTimer = this.snapshot().timer;
    if (!currentTimer || currentTimer.status === TIMER_STATUS.IDLE || currentTimer.status === TIMER_STATUS.ENDED) {
      return { state: 'unchanged', timer: currentTimer };
    }
    return this.repository.transaction((database) => {
      const timer = database.timer;
      const pausesAreValid = Array.isArray(timer.pauses) && timer.pauses.every((pause, index, pauses) => {
        const precedingEnd = index === 0 ? timer.startedAt : pauses[index - 1].endedAt;
        return isFiniteTimestamp(pause.startedAt) && isFiniteTimestamp(pause.endedAt) && pause.endedAt >= pause.startedAt && pause.startedAt >= precedingEnd && pause.endedAt <= now;
      });
      const basicValid = isFiniteTimestamp(timer.startedAt) && now >= timer.startedAt;
      const activePauseValid = timer.status !== TIMER_STATUS.PAUSED || (isFiniteTimestamp(timer.pausedAt) && timer.pausedAt >= timer.startedAt && timer.pausedAt <= now);
      if (basicValid && pausesAreValid && activePauseValid && now - timer.startedAt <= MAX_TIMER_SPAN_MS) {
        return { state: 'resumed', timer };
      }
      database.timer = createIdleTimer();
      if (!basicValid) {
        database.recoveryDraft = { reason: '时间戳无法还原，请手工修正后再创建候选记录', timer, createdAt: now };
        return { state: 'draft', recoveryDraft: database.recoveryDraft };
      }
      const endedAt = Math.min(now, timer.startedAt + MAX_TIMER_SPAN_MS);
      const pauses = pausesAreValid ? timer.pauses.filter((pause) => pause.startedAt < endedAt).map((pause) => ({
        startedAt: pause.startedAt,
        endedAt: Math.min(pause.endedAt, endedAt)
      })) : [];
      const durationMinutes = calculateDurationMinutes(timer.startedAt, endedAt, pauses);
      if (durationMinutes <= 0) {
        database.recoveryDraft = { reason: '可恢复时间无效，请手工修正后再创建候选记录', timer, createdAt: now };
        return { state: 'draft', recoveryDraft: database.recoveryDraft };
      }
      const log = createTimeLog({
        ...timer.draft,
        startedAt: timer.startedAt,
        endedAt,
        durationMinutes,
        status: LOG_STATUS.CANDIDATE,
        source: LOG_SOURCE.TIMER
      }, now);
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
