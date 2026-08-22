const test = require('node:test');
const assert = require('node:assert/strict');

const { LOG_SOURCE, LOG_STATUS, MAX_TIMER_SPAN_MS, TASK_STATUS, TIMER_STATUS } = require('../miniprogram/domain/constants');
const { createIdleTimer, createInitialDatabase, clone } = require('../miniprogram/domain/entities');
const { projectRule } = require('../miniprogram/domain/recurrence');
const {
  CONFLICT_POLICY,
  IMPORT_MODE
} = require('../miniprogram/repository/json-import');
const {
  BACKUP_KEY,
  LocalRepository,
  STORAGE_KEY
} = require('../miniprogram/repository/local-repository');
const { MemoryStorageAdapter } = require('../miniprogram/repository/storage-adapter');
const { ApplicationService } = require('../miniprogram/services/application-service');
const {
  LocalPreferenceStore,
  PREFERENCES
} = require('../miniprogram/services/local-preference-store');
const { DomainError, StorageError } = require('../miniprogram/domain/errors');

class TrackingStorage extends MemoryStorageAdapter {
  constructor() {
    super();
    this.setCalls = [];
    this.removeCalls = [];
    this.failNextSet = false;
  }

  set(key, value) {
    this.setCalls.push(key);
    if (this.failNextSet) {
      this.failNextSet = false;
      throw new Error('write failed');
    }
    super.set(key, value);
  }

  remove(key) {
    this.removeCalls.push(key);
    super.remove(key);
  }

  resetCalls() {
    this.setCalls = [];
    this.removeCalls = [];
  }
}

function createHarness(start = 1_700_000_000_000, storage = new TrackingStorage(), applicationOptions = {}) {
  let now = start;
  const repository = new LocalRepository(storage, { now: () => now });
  const exportTempFileStore = {
    removeAllStrictCalls: 0,
    removeAllStrict() {
      this.removeAllStrictCalls += 1;
      return { removedCount: 0 };
    }
  };
  const service = new ApplicationService(repository, {
    now: () => now,
    exportTempFileStore,
    ...applicationOptions
  });
  const initialized = service.initialize();
  return {
    service,
    repository,
    storage,
    exportTempFileStore,
    initialized,
    setNow(value) { now = value; },
    now() { return now; }
  };
}

function createStoredTimerHarness(timer, capturedNow) {
  const database = createInitialDatabase(capturedNow);
  database.timer = clone(timer);
  const storage = new TrackingStorage();
  storage.set(STORAGE_KEY, database);
  let nowCalls = 0;
  const sharedNow = () => {
    nowCalls += 1;
    if (nowCalls > 1) throw new Error('同一次公开操作重复读取 now');
    return capturedNow;
  };
  const repository = new LocalRepository(storage, { now: sharedNow });
  const service = new ApplicationService(repository, { now: sharedNow });
  return { service, nowCalls: () => nowCalls };
}

test('开发验收的超时恢复只创建一份待审核候选预览', () => {
  const { service, setNow, now } = createHarness(undefined, undefined, {
    recoveryTimerSpanMs: 2_000
  });
  const startedAt = now();
  service.startTimer({ note: '开发验收候选预览' });
  setNow(startedAt + 3_000);

  const recovered = service.recoverTimer();

  assert.equal(recovered.state, 'draft');
  assert.deepEqual(recovered.recoveryDraft.candidatePreview, {
    startedAt,
    endedAt: startedAt + 2_000,
    pausedDurationSeconds: 0,
    durationMinutes: 1,
    source: LOG_SOURCE.TIMER
  });
  assert.equal(service.snapshot().timer.status, TIMER_STATUS.IDLE);
  assert.equal(service.snapshot().timeLogs.length, 0);
});

function createCalendarEventForTask(service, input) {
  const taskId = input.taskId || service.createTask({ title: `${input.title}任务` }).id;
  return service.createCalendarEvent({ ...input, taskId });
}

function assertNoLegacyRepeatSeedFields(event) {
  assert.ok(event);
  ['repeatRuleId', 'repeatRuleSummarySnapshot'].forEach((field) => {
    assert.equal(Object.hasOwn(event, field), false);
  });
}

function createRecurringPlanForTask(service, input) {
  const taskId = input.taskId || service.createTask({ title: `${input.title}任务` }).id;
  return service.createRecurringPlan({ ...input, taskId });
}

test('空任务资料库原子创建同名 TODO 与普通或重复计划', () => {
  const start = 1_700_000_000_000 + 3_600_000;
  const eventHarness = createHarness();
  const eventResult = eventHarness.service.createCalendarEventWithNewTask({
    title: '  自动计划  ',
    startedAt: start,
    endedAt: start + 1_800_000,
    priority: 2
  });
  const eventSnapshot = eventHarness.service.snapshot();
  assert.equal(eventSnapshot.tasks.length, 1);
  assert.equal(eventSnapshot.calendarEvents.length, 1);
  assert.deepEqual(
    [eventResult.task.title, eventResult.task.status, eventResult.task.projectId],
    ['自动计划', TASK_STATUS.TODO, null]
  );
  assert.deepEqual(
    [eventResult.event.taskId, eventResult.event.taskNameSnapshot],
    [eventResult.task.id, '自动计划']
  );

  const repeatHarness = createHarness();
  const repeatResult = repeatHarness.service.createRecurringPlanWithNewTask({
    title: '自动固定日程',
    startedAt: start,
    endedAt: start + 1_800_000,
    priority: 1,
    frequency: 'daily',
    interval: 1
  });
  const repeatSnapshot = repeatHarness.service.snapshot();
  assert.equal(repeatSnapshot.tasks.length, 1);
  assert.equal(repeatSnapshot.repeatRules.length, 1);
  assert.equal(repeatSnapshot.calendarEvents.length, 0);
  assert.equal(repeatResult.rule.revisions[0].taskId, repeatResult.task.id);
  assert.equal(repeatResult.occurrence.taskId, repeatResult.task.id);
  assert.equal(repeatResult.occurrence.ruleId, repeatResult.rule.id);
  assert.equal(repeatResult.occurrence.occurrenceStart, start);
  assert.equal(repeatResult.occurrence.virtual, true);
});

test('显式新建同名任务支持已有任务资料库且失败不留下孤立 TODO', () => {
  const start = 1_700_000_000_000 + 3_600_000;
  const existingHarness = createHarness();
  const existingTask = existingHarness.service.createTask({ title: '已有任务' });
  const explicitResult = existingHarness.service.createCalendarEventWithNewTask({
    title: '显式新建任务',
    startedAt: start,
    endedAt: start + 1_800_000,
    priority: 1
  });
  const existingSnapshot = existingHarness.service.snapshot();
  assert.equal(existingSnapshot.tasks.length, 2);
  assert.ok(existingSnapshot.tasks.some((item) => item.id === existingTask.id));
  assert.deepEqual(
    [explicitResult.task.title, explicitResult.task.status, explicitResult.task.projectId],
    ['显式新建任务', TASK_STATUS.TODO, null]
  );
  assert.equal(explicitResult.event.taskId, explicitResult.task.id);

  const recurringHarness = createHarness();
  recurringHarness.service.createTask({ title: '已有固定日程任务' });
  const recurringResult = recurringHarness.service.createRecurringPlanWithNewTask({
    title: '显式新建固定日程任务',
    startedAt: start,
    endedAt: start + 1_800_000,
    priority: 1,
    frequency: 'daily',
    interval: 1
  });
  assert.equal(recurringHarness.service.snapshot().tasks.length, 2);
  assert.equal(recurringHarness.service.snapshot().calendarEvents.length, 0);
  assert.equal(recurringResult.rule.revisions[0].taskId, recurringResult.task.id);
  assert.equal(recurringResult.occurrence.taskId, recurringResult.task.id);

  const invalidHarness = createHarness();
  assert.throws(() => invalidHarness.service.createCalendarEventWithNewTask({
    title: '非法计划',
    startedAt: start,
    endedAt: start,
    priority: 1
  }));
  assert.equal(invalidHarness.service.snapshot().tasks.length, 0);
  assert.equal(invalidHarness.service.snapshot().calendarEvents.length, 0);

  const failingStorage = new TrackingStorage();
  const failingHarness = createHarness(undefined, failingStorage);
  failingStorage.resetCalls();
  failingStorage.failNextSet = true;
  assert.throws(() => failingHarness.service.createCalendarEventWithNewTask({
    title: '写入失败计划',
    startedAt: start,
    endedAt: start + 1_800_000,
    priority: 1
  }));
  assert.equal(failingHarness.service.snapshot().tasks.length, 0);
  assert.equal(failingHarness.service.snapshot().calendarEvents.length, 0);
});

test('createCalendarEventWithNewTask 支持活动项目 taskProjectId 并拒绝归档或不存在项目', () => {
  const start = 1_700_000_000_000 + 3_600_000;
  const activeHarness = createHarness();
  const project = activeHarness.service.createProject({
    title: '活动项目',
    deadlineAt: start + 86_400_000
  });
  const linked = activeHarness.service.createCalendarEventWithNewTask({
    title: '带项目计划',
    startedAt: start,
    endedAt: start + 1_800_000,
    priority: 1,
    taskProjectId: project.id
  });
  assert.equal(linked.task.projectId, project.id);
  assert.equal(linked.task.projectNameSnapshot, '活动项目');
  assert.equal(linked.event.projectId, null);
  assert.equal(linked.event.projectNameSnapshot, '活动项目');
  assert.equal(linked.event.taskId, linked.task.id);
  assert.equal(linked.event.title, '带项目计划');
  assert.equal(linked.task.title, '带项目计划');

  const omitted = createHarness().service.createCalendarEventWithNewTask({
    title: '无项目计划',
    startedAt: start,
    endedAt: start + 1_800_000,
    priority: 1
  });
  assert.equal(omitted.task.projectId, null);
  assert.equal(omitted.event.projectId, null);

  const missingHarness = createHarness();
  assert.throws(
    () => missingHarness.service.createCalendarEventWithNewTask({
      title: '无效项目',
      startedAt: start,
      endedAt: start + 1_800_000,
      priority: 1,
      taskProjectId: 'project_missing'
    }),
    (error) => error.code === 'ENTITY_NOT_FOUND'
  );
  assert.equal(missingHarness.service.snapshot().tasks.length, 0);
  assert.equal(missingHarness.service.snapshot().calendarEvents.length, 0);

  const archivedHarness = createHarness();
  const archived = archivedHarness.service.createProject({
    title: '归档项目',
    deadlineAt: start + 86_400_000
  });
  archivedHarness.service.setProjectArchived(archived.id, true);
  assert.throws(
    () => archivedHarness.service.createCalendarEventWithNewTask({
      title: '归档项目计划',
      startedAt: start,
      endedAt: start + 1_800_000,
      priority: 1,
      taskProjectId: archived.id
    }),
    (error) => error.code === 'PROJECT_NOT_ACTIVE'
  );
  assert.equal(archivedHarness.service.snapshot().tasks.length, 0);
  assert.equal(archivedHarness.service.snapshot().calendarEvents.length, 0);
});

test('createRecurringPlanWithNewTask 支持活动项目 taskProjectId 并拒绝归档或不存在项目', () => {
  const start = 1_700_000_000_000 + 3_600_000;
  const recurringInput = {
    title: '带项目固定日程',
    startedAt: start,
    endedAt: start + 1_800_000,
    priority: 1,
    frequency: 'daily',
    interval: 1
  };
  const activeHarness = createHarness();
  const project = activeHarness.service.createProject({
    title: '活动项目',
    deadlineAt: start + 86_400_000
  });
  const linked = activeHarness.service.createRecurringPlanWithNewTask({
    ...recurringInput,
    taskProjectId: project.id
  });
  assert.equal(linked.task.projectId, project.id);
  assert.equal(linked.task.projectNameSnapshot, '活动项目');
  assert.equal(linked.rule.revisions[0].projectId, null);
  assert.equal(linked.rule.revisions[0].projectNameSnapshot, '活动项目');
  assert.equal(linked.rule.revisions[0].taskId, linked.task.id);
  assert.equal(linked.occurrence.virtual, true);
  assert.equal(activeHarness.service.snapshot().calendarEvents.length, 0);

  const omitted = createHarness().service.createRecurringPlanWithNewTask(recurringInput);
  assert.equal(omitted.task.projectId, null);
  assert.equal(omitted.rule.revisions[0].projectId, null);

  const missingHarness = createHarness();
  assert.throws(
    () => missingHarness.service.createRecurringPlanWithNewTask({
      ...recurringInput,
      taskProjectId: 'project_missing'
    }),
    (error) => error.code === 'ENTITY_NOT_FOUND'
  );
  assert.equal(missingHarness.service.snapshot().tasks.length, 0);
  assert.equal(missingHarness.service.snapshot().repeatRules.length, 0);

  const archivedHarness = createHarness();
  const archived = archivedHarness.service.createProject({
    title: '归档项目',
    deadlineAt: start + 86_400_000
  });
  archivedHarness.service.setProjectArchived(archived.id, true);
  assert.throws(
    () => archivedHarness.service.createRecurringPlanWithNewTask({
      ...recurringInput,
      title: '归档项目固定日程',
      taskProjectId: archived.id
    }),
    (error) => error.code === 'PROJECT_NOT_ACTIVE'
  );
  assert.equal(archivedHarness.service.snapshot().tasks.length, 0);
  assert.equal(archivedHarness.service.snapshot().repeatRules.length, 0);
});

test('删除愿望需要二次确认并只移除目标愿望', () => {
  const { service } = createHarness();
  const deletedWish = service.createWish('准备删除的愿望');
  const keptWish = service.createWish('继续保留的愿望');

  assert.throws(
    () => service.deleteWish(deletedWish.id, false),
    (error) => error.code === 'WISH_DELETE_CONFIRMATION_REQUIRED'
  );
  assert.deepEqual(service.snapshot().wishes.map((wish) => wish.id), [deletedWish.id, keptWish.id]);

  assert.deepEqual(
    service.deleteWish(deletedWish.id, true),
    { id: deletedWish.id, title: deletedWish.title }
  );
  assert.deepEqual(service.snapshot().wishes.map((wish) => wish.id), [keptWish.id]);
});

test('重复规则投影返回 virtual plan 而不是候选日志', () => {
  const { service, now } = createHarness();
  const task = service.createTask({ title: '重复任务' });
  const project = service.createProject({
    title: '重复项目',
    deadlineAt: now() + 86_400_000
  });
  service.updateTask(task.id, { projectId: project.id });
  const startedAt = now() + 60 * 60 * 1000;
  const { rule } = service.createRecurringPlan({
    title: '重复计划',
    startedAt,
    endedAt: startedAt + 30 * 60 * 1000,
    priority: 2,
    frequency: 'daily',
    interval: 1,
    taskId: task.id
  });

  const occurrence = projectRule(
    rule,
    startedAt + 86_400_000,
    startedAt + 86_400_000,
    []
  )[0];

  assert.deepEqual(
    {
      type: occurrence.type,
      virtual: occurrence.virtual,
      ruleId: occurrence.ruleId,
      originRuleId: occurrence.originRuleId,
      occurrenceStart: occurrence.occurrenceStart,
      originOccurrenceId: occurrence.originOccurrenceId,
      title: occurrence.title,
      startedAt: occurrence.startedAt,
      endedAt: occurrence.endedAt,
      priority: occurrence.priority,
      projectId: occurrence.projectId,
      projectNameSnapshot: occurrence.projectNameSnapshot,
      taskId: occurrence.taskId,
      taskNameSnapshot: occurrence.taskNameSnapshot
    },
    {
      type: 'plan',
      virtual: true,
      ruleId: rule.id,
      originRuleId: rule.id,
      occurrenceStart: startedAt + 86_400_000,
      originOccurrenceId: occurrence.id,
      title: '重复计划',
      startedAt: startedAt + 86_400_000,
      endedAt: startedAt + 86_400_000 + 30 * 60 * 1000,
      priority: 2,
      projectId: null,
      projectNameSnapshot: project.title,
      taskId: task.id,
      taskNameSnapshot: task.title
    }
  );
});

test('编辑普通计划开启固定日程：无记录或计时引用时原子替换为重复规则', () => {
  const { service, now } = createHarness();
  const originalTask = service.createTask({ title: '原任务' });
  const selectedTask = service.createTask({ title: '新任务' });
  const event = service.createCalendarEvent({
    title: '普通计划',
    startedAt: now() + 60 * 60 * 1000,
    endedAt: now() + 2 * 60 * 60 * 1000,
    priority: 1,
    taskId: originalTask.id
  });
  const nextStart = now() + 3 * 60 * 60 * 1000;

  const result = service.enableRecurringForCalendarEvent(event.id, {
    title: '固定复盘',
    startedAt: nextStart,
    endedAt: nextStart + 30 * 60 * 1000,
    priority: 3,
    taskId: selectedTask.id,
    frequency: 'weekly',
    interval: 2,
    weekdays: [new Date(nextStart).getDay()],
    monthDays: []
  });
  const snapshot = service.snapshot();
  const revision = result.rule.revisions[0];

  assert.equal(result.originalEventPreserved, false);
  assert.equal(result.event, null);
  assert.equal(snapshot.calendarEvents.some((item) => item.id === event.id), false);
  assert.equal(snapshot.repeatRules.length, 1);
  assert.deepEqual(
    [result.rule.title, revision.startedAt, revision.endedAt, revision.priority, revision.taskId],
    ['固定复盘', nextStart, nextStart + 30 * 60 * 1000, 3, selectedTask.id]
  );
  assert.deepEqual(
    [revision.frequency, revision.interval, revision.weekdays, revision.monthDays],
    ['weekly', 2, [new Date(nextStart).getDay()], []]
  );
  assert.equal(result.occurrence.ruleId, result.rule.id);
});

test('编辑有记录的普通计划开启固定日程：保留并同步更新原计划，记录关联不变', () => {
  const { service, now } = createHarness();
  const task = service.createTask({ title: '记录任务' });
  const event = service.createCalendarEvent({
    title: '已有记录的计划',
    startedAt: now() + 60 * 60 * 1000,
    endedAt: now() + 2 * 60 * 60 * 1000,
    priority: 1,
    taskId: task.id
  });
  const log = service.createManualLog({
    startedAt: now() - 30 * 60 * 1000,
    endedAt: now() - 20 * 60 * 1000,
    calendarEventId: event.id
  }).log;
  const nextStart = now() + 4 * 60 * 60 * 1000;

  const result = service.enableRecurringForCalendarEvent(event.id, {
    title: '同名固定日程',
    startedAt: nextStart,
    endedAt: nextStart + 45 * 60 * 1000,
    priority: 2,
    taskId: task.id,
    frequency: 'daily',
    interval: 1,
    weekdays: [],
    monthDays: []
  });
  const snapshot = service.snapshot();
  const keptEvent = snapshot.calendarEvents.find((item) => item.id === event.id);
  const keptLog = snapshot.timeLogs.find((item) => item.id === log.id);
  const revision = result.rule.revisions[0];

  assert.equal(result.originalEventPreserved, true);
  assert.equal(result.event.id, event.id);
  assert.deepEqual(
    [keptEvent.title, keptEvent.startedAt, keptEvent.endedAt, keptEvent.priority, keptEvent.taskId],
    ['同名固定日程', nextStart, nextStart + 45 * 60 * 1000, 2, task.id]
  );
  assert.deepEqual(
    [result.rule.title, revision.startedAt, revision.endedAt, revision.priority, revision.taskId],
    ['同名固定日程', nextStart, nextStart + 45 * 60 * 1000, 2, task.id]
  );
  assert.equal(keptLog.calendarEventId, event.id);
  assert.equal(keptLog.originRuleId, null);
  assert.equal(keptLog.source, LOG_SOURCE.MANUAL);
  assert.equal(snapshot.tasks.find((item) => item.id === task.id).status, TASK_STATUS.TODO);
});

