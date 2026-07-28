const test = require('node:test');
const assert = require('node:assert/strict');

const { LOG_STATUS, MAX_TIMER_SPAN_MS, TIMER_STATUS } = require('../miniprogram/domain/constants');
const { LocalRepository } = require('../miniprogram/repository/local-repository');
const { MemoryStorageAdapter } = require('../miniprogram/repository/storage-adapter');
const { ApplicationService } = require('../miniprogram/services/application-service');
const { DomainError, StorageError } = require('../miniprogram/domain/errors');

function createHarness(start = 1_700_000_000_000) {
  let now = start;
  const repository = new LocalRepository(new MemoryStorageAdapter(), { now: () => now });
  const service = new ApplicationService(repository, { now: () => now });
  service.initialize();
  return {
    service,
    setNow(value) { now = value; },
    now() { return now; }
  };
}

function requiredObjectives() {
  return [{ title: '完成目标', keyResults: [{ title: '整体进度', currentValue: 0, targetValue: 100 }] }];
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
    objectives: [{ title: '完成', keyResults: [{ title: '进度', currentValue: 20, targetValue: 100 }] }]
  });
  assert.equal(project.objectives[0].keyResults[0].targetValue, 100);
  assert.throws(() => service.updateProject(project.id, {
    objectives: [{ title: '错误', keyResults: [{ title: '超范围', currentValue: 101, targetValue: 100 }] }]
  }), (error) => error instanceof DomainError && error.code === 'PERCENTAGE_INVALID');

  for (let index = 1; index < 5; index += 1) {
    service.createProject({ title: `项目${index}`, deadlineAt: now() + 86_400_000, objectives: [{ title: '目标', keyResults: [{ title: '进度', currentValue: 0, targetValue: 100 }] }] });
  }
  assert.throws(() => service.createProject({ title: '第六个项目', deadlineAt: now() + 86_400_000, objectives: [{ title: '目标', keyResults: [{ title: '进度', currentValue: 0, targetValue: 100 }] }] }), (error) => error.code === 'ACTIVE_PROJECT_LIMIT');
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

test('M2：超过 24 小时的计时恢复为候选记录', () => {
  const { service, setNow, now } = createHarness();
  service.startTimer({ note: '异常恢复' });
  setNow(now() + MAX_TIMER_SPAN_MS + 60_000);
  const recovered = service.recoverTimer(now());

  assert.equal(recovered.state, 'candidate');
  assert.equal(recovered.log.status, LOG_STATUS.CANDIDATE);
  assert.equal(service.snapshot().timer.status, TIMER_STATUS.IDLE);
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

test('M5：JSON 和 CSV 导出保留日志状态、来源与关系', () => {
  const { service, now } = createHarness();
  const log = service.createManualLog({ startedAt: now() - 3_600_000, endedAt: now() - 1_800_000, note: '含,逗号' }).log;
  const json = service.exportJson();
  const csv = service.exportLogsCsv();

  assert.equal(JSON.parse(json).schemaVersion, 1);
  assert.match(json, new RegExp(log.id));
  assert.match(csv, /"含,逗号"/);
  assert.match(csv, /confirmed,manual/);
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
