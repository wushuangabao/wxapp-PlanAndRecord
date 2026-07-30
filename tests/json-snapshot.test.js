const test = require('node:test');
const assert = require('node:assert/strict');
const { createInitialDatabase, createIdleTimer } = require('../miniprogram/domain/entities');
const { LocalRepository } = require('../miniprogram/repository/local-repository');
const { ApplicationService } = require('../miniprogram/services/application-service');
const { exportJson } = require('../miniprogram/services/export-service');
const {
  parseJsonSnapshot,
  validateJsonSnapshot,
  persistedValueEquals
} = require('../miniprogram/repository/json-snapshot');

const NOW = 1_700_000_000_000;

function completeSnapshot(now = NOW) {
  const database = createInitialDatabase(now);
  database.timer = createIdleTimer();
  return database;
}

function copySnapshot() {
  return JSON.parse(JSON.stringify(completeSnapshot()));
}

function expectSchemaInvalid(mutator) {
  const database = copySnapshot();
  mutator(database);
  assert.throws(() => validateJsonSnapshot(database), (error) => error.code === 'IMPORT_SCHEMA_INVALID');
}

function expectDuplicateId(mutator) {
  const database = copySnapshot();
  mutator(database);
  assert.throws(() => validateJsonSnapshot(database), (error) => error.code === 'IMPORT_DUPLICATE_ID');
}

function validProject() {
  return {
    id: 'project_1', title: '项目', deadlineAt: NOW + 86_400_000, status: 'active',
    objectives: [{ id: 'objective_1', title: '目标', keyResults: [{ id: 'key_result_1', title: '结果', currentValue: 0 }] }],
    createdAt: NOW, updatedAt: NOW
  };
}

function validTask() {
  return { id: 'task_1', title: '任务', status: 'todo', projectId: null, projectNameSnapshot: null, completedAt: null, createdAt: NOW, updatedAt: NOW };
}

function validEvent() {
  return {
    id: 'event_1', title: '计划', startedAt: NOW, endedAt: NOW + 3_600_000, priority: 1,
    projectId: null, projectNameSnapshot: null, taskId: null, taskNameSnapshot: null,
    repeatRuleId: null, repeatRuleSummarySnapshot: null, createdAt: NOW, updatedAt: NOW
  };
}

function validRevision() {
  return {
    id: 'revision_1', revision: 1, effectiveFrom: NOW, effectiveUntil: null,
    frequency: 'weekly', interval: 1, weekdays: [1], monthDay: null,
    startedAt: NOW, endedAt: NOW + 3_600_000, priority: 1,
    projectId: null, projectNameSnapshot: null, taskId: null, taskNameSnapshot: null
  };
}

function validRule() {
  return { id: 'rule_1', title: '重复计划', revisions: [validRevision()], createdAt: NOW, updatedAt: NOW };
}

function validException() {
  return { id: 'exception_1', ruleId: 'rule_1', occurrenceStart: NOW, kind: 'skip', override: null, createdAt: NOW, updatedAt: NOW };
}

function validOverrideException(override = {}) {
  return {
    id: 'exception_override_1',
    ruleId: 'rule_1',
    occurrenceStart: NOW,
    kind: 'override',
    override: {
      title: '临时调整',
      startedAt: NOW + 60_000,
      endedAt: NOW + 120_000,
      priority: 2,
      projectId: null,
      projectNameSnapshot: null,
      taskId: null,
      taskNameSnapshot: null,
      ...override
    },
    createdAt: NOW,
    updatedAt: NOW
  };
}

function validLog() {
  return {
    id: 'log_1', schemaVersion: 1, startedAt: NOW, endedAt: NOW + 3_600_000, durationMinutes: 60,
    projectId: null, projectNameSnapshot: null, taskId: null, taskNameSnapshot: null,
    calendarEventId: null, calendarEventSummarySnapshot: null,
    note: '', status: 'confirmed', source: 'manual', originRuleId: null, originOccurrenceId: null,
    originRuleSummarySnapshot: null, tags: [], createdAt: NOW, updatedAt: NOW
  };
}

