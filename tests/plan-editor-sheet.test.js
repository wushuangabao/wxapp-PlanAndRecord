const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const componentPath = require.resolve('../miniprogram/components/plan-editor-sheet/index.js');
const componentWxmlPath = path.join(__dirname, '../miniprogram/components/plan-editor-sheet/index.wxml');
const componentWxssPath = path.join(__dirname, '../miniprogram/components/plan-editor-sheet/index.wxss');

function loadDefinition() {
  const originalComponent = global.Component;
  let definition;
  global.Component = (value) => { definition = value; };
  delete require.cache[componentPath];
  require(componentPath);
  global.Component = originalComponent;
  return definition;
}

function openSheet(properties) {
  const definition = loadDefinition();
  const events = [];
  const component = {
    data: { ...definition.data },
    properties: { visible: false, variant: 'calendar', mode: 'create', initialValue: null, ...properties },
    setData(updates, callback) {
      Object.assign(this.data, updates);
      if (callback) callback();
    },
    triggerEvent(name, detail) { events.push({ name, detail }); }
  };
  Object.entries(definition.methods || {}).forEach(([name, method]) => {
    component[name] = method.bind(component);
  });
  definition.observers.visible.call(component, true);
  return { component, events };
}

function withService(service, callback) {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const toasts = [];
  global.getApp = () => ({ globalData: { bootstrap: { applicationService: service } } });
  global.wx = { showToast(options) { toasts.push(options); } };
  try {
    return callback(toasts);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
}

function createInitialValue(overrides = {}) {
  return {
    title: '计划',
    anchorDate: new Date(2026, 7, 12, 12).getTime(),
    priority: 1,
    hasAnyTasks: false,
    taskOptions: [{ id: '', title: '请选择任务' }],
    taskIndex: 0,
    newTaskProjectId: null,
    ...overrides
  };
}

test('iOS：日历计划弹窗不脱离页面，输入框使用默认原生避让', () => {
  const wxml = fs.readFileSync(componentWxmlPath, 'utf8');
  const wxss = fs.readFileSync(componentWxssPath, 'utf8');
  const definition = loadDefinition();
  const inputs = wxml.match(/<input\b[^>]*\/>/g) || [];
  const rootPortals = wxml.match(/<root-portal\b[^>]*>/g) || [];

  assert.equal(inputs.length, 2);
  assert.equal(rootPortals.length, 1);
  assert.match(rootPortals[0], /wx:if="\{\{visible\}\}"/);
  assert.match(rootPortals[0], /enable="\{\{variant === 'plans-todo'\}\}"/);
  assert.match(
    wxml,
    /<root-portal\b[^>]*>[\s\S]*class="modal-mask"[\s\S]*class="modal-mask task-picker-mask"[\s\S]*<\/root-portal>/
  );
  assert.equal(definition.options.virtualHost, true);
  assert.equal(definition.data.keyboardHeight, undefined);
  assert.equal(definition.methods.onKeyboardHeightChange, undefined);
  inputs.forEach((input) => {
    assert.doesNotMatch(input, /always-embed|adjust-position|bindfocus|bindblur/);
  });
  assert.equal(definition.methods.onEditorInputFocus, undefined);
  assert.equal(definition.methods.onEditorInputBlur, undefined);
  assert.doesNotMatch(wxml, /keyboardHeight|bindkeyboardheightchange/);
  assert.doesNotMatch(wxss, /modal-keyboard-viewport/);
  assert.match(wxss, /\.create-modal\s*\{[^}]*max-height:\s*88vh;/s);
  assert.match(
    wxss,
    /\.plan-editor-input\s*\{[^}]*height:\s*72rpx;[^}]*padding:\s*0 15rpx;[^}]*line-height:\s*72rpx;/s
  );
});

test('标题输入未截断时不 setData，截断时才回写视图', () => {
  const { component } = openSheet({
    visible: true,
    initialValue: createInitialValue({ title: '' })
  });
  const calls = [];
  const originalSetData = component.setData.bind(component);
  component.setData = (updates, callback) => {
    calls.push(updates);
    return originalSetData(updates, callback);
  };

  assert.equal(
    component.onTitleField({
      currentTarget: { dataset: { key: 'title' } },
      detail: { value: '日历计划' }
    }),
    '日历计划'
  );
  assert.equal(component.data.title, '日历计划');
  assert.equal(calls.length, 0);

  const tooLong = '字'.repeat(26);
  const limited = '字'.repeat(25);
  assert.equal(
    component.onTitleField({
      currentTarget: { dataset: { key: 'title' } },
      detail: { value: tooLong }
    }),
    limited
  );
  assert.equal(component.data.title, limited);
  assert.deepEqual(calls, [{ title: limited }]);
});