test('编辑有活动计时或恢复草稿引用的普通计划开启固定日程时保留原计划和引用', () => {
  for (const referenceKind of ['active', 'recovery']) {
    const { service, setNow, now } = createHarness();
    const task = service.createTask({ title: `${referenceKind} 任务` });
    const event = service.createCalendarEvent({
      title: `${referenceKind} 计划`,
      startedAt: now() + 60 * 60 * 1000,
      endedAt: now() + 2 * 60 * 60 * 1000,
      priority: 1,
      taskId: task.id
    });
    service.startTimer({ calendarEventId: event.id });
    if (referenceKind === 'recovery') {
      setNow(now() + MAX_TIMER_SPAN_MS + 1);
      service.recoverTimer();
    }

    const result = service.enableRecurringForCalendarEvent(event.id, {
      title: `${referenceKind} 固定日程`,
      startedAt: event.startedAt,
      endedAt: event.endedAt,
      priority: 1,
      taskId: task.id,
      frequency: 'daily',
      interval: 1,
      weekdays: [],
      monthDays: []
    });
    const snapshot = service.snapshot();
    const draft = referenceKind === 'active'
      ? snapshot.timer.draft
      : snapshot.recoveryDraft.timer.draft;

    assert.equal(result.originalEventPreserved, true, referenceKind);
    assert.equal(snapshot.calendarEvents.some((item) => item.id === event.id), true, referenceKind);
    assert.equal(draft.calendarEventId, event.id, referenceKind);
    assert.equal(draft.originRuleId, null, referenceKind);
  }
});

test('编辑普通计划开启固定日程写入失败时不删除或修改原计划，也不留下规则', () => {
  const storage = new TrackingStorage();
  const { service, now } = createHarness(undefined, storage);
  const task = service.createTask({ title: '回滚任务' });
  const event = service.createCalendarEvent({
    title: '回滚前计划',
    startedAt: now() + 60 * 60 * 1000,
    endedAt: now() + 2 * 60 * 60 * 1000,
    priority: 1,
    taskId: task.id
  });
  const before = service.snapshot();
  storage.resetCalls();
  storage.failNextSet = true;

  assert.throws(
    () => service.enableRecurringForCalendarEvent(event.id, {
      title: '不应保存的固定日程',
      startedAt: event.startedAt,
      endedAt: event.endedAt,
      priority: 2,
      taskId: task.id,
      frequency: 'daily',
      interval: 1,
      weekdays: [],
      monthDays: []
    }),
    (error) => error instanceof StorageError && error.code === 'WRITE_FAILED'
  );
  assert.deepEqual(service.snapshot(), before);
});

test('确认 virtual plan 只创建一条 confirmed rule 日志且重复确认被拒绝', () => {
  const { service, setNow, now } = createHarness();
  const startedAt = now() + 60 * 60 * 1000;
  const { rule } = createRecurringPlanForTask(service, {
    title: '确认重复计划',
    startedAt,
    endedAt: startedAt + 30 * 60 * 1000,
    frequency: 'daily',
    interval: 1
  });
  const occurrenceStart = startedAt + 86_400_000;
  const occurrence = service.timeline(occurrenceStart, occurrenceStart + 30 * 60 * 1000)
    .find((item) => item.virtual);

  assert.throws(
    () => service.confirmVirtualOccurrence(occurrence),
    (error) => error.code === 'PLAN_NOT_STARTED'
  );
  assert.equal(service.snapshot().timeLogs.length, 0);
  setNow(occurrence.startedAt);
  const log = service.confirmVirtualOccurrence(occurrence);

  assert.deepEqual(
    [log.status, log.source, log.originRuleId, log.originOccurrenceId],
    [LOG_STATUS.CONFIRMED, LOG_SOURCE.RULE, rule.id, occurrence.originOccurrenceId]
  );
  assert.equal(service.snapshot().timeLogs.length, 1);
  assert.throws(
    () => service.confirmVirtualOccurrence(occurrence),
    (error) => error.code === 'OCCURRENCE_ALREADY_CONFIRMED'
  );
  assert.equal(service.snapshot().timeLogs.length, 1);
});

test('活动计时关联的重复实例不能再被确认完成', () => {
  const { service, setNow, now } = createHarness();
  const startedAt = now() + 60 * 60 * 1000;
  createRecurringPlanForTask(service, {
    title: '计时中不可确认',
    startedAt,
    endedAt: startedAt + 30 * 60 * 1000,
    frequency: 'daily',
    interval: 1
  });
  const first = service.timeline(startedAt, startedAt + 30 * 60 * 1000).find((item) => item.virtual);
  const nextStart = startedAt + 86_400_000;
  const second = service.timeline(nextStart, nextStart + 30 * 60 * 1000).find((item) => item.virtual);

  service.startTimer({
    originRuleId: first.ruleId,
    originOccurrenceId: first.originOccurrenceId
  });
  assert.throws(
    () => service.confirmVirtualOccurrence(first),
    (error) => error.code === 'OCCURRENCE_TIMER_ACTIVE'
  );
  assert.equal(service.snapshot().timeLogs.length, 0);

  service.pauseTimer();
  assert.throws(
    () => service.confirmVirtualOccurrence(first),
    (error) => error.code === 'OCCURRENCE_TIMER_ACTIVE'
  );

  assert.throws(
    () => service.confirmVirtualOccurrence(second),
    (error) => error.code === 'PLAN_NOT_STARTED'
  );
  setNow(second.startedAt);
  const otherLog = service.confirmVirtualOccurrence(second);
  assert.equal(otherLog.originOccurrenceId, second.originOccurrenceId);
  assert.equal(service.snapshot().timer.status, TIMER_STATUS.PAUSED);
});

test('TODO 长按确认：未来候选到达开始时间后才能按计划生成记录，计时中拒绝', () => {
  const { service, setNow, now } = createHarness();
  const task = service.createTask({ title: '待确认计划任务' });
  const event = service.createCalendarEvent({
    title: '上午计划',
    taskId: task.id,
    startedAt: now() + 60 * 60 * 1000,
    endedAt: now() + 2 * 60 * 60 * 1000,
    priority: 1
  });

  assert.throws(
    () => service.confirmTaskPlanCandidate(task.id, `event:${event.id}`),
    (error) => error.code === 'PLAN_NOT_STARTED'
  );
  assert.equal(service.snapshot().timeLogs.length, 0);
  setNow(event.startedAt);
  const eventLog = service.confirmTaskPlanCandidate(task.id, `event:${event.id}`);
  assert.deepEqual(
    [eventLog.status, eventLog.source, eventLog.calendarEventId, eventLog.startedAt, eventLog.endedAt],
    [LOG_STATUS.CONFIRMED, LOG_SOURCE.MANUAL, event.id, event.startedAt, event.endedAt]
  );
  assert.equal(service.snapshot().tasks.find((item) => item.id === task.id).status, TASK_STATUS.COMPLETED);
  assert.throws(
    () => service.confirmTaskPlanCandidate(task.id, `event:${event.id}`),
    (error) => error.code === 'TASK_PLAN_CANDIDATE_UNAVAILABLE'
  );

  const startedAt = now() + 60 * 60 * 1000;
  const { rule } = createRecurringPlanForTask(service, {
    title: '每日确认',
    startedAt,
    endedAt: startedAt + 30 * 60 * 1000,
    frequency: 'daily',
    interval: 1
  });
  const occurrenceTaskId = rule.revisions[0].taskId;
  const occurrenceCandidate = service.taskPlanStates().get(occurrenceTaskId).candidates
    .find((item) => item.kind === 'occurrence');
  assert.ok(occurrenceCandidate);
  assert.equal(service.taskPlanStates().get(occurrenceTaskId).confirmableCandidates.length, 0);
  setNow(occurrenceCandidate.startedAt);
  const occurrenceLog = service.confirmTaskPlanCandidate(occurrenceTaskId, occurrenceCandidate.id);
  assert.deepEqual(
    [occurrenceLog.status, occurrenceLog.source, occurrenceLog.originRuleId, occurrenceLog.originOccurrenceId],
    [LOG_STATUS.CONFIRMED, LOG_SOURCE.RULE, rule.id, occurrenceCandidate.originOccurrenceId]
  );

  const timedTask = service.createTask({ title: '计时中计划任务' });
  const timedEvent = service.createCalendarEvent({
    title: '正在计时的计划',
    taskId: timedTask.id,
    startedAt: now() + 3 * 60 * 60 * 1000,
    endedAt: now() + 4 * 60 * 60 * 1000,
    priority: 1
  });
  service.startTimer({ calendarEventId: timedEvent.id });
  assert.throws(
    () => service.confirmTaskPlanCandidate(timedTask.id, `event:${timedEvent.id}`),
    (error) => error.code === 'PLAN_TIMER_ACTIVE'
  );
  assert.equal(service.snapshot().timeLogs.filter((item) => item.calendarEventId === timedEvent.id).length, 0);
});

test('跳过真实固定日程实例只写 skip，并保留同规则其他实例投影', () => {
  const { service, now } = createHarness();
  const dayMs = 24 * 60 * 60 * 1000;
  const startedAt = now() + 60 * 60 * 1000;
  const { rule } = createRecurringPlanForTask(service, {
    title: '每日跳过测试',
    startedAt,
    endedAt: startedAt + 30 * 60 * 1000,
    frequency: 'daily',
    interval: 1
  });
  const skippedOccurrenceStart = startedAt + dayMs;
  const virtual = service.timeline(
    skippedOccurrenceStart,
    skippedOccurrenceStart + 30 * 60 * 1000
  ).find((item) => item.virtual && item.occurrenceStart === skippedOccurrenceStart);

  assert.ok(virtual);
  const exception = service.skipOccurrence(rule.id, virtual.occurrenceStart);
  const snapshot = service.snapshot();
  const projected = projectRule(
    rule,
    startedAt,
    startedAt + 2 * dayMs,
    snapshot.occurrenceExceptions
  );
  const timeline = service.timeline(startedAt, startedAt + 2 * dayMs + 30 * 60 * 1000);

  assert.deepEqual(
    [exception.ruleId, exception.occurrenceStart, exception.kind],
    [rule.id, skippedOccurrenceStart, 'skip']
  );
  assert.equal(Object.hasOwn(exception, 'override'), false);
  assert.equal(snapshot.occurrenceExceptions.length, 1);
  assert.equal(projected.some((item) => item.occurrenceStart === skippedOccurrenceStart), false);
  assert.equal(projected.some((item) => item.occurrenceStart === startedAt), true);
  assert.equal(projected.some((item) => item.occurrenceStart === startedAt + 2 * dayMs), true);
  assert.equal(
    timeline.some((item) => item.virtual && item.occurrenceStart === skippedOccurrenceStart),
    false
  );
  assert.throws(
    () => service.skipOccurrence(rule.id, startedAt + 12 * 60 * 60 * 1000),
    (error) => error.code === 'OCCURRENCE_NOT_FOUND'
  );
  assert.equal(service.snapshot().occurrenceExceptions.length, 1);
});

test('删除本次及后续固定日程需要确认，并且只接受当前真实实例', () => {
  const { service, now } = createHarness();
  const occurrenceStart = now() + 60 * 60 * 1000;
  const { rule } = createRecurringPlanForTask(service, {
    title: '删除校验',
    startedAt: occurrenceStart,
    endedAt: occurrenceStart + 30 * 60 * 1000,
    frequency: 'daily',
    interval: 1
  });
  const before = service.snapshot();

  assert.throws(
    () => service.deleteRuleFollowing(rule.id, occurrenceStart, false),
    (error) => error.code === 'RULE_DELETE_CONFIRMATION_REQUIRED'
  );
  assert.throws(
    () => service.deleteRuleFollowing(rule.id, occurrenceStart + 1, true),
    (error) => error.code === 'OCCURRENCE_NOT_FOUND'
  );
  assert.throws(
    () => service.deleteRuleFollowing('missing-rule', occurrenceStart, true),
    (error) => error.code === 'ENTITY_NOT_FOUND'
  );
  assert.deepEqual(service.snapshot(), before);
});

test('已跳过的固定日程实例不能作为删除本次及后续的边界', () => {
  const { service, now } = createHarness();
  const dayMs = 24 * 60 * 60 * 1000;
  const startedAt = now() + 60 * 60 * 1000;
  const { rule } = createRecurringPlanForTask(service, {
    title: '已跳过删除边界校验',
    startedAt,
    endedAt: startedAt + 30 * 60 * 1000,
    frequency: 'daily',
    interval: 1
  });
  const skippedOccurrenceStart = startedAt + dayMs;

  service.skipOccurrence(rule.id, skippedOccurrenceStart);
  const beforeDelete = service.snapshot();

  assert.throws(
    () => service.deleteRuleFollowing(rule.id, skippedOccurrenceStart, true),
    (error) => error.code === 'OCCURRENCE_NOT_FOUND'
  );
  assert.deepEqual(service.snapshot(), beforeDelete);
});

test('从首次实际发生删除固定日程会删除整条每日、每周和每月规则', () => {
  const cases = [
    {
      label: '每日',
      input: {
        startedAt: new Date(2024, 0, 1, 9, 0, 0, 0).getTime(),
        frequency: 'daily',
        interval: 1
      },
      occurrenceStart: new Date(2024, 0, 1, 9, 0, 0, 0).getTime()
    },
    {
      label: '每周',
      input: {
        startedAt: new Date(2024, 0, 1, 9, 0, 0, 0).getTime(),
        frequency: 'weekly',
        interval: 1,
        weekdays: [3]
      },
      occurrenceStart: new Date(2024, 0, 3, 9, 0, 0, 0).getTime()
    },
    {
      label: '每月',
      input: {
        startedAt: new Date(2024, 0, 1, 9, 0, 0, 0).getTime(),
        frequency: 'monthly',
        interval: 1,
        monthDays: [15]
      },
      occurrenceStart: new Date(2024, 0, 15, 9, 0, 0, 0).getTime()
    }
  ];

  cases.forEach(({ label, input, occurrenceStart }) => {
    const { service } = createHarness();
    const { rule } = createRecurringPlanForTask(service, {
      title: `${label}首次删除`,
      ...input,
      endedAt: input.startedAt + 30 * 60 * 1000
    });
    const nextOccurrence = projectRule(
      rule,
      occurrenceStart + 1,
      occurrenceStart + 90 * 24 * 60 * 60 * 1000,
      []
    )[0];
    service.skipOccurrence(rule.id, nextOccurrence.occurrenceStart);
    const result = service.deleteRuleFollowing(rule.id, occurrenceStart, true);
    const rangeEnd = occurrenceStart + 40 * 24 * 60 * 60 * 1000;
    const timeline = service.timeline(input.startedAt, rangeEnd);
    const statistics = service.statistics({ rangeStart: input.startedAt, rangeEnd });
    const snapshot = service.snapshot();

    assert.deepEqual(result, { ruleId: rule.id, occurrenceStart, removedRule: true });
    assert.equal(snapshot.repeatRules.some((item) => item.id === rule.id), false);
    assert.equal(snapshot.occurrenceExceptions.some((item) => item.ruleId === rule.id), false);
    assert.equal(timeline.some((item) => item.ruleId === rule.id), false);
    assert.equal(statistics.planVariance.events.some((item) => item.eventId.startsWith(`${rule.id}:`)), false);
  });
});

test('从中间固定日程实例删除会截止规则并清理当前及未来 skip', () => {
  const { service, now } = createHarness();
  const dayMs = 24 * 60 * 60 * 1000;
  const firstStart = now() + 60 * 60 * 1000;
  const thirdStart = firstStart + 2 * dayMs;
  const futureStart = firstStart + 3 * dayMs;
  const { rule } = createRecurringPlanForTask(service, {
    title: '中间截止',
    startedAt: firstStart,
    endedAt: firstStart + 30 * 60 * 1000,
    frequency: 'daily',
    interval: 1
  });
  service.skipOccurrence(rule.id, firstStart);
  service.skipOccurrence(rule.id, futureStart);

  const result = service.deleteRuleFollowing(rule.id, thirdStart, true);
  const snapshot = service.snapshot();
  const keptRule = snapshot.repeatRules.find((item) => item.id === rule.id);
  const projected = projectRule(
    keptRule,
    firstStart,
    futureStart,
    snapshot.occurrenceExceptions
  );

  assert.deepEqual(result, { ruleId: rule.id, occurrenceStart: thirdStart, removedRule: false });
  assert.equal(keptRule.revisions.length, 1);
  assert.equal(keptRule.revisions[0].effectiveUntil, thirdStart - 1);
  assert.equal(projected.some((item) => item.occurrenceStart === thirdStart), false);
  assert.equal(projected.some((item) => item.occurrenceStart === futureStart), false);
  assert.deepEqual(
    snapshot.occurrenceExceptions.map((item) => item.occurrenceStart),
    [firstStart]
  );
});

test('删除本次及后续固定日程时仅解绑边界及未来日志，并保留历史实例追溯', () => {
  const { service, repository, now, setNow } = createHarness();
  const dayMs = 24 * 60 * 60 * 1000;
  const firstStart = now() + 60 * 60 * 1000;
  const cutoffStart = firstStart + dayMs;
  const futureStart = cutoffStart + dayMs;
  const { rule } = createRecurringPlanForTask(service, {
    title: '日志解绑边界',
    startedAt: firstStart,
    endedAt: firstStart + 30 * 60 * 1000,
    frequency: 'daily',
    interval: 1
  });
  const occurrences = projectRule(rule, firstStart, futureStart, []);
  const pastOccurrence = occurrences.find((item) => item.occurrenceStart === firstStart);
  const cutoffOccurrence = occurrences.find((item) => item.occurrenceStart === cutoffStart);
  const futureOccurrence = occurrences.find((item) => item.occurrenceStart === futureStart);
  const past = service.createManualLog({
    startedAt: pastOccurrence.startedAt,
    endedAt: pastOccurrence.endedAt,
    originRuleId: rule.id,
    originOccurrenceId: pastOccurrence.originOccurrenceId,
    note: '历史已确认',
    tags: ['历史']
  }).log;
  const atCutoff = service.createManualLog({
    startedAt: cutoffOccurrence.startedAt,
    endedAt: cutoffOccurrence.endedAt,
    originRuleId: rule.id,
    originOccurrenceId: cutoffOccurrence.originOccurrenceId,
    note: '边界候选',
    tags: ['边界']
  }).log;
  const future = service.createManualLog({
    startedAt: futureOccurrence.startedAt,
    endedAt: futureOccurrence.endedAt,
    originRuleId: rule.id,
    originOccurrenceId: futureOccurrence.originOccurrenceId,
    note: '未来已确认',
    tags: ['未来']
  }).log;
  const originalCutoffStatus = LOG_STATUS.CANDIDATE;
  const originalCutoffTags = atCutoff.tags;
  const originalFutureSummary = '旧摘要不得覆盖';
  repository.transaction((database) => {
    database.timeLogs.find((item) => item.id === atCutoff.id).status = originalCutoffStatus;
    database.timeLogs.find((item) => item.id === future.id).originRuleSummarySnapshot = originalFutureSummary;
  });
  setNow(now() + 5 * 60 * 1000);

  service.deleteRuleFollowing(rule.id, cutoffStart, true);

  const logs = new Map(service.snapshot().timeLogs.map((item) => [item.id, item]));
  assert.deepEqual(
    [logs.get(past.id).originRuleId, logs.get(past.id).originOccurrenceId],
    [rule.id, pastOccurrence.originOccurrenceId]
  );
  assert.deepEqual(
    [logs.get(atCutoff.id).originRuleId, logs.get(atCutoff.id).originOccurrenceId],
    [null, cutoffOccurrence.originOccurrenceId]
  );
  assert.equal(logs.get(atCutoff.id).originRuleSummarySnapshot, rule.title);
  assert.equal(logs.get(atCutoff.id).status, originalCutoffStatus);
  assert.deepEqual(logs.get(atCutoff.id).tags, originalCutoffTags);
  assert.equal(logs.get(atCutoff.id).updatedAt, now());
  assert.deepEqual(
    [logs.get(future.id).originRuleId, logs.get(future.id).originOccurrenceId],
    [null, futureOccurrence.originOccurrenceId]
  );
  assert.equal(logs.get(future.id).originRuleSummarySnapshot, originalFutureSummary);
  assert.equal(logs.get(future.id).updatedAt, now());
});

