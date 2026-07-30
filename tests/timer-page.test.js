const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { TIMER_STATUS } = require('../miniprogram/domain/constants');

const timerPagePath = require.resolve('../miniprogram/pages/timer/index.js');
const timerWxmlPath = path.join(__dirname, '../miniprogram/pages/timer/index.wxml');
const NOW = 1_700_000_000_000;

function loadTimerPage() {
  const originalPage = global.Page;
  let page;
  global.Page = (definition) => { page = definition; };
  delete require.cache[timerPagePath];
  require(timerPagePath);
  global.Page = originalPage;
  return page;
}

function createHarness(timer) {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const originalDateNow = Date.now;
  let currentNow = NOW;
  const page = loadTimerPage();

  global.getApp = () => ({ globalData: { bootstrap: { applicationService: {} } } });
  global.wx = { showToast() {} };
  Date.now = () => currentNow;
  page.data = {
    ...page.data,
    timer,
    elapsed: '00:00:00',
    elapsedMinutes: 0
  };
  page.setData = (updates, callback) => {
    Object.assign(page.data, updates);
    if (callback) callback();
  };

  return {
    page,
    setNow(value) { currentNow = value; },
    restore() {
      global.getApp = originalGetApp;
      global.wx = originalWx;
      Date.now = originalDateNow;
    }
  };
}

test('M2：计时页按秒刷新显示，并预览向上取整后的记录分钟数', () => {
  const harness = createHarness({
    status: TIMER_STATUS.RUNNING,
    startedAt: NOW - 5_000,
    endedAt: null,
    pausedAt: null,
    pauses: [],
    draft: { tags: [] }
  });
  try {
    harness.page.updateElapsed();
    assert.equal(harness.page.data.elapsed, '00:00:05');
    assert.equal(harness.page.data.elapsedMinutes, 1);

    harness.setNow(NOW + 26_000);
    harness.page.updateElapsed();
    assert.equal(harness.page.data.elapsed, '00:00:31');
    assert.equal(harness.page.data.elapsedMinutes, 1);

    harness.setNow(NOW + 56_000);
    harness.page.updateElapsed();
    assert.equal(harness.page.data.elapsed, '00:01:01');
    assert.equal(harness.page.data.elapsedMinutes, 2);
  } finally {
    harness.restore();
  }
});

test('M2：计时页提供跨日期补录和恢复草稿修正入口', () => {
  const wxml = fs.readFileSync(timerWxmlPath, 'utf8');
  assert.match(wxml, /manualStartDate/);
  assert.match(wxml, /manualEndDate/);
  assert.match(wxml, /openRecoveryManual/);
  assert.match(wxml, /时 : 分 : 秒/);
});

test('计时页只提交可选标签和计划块，不暴露分类、项目或任务选择器', () => {
  const page = loadTimerPage();
  page.data = {
    ...page.data,
    events: [{ id: '', title: '非计划实际' }, { id: 'event_plan', title: '写方案' }],
    eventIndex: 1,
    note: '按计划执行',
    tags: ['深度', '写作', 'AI']
  };
  assert.deepEqual(page.selectedInput(), {
    calendarEventId: 'event_plan',
    note: '按计划执行',
    tags: ['深度', '写作', 'AI']
  });
  assert.equal(page.data.maxTagsPerLog, 10);
  assert.equal(page.data.maxTagLength, 5);

  const wxml = fs.readFileSync(timerWxmlPath, 'utf8');
  assert.match(wxml, /计划块：/);
  assert.doesNotMatch(wxml, /分类：|项目：|任务：/);
  assert.match(wxml, /wx:for="\{\{tags\}\}"/);
  assert.match(wxml, /class="tag-chip tag-add"/);
  assert.match(wxml, /bindtap="removeTag"/);
  assert.doesNotMatch(wxml, /逗号分隔/);
});

test('计时页保留导入的超限标签交给应用服务按领域规则判断', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const calls = [];
  const toasts = [];
  global.getApp = () => ({
    globalData: {
      bootstrap: {
        applicationService: {
          startTimer(input) {
            calls.push(input);
            const error = new Error('一条记录最多添加 10 个标签');
            error.code = 'TAG_COUNT_EXCEEDED';
            throw error;
          }
        }
      }
    }
  });
  global.wx = {
    showToast(options) { toasts.push(options); }
  };
  try {
    const page = loadTimerPage();
    page.setData = (updates) => Object.assign(page.data, updates);
    page.refresh = () => {};
    Object.assign(page.data, {
      timer: { status: TIMER_STATUS.IDLE },
      events: [{ id: '', title: '非计划实际', associationType: 'none' }],
      eventIndex: 0,
      tags: ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一']
    });

    page.onPrimary();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].tags.length, 11);
    assert.equal(toasts.at(-1).title, '一条记录最多添加 10 个标签');
    assert.equal(toasts.at(-1).icon, 'none');
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('计时页保留导入的超限标签数组，由应用服务按规范化结果判断是否实际修改', () => {
  const page = loadTimerPage();
  const importedTags = Array.from({ length: 11 }, (_, index) => `标签${index}`);
  Object.assign(page.data, {
    events: [{ id: '', title: '非计划实际', associationType: 'none' }],
    eventIndex: 0,
    tags: importedTags,
    manualEvents: [{ id: '', title: '非计划实际', associationType: 'none' }],
    manualEventIndex: 0,
    manualTags: importedTags
  });

  assert.deepEqual(page.selectedInput().tags, importedTags);
  assert.deepEqual(page.selectedManualInput().tags, importedTags);
});