test('calendar create：无任务隐藏选择器并可直接同名创建；仅已完成时必须显式选择', () => {
  const wxml = fs.readFileSync(componentWxmlPath, 'utf8');
  assert.match(wxml, /variant === 'calendar' && \(planEditor \|\| hasAnyTasks\)/);
  assert.match(wxml, /<view class="switch-row"><view>固定日程<\/view><switch/);
  assert.match(wxml, /wx:if="\{\{repeatEnabled\}\}" class="repeat-options"/);

  const calls = [];
  withService({
    createCalendarEventWithNewTask(input) {
      calls.push(input);
      return { event: { id: 'event_1', startedAt: input.startedAt, endedAt: input.endedAt } };
    }
  }, () => {
    const noTasks = openSheet({
      visible: true,
      initialValue: createInitialValue({ hasAnyTasks: false })
    });
    noTasks.component.submitPlanForm();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].taskId, undefined);

    const onlyCompleted = openSheet({
      visible: true,
      initialValue: createInitialValue({
        hasAnyTasks: true,
        taskOptions: [
          { id: '', title: '请选择任务' },
          { id: '__create_same_title_task__', title: '新建同名任务', optionType: 'create' }
        ]
      })
    });
    onlyCompleted.component.submitPlanForm();
    assert.equal(calls.length, 1);
    onlyCompleted.component.chooseTaskOption({ currentTarget: { dataset: { index: 1 } } });
    onlyCompleted.component.submitPlanForm();
    assert.equal(calls.length, 2);
    assert.deepEqual(
      onlyCompleted.events.find((event) => event.name === 'taskindexchange').detail,
      { taskIndex: 1 }
    );
  });
});

test('plans-todo：未开固定日程只走普通计划原子 API 并带 taskProjectId', () => {
  const calls = { event: [], recurring: [], plain: [] };
  withService({
    createCalendarEventWithNewTask(input) {
      calls.event.push(input);
      return {
        task: { title: input.title, projectId: input.taskProjectId || null },
        event: { id: 'event_1', title: input.title, projectId: null, taskId: 't1', startedAt: input.startedAt, endedAt: input.endedAt }
      };
    },
    createRecurringPlanWithNewTask(input) { calls.recurring.push(input); },
    createCalendarEvent(input) { calls.plain.push(input); },
    createRecurringPlan(input) { calls.recurring.push(input); }
  }, () => {
    const { component, events } = openSheet({
      visible: true,
      variant: 'plans-todo',
      mode: 'create',
      initialValue: createInitialValue({
        title: 'A',
        taskOptions: [],
        newTaskProjectId: 'project_1'
      })
    });
    component.onTitleField({ currentTarget: { dataset: { key: 'title' } }, detail: { value: 'B' } });
    component.submitPlanForm();

    assert.equal(calls.event.length, 1);
    assert.equal(calls.recurring.length, 0);
    assert.equal(calls.plain.length, 0);
    assert.equal(calls.event[0].title, 'B');
    assert.equal(calls.event[0].taskProjectId, 'project_1');
    assert.equal(calls.event[0].taskId, undefined);
    assert.equal(calls.event[0].projectId, undefined);
    const success = events.find((event) => event.name === 'success').detail;
    assert.equal(success.operation, 'create-event');
    assert.equal(success.result.task.title, 'B');
    assert.equal(success.result.event.title, 'B');
    assert.ok(success.revealTarget);
  });
});