test('删除本次及后续固定日程时只清理边界及未来的活动与恢复草稿关联', () => {
  const dayMs = 24 * 60 * 60 * 1000;
  const activeHarness = createHarness();
  const activeFirstStart = activeHarness.now() + 60 * 60 * 1000;
  const activeCutoffStart = activeFirstStart + dayMs;
  const { rule: activeRule } = createRecurringPlanForTask(activeHarness.service, {
    title: '活动草稿解绑',
    startedAt: activeFirstStart,
    endedAt: activeFirstStart + 30 * 60 * 1000,
    frequency: 'daily',
    interval: 1
  });
  const activeOccurrences = projectRule(activeRule, activeFirstStart, activeCutoffStart, []);
  const activeCutoff = activeOccurrences.find((item) => item.occurrenceStart === activeCutoffStart);
  activeHarness.service.startTimer({
    originRuleId: activeRule.id,
    originOccurrenceId: activeCutoff.originOccurrenceId,
    note: '活动草稿内容',
    tags: ['活动']
  });
  const activeOriginalDraft = activeHarness.service.snapshot().timer.draft;

  activeHarness.service.deleteRuleFollowing(activeRule.id, activeCutoffStart, true);

  const activeSnapshot = activeHarness.service.snapshot();
  assert.deepEqual(
    [
      activeSnapshot.timer.draft.originRuleId,
      activeSnapshot.timer.draft.originOccurrenceId,
      activeSnapshot.timer.draft.originRuleSummarySnapshot
    ],
    [null, null, activeRule.title]
  );
  assert.equal(activeSnapshot.timer.draft.note, activeOriginalDraft.note);
  assert.deepEqual(activeSnapshot.timer.draft.tags, activeOriginalDraft.tags);
  assert.equal(activeSnapshot.timer.status, TIMER_STATUS.RUNNING);

  const pastHarness = createHarness();
  const pastFirstStart = pastHarness.now() + 60 * 60 * 1000;
  const pastCutoffStart = pastFirstStart + dayMs;
  const { rule: pastRule } = createRecurringPlanForTask(pastHarness.service, {
    title: '活动草稿历史',
    startedAt: pastFirstStart,
    endedAt: pastFirstStart + 30 * 60 * 1000,
    frequency: 'daily',
    interval: 1
  });
  const pastOccurrence = projectRule(pastRule, pastFirstStart, pastFirstStart, [])[0];
  pastHarness.service.startTimer({
    originRuleId: pastRule.id,
    originOccurrenceId: pastOccurrence.originOccurrenceId
  });
  pastHarness.service.deleteRuleFollowing(pastRule.id, pastCutoffStart, true);
  assert.deepEqual(
    [
      pastHarness.service.snapshot().timer.draft.originRuleId,
      pastHarness.service.snapshot().timer.draft.originOccurrenceId
    ],
    [pastRule.id, pastOccurrence.originOccurrenceId]
  );

  const recoveryPastHarness = createHarness();
  const recoveryPastFirstStart = recoveryPastHarness.now() + 60 * 60 * 1000;
  const recoveryPastCutoffStart = recoveryPastFirstStart + dayMs;
  const { rule: recoveryPastRule } = createRecurringPlanForTask(recoveryPastHarness.service, {
    title: '恢复草稿历史',
    startedAt: recoveryPastFirstStart,
    endedAt: recoveryPastFirstStart + 30 * 60 * 1000,
    frequency: 'daily',
    interval: 1
  });
  const recoveryPastOccurrence = projectRule(
    recoveryPastRule,
    recoveryPastFirstStart,
    recoveryPastFirstStart,
    []
  )[0];
  recoveryPastHarness.repository.transaction((database) => {
    database.recoveryDraft = {
      reason: '历史恢复草稿',
      createdAt: recoveryPastHarness.now(),
      timer: {
        ...createIdleTimer(),
        status: TIMER_STATUS.RUNNING,
        startedAt: recoveryPastHarness.now() - 10_000,
        draft: {
          originRuleId: recoveryPastRule.id,
          originOccurrenceId: recoveryPastOccurrence.originOccurrenceId,
          tags: []
        }
      }
    };
  });
  recoveryPastHarness.service.deleteRuleFollowing(recoveryPastRule.id, recoveryPastCutoffStart, true);
  assert.deepEqual(
    [
      recoveryPastHarness.service.snapshot().recoveryDraft.timer.draft.originRuleId,
      recoveryPastHarness.service.snapshot().recoveryDraft.timer.draft.originOccurrenceId
    ],
    [recoveryPastRule.id, recoveryPastOccurrence.originOccurrenceId]
  );

  const recoveryHarness = createHarness();
  const recoveryFirstStart = recoveryHarness.now() + 60 * 60 * 1000;
  const recoveryCutoffStart = recoveryFirstStart + dayMs;
  const { rule: recoveryRule } = createRecurringPlanForTask(recoveryHarness.service, {
    title: '恢复草稿解绑',
    startedAt: recoveryFirstStart,
    endedAt: recoveryFirstStart + 30 * 60 * 1000,
    frequency: 'daily',
    interval: 1
  });
  const recoveryCutoff = projectRule(recoveryRule, recoveryCutoffStart, recoveryCutoffStart, [])[0];
  const recoveryCreatedAt = recoveryHarness.now() - 1_000;
  const recoveryPauses = [{ startedAt: recoveryHarness.now() - 9_000, endedAt: recoveryHarness.now() - 8_000 }];
  recoveryHarness.repository.transaction((database) => {
    database.recoveryDraft = {
      reason: '保持恢复原因',
      createdAt: recoveryCreatedAt,
      timer: {
        ...createIdleTimer(),
        status: TIMER_STATUS.PAUSED,
        startedAt: recoveryHarness.now() - 10_000,
        pausedAt: recoveryHarness.now() - 7_000,
        pauses: recoveryPauses,
        draft: {
          originRuleId: recoveryRule.id,
          originOccurrenceId: recoveryCutoff.originOccurrenceId,
          originRuleSummarySnapshot: null,
          note: '恢复草稿内容',
          tags: ['恢复']
        }
      }
    };
  });
  const recoveryOriginal = recoveryHarness.service.snapshot().recoveryDraft;

  recoveryHarness.service.deleteRuleFollowing(recoveryRule.id, recoveryCutoffStart, true);

  const recoverySnapshot = recoveryHarness.service.snapshot();
  assert.deepEqual(
    [
      recoverySnapshot.recoveryDraft.timer.draft.originRuleId,
      recoverySnapshot.recoveryDraft.timer.draft.originOccurrenceId,
      recoverySnapshot.recoveryDraft.timer.draft.originRuleSummarySnapshot
    ],
    [null, null, recoveryRule.title]
  );
  assert.equal(recoverySnapshot.recoveryDraft.timer.draft.note, recoveryOriginal.timer.draft.note);
  assert.deepEqual(recoverySnapshot.recoveryDraft.timer.draft.tags, recoveryOriginal.timer.draft.tags);
  assert.equal(recoverySnapshot.recoveryDraft.reason, recoveryOriginal.reason);
  assert.equal(recoverySnapshot.recoveryDraft.createdAt, recoveryOriginal.createdAt);
  assert.equal(recoverySnapshot.recoveryDraft.timer.status, TIMER_STATUS.PAUSED);
  assert.deepEqual(recoverySnapshot.recoveryDraft.timer.pauses, recoveryPauses);
});

test('删除本次及后续固定日程写入失败时完整回滚规则、skip、日志和活动草稿', () => {
  const { service, storage, now } = createHarness();
  const dayMs = 24 * 60 * 60 * 1000;
  const firstStart = now() + 60 * 60 * 1000;
  const cutoffStart = firstStart + dayMs;
  const futureStart = cutoffStart + dayMs;
  const { rule } = createRecurringPlanForTask(service, {
    title: '删除回滚关联',
    startedAt: firstStart,
    endedAt: firstStart + 30 * 60 * 1000,
    frequency: 'daily',
    interval: 1
  });
  const occurrences = projectRule(rule, cutoffStart, futureStart, []);
  const cutoff = occurrences.find((item) => item.occurrenceStart === cutoffStart);
  const future = occurrences.find((item) => item.occurrenceStart === futureStart);
  service.skipOccurrence(rule.id, futureStart);
  service.createManualLog({
    startedAt: cutoff.startedAt,
    endedAt: cutoff.endedAt,
    originRuleId: rule.id,
    originOccurrenceId: cutoff.originOccurrenceId
  });
  service.startTimer({
    originRuleId: rule.id,
    originOccurrenceId: cutoff.originOccurrenceId,
    note: '不可丢失的活动草稿'
  });
  const before = service.snapshot();
  storage.failNextSet = true;

  assert.throws(
    () => service.deleteRuleFollowing(rule.id, cutoffStart, true),
    (error) => error.code === 'WRITE_FAILED'
  );

  assert.deepEqual(service.snapshot(), before);
});

test('编辑本次及后续会截断旧规则、创建新 ruleId，并保留过去投影和 skip', () => {
  const { service, storage } = createHarness();
  const firstStart = new Date(2026, 7, 20, 9, 0, 0, 0).getTime();
  const boundary = new Date(2026, 7, 22, 9, 0, 0, 0).getTime();
  const futureStart = new Date(2026, 7, 23, 9, 0, 0, 0).getTime();
  const oldTask = service.createTask({ title: '旧任务' });
  const newTask = service.createTask({ title: '新任务' });
  const { rule } = createRecurringPlanForTask(service, {
    title: '旧固定日程',
    taskId: oldTask.id,
    startedAt: firstStart,
    endedAt: firstStart + 30 * 60 * 1000,
    priority: 1,
    frequency: 'daily',
    interval: 1
  });
  service.skipOccurrence(rule.id, firstStart);
  service.skipOccurrence(rule.id, futureStart);
  storage.resetCalls();

  assert.equal(service.canEditRuleFollowing(rule.id, boundary), true);
  assert.deepEqual(storage.setCalls, []);

  const editedStart = new Date(2026, 7, 22, 11, 0, 0, 0).getTime();
  const result = service.editRuleFollowing(rule.id, boundary, {
    title: '新固定日程',
    taskId: newTask.id,
    startedAt: editedStart,
    endedAt: editedStart + 60 * 60 * 1000,
    priority: 3,
    frequency: 'weekly',
    interval: 2,
    weekdays: [new Date(editedStart).getDay()]
  });
  const snapshot = service.snapshot();
  const oldRule = snapshot.repeatRules.find((item) => item.id === rule.id);
  const nextRule = snapshot.repeatRules.find((item) => item.id === result.rule.id);

  assert.notEqual(result.rule.id, rule.id);
  assert.equal(result.previousRuleId, rule.id);
  assert.equal(result.removedPreviousRule, false);
  assert.equal(oldRule.title, '旧固定日程');
  assert.equal(oldRule.revisions.length, 1);
  assert.equal(oldRule.revisions[0].effectiveUntil, boundary - 1);
  assert.equal(oldRule.revisions[0].taskId, oldTask.id);
  assert.equal(nextRule.title, '新固定日程');
  assert.equal(nextRule.revisions.length, 1);
  assert.deepEqual(
    [nextRule.revisions[0].effectiveFrom, nextRule.revisions[0].startedAt, nextRule.revisions[0].endedAt],
    [editedStart, editedStart, editedStart + 60 * 60 * 1000]
  );
  assert.deepEqual(
    [nextRule.revisions[0].frequency, nextRule.revisions[0].interval, nextRule.revisions[0].weekdays],
    ['weekly', 2, [new Date(editedStart).getDay()]]
  );
  assert.equal(nextRule.revisions[0].taskId, newTask.id);
  assert.equal(projectRule(oldRule, firstStart, boundary - 1, []).length, 2);
  assert.equal(projectRule(oldRule, boundary, futureStart, []).length, 0);
  assert.deepEqual(
    snapshot.occurrenceExceptions.map((item) => [item.ruleId, item.occurrenceStart]),
    [[rule.id, firstStart]]
  );
  assert.equal(result.occurrence.ruleId, nextRule.id);
  assert.equal(result.occurrence.startedAt, editedStart);
  assert.equal(storage.setCalls.length, 1);
});

test('从首个固定日程编辑会删除旧规则，新模式不命中生效槽位时不伪造首项', () => {
  const { service } = createHarness();
  const firstStart = new Date(2026, 7, 20, 9, 0, 0, 0).getTime();
  const task = service.createTask({ title: '编辑首项任务' });
  const { rule } = createRecurringPlanForTask(service, {
    title: '编辑首项',
    taskId: task.id,
    startedAt: firstStart,
    endedAt: firstStart + 30 * 60 * 1000,
    frequency: 'daily',
    interval: 1
  });
  const editedStart = new Date(2026, 7, 20, 10, 0, 0, 0).getTime();
  const otherWeekday = (new Date(editedStart).getDay() + 1) % 7;

  const result = service.editRuleFollowing(rule.id, firstStart, {
    title: '编辑后的首项',
    taskId: task.id,
    startedAt: editedStart,
    endedAt: editedStart + 30 * 60 * 1000,
    priority: 2,
    frequency: 'weekly',
    interval: 1,
    weekdays: [otherWeekday]
  });

  assert.equal(result.removedPreviousRule, true);
  assert.equal(result.occurrence, null);
  assert.equal(service.snapshot().repeatRules.some((item) => item.id === rule.id), false);
  assert.equal(service.snapshot().repeatRules.some((item) => item.id === result.rule.id), true);
});

test('只有过去记录不阻止编辑；边界及后续的候选、实际、活动计时和恢复草稿分别阻止编辑', () => {
  const createCase = () => {
    const harness = createHarness();
    const firstStart = new Date(2026, 7, 20, 9, 0, 0, 0).getTime();
    const boundary = new Date(2026, 7, 21, 9, 0, 0, 0).getTime();
    const future = new Date(2026, 7, 22, 9, 0, 0, 0).getTime();
    const task = harness.service.createTask({ title: '关联阻止任务' });
    const { rule } = createRecurringPlanForTask(harness.service, {
      title: '关联阻止规则',
      taskId: task.id,
      startedAt: firstStart,
      endedAt: firstStart + 30 * 60 * 1000,
      frequency: 'daily',
      interval: 1
    });
    const occurrences = projectRule(rule, firstStart, future, []);
    const editInput = {
      title: '不应写入',
      taskId: task.id,
      startedAt: boundary,
      endedAt: boundary + 60 * 60 * 1000,
      priority: 2,
      frequency: 'daily',
      interval: 1
    };
    return { ...harness, task, rule, firstStart, boundary, future, occurrences, editInput };
  };

  const past = createCase();
  const pastOccurrence = past.occurrences.find((item) => item.occurrenceStart === past.firstStart);
  past.service.createManualLog({
    startedAt: pastOccurrence.startedAt,
    endedAt: pastOccurrence.endedAt,
    originRuleId: past.rule.id,
    originOccurrenceId: pastOccurrence.originOccurrenceId
  });
  assert.equal(past.service.canEditRuleFollowing(past.rule.id, past.boundary), true);

  const cases = [{
    label: '候选记录',
    setup(context) {
      const occurrence = context.occurrences.find((item) => item.occurrenceStart === context.boundary);
      const log = context.service.createManualLog({
        startedAt: occurrence.startedAt,
        endedAt: occurrence.endedAt,
        originRuleId: context.rule.id,
        originOccurrenceId: occurrence.originOccurrenceId
      }).log;
      context.repository.transaction((database) => {
        database.timeLogs.find((item) => item.id === log.id).status = LOG_STATUS.CANDIDATE;
      });
    }
  }, {
    label: '实际记录',
    setup(context) {
      const occurrence = context.occurrences.find((item) => item.occurrenceStart === context.future);
      context.service.createManualLog({
        startedAt: occurrence.startedAt,
        endedAt: occurrence.endedAt,
        originRuleId: context.rule.id,
        originOccurrenceId: occurrence.originOccurrenceId
      });
    }
  }, {
    label: '活动计时',
    setup(context) {
      const occurrence = context.occurrences.find((item) => item.occurrenceStart === context.boundary);
      context.service.startTimer({
        originRuleId: context.rule.id,
        originOccurrenceId: occurrence.originOccurrenceId
      });
    }
  }, {
    label: '恢复草稿',
    setup(context) {
      const occurrence = context.occurrences.find((item) => item.occurrenceStart === context.future);
      context.repository.transaction((database) => {
        database.recoveryDraft = {
          reason: '待恢复',
          createdAt: context.now(),
          timer: {
            ...createIdleTimer(),
            draft: {
              originRuleId: context.rule.id,
              originOccurrenceId: occurrence.originOccurrenceId,
              tags: []
            }
          }
        };
      });
    }
  }];

  cases.forEach(({ label, setup }) => {
    const context = createCase();
    setup(context);
    const before = context.service.snapshot();
    context.storage.resetCalls();
    assert.equal(context.service.canEditRuleFollowing(context.rule.id, context.boundary), false, label);
    assert.throws(
      () => context.service.editRuleFollowing(
        context.rule.id,
        context.boundary,
        context.editInput
      ),
      (error) => error.code === 'RULE_FOLLOWING_HAS_EXECUTION_REFERENCES',
      label
    );
    assert.deepEqual(context.service.snapshot(), before, label);
    assert.deepEqual(context.storage.setCalls, [], label);
  });
});

test('固定日程编辑拒绝无效、已跳过边界和早于边界自然日的开始时间，写入失败完整回滚', () => {
  const { service, storage, now } = createHarness();
  const firstStart = new Date(2026, 7, 20, 9, 0, 0, 0).getTime();
  const boundary = new Date(2026, 7, 21, 9, 0, 0, 0).getTime();
  const task = service.createTask({ title: '编辑校验任务' });
  const { rule } = createRecurringPlanForTask(service, {
    title: '编辑校验规则',
    taskId: task.id,
    startedAt: firstStart,
    endedAt: firstStart + 30 * 60 * 1000,
    frequency: 'daily',
    interval: 1
  });
  const validInput = {
    title: '有效编辑',
    taskId: task.id,
    startedAt: boundary,
    endedAt: boundary + 30 * 60 * 1000,
    priority: 1,
    frequency: 'daily',
    interval: 1
  };
  const before = service.snapshot();
  storage.resetCalls();

  assert.throws(
    () => service.editRuleFollowing(rule.id, boundary + 1, validInput),
    (error) => error.code === 'OCCURRENCE_NOT_FOUND'
  );
  assert.throws(
    () => service.editRuleFollowing(rule.id, boundary, {
      ...validInput,
      startedAt: firstStart,
      endedAt: firstStart + 30 * 60 * 1000
    }),
    (error) => error.code === 'RULE_EDIT_START_BEFORE_BOUNDARY'
  );
  assert.deepEqual(service.snapshot(), before);
  assert.deepEqual(storage.setCalls, []);

  service.skipOccurrence(rule.id, boundary);
  const skipped = service.snapshot();
  storage.resetCalls();
  assert.equal(service.canEditRuleFollowing(rule.id, boundary), false);
  assert.throws(
    () => service.editRuleFollowing(rule.id, boundary, validInput),
    (error) => error.code === 'OCCURRENCE_NOT_FOUND'
  );
  assert.deepEqual(service.snapshot(), skipped);
  assert.deepEqual(storage.setCalls, []);

  const rollback = createHarness(now());
  const rollbackTask = rollback.service.createTask({ title: '回滚任务' });
  const rollbackStart = new Date(2026, 8, 1, 9, 0, 0, 0).getTime();
  const { rule: rollbackRule } = createRecurringPlanForTask(rollback.service, {
    title: '回滚规则',
    taskId: rollbackTask.id,
    startedAt: rollbackStart,
    endedAt: rollbackStart + 30 * 60 * 1000,
    frequency: 'daily',
    interval: 1
  });
  rollback.service.skipOccurrence(rollbackRule.id, rollbackStart + 2 * 24 * 60 * 60 * 1000);
  const rollbackBefore = rollback.service.snapshot();
  rollback.storage.failNextSet = true;
  assert.throws(
    () => rollback.service.editRuleFollowing(rollbackRule.id, rollbackStart, {
      title: '失败编辑',
      taskId: rollbackTask.id,
      startedAt: rollbackStart,
      endedAt: rollbackStart + 60 * 60 * 1000,
      priority: 2,
      frequency: 'daily',
      interval: 1
    }),
    (error) => error.code === 'WRITE_FAILED'
  );
  assert.deepEqual(rollback.service.snapshot(), rollbackBefore);
});

test('固定日程 v1 只新增本次及后续编辑入口，不提供单次 override 或多 revision 写入口', () => {
  const { service } = createHarness();
  assert.equal(typeof service.editRuleFollowing, 'function');
  assert.equal(typeof service.canEditRuleFollowing, 'function');
  assert.equal(typeof service.overrideOccurrence, 'undefined');
  assert.equal(typeof service.reviseRuleFollowing, 'undefined');
  assert.equal(typeof service.saveOccurrenceException, 'undefined');
});

