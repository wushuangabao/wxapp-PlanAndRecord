const test = require('node:test');
const assert = require('node:assert/strict');
const { createCalendarEvent, createInitialDatabase, createIdleTimer } = require('../miniprogram/domain/entities');
const { LocalRepository } = require('../miniprogram/repository/local-repository');
const { MemoryStorageAdapter } = require('../miniprogram/repository/storage-adapter');
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
    createdAt: NOW, updatedAt: NOW
  };
}

function assertNoLegacyRepeatSeedFields(event) {
  assert.ok(event);
  ['repeatRuleId', 'repeatRuleSummarySnapshot'].forEach((field) => {
    assert.equal(Object.hasOwn(event, field), false);
  });
}

test('CalendarEvent 首版契约不包含重复规则种子字段', () => {
  const event = createCalendarEvent({
    title: '普通计划',
    startedAt: NOW,
    endedAt: NOW + 3_600_000,
    priority: 1
  }, NOW);

  assert.equal(Object.hasOwn(event, 'repeatRuleId'), false);
  assert.equal(Object.hasOwn(event, 'repeatRuleSummarySnapshot'), false);
});

test('旧 CalendarEvent 重复规则种子字段按未知字段丢弃且不迁移', () => {
  const database = copySnapshot();
  database.calendarEvents.push({
    ...validEvent(),
    repeatRuleId: 'rule_1',
    repeatRuleSummarySnapshot: '旧固定日程'
  });
  database.repeatRules.push(validRule());

  const parsed = parseJsonSnapshot(JSON.stringify(database));
  const event = parsed.calendarEvents.find((item) => item.id === 'event_1');

  assert.equal(parsed.schemaVersion, 1);
  assertNoLegacyRepeatSeedFields(event);
});

function validRevision() {
  return {
    id: 'revision_1', revision: 1, effectiveFrom: NOW, effectiveUntil: null,
    frequency: 'weekly', interval: 1, weekdays: [1], monthDays: [],
    startedAt: NOW, endedAt: NOW + 3_600_000, priority: 1,
    projectId: null, projectNameSnapshot: null, taskId: null, taskNameSnapshot: null
  };
}

function validRule() {
  return { id: 'rule_1', title: '重复计划', revisions: [validRevision()], createdAt: NOW, updatedAt: NOW };
}

function validException() {
  return {
    id: 'exception_skip',
    ruleId: 'rule_1',
    occurrenceStart: NOW,
    kind: 'skip',
    createdAt: NOW,
    updatedAt: NOW
  };
}

function validLog() {
  return {
    id: 'log_1', schemaVersion: 1, startedAt: NOW, endedAt: NOW + 3_600_000,
    pausedDurationSeconds: 0, durationMinutes: 60,
    projectId: null, projectNameSnapshot: null, taskId: null, taskNameSnapshot: null,
    calendarEventId: null, calendarEventSummarySnapshot: null,
    note: '', status: 'confirmed', source: 'manual', originRuleId: null, originOccurrenceId: null,
    originRuleSummarySnapshot: null, tags: [], createdAt: NOW, updatedAt: NOW
  };
}

test('同版本旧 TimeLog 缺失暂停秒数时同步重算非边界派生分钟', () => {
  const database = copySnapshot();
  const legacyLog = {
    ...validLog(),
    endedAt: NOW + 61_000,
    durationMinutes: 1,
    updatedAt: NOW + 61_000
  };
  delete legacyLog.pausedDurationSeconds;
  database.timeLogs.push(legacyLog);

  const parsed = parseJsonSnapshot(JSON.stringify(database));
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.timeLogs[0].pausedDurationSeconds, 0);
  assert.equal(parsed.timeLogs[0].durationMinutes, 2);

  const exported = JSON.parse(exportJson(parsed));
  assert.equal(exported.schemaVersion, 1);
  assert.equal(exported.timeLogs[0].pausedDurationSeconds, 0);
  assert.equal(exported.timeLogs[0].durationMinutes, 2);
});

