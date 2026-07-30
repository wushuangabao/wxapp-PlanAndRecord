const {
  DEFAULT_CATEGORY_ID,
  DEFAULT_CATEGORY_NAME,
  PROJECT_STATUS
} = require('../domain/constants');
const { clone, createInitialDatabase } = require('../domain/entities');
const { DomainError } = require('../domain/errors');
const { logicalOccurrenceStart, projectRule } = require('../domain/recurrence');
const { validateJsonSnapshot, persistedValueEquals } = require('./json-snapshot');

const ENTITY_COLLECTIONS = [
  'categories',
  'wishes',
  'projects',
  'tasks',
  'calendarEvents',
  'repeatRules',
  'occurrenceExceptions',
  'timeLogs'
];

const IMPORT_MODE = {
  INCREMENTAL: 'incremental',
  REPLACE: 'replace'
};

const CONFLICT_POLICY = {
  KEEP_LOCAL: 'keep-local',
  USE_IMPORTED: 'use-imported'
};

function emptyCounts() {
  return ENTITY_COLLECTIONS.reduce((counts, name) => {
    counts[name] = 0;
    return counts;
  }, {});
}

function assertImportMode(mode) {
  if (!Object.values(IMPORT_MODE).includes(mode)) {
    throw new DomainError('IMPORT_MODE_INVALID', '导入模式无效');
  }
}

function createBaseDatabase(localDatabase, mode, now) {
  if (mode === IMPORT_MODE.INCREMENTAL) return clone(localDatabase);

  const base = createInitialDatabase(now);
  ENTITY_COLLECTIONS.forEach((name) => {
    base[name] = [];
  });
  return base;
}

function createImportAnalysis(localDatabase, importedDatabase, { mode, now }) {
  assertImportMode(mode);
  validateJsonSnapshot(localDatabase);
  validateJsonSnapshot(importedDatabase);

  const baseDatabase = createBaseDatabase(localDatabase, mode, now);
  const imported = clone(importedDatabase);
  const addedCounts = emptyCounts();
  const conflicts = [];
  let identicalCount = 0;

  ENTITY_COLLECTIONS.forEach((collection) => {
    const baseById = new Map(baseDatabase[collection].map((entity) => [entity.id, entity]));
    imported[collection].forEach((entity) => {
      const existing = baseById.get(entity.id);
      if (!existing) {
        addedCounts[collection] += 1;
      } else if (persistedValueEquals(existing, entity)) {
        identicalCount += 1;
      } else {
        conflicts.push({ collection, id: entity.id });
      }
    });
  });

  return {
    mode,
    now,
    baseDatabase,
    importedDatabase: imported,
    conflictCount: conflicts.length,
    identicalCount,
    addedCounts,
    conflicts
  };
}

function assertConflictPolicy(conflictCount, conflictPolicy) {
  if (!conflictCount) return;
  if (conflictPolicy === undefined || conflictPolicy === null) {
    throw new DomainError('IMPORT_CONFLICT_POLICY_REQUIRED', '存在数据冲突，请选择统一处理方式');
  }
  if (!Object.values(CONFLICT_POLICY).includes(conflictPolicy)) {
    throw new DomainError('IMPORT_CONFLICT_POLICY_INVALID', '冲突处理方式无效');
  }
}

function mergeImportedEntities(database, importedDatabase, conflictPolicy) {
  const replacedCounts = emptyCounts();

  ENTITY_COLLECTIONS.forEach((collection) => {
    const indicesById = new Map(database[collection].map((entity, index) => [entity.id, index]));
    importedDatabase[collection].forEach((importedEntity) => {
      const existingIndex = indicesById.get(importedEntity.id);
      if (existingIndex === undefined) {
        database[collection].push(clone(importedEntity));
        indicesById.set(importedEntity.id, database[collection].length - 1);
        return;
      }

      const existing = database[collection][existingIndex];
      if (persistedValueEquals(existing, importedEntity) || conflictPolicy === CONFLICT_POLICY.KEEP_LOCAL) return;

      database[collection][existingIndex] = clone(importedEntity);
      replacedCounts[collection] += 1;
    });
  });

  return replacedCounts;
}