test('本地手工、计时和规则路径都不会生成 candidate', () => {
  const { service, setNow, now } = createHarness();
  const manual = service.createManualLog({
    startedAt: now() - 60 * 60 * 1000,
    endedAt: now() - 30 * 60 * 1000
  }).log;
  service.startTimer();
  setNow(now() + 60_000);
  const timer = service.finishTimer().log;
  const startedAt = now() + 60 * 60 * 1000;
  createRecurringPlanForTask(service, {
    title: '本地规则',
    startedAt,
    endedAt: startedAt + 30 * 60 * 1000,
    frequency: 'daily',
    interval: 1
  });
  const virtual = service.timeline(startedAt + 86_400_000, startedAt + 86_400_000 + 30 * 60 * 1000)
    .find((item) => item.virtual);
  setNow(virtual.startedAt);
  const rule = service.confirmVirtualOccurrence(virtual);

  assert.deepEqual(
    service.snapshot().timeLogs.map((item) => item.status),
    [manual.status, timer.status, rule.status]
  );
  assert.equal(service.snapshot().timeLogs.every((item) => item.status === LOG_STATUS.CONFIRMED), true);
});

test('新建重复规则拒绝非法 pattern 且不写入半成品', () => {
  const { service, now } = createHarness();
  const startedAt = now() + 60 * 60 * 1000;
  const before = service.snapshot();

  assert.throws(() => createRecurringPlanForTask(service, {
    title: '非法周规则',
    startedAt,
    endedAt: startedAt + 30 * 60 * 1000,
    frequency: 'weekly',
    interval: 1,
    weekdays: []
  }));
  assert.deepEqual(service.snapshot().repeatRules, before.repeatRules);
  assert.deepEqual(service.snapshot().calendarEvents, before.calendarEvents);
});

test('新建重复规则严格拒绝字符串 pattern 字段', () => {
  const cases = [
    {
      label: 'interval',
      patch: { frequency: 'daily', interval: '2' },
      code: 'REPEAT_INTERVAL_INVALID'
    },
    {
      label: 'weekday',
      patch: { frequency: 'weekly', interval: 1, weekdays: ['1'] },
      code: 'REPEAT_WEEKDAYS_INVALID'
    },
    {
      label: 'monthDays',
      patch: { frequency: 'monthly', interval: 1, monthDays: ['15'] },
      code: 'REPEAT_MONTH_DAYS_INVALID'
    }
  ];

  cases.forEach(({ label, patch, code }) => {
    const createHarnessResult = createHarness();
    const createStart = createHarnessResult.now() + 60 * 60 * 1000;
    assert.throws(
      () => createRecurringPlanForTask(createHarnessResult.service, {
        title: `新建严格校验 ${label}`,
        startedAt: createStart,
        endedAt: createStart + 30 * 60 * 1000,
        ...patch
      }),
      (error) => error.code === code,
      `createRecurringPlan 应拒绝字符串 ${label}`
    );
    assert.equal(createHarnessResult.service.snapshot().repeatRules.length, 0);
    assert.equal(createHarnessResult.service.snapshot().calendarEvents.length, 0);
  });
});

function importedWish(id, title, now) {
  return { id, title, createdAt: now, updatedAt: now };
}

function importedProject(id, title, now) {
  return {
    id,
    title,
    deadlineAt: now + 86_400_000,
    status: 'active',
    createdAt: now,
    updatedAt: now
  };
}

function importedLog(id, now) {
  return {
    id,
    schemaVersion: 1,
    startedAt: now - 3_600_000,
    endedAt: now - 1_800_000,
    durationMinutes: 30,
    projectId: null,
    projectNameSnapshot: null,
    taskId: null,
    taskNameSnapshot: null,
    calendarEventId: null,
    calendarEventSummarySnapshot: null,
    note: '导入候选',
    status: LOG_STATUS.CANDIDATE,
    source: LOG_SOURCE.FILE,
    originRuleId: null,
    originOccurrenceId: null,
    originRuleSummarySnapshot: null,
    tags: ['导入'],
    createdAt: now,
    updatedAt: now
  };
}

test('M1：首次资料库生成匿名资料库且不再包含分类实体', () => {
  const { service } = createHarness();
  const snapshot = service.snapshot();

  assert.match(snapshot.localProfile.id, /^profile_/);
  assert.equal(Object.hasOwn(snapshot, 'categories'), false);
  assert.equal(service.createCategory, undefined);
  assert.equal(service.renameCategory, undefined);
  assert.equal(service.archiveCategory, undefined);
});

test('应用服务只读暴露仓储容量且不触发写入', () => {
  const { service, storage } = createHarness();
  storage.resetCalls();

  const usage = service.storageUsage();

  assert.equal(usage.databaseLimitBytes, 1024 * 1024);
  assert.equal(typeof usage.databaseBytes, 'number');
  assert.deepEqual(storage.setCalls, []);
});

test('新建记录和计时草稿统一规范化标签并执行 10/5 中英文折算上限', () => {
  const { service, now } = createHarness();
  const manual = service.createManualLog({
    startedAt: now() - 3_600_000,
    endedAt: now() - 1_800_000,
    tags: [' ＡＩ ', 'AI', 'ai']
  }).log;
  assert.deepEqual(manual.tags, ['AI', 'ai']);

  const englishTag = service.createManualLog({
    startedAt: now() - 1_700_000,
    endedAt: now() - 1_600_000,
    tags: ['timeboxing']
  }).log;
  assert.deepEqual(englishTag.tags, ['timeboxing']);

  assert.throws(
    () => service.createManualLog({
      startedAt: now() - 1_700_000,
      endedAt: now() - 1_600_000,
      tags: ['一二三四五六']
    }),
    (error) => error.code === 'TAG_TOO_LONG'
  );

  const timer = service.startTimer({ tags: [' 复　盘 ', '复 盘'] });
  assert.deepEqual(timer.draft.tags, ['复 盘']);
  assert.throws(
    () => service.updateTimerDraft({
      tags: Array.from({ length: 11 }, (_, index) => String(index))
    }),
    (error) => error.code === 'TAG_COUNT_EXCEEDED'
  );
});

test('手工日志按秒级暂停契约创建，且拒绝无有效秒的区间', () => {
  const { service, now } = createHarness();
  const timestamp = now() - 60_000;
  const shortManual = service.createManualLog({ startedAt: timestamp, endedAt: timestamp + 20_000 }).log;
  assert.equal(shortManual.pausedDurationSeconds, 0);
  assert.equal(shortManual.durationMinutes, 1);

  const paused = service.createManualLog({
    startedAt: timestamp,
    endedAt: timestamp + 120_999,
    pausedDurationSeconds: 61
  }).log;
  assert.equal(paused.pausedDurationSeconds, 61);
  assert.equal(paused.durationMinutes, 1);

  assert.throws(
    () => service.createManualLog({ startedAt: timestamp, endedAt: timestamp }),
    (error) => error.code === 'LOG_TIMING_INVALID'
  );

  assert.throws(
    () => service.createManualLog({ startedAt: timestamp, endedAt: timestamp - 1 }),
    (error) => error.code === 'TIME_RANGE_INVALID' && error.message === '手工补录时间的结束时间不能早于开始时间'
  );
});

test('更新日志保留旧暂停秒数或按新值重算，非法缩短时零写入', () => {
  const { service, storage, now } = createHarness();
  const startedAt = now() - 300_000;
  const created = service.createManualLog({
    startedAt,
    endedAt: startedAt + 180_000,
    pausedDurationSeconds: 61
  }).log;

  const inheritedResult = service.updateLog(created.id, { note: '保留暂停' });
  assert.deepEqual(Object.keys(inheritedResult), ['log']);
  const inherited = inheritedResult.log;
  assert.equal(inherited.pausedDurationSeconds, 61);
  assert.equal(inherited.durationMinutes, 2);

  const recalculated = service.updateLog(created.id, { pausedDurationSeconds: 1 }).log;
  assert.equal(recalculated.pausedDurationSeconds, 1);
  assert.equal(recalculated.durationMinutes, 3);

  const before = service.snapshot();
  storage.resetCalls();
  assert.throws(
    () => service.updateLog(created.id, {
      endedAt: startedAt + 1_000,
      pausedDurationSeconds: 1
    }),
    (error) => error.code === 'LOG_TIMING_INVALID'
  );
  assert.deepEqual(service.snapshot(), before);
  assert.deepEqual(storage.setCalls, []);
});

test('导入的超限计时草稿在不改标签时可生成记录或从恢复草稿确认', () => {
  const { service, repository, now } = createHarness();
  const importedTags = Array.from({ length: 11 }, (_, index) => `标签${index}`);
  repository.transaction((database) => {
    database.timer = {
      status: TIMER_STATUS.RUNNING,
      startedAt: now() - 120_000,
      pausedAt: null,
      pauses: [],
      draft: { tags: importedTags }
    };
  });
  assert.deepEqual(service.finishTimer().log.tags, importedTags);

  repository.transaction((database) => {
    database.recoveryDraft = {
      reason: '导入的恢复草稿',
      timer: {
        ...createIdleTimer(),
        draft: { tags: importedTags }
      },
      createdAt: now()
    };
  });
  const recovered = service.createRecoveryConfirmedLog({
    startedAt: now() - 50_000,
    endedAt: now() - 10_000
  });
  assert.deepEqual(recovered.tags, importedTags);
});

test('新建项目丢弃传入的 OKR 字段', () => {
  const { service, now } = createHarness();
  const project = service.createProject({
    title: '学习项目',
    deadlineAt: now() + 86_400_000,
    objectives: [{ title: '过时目标', keyResults: [{ title: '过时结果', currentValue: 20 }] }]
  });

  assert.equal(Object.hasOwn(project, 'objectives'), false);
  assert.equal(Object.hasOwn(service.snapshot().projects[0], 'objectives'), false);
});

test('M1/M3：活动项目不能超过五个', () => {
  const { service, now } = createHarness();
  service.createProject({ title: '学习项目', deadlineAt: now() + 86_400_000 });

  for (let index = 1; index < 5; index += 1) {
    service.createProject({ title: `项目${index}`, deadlineAt: now() + 86_400_000 });
  }
  assert.throws(() => service.createProject({ title: '第六个项目', deadlineAt: now() + 86_400_000 }), (error) => error.code === 'ACTIVE_PROJECT_LIMIT');
});

test('项目改名只更新项目，关联 TODO 的名称快照与更新时间保持不变', () => {
  const { service, setNow, now } = createHarness();
  const project = service.createProject({ title: '旧项目名', deadlineAt: now() + 86_400_000 });
  const linkedTodo = service.createTask({ title: '关联 TODO', projectId: project.id });
  const unlinkedTodo = service.createTask({ title: '独立 TODO' });
  const beforeTasks = clone(service.snapshot().tasks);
  const renamedAt = now() + 1_000;
  setNow(renamedAt);

  service.updateProject(project.id, { title: '新项目名' });

  const snapshot = service.snapshot();
  assert.equal(snapshot.projects.find((item) => item.id === project.id).updatedAt, renamedAt);
  assert.deepEqual(snapshot.tasks, beforeTasks);
  assert.equal(snapshot.tasks.find((task) => task.id === linkedTodo.id).projectNameSnapshot, '旧项目名');
  assert.equal(snapshot.tasks.find((task) => task.id === unlinkedTodo.id).projectNameSnapshot, null);
});

test('M3：新建任务插入开头，后续修改不重排保存顺序', () => {
  const { service, setNow, now } = createHarness();
  const first = service.createTask({ title: '先创建的任务' });
  setNow(now() + 1);
  const second = service.createTask({ title: '后创建的任务' });

  assert.deepEqual(service.snapshot().tasks.map((task) => task.id), [second.id, first.id]);

  setNow(now() + 1);
  service.updateTask(first.id, { status: TASK_STATUS.COMPLETED });
  service.updateTask(second.id, { title: '已修改的后创建任务' });
  assert.deepEqual(service.snapshot().tasks.map((task) => task.id), [second.id, first.id]);
});

test('M3：新建任务忽略外部完成状态并始终保存为 todo', () => {
  const { service } = createHarness();

  const task = service.createTask({ title: '不能直接完成', status: TASK_STATUS.COMPLETED });

  assert.equal(task.status, TASK_STATUS.TODO);
  assert.equal(task.completedAt, null);
});

test('M3：任务首次完成记录时间且重复完成保持原完成时间', () => {
  const { service, setNow, now } = createHarness();
  const task = service.createTask({ title: '完成一次' });
  const firstCompletedAt = now() + 1_000;
  setNow(firstCompletedAt);

  const completed = service.updateTask(task.id, { status: TASK_STATUS.COMPLETED });
  setNow(firstCompletedAt + 1_000);
  const completedAgain = service.updateTask(task.id, { status: TASK_STATUS.COMPLETED });

  assert.equal(completed.completedAt, firstCompletedAt);
  assert.equal(completed.updatedAt, firstCompletedAt);
  assert.equal(completedAgain.completedAt, firstCompletedAt);
  assert.equal(completedAgain.updatedAt, firstCompletedAt);
});

test('M3：重新打开清空完成时间且再次完成生成新时间', () => {
  const { service, setNow, now } = createHarness();
  const task = service.createTask({ title: '重新完成' });
  const firstCompletedAt = now() + 1_000;
  setNow(firstCompletedAt);
  service.updateTask(task.id, { status: TASK_STATUS.COMPLETED });
  setNow(firstCompletedAt + 1_000);

  const reopened = service.updateTask(task.id, { status: TASK_STATUS.TODO });
  assert.equal(reopened.completedAt, null);

  const secondCompletedAt = firstCompletedAt + 2_000;
  setNow(secondCompletedAt);
  const completedAgain = service.updateTask(task.id, { status: TASK_STATUS.COMPLETED });
  assert.equal(completedAgain.completedAt, secondCompletedAt);
});

test('M2：点击结束计时会立即写入 confirmed', () => {
  const { service, setNow, now } = createHarness();
  service.startTimer({ note: '专注' });
  setNow(now() + 30 * 60 * 1000);
  service.pauseTimer();
  setNow(now() + 10 * 60 * 1000);
  service.resumeTimer();
  setNow(now() + 20 * 60 * 1000);
  const result = service.finishTimer();
  assert.deepEqual(Object.keys(result), ['log']);
  const { log } = result;
  assert.equal(log.durationMinutes, 50);
  assert.equal(log.status, LOG_STATUS.CONFIRMED);
  assert.equal(service.snapshot().timer.status, TIMER_STATUS.IDLE);
});

test('M2：暂停遇到墙钟倒退时单次取时并原子转为恢复草稿', () => {
  const capturedNow = 1_700_000_000_000;
  const originalTimer = {
    ...createIdleTimer(),
    status: TIMER_STATUS.RUNNING,
    startedAt: capturedNow + 1_000,
    draft: { note: '暂停前原稿', tags: ['原稿'] }
  };
  const { service, nowCalls } = createStoredTimerHarness(originalTimer, capturedNow);

  const result = service.pauseTimer();
  const snapshot = service.snapshot();

  assert.equal(nowCalls(), 1);
  assert.equal(result.state, 'draft');
  assert.equal(snapshot.timer.status, TIMER_STATUS.IDLE);
  assert.equal(snapshot.timeLogs.length, 0);
  assert.deepEqual(snapshot.recoveryDraft.timer, originalTimer);
  assert.equal(snapshot.recoveryDraft.createdAt, capturedNow);
  assert.equal(snapshot.updatedAt, capturedNow);
});

test('M2：恢复遇到 pausedAt 晚于墙钟时单次取时并保留原 timer', () => {
  const capturedNow = 1_700_000_000_000;
  const originalTimer = {
    ...createIdleTimer(),
    status: TIMER_STATUS.PAUSED,
    startedAt: capturedNow - 60_000,
    pausedAt: capturedNow + 1,
    draft: { note: '恢复前原稿', tags: [] }
  };
  const { service, nowCalls } = createStoredTimerHarness(originalTimer, capturedNow);

  const result = service.resumeTimer();
  const snapshot = service.snapshot();

  assert.equal(nowCalls(), 1);
  assert.equal(result.state, 'draft');
  assert.equal(snapshot.timer.status, TIMER_STATUS.IDLE);
  assert.equal(snapshot.timeLogs.length, 0);
  assert.deepEqual(snapshot.recoveryDraft.timer, originalTimer);
});

test('M2：结束遇到倒序、重叠或晚于当前时刻的暂停时只保留完整恢复草稿', () => {
  const capturedNow = 1_700_000_100_000;
  const startedAt = capturedNow - 100_000;
  const invalidPauses = [
    [
      { startedAt: startedAt + 50_000, endedAt: startedAt + 60_000 },
      { startedAt: startedAt + 10_000, endedAt: startedAt + 20_000 }
    ],
    [
      { startedAt: startedAt + 10_000, endedAt: startedAt + 60_000 },
      { startedAt: startedAt + 50_000, endedAt: startedAt + 70_000 }
    ],
    [{ startedAt: startedAt + 10_000, endedAt: capturedNow + 1 }]
  ];

  invalidPauses.forEach((pauses) => {
    const originalTimer = {
      ...createIdleTimer(),
      status: TIMER_STATUS.RUNNING,
      startedAt,
      pauses,
      draft: { note: '不能生成日志', tags: [] }
    };
    const { service, nowCalls } = createStoredTimerHarness(originalTimer, capturedNow);

    const result = service.finishTimer({ note: '不得解析的新值' });
    const snapshot = service.snapshot();

    assert.equal(nowCalls(), 1);
    assert.equal(result.state, 'draft');
    assert.equal(snapshot.timer.status, TIMER_STATUS.IDLE);
    assert.equal(snapshot.timeLogs.length, 0);
    assert.deepEqual(snapshot.recoveryDraft.timer, originalTimer);
  });
});

test('M2：正常结束按完整暂停区间写入精确暂停秒数', () => {
  const { service, setNow, now } = createHarness();
  const startedAt = now();
  service.startTimer({ note: '两小时区间' });
  setNow(startedAt + 30 * 60_000);
  service.pauseTimer();
  setNow(startedAt + 90 * 60_000);
  service.resumeTimer();
  setNow(startedAt + 120 * 60_000);

  const { log } = service.finishTimer({ pausedDurationSeconds: 1 });

  assert.equal(log.pausedDurationSeconds, 3_600);
  assert.equal(log.durationMinutes, 60);
});

test('M2：正常结束使用唯一捕获时刻同时写日志和根更新时间', () => {
  const capturedNow = 1_700_000_060_000;
  const originalTimer = {
    ...createIdleTimer(),
    status: TIMER_STATUS.RUNNING,
    startedAt: capturedNow - 60_000,
    draft: { note: '单时刻结束', tags: [] }
  };
  const { service, nowCalls } = createStoredTimerHarness(originalTimer, capturedNow);

  const { log } = service.finishTimer();
  const snapshot = service.snapshot();

  assert.equal(nowCalls(), 1);
  assert.equal(log.endedAt, capturedNow);
  assert.equal(log.createdAt, capturedNow);
  assert.equal(snapshot.updatedAt, capturedNow);
});

test('M2：短时计时生成的已确认记录至少计为一分钟', () => {
  const { service, setNow, now } = createHarness();
  service.startTimer({ note: '快速记录' });
  setNow(now() + 5_000);
  const { log } = service.finishTimer();
  assert.equal(log.durationMinutes, 1);
  assert.equal(log.status, LOG_STATUS.CONFIRMED);
  assert.equal(log.note, '快速记录');
});

test('M2：计时记录超过整分钟后向上取整', () => {
  for (const [elapsedMilliseconds, expectedMinutes] of [[60_000, 1], [60_999, 1], [61_000, 2], [119_999, 2]]) {
    const { service, setNow, now } = createHarness();
    service.startTimer({ note: '向上取整' });
    setNow(now() + elapsedMilliseconds);
    assert.equal(service.finishTimer().log.durationMinutes, expectedMinutes);
  }
});

test('M2：恢复草稿经用户修正并保存后创建实际记录、纳入默认统计且清除草稿', () => {
  const { service, setNow, now } = createHarness();
  const startedAt = now();
  service.startTimer({ note: '需修正的计时' });
  setNow(startedAt - 1_000);
  const recovered = service.recoverTimer();
  assert.equal(recovered.state, 'draft');

  setNow(startedAt + 60_000);
  const log = service.createRecoveryConfirmedLog({
    startedAt,
    endedAt: now(),
    note: '已修正的计时'
  });
  assert.equal(log.status, LOG_STATUS.CONFIRMED);
  assert.equal(log.source, LOG_SOURCE.TIMER);
  assert.equal(log.note, '已修正的计时');
  assert.equal(service.snapshot().recoveryDraft, null);
  const statistics = service.statistics({ rangeStart: startedAt - 1, rangeEnd: now() + 1 });
  assert.equal(statistics.totalMinutes, 1);
  assert.equal(statistics.weeklyReview.logCount, 1);
});

