const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { LocalPreferenceStore } = require('../miniprogram/services/local-preference-store');

const calendarWxmlPath = path.join(__dirname, '../miniprogram/pages/calendar/index.wxml');
const calendarWxssPath = path.join(__dirname, '../miniprogram/pages/calendar/index.wxss');
const calendarScriptPath = path.join(__dirname, '../miniprogram/pages/calendar/index.js');
const calendarJsonPath = path.join(__dirname, '../miniprogram/pages/calendar/index.json');
const calendarPagePath = require.resolve('../miniprogram/pages/calendar/index.js');
const planEditorWxmlPath = path.join(__dirname, '../miniprogram/components/plan-editor-sheet/index.wxml');
const planEditorWxssPath = path.join(__dirname, '../miniprogram/components/plan-editor-sheet/index.wxss');
const planEditorComponentPath = require.resolve('../miniprogram/components/plan-editor-sheet/index.js');
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

function deferSetDataCallbacks(page) {
  const callbacks = [];
  page.setData = (updates, callback) => {
    Object.assign(page.data, updates);
    if (callback) callbacks.push(callback);
  };
  return callbacks;
}

function loadPlanEditorSheet(properties = {}) {
  const originalComponent = global.Component;
  let definition;
  global.Component = (value) => { definition = value; };
  delete require.cache[planEditorComponentPath];
  require(planEditorComponentPath);
  global.Component = originalComponent;
  const component = {
    data: { ...definition.data },
    properties: {
      visible: true,
      variant: 'calendar',
      mode: 'create',
      initialValue: {
        title: '',
        anchorDate: Date.now(),
        priority: 1,
        hasAnyTasks: true,
        taskOptions: [{ id: '', title: '请选择任务' }],
        taskIndex: 0
      },
      ...properties
    },
    setData(updates, callback) {
      Object.assign(this.data, updates);
      if (callback) callback();
    },
    events: [],
    triggerEvent(name, detail) { this.events.push({ name, detail }); }
  };
  Object.entries(definition.methods).forEach(([name, method]) => {
    component[name] = method.bind(component);
  });
  definition.observers.visible.call(component, true);
  return component;
}

test('日历新增计划弹窗改由 plan-editor-sheet 承载且页面不持有表单可编辑字段', () => {
  const wxml = fs.readFileSync(calendarWxmlPath, 'utf8');
  const json = JSON.parse(fs.readFileSync(calendarJsonPath, 'utf8'));
  const pageJs = fs.readFileSync(calendarScriptPath, 'utf8');
  assert.equal(json.usingComponents['plan-editor-sheet'], '/components/plan-editor-sheet/index');
  assert.doesNotMatch(wxml, /<page-meta\b/);
  assert.match(wxml, /<plan-editor-sheet[\s\S]*visible="\{\{isCreateOpen\}\}"/);
  assert.match(wxml, /variant="calendar"/);
  assert.match(wxml, /bind:success="onPlanEditorSuccess"/);
  assert.match(wxml, /bind:cancel="onPlanEditorCancel"/);
  assert.match(wxml, /bind:taskindexchange="onPlanEditorTaskIndexChange"/);
  assert.match(
    wxml,
    /class="calendar-fab"[^>]*>\+<\/view>\s*<\/view>\s*<plan-editor-sheet/
  );
  assert.match(wxml, /scroll-y="\{\{!isCreateOpen\}\}"/);
  assert.match(
    wxml,
    /class="calendar-scroll \{\{pageTurnClass\}\} \{\{isCreateOpen \? 'is-sheet-open' : ''\}\}"/
  );
  assert.doesNotMatch(wxml, /class="modal create-modal"/);
  assert.doesNotMatch(pageJs, /createPlan\(\)\s*\{/);
});

test('日历页记住组件任务选择并在取消后重新新增时回填', () => {
  const page = loadCalendarPage();
  page.data.tasks = [
    { id: '', title: '请选择任务' },
    { id: '__create_same_title_task__', title: '新建同名任务', optionType: 'create' },
    { id: 'task_review', title: '评审任务', optionType: 'task' }
  ];
  page.data.hasAnyTasks = true;

  page.openCreatePlan();
  page.onPlanEditorTaskIndexChange({ detail: { taskIndex: 2 } });
  assert.equal(page.data.taskIndex, 2);

  page.onPlanEditorCancel();
  page.openCreatePlan();
  assert.equal(page.data.planEditorInitialValue.taskIndex, 2);
});

test('日历粗粒度多行时间格可由左侧时间文案切换折叠与展开', () => {
  const page = loadCalendarPage();
  ['year', 'month', 'week'].forEach((view) => {
    const collapseKey = `${view}:row-1`;
    page.data.view = view;
    page.data.timeRows = [{ collapseKey, isCollapsible: true, isCollapsed: false }];

    page.toggleCoarseRow({ currentTarget: { dataset: { collapseKey } } });
    assert.equal(page.data.timeRows[0].isCollapsed, true);
    assert.equal(page.collapsedCoarseRowKeys.has(collapseKey), true);

    page.toggleCoarseRow({ currentTarget: { dataset: { collapseKey } } });
    assert.equal(page.data.timeRows[0].isCollapsed, false);
    assert.equal(page.collapsedCoarseRowKeys.has(collapseKey), false);
  });

  page.data.view = 'month';
  page.data.timeRows = [{
    collapseKey: 'month:row-2',
    isCollapsible: false,
    isCollapsed: false
  }];
  page.toggleCoarseRow({ currentTarget: { dataset: { collapseKey: 'month:row-2' } } });
  assert.equal(page.data.timeRows[0].isCollapsed, false);

  page.data.view = 'day';
  page.data.timeRows = [{
    collapseKey: 'day:row-1',
    isCollapsible: true,
    isCollapsed: false
  }];
  page.toggleCoarseRow({ currentTarget: { dataset: { collapseKey: 'day:row-1' } } });
  assert.equal(page.data.timeRows[0].isCollapsed, false);
});

test('日历新增成功只在关闭弹窗 setData 完成后定位计划', () => {
  const originalWx = global.wx;
  global.wx = { showToast() {} };
  try {
    const page = loadCalendarPage();
    const callbacks = deferSetDataCallbacks(page);
    const createdEvent = { id: 'event_created' };
    let revealed;
    page.data.isCreateOpen = true;
    page.revealCreatedPlan = (event) => { revealed = event; };

    page.onPlanEditorSuccess({
      detail: { operation: 'create-event', revealTarget: createdEvent }
    });

    assert.equal(page.data.isCreateOpen, false);
    assert.equal(revealed, undefined);
    assert.equal(callbacks.length, 1);
    callbacks.shift()();
    assert.equal(revealed, createdEvent);
  } finally {
    global.wx = originalWx;
  }
});

test('日历更新成功只在关闭弹窗 setData 完成后刷新', () => {
  const originalWx = global.wx;
  global.wx = { showToast() {} };
  try {
    const page = loadCalendarPage();
    const callbacks = deferSetDataCallbacks(page);
    let refreshCount = 0;
    page.data.isCreateOpen = true;
    page.refresh = () => { refreshCount += 1; };

    page.onPlanEditorSuccess({
      detail: { operation: 'update-event' }
    });

    assert.equal(page.data.isCreateOpen, false);
    assert.equal(refreshCount, 0);
    assert.equal(callbacks.length, 1);
    callbacks.shift()();
    assert.equal(refreshCount, 1);
  } finally {
    global.wx = originalWx;
  }
});

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
  assert.match(wxml, /class="section-add todo-add"[^>]*bindtap="openStandaloneTask"/);
  assert.match(wxml, /<view wx:if="\{\{activeProjects\.length < 5\}\}" class="section-add project-add" role="button" aria-label="新建项目" bindtap="openProjectCreate">\+<\/view>/);
  assert.doesNotMatch(wxml, /<button[^>]*class="section-add project-add"/);
  assert.match(wxml, /section-heading"><view class="section-title">项目（/);
  assert.doesNotMatch(wxml, /todo-fab|右下角 \+/);
  assert.doesNotMatch(wxss, /\.todo-fab\s*\{/);
  assert.match(wxss, /\.section-header\s*\{[^}]*box-sizing:\s*border-box;[^}]*width:\s*100%/s);
  assert.match(wxss, /\.section-heading\s*\{[^}]*flex:\s*1;/s);
  assert.match(wxss, /\.section-add\s*\{[^}]*flex:\s*0 0 54rpx;[^}]*border-radius:\s*0;[^}]*background:\s*transparent;[^}]*color:\s*#59635d;/s);
});

