const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const calendarWxmlPath = path.join(__dirname, '../miniprogram/pages/calendar/index.wxml');
const calendarWxssPath = path.join(__dirname, '../miniprogram/pages/calendar/index.wxss');
const calendarScriptPath = path.join(__dirname, '../miniprogram/pages/calendar/index.js');
const calendarJsonPath = path.join(__dirname, '../miniprogram/pages/calendar/index.json');
const calendarPagePath = require.resolve('../miniprogram/pages/calendar/index.js');
const plansWxmlPath = path.join(__dirname, '../miniprogram/pages/plans/index.wxml');
const plansWxssPath = path.join(__dirname, '../miniprogram/pages/plans/index.wxss');

function loadCalendarPage() {
  const originalPage = global.Page;
  let page;
  global.Page = (definition) => { page = definition; };
  delete require.cache[calendarPagePath];
  require(calendarPagePath);
  global.Page = originalPage;
  page.setData = (updates, callback) => {
    Object.assign(page.data, updates);
    if (callback) callback();
  };
  return page;
}

test('M3：已归档项目可在页面中恢复', () => {
  const wxml = fs.readFileSync(plansWxmlPath, 'utf8');
  assert.match(wxml, /已归档项目/);
  assert.match(wxml, /restoreProject/);
});

test('M3：计划页以 TODO LIST 和项目内联子任务总览替代任务收集表单', () => {
  const wxml = fs.readFileSync(plansWxmlPath, 'utf8');
  assert.ok(wxml.indexOf('TODO LIST') < wxml.indexOf('项目（'));
  assert.match(wxml, /openStandaloneTask/);
  assert.match(wxml, /openChildTask/);
  assert.match(wxml, /wx:for="\{\{projectCards\}\}"/);
  assert.match(wxml, /bindtap="toggleProjectTodoExpansion"/);
  assert.match(wxml, /bindtap="toggleProjectCompletedExpansion"/);
  assert.doesNotMatch(wxml, /projectTaskPanel|openProjectTasks|switchProjectTaskTab/);
  assert.doesNotMatch(wxml, /OKR|关键结果|openKeyResult|okrEditor/);
  assert.match(wxml, /wx:if="{{isProjectCreateOpen}}"/);
  assert.doesNotMatch(wxml, /任务 \/ 备忘录/);
  assert.doesNotMatch(wxml, /加入收集箱/);
  assert.doesNotMatch(wxml, /整理为待办/);
});

test('计划页：TODO 使用三行横向列和图标操作', () => {
  const wxml = fs.readFileSync(plansWxmlPath, 'utf8');
  const wxss = fs.readFileSync(plansWxssPath, 'utf8');
  assert.match(wxml, /scroll-x="{{true}}"/);
  assert.doesNotMatch(wxml, /scroll-y="true"/);
  assert.match(wxml, /todoListColumns/);
  assert.match(wxml, /bindtouchstart="onTodoTouchStart"/);
  assert.match(wxml, /bindtouchend="onTodoTouchEnd"/);
  assert.match(wxml, /aria-label="关联项目"/);
  assert.match(wxml, /aria-label="删除"/);
  assert.match(wxml, /class="todo-scroll-tail" aria-hidden="true"/);
  assert.match(wxss, /\.todo-columns\s*\{[^}]*column-gap:\s*20%/s);
  assert.match(wxss, /\.todo-column\s*\{[^}]*flex:\s*0 0 60%/s);
  assert.match(wxss, /\.todo-scroll-tail\s*\{[^}]*flex:\s*0 0 20%/s);
  assert.doesNotMatch(wxss, /\.todo-row\s*\{[^}]*border-top/s);
});