test('计时页以标签块添加、规范化和移除标签', () => {
  const originalWx = global.wx;
  const toasts = [];
  global.wx = { showToast(options) { toasts.push(options); } };
  try {
    const page = loadTimerPage();
    page.setData = (updates) => Object.assign(page.data, updates);
    page.openTagInput({ currentTarget: { dataset: { inputVisibleKey: 'tagInputVisible' } } });
    page.addTag({
      currentTarget: { dataset: { tagsKey: 'tags', inputVisibleKey: 'tagInputVisible' } },
      detail: { value: ' ＡＩ ' }
    });
    assert.deepEqual(page.data.tags, ['AI']);
    assert.equal(page.data.tagInputVisible, false);

    page.openTagInput({ currentTarget: { dataset: { inputVisibleKey: 'tagInputVisible' } } });
    page.addTag({
      currentTarget: { dataset: { tagsKey: 'tags', inputVisibleKey: 'tagInputVisible' } },
      detail: { value: 'AI' }
    });
    assert.equal(toasts.at(-1).title, '标签已存在');
    assert.equal(page.data.tagInputVisible, true);

    page.removeTag({ currentTarget: { dataset: { tagsKey: 'tags', index: 0 } } });
    assert.deepEqual(page.data.tags, []);
  } finally {
    global.wx = originalWx;
  }
});