test('M2：待修正恢复草稿必须先确认或明确放弃，才可开始新的计时', () => {
  const { service, setNow, now } = createHarness();
  const startedAt = now();
  service.startTimer({ note: '需要修正的计时' });
  setNow(startedAt - 1_000);
  assert.equal(service.recoverTimer().state, 'draft');

  assert.throws(
    () => service.startTimer({ note: '不应静默覆盖草稿' }),
    (error) => error.code === 'RECOVERY_DRAFT_PENDING'
  );
  assert.ok(service.snapshot().recoveryDraft);

  assert.deepEqual(service.discardRecoveryDraft(), { discarded: true });
  assert.equal(service.snapshot().recoveryDraft, null);
  assert.equal(service.startTimer({ note: '新的计时' }).status, TIMER_STATUS.RUNNING);
});

test('开发调试可即时构造需要手工修正的恢复草稿', () => {
  const { service, now } = createHarness();

  const recovered = service.simulateTimerRecoveryFailureForDebug();
  const snapshot = service.snapshot();

  assert.equal(recovered.state, 'draft');
  assert.equal(snapshot.timer.status, TIMER_STATUS.IDLE);
  assert.equal(snapshot.timeLogs.length, 0);
  assert.equal(snapshot.recoveryDraft.reason, '时间戳无法还原，请手工修正并确认记录');
  assert.equal(snapshot.recoveryDraft.timer.status, TIMER_STATUS.RUNNING);
  assert.equal(snapshot.recoveryDraft.timer.pausedAt, now());
  assert.deepEqual(snapshot.recoveryDraft.timer.draft.tags, []);
  assert.throws(
    () => service.simulateTimerRecoveryFailureForDebug(),
    (error) => error.code === 'DEBUG_RECOVERY_DRAFT_EXISTS'
  );
});

test('开发调试不会覆盖进行中的计时', () => {
  const { service } = createHarness();
  service.startTimer({ note: '正在计时' });

  assert.throws(
    () => service.simulateTimerRecoveryFailureForDebug(),
    (error) => error.code === 'DEBUG_TIMER_TEST_REQUIRES_IDLE'
  );
});

test('M2：超过 24 小时的计时恢复为待审核草稿，不写入候选记录', () => {
  const { service, repository, setNow, now } = createHarness();
  service.startTimer({ note: '异常恢复' });
  const importedTags = [
    '超过五个字符',
    ...Array.from({ length: 10 }, (_, index) => `标签${index}`)
  ];
  repository.transaction((database) => {
    database.timer.draft.tags = importedTags;
  });
  setNow(now() + MAX_TIMER_SPAN_MS + 60_000);
  const recovered = service.recoverTimer();

  assert.equal(recovered.state, 'draft');
  assert.deepEqual(recovered.recoveryDraft.candidatePreview, {
    startedAt: now() - MAX_TIMER_SPAN_MS - 60_000,
    endedAt: now() - 60_000,
    pausedDurationSeconds: 0,
    durationMinutes: 24 * 60,
    source: LOG_SOURCE.TIMER
  });
  assert.deepEqual(recovered.recoveryDraft.timer.draft.tags, importedTags);
  assert.equal(service.snapshot().timer.status, TIMER_STATUS.IDLE);
  assert.equal(service.snapshot().timeLogs.length, 0);
});

test('M2：暂停状态超时恢复时扣除尚未结束的暂停区间', () => {
  const { service, setNow, now } = createHarness();
  const startedAt = now();
  service.startTimer({ note: '运行一小时后长时间暂停' });
  setNow(startedAt + 60 * 60 * 1000);
  service.pauseTimer();
  setNow(startedAt + MAX_TIMER_SPAN_MS + 60 * 60 * 1000);

  const recovered = service.recoverTimer();

  assert.equal(recovered.state, 'draft');
  assert.equal(recovered.recoveryDraft.candidatePreview.startedAt, startedAt);
  assert.equal(recovered.recoveryDraft.candidatePreview.endedAt, startedAt + MAX_TIMER_SPAN_MS);
  assert.equal(recovered.recoveryDraft.candidatePreview.durationMinutes, 60);
  assert.equal(service.snapshot().timer.status, TIMER_STATUS.IDLE);
  assert.equal(service.snapshot().timeLogs.length, 0);
});

test('M2：超时恢复候选沿用计时器向上取整口径', () => {
  const { service, setNow, now } = createHarness();
  const startedAt = now();
  service.startTimer({ note: '短时恢复' });
  setNow(startedAt + 61_000);
  service.pauseTimer();
  setNow(startedAt + MAX_TIMER_SPAN_MS + 1);

  const recovered = service.recoverTimer();
  const preview = recovered.recoveryDraft.candidatePreview;
  const log = service.createRecoveryConfirmedLog({
    startedAt: preview.startedAt,
    endedAt: preview.endedAt
  });

  assert.equal(preview.durationMinutes, 2);
  assert.equal(log.durationMinutes, 2);
});

test('M2：直接核实超时恢复候选时保留已扣除暂停区间的时长', () => {
  const { service, setNow, now } = createHarness();
  const startedAt = now();
  service.startTimer({ note: '运行一小时后长时间暂停' });
  setNow(startedAt + 60 * 60 * 1_000);
  service.pauseTimer();
  setNow(startedAt + MAX_TIMER_SPAN_MS + 60 * 60 * 1_000);

  const recovered = service.recoverTimer();
  const preview = recovered.recoveryDraft.candidatePreview;
  const log = service.createRecoveryConfirmedLog({
    startedAt: preview.startedAt,
    endedAt: preview.endedAt
  });

  assert.equal(preview.durationMinutes, 60);
  assert.equal(log.durationMinutes, 60);
  assert.equal(log.status, LOG_STATUS.CONFIRMED);
  assert.equal(service.snapshot().recoveryDraft, null);
});

test('M2：全程暂停的超时计时不伪造一分钟候选预览', () => {
  const { service, setNow, now } = createHarness();
  const startedAt = now();
  service.startTimer({ note: '全程暂停' });
  service.pauseTimer();
  setNow(startedAt + MAX_TIMER_SPAN_MS + 1);

  const recovered = service.recoverTimer();

  assert.equal(recovered.state, 'draft');
  assert.equal(Object.hasOwn(recovered.recoveryDraft, 'candidatePreview'), false);
});

test('M2：暂停区间不自洽时只保留恢复草稿', () => {
  const { service, storage, setNow, now } = createHarness();
  const startedAt = now();
  service.startTimer({ note: '暂停数据异常' });
  setNow(startedAt + 60 * 60 * 1000);
  service.pauseTimer();
  const corrupted = service.snapshot();
  corrupted.timer.pauses = [{
    startedAt: startedAt + 30 * 60 * 1000,
    endedAt: startedAt + 90 * 60 * 1000
  }];
  storage.set(STORAGE_KEY, corrupted);
  const recoveryNow = startedAt + MAX_TIMER_SPAN_MS + 60 * 60 * 1000;
  setNow(recoveryNow);
  const { service: reloadedService, initialized: recovered } = createHarness(recoveryNow, storage);
  const snapshot = reloadedService.snapshot();

  assert.equal(recovered.state, 'draft');
  assert.equal(snapshot.timer.status, TIMER_STATUS.IDLE);
  assert.equal(snapshot.timeLogs.length, 0);
  assert.equal(snapshot.recoveryDraft.timer.pausedAt, startedAt + 60 * 60 * 1000);
});

test('M2：运行态字段矛盾时不得恢复或生成候选', () => {
  const { service, storage, now } = createHarness();
  const startedAt = now();
  service.startTimer({ note: '运行态字段异常' });
  const corrupted = service.snapshot();
  corrupted.timer.pausedAt = startedAt + 30 * 60 * 1000;
  storage.set(STORAGE_KEY, corrupted);
  const recoveryNow = startedAt + 60 * 60 * 1000;
  const { service: reloadedService, initialized: recovered } = createHarness(recoveryNow, storage);
  const snapshot = reloadedService.snapshot();

  assert.equal(recovered.state, 'draft');
  assert.equal(snapshot.timer.status, TIMER_STATUS.IDLE);
  assert.equal(snapshot.timeLogs.length, 0);
  assert.equal(snapshot.recoveryDraft.timer.pausedAt, startedAt + 30 * 60 * 1000);
});

test('M2：已有恢复草稿时丢弃冲突的活动计时且不覆盖原草稿', () => {
  const capturedNow = 1_700_000_000_000;
  const database = createInitialDatabase(capturedNow - 20_000);
  database.timer = {
    ...createIdleTimer(),
    status: TIMER_STATUS.RUNNING,
    startedAt: capturedNow - 10_000,
    draft: { note: '应丢弃的新计时', tags: [] }
  };
  database.recoveryDraft = {
    reason: '必须保留的旧恢复草稿',
    timer: {
      ...createIdleTimer(),
      status: TIMER_STATUS.RUNNING,
      startedAt: capturedNow - 20_000,
      draft: { note: '必须保留的旧草稿', tags: [] }
    },
    createdAt: capturedNow - 5_000
  };
  const originalRecoveryDraft = clone(database.recoveryDraft);
  const storage = new TrackingStorage();
  storage.set(STORAGE_KEY, database);
  const repository = new LocalRepository(storage, { now: () => capturedNow });
  const service = new ApplicationService(repository, {
    now: () => capturedNow,
    recoveryTimerSpanMs: 5_000
  });

  const recovered = service.initialize();
  const snapshot = service.snapshot();

  assert.equal(recovered.state, 'draft');
  assert.equal(recovered.timerDiscarded, true);
  assert.deepEqual(snapshot.timer, createIdleTimer());
  assert.deepEqual(snapshot.recoveryDraft, originalRecoveryDraft);
});

test('M2：冷启动恢复只捕获一次当前时刻', () => {
  const capturedNow = 1_700_000_000_000;
  const originalTimer = {
    ...createIdleTimer(),
    status: TIMER_STATUS.RUNNING,
    startedAt: capturedNow - 1_000,
    draft: { note: '有效计时', tags: [] }
  };
  const { service, nowCalls } = createStoredTimerHarness(originalTimer, capturedNow);

  const recovered = service.recoverTimer();

  assert.equal(nowCalls(), 1);
  assert.equal(recovered.state, 'resumed');
});

test('活动计时在恢复窗口内且关联未变化时不写主库或推进 updatedAt', () => {
  const { service, storage, now } = createHarness();
  service.startTimer({ note: '保持不变' });
  const before = service.snapshot();
  storage.resetCalls();

  const result = service.recoverTimer();

  assert.equal(result.state, 'resumed');
  assert.deepEqual(storage.setCalls, []);
  assert.equal(service.snapshot().updatedAt, before.updatedAt);
  assert.equal(now() - service.snapshot().timer.startedAt <= MAX_TIMER_SPAN_MS, true);
});

test('导入预览期间无变化恢复不会制造假 stale', () => {
  const { service, storage } = createHarness();
  service.startTimer({ note: '保持预览基线' });
  const prepared = service.prepareJsonImport(service.exportJson());
  service.previewJsonImport(prepared.token, { mode: IMPORT_MODE.INCREMENTAL });
  storage.resetCalls();

  assert.equal(service.recoverTimer().state, 'resumed');
  assert.deepEqual(storage.setCalls, []);
  assert.doesNotThrow(() => service.commitJsonImport(prepared.token));
});

test('M4：重复实例按需投影，确认后不会再次投影', () => {
  const { service, setNow, now } = createHarness();
  const start = now() + 60 * 60 * 1000;
  const repeated = createRecurringPlanForTask(service, {
    title: '晨间阅读',
    startedAt: start,
    endedAt: start + 30 * 60 * 1000,
    priority: 3,
    frequency: 'daily',
    interval: 1
  });
  const timeline = service.timeline(start, start + 2 * 24 * 60 * 60 * 1000);
  const virtual = timeline.find((item) => item.virtual);
  assert.equal(virtual.priority, 3);
  setNow(virtual.startedAt);
  service.confirmVirtualOccurrence({ ...virtual });
  const after = service.timeline(start, start + 2 * 24 * 60 * 60 * 1000);
  assert.equal(after.filter((item) => item.originOccurrenceId === virtual.originOccurrenceId).length, 1);
  assert.equal(repeated.rule.revisions[0].frequency, 'daily');
});

test('日历实际记录优先显示备注，空备注沿用任务名称与时间记录回退', () => {
  const { service, now } = createHarness();
  const startedAt = now() + 60 * 60 * 1000;
  const task = service.createTask({ title: '整理资料' });
  const event = service.createCalendarEvent({
    title: '上午计划',
    taskId: task.id,
    startedAt,
    endedAt: startedAt + 30 * 60 * 1000,
    priority: 1
  });
  const noted = service.createManualLog({
    calendarEventId: event.id,
    startedAt,
    endedAt: startedAt + 10 * 60 * 1000,
    note: '  实际复盘  '
  }).log;
  const taskFallback = service.createManualLog({
    calendarEventId: event.id,
    startedAt: startedAt + 10 * 60 * 1000,
    endedAt: startedAt + 20 * 60 * 1000,
    note: '\u200B  '
  }).log;
  const genericFallback = service.createManualLog({
    startedAt: startedAt + 20 * 60 * 1000,
    endedAt: startedAt + 30 * 60 * 1000,
    note: ''
  }).log;

  const actualById = new Map(service.timeline(
    startedAt,
    startedAt + 30 * 60 * 1000
  ).filter((item) => item.type === LOG_STATUS.CONFIRMED).map((item) => [item.id, item]));

  assert.equal(actualById.get(noted.id).title, '实际复盘');
  assert.equal(actualById.get(taskFallback.id).title, '整理资料');
  assert.equal(actualById.get(genericFallback.id).title, '时间记录');
});

test('M4/M5：跨查询起点的过夜重复实例进入时间线和计划统计，但不伪造实际记录', () => {
  const { service } = createHarness();
  const firstStart = new Date(2026, 6, 1, 23, 30, 0, 0).getTime();
  const queryStart = new Date(2026, 6, 3, 0, 0, 0, 0).getTime();
  const expectedOccurrenceStart = new Date(2026, 6, 2, 23, 30, 0, 0).getTime();
  createRecurringPlanForTask(service, {
    title: '跨日起居',
    startedAt: firstStart,
    endedAt: firstStart + 60 * 60 * 1000,
    priority: 1,
    frequency: 'daily',
    interval: 1
  });

  const timeline = service.timeline(queryStart, queryStart + 15 * 60 * 1000);
  const occurrence = timeline.find((item) => item.virtual);
  const statistics = service.statistics({
    rangeStart: queryStart,
    rangeEnd: queryStart + 15 * 60 * 1000,
    includeCandidates: true
  });

  assert.equal(occurrence.occurrenceStart, expectedOccurrenceStart);
  assert.equal(occurrence.startedAt, expectedOccurrenceStart);
  assert.equal(occurrence.endedAt, queryStart + 30 * 60 * 1000);
  assert.equal(statistics.totalMinutes, 0);
  assert.equal(statistics.weeklyReview.logCount, 0);
  assert.equal(statistics.planVariance.events.length, 1);
  assert.equal(statistics.planVariance.events[0].plannedMinutes, 60);
  assert.equal(statistics.planVariance.events[0].actualMinutes, 0);
});

test('M4：固定日程首次实例只由规则投影且不写入 CalendarEvent', () => {
  const { service, now } = createHarness();
  const start = now() + 60 * 60 * 1000;
  const { occurrence, rule } = createRecurringPlanForTask(service, {
    title: '纯规则固定日程',
    startedAt: start,
    endedAt: start + 30 * 60 * 1000,
    priority: 1,
    frequency: 'daily',
    interval: 1
  });
  const timeline = service.timeline(start, start + 30 * 60 * 1000);
  const statistics = service.statistics({
    rangeStart: start,
    rangeEnd: start + 30 * 60 * 1000
  });

  assert.equal(service.snapshot().calendarEvents.length, 0);
  assert.equal(occurrence.virtual, true);
  assert.equal(occurrence.ruleId, rule.id);
  assert.equal(timeline.filter((item) => item.id === occurrence.id).length, 1);
  assert.equal(statistics.planVariance.events.some((item) => item.eventId === occurrence.id), true);
});

test('M4：规则生效时间不命中所选重复日期时不伪造首次投影', () => {
  const { service, now } = createHarness();
  const start = now() + 60 * 60 * 1000;
  const weekday = (new Date(start).getDay() + 1) % 7;
  const result = createRecurringPlanForTask(service, {
    title: '次日才发生的固定日程',
    startedAt: start,
    endedAt: start + 30 * 60 * 1000,
    priority: 1,
    frequency: 'weekly',
    interval: 1,
    weekdays: [weekday]
  });

  assert.equal(result.occurrence, null);
  assert.equal(service.snapshot().repeatRules.length, 1);
  assert.equal(service.snapshot().calendarEvents.length, 0);
});

test('重叠只作为范围内持久化日志的 timeline 元数据，保存结果与统计不再返回重叠提示', () => {
  const { service, repository, now } = createHarness();
  const start = now() - 60 * 60 * 1000;
  const firstResult = service.createManualLog({
    startedAt: start,
    endedAt: start + 40 * 60 * 1000,
    note: '甲'
  });
  const secondResult = service.createManualLog({
    startedAt: start + 20 * 60 * 1000,
    endedAt: start + 50 * 60 * 1000,
    note: '乙'
  });
  assert.deepEqual(Object.keys(firstResult), ['log']);
  assert.deepEqual(Object.keys(secondResult), ['log']);
  repository.transaction((database) => {
    database.timeLogs.find((item) => item.id === secondResult.log.id).status = LOG_STATUS.CANDIDATE;
  });

  const task = service.createTask({ title: '重叠测试任务' });
  const plan = createCalendarEventForTask(service, {
    title: '范围内计划',
    startedAt: start,
    endedAt: start + 30 * 60 * 1000,
    taskId: task.id
  });
  createRecurringPlanForTask(service, {
    title: '范围内重复计划',
    startedAt: start,
    endedAt: start + 30 * 60 * 1000,
    frequency: 'daily',
    interval: 1,
    taskId: task.id
  });

  const timeline = service.timeline(start - 1, start + 24 * 60 * 60 * 1000 + 1);
  const first = timeline.find((item) => item.id === firstResult.log.id);
  const second = timeline.find((item) => item.id === secondResult.log.id);
  assert.deepEqual(first.overlapMeta, {
    totalCount: 1,
    confirmedCount: 0,
    candidateCount: 1
  });
  assert.deepEqual(second.overlapMeta, {
    totalCount: 1,
    confirmedCount: 1,
    candidateCount: 0
  });
  assert.equal(Object.hasOwn(timeline.find((item) => item.id === plan.id), 'overlapMeta'), false);
  assert.equal(
    timeline.filter((item) => item.virtual).every((item) => !Object.hasOwn(item, 'overlapMeta')),
    true
  );
  const narrowTimeline = service.timeline(start - 1, start + 10 * 60 * 1000);
  assert.equal(
    Object.hasOwn(narrowTimeline.find((item) => item.id === firstResult.log.id), 'overlapMeta'),
    false
  );
  assert.equal(narrowTimeline.some((item) => item.id === secondResult.log.id), false);

  const stats = service.statistics({ rangeStart: start - 1, rangeEnd: now() + 1 });

  assert.equal(stats.totalMinutes, 40);
  assert.equal(Object.hasOwn(stats, 'overlaps'), false);
});

