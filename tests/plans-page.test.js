const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { TASK_STATUS } = require('../miniprogram/domain/constants');

const plansPagePath = require.resolve('../miniprogram/pages/plans/index.js');
const plansWxmlPath = path.join(__dirname, '../miniprogram/pages/plans/index.wxml');
const plansWxssPath = path.join(__dirname, '../miniprogram/pages/plans/index.wxss');

function loadPlansPage() {
  const originalPage = global.Page;
  let page;
  global.Page = (definition) => { page = definition; };
  delete require.cache[plansPagePath];
  require(plansPagePath);
  global.Page = originalPage;
  return page;
}

function event(id, status) {
  return { currentTarget: { dataset: { id, status } } };
}

function inputEvent(key, value) {
  return { currentTarget: { dataset: { key } }, detail: { value } };
}

function createHarness({ tasks: providedTasks } = {}) {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const project = { id: 'project_1', title: '项目一', status: 'active', deadlineAt: 1_700_100_000_000, deadlineText: '2023-11-15 00:00', objectives: [] };
  const tasks = providedTasks || [
    { id: 'task_todo', title: '未完成', status: TASK_STATUS.TODO, projectId: project.id, projectNameSnapshot: project.title, updatedAt: 20 },
    { id: 'task_done', title: '已完成', status: TASK_STATUS.COMPLETED, projectId: project.id, projectNameSnapshot: project.title, updatedAt: 10 }
  ];
  const calls = { createTask: [], updateTask: [], deleteTask: [] };
  const wxState = {};
  const service = {
    snapshot() { return { projects: [project], wishes: [], tasks }; },
    createTask(input) { calls.createTask.push(input); },
    updateTask(id, input) { calls.updateTask.push([id, input]); },
    deleteTask(id, confirmed) { calls.deleteTask.push([id, confirmed]); }
  };
  const page = loadPlansPage();

  global.getApp = () => ({ globalData: { bootstrap: { applicationService: service } } });
  global.wx = {
    showToast() {},
    showActionSheet(config) { wxState.actionSheet = config; },
    showModal(config) { wxState.modal = config; }
  };
  page.data = { ...page.data, activeProjects: [project], tasks };
  page.setData = (updates, callback) => {
    Object.assign(page.data, updates);
    if (callback) callback();
  };

  return {
    page,
    calls,
    wxState,
    restore() {
      global.getApp = originalGetApp;
      global.wx = originalWx;
    }
  };
}

test('计划页：TODO 表单默认不关联，项目入口默认选中对应项目', () => {
  const harness = createHarness();
  try {
    harness.page.openStandaloneTask();
    assert.deepEqual(harness.page.data.taskEditor.projectOptions, [{ id: null, title: '不关联项目' }, { id: 'project_1', title: '项目一' }]);
    assert.equal(harness.page.data.taskEditor.projectTitle, '不关联项目');
    harness.page.onField(inputEvent('taskTitle', '独立任务'));
    harness.page.saveTaskEditor();
    assert.deepEqual(harness.calls.createTask[0], { title: '独立任务', status: TASK_STATUS.TODO, projectId: null });

    harness.page.openChildTask(event('project_1'));
    assert.equal(harness.page.data.taskEditor.projectTitle, '项目一');
    harness.page.onField(inputEvent('taskTitle', '项目子任务'));
    harness.page.saveTaskEditor();
    assert.deepEqual(harness.calls.createTask[1], { title: '项目子任务', projectId: 'project_1', status: TASK_STATUS.TODO });
  } finally {
    harness.restore();
  }
});

test('计划页：点击任务标题或项目标题打开编辑 TODO 表单并保存关联变更', () => {
  const harness = createHarness();
  try {
    harness.page.openTaskEditor(event('task_todo'));
    assert.equal(harness.page.data.taskEditor.mode, 'edit');
    assert.equal(harness.page.data.taskTitle, '未完成');
    assert.equal(harness.page.data.taskEditor.projectTitle, '项目一');

    harness.page.onTaskProjectChange({ detail: { value: '0' } });
    harness.page.onField(inputEvent('taskTitle', '已编辑任务'));
    harness.page.saveTaskEditor();
    assert.deepEqual(harness.calls.updateTask.at(-1), ['task_todo', { title: '已编辑任务', projectId: null }]);
  } finally {
    harness.restore();
  }
});