test('M3：TODO 和项目的右上角新建入口为无底色深灰加号，页面不再显示悬浮按钮', () => {
  const wxml = fs.readFileSync(plansWxmlPath, 'utf8');
  const wxss = fs.readFileSync(plansWxssPath, 'utf8');
  assert.match(wxml, /class="section-add todo-add" bindtap="openStandaloneTask"/);
  assert.match(wxml, /class="section-add project-add" bindtap="openProjectCreate"/);
  assert.match(wxml, /section-heading"><view class="section-title">项目（/);
  assert.doesNotMatch(wxml, /todo-fab|右下角 \+/);
  assert.doesNotMatch(wxss, /\.todo-fab\s*\{/);
  assert.match(wxss, /\.section-header\s*\{[^}]*box-sizing:\s*border-box;[^}]*width:\s*100%/s);
  assert.match(wxss, /\.section-heading\s*\{[^}]*flex:\s*1;/s);
  assert.match(wxss, /\.section-add\s*\{[^}]*flex:\s*0 0 54rpx;[^}]*border-radius:\s*0;[^}]*background:\s*transparent;[^}]*color:\s*#59635d;/s);
});

test('M4：日历提供计划块编辑删除入口，重复实例编辑弹层只渲染一次', () => {
  const wxml = fs.readFileSync(calendarWxmlPath, 'utf8');
  const script = fs.readFileSync(calendarScriptPath, 'utf8');
  const wxss = fs.readFileSync(calendarWxssPath, 'utf8');
  assert.match(wxml, /openPlanEditor/);
  assert.match(wxml, /item\.type === 'plan' && !item\.virtual && item\.canEditPlan/);
  assert.match(wxml, /item\.type === 'plan' && item\.canAssociate/);
  assert.match(wxml, /item\.type === 'plan' && !item\.virtual[^>]*bindtap="deletePlan"/);
  assert.match(wxml, /item\.virtual[^>]*bindtap="confirmItem"/);
  assert.match(wxml, /item\.virtual[^>]*bindtap="openOccurrenceEditor"/);
  assert.match(wxml, /item\.virtual[^>]*bindtap="skipVirtualOccurrence"/);
  assert.match(wxml, /item\.type === 'candidate' && !item\.virtual[^>]*bindtap="confirmItem"/);
  assert.match(wxml, /item\.type === 'candidate' && !item\.virtual[^>]*bindtap="openLogEditor"/);
  assert.match(wxml, /item\.type === 'candidate' && !item\.virtual[^>]*bindtap="discardCandidate"/);
  assert.match(script, /item\.virtual\s*\?\s*'重复计划·待确认'/);
  assert.match(script, /item\.type === 'candidate'\s*\?\s*'候选记录'/);
  assert.doesNotMatch(script, /virtual[^\n]*candidate|candidate[^\n]*virtual/);
  assert.match(wxss, /\.timeline-item\.plan\s*\{[^}]*#7b918b/s);
  assert.match(wxml, /savePlanEditor/);
  assert.equal((wxml.match(/修改重复实例/g) || []).length, 1);
});

test('日历计划块只选择必选任务，日志编辑只选择标签和计划块', () => {
  const script = fs.readFileSync(calendarScriptPath, 'utf8');
  const wxml = fs.readFileSync(calendarWxmlPath, 'utf8');
  assert.match(wxml, /任务（必选）/);
  assert.match(wxml, /项目归属（由任务决定）/);
  assert.match(wxml, /logEventIndex/);
  assert.match(wxml, /wx:for="\{\{logTags\}\}"/);
  assert.match(wxml, /class="tag-chip tag-add"/);
  assert.doesNotMatch(wxml, /逗号分隔/);
  assert.doesNotMatch(wxml, /分类|logCategoryIndex|data-key="projectIndex"|data-key="planProjectIndex"/);
  assert.doesNotMatch(script, /categoryById|logCategories|logCategoryIndex/);
  assert.doesNotMatch(script, /projectId:\s*project/);
  assert.match(script, /normalizeTags/);
  assert.match(script, /tags:\s*this\.data\.logTags\.slice\(\)/);
  assert.match(script, /originRuleId: item\.ruleId/);
  assert.match(script, /calendarEventId: item\.id/);
  const page = loadCalendarPage();
  assert.equal(page.data.maxTagsPerLog, 10);
  assert.match(wxml, /class="tag-chip tag-input" focus maxlength="10"/);
});

test('日历日志编辑器分别提供开始结束日期、秒级时间和暂停时长', () => {
  const wxml = fs.readFileSync(calendarWxmlPath, 'utf8');
  const config = JSON.parse(fs.readFileSync(calendarJsonPath, 'utf8'));
  const logMarkup = wxml.slice(wxml.indexOf('wx:if="{{logEditor}}"'));

  assert.equal((logMarkup.match(/mode="date"/g) || []).length, 2);
  assert.equal((logMarkup.match(/<second-time-picker\b/g) || []).length, 2);
  assert.equal((logMarkup.match(/<pause-duration-input\b/g) || []).length, 1);
  assert.doesNotMatch(logMarkup, /mode="time"/);
  assert.equal(config.usingComponents['second-time-picker'], '/components/second-time-picker/index');
  assert.equal(config.usingComponents['pause-duration-input'], '/components/pause-duration-input/index');
});

test('日历日志只改备注时保留跨日首尾毫秒与暂停秒', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  let received;
  const startedAt = new Date(2026, 7, 4, 23, 59, 58, 987).getTime();
  const endedAt = new Date(2026, 7, 5, 0, 0, 2, 654).getTime();
  const snapshot = { projects: [], tasks: [], calendarEvents: [] };
  const service = {
    snapshot() { return snapshot; },
    planAssociationCandidates() { return []; },
    updateLog(id, input) {
      received = { id, input };
      return { log: { id } };
    }
  };
  global.getApp = () => ({ globalData: { bootstrap: { applicationService: service } } });
  global.wx = { showToast() {} };
  try {
    const page = loadCalendarPage();
    page.currentSnapshot = snapshot;
    page.currentService = service;
    page.refresh = () => {};
    page.openLogEditor({ currentTarget: { dataset: { item: {
      id: 'log_cross_day',
      type: 'confirmed',
      startedAt,
      endedAt,
      pausedDurationSeconds: 1,
      calendarEventId: null,
      note: '旧备注',
      tags: []
    } } } });
    assert.equal(page.data.logStartDate, '2026-08-04');
    assert.equal(page.data.logEndDate, '2026-08-05');
    assert.equal(page.data.logStartTimeValue, '23:59:58');
    assert.equal(page.data.logEndTimeValue, '00:00:02');
    page.data.logNote = '只改备注';

    page.saveLogEditor();

    assert.equal(received.input.startedAt, startedAt);
    assert.equal(received.input.endedAt, endedAt);
    assert.equal(received.input.pausedDurationSeconds, 1);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('日历页：持久化标题输入以 25 个 Unicode 码点截断', () => {
  const page = loadCalendarPage();
  const emoji = '🙂';
  page.onTitleField({ currentTarget: { dataset: { key: 'title' } }, detail: { value: emoji.repeat(26) } });
  assert.equal(page.data.title, emoji.repeat(25));

  const wxml = fs.readFileSync(calendarWxmlPath, 'utf8');
  for (const key of ['title', 'editorTitle', 'planTitle']) {
    assert.match(wxml, new RegExp(`maxlength="-1"[^>]*data-key="${key}"[^>]*bindinput="onTitleField"`));
  }
});

test('日历创建计划只向服务提交任务关联', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  let received;
  global.getApp = () => ({
    globalData: {
      bootstrap: {
        applicationService: {
          createCalendarEvent(input) { received = input; }
        }
      }
    }
  });
  global.wx = { showToast() {} };
  try {
    const page = loadCalendarPage();
    Object.assign(page.data, {
      title: '写评审',
      startDate: '2026-07-30',
      startTime: '09:00',
      endDate: '2026-07-30',
      endTime: '10:00',
      tasks: [{ id: 'task_review', title: '评审任务' }],
      taskIndex: 0,
      repeatEnabled: false
    });
    page.refresh = () => {};
    page.createPlan();
    assert.equal(received.taskId, 'task_review');
    assert.equal(Object.prototype.hasOwnProperty.call(received, 'projectId'), false);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('日历按任务当前 projectId 派生只读项目标题', () => {
  const originalGetApp = global.getApp;
  const snapshot = {
    projects: [{ id: 'project_current', title: '重命名后的项目', status: 'active' }],
    tasks: [{
      id: 'task_plan',
      title: '计划任务',
      status: 'todo',
      projectId: 'project_current',
      projectNameSnapshot: '旧项目名'
    }],
    calendarEvents: []
  };
  global.getApp = () => ({
    globalData: {
      bootstrap: {
        applicationService: {
          snapshot() { return snapshot; },
          timeline() { return []; }
        }
      }
    }
  });
  try {
    const page = loadCalendarPage();
    page.refresh();
    assert.equal(page.data.tasks[1].derivedProjectName, '重命名后的项目');
  } finally {
    global.getApp = originalGetApp;
  }
});

test('日历只在重叠日志卡片显示低干扰的实际与候选计数', () => {
  const originalGetApp = global.getApp;
  const snapshot = { projects: [], tasks: [], calendarEvents: [] };
  const timeline = [{
    id: 'confirmed_overlap',
    type: 'confirmed',
    title: '实际记录',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_060_000,
    overlapMeta: { totalCount: 3, confirmedCount: 2, candidateCount: 1 }
  }, {
    id: 'candidate_overlap',
    type: 'candidate',
    title: '候选记录',
    startedAt: 1_700_000_010_000,
    endedAt: 1_700_000_050_000,
    overlapMeta: { totalCount: 1, confirmedCount: 1, candidateCount: 0 }
  }, {
    id: 'plain_log',
    type: 'confirmed',
    title: '普通记录',
    startedAt: 1_700_000_100_000,
    endedAt: 1_700_000_160_000
  }, {
    id: 'virtual_plan',
    type: 'plan',
    virtual: true,
    title: '重复计划',
    startedAt: 1_700_000_100_000,
    endedAt: 1_700_000_160_000
  }];
  global.getApp = () => ({
    globalData: { bootstrap: { applicationService: {
      snapshot() { return snapshot; },
      timeline() { return timeline; }
    } } }
  });
  try {
    const page = loadCalendarPage();
    page.refresh();
    const itemById = new Map(page.data.timeline.map((item) => [item.id, item]));

    assert.equal(
      itemById.get('confirmed_overlap').displayOverlap,
      '与其他记录重叠：实际 2 条、候选 1 条'
    );
    assert.equal(
      itemById.get('candidate_overlap').displayOverlap,
      '与其他记录重叠：实际 1 条'
    );
    assert.equal(itemById.get('plain_log').displayOverlap, '');
    assert.equal(itemById.get('virtual_plan').displayOverlap, '');

    const wxml = fs.readFileSync(calendarWxmlPath, 'utf8');
    const wxss = fs.readFileSync(calendarWxssPath, 'utf8');
    assert.match(wxml, /item\.overlapMeta[^}]*is-overlapping/);
    assert.match(wxml, /wx:if="\{\{item\.displayOverlap\}\}"[^>]*overlap-note/);
    assert.match(wxss, /\.timeline-item\.is-overlapping\s*\{[^}]*background:\s*#f8f5ee;[^}]*box-shadow:/s);
    assert.doesNotMatch(wxss, /\.timeline-item\.is-overlapping\s*\{[^}]*border-left:/s);
  } finally {
    global.getApp = originalGetApp;
  }
});

test('尚未结束的失效任务计划可补绑任务，历史失效计划保持只读', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const now = Date.now();
  const updates = [];
  const toasts = [];
  const snapshot = {
    projects: [],
    tasks: [{ id: 'task_live', title: '有效任务', status: 'todo', projectId: null }],
    calendarEvents: []
  };
  const items = [{
    id: 'event_valid_history',
    type: 'plan',
    virtual: false,
    taskId: 'task_live',
    title: '有效任务历史计划',
    startedAt: now - 2 * 60 * 60 * 1_000,
    endedAt: now - 60 * 60 * 1_000
  }, {
    id: 'event_repairable',
    type: 'plan',
    virtual: false,
    taskId: null,
    title: '待补绑未来计划',
    startedAt: now + 60 * 60 * 1_000,
    endedAt: now + 2 * 60 * 60 * 1_000
  }, {
    id: 'event_read_only',
    type: 'plan',
    virtual: false,
    taskId: null,
    title: '只读历史计划',
    startedAt: now - 2 * 60 * 60 * 1_000,
    endedAt: now - 60 * 60 * 1_000
  }, {
    id: 'rule_taskless:1:123',
    type: 'plan',
    virtual: true,
    taskId: null,
    title: '失效虚拟计划',
    startedAt: now + 60 * 60 * 1_000,
    endedAt: now + 2 * 60 * 60 * 1_000
  }];
  const service = {
    snapshot() { return snapshot; },
    timeline() { return items; },
    updateCalendarEvent(id, input) { updates.push({ id, input }); }
  };
  global.getApp = () => ({
    globalData: {
      bootstrap: {
        applicationService: service
      }
    }
  });
  global.wx = {
    showToast(options) { toasts.push(options); }
  };
  try {
    const page = loadCalendarPage();
    page.refresh();
    const itemById = new Map(page.data.timeline.map((item) => [item.id, item]));

    assert.equal(itemById.get('event_valid_history').canAssociate, true);
    assert.equal(itemById.get('event_valid_history').canEditPlan, true);
    assert.equal(itemById.get('event_repairable').canAssociate, false);
    assert.equal(itemById.get('event_repairable').canEditPlan, true);
    assert.equal(itemById.get('event_read_only').canAssociate, false);
    assert.equal(itemById.get('event_read_only').canEditPlan, false);
    assert.equal(itemById.get('rule_taskless:1:123').canEditPlan, false);

    page.openPlanEditor({
      currentTarget: { dataset: { item: itemById.get('event_repairable') } }
    });
    assert.equal(page.data.planTaskIndex, 0);
    assert.equal(page.data.planTasks[0].title, '请选择任务');

    page.refresh = () => {};
    page.savePlanEditor();
    assert.equal(updates.length, 0);
    assert.equal(toasts.at(-1).title, '请选择任务');

    page.data.planTasks.push({ id: 'task_missing', title: '已失效任务' });
    page.data.planTaskIndex = page.data.planTasks.length - 1;
    page.savePlanEditor();
    assert.equal(updates.length, 0);
    assert.equal(toasts.at(-1).title, '请选择任务');

    page.data.planTaskIndex = page.data.planTasks.findIndex((item) => item.id === 'task_live');
    page.savePlanEditor();
    assert.equal(updates.length, 1);
    assert.equal(updates[0].id, 'event_repairable');
    assert.equal(updates[0].input.taskId, 'task_live');
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('日历可从具体或虚拟计划块开始计时，并使用对应联合关联', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const associations = [];
  global.getApp = () => ({
    globalData: {
      bootstrap: {
        applicationService: {
          startTimer(input) { associations.push(input); }
        }
      }
    }
  });
  global.wx = {
    showToast() {},
    switchTab() {}
  };
  try {
    const page = loadCalendarPage();
    page.startTimerFromPlan({
      currentTarget: {
        dataset: { item: { id: 'event_plan', virtual: false } }
      }
    });
    page.startTimerFromPlan({
      currentTarget: {
        dataset: {
          item: {
            id: 'virtual_display_id',
            virtual: true,
            ruleId: 'rule_repeat',
            originOccurrenceId: 'rule_repeat:2:123'
          }
        }
      }
    });
    assert.deepEqual(associations, [
      { calendarEventId: 'event_plan' },
      {
        originRuleId: 'rule_repeat',
        originOccurrenceId: 'rule_repeat:2:123'
      }
    ]);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('日历确认虚拟实例或候选日志后会更新最近记录的 new 标记', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const stored = new Map();
  const calls = [];
  const snapshot = { localProfile: { id: 'profile_calendar' } };
  const service = {
    confirmVirtualOccurrence(item) {
      calls.push(['virtual', item]);
      return { id: 'confirmed_virtual' };
    },
    confirmCandidateLog(id) {
      calls.push(['candidate', id]);
      return { id: 'confirmed_candidate' };
    }
  };
  global.getApp = () => ({ globalData: { bootstrap: { applicationService: service } } });
  global.wx = {
    showToast() {},
    setStorageSync(key, value) { stored.set(key, value); }
  };
  try {
    const page = loadCalendarPage();
    page.currentSnapshot = snapshot;
    page.refresh = () => {};

    page.confirmItem({ currentTarget: { dataset: { item: {
      virtual: true,
      ruleId: 'rule_repeat',
      originOccurrenceId: 'rule_repeat:1:123'
    } } } });
    assert.deepEqual(stored.get('plan-and-record.recent-log-highlight'), {
      profileId: 'profile_calendar',
      logId: 'confirmed_virtual'
    });

    page.confirmItem({ currentTarget: { dataset: { item: { id: 'candidate_log', virtual: false } } } });
    assert.deepEqual(calls.map(([type]) => type), ['virtual', 'candidate']);
    assert.deepEqual(stored.get('plan-and-record.recent-log-highlight'), {
      profileId: 'profile_calendar',
      logId: 'confirmed_candidate'
    });
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('日志编辑可保留或明确解除重复计划实例关联', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const updates = [];
  const ranges = [];
  const snapshot = {
    projects: [],
    tasks: [{ id: 'task_repeat', title: '重复任务', status: 'todo' }],
    calendarEvents: []
  };
  const service = {
    snapshot() { return snapshot; },
    timeline() {
      throw new Error('计划选择器不应使用会按日志去重的 timeline');
    },
    planAssociationCandidates(start, end) {
      ranges.push({ start, end });
      return [{
        id: 'event_choice',
        virtual: false,
        type: 'plan',
        taskId: 'task_repeat',
        title: '可改绑具体计划',
        startedAt: new Date(2026, 6, 30, 10, 0).getTime(),
        endedAt: new Date(2026, 6, 30, 11, 0).getTime()
      }, {
        id: 'rule_choice:1:123',
        virtual: true,
        type: 'candidate',
        ruleId: 'rule_choice',
        originOccurrenceId: 'rule_choice:1:123',
        taskId: 'task_repeat',
        title: '可改绑循环计划',
        startedAt: new Date(2026, 6, 30, 11, 0).getTime(),
        endedAt: new Date(2026, 6, 30, 12, 0).getTime()
      }, {
        id: 'rule_taskless:1:123',
        virtual: true,
        type: 'candidate',
        ruleId: 'rule_taskless',
        originOccurrenceId: 'rule_taskless:1:123',
        taskId: 'deleted_task',
        title: '失效循环计划',
        startedAt: new Date(2026, 6, 30, 11, 0).getTime(),
        endedAt: new Date(2026, 6, 30, 12, 0).getTime()
      }];
    },
    updateLog(id, input) { updates.push({ id, input }); }
  };
  global.getApp = () => ({
    globalData: {
      bootstrap: {
        applicationService: service
      }
    }
  });
  global.wx = { showToast() {} };
  try {
    const page = loadCalendarPage();
    const log = {
      id: 'log_repeat',
      type: 'confirmed',
      startedAt: new Date(2026, 6, 30, 9, 0).getTime(),
      endedAt: new Date(2026, 6, 30, 10, 0).getTime(),
      calendarEventId: null,
      originRuleId: 'rule_repeat',
      originOccurrenceId: 'rule_repeat:rev:occurrence',
      originRuleSummarySnapshot: '每日写作',
      note: ''
    };
    page.currentSnapshot = snapshot;
    page.currentService = service;
    page.refresh = () => {};

    page.openLogEditor({ currentTarget: { dataset: { item: log } } });
    assert.equal(page.data.logEvents[page.data.logEventIndex].associationType, 'current-origin');
    assert.equal(page.data.logEvents.some((item) => item.calendarEventId === 'event_choice'), true);
    assert.equal(page.data.logEvents.some((item) => item.originRuleId === 'rule_choice'), true);
    assert.equal(page.data.logEvents.some((item) => item.originRuleId === 'rule_taskless'), false);
    assert.ok(ranges.every((range) => range.end - range.start <= 3 * 24 * 60 * 60 * 1_000));
    const rangesBeforeTimeChange = ranges.length;
    page.onEditorField({
      currentTarget: { dataset: { key: 'logStart' } },
      detail: { value: '08:30' }
    });
    assert.equal(ranges.length, rangesBeforeTimeChange + 1);
    assert.equal(page.data.logEvents[page.data.logEventIndex].associationType, 'current-origin');
    page.saveLogEditor();
    assert.equal(Object.prototype.hasOwnProperty.call(updates[0].input, 'calendarEventId'), false);

    page.openLogEditor({ currentTarget: { dataset: { item: log } } });
    page.data.logEventIndex = 0;
    page.saveLogEditor();
    assert.equal(updates[1].input.calendarEventId, null);

    page.openLogEditor({ currentTarget: { dataset: { item: log } } });
    page.data.logEventIndex = page.data.logEvents.findIndex(
      (item) => item.originRuleId === 'rule_choice'
    );
    page.saveLogEditor();
    assert.equal(updates[2].input.originRuleId, 'rule_choice');
    assert.equal(updates[2].input.originOccurrenceId, 'rule_choice:1:123');
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('日志编辑器只改备注时不限额规范化并保留导入的超限标签', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  let received;
  const snapshot = {
    projects: [],
    tasks: [],
    calendarEvents: []
  };
  const service = {
    snapshot() { return snapshot; },
    planAssociationCandidates() { return []; },
    updateLog(id, input) { received = { id, input }; }
  };
  global.getApp = () => ({
    globalData: {
      bootstrap: {
        applicationService: service
      }
    }
  });
  global.wx = { showToast() {} };
  try {
    const page = loadCalendarPage();
    const importedTags = [
      'a,b',
      '复,盘',
      '标签三',
      '标签四',
      '标签五',
      '标签六',
      '标签七',
      '标签八',
      '标签九',
      '标签十',
      '标签十一'
    ];
    page.currentSnapshot = snapshot;
    page.currentService = service;
    page.refresh = () => {};
    page.openLogEditor({
      currentTarget: {
        dataset: {
          item: {
            id: 'log_imported_tags',
            type: 'confirmed',
            startedAt: new Date(2026, 6, 30, 9, 0).getTime(),
            endedAt: new Date(2026, 6, 30, 10, 0).getTime(),
            calendarEventId: null,
            note: '旧备注',
            tags: importedTags
          }
        }
      }
    });
    assert.deepEqual(page.data.logTags, importedTags);
    page.data.logNote = '只改备注';
    page.saveLogEditor();
    assert.equal(received.input.note, '只改备注');
    assert.deepEqual(received.input.tags, importedTags);
    assert.equal(Object.prototype.hasOwnProperty.call(received.input, 'categoryId'), false);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});
