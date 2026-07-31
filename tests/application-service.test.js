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
      throw new Error('disk full');
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
  service.initialize();
  return {
    service,
    repository,
    storage,
    exportTempFileStore,
    setNow(value) { now = value; },
    now() { return now; }
  };
}

test('开发验收可用两秒恢复窗口创建一条候选记录', () => {
  const { service, setNow, now } = createHarness(undefined, undefined, {
    recoveryTimerSpanMs: 2_000,
    minimumRecoveryDurationMinutes: 1
  });
  const startedAt = now();
  service.startTimer({ note: '开发验收候选记录' });
  setNow(startedAt + 3_000);

  const recovered = service.recoverTimer(now());

  assert.equal(recovered.state, 'candidate');
  assert.equal(recovered.log.status, LOG_STATUS.CANDIDATE);
  assert.equal(recovered.log.durationMinutes, 1);
  assert.equal(service.snapshot().timer.status, TIMER_STATUS.IDLE);
});

function requiredObjectives() {
  return [{ title: '完成目标', keyResults: [{ title: '整体进度', currentValue: 0 }] }];
}

function createCalendarEventForTask(service, input) {
  const taskId = input.taskId || service.createTask({ title: `${input.title}任务` }).id;
  return service.createCalendarEvent({ ...input, taskId });
}

function createRecurringPlanForTask(service, input) {
  const taskId = input.taskId || service.createTask({ title: `${input.title}任务` }).id;
  return service.createRecurringPlan({ ...input, taskId });
}

function createCrossTaskOverrideFixture(service, repository, now, sourceTask, overrideTask) {
  const dayMs = 24 * 60 * 60 * 1000;
  const start = now() + 60 * 60 * 1000;
  const { rule } = service.createRecurringPlan({
    title: '跨任务重复计划',
    startedAt: start,
    endedAt: start + 30 * 60 * 1000,
    frequency: 'daily',
    interval: 1,
    taskId: sourceTask.id
  });
  const occurrenceStart = start + dayMs;
  service.overrideOccurrence(rule.id, occurrenceStart, {
    title: '临时改绑任务',
    startedAt: occurrenceStart,
    endedAt: occurrenceStart + 30 * 60 * 1000,
    priority: 2,
    taskId: overrideTask.id
  });
  const occurrence = service.timeline(
    occurrenceStart,
    occurrenceStart + 30 * 60 * 1000
  ).find((item) => item.virtual && item.occurrenceStart === occurrenceStart);
  const confirmed = service.confirmVirtualOccurrence(occurrence);
  const candidate = service.createManualLog({
    startedAt: occurrence.startedAt + 5 * 60 * 1000,
    endedAt: occurrence.startedAt + 10 * 60 * 1000,
    originRuleId: rule.id,
    originOccurrenceId: occurrence.originOccurrenceId
  }).log;
  repository.transaction((database) => {
    database.timeLogs.find((item) => item.id === candidate.id).status = LOG_STATUS.CANDIDATE;
  });
  service.startTimer({
    originRuleId: rule.id,
    originOccurrenceId: occurrence.originOccurrenceId
  });
  repository.transaction((database) => {
    database.recoveryDraft = {
      reason: '等待修复跨任务实例',
      timer: {
        ...createIdleTimer(),
        draft: {
          originRuleId: rule.id,
          originOccurrenceId: occurrence.originOccurrenceId,
          originRuleSummarySnapshot: rule.title
        }
      },
      createdAt: now()
    };
  });
  return {
    rule,
    occurrence,
    occurrenceStart,
    nextOccurrenceStart: occurrenceStart + dayMs,
    confirmed,
    candidate
  };
}

function importedWish(id, title, now) {
  return { id, title, createdAt: now, updatedAt: now };
}

