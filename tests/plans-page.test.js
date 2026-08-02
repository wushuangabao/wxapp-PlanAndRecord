const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { TASK_STATUS } = require('../miniprogram/domain/constants');

const plansPagePath = require.resolve('../miniprogram/pages/plans/index.js');
const plansWxmlPath = path.join(__dirname, '../miniprogram/pages/plans/index.wxml');
const plansWxssPath = path.join(__dirname, '../miniprogram/pages/plans/index.wxss');
const plansJsonPath = path.join(__dirname, '../miniprogram/pages/plans/index.json');
const deleteIconDirectory = path.join(__dirname, '../miniprogram/components/delete-icon');
const deleteIconWxmlPath = path.join(deleteIconDirectory, 'index.wxml');
const deleteIconWxssPath = path.join(deleteIconDirectory, 'index.wxss');
const sheetHeaderDirectory = path.join(__dirname, '../miniprogram/components/sheet-header');
const sheetHeaderJsPath = path.join(sheetHeaderDirectory, 'index.js');
const sheetHeaderJsonPath = path.join(sheetHeaderDirectory, 'index.json');
const sheetHeaderWxmlPath = path.join(sheetHeaderDirectory, 'index.wxml');
const sheetHeaderWxssPath = path.join(sheetHeaderDirectory, 'index.wxss');

function loadPlansPage() {
  const originalPage = global.Page;
  let page;
  global.Page = (definition) => { page = definition; };
  delete require.cache[plansPagePath];
  require(plansPagePath);
  global.Page = originalPage;
  return page;
}

function loadSheetHeader() {
  const originalComponent = global.Component;
  let component;
  global.Component = (definition) => { component = definition; };
  delete require.cache[sheetHeaderJsPath];
  require(sheetHeaderJsPath);
  global.Component = originalComponent;
  return component;
}

function event(id, status) {
  return { currentTarget: { dataset: { id, status } } };
}

function inputEvent(key, value) {
  return { currentTarget: { dataset: { key } }, detail: { value } };
}