test('M4：日历详情层提供原有操作，画布块不显示状态文字且顶部保留图例', () => {
  const wxml = fs.readFileSync(calendarWxmlPath, 'utf8');
  const script = fs.readFileSync(calendarScriptPath, 'utf8');
  const wxss = fs.readFileSync(calendarWxssPath, 'utf8');
  assert.match(wxml, /openPlanEditor/);
  assert.match(wxml, /class="detail-actions-start">[\s\S]*bindtap="deletePlan">删除计划[\s\S]*bindtap="deleteRuleFollowing">删除本次及后续[\s\S]*bindtap="skipVirtualOccurrence"[\s\S]*class="detail-actions-end">/);
  assert.match(wxml, /class="detail-actions-end">[\s\S]*bindtap="openPlanEditor">编辑计划[\s\S]*bindtap="startTimerFromPlan">开始计时[\s\S]*detailItem\.virtual && detailItem\.canConfirmVirtual[^>]*bindtap="confirmItem">确认完成/);
  assert.match(wxml, /detailItem\.type === 'plan' && !detailItem\.virtual && detailItem\.canEditPlan/);
  assert.match(wxml, /detailItem\.type === 'plan' && detailItem\.canAssociate/);
  assert.match(wxml, /detailItem\.type === 'plan' && !detailItem\.virtual[^>]*bindtap="deletePlan"/);
  assert.match(wxml, /detailItem\.virtual[^>]*bindtap="confirmItem"/);
  assert.match(wxml, /detailItem\.virtual[^>]*class="detail-action danger-action"[^>]*bindtap="deleteRuleFollowing">删除本次及后续/);
  assert.match(wxml, /detailItem\.virtual[^>]*bindtap="skipVirtualOccurrence"/);
  assert.match(wxss, /\.detail-actions\s*\{[^}]*justify-content:\s*space-between;/s);
  assert.match(wxss, /\.detail-actions-start\s*\{[^}]*justify-content:\s*flex-start;/s);
  assert.match(wxss, /\.detail-actions-end\s*\{[^}]*justify-content:\s*flex-end;[^}]*margin-left:\s*auto;/s);
  assert.match(wxml, /detailItem\.type === 'candidate' && !detailItem\.virtual[^>]*bindtap="confirmItem"/);
  assert.match(wxml, /detailItem\.type === 'candidate' && !detailItem\.virtual[^>]*bindtap="openLogEditor"/);
  assert.match(wxml, /detailItem\.type === 'candidate' && !detailItem\.virtual[^>]*bindtap="discardCandidate"/);
  assert.match(script, /item\.virtual\s*\?\s*'重复计划·待确认'/);
  assert.doesNotMatch(script, /已从计划块开始计时/);
  assert.match(script, /item\.virtual\s*\?\s*'固定日程已完成'/);
  assert.doesNotMatch(script, /重复计划已确认/);
  assert.match(script, /item\.type === 'candidate'\s*\?\s*'候选记录'/);
  assert.doesNotMatch(script, /virtual[^\n]*candidate|candidate[^\n]*virtual/);
  assert.match(wxss, /\.calendar-block\.plan\s*\{[^}]*#7f8ca1/s);
  assert.match(wxml, /bindtap="openItemDetail"/);
  assert.match(wxml, /class="calendar-legend"[^>]*>[\s\S]*>计划<[\s\S]*>记录<[\s\S]*>候选<[\s\S]*bindtap="cycleTimelineFilter">[\s\S]*\{\{timelineFilterLabel\}\}[\s\S]*>↻</);
  assert.match(wxml, /class="block-title">\{\{item\.title\}\}<\/view>/);
  assert.doesNotMatch(wxml, /isDecorativeSegment|is-decorative-segment/);
  assert.doesNotMatch(script, /isDecorativeSegment/);
  assert.match(wxml, /detailItem\.isAggregate/);
  assert.match(wxml, /wx:for="\{\{detailItem\.aggregateItems\}\}"[\s\S]*bindtap="openItemDetail"/);
  assert.match(wxss, /\.calendar-block\.aggregate\s*\{[^}]*#a9bdae[^}]*#e6ece7/s);
  const componentWxml = fs.readFileSync(planEditorWxmlPath, 'utf8');
  assert.match(componentWxml, /bind:confirm="submitPlanForm"/);
  assert.match(componentWxml, /title="\{\{planEditor \? '编辑计划' : '新增计划'\}\}"/);
  assert.doesNotMatch(wxml, /编辑计划块|bindtap="closePlanEditor"/);
  assert.equal((wxml.match(/<plan-editor-sheet\b/g) || []).length, 1);
  assert.doesNotMatch(wxml, /修改本次|修改本次及后续|submitOccurrenceEditor/);
  assert.doesNotMatch(script, /overrideOccurrence|reviseRuleFollowing|editorMode|editorTitle|saveOccurrenceOverride|saveRuleFollowing/);
});

test('日历筛选按钮按全部、计划、记录循环，并将候选归入记录', () => {
  const originalGetApp = global.getApp;
  const startedAt = new Date(2026, 7, 14, 9, 0).getTime();
  const snapshot = {
    projects: [],
    tasks: [{ id: 'task_1', title: '测试任务', status: 'todo', projectId: null }],
    calendarEvents: []
  };
  const items = [{
    id: 'plan_1',
    type: 'plan',
    virtual: false,
    taskId: 'task_1',
    title: '计划块',
    startedAt,
    endedAt: startedAt + 30 * 60 * 1_000
  }, {
    id: 'candidate_1',
    type: 'candidate',
    virtual: false,
    title: '候选记录',
    startedAt: startedAt + 30 * 60 * 1_000,
    endedAt: startedAt + 60 * 60 * 1_000
  }, {
    id: 'confirmed_1',
    type: 'confirmed',
    virtual: false,
    title: '实际记录',
    startedAt: startedAt + 60 * 60 * 1_000,
    endedAt: startedAt + 90 * 60 * 1_000
  }];
  global.getApp = () => ({
    globalData: { bootstrap: { applicationService: {
      snapshot() { return snapshot; },
      timeline() { return items; }
    } } }
  });

  try {
    const page = loadCalendarPage();
    page.data.anchor = startedAt;
    page.refresh();
    assert.equal(page.data.timelineFilter, 'all');
    assert.equal(page.data.timelineFilterLabel, '查看全部');
    assert.deepEqual(page.data.timeline.map((item) => item.id), ['plan_1', 'candidate_1', 'confirmed_1']);

    page.cycleTimelineFilter();
    assert.equal(page.data.timelineFilter, 'plan');
    assert.equal(page.data.timelineFilterLabel, '只看计划');
    assert.deepEqual(page.data.timeline.map((item) => item.id), ['plan_1']);

    page.cycleTimelineFilter();
    assert.equal(page.data.timelineFilter, 'record');
    assert.equal(page.data.timelineFilterLabel, '只看记录');
    assert.deepEqual(page.data.timeline.map((item) => item.id), ['candidate_1', 'confirmed_1']);

    page.cycleTimelineFilter();
    assert.equal(page.data.timelineFilter, 'all');
    assert.equal(page.data.timelineFilterLabel, '查看全部');
    assert.deepEqual(page.data.timeline.map((item) => item.id), ['plan_1', 'candidate_1', 'confirmed_1']);
  } finally {
    global.getApp = originalGetApp;
  }
});

test('日历粗粒度刷新只在时间行保留块数据并使用独立空态', () => {
  const originalGetApp = global.getApp;
  const startedAt = new Date(2026, 7, 14, 9, 0).getTime();
  let items = [{
    id: 'plan_1',
    type: 'plan',
    virtual: false,
    title: '计划块',
    startedAt,
    endedAt: startedAt + 30 * 60 * 1_000
  }];
  global.getApp = () => ({
    globalData: { bootstrap: { applicationService: {
      snapshot() {
        return { projects: [], tasks: [], calendarEvents: [] };
      },
      timeline() { return items; }
    } } }
  });

  try {
    const page = loadCalendarPage();
    page.data.view = 'month';
    page.data.anchor = startedAt;
    page.refresh();

    assert.equal(page.data.hasTimelineItems, true);
    assert.deepEqual(page.data.timeline, []);
    assert.equal(page.data.timeRows.flatMap((row) => row.blocks).length, 1);

    items = [];
    page.refresh();
    assert.equal(page.data.hasTimelineItems, false);
    assert.deepEqual(page.data.timeline, []);
    assert.equal(page.data.timeRows.flatMap((row) => row.blocks).length, 0);
  } finally {
    global.getApp = originalGetApp;
  }
});

test('日历固定日程用完整句式解释重复间隔', () => {
  const page = loadPlanEditorSheet();
  const wxml = fs.readFileSync(planEditorWxmlPath, 'utf8');
  const wxss = fs.readFileSync(planEditorWxssPath, 'utf8');

  assert.deepEqual(page.data.frequencyUnits, ['天', '周', '月']);
  assert.match(wxml, /class="repeat-interval-row"><text>每隔<\/text><input[^>]*value="\{\{repeatGap\}\}"[^>]*bindinput="onRepeatGapInput"[^>]*><picker class="repeat-frequency-picker" range="\{\{frequencyUnits\}\}"/);
  assert.match(wxml, /class="picker repeat-frequency-field">\{\{frequencyUnits\[frequencyIndex\]\}\}<\/view><\/picker><text>\{\{repeatOccurrenceText\}\}<\/text>/);
  assert.doesNotMatch(wxml, /frequencyLabels/);
  assert.match(wxss, /\.repeat-interval-input\s*\{[^}]*width:\s*116rpx;[^}]*height:\s*64rpx;[^}]*padding:\s*0 12rpx;[^}]*line-height:\s*64rpx;[^}]*text-align:\s*center;/s);
  assert.match(wxss, /\.repeat-frequency-picker\s*\{[^}]*width:\s*116rpx;/s);
  assert.equal(page.data.repeatGap, '0');
});