test('计划页：任务标题区域可打开编辑表单，表单提供关联项目选择', () => {
  const wxml = fs.readFileSync(plansWxmlPath, 'utf8');

  assert.match(wxml, /class="todo-main" data-id="{{task.id}}" bindtap="openTaskEditor"/);
  assert.match(wxml, /mode="selector" range="{{taskEditor.projectOptions}}" range-key="title"/);
  assert.match(wxml, /taskEditor.mode === 'edit' \? '编辑 TODO' : '新建 TODO'/);
});

test('计划页：关联菜单首项取消关联，删除必须确认', () => {
  const harness = createHarness();
  try {
    harness.page.chooseTaskProject(event('task_todo'));
    assert.deepEqual(harness.wxState.actionSheet.itemList, ['取消关联', '项目一']);
    harness.wxState.actionSheet.success({ tapIndex: 0 });
    assert.deepEqual(harness.calls.updateTask.at(-1), ['task_todo', { projectId: null }]);

    harness.page.confirmDeleteTask(event('task_todo'));
    assert.equal(harness.wxState.modal.content, '未结束的关联计划会一并删除；已结束计划和计时记录会保留。');
    harness.wxState.modal.success({ confirm: false });
    assert.equal(harness.calls.deleteTask.length, 0);
    harness.wxState.modal.success({ confirm: true });
    assert.deepEqual(harness.calls.deleteTask, [['task_todo', true]]);
  } finally {
    harness.restore();
  }
});

test('计划页：任务勾选切换状态，项目子任务按完成状态分栏', () => {
  const harness = createHarness();
  try {
    harness.page.toggleTask(event('task_todo', TASK_STATUS.TODO));
    harness.page.toggleTask(event('task_done', TASK_STATUS.COMPLETED));
    assert.deepEqual(harness.calls.updateTask, [
      ['task_todo', { status: TASK_STATUS.COMPLETED }],
      ['task_done', { status: TASK_STATUS.TODO }]
    ]);

    harness.page.openProjectTasks(event('project_1'));
    assert.deepEqual(harness.page.data.projectTaskPanel.activeTasks.map((item) => item.id), ['task_todo']);
    assert.deepEqual(harness.page.data.projectTaskPanel.completedTasks.map((item) => item.id), ['task_done']);
  } finally {
    harness.restore();
  }
});

test('计划页：TODO 保持保存顺序，修改状态不会重排任务位置', () => {
  const tasks = [
    { id: 'task_done', title: '先创建的已完成任务', status: TASK_STATUS.COMPLETED, projectId: null, projectNameSnapshot: '', updatedAt: 100 },
    { id: 'task_todo', title: '后创建的未完成任务', status: TASK_STATUS.TODO, projectId: null, projectNameSnapshot: '', updatedAt: 1 },
    { id: 'task_last', title: '第三条任务', status: TASK_STATUS.TODO, projectId: null, projectNameSnapshot: '', updatedAt: 2 }
  ];
  const harness = createHarness({ tasks });
  try {
    harness.page.refresh();
    assert.deepEqual(harness.page.data.todoListTasks.map((task) => task.id), ['task_done', 'task_todo', 'task_last']);

    harness.page.toggleTask(event('task_todo', TASK_STATUS.TODO));
    assert.deepEqual(harness.page.data.todoListTasks.map((task) => task.id), ['task_done', 'task_todo', 'task_last']);
  } finally {
    harness.restore();
  }
});

test('计划页：无关联 TODO 默认 32rpx，关联 TODO 默认 28rpx，溢出最小缩小到 18rpx', () => {
  const tasks = [
    { id: 'task_unlinked', title: '短标题', status: TASK_STATUS.TODO, projectId: null, projectNameSnapshot: '' },
    { id: 'task_linked', title: '关联任务', status: TASK_STATUS.TODO, projectId: 'project_1', projectNameSnapshot: '项目一' },
    { id: 'task_medium', title: '啊啊啊啊啊啊啊啊啊啊', status: TASK_STATUS.TODO, projectId: null, projectNameSnapshot: '' },
    { id: 'task_long', title: '啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊', status: TASK_STATUS.TODO, projectId: null, projectNameSnapshot: '' }
  ];
  const harness = createHarness({ tasks });
  try {
    global.wx.getSystemInfoSync = () => ({ windowWidth: 375 });
    global.wx.createSelectorQuery = () => ({
      selectAll(selector) {
        this.selector = selector;
        return this;
      },
      boundingClientRect(callback) {
        callback(this.selector === '.todo-column'
          ? [{ left: 0, width: 210 }]
          : [{ width: 100 }, { width: 100 }, { width: 80 }, { width: 80 }]);
        return this;
      },
      exec() {}
    });

    harness.page.refresh();
    assert.deepEqual(
      harness.page.data.todoListColumns.flatMap((column) => column.tasks).map((task) => task.todoTitleFontSize),
      [32, 28, 18, 18]
    );
  } finally {
    harness.restore();
  }
});