function repairFinalReferences(database) {
  const projectIds = new Set(database.projects.map((item) => item.id));
  const taskIds = new Set(database.tasks.map((item) => item.id));
  const eventIds = new Set(database.calendarEvents.map((item) => item.id));
  const ruleIds = new Set(database.repeatRules.map((item) => item.id));
  const categoryIds = new Set(database.categories.map((item) => item.id));
  const defaultCategory = database.categories.find((item) => item.id === DEFAULT_CATEGORY_ID);
  let repairedReferenceCount = 0;
  let discardedExceptionCount = 0;

  function clearMissing(entity, field, ids) {
    if (entity[field] !== null && !ids.has(entity[field])) {
      entity[field] = null;
      repairedReferenceCount += 1;
    }
  }

  function hasReferenceValue(value) {
    return value !== undefined && value !== null && value !== '';
  }

  function normalizeRuntimeDraft(draft) {
    if (!draft || typeof draft !== 'object') return;
    if (Object.prototype.hasOwnProperty.call(draft, 'projectId')) draft.projectId = null;
    if (Object.prototype.hasOwnProperty.call(draft, 'taskId')) draft.taskId = null;

    if (hasReferenceValue(draft.calendarEventId)) {
      const event = database.calendarEvents.find((item) => item.id === draft.calendarEventId);
      if (!event || !event.taskId || !taskIds.has(event.taskId)) {
        draft.calendarEventSummarySnapshot = draft.calendarEventSummarySnapshot
          || (event ? event.title : null);
        draft.calendarEventId = null;
        repairedReferenceCount += 1;
      }
    }

    if (hasReferenceValue(draft.originRuleId) || hasReferenceValue(draft.originOccurrenceId)) {
      const rule = database.repeatRules.find((item) => item.id === draft.originRuleId);
      const occurrenceStart = logicalOccurrenceStart(
        draft.originRuleId,
        draft.originOccurrenceId
      );
      const occurrence = rule && occurrenceStart !== null
        ? projectRule(
          rule,
          occurrenceStart,
          occurrenceStart,
          database.occurrenceExceptions
        ).find((item) => item.originOccurrenceId === draft.originOccurrenceId)
        : null;
      if (!occurrence || !occurrence.taskId || !taskIds.has(occurrence.taskId)) {
        draft.originRuleSummarySnapshot = draft.originRuleSummarySnapshot
          || (rule ? rule.title : null);
        draft.originRuleId = null;
        draft.originOccurrenceId = null;
        repairedReferenceCount += 1;
      }
    }
  }

  database.tasks.forEach((item) => clearMissing(item, 'projectId', projectIds));

  database.calendarEvents.forEach((item) => {
    clearMissing(item, 'taskId', taskIds);
    clearMissing(item, 'repeatRuleId', ruleIds);
  });

  database.repeatRules.forEach((rule) => {
    rule.revisions.forEach((item) => {
      clearMissing(item, 'taskId', taskIds);
    });
  });

  database.occurrenceExceptions = database.occurrenceExceptions.filter((item) => {
    if (!ruleIds.has(item.ruleId)) {
      repairedReferenceCount += 1;
      discardedExceptionCount += 1;
      return false;
    }
    if (item.override) {
      clearMissing(item.override, 'taskId', taskIds);
    }
    return true;
  });

  database.timeLogs.forEach((item) => {
    if (!categoryIds.has(item.categoryId)) {
      item.categoryId = DEFAULT_CATEGORY_ID;
      item.categoryNameSnapshot = defaultCategory.name;
      repairedReferenceCount += 1;
    }
    clearMissing(item, 'calendarEventId', eventIds);
    if (item.originRuleId !== null && !ruleIds.has(item.originRuleId)) {
      item.originRuleId = null;
      repairedReferenceCount += 1;
    }
  });

  normalizeRuntimeDraft(database.timer && database.timer.draft);
  normalizeRuntimeDraft(
    database.recoveryDraft
      && database.recoveryDraft.timer
      && database.recoveryDraft.timer.draft
  );

  return { repairedReferenceCount, discardedExceptionCount };
}

function resolveImportAnalysis(analysis, conflictPolicy) {
  assertConflictPolicy(analysis.conflictCount, conflictPolicy);

  const database = clone(analysis.baseDatabase);
  const replacedCounts = mergeImportedEntities(database, analysis.importedDatabase, conflictPolicy);
  const repairs = repairFinalReferences(database);
  database.updatedAt = analysis.now;
  validateJsonSnapshot(database);

  return {
    database,
    summary: {
      mode: analysis.mode,
      conflictPolicy: analysis.conflictCount ? conflictPolicy : null,
      conflictCount: analysis.conflictCount,
      identicalCount: analysis.identicalCount,
      addedCounts: clone(analysis.addedCounts),
      replacedCounts,
      repairedReferenceCount: repairs.repairedReferenceCount,
      discardedExceptionCount: repairs.discardedExceptionCount,
      activeProjectCount: database.projects.filter((item) => item.status === PROJECT_STATUS.ACTIVE).length
    }
  };
}

module.exports = {
  ENTITY_COLLECTIONS,
  IMPORT_MODE,
  CONFLICT_POLICY,
  createImportAnalysis,
  resolveImportAnalysis
};