test('M3：放弃项目删除未来对象但保留已确认历史和快照', () => {
  const { service, now } = createHarness();
  const project = service.createProject({ title: '待放弃项目', deadlineAt: now() + 86_400_000 });
  const completedTask = service.createTask({ title: '历史任务', projectId: project.id });
  service.updateTask(completedTask.id, { status: TASK_STATUS.COMPLETED });
  const activeTask = service.createTask({ title: '未来任务', projectId: project.id });
  const historicalEvent = createCalendarEventForTask(service, { title: '历史计划', startedAt: now() - 3_600_000, endedAt: now() - 1_800_000, taskId: completedTask.id });
  service.createManualLog({
    startedAt: now() - 3_500_000,
    endedAt: now() - 3_000_000,
    calendarEventId: historicalEvent.id,
    note: '历史任务完成证据'
  });
  const futureEvent = createCalendarEventForTask(service, { title: '未来计划', startedAt: now() + 3_600_000, endedAt: now() + 7_200_000, taskId: activeTask.id });
  createCalendarEventForTask(service, { title: '仍未执行的未来计划', startedAt: now() + 8_000_000, endedAt: now() + 9_000_000, taskId: activeTask.id });
  const confirmed = service.createManualLog({
    startedAt: now() - 3_000_000,
    endedAt: now() - 2_700_000,
    calendarEventId: futureEvent.id,
    note: '保留事实'
  }).log;

  service.abandonProject(project.id, true);
  const snapshot = service.snapshot();
  assert.equal(snapshot.projects.length, 0);
  assert.equal(snapshot.tasks.some((task) => task.id === activeTask.id), false);
  assert.equal(snapshot.tasks.some((task) => task.id === completedTask.id), true);
  assert.equal(snapshot.calendarEvents.some((event) => event.id === historicalEvent.id), true);
  const keptLog = snapshot.timeLogs.find((log) => log.id === confirmed.id);
  assert.equal(keptLog.status, LOG_STATUS.CONFIRMED);
  assert.equal(keptLog.projectId, null);
  assert.equal(keptLog.projectNameSnapshot, '待放弃项目');
  assert.equal(keptLog.taskId, null);
});

test('放弃项目沿全部项目任务的计划链删除未来计划、规则和候选，已确认历史继续保留', () => {
  const { service, repository, now } = createHarness();
  const project = service.createProject({
    title: '完整链路项目',
    deadlineAt: now() + 86_400_000
  });
  const completedTask = service.createTask({
    title: '已完成但仍有计划的任务',
    projectId: project.id
  });
  service.updateTask(completedTask.id, { status: TASK_STATUS.COMPLETED });
  const foreignProject = service.createProject({
    title: '其他项目',
    deadlineAt: now() + 86_400_000
  });
  const foreignTask = service.createTask({
    title: '其他项目任务',
    projectId: foreignProject.id
  });
  const historicalEvent = createCalendarEventForTask(service, {
    title: '已结束计划',
    startedAt: now() - 2 * 60 * 60 * 1000,
    endedAt: now() - 60 * 60 * 1000,
    taskId: completedTask.id
  });
  const futureEvent = createCalendarEventForTask(service, {
    title: '已完成任务的未来计划',
    startedAt: now() + 60 * 60 * 1000,
    endedAt: now() + 2 * 60 * 60 * 1000,
    taskId: completedTask.id
  });
  const repeatStart = now() + 3 * 60 * 60 * 1000;
  const { rule } = createRecurringPlanForTask(service, {
    title: '已完成任务的重复计划',
    startedAt: repeatStart,
    endedAt: repeatStart + 30 * 60 * 1000,
    frequency: 'daily',
    interval: 1,
    taskId: completedTask.id
  });
  const virtual = service.timeline(
    repeatStart + 24 * 60 * 60 * 1000,
    repeatStart + 25 * 60 * 60 * 1000
  ).find((item) => item.virtual);
  const confirmedHistory = service.createManualLog({
    startedAt: now() - 2 * 60 * 60 * 1000,
    endedAt: now() - 90 * 60 * 1000,
    calendarEventId: historicalEvent.id
  }).log;
  const candidateHistory = service.createManualLog({
    startedAt: now() - 80 * 60 * 1000,
    endedAt: now() - 70 * 60 * 1000,
    calendarEventId: historicalEvent.id
  }).log;
  const candidateRule = service.createManualLog({
    startedAt: now() - 60 * 60 * 1000,
    endedAt: now() - 50 * 60 * 1000,
    originRuleId: rule.id,
    originOccurrenceId: virtual.originOccurrenceId
  }).log;
  const confirmedRule = service.createManualLog({
    startedAt: now() - 40 * 60 * 1000,
    endedAt: now() - 30 * 60 * 1000,
    originRuleId: rule.id,
    originOccurrenceId: virtual.originOccurrenceId
  }).log;
  const foreignEvent = createCalendarEventForTask(service, {
    title: '不能被旧 projectId 误删的计划',
    startedAt: now() + 4 * 60 * 60 * 1000,
    endedAt: now() + 5 * 60 * 60 * 1000,
    taskId: foreignTask.id
  });
  const foreignCandidate = service.createManualLog({
    startedAt: now() - 20 * 60 * 1000,
    endedAt: now() - 10 * 60 * 1000,
    calendarEventId: foreignEvent.id
  }).log;
  const directOnlyCandidate = service.createManualLog({
    startedAt: now() - 10 * 60 * 1000,
    endedAt: now() - 5 * 60 * 1000
  }).log;
  repository.transaction((database) => {
    database.timeLogs.find((log) => log.id === candidateHistory.id).status = LOG_STATUS.CANDIDATE;
    database.timeLogs.find((log) => log.id === candidateRule.id).status = LOG_STATUS.CANDIDATE;
    database.timeLogs.find((log) => log.id === foreignCandidate.id).status = LOG_STATUS.CANDIDATE;
    const directOnly = database.timeLogs.find((log) => log.id === directOnlyCandidate.id);
    directOnly.status = LOG_STATUS.CANDIDATE;
    directOnly.projectId = project.id;
    directOnly.taskId = completedTask.id;
    database.calendarEvents.find((event) => event.id === foreignEvent.id).projectId = project.id;
  });
  // 本用例只验证放弃项目对“进入事务时已完成任务”的旧有清理边界。
  service.updateTask(completedTask.id, { status: TASK_STATUS.COMPLETED });

  service.abandonProject(project.id, true);
  const snapshot = service.snapshot();
  const keptTask = snapshot.tasks.find((task) => task.id === completedTask.id);
  const keptEvent = snapshot.calendarEvents.find((event) => event.id === historicalEvent.id);
  const keptHistory = snapshot.timeLogs.find((log) => log.id === confirmedHistory.id);
  const keptRuleLog = snapshot.timeLogs.find((log) => log.id === confirmedRule.id);

  assert.deepEqual([keptTask.projectId, keptTask.projectNameSnapshot], [null, project.title]);
  assert.deepEqual([keptEvent.taskId, keptEvent.projectId], [completedTask.id, null]);
  assert.equal(snapshot.calendarEvents.some((event) => event.id === futureEvent.id), false);
  assert.equal(snapshot.repeatRules.some((item) => item.id === rule.id), false);
  assert.equal(snapshot.timeLogs.some((log) => log.id === candidateHistory.id), false);
  assert.equal(snapshot.timeLogs.some((log) => log.id === candidateRule.id), false);
  assert.equal(snapshot.calendarEvents.some((event) => event.id === foreignEvent.id), true);
  assert.equal(
    snapshot.calendarEvents.find((event) => event.id === foreignEvent.id).projectId,
    null
  );
  assert.equal(snapshot.timeLogs.some((log) => log.id === foreignCandidate.id), true);
  assert.equal(snapshot.timeLogs.some((log) => log.id === directOnlyCandidate.id), true);
  assert.equal(
    snapshot.timeLogs.find((log) => log.id === directOnlyCandidate.id).projectId,
    null
  );
  assert.equal(keptHistory.calendarEventId, historicalEvent.id);
  assert.deepEqual(
    [keptRuleLog.originRuleId, keptRuleLog.originOccurrenceId, keptRuleLog.originRuleSummarySnapshot],
    [null, virtual.originOccurrenceId, rule.title]
  );
});

test('M3：放弃项目断开计时草稿失效引用且保留仍有效的项目关联', () => {
  const { service, repository, now } = createHarness();
  const abandonedProject = service.createProject({
    title: '待放弃项目',
    deadlineAt: now() + 86_400_000
  });
  const retainedProject = service.createProject({
    title: '保留项目',
    deadlineAt: now() + 86_400_000
  });
  const deletingTask = service.createTask({
    title: '待删除任务',
    projectId: abandonedProject.id
  });
  const futureEvent = createCalendarEventForTask(service, {
    title: '待删除计划',
    startedAt: now() + 60 * 60 * 1000,
    endedAt: now() + 2 * 60 * 60 * 1000,
    taskId: deletingTask.id
  });
  const { rule } = createRecurringPlanForTask(service, {
    title: '待删除规则',
    startedAt: now() + 3 * 60 * 60 * 1000,
    endedAt: now() + 4 * 60 * 60 * 1000,
    frequency: 'daily',
    interval: 1,
    taskId: deletingTask.id
  });
  service.startTimer({
    calendarEventId: futureEvent.id
  });
  repository.transaction((database) => {
    database.timer.draft.originRuleSummarySnapshot = rule.title;
    database.recoveryDraft = {
      reason: '待修正',
      timer: {
        ...createIdleTimer(),
        draft: {
          projectId: retainedProject.id,
          projectNameSnapshot: retainedProject.title,
          taskId: deletingTask.id,
          calendarEventId: null,
          calendarEventSummarySnapshot: futureEvent.title,
          originRuleId: rule.id,
          originOccurrenceId: `${rule.id}:1:${rule.revisions[0].effectiveFrom}`,
          originRuleSummarySnapshot: rule.title
        }
      },
      createdAt: now()
    };
  });

  service.abandonProject(abandonedProject.id, true);
  const snapshot = service.snapshot();
  const timerDraft = snapshot.timer.draft;
  const recoveryDraft = snapshot.recoveryDraft.timer.draft;

  assert.deepEqual(
    [timerDraft.projectId, timerDraft.projectNameSnapshot, timerDraft.taskId, timerDraft.taskNameSnapshot],
    [null, abandonedProject.title, null, deletingTask.title]
  );
  assert.deepEqual(
    [
      timerDraft.calendarEventId,
      timerDraft.calendarEventSummarySnapshot,
      timerDraft.originRuleId,
      timerDraft.originOccurrenceId,
      timerDraft.originRuleSummarySnapshot
    ],
    [null, futureEvent.title, null, null, rule.title]
  );
  assert.deepEqual(
    [recoveryDraft.projectId, recoveryDraft.projectNameSnapshot, recoveryDraft.taskId, recoveryDraft.taskNameSnapshot],
    [retainedProject.id, retainedProject.title, null, deletingTask.title]
  );
  assert.deepEqual(
    [
      recoveryDraft.calendarEventId,
      recoveryDraft.calendarEventSummarySnapshot,
      recoveryDraft.originRuleId,
      recoveryDraft.originOccurrenceId
    ],
    [null, futureEvent.title, null, null]
  );
});

test('M3：删除任务清除未结束计划并保留历史计划和计时记录', () => {
  const { service, repository, setNow, now } = createHarness();
  const project = service.createProject({ title: '关联项目', deadlineAt: now() + 86_400_000 });
  const task = service.createTask({ title: '待删除任务', projectId: project.id });
  const historicalEvent = createCalendarEventForTask(service, { title: '历史任务计划', startedAt: now() - 3_600_000, endedAt: now() - 1_800_000, taskId: task.id });
  const start = now() + 3_600_000;
  const futureEvent = createCalendarEventForTask(service, { title: '未来任务计划', startedAt: start, endedAt: start + 1_800_000, taskId: task.id });
  const { rule } = createRecurringPlanForTask(service, {
    title: '任务重复计划',
    startedAt: start,
    endedAt: start + 1_800_000,
    frequency: 'daily',
    interval: 1,
    taskId: task.id
  });
  const virtual = service.timeline(
    start + 24 * 60 * 60 * 1000,
    start + 25 * 60 * 60 * 1000
  ).find((item) => item.virtual);
  const deletionNow = now();
  setNow(virtual.startedAt);
  const ruleLog = service.confirmVirtualOccurrence(virtual);
  setNow(deletionNow);
  service.skipOccurrence(rule.id, start);
  const { log } = service.createManualLog({
    startedAt: now() - 3_600_000,
    endedAt: now() - 1_800_000,
    calendarEventId: futureEvent.id,
    note: '任务实际记录'
  });
  service.startTimer({ calendarEventId: historicalEvent.id });
  repository.transaction((database) => {
    database.recoveryDraft = {
      reason: '恢复任务',
      timer: {
        ...createIdleTimer(),
        draft: {
          projectId: project.id,
          projectNameSnapshot: project.title,
          taskId: task.id,
          taskNameSnapshot: task.title,
          calendarEventId: historicalEvent.id,
          calendarEventSummarySnapshot: historicalEvent.title,
          originRuleId: null,
          originOccurrenceId: null
        }
      },
      createdAt: now()
    };
  });

  assert.equal(task.status, TASK_STATUS.TODO);
  assert.throws(() => service.updateTask(task.id, { status: 'inbox' }), (error) => error.code === 'TASK_STATUS_INVALID');
  assert.throws(() => service.deleteTask(task.id, false), (error) => error.code === 'TASK_DELETE_CONFIRMATION_REQUIRED');

  assert.deepEqual(service.deleteTask(task.id, true), { id: task.id, title: task.title });
  const snapshot = service.snapshot();
  const keptEvent = snapshot.calendarEvents.find((item) => item.id === historicalEvent.id);
  const keptLog = snapshot.timeLogs.find((item) => item.id === log.id);
  const keptRuleLog = snapshot.timeLogs.find((item) => item.id === ruleLog.id);

  assert.equal(snapshot.tasks.some((item) => item.id === task.id), false);
  assert.deepEqual([keptEvent.taskId, keptEvent.taskNameSnapshot, keptEvent.projectId], [null, task.title, null]);
  assert.equal(snapshot.calendarEvents.some((item) => item.id === futureEvent.id), false);
  assert.equal(snapshot.repeatRules.some((item) => item.id === rule.id), false);
  assert.equal(snapshot.occurrenceExceptions.length, 0);
  assert.deepEqual([keptLog.taskId, keptLog.taskNameSnapshot], [null, task.title]);
  assert.deepEqual([keptLog.calendarEventId, keptLog.calendarEventSummarySnapshot], [null, futureEvent.title]);
  assert.deepEqual([snapshot.timer.draft.taskId, snapshot.timer.draft.taskNameSnapshot], [null, task.title]);
  assert.deepEqual(
    [snapshot.timer.draft.calendarEventId, snapshot.timer.draft.calendarEventSummarySnapshot],
    [null, historicalEvent.title]
  );
  assert.deepEqual([snapshot.recoveryDraft.timer.draft.taskId, snapshot.recoveryDraft.timer.draft.taskNameSnapshot], [null, task.title]);
  assert.deepEqual(
    [
      snapshot.recoveryDraft.timer.draft.calendarEventId,
      snapshot.recoveryDraft.timer.draft.calendarEventSummarySnapshot,
      snapshot.recoveryDraft.timer.draft.originRuleId,
      snapshot.recoveryDraft.timer.draft.originOccurrenceId
    ],
    [null, historicalEvent.title, null, null]
  );
  assert.deepEqual(
    [keptRuleLog.originRuleId, keptRuleLog.originOccurrenceId],
    [null, virtual.originOccurrenceId]
  );
  const editedRuleTrace = service.updateLog(ruleLog.id, {
    calendarEventId: null,
    note: '编辑备注时保留已删除规则的实例追溯'
  }).log;
  assert.deepEqual(
    [
      editedRuleTrace.originRuleId,
      editedRuleTrace.originOccurrenceId,
      editedRuleTrace.note
    ],
    [null, virtual.originOccurrenceId, '编辑备注时保留已删除规则的实例追溯']
  );
  const replacementTask = service.createTask({ title: '替代任务' });
  assert.throws(
    () => service.updateCalendarEvent(historicalEvent.id, {
      title: '试图复活历史计划',
      taskId: replacementTask.id
    }),
    (error) => error.code === 'CALENDAR_EVENT_READ_ONLY'
  );
  const stillReadOnly = service.snapshot().calendarEvents.find((item) => item.id === historicalEvent.id);
  assert.deepEqual(
    [stillReadOnly.title, stillReadOnly.taskId],
    [historicalEvent.title, null]
  );
  assert.equal(
    service.planAssociationCandidates(historicalEvent.startedAt, historicalEvent.endedAt)
      .some((item) => item.id === historicalEvent.id),
    false
  );
});

test('新关系链：计划创建和更新只能关联有效任务', () => {
  const { service, repository, now } = createHarness();
  const firstProject = service.createProject({
    title: '甲项目',
    deadlineAt: now() + 86_400_000
  });
  const secondProject = service.createProject({
    title: '乙项目',
    deadlineAt: now() + 86_400_000
  });
  const firstTask = service.createTask({ title: '甲任务', projectId: firstProject.id });
  const secondTask = service.createTask({ title: '乙任务', projectId: secondProject.id });
  const start = now() + 60 * 60 * 1000;
  const planInput = {
    title: '任务计划',
    startedAt: start,
    endedAt: start + 30 * 60 * 1000
  };

  assert.throws(
    () => service.createCalendarEvent(planInput),
    (error) => error.code === 'PLAN_TASK_REQUIRED'
  );
  assert.throws(
    () => service.createCalendarEvent({
      ...planInput,
      taskId: firstTask.id,
      projectId: firstProject.id
    }),
    (error) => error.code === 'PLAN_PROJECT_DIRECT_FORBIDDEN'
  );

  const event = service.createCalendarEvent({ ...planInput, taskId: firstTask.id });
  assert.deepEqual(
    [event.taskId, event.taskNameSnapshot, event.projectId, event.projectNameSnapshot],
    [firstTask.id, firstTask.title, null, firstProject.title]
  );
  const updatedEvent = service.updateCalendarEvent(event.id, { taskId: secondTask.id });
  assert.deepEqual(
    [updatedEvent.taskId, updatedEvent.projectId, updatedEvent.projectNameSnapshot],
    [secondTask.id, null, secondProject.title]
  );
  assert.throws(
    () => service.updateCalendarEvent(event.id, { projectId: firstProject.id }),
    (error) => error.code === 'PLAN_PROJECT_DIRECT_FORBIDDEN'
  );
  const repairableFutureEvent = service.createCalendarEvent({
    ...planInput,
    title: '导入后待修复的未来计划',
    taskId: firstTask.id
  });
  repository.transaction((database) => {
    database.calendarEvents.find((item) => item.id === repairableFutureEvent.id).taskId = null;
  });
  const repairedFutureEvent = service.updateCalendarEvent(
    repairableFutureEvent.id,
    { taskId: secondTask.id }
  );
  assert.equal(repairedFutureEvent.taskId, secondTask.id);

  assert.throws(
    () => service.createRecurringPlan({
      ...planInput,
      frequency: 'daily',
      interval: 1
    }),
    (error) => error.code === 'PLAN_TASK_REQUIRED'
  );
  const { rule } = service.createRecurringPlan({
    ...planInput,
    title: '每日任务',
    frequency: 'daily',
    interval: 1,
    taskId: firstTask.id
  });

  repository.transaction((database) => {
    database.repeatRules
      .find((item) => item.id === rule.id)
      .revisions
      .forEach((item) => {
        item.taskId = null;
      });
  });
  const legacyRangeStart = start + 48 * 60 * 60 * 1000;
  assert.equal(
    service.timeline(legacyRangeStart, legacyRangeStart + 30 * 60 * 1000)
      .some((item) => item.virtual && item.ruleId === rule.id),
    false
  );
  const exceptionCount = service.snapshot().occurrenceExceptions.length;
  assert.throws(
    () => service.skipOccurrence(rule.id, legacyRangeStart),
    (error) => error.code === 'OCCURRENCE_TASK_UNAVAILABLE'
  );
  assert.equal(service.snapshot().occurrenceExceptions.length, exceptionCount);
});