test('同版本旧 TimeLog 的 20 秒零分钟记录规范化为 1 分钟', () => {
  const database = copySnapshot();
  const legacyLog = {
    ...validLog(),
    endedAt: NOW + 20_000,
    durationMinutes: 0,
    updatedAt: NOW + 20_000
  };
  delete legacyLog.pausedDurationSeconds;
  database.timeLogs.push(legacyLog);

  const parsed = parseJsonSnapshot(JSON.stringify(database));

  assert.equal(parsed.timeLogs[0].pausedDurationSeconds, 0);
  assert.equal(parsed.timeLogs[0].durationMinutes, 1);
});

test('TimeLog 显式暂停为 0 时不会修正错误的派生分钟', () => {
  const database = copySnapshot();
  database.timeLogs.push({
    ...validLog(),
    endedAt: NOW + 61_000,
    pausedDurationSeconds: 0,
    durationMinutes: 1,
    updatedAt: NOW + 61_000
  });

  assert.throws(
    () => parseJsonSnapshot(JSON.stringify(database)),
    (error) => error.code === 'IMPORT_SCHEMA_INVALID'
  );
});

test('TimeLog 暂停秒数和派生分钟数必须严格符合秒级公式', () => {
  const invalidCases = [
    ['负数', { pausedDurationSeconds: -1 }],
    ['小数', { pausedDurationSeconds: 0.5 }],
    ['字符串', { pausedDurationSeconds: '0' }],
    ['等于区间总秒数', { pausedDurationSeconds: 3_600 }],
    ['大于区间总秒数', { pausedDurationSeconds: 3_601 }],
    ['分钟数低于公式', { durationMinutes: 59 }],
    ['分钟数高于公式', { durationMinutes: 61 }]
  ];

  for (const [label, patch] of invalidCases) {
    const database = copySnapshot();
    database.timeLogs.push({ ...validLog(), ...patch });
    assert.throws(
      () => validateJsonSnapshot(database),
      (error) => error.code === 'IMPORT_SCHEMA_INVALID',
      label
    );
  }
});

test('TimeLog 缺失暂停字段与显式 0 规范化后持久化内容相同', () => {
  const explicit = copySnapshot();
  explicit.timeLogs.push({
    ...validLog(),
    endedAt: NOW + 61_000,
    durationMinutes: 2,
    updatedAt: NOW + 61_000
  });
  const missing = JSON.parse(JSON.stringify(explicit));
  const legacyLog = {
    ...validLog(),
    endedAt: NOW + 61_000,
    durationMinutes: 1,
    updatedAt: NOW + 61_000
  };
  delete legacyLog.pausedDurationSeconds;
  missing.timeLogs = [legacyLog];

  assert.equal(
    persistedValueEquals(
      parseJsonSnapshot(JSON.stringify(missing)),
      parseJsonSnapshot(JSON.stringify(explicit))
    ),
    true
  );
});

function createService(now = NOW) {
  const storage = new MemoryStorageAdapter();
  const clock = typeof now === 'function' ? now : () => now;
  const repository = new LocalRepository(storage, { now: clock });
  const service = new ApplicationService(repository, { now: clock });
  service.initialize();
  return service;
}

test('合法的当前版本全量快照可以解析并返回克隆', () => {
  const database = completeSnapshot();
  const parsed = parseJsonSnapshot(JSON.stringify(database));
  assert.equal(parsed.schemaVersion, 1);
  assert.notEqual(parsed, database);
});

test('JSON 快照导入时丢弃项目中的 OKR 字段', () => {
  const database = copySnapshot();
  database.projects.push({
    ...validProject(),
    objectives: [{ id: 'legacy_objective', title: '旧目标', keyResults: [{ id: 'legacy_result', title: '旧结果', currentValue: 20 }] }]
  });

  const parsed = parseJsonSnapshot(JSON.stringify(database));
  assert.equal(Object.hasOwn(parsed.projects[0], 'objectives'), false);
});

