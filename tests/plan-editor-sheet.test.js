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

test('iOS：计划输入框复用其他底部弹窗的原生非同层避让', () => {
  const wxml = fs.readFileSync(componentWxmlPath, 'utf8');
  const wxss = fs.readFileSync(componentWxssPath, 'utf8');
  const definition = loadDefinition();
  const inputs = wxml.match(/<input\b[^>]*\/>/g) || [];

  assert.equal(inputs.length, 2);
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

test('plans-todo：标题 A→B 只走普通计划原子 API 并带 taskProjectId', () => {
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
