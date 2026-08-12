const test = require('node:test');
const assert = require('node:assert/strict');
const { createInitialDatabase, createIdleTimer } = require('../miniprogram/domain/entities');
const { projectRule } = require('../miniprogram/domain/recurrence');
const {
  IMPORT_MODE,
  CONFLICT_POLICY,
  createImportAnalysis,
  resolveImportAnalysis
} = require('../miniprogram/repository/json-import');

const NOW = 1_700_000_000_000;

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function database(now = NOW) {
  return createInitialDatabase(now);
}

function wish(id, title, now = NOW) {
  return { id, title, createdAt: now, updatedAt: now };
}

function project(id, title, now = NOW) {
  return {
    id, title, deadlineAt: now + 86_400_000, status: 'active',
    createdAt: now, updatedAt: now
  };
}

function task(id, title, projectId = null, projectNameSnapshot = null, now = NOW) {
  return {
    id, title, status: 'todo', projectId, projectNameSnapshot, completedAt: null,
    createdAt: now, updatedAt: now
  };
}

function calendarEvent(id, title, references = {}, now = NOW) {
  return {
    id, title, startedAt: now, endedAt: now + 3_600_000, priority: 1,
    projectId: null, projectNameSnapshot: null, taskId: null, taskNameSnapshot: null,
    ...references, createdAt: now, updatedAt: now
  };
}

function revision(id, references = {}, now = NOW) {
  return {
    id, revision: 1, effectiveFrom: now, effectiveUntil: null,
    frequency: 'weekly', interval: 1, weekdays: [1], monthDays: [],
    startedAt: now, endedAt: now + 3_600_000, priority: 1,
    projectId: null, projectNameSnapshot: null, taskId: null, taskNameSnapshot: null,
    ...references
  };
}

function repeatRule(id, title, revisions, now = NOW) {
  return { id, title, revisions, createdAt: now, updatedAt: now };
}

function occurrenceException(id, ruleId, now = NOW) {
  return {
    id, ruleId, occurrenceStart: now, kind: 'skip',
    createdAt: now, updatedAt: now
  };
}

function timeLog(id, references = {}, now = NOW) {
  return {
    id, schemaVersion: 1, startedAt: now, endedAt: now + 3_600_000,
    pausedDurationSeconds: 0, durationMinutes: 60,
    projectId: null, projectNameSnapshot: null, taskId: null, taskNameSnapshot: null,
    calendarEventId: null, calendarEventSummarySnapshot: null, note: '', status: 'confirmed',
    source: 'manual', originRuleId: null, originOccurrenceId: null,
    originRuleSummarySnapshot: null, tags: [], ...references, createdAt: now, updatedAt: now
  };
}

function addedCounts(overrides = {}) {
  return {
    wishes: 0, projects: 0, tasks: 0, calendarEvents: 0,
    repeatRules: 0, occurrenceExceptions: 0, timeLogs: 0, ...overrides
  };
}

test('增量导入添加新实体并保留本机运行态', () => {
  const local = database(1000);
  local.timer = {
    status: 'running', startedAt: 900, pausedAt: null, pauses: [],
    draft: { note: '本机计时', tags: [] }
  };
  local.recoveryDraft = { reason: '本机恢复草稿', timer: createIdleTimer(), createdAt: 1000 };
  const imported = database(1000);
  imported.wishes.push(wish('wish_imported', '导入愿望', 2000));
  imported.timer = createIdleTimer();
  imported.recoveryDraft = null;

  const analysis = createImportAnalysis(local, imported, { mode: IMPORT_MODE.INCREMENTAL, now: 3000 });
  const resolved = resolveImportAnalysis(analysis);

  assert.equal(resolved.database.wishes.some((item) => item.id === 'wish_imported'), true);
  assert.equal(resolved.database.localProfile.id, local.localProfile.id);
  assert.deepEqual(resolved.database.timer, local.timer);
  assert.deepEqual(resolved.database.recoveryDraft, local.recoveryDraft);
  assert.equal(resolved.database.createdAt, local.createdAt);
  assert.equal(resolved.database.updatedAt, 3000);
  assert.deepEqual(resolved.summary.addedCounts, addedCounts({ wishes: 1 }));
});