test('JSON 快照的五类真实标题统一按 Unicode 码点 trim 和校验', () => {
  const emoji = '🙂';
  const titleFields = [
    ['Wish', (database, title) => { database.wishes.push({ id: 'wish_1', title, createdAt: NOW, updatedAt: NOW }); }],
    ['Project', (database, title) => { database.projects.push({ ...validProject(), title }); }],
    ['Task', (database, title) => { database.tasks.push({ ...validTask(), title }); }],
    ['CalendarEvent', (database, title) => { database.calendarEvents.push({ ...validEvent(), title }); }],
    ['RepeatRule', (database, title) => { database.repeatRules.push({ ...validRule(), title }); }]
  ];

  for (const [label, insert] of titleFields) {
    const accepted = copySnapshot();
    insert(accepted, `  ${emoji.repeat(25)}  `);
    const parsed = parseJsonSnapshot(JSON.stringify(accepted));
    const exported = JSON.stringify(parsed);
    assert.equal(exported.includes(`  ${emoji}`), false, `${label} 应 trim`);
    assert.equal(exported.includes(emoji.repeat(25)), true, `${label} 应接受 25 个 emoji`);

    const rejected = copySnapshot();
    insert(rejected, emoji.repeat(26));
    assert.throws(
      () => parseJsonSnapshot(JSON.stringify(rejected)),
      (error) => error.code === 'IMPORT_SCHEMA_INVALID',
      `${label} 应拒绝 26 个 emoji`
    );
  }
});

test('JSON 修订 pattern 按频率规范无关字段并排序多选值', () => {
  const daily = copySnapshot();
  daily.repeatRules.push({
    ...validRule(),
    revisions: [{
      ...validRevision(),
      frequency: 'daily',
      weekdays: [6, 1],
      monthDays: [18]
    }]
  });
  const parsedDaily = parseJsonSnapshot(JSON.stringify(daily)).repeatRules[0].revisions[0];
  assert.deepEqual(
    [parsedDaily.frequency, parsedDaily.weekdays, parsedDaily.monthDays],
    ['daily', [], []]
  );

  const weekly = copySnapshot();
  weekly.repeatRules.push({
    ...validRule(),
    revisions: [{ ...validRevision(), weekdays: [6, 1, 4], monthDays: [18] }]
  });
  const parsedWeekly = parseJsonSnapshot(JSON.stringify(weekly)).repeatRules[0].revisions[0];
  assert.deepEqual([parsedWeekly.weekdays, parsedWeekly.monthDays], [[1, 4, 6], []]);

  const monthly = copySnapshot();
  monthly.repeatRules.push({
    ...validRule(),
    revisions: [{
      ...validRevision(),
      frequency: 'monthly',
      weekdays: [6, 1],
      monthDays: [31, 1, 15],
      monthDay: 20
    }]
  });
  const parsedMonthly = parseJsonSnapshot(JSON.stringify(monthly)).repeatRules[0].revisions[0];
  assert.deepEqual([parsedMonthly.weekdays, parsedMonthly.monthDays], [[], [1, 15, 31]]);
  assert.equal(Object.hasOwn(parsedMonthly, 'monthDay'), false);
});

test('JSON 当前 v1 拒绝多 revision 和 override 例外', () => {
  const multipleRevisions = copySnapshot();
  multipleRevisions.repeatRules.push(validRule());
  multipleRevisions.repeatRules[0].revisions[0].effectiveUntil = NOW - 1;
  multipleRevisions.repeatRules[0].revisions.push({
    ...validRevision(),
    id: 'revision_2',
    revision: 2
  });
  assert.throws(
    () => parseJsonSnapshot(JSON.stringify(multipleRevisions)),
    (error) => error.code === 'IMPORT_SCHEMA_INVALID'
  );

  const overrideException = copySnapshot();
  overrideException.repeatRules.push(validRule());
  overrideException.occurrenceExceptions.push({
    id: 'exception_override',
    ruleId: 'rule_1',
    occurrenceStart: NOW,
    kind: 'override',
    override: {},
    createdAt: NOW,
    updatedAt: NOW
  });
  assert.throws(
    () => parseJsonSnapshot(JSON.stringify(overrideException)),
    (error) => error.code === 'IMPORT_SCHEMA_INVALID'
  );
});