test('计时页会显示并保留当前重复计划，已有同源日志后仍可再次选择该实例', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const page = loadTimerPage();
  const ranges = [];
  const snapshot = {
    projects: [],
    tasks: [{ id: 'task_repeat', title: '重复任务', status: 'todo' }],
    calendarEvents: [],
    timeLogs: [{
      id: 'log_existing_origin',
      originRuleId: 'rule_choice',
      originOccurrenceId: 'rule_choice:1:1700000000000'
    }],
    timer: {
      status: TIMER_STATUS.RUNNING,
      startedAt: NOW,
      endedAt: null,
      pausedAt: null,
      pauses: [],
      draft: {
        calendarEventId: null,
        originRuleId: 'rule_repeat',
        originOccurrenceId: 'rule_repeat:1:1700000000000',
        originRuleSummarySnapshot: '每日整理',
        note: '',
        tags: ['a,b', '复,盘']
      }
    },
    recoveryDraft: null
  };
  const service = {
    snapshot() { return snapshot; },
    timeline() {
      throw new Error('计划选择器不应使用会按日志去重的 timeline');
    },
    planAssociationCandidates(start, end) {
      ranges.push({ start, end });
      return [{
        id: 'event_near',
        type: 'plan',
        virtual: false,
        taskId: 'task_repeat',
        title: '具体计划',
        startedAt: NOW,
        endedAt: NOW + 60_000
      }, {
        id: 'rule_choice:1:1700000000000',
        type: 'candidate',
        virtual: true,
        ruleId: 'rule_choice',
        originOccurrenceId: 'rule_choice:1:1700000000000',
        taskId: 'task_repeat',
        title: '可选循环计划',
        startedAt: NOW,
        endedAt: NOW + 60_000
      }, {
        id: 'rule_taskless:1:1700000000000',
        type: 'candidate',
        virtual: true,
        ruleId: 'rule_taskless',
        originOccurrenceId: 'rule_taskless:1:1700000000000',
        taskId: 'deleted_task',
        title: '失效循环计划',
        startedAt: NOW,
        endedAt: NOW + 60_000
      }];
    }
  };
  global.getApp = () => ({
    globalData: {
      bootstrap: {
        applicationService: service
      }
    }
  });
  global.wx = { showToast() {} };
  page.setData = (updates, callback) => {
    Object.assign(page.data, updates);
    if (callback) callback();
  };
  page.updateElapsed = () => {};
  page.startTicker = () => {};
  try {
    page.refresh();
    assert.equal(page.data.events[page.data.eventIndex].associationType, 'current-origin');
    assert.equal(page.data.events.some((item) => item.associationType === 'event'), true);
    assert.equal(page.data.events.some((item) => item.originRuleId === 'rule_choice'), true);
    assert.equal(page.data.events.some((item) => item.originRuleId === 'rule_taskless'), false);
    assert.ok(ranges.every((range) => range.end - range.start <= 3 * 24 * 60 * 60 * 1_000));
    assert.deepEqual(page.data.tags, ['a,b', '复,盘']);
    assert.deepEqual(page.selectedInput(), {
      note: '',
      tags: ['a,b', '复,盘']
    });
    page.data.tags = page.data.tags.concat('新增');
    assert.deepEqual(page.selectedInput().tags, ['a,b', '复,盘', '新增']);
    page.data.tags = ['a,b', '复,盘'];
    const virtualIndex = page.data.events.findIndex(
      (item) => item.originRuleId === 'rule_choice'
    );
    page.data.eventIndex = virtualIndex;
    assert.deepEqual(page.selectedInput(), {
      originRuleId: 'rule_choice',
      originOccurrenceId: 'rule_choice:1:1700000000000',
      note: '',
      tags: ['a,b', '复,盘']
    });
    page.data.eventIndex = 0;
    assert.equal(page.selectedInput().calendarEventId, null);

    page.data.recoveryDraft = {
      timer: {
        startedAt: NOW,
        endedAt: NOW + 60_000,
        draft: {
          originRuleId: 'rule_repeat',
          originOccurrenceId: 'rule_repeat:1:1700000000000',
          originRuleSummarySnapshot: '每日整理',
          note: '',
          tags: ['恢复,一', '复,盘']
        }
      }
    };
    page.openRecoveryManual();
    assert.equal(
      page.data.manualEvents[page.data.manualEventIndex].associationType,
      'current-origin'
    );
    assert.equal(
      page.data.manualEvents.some((item) => item.originRuleId === 'rule_choice'),
      true
    );
    assert.equal(
      page.data.manualEvents.some((item) => item.calendarEventId === 'event_near'),
      true
    );
    assert.deepEqual(page.selectedManualInput(), {
      tags: ['恢复,一', '复,盘']
    });
    page.data.manualEventIndex = 0;
    assert.equal(page.selectedManualInput().calendarEventId, null);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('手工补录按记录区间有限投影具体与重复计划候选', () => {
  const page = loadTimerPage();
  const ranges = [];
  const snapshot = {
    projects: [],
    tasks: [{ id: 'task_live', title: '有效任务', status: 'todo' }],
    calendarEvents: [],
    timeLogs: [],
    timer: { status: TIMER_STATUS.IDLE, draft: {} },
    recoveryDraft: null
  };
  const service = {
    snapshot() { return snapshot; },
    timeline() {
      throw new Error('计划选择器不应使用会按日志去重的 timeline');
    },
    planAssociationCandidates(start, end) {
      ranges.push({ start, end });
      return [{
        id: 'event_manual',
        type: 'plan',
        virtual: false,
        taskId: 'task_live',
        title: '补录具体计划',
        startedAt: new Date(2026, 6, 30, 9, 0).getTime(),
        endedAt: new Date(2026, 6, 30, 9, 30).getTime()
      }, {
        id: 'rule_manual:1:123',
        type: 'candidate',
        virtual: true,
        ruleId: 'rule_manual',
        originOccurrenceId: 'rule_manual:1:123',
        taskId: 'task_live',
        title: '补录循环计划',
        startedAt: new Date(2026, 6, 30, 9, 30).getTime(),
        endedAt: new Date(2026, 6, 30, 10, 0).getTime()
      }];
    }
  };
  page.setData = (updates, callback) => {
    Object.assign(page.data, updates);
    if (callback) callback();
  };
  Object.assign(page.data, {
    events: [{ id: '', title: '非计划实际', associationType: 'none' }],
    eventIndex: 0,
    manualStartDate: '2026-07-30',
    manualStartTime: '09:00',
    manualEndDate: '2026-07-30',
    manualEndTime: '10:00'
  });
  page.currentSnapshot = snapshot;
  page.currentService = service;

  page.openManual();
  const virtualIndex = page.data.manualEvents.findIndex(
    (item) => item.originRuleId === 'rule_manual'
  );
  assert.ok(virtualIndex > 0);
  assert.equal(
    page.data.manualEvents.some((item) => item.calendarEventId === 'event_manual'),
    true
  );
  page.data.manualEventIndex = virtualIndex;
  assert.deepEqual(page.selectedManualInput(), {
    originRuleId: 'rule_manual',
    originOccurrenceId: 'rule_manual:1:123',
    tags: []
  });
  assert.equal(
    ranges[0].start,
    new Date(2026, 6, 30, 9, 0).getTime() - 24 * 60 * 60 * 1_000
  );
  assert.ok(ranges[0].end - ranges[0].start <= 3 * 24 * 60 * 60 * 1_000);

  const before = ranges.length;
  page.onManualField({
    currentTarget: { dataset: { key: 'manualStartTime' } },
    detail: { value: '08:30' }
  });
  assert.equal(ranges.length, before + 1);
});