function createHarness({ tasks: providedTasks, projects: providedProjects } = {}) {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const project = { id: 'project_1', title: '项目一', status: 'active', deadlineAt: 1_700_100_000_000, deadlineText: '2023-11-15 00:00', objectives: [] };
  const projects = providedProjects || [project];
  const tasks = providedTasks || [
    { id: 'task_todo', title: '未完成', status: TASK_STATUS.TODO, projectId: project.id, projectNameSnapshot: project.title, updatedAt: 20 },
    { id: 'task_done', title: '已完成', status: TASK_STATUS.COMPLETED, projectId: project.id, projectNameSnapshot: project.title, updatedAt: 10 }
  ];
  const calls = { createProject: [], createTask: [], updateTask: [], deleteTask: [] };
  const wxState = {};
  const service = {
    snapshot() { return { projects, wishes: [], tasks }; },
    createProject(input) {
      calls.createProject.push(input);
      const createdProject = { id: 'project_created', title: input.title, status: 'active', deadlineAt: input.deadlineAt, objectives: input.objectives };
      projects.push(createdProject);
      return createdProject;
    },
    createTask(input) { calls.createTask.push(input); },
    updateTask(id, input) { calls.updateTask.push([id, input]); },
    deleteTask(id, confirmed) { calls.deleteTask.push([id, confirmed]); }
  };
  const page = loadPlansPage();

  global.getApp = () => ({ globalData: { bootstrap: { applicationService: service } } });
  global.wx = {
    showToast(config) { wxState.toast = config; },
    showActionSheet(config) { wxState.actionSheet = config; },
    showModal(config) { wxState.modal = config; }
  };
  page.data = { ...page.data, activeProjects: projects.filter((item) => item.status === 'active'), tasks };
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

test('计划页：TODO 图标操作使用固定热区的 view 和统一删除图标', () => {
  const wxml = fs.readFileSync(plansWxmlPath, 'utf8');
  const wxss = fs.readFileSync(plansWxssPath, 'utf8');
  const config = JSON.parse(fs.readFileSync(plansJsonPath, 'utf8'));
  const deleteIconWxml = fs.readFileSync(deleteIconWxmlPath, 'utf8');
  const deleteIconWxss = fs.readFileSync(deleteIconWxssPath, 'utf8');

  assert.match(wxml, /<view class="todo-actions">\s*<view class="todo-icon-button todo-link-button" role="button" aria-label="关联项目" data-id="\{\{task\.id\}\}" bindtap="chooseTaskProject">/s);
  assert.match(wxml, /<view class="todo-icon-button todo-delete-button" role="button" aria-label="删除" data-id="\{\{task\.id\}\}" bindtap="confirmDeleteTask"><delete-icon\s*\/><\/view>/);
  assert.doesNotMatch(wxml, /<button class="todo-icon-button/);
  assert.match(wxss, /\.todo-actions\s*\{[^}]*flex:\s*0 0 112rpx;[^}]*width:\s*112rpx;[^}]*min-width:\s*112rpx;/s);
  assert.match(wxss, /\.todo-icon-button\s*\{[^}]*flex:\s*0 0 56rpx;[^}]*width:\s*56rpx;[^}]*height:\s*56rpx;/s);
  assert.equal(config.usingComponents['delete-icon'], '/components/delete-icon/index');
  assert.match(deleteIconWxml, /class="delete-icon-handle"/);
  assert.match(deleteIconWxml, /class="delete-icon-lid"/);
  assert.match(deleteIconWxml, /class="delete-icon-body"/);
  assert.equal((deleteIconWxml.match(/class="delete-icon-line"/g) || []).length, 2);
  assert.match(deleteIconWxss, /:host\s*\{[^}]*width:\s*22rpx;[^}]*height:\s*25rpx;/s);
  assert.match(deleteIconWxss, /\.delete-icon\s*\{[^}]*width:\s*22rpx;[^}]*height:\s*25rpx;[^}]*transform:\s*scale\(\.85\)/s);
  assert.match(deleteIconWxss, /\.delete-icon-body\s*\{[^}]*left:\s*50%;[^}]*border:\s*3rpx solid #9a5550;/s);
  assert.match(deleteIconWxss, /\.delete-icon-line\s*\{[^}]*width:\s*3rpx;/s);
  for (const part of ['handle', 'lid', 'body', 'lines']) {
    assert.match(deleteIconWxss, new RegExp(`\\.delete-icon-${part}\\s*\\{[^}]*left:\\s*50%;`, 's'));
  }
});

test('计划页：项目选择弹窗按关联状态显示标题和取消关联项', () => {
  const firstProject = { id: 'project_1', title: '项目一', status: 'active', deadlineAt: 1_700_100_000_000, objectives: [] };
  const secondProject = { id: 'project_2', title: '项目二', status: 'active', deadlineAt: 1_700_200_000_000, objectives: [] };
  const harness = createHarness({
    projects: [firstProject, secondProject],
    tasks: [{ id: 'task_todo', title: '已关联 TODO', status: TASK_STATUS.TODO, projectId: firstProject.id, projectNameSnapshot: firstProject.title, updatedAt: 20 }]
  });
  try {
    harness.page.chooseTaskProject(event('task_todo'));
    assert.deepEqual(harness.page.data.taskProjectPicker, {
      taskId: 'task_todo',
      title: '更改所属项目',
      projects: [{ id: 'project_2', title: '项目二' }],
      optionsHeight: 192,
      canUnlink: true
    });
  } finally {
    harness.restore();
  }

  const unlinkedHarness = createHarness({
    projects: [firstProject, secondProject],
    tasks: [{ id: 'task_unlinked', title: '独立 TODO', status: TASK_STATUS.TODO, projectId: null, projectNameSnapshot: '', updatedAt: 10 }]
  });
  try {
    unlinkedHarness.page.chooseTaskProject(event('task_unlinked'));
    assert.deepEqual(unlinkedHarness.page.data.taskProjectPicker, {
      taskId: 'task_unlinked',
      title: '添加到项目…',
      projects: [{ id: 'project_1', title: '项目一' }, { id: 'project_2', title: '项目二' }],
      optionsHeight: 192,
      canUnlink: false
    });
  } finally {
    unlinkedHarness.restore();
  }
});