test('同 ID 冲突必须统一选择策略并精确报告替换数', () => {
  const local = database(1000);
  const imported = database(1000);
  local.wishes.push(wish('wish_same', '本地', 1));
  imported.wishes.push({ ...wish('wish_same', '导入', 1), updatedAt: 2 });
  const analysis = createImportAnalysis(local, imported, { mode: IMPORT_MODE.INCREMENTAL, now: 3000 });

  assert.equal(analysis.conflictCount, 1);
  assert.throws(() => resolveImportAnalysis(analysis), (error) => error.code === 'IMPORT_CONFLICT_POLICY_REQUIRED');
  const kept = resolveImportAnalysis(analysis, CONFLICT_POLICY.KEEP_LOCAL);
  const used = resolveImportAnalysis(analysis, CONFLICT_POLICY.USE_IMPORTED);
  assert.equal(kept.database.wishes[0].title, '本地');
  assert.deepEqual(kept.summary.replacedCounts, addedCounts());
  assert.equal(used.database.wishes[0].title, '导入');
  assert.deepEqual(used.summary.replacedCounts, addedCounts({ wishes: 1 }));
});

test('同 ID 且完整持久化值相同会跳过，对象属性顺序忽略而数组顺序冲突', () => {
  const local = database();
  const imported = database();
  local.wishes.push(wish('wish_same', '同一愿望'));
  imported.wishes.push({ updatedAt: NOW, title: '同一愿望', id: 'wish_same', createdAt: NOW });
  local.timeLogs.push(timeLog('log_same', { tags: ['A', 'B'] }));
  imported.timeLogs.push(timeLog('log_same', { tags: ['B', 'A'] }));

  const analysis = createImportAnalysis(local, imported, { mode: IMPORT_MODE.INCREMENTAL, now: NOW + 1 });

  assert.equal(analysis.identicalCount, 1);
  assert.equal(analysis.conflictCount, 1);
  assert.deepEqual(analysis.addedCounts, addedCounts());
});

test('同 ID 项目冲突按统一策略保留或整体替换项目', () => {
  const local = database();
  const imported = database();
  const localProject = project('project_aggregate', '本地项目');
  const importedProject = {
    ...project('project_aggregate', '导入项目'),
    updatedAt: NOW + 1
  };
  local.projects.push(localProject);
  imported.projects.push(importedProject);
  const analysis = createImportAnalysis(local, imported, {
    mode: IMPORT_MODE.INCREMENTAL,
    now: NOW + 2
  });

  assert.equal(analysis.conflictCount, 1);
  const keptProject = resolveImportAnalysis(analysis, CONFLICT_POLICY.KEEP_LOCAL).database.projects[0];
  const usedProject = resolveImportAnalysis(analysis, CONFLICT_POLICY.USE_IMPORTED).database.projects[0];

  assert.deepEqual(keptProject, localProject);
  assert.deepEqual(usedProject, importedProject);
  assert.equal(usedProject.title, '导入项目');
});

test('同 ID 重复规则冲突按统一策略保留或整体替换 revisions', () => {
  const local = database();
  const imported = database();
  const localRule = repeatRule('rule_aggregate', '聚合规则', [
    revision('revision_local_only')
  ]);
  const importedRule = {
    ...repeatRule('rule_aggregate', '聚合规则', [
      revision('revision_imported_only')
    ]),
    updatedAt: NOW + 1
  };
  local.repeatRules.push(localRule);
  imported.repeatRules.push(importedRule);
  const analysis = createImportAnalysis(local, imported, {
    mode: IMPORT_MODE.INCREMENTAL,
    now: NOW + 2
  });

  assert.equal(analysis.conflictCount, 1);
  const keptRule = resolveImportAnalysis(analysis, CONFLICT_POLICY.KEEP_LOCAL).database.repeatRules[0];
  const usedRule = resolveImportAnalysis(analysis, CONFLICT_POLICY.USE_IMPORTED).database.repeatRules[0];

  assert.deepEqual(keptRule, localRule);
  assert.deepEqual(usedRule, importedRule);
  assert.deepEqual(usedRule.revisions.map((item) => item.id), ['revision_imported_only']);
  assert.equal(JSON.stringify(usedRule).includes('revision_local_only'), false);
});

test('缺规则 skip 仍按既有策略修复', () => {
  const repairable = database();
  repairable.occurrenceExceptions.push(occurrenceException(
    'exception_orphan_skip',
    'rule_missing'
  ));
  const resolved = resolveImportAnalysis(createImportAnalysis(repairable, database(), {
    mode: IMPORT_MODE.INCREMENTAL,
    now: NOW + 1
  }));
  assert.equal(resolved.database.occurrenceExceptions.length, 0);
  assert.equal(resolved.summary.discardedExceptionCount, 1);
});