function createService(now = NOW) {
  class MemoryStorage {
    get(key) { return this[key]; }
    set(key, value) { this[key] = value; }
  }
  const storage = new MemoryStorage();
  const repository = new LocalRepository(storage, { now: () => now });
  const service = new ApplicationService(repository, { now: () => now });
  service.initialize();
  return service;
}

test('合法的当前版本全量快照可以解析并返回克隆', () => {
  const database = completeSnapshot();
  const parsed = parseJsonSnapshot(JSON.stringify(database));
  assert.equal(parsed.schemaVersion, 1);
  assert.notEqual(parsed, database);
});

test('解析会忽略未知字段，但保留已知字段的严格校验', () => {
  const database = copySnapshot();
  database.legacyRootField = 'ignored';
  database.localProfile.legacyProfileField = true;
  database.projects.push(validProject());
  database.projects[0].legacyProjectField = 'ignored';
  database.projects[0].objectives[0].legacyObjectiveField = 'ignored';
  database.projects[0].objectives[0].keyResults[0].targetValue = 100;
  database.timer.draft.legacyDraftField = 'ignored';

  const parsed = parseJsonSnapshot(JSON.stringify(database));
  const keyResult = parsed.projects[0].objectives[0].keyResults[0];

  assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'legacyRootField'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.localProfile, 'legacyProfileField'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.projects[0], 'legacyProjectField'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.projects[0].objectives[0], 'legacyObjectiveField'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(keyResult, 'targetValue'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.timer.draft, 'legacyDraftField'), false);

  database.projects[0].objectives[0].keyResults[0].currentValue = 101;
  assert.throws(() => parseJsonSnapshot(JSON.stringify(database)), (error) => error.code === 'IMPORT_SCHEMA_INVALID');
});

test('旧 Category 字段按未知字段忽略且不迁移为标签', () => {
  const database = copySnapshot();
  database.categories = [{
    id: 'category_legacy',
    name: '旧分类',
    status: 'active',
    isSystem: false,
    createdAt: NOW,
    updatedAt: NOW
  }];
  database.timeLogs.push({
    ...validLog(),
    categoryId: 'category_legacy',
    categoryNameSnapshot: '旧分类'
  });
  database.timer.draft = {
    categoryId: 'category_legacy',
    categoryNameSnapshot: '旧分类'
  };

  const parsed = parseJsonSnapshot(JSON.stringify(database));

  assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'categories'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.timeLogs[0], 'categoryId'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.timeLogs[0], 'categoryNameSnapshot'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.timer.draft, 'categoryId'), false);
  assert.deepEqual(parsed.timeLogs[0].tags, []);
});

test('JSON 标签规范化去空去重但不执行用户数量和长度上限', () => {
  const database = copySnapshot();
  const oversized = Array.from({ length: 11 }, (_, index) => `标签${index}`);
  database.timeLogs.push({
    ...validLog(),
    tags: [' ＡＩ ', '', 'AI', '超过五个字符', ...oversized]
  });
  database.timer.draft = {
    tags: [' 草稿 ', '草稿', '', '超过五个字符']
  };
  database.recoveryDraft = {
    reason: '等待用户恢复',
    timer: {
      ...createIdleTimer(),
      draft: { tags: [' 恢复  草稿 ', '恢复 草稿', ''] }
    },
    createdAt: NOW
  };

  const parsed = parseJsonSnapshot(JSON.stringify(database));

  assert.deepEqual(
    parsed.timeLogs[0].tags,
    ['AI', '超过五个字符', ...oversized]
  );
  assert.deepEqual(parsed.timer.draft.tags, ['草稿', '超过五个字符']);
  assert.deepEqual(parsed.recoveryDraft.timer.draft.tags, ['恢复 草稿']);
});

