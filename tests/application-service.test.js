const test = require('node:test');
const assert = require('node:assert/strict');

const { LOG_SOURCE, LOG_STATUS, MAX_TIMER_SPAN_MS, TASK_STATUS, TIMER_STATUS } = require('../miniprogram/domain/constants');
const { createIdleTimer, createInitialDatabase, clone } = require('../miniprogram/domain/entities');
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

function createHarness(start = 1_700_000_000_000, storage = new TrackingStorage()) {
  let now = start;
  const repository = new LocalRepository(storage, { now: () => now });
  const service = new ApplicationService(repository, { now: () => now });
  service.initialize();
  return {
    service,
    repository,
    storage,
    setNow(value) { now = value; },
    now() { return now; }
  };
}

function requiredObjectives() {
  return [{ title: '完成目标', keyResults: [{ title: '整体进度', currentValue: 0 }] }];
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
    categoryId: 'category_uncategorized',
    categoryNameSnapshot: '未分类',
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

test('M1：首次资料库生成匿名资料库和不可删除的未分类', () => {
  const { service } = createHarness();
  const snapshot = service.snapshot();

  assert.match(snapshot.localProfile.id, /^profile_/);
  assert.equal(snapshot.categories.length, 1);
  assert.equal(snapshot.categories[0].name, '未分类');
  assert.throws(() => service.archiveCategory(snapshot.categories[0].id), (error) => error.code === 'CATEGORY_SYSTEM');
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

test('M2：恢复草稿经用户修正后创建候选记录并清除草稿', () => {
  const { service, setNow, now } = createHarness();
  const startedAt = now();
  service.startTimer({ note: '需修正的计时' });
  setNow(startedAt - 1_000);
  const recovered = service.recoverTimer(now());
  assert.equal(recovered.state, 'draft');

  setNow(startedAt + 60_000);
  const log = service.createRecoveryCandidate({
    startedAt,
    endedAt: now(),
    note: '已修正的计时'
  });
  assert.equal(log.status, LOG_STATUS.CANDIDATE);
  assert.equal(log.source, LOG_SOURCE.TIMER);
  assert.equal(log.note, '已修正的计时');
  assert.equal(service.snapshot().recoveryDraft, null);
});

test('M2：超过 24 小时的计时恢复为候选记录', () => {
  const { service, setNow, now } = createHarness();
  service.startTimer({ note: '异常恢复' });
  setNow(now() + MAX_TIMER_SPAN_MS + 60_000);
  const recovered = service.recoverTimer(now());

  assert.equal(recovered.state, 'candidate');
  assert.equal(recovered.log.status, LOG_STATUS.CANDIDATE);
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
  const repeated = service.createRecurringPlan({
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
  const historicalEvent = service.createCalendarEvent({ title: '历史计划', startedAt: now() - 3_600_000, endedAt: now() - 1_800_000, projectId: project.id, taskId: completedTask.id });
  service.createCalendarEvent({ title: '未来计划', startedAt: now() + 3_600_000, endedAt: now() + 7_200_000, projectId: project.id, taskId: activeTask.id });
  const confirmed = service.createManualLog({ startedAt: now() - 3_000_000, endedAt: now() - 2_700_000, projectId: project.id, taskId: activeTask.id, note: '保留事实' }).log;

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
  const futureEvent = service.createCalendarEvent({
    title: '待删除计划',
    startedAt: now() + 60 * 60 * 1000,
    endedAt: now() + 2 * 60 * 60 * 1000,
    projectId: abandonedProject.id,
    taskId: deletingTask.id
  });
  const { rule } = service.createRecurringPlan({
    title: '待删除规则',
    startedAt: now() + 3 * 60 * 60 * 1000,
    endedAt: now() + 4 * 60 * 60 * 1000,
    frequency: 'daily',
    interval: 1,
    projectId: abandonedProject.id,
    taskId: deletingTask.id
  });
  service.startTimer({
    projectId: abandonedProject.id,
    taskId: deletingTask.id,
    calendarEventId: futureEvent.id
  });
  repository.transaction((database) => {
    database.timer.draft.originRuleId = rule.id;
    database.recoveryDraft = {
      reason: '待修正',
      timer: {
        ...createIdleTimer(),
        draft: {
          projectId: retainedProject.id,
          projectNameSnapshot: retainedProject.title,
          taskId: deletingTask.id,
          calendarEventId: futureEvent.id,
          repeatRuleId: rule.id
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
    [timerDraft.calendarEventId, timerDraft.calendarEventSummarySnapshot, timerDraft.originRuleId, timerDraft.originRuleSummarySnapshot],
    [null, futureEvent.title, null, rule.title]
  );
  assert.deepEqual(
    [recoveryDraft.projectId, recoveryDraft.projectNameSnapshot, recoveryDraft.taskId, recoveryDraft.taskNameSnapshot],
    [retainedProject.id, retainedProject.title, null, deletingTask.title]
  );
  assert.deepEqual(
    [recoveryDraft.calendarEventId, recoveryDraft.calendarEventSummarySnapshot, recoveryDraft.repeatRuleId, recoveryDraft.repeatRuleSummarySnapshot],
    [null, futureEvent.title, null, rule.title]
  );
});

test('M3：删除任务清除未结束计划并保留历史计划和计时记录', () => {
  const { service, repository, now } = createHarness();
  const project = service.createProject({ title: '关联项目', deadlineAt: now() + 86_400_000, objectives: requiredObjectives() });
  const task = service.createTask({ title: '待删除任务', projectId: project.id });
  const historicalEvent = service.createCalendarEvent({ title: '历史任务计划', startedAt: now() - 3_600_000, endedAt: now() - 1_800_000, projectId: project.id, taskId: task.id });
  const start = now() + 3_600_000;
  const futureEvent = service.createCalendarEvent({ title: '未来任务计划', startedAt: start, endedAt: start + 1_800_000, projectId: project.id, taskId: task.id });
  const { rule } = service.createRecurringPlan({
    title: '任务重复计划',
    startedAt: start,
    endedAt: start + 1_800_000,
    frequency: 'daily',
    interval: 1,
    projectId: project.id,
    taskId: task.id
  });
  service.overrideOccurrence(rule.id, start, {
    title: '任务重复计划（临时）',
    startedAt: start,
    endedAt: start + 1_800_000,
    priority: 1,
    projectId: project.id,
    projectNameSnapshot: project.title,
    taskId: task.id,
    taskNameSnapshot: task.title
  });
  const { log } = service.createManualLog({
    startedAt: now() - 3_600_000,
    endedAt: now() - 1_800_000,
    projectId: project.id,
    taskId: task.id,
    calendarEventId: futureEvent.id,
    note: '任务实际记录'
  });
  service.startTimer({ projectId: project.id, taskId: task.id });
  repository.transaction((database) => {
    database.recoveryDraft = {
      reason: '恢复任务',
      timer: {
        ...createIdleTimer(),
        draft: {
          projectId: project.id,
          projectNameSnapshot: project.title,
          taskId: task.id,
          taskNameSnapshot: task.title
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

  assert.equal(snapshot.tasks.some((item) => item.id === task.id), false);
  assert.deepEqual([keptEvent.taskId, keptEvent.taskNameSnapshot, keptEvent.projectId], [null, task.title, project.id]);
  assert.equal(snapshot.calendarEvents.some((item) => item.id === futureEvent.id), false);
  assert.equal(snapshot.repeatRules.some((item) => item.id === rule.id), false);
  assert.equal(snapshot.occurrenceExceptions.length, 0);
  assert.deepEqual([keptLog.taskId, keptLog.taskNameSnapshot], [null, task.title]);
  assert.deepEqual([keptLog.calendarEventId, keptLog.calendarEventSummarySnapshot], [null, futureEvent.title]);
  assert.deepEqual([snapshot.timer.draft.taskId, snapshot.timer.draft.taskNameSnapshot], [null, task.title]);
  assert.deepEqual([snapshot.recoveryDraft.timer.draft.taskId, snapshot.recoveryDraft.timer.draft.taskNameSnapshot], [null, task.title]);
});

test('M4：跳过实例和后续修订都不会生成重复投影', () => {
  const { service, now } = createHarness();
  const start = now() + 60 * 60 * 1000;
  const { rule } = service.createRecurringPlan({ title: '每周整理', startedAt: start, endedAt: start + 1_800_000, frequency: 'weekly', interval: 1, weekdays: [new Date(start).getDay()] });
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

test('M4：从首个实例修订后续会替换原修订，导出后仍可导入', () => {
  const { service, now } = createHarness();
  const start = now() + 60 * 60 * 1000;
  const { rule } = service.createRecurringPlan({
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
  const { service, storage, setNow, now } = createHarness();
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

  setNow(now() + 10_000);
  const result = service.clearAllData(true);
  const snapshot = service.snapshot();
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
  const { service, storage } = createHarness();
  service.createWish('不能丢失');
  const before = service.snapshot();
  storage.failNextSet = true;

  assert.throws(
    () => service.clearAllData(true),
    (error) => error instanceof StorageError && error.code === 'WRITE_FAILED'
  );
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
  const event = service.createCalendarEvent({
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