test('plans-todo：开启固定日程走重复计划原子 API 并带 taskProjectId', () => {
  const calls = { event: [], recurring: [], plain: [] };
  withService({
    createCalendarEventWithNewTask(input) { calls.event.push(input); },
    createRecurringPlanWithNewTask(input) {
      calls.recurring.push(input);
      return {
        task: { title: input.title, projectId: input.taskProjectId || null },
        rule: { id: 'rule_1', title: input.title },
        occurrence: {
          id: 'occ_1',
          title: input.title,
          startedAt: input.startedAt,
          endedAt: input.endedAt,
          virtual: true
        }
      };
    },
    createCalendarEvent(input) { calls.plain.push(input); },
    createRecurringPlan(input) { calls.plain.push(input); }
  }, () => {
    const { component, events } = openSheet({
      visible: true,
      variant: 'plans-todo',
      mode: 'create',
      initialValue: createInitialValue({
        title: 'A',
        taskOptions: [],
        newTaskProjectId: 'project_1'
      })
    });
    component.onTitleField({ currentTarget: { dataset: { key: 'title' } }, detail: { value: 'B' } });
    component.onSwitch({ currentTarget: { dataset: { key: 'repeatEnabled' } }, detail: { value: true } });
    component.submitPlanForm();

    assert.equal(calls.event.length, 0);
    assert.equal(calls.plain.length, 0);
    assert.equal(calls.recurring.length, 1);
    assert.equal(calls.recurring[0].title, 'B');
    assert.equal(calls.recurring[0].taskProjectId, 'project_1');
    assert.equal(calls.recurring[0].taskId, undefined);
    assert.equal(calls.recurring[0].projectId, undefined);
    assert.equal(calls.recurring[0].frequency, 'daily');
    assert.equal(calls.recurring[0].interval, 1);
    const success = events.find((event) => event.name === 'success').detail;
    assert.equal(success.operation, 'create-recurring');
    assert.equal(success.result.task.title, 'B');
    assert.equal(success.result.occurrence.virtual, true);
    assert.ok(success.revealTarget);
  });
});

test('calendar edit-recurring：固定展开本次及后续表单，完整预填规则并只调用一次编辑 API', () => {
  const wxml = fs.readFileSync(componentWxmlPath, 'utf8');
  const calls = [];
  const startedAt = new Date(2026, 7, 21, 9, 30).getTime();
  const endedAt = new Date(2026, 7, 21, 10, 45).getTime();
  const createdOccurrence = {
    id: 'rule_new:1:1787275800000',
    virtual: true,
    ruleId: 'rule_new',
    startedAt,
    endedAt
  };

  assert.match(wxml, /isRecurringEditor \? '编辑固定日程'/);
  assert.match(wxml, /<block wx:if="\{\{!isRecurringEditor\}\}"><view class="switch-row"/);
  assert.match(wxml, /<view wx:else class="repeat-edit-scope">固定日程 · 本次及后续<\/view>/);

  withService({
    editRuleFollowing(ruleId, occurrenceStart, input) {
      calls.push({ ruleId, occurrenceStart, input });
      return { previousRuleId: ruleId, rule: { id: 'rule_new' }, occurrence: createdOccurrence };
    },
    updateCalendarEvent() { throw new Error('不应更新普通计划'); },
    enableRecurringForCalendarEvent() { throw new Error('不应重复创建固定日程'); }
  }, () => {
    const { component, events } = openSheet({
      visible: true,
      mode: 'edit-recurring',
      initialValue: {
        plan: {
          id: 'rule_old:1:1787275800000',
          title: '每周复盘',
          ruleId: 'rule_old',
          occurrenceStart: startedAt,
          startedAt,
          endedAt,
          priority: 3
        },
        ruleId: 'rule_old',
        occurrenceStart: startedAt,
        revision: {
          revision: 1,
          frequency: 'weekly',
          interval: 3,
          weekdays: [1, 5],
          monthDays: [],
          taskId: 'task_review'
        },
        taskOptions: [{ id: 'task_review', title: '复盘任务', optionType: 'task' }],
        taskIndex: 0
      }
    });

    assert.equal(component.data.isRecurringEditor, true);
    assert.equal(component.data.repeatEnabled, true);
    assert.equal(component.data.title, '每周复盘');
    assert.deepEqual(
      [component.data.startDate, component.data.startTime, component.data.endDate, component.data.endTime],
      ['2026-08-21', '09:30', '2026-08-21', '10:45']
    );
    assert.deepEqual(
      [component.data.frequencyIndex, component.data.repeatGap, component.data.repeatWeekdays],
      [1, '2', [1, 5]]
    );
    assert.deepEqual(
      component.data.weekdayOptions.filter((item) => item.checked).map((item) => item.value),
      [1, 5]
    );

    component.savePlanEditor();

    assert.deepEqual(calls, [{
      ruleId: 'rule_old',
      occurrenceStart: startedAt,
      input: {
        title: '每周复盘',
        startedAt,
        endedAt,
        priority: 3,
        taskId: 'task_review',
        frequency: 'weekly',
        interval: 3,
        weekdays: [1, 5],
        monthDays: []
      }
    }]);
    const success = events.find((event) => event.name === 'success').detail;
    assert.equal(success.operation, 'update-recurring');
    assert.equal(success.revealTarget, createdOccurrence);
  });
});