test('计划页：关联项目图标由文件夹堆叠和左指箭头表示', () => {
  const wxml = fs.readFileSync(plansWxmlPath, 'utf8');
  const wxss = fs.readFileSync(plansWxssPath, 'utf8');

  assert.match(wxml, /class="todo-link-icon"><view class="todo-folder-stack"><\/view><view class="todo-link-arrow"><\/view>/);
  assert.match(wxss, /\.todo-folder-stack::before\s*\{[^}]*border:[^}]*#15803d[^}]*background:\s*#ffffff/s);
  assert.match(wxss, /\.todo-link-arrow\s*\{[^}]*right:\s*0;[^}]*background:\s*#15803d/s);
  assert.match(wxss, /\.todo-link-arrow::before\s*\{[^}]*rotate\(-40deg\)/s);
  assert.match(wxss, /\.todo-link-arrow::after\s*\{[^}]*rotate\(40deg\)/s);
  assert.doesNotMatch(wxss, /\.todo-link-icon\s*\{[^}]*rotate\(-45deg\)/s);
});

test('计划页：删除图标桶身包含两道竖线', () => {
  const wxml = fs.readFileSync(plansWxmlPath, 'utf8');
  const wxss = fs.readFileSync(plansWxssPath, 'utf8');

  assert.match(wxml, /class="todo-delete-icon"><view class="todo-delete-lines"><\/view>/);
  assert.match(wxss, /\.todo-delete-lines\s*\{[^}]*width:\s*2rpx;[^}]*height:\s*12rpx;[^}]*box-shadow:\s*7rpx 0 0 #dc2626/s);
});

test('计划页：新建 TODO 时回到首列并使用 600ms 动画', () => {
  const harness = createHarness();
  const originalSetTimeout = global.setTimeout;
  const scheduled = [];
  global.setTimeout = (callback, delay) => {
    scheduled.push({ callback, delay });
    return scheduled.length;
  };
  try {
    harness.page.refresh();
    harness.page.setData({ todoColumnStep: 240, todoColumnIndex: 1, todoScrollLeft: 240 });
    harness.page.openStandaloneTask();
    harness.page.onField(inputEvent('taskTitle', '新任务'));
    harness.page.saveTaskEditor();

    assert.equal(harness.page.data.todoColumnIndex, 0);
    assert.ok(harness.page.data.todoScrollLeft > 0 && harness.page.data.todoScrollLeft <= 240);
    assert.equal(harness.page.data.todoScrollWithAnimation, false);
    assert.deepEqual(scheduled.map((item) => item.delay), [16]);
    assert.match(require('node:fs').readFileSync(plansPagePath, 'utf8'), /TODO_RETURN_ANIMATION_DURATION = 600/);
  } finally {
    global.setTimeout = originalSetTimeout;
    harness.restore();
  }
});