function importedProject(id, title, now) {
  return {
    id,
    title,
    deadlineAt: now + 86_400_000,
    status: 'active',
    objectives: [],
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

test('新建记录和计时草稿统一规范化标签并执行 10/5 上限', () => {
  const { service, now } = createHarness();
  const manual = service.createManualLog({
    startedAt: now() - 3_600_000,
    endedAt: now() - 1_800_000,
    tags: [' ＡＩ ', 'AI', 'ai']
  }).log;
  assert.deepEqual(manual.tags, ['AI', 'ai']);

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

test('导入的超限计时草稿在不改标签时可生成记录或恢复为候选', () => {
  const { service, repository, now } = createHarness();
  const importedTags = Array.from({ length: 11 }, (_, index) => `标签${index}`);
  repository.transaction((database) => {
    database.timer = {
      status: TIMER_STATUS.ENDED,
      startedAt: now() - 120_000,
      endedAt: now() - 60_000,
      pausedAt: null,
      pauses: [],
      draft: { tags: importedTags }
    };
  });
  assert.deepEqual(service.generateTimerRecord().log.tags, importedTags);

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

test('M1/M3：关键结果只能记录百分比，活动项目不能超过五个', () => {
  const { service, now } = createHarness();
  const project = service.createProject({
    title: '学习项目',
    deadlineAt: now() + 86_400_000,
    objectives: [{ title: '完成', keyResults: [{ title: '进度', currentValue: 20 }] }]
  });
  assert.deepEqual(Object.keys(project.objectives[0].keyResults[0]).sort(), ['currentValue', 'id', 'title']);
  assert.throws(() => service.updateProject(project.id, {
    objectives: [{ title: '错误', keyResults: [{ title: '超范围', currentValue: 101 }] }]
  }), (error) => error instanceof DomainError && error.code === 'PERCENTAGE_INVALID');

  for (let index = 1; index < 5; index += 1) {
    service.createProject({ title: `项目${index}`, deadlineAt: now() + 86_400_000, objectives: requiredObjectives() });
  }
  assert.throws(() => service.createProject({ title: '第六个项目', deadlineAt: now() + 86_400_000, objectives: requiredObjectives() }), (error) => error.code === 'ACTIVE_PROJECT_LIMIT');
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

test('M2：计时暂停、恢复、结束后只在生成记录时写入 confirmed', () => {
  const { service, setNow, now } = createHarness();
  service.startTimer({ note: '专注' });
  setNow(now() + 30 * 60 * 1000);
  service.pauseTimer();
  setNow(now() + 10 * 60 * 1000);
  service.resumeTimer();
  setNow(now() + 20 * 60 * 1000);
  service.finishTimer();
  assert.equal(service.snapshot().timeLogs.length, 0);
  assert.equal(service.snapshot().timer.status, TIMER_STATUS.ENDED);

  const { log } = service.generateTimerRecord();
  assert.equal(log.durationMinutes, 50);
  assert.equal(log.status, LOG_STATUS.CONFIRMED);
  assert.equal(service.snapshot().timer.status, TIMER_STATUS.IDLE);
});

test('M2：短时计时生成的已确认记录至少计为一分钟', () => {
  const { service, setNow, now } = createHarness();
  service.startTimer({ note: '快速记录' });
  setNow(now() + 5_000);
  service.finishTimer();

  const { log } = service.generateTimerRecord();
  assert.equal(log.durationMinutes, 1);
  assert.equal(log.status, LOG_STATUS.CONFIRMED);
  assert.equal(log.note, '快速记录');
});

test('M2：计时记录超过整分钟后向上取整', () => {
  for (const [elapsedMilliseconds, expectedMinutes] of [[60_000, 1], [60_001, 2], [119_999, 2]]) {
    const { service, setNow, now } = createHarness();
    service.startTimer({ note: '向上取整' });
    setNow(now() + elapsedMilliseconds);
    service.finishTimer();
    assert.equal(service.generateTimerRecord().log.durationMinutes, expectedMinutes);
  }
});

test('M2：恢复草稿经用户修正并保存后创建实际记录、纳入默认统计且清除草稿', () => {
  const { service, setNow, now } = createHarness();
  const startedAt = now();
  service.startTimer({ note: '需修正的计时' });
  setNow(startedAt - 1_000);
  const recovered = service.recoverTimer(now());
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

test('开发调试不会覆盖进行中或待确认的计时', () => {
  const { service } = createHarness();
  service.startTimer({ note: '正在计时' });

  assert.throws(
    () => service.simulateTimerRecoveryFailureForDebug(),
    (error) => error.code === 'DEBUG_TIMER_TEST_REQUIRES_IDLE'
  );
});

test('M2：超过 24 小时的计时恢复为候选记录', () => {
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
  const recovered = service.recoverTimer(now());

  assert.equal(recovered.state, 'candidate');
  assert.equal(recovered.log.status, LOG_STATUS.CANDIDATE);
  assert.deepEqual(recovered.log.tags, importedTags);
  assert.equal(service.snapshot().timer.status, TIMER_STATUS.IDLE);
});

test('M2：暂停状态超时恢复时扣除尚未结束的暂停区间', () => {
  const { service, setNow, now } = createHarness();
  const startedAt = now();
  service.startTimer({ note: '运行一小时后长时间暂停' });
  setNow(startedAt + 60 * 60 * 1000);
  service.pauseTimer();
  setNow(startedAt + MAX_TIMER_SPAN_MS + 60 * 60 * 1000);

  const recovered = service.recoverTimer(now());

  assert.equal(recovered.state, 'candidate');
  assert.equal(recovered.log.startedAt, startedAt);
  assert.equal(recovered.log.endedAt, startedAt + MAX_TIMER_SPAN_MS);
  assert.equal(recovered.log.durationMinutes, 60);
  assert.equal(service.snapshot().timer.status, TIMER_STATUS.IDLE);
  assert.equal(service.snapshot().recoveryDraft, null);
});

test('M2：暂停区间不自洽时只保留恢复草稿', () => {
  const { service, repository, setNow, now } = createHarness();
  const startedAt = now();
  service.startTimer({ note: '暂停数据异常' });
  setNow(startedAt + 60 * 60 * 1000);
  service.pauseTimer();
  repository.transaction((database) => {
    database.timer.pauses = [{
      startedAt: startedAt + 30 * 60 * 1000,
      endedAt: startedAt + 90 * 60 * 1000
    }];
  });
  setNow(startedAt + MAX_TIMER_SPAN_MS + 60 * 60 * 1000);

  const recovered = service.recoverTimer(now());
  const snapshot = service.snapshot();

  assert.equal(recovered.state, 'draft');
  assert.equal(snapshot.timer.status, TIMER_STATUS.IDLE);
  assert.equal(snapshot.timeLogs.length, 0);
  assert.equal(snapshot.recoveryDraft.timer.pausedAt, startedAt + 60 * 60 * 1000);
});

test('M2：运行态字段矛盾时不得恢复或生成候选', () => {
  const { service, repository, setNow, now } = createHarness();
  const startedAt = now();
  service.startTimer({ note: '运行态字段异常' });
  repository.transaction((database) => {
    database.timer.endedAt = startedAt + 30 * 60 * 1000;
  });
  setNow(startedAt + 60 * 60 * 1000);

  const recovered = service.recoverTimer(now());
  const snapshot = service.snapshot();

  assert.equal(recovered.state, 'draft');
  assert.equal(snapshot.timer.status, TIMER_STATUS.IDLE);
  assert.equal(snapshot.timeLogs.length, 0);
  assert.equal(snapshot.recoveryDraft.timer.endedAt, startedAt + 30 * 60 * 1000);
});

test('M4：重复实例按需投影，确认后不会再次投影', () => {
  const { service, now } = createHarness();
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
  service.confirmVirtualOccurrence({ ...virtual });
  const after = service.timeline(start, start + 2 * 24 * 60 * 60 * 1000);
  assert.equal(after.filter((item) => item.originOccurrenceId === virtual.originOccurrenceId).length, 1);
  assert.equal(repeated.rule.revisions[0].frequency, 'daily');
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

test('M4：时间线按单次改期后的最终区间决定候选移入和移出', () => {
  const { service } = createHarness();
  const firstStart = new Date(2026, 6, 1, 9, 0, 0, 0).getTime();
  const occurrenceStart = new Date(2026, 6, 3, 9, 0, 0, 0).getTime();
  const queryStart = new Date(2026, 6, 2, 15, 0, 0, 0).getTime();
  const { rule } = createRecurringPlanForTask(service, {
    title: '改期事项',
    startedAt: firstStart,
    endedAt: firstStart + 60 * 60 * 1000,
    priority: 1,
    frequency: 'daily',
    interval: 1
  });
  service.overrideOccurrence(rule.id, occurrenceStart, {
    title: '移入查询范围',
    startedAt: queryStart + 15 * 60 * 1000,
    endedAt: queryStart + 75 * 60 * 1000,
    priority: 2
  });

  const movedIn = service.timeline(queryStart, queryStart + 60 * 60 * 1000)
    .filter((item) => item.virtual && item.occurrenceStart === occurrenceStart);
  const movedOut = service.timeline(occurrenceStart, occurrenceStart + 60 * 60 * 1000)
    .filter((item) => item.virtual && item.occurrenceStart === occurrenceStart);

  assert.equal(movedIn.length, 1);
  assert.equal(movedIn[0].startedAt, queryStart + 15 * 60 * 1000);
  assert.equal(movedIn[0].priority, 2);
  assert.equal(movedOut.length, 0);
});

test('M4：时间线按规则与原始发生时间跨修订去重已确认实例', () => {
  const { service, now } = createHarness();
  const start = now() + 60 * 60 * 1000;
  const { rule } = createRecurringPlanForTask(service, {
    title: '跨修订实例',
    startedAt: start,
    endedAt: start + 30 * 60 * 1000,
    priority: 1,
    frequency: 'daily',
    interval: 1
  });
  const occurrenceStart = start + 24 * 60 * 60 * 1000;
  const virtual = service.timeline(occurrenceStart, occurrenceStart + 30 * 60 * 1000)
    .find((item) => item.virtual && item.occurrenceStart === occurrenceStart);
  const confirmed = service.confirmVirtualOccurrence({ ...virtual });
  service.reviseRuleFollowing(rule.id, occurrenceStart, { priority: 2 });

  const timeline = service.timeline(occurrenceStart, occurrenceStart + 30 * 60 * 1000);
  const snapshot = service.snapshot();
  const revisedRule = snapshot.repeatRules.find((item) => item.id === rule.id);
  const revisedOccurrence = projectRule(
    revisedRule,
    occurrenceStart,
    occurrenceStart,
    snapshot.occurrenceExceptions
  )[0];

  assert.equal(timeline.some((item) => item.virtual && item.occurrenceStart === occurrenceStart), false);
  assert.equal(timeline.filter((item) => item.id === confirmed.id).length, 1);
  assert.notEqual(revisedOccurrence.originOccurrenceId, confirmed.originOccurrenceId);
  assert.throws(
    () => service.confirmVirtualOccurrence({ ...revisedOccurrence }),
    (error) => error.code === 'OCCURRENCE_ALREADY_CONFIRMED'
  );
});

test('M4：种子计划块改时后仍按规则最早逻辑实例抑制虚拟首项', () => {
  const { service, now } = createHarness();
  const start = now() + 60 * 60 * 1000;
  const { event } = createRecurringPlanForTask(service, {
    title: '移动首个计划块',
    startedAt: start,
    endedAt: start + 30 * 60 * 1000,
    priority: 1,
    frequency: 'daily',
    interval: 1
  });
  const movedStart = start + 6 * 60 * 60 * 1000;
  service.updateCalendarEvent(event.id, {
    startedAt: movedStart,
    endedAt: movedStart + 30 * 60 * 1000
  });

  const originalRange = service.timeline(start, start + 30 * 60 * 1000);
  const movedRange = service.timeline(movedStart, movedStart + 30 * 60 * 1000);

  assert.equal(
    originalRange.some((item) => item.virtual && item.occurrenceStart === start),
    false
  );
  assert.equal(movedRange.filter((item) => item.id === event.id).length, 1);
});

test('M5：候选默认不计统计，重叠提示计算相交分钟数', () => {
  const { service, now } = createHarness();
  const start = now() - 60 * 60 * 1000;
  service.createManualLog({ startedAt: start, endedAt: start + 40 * 60 * 1000, note: '甲' });
  service.createManualLog({ startedAt: start + 20 * 60 * 1000, endedAt: start + 50 * 60 * 1000, note: '乙' });
  const stats = service.statistics({ rangeStart: start - 1, rangeEnd: now() + 1 });

  assert.equal(stats.totalMinutes, 70);
  assert.equal(stats.overlaps.length, 1);
  assert.equal(stats.overlaps[0].minutes, 20);
});

test('M3：放弃项目删除未来对象但保留已确认历史和快照', () => {
  const { service, now } = createHarness();
  const project = service.createProject({ title: '待放弃项目', deadlineAt: now() + 86_400_000, objectives: requiredObjectives() });
  const completedTask = service.createTask({ title: '历史任务', projectId: project.id, status: 'completed' });
  service.updateTask(completedTask.id, { status: 'completed' });
  const activeTask = service.createTask({ title: '未来任务', projectId: project.id, status: 'todo' });
  const historicalEvent = createCalendarEventForTask(service, { title: '历史计划', startedAt: now() - 3_600_000, endedAt: now() - 1_800_000, taskId: completedTask.id });
  const futureEvent = createCalendarEventForTask(service, { title: '未来计划', startedAt: now() + 3_600_000, endedAt: now() + 7_200_000, taskId: activeTask.id });
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
    deadlineAt: now() + 86_400_000,
    objectives: requiredObjectives()
  });
  const completedTask = service.createTask({
    title: '已完成但仍有计划的任务',
    projectId: project.id
  });
  service.updateTask(completedTask.id, { status: TASK_STATUS.COMPLETED });
  const foreignProject = service.createProject({
    title: '其他项目',
    deadlineAt: now() + 86_400_000,
    objectives: requiredObjectives()
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
  const { event: repeatSeed, rule } = createRecurringPlanForTask(service, {
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

  service.abandonProject(project.id, true);
  const snapshot = service.snapshot();
  const keptTask = snapshot.tasks.find((task) => task.id === completedTask.id);
  const keptEvent = snapshot.calendarEvents.find((event) => event.id === historicalEvent.id);
  const keptHistory = snapshot.timeLogs.find((log) => log.id === confirmedHistory.id);
  const keptRuleLog = snapshot.timeLogs.find((log) => log.id === confirmedRule.id);

  assert.deepEqual([keptTask.projectId, keptTask.projectNameSnapshot], [null, project.title]);
  assert.deepEqual([keptEvent.taskId, keptEvent.projectId], [completedTask.id, null]);
  assert.equal(snapshot.calendarEvents.some((event) => event.id === futureEvent.id), false);
  assert.equal(snapshot.calendarEvents.some((event) => event.id === repeatSeed.id), false);
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

test('放弃项目把跨项目 override 槽位转为 skip，删除候选并保留已确认追溯', () => {
  const { service, repository, now } = createHarness();
  const sourceProject = service.createProject({
    title: '规则所属项目',
    deadlineAt: now() + 86_400_000,
    objectives: requiredObjectives()
  });
  const overrideProject = service.createProject({
    title: '临时改绑项目',
    deadlineAt: now() + 86_400_000,
    objectives: requiredObjectives()
  });
  const sourceTask = service.createTask({
    title: '规则任务 A',
    projectId: sourceProject.id
  });
  const overrideTask = service.createTask({
    title: '改绑任务 B',
    projectId: overrideProject.id
  });
  const fixture = createCrossTaskOverrideFixture(
    service,
    repository,
    now,
    sourceTask,
    overrideTask
  );

  service.abandonProject(overrideProject.id, true);
  const snapshot = service.snapshot();
  const keptRule = snapshot.repeatRules.find((item) => item.id === fixture.rule.id);
  const skippedSlot = snapshot.occurrenceExceptions.find((item) => (
    item.ruleId === fixture.rule.id
    && item.occurrenceStart === fixture.occurrenceStart
  ));
  const confirmed = snapshot.timeLogs.find((item) => item.id === fixture.confirmed.id);

  assert.ok(keptRule);
  assert.equal(keptRule.revisions.every((item) => item.taskId === sourceTask.id), true);
  assert.deepEqual([skippedSlot.kind, skippedSlot.override], ['skip', null]);
  assert.equal(snapshot.projects.some((item) => item.id === overrideProject.id), false);
  assert.equal(snapshot.tasks.some((item) => item.id === overrideTask.id), false);
  assert.equal(snapshot.timeLogs.some((item) => item.id === fixture.candidate.id), false);
  assert.deepEqual(
    [
      confirmed.status,
      confirmed.originRuleId,
      confirmed.originOccurrenceId,
      confirmed.originRuleSummarySnapshot
    ],
    [
      LOG_STATUS.CONFIRMED,
      null,
      fixture.occurrence.originOccurrenceId,
      fixture.rule.title
    ]
  );
  assert.deepEqual(
    [snapshot.timer.draft.originRuleId, snapshot.timer.draft.originOccurrenceId],
    [null, null]
  );
  assert.deepEqual(
    [
      snapshot.recoveryDraft.timer.draft.originRuleId,
      snapshot.recoveryDraft.timer.draft.originOccurrenceId
    ],
    [null, null]
  );
  assert.equal(
    service.timeline(
      fixture.occurrenceStart,
      fixture.occurrenceStart + 30 * 60 * 1000
    ).some((item) => item.virtual && item.ruleId === fixture.rule.id),
    false
  );
  assert.equal(
    service.timeline(
      fixture.nextOccurrenceStart,
      fixture.nextOccurrenceStart + 30 * 60 * 1000
    ).some((item) => item.virtual && item.taskId === sourceTask.id),
    true
  );
});

test('M3：放弃项目断开计时草稿失效引用且保留仍有效的项目关联', () => {
  const { service, repository, now } = createHarness();
  const abandonedProject = service.createProject({
    title: '待放弃项目',
    deadlineAt: now() + 86_400_000,
    objectives: requiredObjectives()
  });
  const retainedProject = service.createProject({
    title: '保留项目',
    deadlineAt: now() + 86_400_000,
    objectives: requiredObjectives()
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
    database.timer.draft.originRuleId = rule.id;
    database.timer.draft.originOccurrenceId = `${rule.id}:1:${rule.revisions[0].effectiveFrom}`;
    database.recoveryDraft = {
      reason: '待修正',
      timer: {
        ...createIdleTimer(),
        draft: {
          projectId: retainedProject.id,
          projectNameSnapshot: retainedProject.title,
          taskId: deletingTask.id,
          calendarEventId: futureEvent.id,
          repeatRuleId: rule.id,
          originRuleId: rule.id,
          originOccurrenceId: `${rule.id}:1:${rule.revisions[0].effectiveFrom}`
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
      recoveryDraft.repeatRuleId,
      recoveryDraft.repeatRuleSummarySnapshot,
      recoveryDraft.originRuleId,
      recoveryDraft.originOccurrenceId
    ],
    [null, futureEvent.title, null, rule.title, null, null]
  );
});

test('M3：删除任务清除未结束计划并保留历史计划和计时记录', () => {
  const { service, repository, now } = createHarness();
  const project = service.createProject({ title: '关联项目', deadlineAt: now() + 86_400_000, objectives: requiredObjectives() });
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
  const ruleLog = service.confirmVirtualOccurrence(virtual);
  service.overrideOccurrence(rule.id, start, {
    title: '任务重复计划（临时）',
    startedAt: start,
    endedAt: start + 1_800_000,
    priority: 1,
    taskId: task.id,
  });
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
          originRuleId: rule.id,
          originOccurrenceId: virtual.originOccurrenceId
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

test('删除 override 任务把槽位转为 skip，并保留候选与已确认日志的实例追溯', () => {
  const { service, repository, now } = createHarness();
  const sourceTask = service.createTask({ title: '规则任务 A' });
  const overrideTask = service.createTask({ title: '改绑任务 B' });
  const fixture = createCrossTaskOverrideFixture(
    service,
    repository,
    now,
    sourceTask,
    overrideTask
  );

  service.deleteTask(overrideTask.id, true);
  const snapshot = service.snapshot();
  const keptRule = snapshot.repeatRules.find((item) => item.id === fixture.rule.id);
  const skippedSlot = snapshot.occurrenceExceptions.find((item) => (
    item.ruleId === fixture.rule.id
    && item.occurrenceStart === fixture.occurrenceStart
  ));
  const confirmed = snapshot.timeLogs.find((item) => item.id === fixture.confirmed.id);
  const candidate = snapshot.timeLogs.find((item) => item.id === fixture.candidate.id);

  assert.ok(keptRule);
  assert.equal(keptRule.revisions.every((item) => item.taskId === sourceTask.id), true);
  assert.deepEqual([skippedSlot.kind, skippedSlot.override], ['skip', null]);
  assert.equal(snapshot.tasks.some((item) => item.id === overrideTask.id), false);
  assert.deepEqual(
    [
      confirmed.status,
      confirmed.originRuleId,
      confirmed.originOccurrenceId,
      confirmed.originRuleSummarySnapshot
    ],
    [
      LOG_STATUS.CONFIRMED,
      null,
      fixture.occurrence.originOccurrenceId,
      fixture.rule.title
    ]
  );
  assert.deepEqual(
    [
      candidate.status,
      candidate.originRuleId,
      candidate.originOccurrenceId,
      candidate.originRuleSummarySnapshot
    ],
    [
      LOG_STATUS.CANDIDATE,
      null,
      fixture.occurrence.originOccurrenceId,
      fixture.rule.title
    ]
  );
  assert.deepEqual(
    [snapshot.timer.draft.originRuleId, snapshot.timer.draft.originOccurrenceId],
    [null, null]
  );
  assert.deepEqual(
    [
      snapshot.recoveryDraft.timer.draft.originRuleId,
      snapshot.recoveryDraft.timer.draft.originOccurrenceId
    ],
    [null, null]
  );
  assert.equal(
    service.timeline(
      fixture.occurrenceStart,
      fixture.occurrenceStart + 30 * 60 * 1000
    ).some((item) => item.virtual && item.ruleId === fixture.rule.id),
    false
  );
  assert.equal(
    service.timeline(
      fixture.nextOccurrenceStart,
      fixture.nextOccurrenceStart + 30 * 60 * 1000
    ).some((item) => item.virtual && item.taskId === sourceTask.id),
    true
  );
});

test('taskless override 不回落到规则任务，也不进入时间线或计划关联候选', () => {
  const { service, repository, now } = createHarness();
  const sourceTask = service.createTask({ title: '规则任务 A' });
  const overrideTask = service.createTask({ title: '失效任务 B' });
  const start = now() + 60 * 60 * 1000;
  const { rule } = service.createRecurringPlan({
    title: '含失效 override 的规则',
    startedAt: start,
    endedAt: start + 30 * 60 * 1000,
    frequency: 'daily',
    interval: 1,
    taskId: sourceTask.id
  });
  const occurrenceStart = start + 24 * 60 * 60 * 1000;
  service.overrideOccurrence(rule.id, occurrenceStart, {
    title: '失效改绑实例',
    startedAt: occurrenceStart,
    endedAt: occurrenceStart + 30 * 60 * 1000,
    priority: 1,
    taskId: overrideTask.id
  });
  repository.transaction((database) => {
    const exception = database.occurrenceExceptions.find((item) => (
      item.ruleId === rule.id && item.occurrenceStart === occurrenceStart
    ));
    exception.override.taskId = null;
  });

  assert.equal(
    service.timeline(occurrenceStart, occurrenceStart + 30 * 60 * 1000)
      .some((item) => item.virtual && item.ruleId === rule.id),
    false
  );
  assert.equal(
    service.planAssociationCandidates(occurrenceStart, occurrenceStart + 30 * 60 * 1000)
      .some((item) => item.virtual && item.ruleId === rule.id),
    false
  );
  assert.equal(
    service.timeline(
      occurrenceStart + 24 * 60 * 60 * 1000,
      occurrenceStart + 24 * 60 * 60 * 1000 + 30 * 60 * 1000
    ).some((item) => item.virtual && item.taskId === sourceTask.id),
    true
  );
});

test('M4：跳过实例和后续修订都不会生成重复投影', () => {
  const { service, now } = createHarness();
  const start = now() + 60 * 60 * 1000;
  const { rule } = createRecurringPlanForTask(service, { title: '每周整理', startedAt: start, endedAt: start + 1_800_000, frequency: 'weekly', interval: 1, weekdays: [new Date(start).getDay()] });
  const firstVirtual = service.timeline(start, start + 14 * 86_400_000).find((item) => item.virtual);
  service.skipOccurrence(rule.id, firstVirtual.occurrenceStart);
  const afterSkip = service.timeline(start, start + 14 * 86_400_000);
  assert.equal(afterSkip.some((item) => item.occurrenceStart === firstVirtual.occurrenceStart), false);
  const nextVirtual = afterSkip.find((item) => item.virtual);
  service.reviseRuleFollowing(rule.id, nextVirtual.occurrenceStart, { priority: 3 });
  const afterRevision = service.timeline(start, start + 21 * 86_400_000);
  assert.equal(new Set(afterRevision.filter((item) => item.virtual).map((item) => item.occurrenceKey)).size, afterRevision.filter((item) => item.virtual).length);
  assert.equal(afterRevision.some((item) => item.virtual && item.priority === 3), true);
});

test('M4：连续后续修订只改优先级时保留上一修订的最终开始时间', () => {
  const { service, now } = createHarness();
  const start = now() + 2 * 60 * 60 * 1000;
  const { rule } = createRecurringPlanForTask(service, {
    title: '连续修订',
    startedAt: start,
    endedAt: start + 30 * 60 * 1000,
    priority: 1,
    frequency: 'daily',
    interval: 1
  });
  const firstLogicalStart = new Date(start);
  firstLogicalStart.setDate(firstLogicalStart.getDate() + 1);
  const firstDisplayStart = firstLogicalStart.getTime() - 60 * 60 * 1000;
  service.reviseRuleFollowing(rule.id, firstLogicalStart.getTime(), {
    startedAt: firstDisplayStart,
    endedAt: firstDisplayStart + 30 * 60 * 1000
  });

  const secondLogicalStart = new Date(firstLogicalStart.getTime());
  secondLogicalStart.setDate(secondLogicalStart.getDate() + 1);
  const expectedDisplayStart = secondLogicalStart.getTime() - 60 * 60 * 1000;
  service.reviseRuleFollowing(rule.id, secondLogicalStart.getTime(), { priority: 3 });

  const occurrence = service.timeline(
    expectedDisplayStart,
    expectedDisplayStart + 30 * 60 * 1000
  ).find((item) => (
    item.virtual
    && item.occurrenceStart === secondLogicalStart.getTime()
  ));

  assert.equal(occurrence.startedAt, expectedDisplayStart);
  assert.equal(occurrence.priority, 3);
  const legacyConfirmationInput = { ...occurrence };
  delete legacyConfirmationInput.occurrenceStart;
  const confirmed = service.confirmVirtualOccurrence(legacyConfirmationInput);
  assert.equal(confirmed.startedAt, expectedDisplayStart);
});

test('M4：从首个实例修订后续会替换原修订，导出后仍可导入', () => {
  const { service, now } = createHarness();
  const start = now() + 60 * 60 * 1000;
  const { rule } = createRecurringPlanForTask(service, {
    title: '每日整理',
    startedAt: start,
    endedAt: start + 1_800_000,
    frequency: 'daily',
    interval: 1
  });

  service.reviseRuleFollowing(rule.id, rule.revisions[0].effectiveFrom, { priority: 2 });

  const updatedRule = service.snapshot().repeatRules.find((item) => item.id === rule.id);
  assert.equal(updatedRule.revisions.length, 1);
  assert.equal(updatedRule.revisions[0].effectiveFrom, rule.revisions[0].effectiveFrom);
  assert.equal(updatedRule.revisions[0].effectiveUntil, null);
  assert.doesNotThrow(() => service.prepareJsonImport(service.exportJson()));
});

test('新关系链：计划创建、更新、修订和单次改期只能关联有效任务', () => {
  const { service, repository, now } = createHarness();
  const firstProject = service.createProject({
    title: '甲项目',
    deadlineAt: now() + 86_400_000,
    objectives: requiredObjectives()
  });
  const secondProject = service.createProject({
    title: '乙项目',
    deadlineAt: now() + 86_400_000,
    objectives: requiredObjectives()
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
  const occurrenceStart = start + 24 * 60 * 60 * 1000;
  const revision = service.reviseRuleFollowing(rule.id, occurrenceStart, {
    taskId: secondTask.id,
    priority: 2
  });
  assert.deepEqual(
    [revision.taskId, revision.projectId, revision.projectNameSnapshot],
    [secondTask.id, null, secondProject.title]
  );
  assert.throws(
    () => service.reviseRuleFollowing(rule.id, occurrenceStart, { projectId: firstProject.id }),
    (error) => error.code === 'PLAN_PROJECT_DIRECT_FORBIDDEN'
  );
  assert.throws(
    () => service.overrideOccurrence(rule.id, occurrenceStart, {
      title: '非法改期',
      startedAt: occurrenceStart,
      endedAt: occurrenceStart + 30 * 60 * 1000,
      projectId: secondProject.id
    }),
    (error) => error.code === 'PLAN_PROJECT_DIRECT_FORBIDDEN'
  );
  const exception = service.overrideOccurrence(rule.id, occurrenceStart, {
    title: '合法改期',
    startedAt: occurrenceStart,
    endedAt: occurrenceStart + 30 * 60 * 1000,
    taskId: secondTask.id
  });
  assert.deepEqual(
    [
      exception.override.taskId,
      exception.override.projectId,
      exception.override.projectNameSnapshot
    ],
    [secondTask.id, null, secondProject.title]
  );

  repository.transaction((database) => {
    database.repeatRules
      .find((item) => item.id === rule.id)
      .revisions
      .forEach((item) => {
        item.taskId = null;
      });
  });
  assert.equal(typeof service.saveOccurrenceException, 'undefined');
  const legacyRangeStart = occurrenceStart + 24 * 60 * 60 * 1000;
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

test('新关系链：日志和计时只写计划关联，direct task/project 始终为空', () => {
  const { service, repository, setNow, now } = createHarness();
  const project = service.createProject({
    title: '专注项目',
    deadlineAt: now() + 86_400_000,
    objectives: requiredObjectives()
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
    stored.originRuleId = 'rule_legacy';
    stored.originOccurrenceId = 'rule_legacy:1:1700000000000';
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
  service.finishTimer();
  const generated = service.generateTimerRecord().log;
  assert.deepEqual(
    [generated.calendarEventId, generated.taskId, generated.projectId],
    [event.id, null, null]
  );
});

test('重复计划实例可作为日志和计时的统一计划关联，并校验成对与互斥', () => {
  const { service, setNow, now } = createHarness();
  const task = service.createTask({ title: '循环任务' });
  const start = now() + 60 * 60 * 1000;
  const { event, rule } = service.createRecurringPlan({
    title: '每日循环',
    startedAt: start,
    endedAt: start + 30 * 60 * 1000,
    frequency: 'daily',
    interval: 1,
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
  service.finishTimer();
  const timerLog = service.generateTimerRecord().log;
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
  assert.equal(service.recoverTimer(recoveryStart - 1).state, 'draft');
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
  const { service, now } = createHarness();
  const task = service.createTask({ title: '多记录任务' });
  const start = now() + 60 * 60 * 1000;
  const { event, rule } = service.createRecurringPlan({
    title: '每日复盘',
    startedAt: start,
    endedAt: start + 30 * 60 * 1000,
    frequency: 'daily',
    interval: 1,
    taskId: task.id
  });
  const nextStart = start + 24 * 60 * 60 * 1000;
  const nextOccurrence = service.timeline(
    nextStart,
    nextStart + 30 * 60 * 1000
  ).find((item) => item.virtual);

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
    false
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
  const { service, repository, now } = createHarness();
  const project = service.createProject({
    title: '候选所属项目',
    deadlineAt: now() + 86_400_000,
    objectives: requiredObjectives()
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
  const incompleteOrigin = service.createManualLog({
    startedAt: now() - 30 * 60 * 1000,
    endedAt: now() - 20 * 60 * 1000
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
  const recurring = service.confirmVirtualOccurrence(virtual);

  repository.transaction((database) => {
    const concreteCandidate = database.timeLogs.find((item) => item.id === concrete.id);
    Object.assign(concreteCandidate, {
      status: LOG_STATUS.CANDIDATE,
      projectId: project.id,
      taskId: task.id,
      originRuleId: rule.id,
      originOccurrenceId: virtual.originOccurrenceId
    });
    const detachedCandidate = database.timeLogs.find((item) => item.id === detached.id);
    Object.assign(detachedCandidate, {
      status: LOG_STATUS.CANDIDATE,
      projectId: project.id,
      taskId: task.id,
      originOccurrenceId: '已删除规则的历史实例'
    });
    const incompleteCandidate = database.timeLogs.find((item) => item.id === incompleteOrigin.id);
    Object.assign(incompleteCandidate, {
      status: LOG_STATUS.CANDIDATE,
      projectId: project.id,
      taskId: task.id,
      originRuleId: rule.id
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
  const confirmedIncomplete = service.confirmCandidateLog(incompleteOrigin.id);
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
      confirmedIncomplete.projectId,
      confirmedIncomplete.taskId,
      confirmedIncomplete.originRuleId,
      confirmedIncomplete.originOccurrenceId
    ],
    [null, null, null, null]
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
  const { service, repository, now } = createHarness();
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

test('M5：JSON 导出移除本地残留的 targetValue，并可被当前导入器读取', () => {
  const { service, repository, now } = createHarness();
  const project = service.createProject({
    title: '历史项目',
    deadlineAt: now() + 86_400_000,
    objectives: requiredObjectives()
  });
  repository.transaction((database) => {
    database.legacyRootField = 'ignored';
    database.projects
      .find((item) => item.id === project.id)
      .legacyProjectField = 'ignored';
    database.projects
      .find((item) => item.id === project.id)
      .objectives[0]
      .keyResults[0]
      .targetValue = 100;
  });

  const json = service.exportJson();
  const exported = JSON.parse(json);
  const exportedKeyResult = exported.projects[0].objectives[0].keyResults[0];

  assert.equal(Object.prototype.hasOwnProperty.call(exported, 'legacyRootField'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(exported.projects[0], 'legacyProjectField'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(exportedKeyResult, 'targetValue'), false);
  assert.doesNotThrow(() => service.prepareJsonImport(json));
});

test('M5：导入会忽略旧版和未知字段，不写入资料库或制造冲突', () => {
  const { service, now } = createHarness();
  const project = service.createProject({
    title: '当前项目',
    deadlineAt: now() + 86_400_000,
    objectives: requiredObjectives()
  });
  const imported = service.snapshot();
  const importedProject = imported.projects.find((item) => item.id === project.id);
  imported.legacyRootField = 'ignored';
  importedProject.legacyProjectField = 'ignored';
  importedProject.objectives[0].keyResults[0].targetValue = 100;

  const prepared = service.prepareJsonImport(JSON.stringify(imported));
  const preview = service.previewJsonImport(prepared.token, { mode: IMPORT_MODE.INCREMENTAL });

  assert.equal(preview.conflictCount, 0);
  service.commitJsonImport(prepared.token);
  const storedProject = service.snapshot().projects.find((item) => item.id === project.id);
  assert.equal(Object.prototype.hasOwnProperty.call(storedProject, 'legacyProjectField'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(storedProject.objectives[0].keyResults[0], 'targetValue'), false);
});

test('M5：本地遗留的未知字段不影响导回刚导出的 JSON', () => {
  const { service, repository, now } = createHarness();
  const project = service.createProject({
    title: '历史项目',
    deadlineAt: now() + 86_400_000,
    objectives: requiredObjectives()
  });
  repository.transaction((database) => {
    database.projects
      .find((item) => item.id === project.id)
      .objectives[0]
      .keyResults[0]
      .targetValue = 100;
  });

  const prepared = service.prepareJsonImport(service.exportJson());
  const preview = service.previewJsonImport(prepared.token, { mode: IMPORT_MODE.INCREMENTAL });

  assert.equal(preview.conflictCount, 0);
  service.commitJsonImport(prepared.token);
  const storedProject = service.snapshot().projects.find((item) => item.id === project.id);
  assert.equal(Object.prototype.hasOwnProperty.call(storedProject.objectives[0].keyResults[0], 'targetValue'), false);
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
  assert.equal(committed.addedCounts.timeLogs, 1);
  assert.deepEqual(storage.setCalls, [STORAGE_KEY]);
  assert.throws(
    () => service.commitJsonImport(prepared.token),
    (error) => error.code === 'IMPORT_PREVIEW_NOT_FOUND'
  );
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
  assert.equal(storage.get(BACKUP_KEY), undefined);
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
  assert.equal(storage.get(BACKUP_KEY), undefined);
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
      deadlineAt: now() + 86_400_000,
      objectives: requiredObjectives()
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
  class FailingStorage {
    constructor() { this.value = undefined; this.fail = false; }
    get() { return this.value; }
    set(key, value) { if (this.fail) throw new Error('disk full'); this.value = value; }
  }
  const storage = new FailingStorage();
  const repository = new LocalRepository(storage, { now: () => 1_700_000_000_000 });
  const service = new ApplicationService(repository, { now: () => 1_700_000_000_000 });
  service.initialize();
  storage.fail = true;
  assert.throws(() => service.createWish('不能写入'), (error) => error instanceof StorageError && error.code === 'WRITE_FAILED');
  assert.equal(service.snapshot().wishes.length, 0);
});