test('TODO 计划计时：实体计划全部形成 confirmed 记录后自动完成，撤销会删除推断证据', () => {
  const { service, setNow, now } = createHarness();
  const task = service.createTask({ title: '实体计划任务' });
  const first = service.createCalendarEvent({
    title: '已经结束的计划',
    taskId: task.id,
    startedAt: now() - 2 * 60 * 60 * 1000,
    endedAt: now() - 60 * 60 * 1000,
    priority: 1
  });
  const second = service.createCalendarEvent({
    title: '未来计划',
    taskId: task.id,
    startedAt: now() + 60 * 60 * 1000,
    endedAt: now() + 2 * 60 * 60 * 1000,
    priority: 1
  });

  service.startTaskPlanTimer(task.id, `event:${first.id}`);
  setNow(now() + 10 * 60 * 1000);
  const firstLog = service.finishTimer().log;
  assert.equal(service.snapshot().tasks.find((item) => item.id === task.id).status, TASK_STATUS.TODO);

  service.startTaskPlanTimer(task.id, `event:${second.id}`);
  setNow(now() + 10 * 60 * 1000);
  const triggerLog = service.finishTimer().log;
  assert.equal(service.snapshot().tasks.find((item) => item.id === task.id).status, TASK_STATUS.COMPLETED);
  assert.equal(service.taskCompletionUndoPreview(task.id).id, triggerLog.id);
  assert.throws(
    () => service.reopenTaskByRemovingCompletionLog(task.id, triggerLog.id, false),
    (error) => error.code === 'TASK_REOPEN_CONFIRMATION_REQUIRED'
  );

  const reopened = service.reopenTaskByRemovingCompletionLog(task.id, triggerLog.id, true);
  assert.equal(reopened.deletedLogId, triggerLog.id);
  const snapshot = service.snapshot();
  assert.equal(snapshot.timeLogs.some((item) => item.id === firstLog.id), true);
  assert.equal(snapshot.timeLogs.some((item) => item.id === triggerLog.id), false);
  assert.equal(snapshot.tasks.find((item) => item.id === task.id).status, TASK_STATUS.TODO);
});

test('TODO 计划计时：固定日程今天记录后保持未完成并进入已记录显示态', () => {
  const start = new Date(2026, 7, 12, 12, 0, 0, 0).getTime();
  const { service, setNow } = createHarness(start);
  const task = service.createTask({ title: '固定日程任务' });
  const { rule } = service.createRecurringPlan({
    title: '每天练习',
    taskId: task.id,
    startedAt: new Date(2026, 7, 10, 9, 0, 0, 0).getTime(),
    endedAt: new Date(2026, 7, 10, 10, 0, 0, 0).getTime(),
    priority: 1,
    frequency: 'daily',
    interval: 1
  });
  const before = service.taskPlanStates(start).get(task.id);
  assert.equal(before.candidates.length, 1);

  service.startTaskPlanTimer(task.id, before.candidates[0].id);
  setNow(start + 10 * 60 * 1000);
  const log = service.finishTimer().log;
  const after = service.taskPlanStates(start + 10 * 60 * 1000).get(task.id);

  assert.equal(log.originRuleId, rule.id);
  assert.equal(service.snapshot().tasks.find((item) => item.id === task.id).status, TASK_STATUS.TODO);
  assert.equal(after.recordedToday, true);
  assert.equal(after.controlKind, 'recorded');
  assert.equal(after.topVisible, true);
});

test('TODO 自动完成：有限固定日程随时间失效后在计划页刷新时收敛状态', () => {
  const start = new Date(2026, 7, 12, 8, 0, 0, 0).getTime();
  const { service, setNow } = createHarness(start);
  const task = service.createTask({ title: '等待固定日程结束' });
  const event = service.createCalendarEvent({
    title: '实体计划',
    taskId: task.id,
    startedAt: start - 2 * 60 * 60 * 1000,
    endedAt: start - 60 * 60 * 1000,
    priority: 1
  });
  service.createManualLog({
    startedAt: start - 30 * 60 * 1000,
    endedAt: start - 20 * 60 * 1000,
    calendarEventId: event.id
  });
  const repeatStart = new Date(2026, 7, 12, 9, 0, 0, 0).getTime();
  const { rule } = service.createRecurringPlan({
    title: '短期固定日程',
    taskId: task.id,
    startedAt: repeatStart,
    endedAt: repeatStart + 30 * 60 * 1000,
    priority: 1,
    frequency: 'daily',
    interval: 1
  });
  const tomorrow = repeatStart + 24 * 60 * 60 * 1000;
  service.deleteRuleFollowing(rule.id, tomorrow, true);
  assert.equal(service.snapshot().tasks.find((item) => item.id === task.id).status, TASK_STATUS.TODO);

  const afterRule = tomorrow + 24 * 60 * 60 * 1000;
  setNow(afterRule);
  assert.deepEqual(service.refreshTaskPlanStatuses(), [task.id]);
  assert.equal(service.snapshot().tasks.find((item) => item.id === task.id).status, TASK_STATUS.COMPLETED);
  assert.deepEqual(service.refreshTaskPlanStatuses(), []);
});

test('新关系链：日志和计时只写计划关联，direct task/project 始终为空', () => {
  const { service, repository, setNow, now } = createHarness();
  const project = service.createProject({
    title: '专注项目',
    deadlineAt: now() + 86_400_000
  });
  const task = service.createTask({ title: '专注任务', projectId: project.id });
  const event = createCalendarEventForTask(service, {
    title: '专注计划',
    startedAt: now() + 60 * 60 * 1000,
    endedAt: now() + 2 * 60 * 60 * 1000,
    taskId: task.id
  });

  assert.throws(
    () => service.createManualLog({
      startedAt: now() - 60 * 60 * 1000,
      endedAt: now() - 30 * 60 * 1000,
      taskId: task.id
    }),
    (error) => error.code === 'LOG_DIRECT_ASSOCIATION_FORBIDDEN'
  );
  const manual = service.createManualLog({
    startedAt: now() - 60 * 60 * 1000,
    endedAt: now() - 30 * 60 * 1000,
    calendarEventId: event.id
  }).log;
  assert.deepEqual(
    [
      manual.calendarEventId,
      manual.taskId,
      manual.taskNameSnapshot,
      manual.projectId,
      manual.projectNameSnapshot
    ],
    [event.id, null, task.title, null, project.title]
  );
  repository.transaction((database) => {
    const stored = database.timeLogs.find((item) => item.id === manual.id);
    stored.taskId = task.id;
    stored.projectId = project.id;
    stored.taskNameSnapshot = '旧重复任务';
    stored.projectNameSnapshot = '旧重复项目';
  });
  const normalizedLegacyLog = service.updateLog(manual.id, { note: '兼容旧字段' }).log;
  assert.deepEqual(
    [
      normalizedLegacyLog.calendarEventId,
      normalizedLegacyLog.taskId,
      normalizedLegacyLog.taskNameSnapshot,
      normalizedLegacyLog.projectId,
      normalizedLegacyLog.projectNameSnapshot,
      normalizedLegacyLog.originRuleId,
      normalizedLegacyLog.originOccurrenceId
    ],
    [event.id, null, task.title, null, project.title, null, null]
  );

  assert.throws(
    () => service.startTimer({ projectId: project.id }),
    (error) => error.code === 'LOG_DIRECT_ASSOCIATION_FORBIDDEN'
  );
  service.startTimer({ calendarEventId: event.id });
  assert.deepEqual(
    [service.snapshot().timer.draft.taskId, service.snapshot().timer.draft.projectId],
    [null, null]
  );
  assert.throws(
    () => service.updateTimerDraft({ taskId: task.id }),
    (error) => error.code === 'LOG_DIRECT_ASSOCIATION_FORBIDDEN'
  );
  repository.transaction((database) => {
    database.timer.draft.taskId = task.id;
    database.timer.draft.projectId = project.id;
  });
  setNow(now() + 60_000);
  const generated = service.finishTimer().log;
  assert.deepEqual(
    [generated.calendarEventId, generated.taskId, generated.projectId],
    [event.id, null, null]
  );
});

test('重复计划实例可作为日志和计时的统一计划关联，并校验成对与互斥', () => {
  const { service, setNow, now } = createHarness();
  const task = service.createTask({ title: '循环任务' });
  const start = now() + 60 * 60 * 1000;
  const { rule } = service.createRecurringPlan({
    title: '每日循环',
    startedAt: start,
    endedAt: start + 30 * 60 * 1000,
    frequency: 'daily',
    interval: 1,
    taskId: task.id
  });
  const event = createCalendarEventForTask(service, {
    title: '具体计划',
    startedAt: start,
    endedAt: start + 30 * 60 * 1000,
    taskId: task.id
  });
  const virtual = service.timeline(
    start + 24 * 60 * 60 * 1000,
    start + 25 * 60 * 60 * 1000
  ).find((item) => item.virtual);

  assert.throws(
    () => service.startTimer({ originRuleId: rule.id }),
    (error) => error.code === 'OCCURRENCE_REFERENCE_PAIR_REQUIRED'
  );
  assert.throws(
    () => service.startTimer({
      calendarEventId: event.id,
      originRuleId: rule.id,
      originOccurrenceId: virtual.originOccurrenceId
    }),
    (error) => error.code === 'PLAN_ASSOCIATION_CONFLICT'
  );

  service.startTimer({
    originRuleId: rule.id,
    originOccurrenceId: virtual.originOccurrenceId
  });
  let draft = service.snapshot().timer.draft;
  assert.deepEqual(
    [draft.calendarEventId, draft.originRuleId, draft.originOccurrenceId, draft.taskId],
    [null, rule.id, virtual.originOccurrenceId, null]
  );
  service.updateTimerDraft({ calendarEventId: event.id });
  draft = service.snapshot().timer.draft;
  assert.deepEqual(
    [draft.calendarEventId, draft.originRuleId, draft.originOccurrenceId],
    [event.id, null, null]
  );
  service.updateTimerDraft({
    originRuleId: rule.id,
    originOccurrenceId: virtual.originOccurrenceId
  });
  setNow(now() + 60_000);
  const timerLog = service.finishTimer().log;
  assert.deepEqual(
    [
      timerLog.calendarEventId,
      timerLog.originRuleId,
      timerLog.originOccurrenceId,
      timerLog.taskId,
      timerLog.projectId
    ],
    [null, rule.id, virtual.originOccurrenceId, null, null]
  );

  const recoveryStart = now();
  service.startTimer({
    originRuleId: rule.id,
    originOccurrenceId: virtual.originOccurrenceId
  });
  setNow(recoveryStart - 1);
  assert.equal(service.recoverTimer().state, 'draft');
  setNow(recoveryStart + 60_000);
  assert.throws(
    () => service.createRecoveryConfirmedLog({
      startedAt: recoveryStart,
      endedAt: recoveryStart + 60_000,
      taskId: task.id
    }),
    (error) => error.code === 'LOG_DIRECT_ASSOCIATION_FORBIDDEN'
  );
  const recovered = service.createRecoveryConfirmedLog({
    startedAt: recoveryStart,
    endedAt: recoveryStart + 60_000
  });
  assert.deepEqual(
    [recovered.originRuleId, recovered.originOccurrenceId, recovered.taskId, recovered.projectId],
    [rule.id, virtual.originOccurrenceId, null, null]
  );
});

test('计划关联候选只返回有效计划，并且不因已有日志隐藏重复实例', () => {
  const { service, setNow, now } = createHarness();
  const task = service.createTask({ title: '多记录任务' });
  const start = now() + 60 * 60 * 1000;
  const { rule } = service.createRecurringPlan({
    title: '每日复盘',
    startedAt: start,
    endedAt: start + 30 * 60 * 1000,
    frequency: 'daily',
    interval: 1,
    taskId: task.id
  });
  const event = createCalendarEventForTask(service, {
    title: '具体复盘',
    startedAt: start,
    endedAt: start + 30 * 60 * 1000,
    taskId: task.id
  });
  const nextStart = start + 24 * 60 * 60 * 1000;
  const nextOccurrence = service.timeline(
    nextStart,
    nextStart + 30 * 60 * 1000
  ).find((item) => item.virtual);

  setNow(nextOccurrence.startedAt);
  service.confirmVirtualOccurrence(nextOccurrence);
  service.createManualLog({
    startedAt: nextStart + 5 * 60 * 1000,
    endedAt: nextStart + 15 * 60 * 1000,
    originRuleId: rule.id,
    originOccurrenceId: nextOccurrence.originOccurrenceId
  });
  service.createManualLog({
    startedAt: start,
    endedAt: start + 10 * 60 * 1000,
    calendarEventId: event.id
  });

  const candidates = service.planAssociationCandidates(
    start,
    nextStart + 30 * 60 * 1000
  );

  assert.equal(
    candidates.filter((item) => !item.virtual && item.id === event.id).length,
    1
  );
  assert.equal(
    candidates.some((item) => item.virtual && item.occurrenceStart === start),
    true
  );
  assert.equal(
    candidates.some((item) => (
      item.virtual
      && item.ruleId === rule.id
      && item.originOccurrenceId === nextOccurrence.originOccurrenceId
    )),
    true
  );
  assert.equal(
    service.timeline(nextStart, nextStart + 30 * 60 * 1000)
      .some((item) => item.virtual && item.ruleId === rule.id),
    false
  );
});

test('确认候选记录执行统一关联归一化，并保证具体计划与重复实例互斥成对', () => {
  const { service, repository, setNow, now } = createHarness();
  const project = service.createProject({
    title: '候选所属项目',
    deadlineAt: now() + 86_400_000
  });
  const task = service.createTask({ title: '候选任务', projectId: project.id });
  const event = service.createCalendarEvent({
    title: '候选计划',
    startedAt: now() - 60 * 60 * 1000,
    endedAt: now() - 30 * 60 * 1000,
    taskId: task.id
  });
  const concrete = service.createManualLog({
    startedAt: now() - 60 * 60 * 1000,
    endedAt: now() - 50 * 60 * 1000,
    calendarEventId: event.id
  }).log;
  const detached = service.createManualLog({
    startedAt: now() - 40 * 60 * 1000,
    endedAt: now() - 30 * 60 * 1000
  }).log;
  const repeatStart = now() + 60 * 60 * 1000;
  const { rule } = service.createRecurringPlan({
    title: '候选重复计划',
    startedAt: repeatStart,
    endedAt: repeatStart + 30 * 60 * 1000,
    frequency: 'daily',
    interval: 1,
    taskId: task.id
  });
  const virtual = service.timeline(
    repeatStart + 24 * 60 * 60 * 1000,
    repeatStart + 25 * 60 * 60 * 1000
  ).find((item) => item.virtual);
  setNow(virtual.startedAt);
  const recurring = service.confirmVirtualOccurrence(virtual);

  repository.transaction((database) => {
    const concreteCandidate = database.timeLogs.find((item) => item.id === concrete.id);
    Object.assign(concreteCandidate, {
      status: LOG_STATUS.CANDIDATE,
      projectId: project.id,
      taskId: task.id
    });
    const detachedCandidate = database.timeLogs.find((item) => item.id === detached.id);
    Object.assign(detachedCandidate, {
      status: LOG_STATUS.CANDIDATE,
      projectId: project.id,
      taskId: task.id,
      originOccurrenceId: '已删除规则的历史实例'
    });
    const recurringCandidate = database.timeLogs.find((item) => item.id === recurring.id);
    Object.assign(recurringCandidate, {
      status: LOG_STATUS.CANDIDATE,
      projectId: project.id,
      taskId: task.id
    });
  });

  const confirmedConcrete = service.confirmCandidateLog(concrete.id);
  const confirmedDetached = service.confirmCandidateLog(detached.id);
  const confirmedRecurring = service.confirmCandidateLog(recurring.id);

  assert.deepEqual(
    [
      confirmedConcrete.projectId,
      confirmedConcrete.taskId,
      confirmedConcrete.calendarEventId,
      confirmedConcrete.originRuleId,
      confirmedConcrete.originOccurrenceId
    ],
    [null, null, event.id, null, null]
  );
  assert.deepEqual(
    [
      confirmedDetached.projectId,
      confirmedDetached.taskId,
      confirmedDetached.calendarEventId,
      confirmedDetached.originRuleId,
      confirmedDetached.originOccurrenceId,
      confirmedDetached.source
    ],
    [null, null, null, null, '已删除规则的历史实例', LOG_SOURCE.MANUAL]
  );
  assert.deepEqual(
    [
      confirmedRecurring.projectId,
      confirmedRecurring.taskId,
      confirmedRecurring.calendarEventId,
      confirmedRecurring.originRuleId,
      confirmedRecurring.originOccurrenceId
    ],
    [null, null, null, rule.id, virtual.originOccurrenceId]
  );
});

test('编辑日志保留导入的超限标签和历史计划；改标签时执行限制，显式空值解除计划关联', () => {
  const { service, repository, setNow, now } = createHarness();
  const task = service.createTask({ title: '历史任务' });
  const historicalEvent = createCalendarEventForTask(service, {
    title: '历史计划',
    startedAt: now() - 2 * 60 * 60 * 1000,
    endedAt: now() - 60 * 60 * 1000,
    taskId: task.id
  });
  const log = service.createManualLog({
    startedAt: now() - 2 * 60 * 60 * 1000,
    endedAt: now() - 90 * 60 * 1000,
    tags: ['历史'],
    calendarEventId: historicalEvent.id
  }).log;
  const importedTags = Array.from({ length: 11 }, (_, index) => `标签${index}`);
  repository.transaction((database) => {
    database.timeLogs.find((item) => item.id === log.id).tags = importedTags;
  });

  const noteOnly = service.updateLog(log.id, {
    note: '只改备注',
    tags: importedTags.slice()
  }).log;
  assert.deepEqual(noteOnly.tags, importedTags);
  assert.equal(noteOnly.calendarEventId, historicalEvent.id);
  assert.throws(
    () => service.updateLog(log.id, { tags: importedTags.concat('新增') }),
    (error) => error.code === 'TAG_COUNT_EXCEEDED'
  );
  assert.throws(
    () => service.updateLog(log.id, { tags: ['一二三四五六'] }),
    (error) => error.code === 'TAG_TOO_LONG'
  );
  assert.deepEqual(service.updateLog(log.id, { tags: [' ＡＩ ', 'AI'] }).log.tags, ['AI']);

  service.deleteTask(task.id, true);
  const preserved = service.updateLog(log.id, {
    calendarEventId: historicalEvent.id,
    note: '保留已失效任务的历史计划'
  }).log;
  assert.equal(preserved.calendarEventId, historicalEvent.id);
  const unplanned = service.createManualLog({
    startedAt: now() - 50 * 60 * 1000,
    endedAt: now() - 40 * 60 * 1000
  }).log;
  assert.throws(
    () => service.updateLog(unplanned.id, { calendarEventId: historicalEvent.id }),
    (error) => error.code === 'CALENDAR_EVENT_TASK_UNAVAILABLE'
  );

  const recurringTask = service.createTask({ title: '重复任务' });
  const repeatStart = now() + 60 * 60 * 1000;
  const { rule } = service.createRecurringPlan({
    title: '重复计划',
    startedAt: repeatStart,
    endedAt: repeatStart + 30 * 60 * 1000,
    frequency: 'daily',
    interval: 1,
    taskId: recurringTask.id
  });
  const virtual = service.timeline(
    repeatStart + 24 * 60 * 60 * 1000,
    repeatStart + 25 * 60 * 60 * 1000
  ).find((item) => item.virtual);
  setNow(virtual.startedAt);
  const originLog = service.confirmVirtualOccurrence(virtual);
  const unchangedOrigin = service.updateLog(originLog.id, { note: '仍关联重复实例' }).log;
  assert.deepEqual(
    [unchangedOrigin.originRuleId, unchangedOrigin.originOccurrenceId],
    [rule.id, virtual.originOccurrenceId]
  );
  const detached = service.updateLog(originLog.id, { calendarEventId: null }).log;
  assert.deepEqual(
    [detached.calendarEventId, detached.originRuleId, detached.originOccurrenceId],
    [null, null, null]
  );
});

test('M5：JSON 导出保留日志状态、来源与关系且不再暴露 CSV API', () => {
  const { service, now } = createHarness();
  const log = service.createManualLog({ startedAt: now() - 3_600_000, endedAt: now() - 1_800_000, note: '含,逗号' }).log;
  const json = service.exportJson();

  assert.equal(JSON.parse(json).schemaVersion, 1);
  assert.match(json, new RegExp(log.id));
  assert.equal(typeof service.exportLogsCsv, 'undefined');
});