test('JSON 标签非法类型统一报告 IMPORT_SCHEMA_INVALID', () => {
  const database = copySnapshot();
  database.timeLogs.push({ ...validLog(), tags: ['有效', 1] });

  assert.throws(
    () => parseJsonSnapshot(JSON.stringify(database)),
    (error) => error.code === 'IMPORT_SCHEMA_INVALID'
  );
});

test('导出会移除各层遗留字段，且输出仍可被当前解析器读取', () => {
  const database = copySnapshot();
  database.projects.push(validProject());
  database.tasks.push(validTask());
  database.calendarEvents.push(validEvent());
  database.repeatRules.push(validRule());
  database.occurrenceExceptions.push(validOverrideException());
  database.timeLogs.push(validLog());
  database.recoveryDraft = {
    reason: '等待用户修复',
    timer: { status: 'running', startedAt: null, endedAt: NOW, pausedAt: NOW, pauses: [], draft: { tags: [] } },
    createdAt: NOW
  };
  database.projects[0].legacyProjectField = true;
  database.repeatRules[0].revisions[0].legacyRevisionField = true;
  database.occurrenceExceptions[0].override.legacyOverrideField = true;
  database.timeLogs[0].legacyLogField = true;
  database.timer.draft.legacyDraftField = true;
  database.recoveryDraft.timer.legacyTimerField = true;

  const exported = JSON.parse(exportJson(database));

  assert.equal(Object.prototype.hasOwnProperty.call(exported.projects[0], 'legacyProjectField'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(exported.repeatRules[0].revisions[0], 'legacyRevisionField'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(exported.occurrenceExceptions[0].override, 'legacyOverrideField'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(exported.timeLogs[0], 'legacyLogField'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(exported.timer.draft, 'legacyDraftField'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(exported.recoveryDraft.timer, 'legacyTimerField'), false);
  assert.doesNotThrow(() => parseJsonSnapshot(JSON.stringify(exported)));
});

test('重复计划实例关联在计时器、恢复草稿和 JSON 往返中保留', () => {
  const originDraft = {
    originRuleId: 'rule_1',
    originOccurrenceId: `rule_1:1:${NOW}`,
    originRuleSummarySnapshot: '每周重复计划',
    tags: []
  };
  const database = copySnapshot();
  database.timer.draft = { ...originDraft };
  database.recoveryDraft = {
    reason: '等待用户恢复',
    timer: {
      status: 'running',
      startedAt: NOW,
      endedAt: null,
      pausedAt: null,
      pauses: [],
      draft: { ...originDraft }
    },
    createdAt: NOW
  };

  const parsed = parseJsonSnapshot(JSON.stringify(database));
  const exported = JSON.parse(exportJson(database));

  assert.deepEqual(parsed.timer.draft, originDraft);
  assert.deepEqual(parsed.recoveryDraft.timer.draft, originDraft);
  assert.deepEqual(exported.timer.draft, originDraft);
  assert.deepEqual(exported.recoveryDraft.timer.draft, originDraft);
});

test('日志 JSON 拒绝具体计划与 origin 混用，并区分完整关联和历史实例追溯', () => {
  expectSchemaInvalid((database) => {
    database.timeLogs.push({
      ...validLog(),
      calendarEventId: 'event_1',
      originRuleId: 'rule_1',
      originOccurrenceId: 'rule_1:1'
    });
  });
  expectSchemaInvalid((database) => {
    database.timeLogs.push({
      ...validLog(),
      originRuleId: 'rule_1'
    });
  });

  const historicalTrace = copySnapshot();
  historicalTrace.timeLogs.push({
    ...validLog(),
    projectId: 'legacy_project',
    taskId: 'legacy_task',
    originOccurrenceId: 'deleted_rule:1'
  });
  assert.doesNotThrow(() => validateJsonSnapshot(historicalTrace));

  const completeOrigin = copySnapshot();
  completeOrigin.timeLogs.push({
    ...validLog(),
    originRuleId: 'rule_1',
    originOccurrenceId: 'rule_1:1'
  });
  assert.doesNotThrow(() => validateJsonSnapshot(completeOrigin));
});

test('计时与恢复草稿 JSON 要求具体计划和完整 origin 二选一', () => {
  expectSchemaInvalid((database) => {
    database.timer = {
      ...createIdleTimer(),
      draft: {
        calendarEventId: 'event_1',
        originRuleId: 'rule_1',
        originOccurrenceId: 'rule_1:1'
      }
    };
  });
  expectSchemaInvalid((database) => {
    database.timer = {
      ...createIdleTimer(),
      draft: { originRuleId: 'rule_1' }
    };
  });
  expectSchemaInvalid((database) => {
    database.recoveryDraft = {
      reason: '等待恢复',
      timer: {
        ...createIdleTimer(),
        draft: { originOccurrenceId: 'rule_1:1' }
      },
      createdAt: NOW
    };
  });

  const database = copySnapshot();
  database.timer = {
    ...createIdleTimer(),
    draft: {
      projectId: 'legacy_project',
      taskId: 'legacy_task',
      originRuleId: 'rule_1',
      originOccurrenceId: 'rule_1:1'
    }
  };
  assert.doesNotThrow(() => validateJsonSnapshot(database));
});

test('结构化比较忽略对象属性顺序但保留数组顺序和时间字段', () => {
  assert.equal(persistedValueEquals({ id: 'wish_1', title: 'A' }, { title: 'A', id: 'wish_1' }), true);
  assert.equal(persistedValueEquals({ tags: ['a', 'b'] }, { tags: ['b', 'a'] }), false);
  assert.equal(persistedValueEquals({ updatedAt: 1 }, { updatedAt: 2 }), false);
});

test('JSON 解析错误、非文本和非普通对象根均被拒绝', () => {
  assert.throws(() => parseJsonSnapshot('{'), (error) => error.code === 'IMPORT_JSON_INVALID');
  assert.throws(() => parseJsonSnapshot({}), (error) => error.code === 'IMPORT_JSON_INVALID');
  for (const root of [null, [], 'text', 1]) {
    assert.throws(() => validateJsonSnapshot(root), (error) => error.code === 'IMPORT_SCHEMA_INVALID');
  }
});

test('根级必填字段逐一缺失时被拒绝', () => {
  for (const field of ['schemaVersion', 'localProfile', 'wishes', 'projects', 'tasks', 'calendarEvents', 'repeatRules', 'occurrenceExceptions', 'timeLogs', 'timer', 'recoveryDraft', 'createdAt', 'updatedAt']) {
    expectSchemaInvalid((database) => { delete database[field]; });
  }
});

test('七个顶层集合必须都是数组', () => {
  for (const field of ['wishes', 'projects', 'tasks', 'calendarEvents', 'repeatRules', 'occurrenceExceptions', 'timeLogs']) {
    expectSchemaInvalid((database) => { database[field] = {}; });
  }
});

test('schemaVersion 缺失、过低、过高或非整数时被拒绝', () => {
  expectSchemaInvalid((database) => { delete database.schemaVersion; });
  assert.throws(() => validateJsonSnapshot({ ...completeSnapshot(), schemaVersion: 0 }), (error) => error.code === 'IMPORT_SCHEMA_UNSUPPORTED');
  assert.throws(() => validateJsonSnapshot({ ...completeSnapshot(), schemaVersion: 2 }), (error) => error.code === 'IMPORT_SCHEMA_UNSUPPORTED');
  expectSchemaInvalid((database) => { database.schemaVersion = 1.1; });
});

test('根时间戳和 localProfile 时间戳不做隐式类型转换', () => {
  expectSchemaInvalid((database) => { database.createdAt = String(NOW); });
  expectSchemaInvalid((database) => { database.localProfile.updatedAt = String(NOW); });
});

test('愿望、项目、目标和关键结果字段类型严格校验', () => {
  expectSchemaInvalid((database) => { database.wishes.push({ id: 'wish_1', title: 1, createdAt: NOW, updatedAt: NOW }); });
  expectSchemaInvalid((database) => { database.projects.push({ ...validProject(), deadlineAt: String(NOW) }); });
  expectSchemaInvalid((database) => { database.projects.push({ ...validProject(), objectives: {} }); });
  expectSchemaInvalid((database) => { database.projects.push({ ...validProject(), objectives: [{ ...validProject().objectives[0], keyResults: [{ ...validProject().objectives[0].keyResults[0], currentValue: 101 }] }] }); });
});

test('任务、日历事件和重复规则字段类型与枚举严格校验', () => {
  expectSchemaInvalid((database) => { database.tasks.push({ ...validTask(), status: 'active' }); });
  expectSchemaInvalid((database) => { database.tasks.push({ ...validTask(), status: 'inbox' }); });
  expectSchemaInvalid((database) => { database.tasks.push({ ...validTask(), completedAt: String(NOW) }); });
  expectSchemaInvalid((database) => { database.calendarEvents.push({ ...validEvent(), endedAt: NOW }); });
  expectSchemaInvalid((database) => { database.calendarEvents.push({ ...validEvent(), priority: 4 }); });
  expectSchemaInvalid((database) => { database.repeatRules.push({ ...validRule(), revisions: [] }); });
  expectSchemaInvalid((database) => { database.repeatRules.push({ ...validRule(), revisions: [{ ...validRevision(), frequency: 'yearly' }] }); });
  expectSchemaInvalid((database) => { database.repeatRules.push({ ...validRule(), revisions: [{ ...validRevision(), interval: 0 }] }); });
  expectSchemaInvalid((database) => { database.repeatRules.push({ ...validRule(), revisions: [{ ...validRevision(), weekdays: [7] }] }); });
  expectSchemaInvalid((database) => { database.repeatRules.push({ ...validRule(), revisions: [{ ...validRevision(), monthDay: 32 }] }); });
});

test('例外、日志、计时器和恢复草稿字段类型严格校验', () => {
  expectSchemaInvalid((database) => { database.occurrenceExceptions.push({ ...validException(), kind: 'delete' }); });
  expectSchemaInvalid((database) => { database.occurrenceExceptions.push({ ...validException(), override: {} }); });
  expectSchemaInvalid((database) => { database.timeLogs.push({ ...validLog(), durationMinutes: '60' }); });
  expectSchemaInvalid((database) => { database.timeLogs.push({ ...validLog(), source: 'remote' }); });
  expectSchemaInvalid((database) => { database.timeLogs.push({ ...validLog(), tags: ['ok', 1] }); });
  expectSchemaInvalid((database) => { database.timer = { ...createIdleTimer(), status: 'broken' }; });
  expectSchemaInvalid((database) => { database.timer = { ...createIdleTimer(), draft: { note: 1 } }; });
  expectSchemaInvalid((database) => { database.timer = { ...createIdleTimer(), draft: { originRuleId: 1 } }; });
  expectSchemaInvalid((database) => { database.timer = { ...createIdleTimer(), draft: { originOccurrenceId: 1 } }; });
  expectSchemaInvalid((database) => { database.timer = { ...createIdleTimer(), draft: { originRuleSummarySnapshot: 1 } }; });
  expectSchemaInvalid((database) => { database.recoveryDraft = { reason: 1, timer: createIdleTimer(), createdAt: NOW }; });
  expectSchemaInvalid((database) => { database.recoveryDraft = { reason: '恢复', timer: { ...createIdleTimer(), pauses: {} }, createdAt: NOW }; });
});

test('持久化标签必须已经规范化、非空且唯一，但允许超出用户上限', () => {
  for (const tags of [[' 未规范 '], [''], ['重复', '重复']]) {
    expectSchemaInvalid((database) => {
      database.timeLogs.push({ ...validLog(), tags });
    });
  }

  const database = copySnapshot();
  database.timeLogs.push({
    ...validLog(),
    tags: ['超过五个字符', ...Array.from({ length: 11 }, (_, index) => `标签${index}`)]
  });
  assert.doesNotThrow(() => validateJsonSnapshot(database));
});

test('完整合法的 override 例外通过校验', () => {
  const database = copySnapshot();
  database.repeatRules.push(validRule());
  database.occurrenceExceptions.push(validOverrideException());
  assert.doesNotThrow(() => validateJsonSnapshot(database));
});

test('override 的 title 类型错误被拒绝', () => {
  expectSchemaInvalid((database) => { database.occurrenceExceptions.push(validOverrideException({ title: 1 })); });
});

test('override 的时间类型错误或逆序被拒绝', () => {
  expectSchemaInvalid((database) => { database.occurrenceExceptions.push(validOverrideException({ startedAt: String(NOW) })); });
  expectSchemaInvalid((database) => { database.occurrenceExceptions.push(validOverrideException({ endedAt: String(NOW) })); });
  expectSchemaInvalid((database) => {
    database.occurrenceExceptions.push(validOverrideException({ startedAt: NOW + 120_000, endedAt: NOW + 60_000 }));
  });
});

test('override 的 priority 越界被拒绝', () => {
  expectSchemaInvalid((database) => { database.occurrenceExceptions.push(validOverrideException({ priority: 4 })); });
});

test('override 的关联 ID 和名称快照类型错误被拒绝', () => {
  for (const field of ['projectId', 'projectNameSnapshot', 'taskId', 'taskNameSnapshot']) {
    expectSchemaInvalid((database) => { database.occurrenceExceptions.push(validOverrideException({ [field]: 1 })); });
  }
});

test('真实服务 startTimer 后的 running 快照通过校验', () => {
  const service = createService();
  service.startTimer({ note: '开始' });
  assert.doesNotThrow(() => validateJsonSnapshot(service.snapshot()));
});

test('真实服务 pauseTimer 后的 paused 快照通过校验', () => {
  const service = createService();
  service.startTimer({ note: '暂停' });
  service.pauseTimer();
  assert.doesNotThrow(() => validateJsonSnapshot(service.snapshot()));
});

test('真实服务同毫秒暂停恢复产生的零时长 pause 是合法快照', () => {
  const service = createService();
  service.startTimer({ note: '同毫秒操作' });
  service.pauseTimer();
  service.resumeTimer();

  const snapshot = service.snapshot();
  assert.deepEqual(snapshot.timer.pauses, [{ startedAt: NOW, endedAt: NOW }]);
  assert.doesNotThrow(() => validateJsonSnapshot(snapshot));
});

test('真实服务 finishTimer 后的 ended 快照通过校验', () => {
  const service = createService();
  service.startTimer({ note: '结束' });
  service.finishTimer();
  assert.doesNotThrow(() => validateJsonSnapshot(service.snapshot()));
});

test('日志时长不得超过墙钟分钟上限', () => {
  expectSchemaInvalid((database) => { database.timeLogs.push({ ...validLog(), durationMinutes: 61 }); });
});

test('日志允许零时长和扣除暂停后小于墙钟上限的时长', () => {
  const database = copySnapshot();
  database.timeLogs.push({ ...validLog(), id: 'log_zero', durationMinutes: 0 });
  database.timeLogs.push({ ...validLog(), id: 'log_paused', durationMinutes: 45, source: 'timer' });
  assert.doesNotThrow(() => validateJsonSnapshot(database));
});

test('根 timer 拒绝与状态机矛盾的时间戳组合', () => {
  expectSchemaInvalid((database) => { database.timer = { ...createIdleTimer(), startedAt: NOW }; });
  expectSchemaInvalid((database) => { database.timer = { ...createIdleTimer(), status: 'running' }; });
  expectSchemaInvalid((database) => {
    database.timer = { ...createIdleTimer(), status: 'paused', startedAt: NOW, pausedAt: null };
  });
  expectSchemaInvalid((database) => {
    database.timer = { ...createIdleTimer(), status: 'ended', startedAt: NOW, endedAt: null };
  });
});

test('根 timer 非 idle 状态必须持久化可为空的规范化标签数组', () => {
  const activeTimers = [{
    ...createIdleTimer(),
    status: 'running',
    startedAt: NOW
  }, {
    ...createIdleTimer(),
    status: 'paused',
    startedAt: NOW,
    pausedAt: NOW + 1_000
  }, {
    ...createIdleTimer(),
    status: 'ended',
    startedAt: NOW,
    endedAt: NOW + 1_000
  }];

  activeTimers.forEach((timer) => {
    expectSchemaInvalid((database) => {
      database.timer = { ...timer, draft: {} };
    });
    const database = copySnapshot();
    database.timer = { ...timer, draft: { tags: [] } };
    assert.doesNotThrow(() => validateJsonSnapshot(database));
  });

  expectSchemaInvalid((database) => {
    database.recoveryDraft = {
      reason: '等待用户修复',
      timer: {
        status: 'running',
        startedAt: null,
        endedAt: NOW,
        pausedAt: NOW,
        pauses: [],
        draft: {}
      },
      createdAt: NOW
    };
  });
});

test('根 timer 的 pause 必须有序、不重叠并处于主计时边界内', () => {
  expectSchemaInvalid((database) => {
    database.timer = {
      ...createIdleTimer(), status: 'ended', startedAt: NOW, endedAt: NOW + 4_000,
      pauses: [{ startedAt: NOW + 1_000, endedAt: NOW + 3_000 }, { startedAt: NOW + 2_000, endedAt: NOW + 4_000 }]
    };
  });
  expectSchemaInvalid((database) => {
    database.timer = {
      ...createIdleTimer(), status: 'ended', startedAt: NOW, endedAt: NOW + 4_000,
      pauses: [{ startedAt: NOW + 1_000, endedAt: NOW + 5_000 }]
    };
  });
  expectSchemaInvalid((database) => {
    database.timer = {
      ...createIdleTimer(), status: 'paused', startedAt: NOW, pausedAt: NOW + 2_000,
      pauses: [{ startedAt: NOW + 1_000, endedAt: NOW + 3_000 }]
    };
  });
});

test('recoveryDraft 保留结构有效但状态异常的原始 timer', () => {
  const database = copySnapshot();
  database.recoveryDraft = {
    reason: '等待用户修复',
    timer: {
      status: 'running', startedAt: null, endedAt: NOW, pausedAt: NOW,
      pauses: [{ startedAt: NOW, endedAt: NOW }], draft: { tags: [] }
    },
    createdAt: NOW
  };
  assert.doesNotThrow(() => validateJsonSnapshot(database));
});

test('重复 ID 包括顶层实体、嵌套目标、关键结果和修订均被拒绝', () => {
  expectDuplicateId((database) => { database.wishes.push({ id: database.localProfile.id, title: '重复', createdAt: NOW, updatedAt: NOW }); });
  expectDuplicateId((database) => { database.projects.push({ ...validProject(), objectives: [{ ...validProject().objectives[0] }, { ...validProject().objectives[0], id: 'objective_1' }] }); });
  expectDuplicateId((database) => { database.projects.push({ ...validProject(), objectives: [{ ...validProject().objectives[0], keyResults: [{ ...validProject().objectives[0].keyResults[0] }, { ...validProject().objectives[0].keyResults[0], id: 'key_result_1' }] }] }); });
  expectDuplicateId((database) => { database.repeatRules.push({ ...validRule(), revisions: [{ ...validRevision() }, { ...validRevision(), revision: 2 }] }); });
});

test('校验错误信息不泄漏 JSON 中的实体正文', () => {
  const sentinel = 'PRIVATE_IMPORT_SENTINEL_749';
  const database = completeSnapshot();
  database.wishes.push({ id: 'wish_1', title: sentinel, createdAt: NOW, updatedAt: 'invalid' });
  assert.throws(() => parseJsonSnapshot(JSON.stringify(database)), (error) => error.code === 'IMPORT_SCHEMA_INVALID' && !error.message.includes(sentinel));
});