test('计划页：仅当前关联项目仍打开更改所属项目弹窗', () => {
  const project = { id: 'project_1', title: '项目一', status: 'active', deadlineAt: 1_700_100_000_000, objectives: [] };
  const harness = createHarness({
    projects: [project],
    tasks: [{ id: 'task_todo', title: '已关联 TODO', status: TASK_STATUS.TODO, projectId: project.id, projectNameSnapshot: project.title, updatedAt: 20 }]
  });
  try {
    harness.page.chooseTaskProject(event('task_todo'));
    assert.deepEqual(harness.page.data.taskProjectPicker, {
      taskId: 'task_todo',
      title: '更改所属项目',
      projects: [],
      optionsHeight: 96,
      canUnlink: true
    });
    assert.equal(harness.page.data.isProjectCreateOpen, false);
  } finally {
    harness.restore();
  }
});

test('计划页：项目选择弹窗可关联项目，已关联 TODO 才可取消关联', () => {
  const harness = createHarness();
  try {
    harness.page.chooseTaskProject(event('task_todo'));
    harness.page.selectTaskProject(event('project_1'));
    assert.deepEqual(harness.calls.updateTask.at(-1), ['task_todo', { projectId: 'project_1' }]);

    harness.page.chooseTaskProject(event('task_todo'));
    harness.page.unlinkTaskProject();
    assert.deepEqual(harness.calls.updateTask.at(-1), ['task_todo', { projectId: null }]);
  } finally {
    harness.restore();
  }
});

test('计划页：没有活动项目时新建项目并自动关联发起选择的 TODO', () => {
  const harness = createHarness({
    projects: [],
    tasks: [{ id: 'task_unlinked', title: '独立 TODO', status: TASK_STATUS.TODO, projectId: null, projectNameSnapshot: '', updatedAt: 10 }]
  });
  try {
    harness.page.chooseTaskProject(event('task_unlinked'));
    assert.deepEqual(
      { open: harness.page.data.isProjectCreateOpen, pendingTaskId: harness.page.data.pendingTaskProjectLinkId },
      { open: true, pendingTaskId: 'task_unlinked' }
    );

    harness.page.setData({
      projectTitle: '新项目',
      projectDate: '2026-07-31',
      projectTime: '09:00',
      projectObjective: '首个目标',
      projectKeyResult: '首个关键结果',
      projectCurrent: '0'
    });
    harness.page.addProject();
    assert.equal(harness.calls.createProject.length, 1);
    assert.deepEqual(harness.calls.updateTask.at(-1), ['task_unlinked', { projectId: 'project_created' }]);
  } finally {
    harness.restore();
  }
});

test('计划页：新建项目允许暂不填写 OKR，但关键结果必须归属目标', () => {
  const harness = createHarness({ projects: [], tasks: [] });
  try {
    harness.page.setData({
      projectTitle: '新项目',
      projectDate: '2026-07-31',
      projectTime: '09:00',
      projectObjective: '',
      projectKeyResult: '',
      projectCurrent: ''
    });
    harness.page.addProject();
    assert.deepEqual(harness.calls.createProject[0].objectives, []);

    harness.page.setData({ projectObjective: '', projectKeyResult: '没有所属目标的关键结果' });
    harness.page.addProject();
    assert.equal(harness.calls.createProject.length, 1);
    assert.equal(harness.wxState.toast.title, '填写关键结果前请先填写目标名称');
  } finally {
    harness.restore();
  }
});

test('计划页：新建项目表单明确标注 OKR 为可选', () => {
  const wxml = fs.readFileSync(plansWxmlPath, 'utf8');

  assert.match(wxml, /placeholder="首个目标名称（可选）"/);
  assert.match(wxml, /placeholder="首个关键结果标题（可选）"/);
  assert.match(wxml, /placeholder="当前值 0–100（可选，默认 0）"/);
});