test('计划页：TODO 每三条分列，横向拖动按方向吸附整列', () => {
  const tasks = Array.from({ length: 7 }, (_, index) => ({
    id: `task_${index + 1}`,
    title: `任务 ${index + 1}`,
    status: TASK_STATUS.TODO,
    projectId: null,
    projectNameSnapshot: '',
    updatedAt: 100 - index
  }));
  const harness = createHarness({ tasks });
  try {
    harness.page.refresh();
    assert.deepEqual(
      harness.page.data.todoListColumns.map((column) => column.tasks.map((task) => task.id)),
      [['task_1', 'task_2', 'task_3'], ['task_4', 'task_5', 'task_6'], ['task_7']]
    );

    harness.page.setData({ todoColumnStep: 240, todoColumnIndex: 0, todoScrollLeft: 0 });
    harness.page.onTodoTouchStart({ touches: [{ pageX: 100 }] });
    harness.page.onTodoScroll({ detail: { scrollLeft: 40 } });
    harness.page.onTodoTouchEnd({ changedTouches: [{ pageX: 70 }] });
    assert.deepEqual(
      { index: harness.page.data.todoColumnIndex, left: harness.page.data.todoScrollLeft },
      { index: 1, left: 240 }
    );

    harness.page.onTodoTouchStart({ touches: [{ pageX: 70 }] });
    harness.page.onTodoTouchEnd({ changedTouches: [{ pageX: 70 }] });
    assert.deepEqual(
      { index: harness.page.data.todoColumnIndex, left: harness.page.data.todoScrollLeft },
      { index: 1, left: 240 }
    );

    harness.page.onTodoTouchStart({ touches: [{ pageX: 70 }] });
    harness.page.onTodoTouchEnd({ changedTouches: [{ pageX: 110 }] });
    assert.deepEqual(
      { index: harness.page.data.todoColumnIndex, left: harness.page.data.todoScrollLeft },
      { index: 0, left: 0 }
    );

    harness.page.setData({ todoColumnIndex: 1, todoScrollLeft: 240 });
    harness.page.onTodoTouchStart({ touches: [{ pageX: 100 }] });
    harness.page.onTodoScroll({ detail: { scrollLeft: 250 } });
    harness.page.onTodoTouchEnd({ changedTouches: [{ pageX: 82 }] });
    assert.deepEqual(
      { index: harness.page.data.todoColumnIndex, left: harness.page.data.todoScrollLeft },
      { index: 1, left: 240 }
    );
  } finally {
    harness.restore();
  }
});

test('计划页：TODO 测量相邻列起点作为含间距的吸附步长', () => {
  const harness = createHarness();
  try {
    harness.page.data.todoListColumns = [{ id: 'todo_column_0', tasks: [] }, { id: 'todo_column_1', tasks: [] }];
    global.wx.createSelectorQuery = () => ({
      selectAll(selector) {
        assert.equal(selector, '.todo-column');
        return this;
      },
      boundingClientRect(callback) {
        callback([{ left: 24, width: 210 }, { left: 282, width: 210 }]);
        return this;
      },
      exec() {}
    });

    harness.page.measureTodoColumn();
    assert.deepEqual(
      { step: harness.page.data.todoColumnStep, left: harness.page.data.todoScrollLeft },
      { step: 258, left: 0 }
    );
  } finally {
    harness.restore();
  }
});

test('计划页：TODO 连续左划可吸附到最后一列，四条任务可吸附第二列', () => {
  const makeTasks = (count) => Array.from({ length: count }, (_, index) => ({
    id: `task_${index + 1}`,
    title: `任务 ${index + 1}`,
    status: TASK_STATUS.TODO,
    projectId: null,
    projectNameSnapshot: '',
    updatedAt: 100 - index
  }));
  const sevenTaskHarness = createHarness({ tasks: makeTasks(7) });
  try {
    sevenTaskHarness.page.refresh();
    sevenTaskHarness.page.setData({ todoColumnStep: 240, todoColumnIndex: 0, todoScrollLeft: 0 });
    sevenTaskHarness.page.onTodoTouchStart({ touches: [{ pageX: 100 }] });
    sevenTaskHarness.page.onTodoTouchEnd({ changedTouches: [{ pageX: 70 }] });
    sevenTaskHarness.page.onTodoTouchStart({ touches: [{ pageX: 100 }] });
    sevenTaskHarness.page.onTodoTouchEnd({ changedTouches: [{ pageX: 70 }] });
    assert.deepEqual(
      { index: sevenTaskHarness.page.data.todoColumnIndex, left: sevenTaskHarness.page.data.todoScrollLeft },
      { index: 2, left: 480 }
    );
  } finally {
    sevenTaskHarness.restore();
  }

  const fourTaskHarness = createHarness({ tasks: makeTasks(4) });
  try {
    fourTaskHarness.page.refresh();
    fourTaskHarness.page.setData({ todoColumnStep: 240, todoColumnIndex: 0, todoScrollLeft: 0 });
    fourTaskHarness.page.onTodoTouchStart({ touches: [{ pageX: 100 }] });
    fourTaskHarness.page.onTodoTouchEnd({ changedTouches: [{ pageX: 70 }] });
    assert.deepEqual(
      { index: fourTaskHarness.page.data.todoColumnIndex, left: fourTaskHarness.page.data.todoScrollLeft },
      { index: 1, left: 240 }
    );
  } finally {
    fourTaskHarness.restore();
  }
});