test('日历每周固定日程默认选择今天并按周一到周日展示', () => {
  const page = loadPlanEditorSheet();
  const wxml = fs.readFileSync(planEditorWxmlPath, 'utf8');
  const today = new Date().getDay();

  assert.deepEqual(page.data.weekdayOptions, [
    { label: '一', value: 1, checked: today === 1 },
    { label: '二', value: 2, checked: today === 2 },
    { label: '三', value: 3, checked: today === 3 },
    { label: '四', value: 4, checked: today === 4 },
    { label: '五', value: 5, checked: today === 5 },
    { label: '六', value: 6, checked: today === 6 },
    { label: '日', value: 0, checked: today === 0 }
  ]);
  assert.deepEqual(page.data.repeatWeekdays, [today]);
  assert.match(wxml, /wx:for="\{\{weekdayOptions\}\}"[^>]*wx:key="value"/);
  assert.match(wxml, /checkbox value="\{\{item\.value\}\}" checked="\{\{item\.checked\}\}"/);
  assert.match(wxml, /\{\{item\.label\}\}/);

  page.onPicker({
    currentTarget: { dataset: { key: 'frequencyIndex' } },
    detail: { value: '1' }
  });
  page.onWeekdaysChange({ detail: { value: ['1', '3', '0'] } });
  assert.deepEqual(page.data.repeatWeekdays, [1, 3, 0]);
  assert.equal(page.data.repeatOccurrenceText, '3次');
  assert.deepEqual(
    page.data.weekdayOptions.filter((item) => item.checked).map((item) => item.value),
    [1, 3, 0]
  );

  page.onWeekdaysChange({ detail: { value: ['1'] } });
  assert.equal(page.data.repeatOccurrenceText, '一次');
});

test('日历每月固定日程提供两行高的独立滚动日期多选并联动次数', () => {
  const page = loadPlanEditorSheet();
  const wxml = fs.readFileSync(planEditorWxmlPath, 'utf8');
  const wxss = fs.readFileSync(planEditorWxssPath, 'utf8');
  const today = new Date().getDate();

  assert.equal(page.data.monthDayOptions.length, 31);
  assert.deepEqual(page.data.monthDayOptions.map((item) => item.value), Array.from({ length: 31 }, (_, index) => index + 1));
  assert.deepEqual(page.data.repeatMonthDays, [today]);
  assert.deepEqual(
    page.data.monthDayOptions.filter((item) => item.checked).map((item) => item.value),
    [today]
  );
  assert.match(wxml, /<scroll-view[^>]*wx:if="\{\{frequencyIndex === 2\}\}"[^>]*class="month-day-scroll"[^>]*scroll-y="\{\{true\}\}"[^>]*>/);
  assert.match(wxml, /<checkbox-group class="month-day-group" bindchange="onMonthDaysChange">/);
  assert.match(wxml, /wx:for="\{\{monthDayOptions\}\}"[^>]*wx:key="value"/);
  assert.match(wxss, /\.month-day-scroll\s*\{[^}]*height:\s*120rpx;[^}]*overflow:\s*hidden;/s);
  assert.match(wxss, /\.month-day-option\s*\{[^}]*width:\s*14\.285714%;[^}]*height:\s*60rpx;/s);

  page.onPicker({
    currentTarget: { dataset: { key: 'frequencyIndex' } },
    detail: { value: '2' }
  });
  page.onMonthDaysChange({ detail: { value: ['1', '15', '31'] } });
  assert.deepEqual(page.data.repeatMonthDays, [1, 15, 31]);
  assert.equal(page.data.repeatOccurrenceText, '3次');
  assert.deepEqual(
    page.data.monthDayOptions.filter((item) => item.checked).map((item) => item.value),
    [1, 15, 31]
  );

  page.onMonthDaysChange({ detail: { value: ['15'] } });
  assert.equal(page.data.repeatOccurrenceText, '一次');
  page.onMonthDaysChange({ detail: { value: [] } });
  assert.equal(page.data.repeatOccurrenceText, '0次');
});

test('日历固定日程间隔输入只接受完整数字串，非法输入保留上一合法值', () => {
  const page = loadPlanEditorSheet();
  page.data.repeatGap = '12';

  assert.equal(page.onRepeatGapInput({ detail: { value: '123' } }), '123');
  assert.equal(page.data.repeatGap, '123');
  assert.equal(page.onRepeatGapInput({ detail: { value: '12.3' } }), '123');
  assert.equal(page.onRepeatGapInput({ detail: { value: '-12' } }), '123');
  assert.equal(page.onRepeatGapInput({ detail: { value: '12a' } }), '123');
  assert.equal(page.onRepeatGapInput({ detail: { value: ' 12' } }), '123');
  assert.equal(page.data.repeatGap, '123');

  assert.equal(page.onRepeatGapInput({ detail: { value: '' } }), '');
  assert.equal(page.data.repeatGap, '');
});