test('计划页：项目选择弹窗使用可滚动的原生动作面板式选项', () => {
  const wxml = fs.readFileSync(plansWxmlPath, 'utf8');
  const wxss = fs.readFileSync(plansWxssPath, 'utf8');

  assert.match(wxml, /wx:if="{{taskProjectPicker}}"[\s\S]*{{taskProjectPicker.title}}/);
  assert.match(wxml, /<scroll-view class="task-project-options" scroll-y="{{true}}" style="height: {{taskProjectPicker.optionsHeight}}rpx;">/);
  assert.match(wxml, /wx:if="{{taskProjectPicker.canUnlink}}"[\s\S]*class="task-project-option task-project-unlink"[\s\S]*取消关联/);
  assert.match(wxss, /\.task-project-options\s*\{[^}]*max-height:\s*56vh/s);
  assert.match(wxss, /\.task-project-option\s*\{[^}]*background:\s*#faf9f7;[^}]*color:\s*#343a36;[^}]*text-align:\s*center/s);
  assert.match(wxss, /\.task-project-option\s*\+\s*\.task-project-option\s*\{[^}]*border-top:\s*1rpx solid #dedad3/s);
  assert.match(wxss, /\.task-project-unlink\s*\{[^}]*color:\s*#9a5550/s);
});

test('计划页：删除任务必须确认', () => {
  const harness = createHarness();
  try {

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
    global.wx.getWindowInfo = () => ({ windowWidth: 375 });
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
    harness.page.onTodoTouchEnd({ changedTouches: [{ pageX: 10 }] });
    assert.equal(harness.page.data.todoColumnIndex, 1);
    harness.page.clearTodoScrollAnimation();

    harness.page.setData({ todoScrollLeft: 240 });
    harness.page.onTodoTouchStart({ touches: [{ pageX: 70 }] });
    harness.page.onTodoTouchEnd({ changedTouches: [{ pageX: 70 }] });
    assert.equal(harness.page.data.todoColumnIndex, 1);

    harness.page.onTodoTouchStart({ touches: [{ pageX: 70 }] });
    harness.page.onTodoTouchEnd({ changedTouches: [{ pageX: 170 }] });
    assert.equal(harness.page.data.todoColumnIndex, 0);
    harness.page.clearTodoScrollAnimation();

    harness.page.setData({ todoColumnIndex: 1, todoScrollLeft: 240 });
    harness.page.onTodoTouchStart({ touches: [{ pageX: 100 }] });
    harness.page.onTodoScroll({ detail: { scrollLeft: 250 } });
    harness.page.onTodoTouchEnd({ changedTouches: [{ pageX: 82 }] });
    assert.equal(harness.page.data.todoColumnIndex, 1);
    harness.page.clearTodoScrollAnimation();
  } finally {
    harness.restore();
  }
});

test('计划页：TODO 轻拖未过一成半列宽时从实际松手位置回弹', () => {
  const tasks = Array.from({ length: 4 }, (_, index) => ({
    id: `task_${index + 1}`,
    title: `任务 ${index + 1}`,
    status: TASK_STATUS.TODO,
    projectId: null,
    projectNameSnapshot: '',
    updatedAt: 100 - index
  }));
  const harness = createHarness({ tasks });
  const originalDateNow = Date.now;
  const originalSetTimeout = global.setTimeout;
  const scheduled = [];
  let now = 1_700_000_000_000;
  Date.now = () => now;
  global.setTimeout = (callback, delay) => {
    scheduled.push({ callback, delay });
    return scheduled.length;
  };
  try {
    harness.page.refresh();
    harness.page.setData({ todoColumnStep: 240, todoColumnIndex: 0, todoScrollLeft: 0 });
    harness.page.onTodoTouchStart({ touches: [{ pageX: 200 }] });
    harness.page.onTodoScroll({ detail: { scrollLeft: 24 } });
    harness.page.onTodoTouchEnd({ changedTouches: [{ pageX: 180 }] });

    assert.deepEqual(
      { index: harness.page.data.todoColumnIndex, left: harness.page.data.todoScrollLeft, nativeAnimation: harness.page.data.todoScrollWithAnimation },
      { index: 0, left: 20, nativeAnimation: false }
    );
    assert.deepEqual(scheduled.map((item) => item.delay), [16]);

    now += 300;
    scheduled.shift().callback();
    assert.ok(harness.page.data.todoScrollLeft >= 0 && harness.page.data.todoScrollLeft < 20);
    now += 120;
    scheduled.shift().callback();
    assert.equal(harness.page.data.todoScrollLeft, 0);
  } finally {
    Date.now = originalDateNow;
    global.setTimeout = originalSetTimeout;
    harness.restore();
  }
});

test('计划页：TODO 松手早于 scroll 事件时仍从手势位移平滑回弹', () => {
  const tasks = Array.from({ length: 4 }, (_, index) => ({
    id: `task_${index + 1}`,
    title: `任务 ${index + 1}`,
    status: TASK_STATUS.TODO,
    projectId: null,
    projectNameSnapshot: '',
    updatedAt: 100 - index
  }));
  const harness = createHarness({ tasks });
  const originalDateNow = Date.now;
  const originalSetTimeout = global.setTimeout;
  const scheduled = [];
  let now = 1_700_000_000_000;
  Date.now = () => now;
  global.setTimeout = (callback, delay) => {
    scheduled.push({ callback, delay });
    return scheduled.length;
  };
  try {
    harness.page.refresh();
    harness.page.setData({ todoColumnStep: 240, todoColumnIndex: 0, todoScrollLeft: 0 });
    harness.page.onTodoTouchStart({ touches: [{ pageX: 200 }] });
    harness.page.onTodoTouchMove({ touches: [{ pageX: 180 }] });
    harness.page.onTodoTouchEnd({ changedTouches: [{ pageX: 180 }] });

    assert.deepEqual(
      { index: harness.page.data.todoColumnIndex, left: harness.page.data.todoScrollLeft, nativeAnimation: harness.page.data.todoScrollWithAnimation },
      { index: 0, left: 20, nativeAnimation: false }
    );
    assert.deepEqual(scheduled.map((item) => item.delay), [16]);

    harness.page.onTodoScroll({ detail: { scrollLeft: 20 } });
    now += 420;
    scheduled.shift().callback();
    assert.equal(harness.page.data.todoScrollLeft, 0);
  } finally {
    Date.now = originalDateNow;
    global.setTimeout = originalSetTimeout;
    harness.restore();
  }
});

test('计划页：TODO 快速横划也只受控进入相邻列', () => {
  const tasks = Array.from({ length: 7 }, (_, index) => ({
    id: `task_${index + 1}`,
    title: `任务 ${index + 1}`,
    status: TASK_STATUS.TODO,
    projectId: null,
    projectNameSnapshot: '',
    updatedAt: 100 - index
  }));
  const harness = createHarness({ tasks });
  const originalDateNow = Date.now;
  const originalSetTimeout = global.setTimeout;
  const scheduled = [];
  let now = 1_700_000_000_000;
  Date.now = () => now;
  global.setTimeout = (callback, delay) => {
    scheduled.push({ callback, delay });
    return scheduled.length;
  };
  try {
    harness.page.refresh();
    harness.page.setData({ todoColumnStep: 240, todoColumnIndex: 0, todoScrollLeft: 0 });
    harness.page.onTodoTouchStart({ touches: [{ pageX: 240 }] });
    harness.page.onTodoScroll({ detail: { scrollLeft: 510 } });
    harness.page.onTodoTouchEnd({ changedTouches: [{ pageX: 80 }] });

    assert.deepEqual(
      { index: harness.page.data.todoColumnIndex, left: harness.page.data.todoScrollLeft, nativeAnimation: harness.page.data.todoScrollWithAnimation },
      { index: 1, left: 160, nativeAnimation: false }
    );
    now += 300;
    scheduled.shift().callback();
    assert.ok(harness.page.data.todoScrollLeft > 240);
    now += 120;
    scheduled.shift().callback();
    assert.equal(harness.page.data.todoScrollLeft, 240);
  } finally {
    Date.now = originalDateNow;
    global.setTimeout = originalSetTimeout;
    harness.restore();
  }
});

test('计划页：TODO 首列右拖时跟随手势，松手后回弹归位', () => {
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
    harness.page.setData({ todoColumnStep: 240, todoColumnIndex: 0, todoScrollLeft: 0 });
    harness.page.onTodoTouchStart({ touches: [{ pageX: 100 }] });
    harness.page.onTodoTouchMove({ touches: [{ pageX: 140 }] });
    assert.deepEqual(
      { index: harness.page.data.todoColumnIndex, left: harness.page.data.todoScrollLeft, offset: harness.page.data.todoBoundaryOffset, dragging: harness.page.data.todoBoundaryIsDragging },
      { index: 0, left: 0, offset: 18, dragging: true }
    );
    harness.page.onTodoTouchEnd({ changedTouches: [{ pageX: 140 }] });
    assert.deepEqual(
      { index: harness.page.data.todoColumnIndex, left: harness.page.data.todoScrollLeft, offset: harness.page.data.todoBoundaryOffset, dragging: harness.page.data.todoBoundaryIsDragging },
      { index: 0, left: 0, offset: 0, dragging: false }
    );

    harness.page.setData({ todoColumnIndex: 2, todoScrollLeft: 480 });
    harness.page.onTodoTouchStart({ touches: [{ pageX: 100 }] });
    harness.page.onTodoTouchEnd({ changedTouches: [{ pageX: 70 }] });
    assert.equal(harness.page.data.todoColumnIndex, 2);
    assert.equal(harness.page.data.todoBoundaryOffset, 0);
    assert.equal(harness.page.data.todoBoundaryIsDragging, false);
    harness.page.clearTodoScrollAnimation();
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
    sevenTaskHarness.page.onTodoTouchEnd({ changedTouches: [{ pageX: 0 }] });
    sevenTaskHarness.page.onTodoTouchStart({ touches: [{ pageX: 100 }] });
    sevenTaskHarness.page.onTodoTouchEnd({ changedTouches: [{ pageX: 0 }] });
    assert.equal(sevenTaskHarness.page.data.todoColumnIndex, 2);
    sevenTaskHarness.page.clearTodoScrollAnimation();
  } finally {
    sevenTaskHarness.restore();
  }

  const fourTaskHarness = createHarness({ tasks: makeTasks(4) });
  try {
    fourTaskHarness.page.refresh();
    fourTaskHarness.page.setData({ todoColumnStep: 240, todoColumnIndex: 0, todoScrollLeft: 0 });
    fourTaskHarness.page.onTodoTouchStart({ touches: [{ pageX: 100 }] });
    fourTaskHarness.page.onTodoTouchEnd({ changedTouches: [{ pageX: 0 }] });
    assert.equal(fourTaskHarness.page.data.todoColumnIndex, 1);
    fourTaskHarness.page.clearTodoScrollAnimation();
  } finally {
    fourTaskHarness.restore();
  }
});

test('计划页：共享底部弹窗头部承接创建和关闭事件', () => {
  const wxml = fs.readFileSync(plansWxmlPath, 'utf8');
  const pageConfig = JSON.parse(fs.readFileSync(plansJsonPath, 'utf8'));

  assert.equal(fs.existsSync(sheetHeaderJsPath), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(sheetHeaderJsonPath, 'utf8')), { component: true });
  assert.equal(pageConfig.usingComponents['sheet-header'], '/components/sheet-header/index');
  assert.match(wxml, /<sheet-header title="新建项目" show-confirm="{{true}}" bind:confirm="addProject" bind:cancel="closeProjectCreate"\s*\/>/);
  assert.match(wxml, /<sheet-header title="{{taskProjectPicker\.title}}" bind:cancel="closeTaskProjectPicker"\s*\/>/);
  assert.doesNotMatch(wxml, /onProjectCreateModalTap|project-create-confirm|project-create-cancel/);

  const component = loadSheetHeader();
  const events = [];
  component.methods.onConfirm.call({ triggerEvent: (name) => events.push(name) });
  component.methods.onCancel.call({ triggerEvent: (name) => events.push(name) });

  assert.deepEqual(events, ['confirm', 'cancel']);
  assert.equal(component.properties.showConfirm.value, false);
  assert.equal(component.properties.confirmText.value, '确定');
  assert.match(fs.readFileSync(sheetHeaderWxmlPath, 'utf8'), /wx:if="{{showConfirm}}"[\s\S]*{{confirmText}}/);
  assert.match(fs.readFileSync(sheetHeaderWxssPath, 'utf8'), /\.sheet-confirm\s*\{[^}]*width:\s*80rpx/s);
  assert.match(fs.readFileSync(sheetHeaderWxssPath, 'utf8'), /\.sheet-cancel\s*\{[^}]*width:\s*56rpx/s);
});