test('非法项目标题拒绝整快照且不修改输入对象', () => {
  const database = copySnapshot();
  database.wishes.push({ id: 'wish_1', title: '  保持原值  ', createdAt: NOW, updatedAt: NOW });
  const project = validProject();
  project.title = '🙂'.repeat(26);
  database.projects.push(project);

  assert.throws(
    () => parseJsonSnapshot(JSON.stringify(database)),
    (error) => error.code === 'IMPORT_SCHEMA_INVALID'
  );
  assert.equal(database.wishes[0].title, '  保持原值  ');
});

test('解析会忽略未知字段，但保留已知字段的严格校验', () => {
  const database = copySnapshot();
  database.legacyRootField = 'ignored';
  database.localProfile.legacyProfileField = true;
  database.projects.push(validProject());
  database.projects[0].legacyProjectField = 'ignored';
  database.timer.draft.legacyDraftField = 'ignored';

  const parsed = parseJsonSnapshot(JSON.stringify(database));

  assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'legacyRootField'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.localProfile, 'legacyProfileField'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.projects[0], 'legacyProjectField'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.timer.draft, 'legacyDraftField'), false);

  database.projects[0].deadlineAt = 'invalid';
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

test('导出会移除各层遗留字段和计时运行态，且输出仍可被当前解析器读取', () => {
  const database = copySnapshot();
  database.projects.push(validProject());
  database.tasks.push(validTask());
  database.calendarEvents.push(validEvent());
  database.repeatRules.push(validRule());
  database.occurrenceExceptions.push(validException());
  database.timeLogs.push(validLog());
  database.recoveryDraft = {
    reason: '等待用户修复',
    timer: { status: 'running', startedAt: null, pausedAt: NOW, pauses: [], draft: { tags: [] } },
    createdAt: NOW
  };
  database.projects[0].legacyProjectField = true;
  database.calendarEvents[0].repeatRuleId = 'rule_1';
  database.calendarEvents[0].repeatRuleSummarySnapshot = '旧固定日程';
  database.repeatRules[0].revisions[0].legacyRevisionField = true;
  database.occurrenceExceptions[0].legacyExceptionField = true;
  database.timeLogs[0].legacyLogField = true;
  database.timer.draft.legacyDraftField = true;
  database.recoveryDraft.timer.legacyTimerField = true;

  const exported = JSON.parse(exportJson(database));

  assert.equal(Object.prototype.hasOwnProperty.call(exported.projects[0], 'legacyProjectField'), false);
  assertNoLegacyRepeatSeedFields(exported.calendarEvents.find((item) => item.id === 'event_1'));
  assert.equal(Object.prototype.hasOwnProperty.call(exported.repeatRules[0].revisions[0], 'legacyRevisionField'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(exported.occurrenceExceptions[0], 'legacyExceptionField'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(exported.occurrenceExceptions[0], 'override'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(exported.timeLogs[0], 'legacyLogField'), false);
  assert.deepEqual(exported.timer, createIdleTimer());
  assert.equal(exported.recoveryDraft, null);
  assert.doesNotThrow(() => parseJsonSnapshot(JSON.stringify(exported)));
});

test('计时草稿关联可在本地快照解析中保留，但 JSON 导出会清除全部计时数据', () => {
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
  assert.deepEqual(exported.timer, createIdleTimer());
  assert.equal(exported.recoveryDraft, null);
  assert.deepEqual(database.timer.draft, originDraft);
  assert.deepEqual(database.recoveryDraft.timer.draft, originDraft);
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

test('愿望和项目字段类型严格校验', () => {
  expectSchemaInvalid((database) => { database.wishes.push({ id: 'wish_1', title: 1, createdAt: NOW, updatedAt: NOW }); });
  expectSchemaInvalid((database) => { database.projects.push({ ...validProject(), deadlineAt: String(NOW) }); });
});

test('任务、日历事件和重复规则字段类型与枚举严格校验', () => {
  expectSchemaInvalid((database) => { database.tasks.push({ ...validTask(), status: 'active' }); });
  expectSchemaInvalid((database) => { database.tasks.push({ ...validTask(), status: 'inbox' }); });
  expectSchemaInvalid((database) => { database.tasks.push({ ...validTask(), completedAt: String(NOW) }); });
  expectSchemaInvalid((database) => { database.tasks.push({ ...validTask(), completedAt: NOW }); });
  expectSchemaInvalid((database) => { database.tasks.push({ ...validTask(), status: 'completed', completedAt: null }); });
  expectSchemaInvalid((database) => { database.calendarEvents.push({ ...validEvent(), endedAt: NOW }); });
  expectSchemaInvalid((database) => { database.calendarEvents.push({ ...validEvent(), priority: 4 }); });
  expectSchemaInvalid((database) => { database.repeatRules.push({ ...validRule(), revisions: [] }); });
  expectSchemaInvalid((database) => { database.repeatRules.push({ ...validRule(), revisions: [{ ...validRevision(), frequency: 'yearly' }] }); });
  expectSchemaInvalid((database) => { database.repeatRules.push({ ...validRule(), revisions: [{ ...validRevision(), interval: 0 }] }); });
  expectSchemaInvalid((database) => { database.repeatRules.push({ ...validRule(), revisions: [{ ...validRevision(), weekdays: [7] }] }); });
  expectSchemaInvalid((database) => {
    const revision = validRevision();
    delete revision.monthDays;
    database.repeatRules.push({ ...validRule(), revisions: [revision] });
  });
  expectSchemaInvalid((database) => { database.repeatRules.push({ ...validRule(), revisions: [{ ...validRevision(), frequency: 'monthly', weekdays: [], monthDays: [] }] }); });
  expectSchemaInvalid((database) => { database.repeatRules.push({ ...validRule(), revisions: [{ ...validRevision(), frequency: 'monthly', weekdays: [], monthDays: [15, 15] }] }); });
  expectSchemaInvalid((database) => { database.repeatRules.push({ ...validRule(), revisions: [{ ...validRevision(), frequency: 'monthly', weekdays: [], monthDays: [0] }] }); });
  expectSchemaInvalid((database) => { database.repeatRules.push({ ...validRule(), revisions: [{ ...validRevision(), frequency: 'monthly', weekdays: [], monthDays: [32] }] }); });
});

test('例外、日志、计时器和恢复草稿字段类型严格校验', () => {
  expectSchemaInvalid((database) => { database.occurrenceExceptions.push({ ...validException(), kind: 'delete' }); });
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

test('真实服务 finishTimer 后清空运行态，快照通过校验', () => {
  let now = NOW;
  const service = createService(() => now);
  service.startTimer({ note: '结束' });
  now += 1_000;
  service.finishTimer();
  assert.equal(service.snapshot().timer.status, 'idle');
  assert.doesNotThrow(() => validateJsonSnapshot(service.snapshot()));
});

test('日志时长不得超过墙钟分钟上限', () => {
  expectSchemaInvalid((database) => { database.timeLogs.push({ ...validLog(), durationMinutes: 61 }); });
});

test('日志拒绝即时、零分钟和与暂停后有效秒数不一致的时长', () => {
  const database = copySnapshot();
  database.timeLogs.push({ ...validLog(), id: 'log_instant', endedAt: NOW, durationMinutes: 1 });
  database.timeLogs.push({ ...validLog(), id: 'log_zero', durationMinutes: 0 });
  database.timeLogs.push({
    ...validLog(),
    id: 'log_paused',
    pausedDurationSeconds: 900,
    durationMinutes: 60,
    source: 'timer'
  });
  assert.throws(
    () => validateJsonSnapshot(database),
    (error) => error.code === 'IMPORT_SCHEMA_INVALID'
  );
});

test('根 timer 拒绝与状态机矛盾的时间戳组合', () => {
  expectSchemaInvalid((database) => { database.timer = { ...createIdleTimer(), startedAt: NOW }; });
  expectSchemaInvalid((database) => { database.timer = { ...createIdleTimer(), endedAt: NOW }; });
  expectSchemaInvalid((database) => { database.timer = { ...createIdleTimer(), status: 'running' }; });
  expectSchemaInvalid((database) => {
    database.timer = { ...createIdleTimer(), status: 'paused', startedAt: NOW, pausedAt: null };
  });
  expectSchemaInvalid((database) => {
    database.timer = { ...createIdleTimer(), status: 'unknown', startedAt: NOW };
  });
});

test('JSON 导入兼容旧 idle 计时器的完成时间字段', () => {
  const database = copySnapshot();
  database.timer.endedAt = null;
  const parsed = parseJsonSnapshot(JSON.stringify(database));
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.timer, 'endedAt'), false);
  assert.deepEqual(parsed.timer, createIdleTimer());
});

test('JSON 导入将旧 ended 计时转为可确认的恢复草稿，而不恢复运行态', () => {
  const database = copySnapshot();
  database.timer = {
    status: 'ended',
    startedAt: NOW,
    endedAt: NOW + 60_000,
    pausedAt: null,
    pauses: [],
    draft: { note: '旧版已结束', tags: ['旧版'] }
  };

  const parsed = parseJsonSnapshot(JSON.stringify(database));

  assert.deepEqual(parsed.timer, createIdleTimer());
  assert.equal(parsed.recoveryDraft.timer.status, 'idle');
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.recoveryDraft.timer, 'endedAt'), false);
  assert.deepEqual(parsed.recoveryDraft.candidatePreview, {
    startedAt: NOW,
    endedAt: NOW + 60_000,
    pausedDurationSeconds: 0,
    durationMinutes: 1,
    source: 'timer'
  });
  assert.doesNotThrow(() => validateJsonSnapshot(parsed));
});

test('旧 ended 计时不能形成候选预览时仍保留待修正恢复草稿', () => {
  const database = copySnapshot();
  database.timer = {
    status: 'ended',
    startedAt: NOW,
    endedAt: NOW,
    pausedAt: null,
    pauses: [],
    draft: { note: '需手工修正', tags: [] }
  };

  const parsed = parseJsonSnapshot(JSON.stringify(database));

  assert.equal(parsed.timer.status, 'idle');
  assert.equal(parsed.recoveryDraft.timer.status, 'idle');
  assert.equal(parsed.recoveryDraft.timer.startedAt, NOW);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.recoveryDraft, 'candidatePreview'), false);
  assert.doesNotThrow(() => validateJsonSnapshot(parsed));
});

test('JSON 导入会兼容恢复草稿中旧 ended 计时器的完成时间字段', () => {
  const database = copySnapshot();
  database.recoveryDraft = {
    reason: '旧版恢复草稿',
    timer: {
      status: 'ended',
      startedAt: NOW,
      endedAt: NOW + 60_000,
      pausedAt: null,
      pauses: [],
      draft: { note: '旧版草稿', tags: [] }
    },
    createdAt: NOW
  };

  const parsed = parseJsonSnapshot(JSON.stringify(database));

  assert.equal(parsed.recoveryDraft.timer.status, 'idle');
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.recoveryDraft.timer, 'endedAt'), false);
  assert.deepEqual(parsed.recoveryDraft.candidatePreview, {
    startedAt: NOW,
    endedAt: NOW + 60_000,
    pausedDurationSeconds: 0,
    durationMinutes: 1,
    source: 'timer'
  });
  assert.doesNotThrow(() => validateJsonSnapshot(parsed));
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
      ...createIdleTimer(), status: 'paused', startedAt: NOW, pausedAt: NOW + 4_000,
      pauses: [{ startedAt: NOW + 1_000, endedAt: NOW + 3_000 }, { startedAt: NOW + 2_000, endedAt: NOW + 4_000 }]
    };
  });
  expectSchemaInvalid((database) => {
    database.timer = {
      ...createIdleTimer(), status: 'paused', startedAt: NOW, pausedAt: NOW + 4_000,
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
      status: 'running', startedAt: null, pausedAt: NOW,
      pauses: [{ startedAt: NOW, endedAt: NOW }], draft: { tags: [] }
    },
    createdAt: NOW
  };
  assert.doesNotThrow(() => validateJsonSnapshot(database));
});