test('七类顶层聚合均按 ID 合并，规则修订随父实体移动', () => {
  const local = database();
  const imported = database();
  imported.wishes.push(wish('wish_imported', '愿望'));
  imported.projects.push(project('project_imported', '项目'));
  imported.tasks.push(task('task_imported', '任务', 'project_imported', '项目'));
  imported.calendarEvents.push(calendarEvent('event_imported', '计划', {
    projectId: 'project_imported', projectNameSnapshot: '项目', taskId: 'task_imported', taskNameSnapshot: '任务'
  }));
  imported.repeatRules.push(repeatRule('rule_imported', '重复计划', [revision('revision_imported', {
    projectId: 'project_imported', projectNameSnapshot: '项目', taskId: 'task_imported', taskNameSnapshot: '任务'
  })]));
  imported.occurrenceExceptions.push(occurrenceException('exception_imported', 'rule_imported'));
  imported.timeLogs.push(timeLog('log_imported', {
    projectId: 'project_imported', projectNameSnapshot: '项目', taskId: 'task_imported', taskNameSnapshot: '任务',
    calendarEventId: 'event_imported', calendarEventSummarySnapshot: '计划'
  }));

  const resolved = resolveImportAnalysis(createImportAnalysis(local, imported, {
    mode: IMPORT_MODE.INCREMENTAL, now: NOW + 1
  }));

  assert.deepEqual(resolved.summary.addedCounts, addedCounts({
    wishes: 1, projects: 1, tasks: 1, calendarEvents: 1,
    repeatRules: 1, occurrenceExceptions: 1, timeLogs: 1
  }));
  assert.equal(resolved.database.projects[0].id, 'project_imported');
  assert.equal(resolved.database.repeatRules[0].revisions[0].id, 'revision_imported');
  assert.equal(resolved.summary.repairedReferenceCount, 0);
});

test('不同 ID 即使项目和任务显示名相同也保持为不同实体', () => {
  const local = database();
  const imported = database();
  local.projects.push(project('project_local', '同名'));
  local.tasks.push(task('task_local', '同名'));
  imported.projects.push(project('project_imported', '同名'));
  imported.tasks.push(task('task_imported', '同名'));

  const resolved = resolveImportAnalysis(createImportAnalysis(local, imported, {
    mode: IMPORT_MODE.INCREMENTAL, now: NOW + 1
  }));

  assert.deepEqual(resolved.database.projects.map((item) => item.id), ['project_local', 'project_imported']);
  assert.deepEqual(resolved.database.tasks.map((item) => item.id), ['task_local', 'task_imported']);
});

test('覆盖导入以空聚合开始，重置运行态且不从来源导入资料库或根时间戳', () => {
  const local = database(1000);
  local.wishes.push(wish('wish_local', '本地愿望', 1000));
  const imported = database(2000);
  imported.timer = { status: 'running', startedAt: 1900, pausedAt: null, pauses: [], draft: { note: '来源计时', tags: [] } };
  imported.recoveryDraft = { reason: '来源草稿', timer: createIdleTimer(), createdAt: 2000 };
  imported.wishes.push(wish('wish_imported', '导入愿望', 2000));
  imported.createdAt = 2000;
  imported.updatedAt = 2001;

  const analysis = createImportAnalysis(local, imported, { mode: IMPORT_MODE.REPLACE, now: 3000 });
  const resolved = resolveImportAnalysis(analysis);

  assert.equal(analysis.conflictCount, 0);
  assert.equal(resolved.database.wishes.some((item) => item.id === 'wish_local'), false);
  assert.equal(resolved.database.wishes.some((item) => item.id === 'wish_imported'), true);
  assert.notEqual(resolved.database.localProfile.id, imported.localProfile.id);
  assert.deepEqual(resolved.database.timer, createIdleTimer());
  assert.equal(resolved.database.recoveryDraft, null);
  assert.equal(resolved.database.createdAt, 3000);
  assert.equal(resolved.database.updatedAt, 3000);
  assert.deepEqual(resolved.summary.addedCounts, addedCounts({ wishes: 1 }));
});

test('最终合并结果保留本地实体时，不会误修复导入任务的本地项目引用', () => {
  const local = database();
  const imported = database();
  local.projects.push(project('project_local', '仅本地项目'));
  imported.tasks.push(task('task_imported', '导入任务', 'project_local', '仅本地项目'));

  const resolved = resolveImportAnalysis(createImportAnalysis(local, imported, {
    mode: IMPORT_MODE.INCREMENTAL, now: NOW + 1
  }));

  assert.equal(resolved.database.tasks[0].projectId, 'project_local');
  assert.equal(resolved.summary.repairedReferenceCount, 0);
});