test('日历非法间隔输入不会被拼接成另一重复周期后持久化', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  let received;
  global.getApp = () => ({
    globalData: {
      bootstrap: {
        applicationService: {
          createRecurringPlan(input) {
            received = input;
            return {};
          }
        }
      }
    }
  });
  global.wx = { showToast() {} };
  try {
    const page = loadPlanEditorSheet();
    Object.assign(page.data, {
      title: '严格间隔计划',
      startDate: '2026-08-10',
      startTime: '09:00',
      endDate: '2026-08-10',
      endTime: '10:00',
      planFormTasks: [{ id: 'task_repeat', title: '重复任务', optionType: 'task' }],
      hasAnyTasks: true,
      planFormTaskIndex: 0,
      repeatEnabled: true,
      frequencyIndex: 0,
      repeatGap: '2'
    });
    assert.equal(page.onRepeatGapInput({ detail: { value: '2.5' } }), '2');
    page.createPlan();

    assert.equal(received.interval, 3);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('日历新增表单不会沿用刚编辑或取消的计划字段', () => {
  const page = loadPlanEditorSheet();
  Object.assign(page.data, {
    title: '刚编辑过的计划',
    priority: 3,
    repeatEnabled: true,
    frequencyIndex: 2,
    repeatGap: '4',
    repeatWeekdays: [1, 3, 5],
    repeatMonthDays: [1, 15, 31]
  });

  page.resetFromInitialValue();

  assert.equal(page.data.title, '');
  assert.equal(page.data.priority, 1);
  assert.equal(page.data.repeatEnabled, false);
  assert.equal(page.data.frequencyIndex, 0);
  assert.equal(page.data.repeatGap, '0');
  assert.deepEqual(page.data.repeatWeekdays, [new Date().getDay()]);
  assert.deepEqual(page.data.repeatMonthDays, [new Date().getDate()]);
  assert.equal(page.data.repeatOccurrenceText, '一次');
});

test('日历固定日程校验非负间隔数并换算为正整数规则步长', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const received = [];
  const errors = [];
  global.getApp = () => ({
    globalData: {
      bootstrap: {
        applicationService: {
          createRecurringPlan(input) {
            received.push(input);
            return {};
          }
        }
      }
    }
  });
  global.wx = {
    showToast(options) {
      if (options.icon === 'none') errors.push(options.title);
    }
  };
  try {
    const createWithGap = (repeatGap) => {
      const page = loadPlanEditorSheet();
      Object.assign(page.data, {
        title: '重复计划',
        startDate: '2026-08-10',
        startTime: '09:00',
        endDate: '2026-08-10',
        endTime: '10:00',
        planFormTasks: [{ id: 'task_repeat', title: '重复任务', optionType: 'task' }],
        hasAnyTasks: true,
        planFormTaskIndex: 0,
        repeatEnabled: true,
        frequencyIndex: 0,
        repeatGap
      });
      page.createPlan();
    };

    createWithGap('0');
    createWithGap('2');
    createWithGap(String(Number.MAX_SAFE_INTEGER - 1));
    createWithGap(String(Number.MAX_SAFE_INTEGER));
    createWithGap('-1');
    createWithGap('1.5');
    createWithGap('');

    assert.deepEqual(received.map((input) => input.interval), [1, 3, Number.MAX_SAFE_INTEGER]);
    assert.deepEqual(errors, [
      '重复间隔必须是非负整数',
      '重复间隔必须是非负整数',
      '重复间隔必须是非负整数',
      '重复间隔必须是非负整数'
    ]);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('日历每月固定日程提交 monthDays 且不再写入 monthDay', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  let received;
  global.getApp = () => ({
    globalData: {
      bootstrap: {
        applicationService: {
          createRecurringPlan(input) {
            received = input;
            return {};
          }
        }
      }
    }
  });
  global.wx = { showToast() {} };
  try {
    const page = loadPlanEditorSheet();
    Object.assign(page.data, {
      title: '每月复盘',
      startDate: '2026-08-10',
      startTime: '09:00',
      endDate: '2026-08-10',
      endTime: '10:00',
      planFormTasks: [{ id: 'task_repeat', title: '重复任务', optionType: 'task' }],
      hasAnyTasks: true,
      planFormTaskIndex: 0,
      repeatEnabled: true,
      frequencyIndex: 2,
      repeatGap: '0',
      repeatWeekdays: [1, 3],
      repeatMonthDays: [1, 15, 31]
    });
    page.createPlan();

    assert.deepEqual(received.weekdays, []);
    assert.deepEqual(received.monthDays, [1, 15, 31]);
    assert.equal(Object.hasOwn(received, 'monthDay'), false);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('日历从含今天的视图切换粒度后定位当前时间线，不含今天时恢复滚动位置', () => {
  const now = new Date(2026, 7, 14, 17, 20).getTime();
  const mondayThisWeek = new Date(2026, 7, 10).getTime();
  const lastMonth = new Date(2026, 5, 1).getTime();
  const page = loadCalendarPage();
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    let afterRefresh;
    const focusedAt = [];
    let hourFocusCount = 0;
    page.refresh = (callback) => { afterRefresh = callback; };
    page.focusCurrentTime = (timestamp) => focusedAt.push(timestamp);
    page.focusCurrentHour = (timestamp) => {
      hourFocusCount += 1;
      focusedAt.push(['hour', timestamp]);
    };

    page.data.view = 'week';
    page.data.anchor = now;
    page.viewScrollTops = { month: 640, week: 128, day: 320 };
    page.changeView({ currentTarget: { dataset: { view: 'month' } } });
    assert.equal(page.data.view, 'month');
    assert.equal(page.data.calendarScrollTop, 0);
    assert.equal(page.viewScrollTops.month, 0);
    assert.deepEqual(focusedAt, []);
    afterRefresh();
    assert.deepEqual(focusedAt, [now]);

    focusedAt.length = 0;
    page.data.view = 'week';
    page.data.anchor = mondayThisWeek;
    page.viewScrollTops = { day: 640, week: 128 };
    page.changeView({ currentTarget: { dataset: { view: 'day' } } });
    assert.equal(page.data.calendarScrollTop, 640);
    afterRefresh();
    assert.deepEqual(focusedAt, []);

    page.data.view = 'month';
    page.data.anchor = lastMonth;
    page.viewScrollTops = { week: 220, month: 80 };
    page.changeView({ currentTarget: { dataset: { view: 'week' } } });
    assert.equal(page.data.calendarScrollTop, 220);
    afterRefresh();
    assert.deepEqual(focusedAt, []);

    delete page.viewScrollTops.day;
    page.data.view = 'week';
    page.data.anchor = lastMonth;
    page.changeView({ currentTarget: { dataset: { view: 'day' } } });
    assert.equal(page.data.calendarScrollTop, 0);
    afterRefresh();
    assert.equal(hourFocusCount, 1);
    assert.deepEqual(focusedAt, [['hour', now]]);

    const livePage = loadCalendarPage();
    livePage.data.view = 'week';
    livePage.data.anchor = now;
    livePage.viewScrollTops = { month: 640 };
    livePage.refresh = (callback) => { afterRefresh = callback; };
    livePage.changeView({ currentTarget: { dataset: { view: 'month' } } });
    afterRefresh();
    assert.equal(livePage.data.scrollIntoView, 'calendar-time-row-13');
  } finally {
    Date.now = originalNow;
  }
});

test('日历长按年、月、周左列会下钻到对应粒度', () => {
  const now = new Date(2026, 7, 20, 9, 30).getTime();
  const marchStart = new Date(2026, 2, 1).getTime();
  const augustStart = new Date(2026, 7, 1).getTime();
  const dayStart = new Date(2026, 7, 8).getTime();
  const todayStart = new Date(2026, 7, 20).getTime();
  const page = loadCalendarPage();
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    let afterRefresh;
    const focusedAt = [];
    page.refresh = (callback) => { afterRefresh = callback; };
    page.focusCurrentTime = (timestamp) => focusedAt.push(timestamp);
    page.focusCurrentHour = () => focusedAt.push('hour');
    page.cancelPageTurn = () => {};

    page.data.view = 'year';
    page.data.anchor = now;
    page.viewScrollTops = { month: 480, year: 88 };
    page.drillDownFromCoarseLabel({ currentTarget: { dataset: { rowStart: String(marchStart) } } });
    assert.equal(page.data.view, 'year');
    page.onCoarseLabelTouchEnd();
    assert.equal(page.data.view, 'month');
    assert.equal(page.data.anchor, marchStart);
    assert.equal(page.data.calendarScrollTop, 480);
    afterRefresh();
    assert.deepEqual(focusedAt, []);

    focusedAt.length = 0;
    page.data.view = 'year';
    page.data.anchor = now;
    page.viewScrollTops = { month: 480, year: 88 };
    page.drillDownFromCoarseLabel({ currentTarget: { dataset: { rowStart: augustStart } } });
    assert.equal(page.data.view, 'year');
    page.onCoarseLabelTouchEnd();
    assert.equal(page.data.view, 'month');
    assert.equal(page.data.anchor, augustStart);
    assert.equal(page.data.calendarScrollTop, 0);
    afterRefresh();
    assert.deepEqual(focusedAt, [now]);

    focusedAt.length = 0;
    page.data.view = 'month';
    page.data.anchor = now;
    page.viewScrollTops = { day: 240, month: 80 };
    page.drillDownFromCoarseLabel({ currentTarget: { dataset: { rowStart: String(dayStart) } } });
    assert.equal(page.data.view, 'month');
    page.onCoarseLabelTouchEnd();
    assert.equal(page.data.view, 'day');
    assert.equal(page.data.anchor, dayStart);
    assert.equal(page.data.calendarScrollTop, 240);
    afterRefresh();
    assert.deepEqual(focusedAt, []);

    focusedAt.length = 0;
    page.data.view = 'week';
    page.data.anchor = now;
    page.viewScrollTops = { day: 240, week: 64 };
    page.drillDownFromCoarseLabel({ currentTarget: { dataset: { rowStart: String(dayStart) } } });
    assert.equal(page.data.view, 'week');
    page.onCoarseLabelTouchEnd();
    assert.equal(page.data.view, 'day');
    assert.equal(page.data.anchor, dayStart);
    assert.equal(page.data.calendarScrollTop, 240);
    afterRefresh();
    assert.deepEqual(focusedAt, []);

    focusedAt.length = 0;
    page.data.view = 'week';
    page.data.anchor = now;
    page.viewScrollTops = { day: 240, week: 64 };
    page.drillDownFromCoarseLabel({ currentTarget: { dataset: { rowStart: todayStart } } });
    assert.equal(page.data.view, 'week');
    page.onCoarseLabelTouchEnd();
    assert.equal(page.data.view, 'day');
    assert.equal(page.data.anchor, todayStart);
    assert.equal(page.data.calendarScrollTop, 0);
    afterRefresh();
    assert.deepEqual(focusedAt, [now]);
  } finally {
    Date.now = originalNow;
  }
});

test('日历点击今天会在刷新完成后定位各粒度的当前时间行', () => {
  const now = new Date(2026, 7, 14, 17, 20).getTime();
  const page = loadCalendarPage();
  const targets = {
    year: 'calendar-time-row-7',
    month: 'calendar-time-row-13',
    week: 'calendar-time-row-4',
    day: 'calendar-time-row-16'
  };

  Object.entries(targets).forEach(([view, target]) => {
    page.data.view = view;
    page.data.anchor = now;
    page.data.scrollIntoView = 'old-target';
    page.focusCurrentTime(now);
    assert.equal(page.data.scrollIntoView, target);
  });

  page.data.view = 'month';
  page.data.anchor = new Date(2026, 5, 1).getTime();
  page.viewScrollTops = { month: 640 };
  let afterRefresh;
  const focusedAt = [];
  page.refresh = (callback) => { afterRefresh = callback; };
  page.focusCurrentTime = (timestamp) => focusedAt.push(timestamp);
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    page.goToday();
    assert.equal(page.data.anchor, now);
    assert.equal(page.data.calendarScrollTop, 0);
    assert.equal(page.viewScrollTops.month, 0);
    assert.deepEqual(focusedAt, []);
    assert.equal(typeof afterRefresh, 'function');
    afterRefresh();
    assert.deepEqual(focusedAt, [now]);
  } finally {
    Date.now = originalNow;
  }
});

test('日历画布以首次有效移动锁定手势方向', () => {
  const page = loadCalendarPage();
  const offsets = [];
  page.animateRangeChange = (offset) => offsets.push(offset);

  page.onCanvasTouchStart({ touches: [{ clientX: 0, clientY: 0 }] });
  page.onCanvasTouchMove({ touches: [{ clientX: 4, clientY: 20 }] });
  page.onCanvasTouchEnd({ changedTouches: [{ clientX: 100, clientY: 24 }] });
  assert.deepEqual(offsets, []);

  page.onCanvasTouchStart({ touches: [{ clientX: 0, clientY: 0 }] });
  page.onCanvasTouchMove({ touches: [{ clientX: 20, clientY: 4 }] });
  page.onCanvasTouchEnd({ changedTouches: [{ clientX: 60, clientY: 80 }] });
  assert.deepEqual(offsets, [-1]);

  const wxml = fs.readFileSync(calendarWxmlPath, 'utf8');
  assert.match(wxml, /bindtouchmove="onCanvasTouchMove"/);
});

test('日历重复实例删除本次及后续仅在确认后调用服务并刷新', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const calls = [];
  const toasts = [];
  let modalOptions;
  const service = {
    deleteRuleFollowing(...args) { calls.push(['deleteRuleFollowing', ...args]); }
  };
  global.getApp = () => ({ globalData: { bootstrap: { applicationService: service } } });
  global.wx = {
    showModal(options) { modalOptions = options; },
    showToast(options) { toasts.push(options); }
  };
  try {
    const page = loadCalendarPage();
    const item = { ruleId: 'rule_1', occurrenceStart: 123 };
    let refreshCount = 0;
    page.data.detailItem = item;
    page.refresh = () => { refreshCount += 1; };

    page.deleteRuleFollowing({ currentTarget: { dataset: { item } } });
    assert.deepEqual(modalOptions, {
      title: '删除本次及后续',
      content: '将删除本次及之后的固定日程。已有时间记录会保留，但会解除计划关联。',
      confirmText: '删除',
      confirmColor: '#9a5550',
      success: modalOptions.success
    });
    modalOptions.success({ confirm: false });
    assert.deepEqual(calls, []);
    assert.equal(page.data.detailItem, item);
    assert.deepEqual(toasts, []);
    assert.equal(refreshCount, 0);

    modalOptions.success({ confirm: true });
    assert.deepEqual(calls, [['deleteRuleFollowing', 'rule_1', 123, true]]);
    assert.equal(page.data.detailItem, null);
    assert.equal(toasts.at(-1).title, '本次及后续已删除');
    assert.equal(refreshCount, 1);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('日历重复实例删除本次及后续失败时保留详情且显示错误', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  let modalOptions;
  const toasts = [];
  const error = new Error('删除失败');
  global.getApp = () => ({ globalData: { bootstrap: { applicationService: {
    deleteRuleFollowing() { throw error; }
  } } } });
  global.wx = {
    showModal(options) { modalOptions = options; },
    showToast(options) { toasts.push(options); }
  };
  try {
    const page = loadCalendarPage();
    const item = { ruleId: 'rule_1', occurrenceStart: 123 };
    page.data.detailItem = item;
    page.refresh = () => { throw new Error('不应刷新'); };

    page.deleteRuleFollowing({ currentTarget: { dataset: { item } } });
    modalOptions.success({ confirm: true });

    assert.equal(page.data.detailItem, item);
    assert.deepEqual(toasts, [{ title: '删除失败', icon: 'none', duration: 3000 }]);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('日历横向切换在动画中点更新日期并在结束后解除动画锁', () => {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const scheduled = [];
  global.setTimeout = (callback, delay) => {
    scheduled.push({ callback, delay });
    return scheduled.length;
  };
  global.clearTimeout = () => {};
  try {
    const page = loadCalendarPage();
    page.data.view = 'day';
    page.data.anchor = new Date(2026, 7, 8, 12, 0).getTime();
    let refreshCount = 0;
    page.refresh = () => { refreshCount += 1; };

    page.animateRangeChange(1);
    assert.equal(page.data.pageTurnClass, 'page-turn-next');
    assert.deepEqual(scheduled.map((item) => item.delay), [140, 280]);

    scheduled[0].callback();
    assert.equal(new Date(page.data.anchor).getDate(), 9);
    assert.equal(refreshCount, 1);

    scheduled[1].callback();
    assert.equal(page.data.pageTurnClass, '');
    assert.equal(page.pageTurnEndTimer, null);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test('日历当前时间线与今天范围状态可随本地时间刷新', () => {
  const page = loadCalendarPage();
  page.data.view = 'day';
  page.data.anchor = new Date(2026, 7, 8, 12, 0).getTime();
  page.data.currentTimeLineStyle = '';
  page.data.rangeIncludesToday = false;

  page.refreshCurrentTimeLine(new Date(2026, 7, 8, 8, 30).getTime());
  assert.equal(page.data.currentTimeLineStyle, 'top: 748.00rpx;');
  assert.equal(page.data.rangeIncludesToday, true);

  page.refreshCurrentTimeLine(new Date(2026, 7, 9, 8, 30).getTime());
  assert.equal(page.data.currentTimeLineStyle, '');
  assert.equal(page.data.rangeIncludesToday, false);
});

test('日历粗粒度当前时间线刷新只更新轻量定位状态', () => {
  const page = loadCalendarPage();
  page.data.view = 'month';
  page.data.anchor = new Date(2026, 7, 8, 12, 0).getTime();
  page.data.timeRows = Array.from({ length: 31 }, (_, index) => ({
    index,
    blocks: [{ id: `block_${index}`, title: '测试块' }]
  }));
  const originalTimeRows = page.data.timeRows;
  let updates;
  page.setData = (next) => {
    updates = next;
    Object.assign(page.data, next);
  };

  page.refreshCurrentTimeLine(new Date(2026, 7, 8, 8, 30).getTime());

  assert.equal(page.data.currentTimeLineRowIndex, 7);
  assert.equal(page.data.currentTimeLineStyle, 'top: 35.42%;');
  assert.strictEqual(page.data.timeRows, originalTimeRows);
  assert.equal(Object.hasOwn(updates, 'timeRows'), false);
  assert.deepEqual(Object.keys(updates).sort(), [
    'currentTimeLineRowIndex',
    'currentTimeLineStyle',
    'rangeIncludesToday'
  ]);
});

test('日历计划块按资料库任务状态显示关联入口，日志编辑只选择标签和计划块', () => {
  const script = fs.readFileSync(calendarScriptPath, 'utf8');
  const wxml = fs.readFileSync(calendarWxmlPath, 'utf8');
  const wxss = fs.readFileSync(calendarWxssPath, 'utf8');
  const componentScript = fs.readFileSync(planEditorComponentPath, 'utf8');
  const componentWxml = fs.readFileSync(planEditorWxmlPath, 'utf8');
  const componentWxss = fs.readFileSync(planEditorWxssPath, 'utf8');
  assert.match(componentWxml, /任务（必选）/);
  assert.match(componentWxml, /show-confirm="\{\{true\}\}"/);
  assert.match(componentWxml, /variant === 'calendar' && \(planEditor \|\| hasAnyTasks\)[^>]*task-picker-trigger[^>]*bindtap="openTaskPicker"/);
  assert.match(script, /title: '新建同名任务'/);
  assert.match(componentWxml, /task-option-create/);
  assert.match(componentWxml, /<sheet-header title="选择任务"[\s\S]*<scroll-view class="task-option-list" scroll-y="\{\{true\}\}" enable-flex="\{\{true\}\}" style="height: \{\{taskPickerListHeight\}\}rpx;"/);
  assert.match(componentWxss, /\.task-picker-modal\s*\{[^}]*max-height:\s*72vh;[^}]*overflow:\s*hidden;/s);
  assert.match(componentWxss, /\.task-option-list\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*overflow:\s*hidden;/s);
  assert.match(componentScript, /TASK_PICKER_MAX_LIST_HEIGHT_RPX\s*=\s*600/);
  assert.doesNotMatch(componentWxml, /<picker wx:if="\{\{hasAnyTasks\}\}"[^>]*data-key="taskIndex"/);
  assert.doesNotMatch(componentWxml, /请先在“计划”页创建一个未完成任务/);
  assert.match(componentWxml, /项目归属（由任务决定）/);
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
  const component = loadPlanEditorSheet();
  component.data.planFormTasks = [{ id: '', title: '请选择任务' }].concat(
    Array.from({ length: 8 }, (_, index) => ({ id: `task-${index}`, title: `任务 ${index}` }))
  );
  component.openTaskPicker();
  assert.equal(component.data.taskPickerListHeight, 600);
  component.data.planFormTasks = component.data.planFormTasks.slice(0, 3);
  component.openTaskPicker();
  assert.equal(component.data.taskPickerListHeight, 204);
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
  const page = loadPlanEditorSheet();
  const emoji = '🙂';
  page.onTitleField({ currentTarget: { dataset: { key: 'title' } }, detail: { value: emoji.repeat(26) } });
  assert.equal(page.data.title, emoji.repeat(25));

  const wxml = fs.readFileSync(planEditorWxmlPath, 'utf8');
  for (const key of ['title']) {
    assert.match(wxml, new RegExp(`maxlength="-1"[^>]*data-key="${key}"[^>]*bindinput="onTitleField"`));
  }
});

test('日历新增计划的开始结束时间复用计划页标签、日期和时间三列布局', () => {
  const wxml = fs.readFileSync(planEditorWxmlPath, 'utf8');
  const wxss = fs.readFileSync(planEditorWxssPath, 'utf8');
  assert.match(wxml, /class="plan-time-label">开始时间<\/view>/);
  assert.match(wxml, /class="plan-time-label">结束时间<\/view>/);
  assert.equal((wxml.match(/class="plan-time-picker plan-time-date"/g) || []).length, 2);
  assert.equal((wxml.match(/class="plan-time-picker plan-time-clock"/g) || []).length, 2);
  assert.match(wxss, /\.plan-time-label\s*\{[^}]*flex:\s*0 0 112rpx;[^}]*font-size:\s*26rpx;/s);
  assert.match(wxss, /\.plan-time-date\s*\{[^}]*flex:\s*1;[^}]*min-width:\s*0;/s);
  assert.match(wxss, /\.plan-time-clock\s*\{[^}]*flex:\s*0 0 180rpx;/s);
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
    const page = loadPlanEditorSheet();
    Object.assign(page.data, {
      title: '写评审',
      startDate: '2026-07-30',
      startTime: '09:00',
      endDate: '2026-07-30',
      endTime: '10:00',
      planFormTasks: [{ id: 'task_review', title: '评审任务' }],
      hasAnyTasks: true,
      planFormTaskIndex: 0,
      repeatEnabled: false
    });
    page.createPlan();
    assert.equal(received.taskId, 'task_review');
    assert.equal(Object.prototype.hasOwnProperty.call(received, 'projectId'), false);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('日历在资料库完全无任务时通过原子入口创建同名 TODO 与计划', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const received = [];
  global.getApp = () => ({
    globalData: {
      bootstrap: {
        applicationService: {
          createCalendarEventWithNewTask(input) { received.push({ type: 'event', input }); },
          createRecurringPlanWithNewTask(input) { received.push({ type: 'repeat', input }); }
        }
      }
    }
  });
  global.wx = { showToast() {} };
  try {
    const base = {
      title: '自动生成 TODO',
      startDate: '2026-07-30',
      startTime: '09:00',
      endDate: '2026-07-30',
      endTime: '10:00',
      planFormTasks: [{ id: '', title: '请选择任务' }],
      hasAnyTasks: false,
      hasTaskOptions: false,
      planFormTaskIndex: 0
    };
    const eventPage = loadPlanEditorSheet();
    Object.assign(eventPage.data, base, { repeatEnabled: false });
    eventPage.createPlan();

    const repeatPage = loadPlanEditorSheet();
    Object.assign(repeatPage.data, base, { repeatEnabled: true, frequencyIndex: 0 });
    repeatPage.createPlan();

    assert.equal(received[0].type, 'event');
    assert.equal(received[1].type, 'repeat');
    assert.equal(received[0].input.title, '自动生成 TODO');
    assert.equal(Object.prototype.hasOwnProperty.call(received[0].input, 'taskId'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(received[1].input, 'taskId'), false);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('日历已有任务时选择新建同名任务走原子入口', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const received = [];
  global.getApp = () => ({
    globalData: {
      bootstrap: {
        applicationService: {
          createCalendarEventWithNewTask(input) { received.push({ type: 'event', input }); },
          createRecurringPlanWithNewTask(input) { received.push({ type: 'repeat', input }); }
        }
      }
    }
  });
  global.wx = { showToast() {} };
  try {
    const base = {
      title: '选择后新建 TODO',
      startDate: '2026-07-30',
      startTime: '09:00',
      endDate: '2026-07-30',
      endTime: '10:00',
      planFormTasks: [
        { id: '', title: '请选择任务' },
        { id: '__create_same_title_task__', title: '新建同名任务', optionType: 'create' },
        { id: 'task_existing', title: '已有任务', optionType: 'task' }
      ],
      hasAnyTasks: true,
      planFormTaskIndex: 1
    };
    const eventPage = loadPlanEditorSheet();
    Object.assign(eventPage.data, base, { repeatEnabled: false });
    eventPage.createPlan();

    const repeatPage = loadPlanEditorSheet();
    Object.assign(repeatPage.data, base, { repeatEnabled: true, frequencyIndex: 0 });
    repeatPage.createPlan();

    assert.deepEqual(received.map((item) => item.type), ['event', 'repeat']);
    assert.equal(Object.prototype.hasOwnProperty.call(received[0].input, 'taskId'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(received[1].input, 'taskId'), false);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('日历创建固定日程后使用服务返回的首次投影定位', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const createdOccurrence = {
    id: 'rule_created:1:1786202400000',
    virtual: true,
    ruleId: 'rule_created',
    startedAt: new Date(2026, 7, 8, 18, 0).getTime(),
    endedAt: new Date(2026, 7, 8, 19, 0).getTime()
  };
  global.getApp = () => ({
    globalData: {
      bootstrap: {
        applicationService: {
          createRecurringPlan() { return { rule: { id: 'rule_created' }, occurrence: createdOccurrence }; }
        }
      }
    }
  });
  global.wx = { showToast() {} };
  try {
    const component = loadPlanEditorSheet();
    Object.assign(component.data, {
      title: '定位新计划',
      startDate: '2026-08-08',
      startTime: '18:00',
      endDate: '2026-08-08',
      endTime: '19:00',
      planFormTasks: [{ id: 'task_existing', title: '已有任务', optionType: 'task' }],
      hasAnyTasks: true,
      planFormTaskIndex: 0,
      repeatEnabled: true,
      frequencyIndex: 0,
      repeatWeekdays: []
    });
    component.createPlan();
    const success = component.events.find((event) => event.name === 'success').detail;
    assert.equal(success.revealTarget, createdOccurrence);

    const page = loadCalendarPage();
    page.data.isCreateOpen = true;
    let revealed;
    page.revealCreatedPlan = (event) => { revealed = event; };
    page.onPlanEditorSuccess({ detail: success });
    assert.equal(revealed, createdOccurrence);
    assert.equal(page.data.isCreateOpen, false);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('日历以新建同名任务创建普通计划后使用返回的 event 定位', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const createdEvent = {
    id: 'event_created_with_task',
    startedAt: new Date(2026, 7, 8, 18, 0).getTime(),
    endedAt: new Date(2026, 7, 8, 19, 0).getTime()
  };
  global.getApp = () => ({
    globalData: {
      bootstrap: {
        applicationService: {
          createCalendarEventWithNewTask() {
            return { task: { id: 'task_created' }, event: createdEvent };
          }
        }
      }
    }
  });
  global.wx = { showToast() {} };
  try {
    const component = loadPlanEditorSheet();
    Object.assign(component.data, {
      title: '定位普通计划',
      startDate: '2026-08-08',
      startTime: '18:00',
      endDate: '2026-08-08',
      endTime: '19:00',
      planFormTasks: [{ id: '', title: '请选择任务' }],
      hasAnyTasks: false,
      planFormTaskIndex: 0,
      repeatEnabled: false
    });
    component.createPlan();
    const success = component.events.find((event) => event.name === 'success').detail;
    assert.equal(success.revealTarget, createdEvent);

    const page = loadCalendarPage();
    page.data.isCreateOpen = true;
    let revealed;
    page.revealCreatedPlan = (event) => { revealed = event; };
    page.onPlanEditorSuccess({ detail: success });
    assert.equal(revealed, createdEvent);
    assert.equal(page.data.isCreateOpen, false);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('日历创建范围外计划时切换锚点，范围内计划保留当前范围', () => {
  const originalWx = global.wx;
  global.wx = {};
  try {
    const page = loadCalendarPage();
    page.data.view = 'day';
    page.data.anchor = new Date(2026, 7, 8, 12, 0).getTime();
    page.data.calendarScrollTop = 160;
    page.currentCalendarScrollTop = 160;
    page.viewScrollTops = { day: 160 };
    const revealedIds = [];
    let refreshCount = 0;
    const layoutOptions = [];
    page.refresh = (callback, options) => {
      refreshCount += 1;
      layoutOptions.push(options);
      if (callback) callback();
    };
    page.scrollCreatedPlanIntoView = (id) => { revealedIds.push(id); };

    page.revealCreatedPlan({
      id: 'event_same_day',
      startedAt: new Date(2026, 7, 8, 18, 0).getTime(),
      endedAt: new Date(2026, 7, 8, 19, 0).getTime()
    });
    assert.equal(page.data.calendarScrollTop, 160);
    assert.equal(new Date(page.data.anchor).getDate(), 8);

    page.revealCreatedPlan({
      id: 'event_next_day',
      startedAt: new Date(2026, 7, 9, 9, 0).getTime(),
      endedAt: new Date(2026, 7, 9, 10, 0).getTime()
    });
    assert.equal(page.data.calendarScrollTop, 0);
    assert.equal(page.currentCalendarScrollTop, 0);
    assert.equal(new Date(page.data.anchor).getDate(), 9);
    assert.equal(refreshCount, 2);
    assert.deepEqual(revealedIds, ['event_same_day', 'event_next_day']);
    assert.deepEqual(layoutOptions, [
      { protectedItemId: 'event_same_day' },
      { protectedItemId: 'event_next_day' }
    ]);
  } finally {
    global.wx = originalWx;
  }
});

test('日历只在新建计划块不完整可见时平滑滚动到其附近', () => {
  const originalWx = global.wx;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const selectors = [];
  const scheduled = [];
  let rects = [];
  global.setTimeout = (callback, delay) => {
    scheduled.push({ callback, delay });
    return scheduled.length;
  };
  global.clearTimeout = () => {};
  global.wx = {
    createSelectorQuery() {
      return {
        select(selector) {
          selectors.push(selector);
          return this;
        },
        boundingClientRect() { return this; },
        exec(callback) { callback(rects); }
      };
    }
  };
  try {
    const page = loadCalendarPage();
    page.data.view = 'day';
    page.data.calendarScrollTop = 120;
    page.currentCalendarScrollTop = 120;
    page.viewScrollTops = { day: 120 };

    rects = [
      { top: 100, bottom: 500, height: 400 },
      { top: 200, bottom: 254, height: 54 }
    ];
    page.scrollCreatedPlanIntoView('event_visible');
    assert.equal(page.data.calendarScrollTop, 120);

    rects = [
      { top: 100, bottom: 500, height: 400 },
      { top: 600, bottom: 654, height: 54 }
    ];
    page.scrollCreatedPlanIntoView('event_hidden');
    assert.equal(page.data.calendarScrollTop, 447);
    assert.equal(page.data.calendarScrollWithAnimation, true);
    assert.equal(page.data.scrollIntoView, 'calendar-block-event_hidden');
    assert.equal(page.currentCalendarScrollTop, 447);
    assert.equal(page.viewScrollTops.day, 447);
    assert.deepEqual(scheduled.map((item) => item.delay), [360, 360]);
    assert.deepEqual(selectors, [
      '.calendar-scroll',
      '#calendar-block-event_visible',
      '.calendar-scroll',
      '#calendar-block-event_hidden'
    ]);

    const wxml = fs.readFileSync(calendarWxmlPath, 'utf8');
    assert.match(wxml, /scroll-with-animation="\{\{calendarScrollWithAnimation\}\}"/);
    assert.match(wxml, /id="\{\{item\.domId\}\}"/);
  } finally {
    global.wx = originalWx;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test('日历新计划节点暂未完成渲染时等节点出现后再定位，不把滚动锁到缺失 ID', () => {
  const originalWx = global.wx;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const scheduled = [];
  let rects = [{ top: 100, bottom: 500, height: 400 }, null];
  global.setTimeout = (callback, delay) => {
    scheduled.push({ callback, delay });
    return scheduled.length;
  };
  global.clearTimeout = () => {};
  global.wx = {
    createSelectorQuery() {
      return {
        select() { return this; },
        boundingClientRect() { return this; },
        exec(callback) { callback(rects); }
      };
    }
  };
  try {
    const page = loadCalendarPage();
    page.data.calendarScrollTop = 120;
    page.currentCalendarScrollTop = 120;
    page.scrollCreatedPlanIntoView('event_rendering');

    assert.equal(page.data.scrollIntoView, '');
    assert.equal(page.data.calendarScrollWithAnimation, false);
    assert.equal(page.data.calendarScrollTop, 120);
    assert.deepEqual(scheduled.map((item) => item.delay), [360]);

    rects = [
      { top: 100, bottom: 500, height: 400 },
      { top: 600, bottom: 654, height: 54 }
    ];
    scheduled[0].callback();
    assert.equal(page.data.scrollIntoView, 'calendar-block-event_rendering');
    assert.equal(page.data.calendarScrollWithAnimation, true);
  } finally {
    global.wx = originalWx;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test('计划页跳转已有计划时范围内不重置滚动，并保护目标不被折进+N', () => {
  const originalWx = global.wx;
  global.wx = {};
  let page;
  try {
    page = loadCalendarPage();
    page.data.view = 'day';
    page.data.anchor = new Date(2026, 7, 8, 12, 0).getTime();
    page.data.calendarScrollTop = 160;
    page.currentCalendarScrollTop = 160;
    page.viewScrollTops = { day: 160 };
    page.data.timelineFilter = 'all';
    const layoutOptions = [];
    const revealedIds = [];
    page.refresh = (callback, options) => {
      layoutOptions.push(options);
      if (callback) callback();
    };
    page.scrollCreatedPlanIntoView = (id) => { revealedIds.push(id); };

    page.applyRevealPlanHandoff({
      type: 'reveal-plan',
      id: 'event_visible',
      startedAt: new Date(2026, 7, 8, 18, 0).getTime(),
      endedAt: new Date(2026, 7, 8, 19, 0).getTime()
    });

    assert.equal(page.data.view, 'day');
    assert.equal(page.data.calendarScrollTop, 160);
    assert.equal(page.currentCalendarScrollTop, 160);
    assert.equal(page.data.highlightedPlanId, 'event_visible');
    assert.deepEqual(revealedIds, ['event_visible']);
    assert.deepEqual(layoutOptions, [{ protectedItemId: 'event_visible' }]);
    assert.equal(Object.prototype.hasOwnProperty.call(page.data, 'handoffGestureLock'), false);
  } finally {
    global.wx = originalWx;
    if (page) {
      clearTimeout(page.handoffHighlightTimer);
    }
  }
});

test('日历接收计划页长按跳转时不创建覆盖点击与横滑的全屏手势层', () => {
  const originalWx = global.wx;
  global.wx = {};
  let page;
  try {
    page = loadCalendarPage();
    page.refresh = (callback) => { if (callback) callback(); };
    page.scrollCreatedPlanIntoView = () => {};

    page.applyRevealPlanHandoff({
      type: 'reveal-plan',
      id: 'event_visible',
      startedAt: new Date(2026, 7, 8, 18, 0).getTime(),
      endedAt: new Date(2026, 7, 8, 19, 0).getTime(),
      swallowPendingTouch: true
    });

    assert.equal(Object.prototype.hasOwnProperty.call(page.data, 'handoffGestureLock'), false);

    const wxml = fs.readFileSync(calendarWxmlPath, 'utf8');
    const wxss = fs.readFileSync(calendarWxssPath, 'utf8');
    assert.doesNotMatch(wxml, /handoff-gesture-lock|onHandoffGestureLockTouch|releaseHandoffGestureLock/);
    assert.doesNotMatch(wxss, /\.handoff-gesture-lock/);
  } finally {
    global.wx = originalWx;
  }
});

test('日历只有已完成任务时仍提供新建同名任务且不混入编辑任务选项', () => {
  const originalGetApp = global.getApp;
  global.getApp = () => ({
    globalData: {
      bootstrap: {
        applicationService: {
          snapshot() {
            return {
              projects: [],
              tasks: [{ id: 'task_completed', title: '已完成任务', status: 'completed' }],
              calendarEvents: []
            };
          },
          timeline() { return []; }
        }
      }
    }
  });
  try {
    const page = loadCalendarPage();
    page.refresh();
    assert.equal(page.data.hasAnyTasks, true);
    assert.equal(page.data.hasTaskOptions, false);
    assert.deepEqual(
      page.data.tasks.map((item) => item.optionType || 'placeholder'),
      ['placeholder', 'create']
    );
    assert.deepEqual(page.data.planTasks.map((item) => item.id), ['']);
  } finally {
    global.getApp = originalGetApp;
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
    assert.equal(
      page.data.tasks.find((item) => item.id === 'task_plan').derivedProjectName,
      '重命名后的项目'
    );
  } finally {
    global.getApp = originalGetApp;
  }
});

test('日历只在重叠条目的详情层显示低干扰的实际与候选计数', () => {
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
    page.data.anchor = timeline[0].startedAt;
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
    assert.equal(itemById.get('virtual_plan').canConfirmVirtual, true);

    const wxml = fs.readFileSync(calendarWxmlPath, 'utf8');
    const wxss = fs.readFileSync(calendarWxssPath, 'utf8');
    assert.match(wxml, /item\.overlapMeta[^}]*is-overlapping/);
    assert.match(wxml, /wx:if="\{\{detailItem\.displayOverlap\}\}"[^>]*detail-overlap/);
    assert.match(wxss, /\.calendar-block\.is-overlapping\s*\{[^}]*box-shadow:/s);
    assert.doesNotMatch(wxss, /\.calendar-block\.is-overlapping\s*\{[^}]*border-left:/s);
  } finally {
    global.getApp = originalGetApp;
  }
});

test('日历对正在计时的重复实例隐藏确认完成，并在刷新时更新已打开详情', () => {
  const originalGetApp = global.getApp;
  const startedAt = 1_700_000_100_000;
  const originOccurrenceId = 'rule_repeat:1:1700000100000';
  const otherOccurrenceId = 'rule_repeat:1:1700086500000';
  const snapshot = {
    projects: [],
    tasks: [{ id: 'task_repeat', title: '循环任务', status: 'todo' }],
    calendarEvents: [],
    timer: {
      status: 'running',
      draft: {
        originRuleId: 'rule_repeat',
        originOccurrenceId
      }
    }
  };
  const timeline = [{
    id: 'virtual_timing',
    type: 'plan',
    virtual: true,
    title: '正在计时的实例',
    ruleId: 'rule_repeat',
    originOccurrenceId,
    startedAt,
    endedAt: startedAt + 60_000,
    taskId: 'task_repeat'
  }, {
    id: 'virtual_other',
    type: 'plan',
    virtual: true,
    title: '其他实例',
    ruleId: 'rule_repeat',
    originOccurrenceId: otherOccurrenceId,
    startedAt: startedAt + 2 * 60 * 60 * 1000,
    endedAt: startedAt + 2 * 60 * 60 * 1000 + 60_000,
    taskId: 'task_repeat'
  }];
  global.getApp = () => ({
    globalData: { bootstrap: { applicationService: {
      snapshot() { return snapshot; },
      timeline() { return timeline; }
    } } }
  });
  try {
    const page = loadCalendarPage();
    page.data.anchor = startedAt;
    page.data.view = 'day';
    page.refresh();
    const itemById = new Map(page.data.timeline.map((item) => [item.id, item]));
    assert.equal(itemById.get('virtual_timing').canConfirmVirtual, false);
    assert.equal(itemById.get('virtual_other').canConfirmVirtual, true);

    page.setData({
      detailItem: {
        ...itemById.get('virtual_timing'),
        canConfirmVirtual: true
      }
    });
    page.refresh();
    assert.equal(page.data.detailItem.canConfirmVirtual, false);
    assert.equal(page.data.detailItem.originOccurrenceId, originOccurrenceId);

    const wxml = fs.readFileSync(calendarWxmlPath, 'utf8');
    assert.match(
      wxml,
      /detailItem\.virtual && detailItem\.canConfirmVirtual[^>]*bindtap="confirmItem">确认完成/
    );
  } finally {
    global.getApp = originalGetApp;
  }
});

test('日历编辑尚未结束的失效任务计划时预填原值并可补绑任务，历史失效计划保持只读', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const now = Math.floor(Date.now() / 60_000) * 60_000;
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
    endedAt: now + 2 * 60 * 60 * 1_000,
    priority: 3
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
    const repairablePlan = itemById.get('event_repairable');

    assert.equal(itemById.get('event_valid_history').canAssociate, true);
    assert.equal(itemById.get('event_valid_history').canEditPlan, true);
    assert.equal(itemById.get('event_repairable').canAssociate, false);
    assert.equal(itemById.get('event_repairable').canEditPlan, true);
    assert.equal(itemById.get('event_read_only').canAssociate, false);
    assert.equal(itemById.get('event_read_only').canEditPlan, false);
    assert.equal(itemById.get('rule_taskless:1:123').canEditPlan, false);

    page.openPlanEditor({
      currentTarget: { dataset: { item: repairablePlan } }
    });
    assert.equal(page.data.isCreateOpen, true);
    assert.equal(page.data.planEditorInitialValue.plan.title, repairablePlan.title);
    assert.equal(page.data.planEditorInitialValue.taskIndex, 0);
    assert.equal(page.data.planEditorInitialValue.taskOptions[0].title, '请选择任务');
    assert.equal(page.data.planEditorInitialValue.taskOptions.some((item) => item.optionType === 'create'), false);

    const component = loadPlanEditorSheet({
      mode: 'edit',
      initialValue: page.data.planEditorInitialValue
    });
    component.savePlanEditor();
    assert.equal(updates.length, 0);
    assert.equal(toasts.at(-1).title, '请选择任务');

    component.data.planFormTasks.push({ id: 'task_missing', title: '已失效任务' });
    component.data.planFormTaskIndex = component.data.planFormTasks.length - 1;
    component.savePlanEditor();
    assert.equal(updates.length, 0);
    assert.equal(toasts.at(-1).title, '请选择任务');

    component.data.planFormTaskIndex = component.data.planFormTasks.findIndex((item) => item.id === 'task_live');
    component.savePlanEditor();
    assert.equal(updates.length, 1);
    assert.equal(updates[0].id, 'event_repairable');
    assert.equal(updates[0].input.taskId, 'task_live');
    assert.equal(updates[0].input.title, repairablePlan.title);
    assert.equal(updates[0].input.startedAt, repairablePlan.startedAt);
    assert.equal(updates[0].input.endedAt, repairablePlan.endedAt);
    assert.equal(updates[0].input.priority, repairablePlan.priority);
    assert.equal(component.events.at(-1).detail.operation, 'update-event');
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('日历可从具体或虚拟计划块开始计时，并使用对应联合关联', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const associations = [];
  const toasts = [];
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
    showToast(options) { toasts.push(options); },
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
    assert.equal(toasts.length, 0);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('日历确认虚拟实例或候选日志后会更新最近记录的 new 标记', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const stored = new Map();
  const preferences = new LocalPreferenceStore({
    has: (key) => stored.has(key),
    get: (key) => (stored.has(key) ? structuredClone(stored.get(key)) : ''),
    set: (key, value) => stored.set(key, structuredClone(value)),
    remove: (key) => stored.delete(key)
  });
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
  const toasts = [];
  global.getApp = () => ({ globalData: { bootstrap: { applicationService: service, preferences } } });
  global.wx = {
    showToast(options) { toasts.push(options); },
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
      version: 1,
      profileId: 'profile_calendar',
      value: { logId: 'confirmed_virtual' }
    });

    page.confirmItem({ currentTarget: { dataset: { item: { id: 'candidate_log', virtual: false } } } });
    assert.deepEqual(calls.map(([type]) => type), ['virtual', 'candidate']);
    assert.deepEqual(toasts.map((item) => item.title), ['固定日程已完成', '候选记录已确认']);
    assert.deepEqual(stored.get('plan-and-record.recent-log-highlight'), {
      version: 1,
      profileId: 'profile_calendar',
      value: { logId: 'confirmed_candidate' }
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