test('recoveryDraft 的候选预览必须是完整且有效的计时器建议', () => {
  const database = copySnapshot();
  database.recoveryDraft = {
    reason: '计时超过恢复时间窗口，系统已生成候选，请核实后确认记录',
    timer: { ...createIdleTimer(), startedAt: NOW },
    candidatePreview: {
      startedAt: NOW,
      endedAt: NOW + 8_000,
      pausedDurationSeconds: 0,
      durationMinutes: 1,
      source: 'timer'
    },
    createdAt: NOW
  };
  const parsed = parseJsonSnapshot(JSON.stringify(database));
  assert.deepEqual(parsed.recoveryDraft.candidatePreview, database.recoveryDraft.candidatePreview);

  for (const candidatePreview of [
    { startedAt: NOW, endedAt: NOW, pausedDurationSeconds: 0, durationMinutes: 1, source: 'timer' },
    { startedAt: NOW, endedAt: NOW + 8_000, pausedDurationSeconds: 0, durationMinutes: 0, source: 'timer' },
    { startedAt: NOW, endedAt: NOW + 8_000, pausedDurationSeconds: 0, durationMinutes: 1, source: 'manual' },
    { startedAt: NOW, endedAt: NOW + 8_000, pausedDurationSeconds: 0, durationMinutes: 1 }
  ]) {
    expectSchemaInvalid((invalidDatabase) => {
      invalidDatabase.recoveryDraft = {
        reason: '等待审核',
        timer: { ...createIdleTimer(), startedAt: NOW },
        candidatePreview,
        createdAt: NOW
      };
    });
  }

  expectSchemaInvalid((invalidDatabase) => {
    invalidDatabase.recoveryDraft = {
      reason: '伪造超长预览',
      timer: { ...createIdleTimer(), startedAt: NOW },
      candidatePreview: {
        startedAt: NOW,
        endedAt: NOW + 60_000,
        pausedDurationSeconds: 0,
        durationMinutes: 2,
        source: 'timer'
      },
      createdAt: NOW
    };
  });
});

test('重复 ID 包括顶层实体和修订均被拒绝', () => {
  expectDuplicateId((database) => { database.wishes.push({ id: database.localProfile.id, title: '重复', createdAt: NOW, updatedAt: NOW }); });
  expectDuplicateId((database) => { database.projects.push({ ...validProject(), id: database.localProfile.id }); });
  expectDuplicateId((database) => {
    database.repeatRules.push(validRule(), {
      ...validRule(),
      id: 'rule_2'
    });
  });
});

test('校验错误信息不泄漏 JSON 中的实体正文', () => {
  const sentinel = 'PRIVATE_IMPORT_SENTINEL_749';
  const database = completeSnapshot();
  database.wishes.push({ id: 'wish_1', title: sentinel, createdAt: NOW, updatedAt: 'invalid' });
  assert.throws(() => parseJsonSnapshot(JSON.stringify(database)), (error) => error.code === 'IMPORT_SCHEMA_INVALID' && !error.message.includes(sentinel));
});