test('最终引用修复忽略旧直接关系字段，并只计数当前有效关系的修复', () => {
  const local = database();
  local.tasks.push(task('task_missing_refs', '任务', 'project_missing', '任务所属项目快照'));
  local.calendarEvents.push(calendarEvent('event_missing_refs', '计划', {
    projectId: 'project_missing', projectNameSnapshot: '计划项目快照',
    taskId: 'task_missing', taskNameSnapshot: '计划任务快照'
  }));
  local.repeatRules.push(repeatRule('rule_with_missing_refs', '保留规则', [revision('revision_missing_refs', {
    projectId: 'project_missing', projectNameSnapshot: '修订项目快照',
    taskId: 'task_missing', taskNameSnapshot: '修订任务快照'
  })]));
  local.occurrenceExceptions.push(occurrenceException('exception_orphan', 'rule_missing'));
  local.timeLogs.push(timeLog('log_missing_event', {
    projectId: 'project_missing', projectNameSnapshot: '日志项目快照',
    taskId: 'task_missing', taskNameSnapshot: '日志任务快照',
    calendarEventId: 'event_missing', calendarEventSummarySnapshot: '日志计划快照'
  }));
  local.timeLogs.push(timeLog('log_missing_rule', {
    originRuleId: 'rule_missing',
    originOccurrenceId: 'rule_missing:occurrence', originRuleSummarySnapshot: '日志规则快照'
  }));

  const resolved = resolveImportAnalysis(createImportAnalysis(local, database(), {
    mode: IMPORT_MODE.INCREMENTAL, now: NOW + 1
  }));
  const repairedTask = resolved.database.tasks[0];
  const repairedEvent = resolved.database.calendarEvents[0];
  const repairedRevision = resolved.database.repeatRules[0].revisions[0];
  const repairedEventLog = resolved.database.timeLogs.find((item) => item.id === 'log_missing_event');
  const repairedRuleLog = resolved.database.timeLogs.find((item) => item.id === 'log_missing_rule');

  assert.deepEqual(
    [repairedTask.projectId, repairedEvent.projectId, repairedEvent.taskId],
    [null, 'project_missing', null]
  );
  assert.deepEqual(
    [repairedRevision.projectId, repairedRevision.taskId],
    ['project_missing', null]
  );
  assert.deepEqual(
    [
      repairedEventLog.projectId,
      repairedEventLog.taskId,
      repairedEventLog.calendarEventId
    ],
    ['project_missing', 'task_missing', null]
  );
  assert.deepEqual(
    [repairedRuleLog.originRuleId, repairedRuleLog.originOccurrenceId],
    [null, 'rule_missing:occurrence']
  );
  assert.equal(repairedTask.projectNameSnapshot, '任务所属项目快照');
  assert.equal(repairedEvent.projectNameSnapshot, '计划项目快照');
  assert.equal(repairedEvent.taskNameSnapshot, '计划任务快照');
  assert.equal(repairedRevision.projectNameSnapshot, '修订项目快照');
  assert.equal(repairedRevision.taskNameSnapshot, '修订任务快照');
  assert.equal(repairedEventLog.projectNameSnapshot, '日志项目快照');
  assert.equal(repairedEventLog.taskNameSnapshot, '日志任务快照');
  assert.equal(repairedEventLog.calendarEventSummarySnapshot, '日志计划快照');
  assert.equal(repairedRuleLog.originRuleSummarySnapshot, '日志规则快照');
  assert.equal(resolved.database.occurrenceExceptions.some((item) => item.id === 'exception_orphan'), false);
  assert.equal(resolved.summary.repairedReferenceCount, 6);
  assert.equal(resolved.summary.discardedExceptionCount, 1);
});