test('calendar edit-recurring：每日、每周和每月规则都按持久化值预填', () => {
  const startedAt = new Date(2026, 7, 21, 9, 30).getTime();
  const base = {
    plan: {
      id: 'occurrence',
      title: '规则预填',
      ruleId: 'rule_prefill',
      occurrenceStart: startedAt,
      startedAt,
      endedAt: startedAt + 30 * 60 * 1000,
      priority: 2
    },
    ruleId: 'rule_prefill',
    occurrenceStart: startedAt,
    taskOptions: [{ id: 'task_prefill', title: '预填任务', optionType: 'task' }],
    taskIndex: 0
  };
  const cases = [{
    revision: { frequency: 'daily', interval: 2, weekdays: [], monthDays: [], taskId: 'task_prefill' },
    expected: [0, '1', [], []]
  }, {
    revision: { frequency: 'weekly', interval: 3, weekdays: [2, 6], monthDays: [], taskId: 'task_prefill' },
    expected: [1, '2', [2, 6], []]
  }, {
    revision: { frequency: 'monthly', interval: 4, weekdays: [], monthDays: [1, 15, 31], taskId: 'task_prefill' },
    expected: [2, '3', [], [1, 15, 31]]
  }];

  cases.forEach(({ revision, expected }) => {
    const { component } = openSheet({
      visible: true,
      mode: 'edit-recurring',
      initialValue: { ...base, revision }
    });
    assert.deepEqual([
      component.data.frequencyIndex,
      component.data.repeatGap,
      component.data.repeatWeekdays,
      component.data.repeatMonthDays
    ], expected);
  });
});

test('plans-todo：既有任务的普通计划和固定日程直接关联原任务且不新建 TODO', () => {
  const calls = { newEvent: [], newRecurring: [], event: [], recurring: [] };
  withService({
    createCalendarEventWithNewTask(input) { calls.newEvent.push(input); },
    createRecurringPlanWithNewTask(input) { calls.newRecurring.push(input); },
    createCalendarEvent(input) {
      calls.event.push(input);
      return { id: 'event_1', startedAt: input.startedAt, endedAt: input.endedAt };
    },
    createRecurringPlan(input) {
      calls.recurring.push(input);
      return {
        rule: { id: 'rule_1' },
        occurrence: { id: 'occ_1', startedAt: input.startedAt, endedAt: input.endedAt, virtual: true }
      };
    }
  }, () => {
    const normal = openSheet({
      visible: true,
      variant: 'plans-todo',
      initialValue: createInitialValue({ title: '待安排任务', existingTaskId: 'task_existing' })
    });
    normal.component.submitPlanForm();

    const recurring = openSheet({
      visible: true,
      variant: 'plans-todo',
      initialValue: createInitialValue({ title: '待安排任务', existingTaskId: 'task_existing' })
    });
    recurring.component.onSwitch({
      currentTarget: { dataset: { key: 'repeatEnabled' } },
      detail: { value: true }
    });
    recurring.component.submitPlanForm();

    assert.equal(calls.newEvent.length, 0);
    assert.equal(calls.newRecurring.length, 0);
    assert.equal(calls.event.length, 1);
    assert.equal(calls.recurring.length, 1);
    assert.equal(calls.event[0].taskId, 'task_existing');
    assert.equal(calls.recurring[0].taskId, 'task_existing');
    assert.equal(calls.event[0].taskProjectId, undefined);
    assert.equal(calls.recurring[0].taskProjectId, undefined);
    assert.equal(normal.events.find((event) => event.name === 'success').detail.operation, 'create-event');
    assert.equal(recurring.events.find((event) => event.name === 'success').detail.operation, 'create-recurring');
  });
});

test('plans-todo：提交失败时不触发 success 且保持会话可再次提交', () => {
  let attempts = 0;
  withService({
    createCalendarEventWithNewTask() {
      attempts += 1;
      throw new Error('保存失败');
    }
  }, (toasts) => {
    const { component, events } = openSheet({
      visible: true,
      variant: 'plans-todo',
      initialValue: createInitialValue({ title: '保留标题' })
    });
    component.submitPlanForm();
    component.submitPlanForm();
    assert.equal(attempts, 2);
    assert.equal(component.data.title, '保留标题');
    assert.equal(events.some((event) => event.name === 'success'), false);
    assert.equal(toasts.at(-1).title, '保存失败');
  });
});