test('M5：JSON 导出移除本地残留的未知字段，并可被当前导入器读取', () => {
  const { service, repository, now } = createHarness();
  const project = service.createProject({
    title: '历史项目',
    deadlineAt: now() + 86_400_000
  });
  repository.transaction((database) => {
    database.legacyRootField = 'ignored';
    database.projects
      .find((item) => item.id === project.id)
      .legacyProjectField = 'ignored';
  });

  const json = service.exportJson();
  const exported = JSON.parse(json);

  assert.equal(Object.prototype.hasOwnProperty.call(exported, 'legacyRootField'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(exported.projects[0], 'legacyProjectField'), false);
  assert.doesNotThrow(() => service.prepareJsonImport(json));
});

test('M5：导入会忽略旧版和未知字段，不写入资料库或制造冲突', () => {
  const { service, now } = createHarness();
  const project = service.createProject({
    title: '当前项目',
    deadlineAt: now() + 86_400_000
  });
  const imported = service.snapshot();
  const importedProject = imported.projects.find((item) => item.id === project.id);
  imported.legacyRootField = 'ignored';
  importedProject.legacyProjectField = 'ignored';

  const prepared = service.prepareJsonImport(JSON.stringify(imported));
  const preview = service.previewJsonImport(prepared.token, { mode: IMPORT_MODE.INCREMENTAL });

  assert.equal(preview.conflictCount, 0);
  service.commitJsonImport(prepared.token);
  const storedProject = service.snapshot().projects.find((item) => item.id === project.id);
  assert.equal(Object.prototype.hasOwnProperty.call(storedProject, 'legacyProjectField'), false);
});

test('CalendarEvent 旧重复规则种子字段在增量与覆盖导入后都不会落库', () => {
  [IMPORT_MODE.INCREMENTAL, IMPORT_MODE.REPLACE].forEach((mode) => {
    const { service, now } = createHarness();
    const template = createCalendarEventForTask(service, {
      title: `导入模板 ${mode}`,
      startedAt: now() + 3_600_000,
      endedAt: now() + 7_200_000
    });
    const imported = service.snapshot();
    const importedEventId = `event_legacy_${mode}`;
    imported.calendarEvents.push({
      ...template,
      id: importedEventId,
      repeatRuleId: 'rule_removed',
      repeatRuleSummarySnapshot: '旧固定日程'
    });

    const prepared = service.prepareJsonImport(JSON.stringify(imported));
    service.previewJsonImport(prepared.token, { mode });
    service.commitJsonImport(prepared.token);

    const snapshot = service.snapshot();
    assert.equal(snapshot.schemaVersion, 1);
    assertNoLegacyRepeatSeedFields(
      snapshot.calendarEvents.find((item) => item.id === importedEventId)
    );
  });
});

test('M5：本地遗留的未知字段不影响导回刚导出的 JSON', () => {
  const { service, repository, now } = createHarness();
  const project = service.createProject({
    title: '历史项目',
    deadlineAt: now() + 86_400_000
  });

  const prepared = service.prepareJsonImport(service.exportJson());
  const preview = service.previewJsonImport(prepared.token, { mode: IMPORT_MODE.INCREMENTAL });

  assert.equal(preview.conflictCount, 0);
  service.commitJsonImport(prepared.token);
  assert.equal(service.snapshot().projects.some((item) => item.id === project.id), true);
});

test('导入准备和预览不写入，只有提交 token 才单次写入并保留日志事实字段', () => {
  const { service, storage, now } = createHarness();
  const before = service.snapshot();
  const imported = clone(before);
  imported.wishes.push(importedWish('wish_import', '导入愿望', now()));
  imported.timeLogs.push(importedLog('log_import', now()));
  storage.resetCalls();

  const prepared = service.prepareJsonImport(JSON.stringify(imported));
  assert.equal(prepared.schemaVersion, 1);
  assert.equal(prepared.sourceCounts.wishes, 1);
  assert.equal(prepared.sourceCounts.timeLogs, 1);
  const preview = service.previewJsonImport(prepared.token, { mode: IMPORT_MODE.INCREMENTAL });

  assert.deepEqual(service.snapshot(), before);
  assert.equal(preview.addedCounts.wishes, 1);
  assert.equal(preview.addedCounts.timeLogs, 1);
  assert.equal(preview.requiresConflictPolicy, false);
  assert.deepEqual(storage.setCalls, []);

  const committed = service.commitJsonImport(prepared.token);
  const snapshot = service.snapshot();
  const log = snapshot.timeLogs.find((item) => item.id === 'log_import');
  assert.equal(snapshot.wishes.some((item) => item.id === 'wish_import'), true);
  assert.equal(log.status, LOG_STATUS.CANDIDATE);
  assert.equal(log.source, LOG_SOURCE.FILE);
  assert.equal(log.pausedDurationSeconds, 0);
  assert.equal(committed.addedCounts.timeLogs, 1);
  assert.deepEqual(storage.setCalls, [STORAGE_KEY]);
  assert.throws(
    () => service.commitJsonImport(prepared.token),
    (error) => error.code === 'IMPORT_PREVIEW_NOT_FOUND'
  );
});

test('导入 candidate 可确认、编辑确认或作废且 source 始终不被改写', () => {
  const { service, now } = createHarness();
  const imported = service.snapshot();
  const direct = importedLog('candidate_direct', now());
  const edited = { ...importedLog('candidate_edited', now()), startedAt: now() - 7_200_000, endedAt: now() - 5_400_000 };
  const discarded = { ...importedLog('candidate_discarded', now()), startedAt: now() - 10_800_000, endedAt: now() - 9_000_000 };
  imported.timeLogs.push(direct, edited, discarded);
  const prepared = service.prepareJsonImport(JSON.stringify(imported));
  service.previewJsonImport(prepared.token, { mode: IMPORT_MODE.INCREMENTAL });
  service.commitJsonImport(prepared.token);

  const confirmed = service.confirmCandidateLog(direct.id);
  const editedConfirmed = service.updateLog(edited.id, { note: '编辑后确认' }).log;
  service.deleteLog(discarded.id, true);

  assert.deepEqual(
    [confirmed.status, confirmed.source, editedConfirmed.status, editedConfirmed.source],
    [LOG_STATUS.CONFIRMED, LOG_SOURCE.FILE, LOG_STATUS.CONFIRMED, LOG_SOURCE.FILE]
  );
  assert.equal(service.snapshot().timeLogs.some((item) => item.id === discarded.id), false);
});

test('冲突必须先预览并对每个冲突统一应用所选策略', () => {
  for (const [policy, expectedTitles] of [
    [CONFLICT_POLICY.KEEP_LOCAL, ['本地甲', '本地乙']],
    [CONFLICT_POLICY.USE_IMPORTED, ['导入甲', '导入乙']]
  ]) {
    const { service, now } = createHarness();
    const first = service.createWish('本地甲');
    const second = service.createWish('本地乙');
    const imported = service.snapshot();
    imported.wishes.find((item) => item.id === first.id).title = '导入甲';
    imported.wishes.find((item) => item.id === first.id).updatedAt = now() + 1;
    imported.wishes.find((item) => item.id === second.id).title = '导入乙';
    imported.wishes.find((item) => item.id === second.id).updatedAt = now() + 1;

    const prepared = service.prepareJsonImport(JSON.stringify(imported));
    const unresolved = service.previewJsonImport(prepared.token, { mode: IMPORT_MODE.INCREMENTAL });
    assert.equal(unresolved.conflictCount, 2);
    assert.equal(unresolved.requiresConflictPolicy, true);
    assert.throws(
      () => service.commitJsonImport(prepared.token),
      (error) => error.code === 'IMPORT_PREVIEW_REQUIRED'
    );

    const resolved = service.previewJsonImport(prepared.token, {
      mode: IMPORT_MODE.INCREMENTAL,
      conflictPolicy: policy
    });
    assert.equal(resolved.requiresConflictPolicy, false);
    service.commitJsonImport(prepared.token);
    assert.deepEqual(service.snapshot().wishes.map((item) => item.title), expectedTitles);
  }
});

test('旧 token、错误 token 和已取消 token 都不能预览或提交', () => {
  const { service } = createHarness();
  const json = JSON.stringify(service.snapshot());
  const first = service.prepareJsonImport(json);
  const second = service.prepareJsonImport(json);

  assert.throws(
    () => service.previewJsonImport(first.token, { mode: IMPORT_MODE.INCREMENTAL }),
    (error) => error.code === 'IMPORT_PREVIEW_NOT_FOUND'
  );
  assert.throws(
    () => service.commitJsonImport('import_wrong'),
    (error) => error.code === 'IMPORT_PREVIEW_NOT_FOUND'
  );

  service.cancelJsonImport(first.token);
  assert.doesNotThrow(() => service.previewJsonImport(second.token, { mode: IMPORT_MODE.INCREMENTAL }));
  service.cancelJsonImport(second.token);
  assert.throws(
    () => service.previewJsonImport(second.token, { mode: IMPORT_MODE.INCREMENTAL }),
    (error) => error.code === 'IMPORT_PREVIEW_NOT_FOUND'
  );
});

test('预览后本地快照变化会拒绝陈旧提交且保留新写入', () => {
  const { service } = createHarness();
  const imported = service.snapshot();
  imported.wishes.push(importedWish('wish_import', '导入愿望', imported.updatedAt));
  const prepared = service.prepareJsonImport(JSON.stringify(imported));
  service.previewJsonImport(prepared.token, { mode: IMPORT_MODE.INCREMENTAL });
  const lateWish = service.createWish('预览后的本地愿望');

  assert.throws(
    () => service.commitJsonImport(prepared.token),
    (error) => error.code === 'IMPORT_PREVIEW_STALE'
  );
  const snapshot = service.snapshot();
  assert.equal(snapshot.wishes.some((item) => item.id === lateWish.id), true);
  assert.equal(snapshot.wishes.some((item) => item.id === 'wish_import'), false);
});

test('覆盖导入在提交时重建资料库时间，只写一次主快照并清理迁移备份', () => {
  const { service, storage, setNow } = createHarness();
  const oldProfileId = service.snapshot().localProfile.id;
  const imported = createInitialDatabase(1_800_000_000_000);
  imported.wishes.push(importedWish('wish_replace', '覆盖导入', 1_800_000_000_000));
  storage.set(BACKUP_KEY, { schemaVersion: 0, sentinel: 'old-backup' });
  storage.resetCalls();

  const prepared = service.prepareJsonImport(JSON.stringify(imported));
  service.previewJsonImport(prepared.token, { mode: IMPORT_MODE.REPLACE });
  const commitNow = 1_900_000_000_000;
  setNow(commitNow);
  service.commitJsonImport(prepared.token);

  const snapshot = service.snapshot();
  assert.notEqual(snapshot.localProfile.id, oldProfileId);
  assert.equal(snapshot.localProfile.createdAt, commitNow);
  assert.equal(snapshot.createdAt, commitNow);
  assert.equal(snapshot.updatedAt, commitNow);
  assert.equal(snapshot.wishes[0].id, 'wish_replace');
  assert.equal(storage.has(BACKUP_KEY), false);
  assert.deepEqual(storage.setCalls, [STORAGE_KEY]);
  assert.deepEqual(storage.removeCalls, [BACKUP_KEY]);
});

test('覆盖导入写入失败时完整保留旧资料库', () => {
  const { service, storage } = createHarness();
  service.createWish('本地保留');
  const before = service.snapshot();
  const imported = createInitialDatabase(1_800_000_000_000);
  imported.wishes.push(importedWish('wish_replace', '不能落盘', 1_800_000_000_000));
  const prepared = service.prepareJsonImport(JSON.stringify(imported));
  service.previewJsonImport(prepared.token, { mode: IMPORT_MODE.REPLACE });
  storage.failNextSet = true;

  assert.throws(
    () => service.commitJsonImport(prepared.token),
    (error) => error instanceof StorageError && error.code === 'WRITE_FAILED'
  );
  assert.deepEqual(service.snapshot(), before);
});

test('清空必须确认，成功后重建空资料库、清除运行态和待处理导入', () => {
  const { service, storage, exportTempFileStore, setNow, now } = createHarness();
  service.createWish('待清空');
  service.startTimer({ note: '运行中' });
  const before = service.snapshot();
  const prepared = service.prepareJsonImport(JSON.stringify(before));
  storage.set(BACKUP_KEY, { schemaVersion: 0, sentinel: 'old-backup' });

  assert.throws(
    () => service.clearAllData(false),
    (error) => error.code === 'CLEAR_CONFIRMATION_REQUIRED'
  );
  assert.deepEqual(service.snapshot(), before);
  assert.equal(exportTempFileStore.removeAllStrictCalls, 0);

  setNow(now() + 10_000);
  const result = service.clearAllData(true);
  const snapshot = service.snapshot();
  assert.equal(exportTempFileStore.removeAllStrictCalls, 1);
  assert.equal(result.cleared, true);
  assert.notEqual(snapshot.localProfile.id, before.localProfile.id);
  assert.deepEqual(snapshot.wishes, []);
  assert.equal(snapshot.timer.status, TIMER_STATUS.IDLE);
  assert.equal(snapshot.recoveryDraft, null);
  assert.equal(storage.has(BACKUP_KEY), false);
  assert.throws(
    () => service.previewJsonImport(prepared.token, { mode: IMPORT_MODE.INCREMENTAL }),
    (error) => error.code === 'IMPORT_PREVIEW_NOT_FOUND'
  );
});

test('清空写入失败时保留旧资料库', () => {
  const { service, storage, exportTempFileStore } = createHarness();
  service.createWish('不能丢失');
  const before = service.snapshot();
  const prepared = service.prepareJsonImport(JSON.stringify(before));
  storage.failNextSet = true;

  assert.throws(
    () => service.clearAllData(true),
    (error) => error instanceof StorageError && error.code === 'WRITE_FAILED'
  );
  assert.equal(exportTempFileStore.removeAllStrictCalls, 1);
  assert.deepEqual(service.snapshot(), before);
  assert.doesNotThrow(
    () => service.previewJsonImport(prepared.token, { mode: IMPORT_MODE.INCREMENTAL })
  );
});

test('清空成功同步删除三个资料库身份偏好', () => {
  const storage = new TrackingStorage();
  const preferenceStore = new LocalPreferenceStore(storage);
  const { service } = createHarness(1_700_000_000_000, storage, { preferenceStore });
  const profileId = service.snapshot().localProfile.id;
  preferenceStore.write('TODO_SORT', profileId, [{ field: 'title' }]);
  preferenceStore.write('PROJECT_COLLAPSE', profileId, ['project_1']);
  preferenceStore.write('RECENT_LOG_HIGHLIGHT', profileId, { logId: 'log_1' });

  service.clearAllData(true);

  for (const preference of Object.values(PREFERENCES)) {
    assert.equal(storage.has(preference.key), false, preference.key);
  }
});

test('清空主资料库失败时恢复已删除的界面偏好', () => {
  const storage = new TrackingStorage();
  const preferenceStore = new LocalPreferenceStore(storage);
  const { service } = createHarness(1_700_000_000_000, storage, { preferenceStore });
  const profileId = service.snapshot().localProfile.id;
  preferenceStore.write('TODO_SORT', profileId, [{ field: 'title' }]);
  storage.failNextSet = true;

  assert.throws(
    () => service.clearAllData(true),
    (error) => error instanceof StorageError && error.code === 'WRITE_FAILED'
  );
  assert.deepEqual(
    preferenceStore.read('TODO_SORT', profileId, null),
    [{ field: 'title' }]
  );
});

test('主库清空与偏好恢复都失败时保留主库错误结论', () => {
  const storage = new TrackingStorage();
  const preferenceStore = {
    clearAllStrict() { return { captured: true }; },
    restoreAllBestEffort() { return false; }
  };
  const { service } = createHarness(1_700_000_000_000, storage, { preferenceStore });
  storage.failNextSet = true;

  const error = (() => {
    try {
      service.clearAllData(true);
    } catch (caught) {
      return caught;
    }
    assert.fail('预期清空失败');
  })();

  assert.equal(error instanceof StorageError, true);
  assert.equal(error.code, 'WRITE_FAILED');
  assert.match(error.message, /已保留当前数据/);
  assert.match(error.message, /界面设置可能已重置/);
});

test('覆盖导入成功后尽力删除旧 profile 的界面偏好', () => {
  const storage = new TrackingStorage();
  const preferenceStore = new LocalPreferenceStore(storage);
  const { service } = createHarness(1_700_000_000_000, storage, { preferenceStore });
  const oldProfileId = service.snapshot().localProfile.id;
  preferenceStore.write('TODO_SORT', oldProfileId, [{ field: 'title' }]);
  const imported = createInitialDatabase(1_800_000_000_000);
  const prepared = service.prepareJsonImport(JSON.stringify(imported));
  service.previewJsonImport(prepared.token, { mode: IMPORT_MODE.REPLACE });

  service.commitJsonImport(prepared.token);

  assert.equal(storage.has(PREFERENCES.TODO_SORT.key), false);
});

test('严格清理临时导出文件失败时不重置资料库，也不清除待处理导入', () => {
  const { service, storage } = createHarness();
  service.createWish('必须保留');
  const before = service.snapshot();
  const prepared = service.prepareJsonImport(JSON.stringify(before));
  service.exportTempFileStore = {
    removeAllStrict() {
      throw new Error('unlinkSync:fail permission denied http://usr/plan-and-record-share.json');
    }
  };
  storage.resetCalls();

  assert.throws(
    () => service.clearAllData(true),
    (error) => (
      error instanceof DomainError
      && error.code === 'EXPORT_TEMP_FILE_CLEANUP_FAILED'
      && !error.message.includes('http://usr')
      && !error.message.includes('permission denied')
    )
  );
  assert.deepEqual(storage.setCalls, []);
  assert.deepEqual(service.snapshot(), before);
  assert.doesNotThrow(
    () => service.previewJsonImport(prepared.token, { mode: IMPORT_MODE.INCREMENTAL })
  );
});

test('未配置临时导出文件存储时拒绝清空并保留资料库', () => {
  const storage = new TrackingStorage();
  const repository = new LocalRepository(storage, { now: () => 1_700_000_000_000 });
  const service = new ApplicationService(repository, { now: () => 1_700_000_000_000 });
  service.initialize();
  service.createWish('配置缺失也不能丢失');
  const before = service.snapshot();
  storage.resetCalls();

  assert.throws(
    () => service.clearAllData(true),
    (error) => (
      error instanceof DomainError
      && error.code === 'EXPORT_TEMP_FILE_STORE_UNAVAILABLE'
    )
  );
  assert.deepEqual(storage.setCalls, []);
  assert.deepEqual(service.snapshot(), before);
});

test('导入允许活动项目暂时超过五个，但之后仍禁止新增项目', () => {
  const { service, now } = createHarness();
  const imported = service.snapshot();
  for (let index = 0; index < 6; index += 1) {
    imported.projects.push(importedProject(`project_import_${index}`, `导入项目${index}`, now()));
  }

  const prepared = service.prepareJsonImport(JSON.stringify(imported));
  service.previewJsonImport(prepared.token, { mode: IMPORT_MODE.INCREMENTAL });
  service.commitJsonImport(prepared.token);

  assert.equal(service.snapshot().projects.length, 6);
  assert.throws(
    () => service.createProject({
      title: '仍受上限约束',
      deadlineAt: now() + 86_400_000
    }),
    (error) => error.code === 'ACTIVE_PROJECT_LIMIT'
  );
});

test('删除计划块会在同一事务中清空全部日志引用并保留计划摘要', () => {
  const { service, now } = createHarness();
  const event = createCalendarEventForTask(service, {
    title: '待删除计划',
    startedAt: now() + 3_600_000,
    endedAt: now() + 7_200_000
  });
  const first = service.createManualLog({
    startedAt: now() - 3_600_000,
    endedAt: now() - 1_800_000,
    calendarEventId: event.id
  }).log;
  const second = service.createManualLog({
    startedAt: now() - 1_700_000,
    endedAt: now() - 800_000,
    calendarEventId: event.id
  }).log;

  service.deleteCalendarEvent(event.id, true);

  for (const id of [first.id, second.id]) {
    const log = service.snapshot().timeLogs.find((item) => item.id === id);
    assert.equal(log.calendarEventId, null);
    assert.equal(log.calendarEventSummarySnapshot, '待删除计划');
    assert.equal(log.updatedAt, now());
  }
});

test('M1：写入失败不会替换内存快照', () => {
  class FailingStorage extends MemoryStorageAdapter {
    constructor() { super(); this.fail = false; }
    set(key, value) {
      if (this.fail) throw new Error('write failed');
      super.set(key, value);
    }
  }
  const storage = new FailingStorage();
  const repository = new LocalRepository(storage, { now: () => 1_700_000_000_000 });
  const service = new ApplicationService(repository, { now: () => 1_700_000_000_000 });
  service.initialize();
  storage.fail = true;
  assert.throws(() => service.createWish('不能写入'), (error) => error instanceof StorageError && error.code === 'WRITE_FAILED');
  assert.equal(service.snapshot().wishes.length, 0);
});