test('USE_IMPORTED 替换为 taskless 计划后修复本机 timer 关联且不计 legacy direct IDs', () => {
  const local = database();
  local.tasks.push(task('task_local', '本机任务'));
  local.calendarEvents.push(calendarEvent('event_conflict', '本机计划', {
    taskId: 'task_local',
    taskNameSnapshot: '本机任务'
  }));
  local.timer = {
    status: 'running',
    startedAt: NOW - 60_000,
    pausedAt: null,
    pauses: [],
    draft: {
      projectId: 'legacy_project',
      projectNameSnapshot: '旧项目',
      taskId: 'task_local',
      taskNameSnapshot: '本机任务',
      calendarEventId: 'event_conflict',
      calendarEventSummarySnapshot: '本机计划快照',
      tags: []
    }
  };
  const imported = database();
  imported.calendarEvents.push(calendarEvent('event_conflict', '导入的无任务计划'));

  const resolved = resolveImportAnalysis(createImportAnalysis(local, imported, {
    mode: IMPORT_MODE.INCREMENTAL,
    now: NOW + 1
  }), CONFLICT_POLICY.USE_IMPORTED);

  assert.deepEqual(
    [
      resolved.database.timer.draft.projectId,
      resolved.database.timer.draft.taskId,
      resolved.database.timer.draft.calendarEventId,
      resolved.database.timer.draft.calendarEventSummarySnapshot
    ],
    [null, null, null, '本机计划快照']
  );
  assert.equal(resolved.summary.repairedReferenceCount, 1);
});

test('USE_IMPORTED 替换为 taskless 计划后同步修复本机 recovery 草稿', () => {
  const local = database();
  local.tasks.push(task('task_local', '本机任务'));
  local.calendarEvents.push(calendarEvent('event_conflict', '本机计划', {
    taskId: 'task_local',
    taskNameSnapshot: '本机任务'
  }));
  local.recoveryDraft = {
    reason: '等待用户恢复',
    timer: {
      ...createIdleTimer(),
      draft: {
        projectId: 'legacy_project',
        taskId: 'task_local',
        calendarEventId: 'event_conflict',
        calendarEventSummarySnapshot: '恢复计划快照'
      }
    },
    createdAt: NOW
  };
  const imported = database();
  imported.calendarEvents.push(calendarEvent('event_conflict', '导入的无任务计划'));

  const resolved = resolveImportAnalysis(createImportAnalysis(local, imported, {
    mode: IMPORT_MODE.INCREMENTAL,
    now: NOW + 1
  }), CONFLICT_POLICY.USE_IMPORTED);

  const draft = resolved.database.recoveryDraft.timer.draft;
  assert.deepEqual(
    [draft.projectId, draft.taskId, draft.calendarEventId, draft.calendarEventSummarySnapshot],
    [null, null, null, '恢复计划快照']
  );
  assert.equal(resolved.summary.repairedReferenceCount, 1);
});

test('规则冲突使本机 origin 草稿命中 taskless 实例时清除完整 pair', () => {
  const local = database();
  local.tasks.push(task('task_local', '本机任务'));
  local.repeatRules.push(repeatRule('rule_conflict', '本机规则', [{
    ...revision('revision_conflict', { taskId: 'task_local', taskNameSnapshot: '本机任务' }),
    frequency: 'daily',
    weekdays: []
  }]));
  local.timer = {
    status: 'running',
    startedAt: NOW - 60_000,
    pausedAt: null,
    pauses: [],
    draft: {
      originRuleId: 'rule_conflict',
      originOccurrenceId: `rule_conflict:1:${NOW}`,
      originRuleSummarySnapshot: '本机规则快照',
      tags: []
    }
  };
  const imported = database();
  imported.repeatRules.push(repeatRule('rule_conflict', '导入的无任务规则', [{
    ...revision('revision_conflict'),
    frequency: 'daily',
    weekdays: []
  }], NOW + 1));

  const resolved = resolveImportAnalysis(createImportAnalysis(local, imported, {
    mode: IMPORT_MODE.INCREMENTAL,
    now: NOW + 2
  }), CONFLICT_POLICY.USE_IMPORTED);

  assert.deepEqual(
    [
      resolved.database.timer.draft.originRuleId,
      resolved.database.timer.draft.originOccurrenceId,
      resolved.database.timer.draft.originRuleSummarySnapshot
    ],
    [null, null, '本机规则快照']
  );
  assert.equal(resolved.summary.repairedReferenceCount, 1);
});

test('导入六个活动项目不受新增项目上限拒绝，并在摘要中如实报告', () => {
  const imported = database();
  for (let index = 1; index <= 6; index += 1) {
    imported.projects.push(project(`project_${index}`, `项目${index}`));
  }

  const resolved = resolveImportAnalysis(createImportAnalysis(database(), imported, {
    mode: IMPORT_MODE.INCREMENTAL, now: NOW + 1
  }));

  assert.equal(resolved.database.projects.length, 6);
  assert.equal(resolved.summary.activeProjectCount, 6);
});
