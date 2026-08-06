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

function createHarness({ tasks: providedTasks, projects: providedProjects, wishes: providedWishes } = {}) {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const project = { id: 'project_1', title: '项目一', status: 'active', deadlineAt: 1_700_100_000_000, deadlineText: '2023-11-15 00:00' };
  const projects = providedProjects || [project];
  const tasks = providedTasks || [
    { id: 'task_todo', title: '未完成', status: TASK_STATUS.TODO, projectId: project.id, projectNameSnapshot: project.title, updatedAt: 20 },
    { id: 'task_done', title: '已完成', status: TASK_STATUS.COMPLETED, projectId: project.id, projectNameSnapshot: project.title, updatedAt: 10 }
  ];
  const wishes = providedWishes || [];
  const calls = {
    createProject: [], createTask: [], updateTask: [], deleteTask: [],
    createWish: [], updateWish: [], deleteWish: [], convertWishToProject: []
  };
  const wxState = {};
  const service = {
    snapshot() { return { projects, wishes, tasks }; },
    createProject(input) {
      calls.createProject.push(input);
      const createdProject = { id: 'project_created', title: input.title, status: 'active', deadlineAt: input.deadlineAt };
      projects.push(createdProject);
      return createdProject;
    },
    createTask(input) { calls.createTask.push(input); },
    updateTask(id, input) {
      calls.updateTask.push([id, input]);
      const task = tasks.find((item) => item.id === id);
      if (task) Object.assign(task, input);
    },
    deleteTask(id, confirmed) { calls.deleteTask.push([id, confirmed]); },
    createWish(title) {
      calls.createWish.push(title);
      const createdWish = {
        id: `wish_created_${calls.createWish.length}`,
        title,
        createdAt: calls.createWish.length,
        updatedAt: calls.createWish.length
      };
      wishes.push(createdWish);
      return createdWish;
    },
    updateWish(id, title) { calls.updateWish.push([id, title]); },
    deleteWish(id, confirmed) { calls.deleteWish.push([id, confirmed]); },
    convertWishToProject(id) { calls.convertWishToProject.push(id); }
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

test('计划页：愿望池每三条分列，横向翻列状态与 TODO 独立', () => {
  const wishes = Array.from({ length: 4 }, (_, index) => ({
    id: `wish_${index + 1}`,
    title: `愿望 ${index + 1}`,
    createdAt: index + 1,
    updatedAt: index + 1
  }));
  const harness = createHarness({ wishes });
  try {
    harness.page.refresh();
    assert.deepEqual(
      harness.page.data.wishListColumns.map((column) => column.wishes.map((wish) => wish.id)),
      [['wish_1', 'wish_2', 'wish_3'], ['wish_4']]
    );

    harness.page.setData({
      wishColumnStep: 240,
      wishColumnIndex: 0,
      wishScrollLeft: 0,
      todoColumnIndex: 0,
      todoScrollLeft: 0
    });
    harness.page.onWishTouchStart({ touches: [{ pageX: 120 }] });
    harness.page.onWishScroll({ detail: { scrollLeft: 80 } });
    harness.page.onWishTouchEnd({ changedTouches: [{ pageX: 20 }] });
    assert.equal(harness.page.data.wishColumnIndex, 1);
    assert.equal(harness.page.data.todoColumnIndex, 0);
    harness.page.clearWishScrollAnimation();
  } finally {
    harness.restore();
  }
});

test('计划页：新建愿望后自动翻到新愿望所在列并使用 600ms 动画', () => {
  const wishes = Array.from({ length: 6 }, (_, index) => ({
    id: `wish_${index + 1}`,
    title: `愿望 ${index + 1}`,
    createdAt: index + 1,
    updatedAt: index + 1
  }));
  const harness = createHarness({ wishes });
  const originalSetTimeout = global.setTimeout;
  const originalDateNow = Date.now;
  const scheduled = [];
  const nowValues = [0, 0, 600];
  global.setTimeout = (callback, delay) => {
    scheduled.push({ callback, delay });
    return scheduled.length;
  };
  Date.now = () => nowValues.shift() ?? 600;
  global.wx.createSelectorQuery = () => {
    let selector = '';
    let callback = null;
    return {
      selectAll(value) { selector = value; return this; },
      boundingClientRect(value) { callback = value; return this; },
      exec() {
        const rects = selector === '.wish-column'
          ? [{ left: 0, width: 180 }, { left: 240, width: 180 }, { left: 480, width: 180 }]
          : [{ left: 0, width: 180 }];
        callback(rects);
      }
    };
  };
  try {
    harness.page.setData({
      isWishExpanded: true,
      wishTitle: '新愿望',
      wishColumnStep: 240,
      wishColumnIndex: 0,
      wishScrollLeft: 0
    });
    harness.page.addWish();

    assert.equal(harness.page.data.wishListColumns.length, 3);
    assert.equal(harness.page.data.wishColumnIndex, 2);
    assert.deepEqual(scheduled.map((item) => item.delay), [16]);
    scheduled[0].callback();
    assert.equal(harness.page.data.wishScrollLeft, 480);
    assert.equal(harness.page.data.todoColumnIndex, 0);
  } finally {
    Date.now = originalDateNow;
    global.setTimeout = originalSetTimeout;
    harness.page.clearWishScrollAnimation();
    harness.restore();
  }
});

test('计划页：点击愿望标题原地编辑并在输入完成后保存', () => {
  const wishes = [{ id: 'wish_1', title: '原愿望', createdAt: 1, updatedAt: 1 }];
  const harness = createHarness({ wishes });
  try {
    harness.page.refresh();
    harness.page.openWishTitleEditor(event('wish_1'));
    assert.equal(harness.page.data.wishTitleEditId, 'wish_1');
    assert.equal(harness.page.data.wishTitleEditValue, '原愿望');

    harness.page.onWishTitleInput({ detail: { value: '修改后的愿望' } });
    harness.page.saveWishTitle({ detail: { value: '修改后的愿望' } });
    assert.deepEqual(harness.calls.updateWish, [['wish_1', '修改后的愿望']]);
    assert.equal(harness.page.data.wishTitleEditId, '');
  } finally {
    harness.restore();
  }
});

test('计划页：愿望使用内联标题输入和右侧转项目、删除图标', () => {
  const wxml = fs.readFileSync(plansWxmlPath, 'utf8');
  const wxss = fs.readFileSync(plansWxssPath, 'utf8');

  assert.match(wxml, /class="wish-title[^\"]*"[^>]*data-id="{{wish.id}}"[^>]*bindtap="openWishTitleEditor"/);
  assert.match(wxml, /<input wx:if="{{wishTitleEditId === wish.id}}" class="wish-title-input"[^>]*focus="{{true}}"[^>]*bindinput="onWishTitleInput"[^>]*bindblur="saveWishTitle"[^>]*bindconfirm="saveWishTitle"/);
  assert.match(wxml, /aria-label="转为项目" data-id="{{wish.id}}" bindtap="convertWish"/);
  assert.match(wxml, /aria-label="删除愿望" data-id="{{wish.id}}" bindtap="confirmDeleteWish"><delete-icon\s*\/><\/view>/);
  assert.doesNotMatch(wxml, /bindtap="editWish"/);
  assert.match(wxss, /\.wish-column\s*\{[^}]*flex:\s*0 0 60%;[^}]*row-gap:\s*18rpx;[^}]*overflow:\s*hidden;/s);
  assert.match(wxss, /\.wish-row\s*\{[^}]*flex:\s*0 0 calc\(33\.333333% - 12rpx\);[^}]*min-width:\s*0;/s);
});

test('计划页：删除愿望必须二次确认', () => {
  const wishes = [{ id: 'wish_1', title: '准备删除', createdAt: 1, updatedAt: 1 }];
  const harness = createHarness({ wishes });
  try {
    harness.page.refresh();
    harness.page.confirmDeleteWish(event('wish_1'));
    assert.equal(harness.wxState.modal.title, '删除愿望');
    assert.equal(harness.wxState.modal.content, '删除后无法恢复。');
    harness.wxState.modal.success({ confirm: false });
    assert.equal(harness.calls.deleteWish.length, 0);
    harness.wxState.modal.success({ confirm: true });
    assert.deepEqual(harness.calls.deleteWish, [['wish_1', true]]);
  } finally {
    harness.restore();
  }
});

test('计划页：TODO 表单默认不关联，项目入口默认选中对应项目', () => {
  const harness = createHarness();
  try {
    harness.page.openStandaloneTask();
    assert.deepEqual(harness.page.data.taskEditor.projectOptions, [{ id: null, title: '不关联项目' }, { id: 'project_1', title: '项目一' }]);
    assert.equal(harness.page.data.taskEditor.projectTitle, '不关联项目');
    harness.page.onField(inputEvent('taskTitle', '独立任务'));
    harness.page.saveTaskEditor();
    assert.deepEqual(harness.calls.createTask[0], { title: '独立任务', projectId: null });

    harness.page.openChildTask(event('project_1'));
    assert.equal(harness.page.data.taskEditor.projectTitle, '项目一');
    harness.page.onField(inputEvent('taskTitle', '项目子任务'));
    harness.page.saveTaskEditor();
    assert.deepEqual(harness.calls.createTask[1], { title: '项目子任务', projectId: 'project_1' });
  } finally {
    harness.restore();
  }
});

test('计划页：点击 TODO 标题就地编辑，输入完成后只更新标题', () => {
  const harness = createHarness();
  try {
    harness.page.openTodoTitleEditor(event('task_todo'));
    assert.equal(harness.page.data.todoTitleEditTaskId, 'task_todo');
    assert.equal(harness.page.data.todoTitleEditValue, '未完成');
    assert.equal(harness.page.data.isTaskEditorOpen, false);

    harness.page.onTodoTitleInput({ detail: { value: '已编辑任务' } });
    harness.page.saveTodoTitle({ detail: { value: '已编辑任务' } });
    assert.deepEqual(harness.calls.updateTask.at(-1), ['task_todo', { title: '已编辑任务' }]);
    assert.equal(harness.page.data.todoTitleEditTaskId, '');
  } finally {
    harness.restore();
  }
});

test('计划页：项目区标题编辑只在项目区自动聚焦，并在保存后清空编辑来源', () => {
  const harness = createHarness();
  try {
    harness.page.openTodoTitleEditor({
      currentTarget: { dataset: { id: 'task_todo', editSource: 'project' } }
    });
    assert.equal(harness.page.data.todoTitleEditTaskId, 'task_todo');
    assert.equal(harness.page.data.todoTitleEditSource, 'project');

    harness.page.saveTodoTitle({ detail: { value: '未完成' } });
    assert.equal(harness.page.data.todoTitleEditTaskId, '');
    assert.equal(harness.page.data.todoTitleEditValue, '');
    assert.equal(harness.page.data.todoTitleEditSource, '');

    const wxml = fs.readFileSync(plansWxmlPath, 'utf8');
    assert.match(wxml, /<input wx:if="\{\{todoTitleEditTaskId === task\.id && todoTitleEditSource === 'todo'\}\}" class="todo-title-input"/);
    assert.equal(
      (wxml.match(/<input wx:if="\{\{todoTitleEditTaskId === task\.id && todoTitleEditSource === 'project'\}\}" class="todo-title-input"/g) || []).length,
      2
    );
  } finally {
    harness.restore();
  }
});

test('计划页：活动项目以内联子任务总览替代只读任务弹层', () => {
  const wxml = fs.readFileSync(plansWxmlPath, 'utf8');
  const wxss = fs.readFileSync(plansWxssPath, 'utf8');

  assert.match(wxml, /wx:for="\{\{projectCards\}\}"/);
  assert.match(wxml, /aria-label="管理项目" data-id="\{\{item\.id\}\}" bindtap="openProjectManage"/);
  assert.match(wxml, /data-id="\{\{task\.id\}\}" data-status="\{\{task\.status\}\}" bindtap="toggleTask"/);
  assert.match(wxml, /bindtap="toggleProjectTodoExpansion"/);
  assert.match(wxml, /bindtap="toggleProjectCompletedExpansion"/);
  assert.match(wxml, /\+ 添加第一项子任务/);
  assert.doesNotMatch(wxml, /projectTaskPanel|openProjectTasks|switchProjectTaskTab/);
  assert.doesNotMatch(wxml, /class="text-button"[^>]*>管理/);
  assert.match(wxss, /\.project-task-row\s*\{/);
  assert.match(wxss, /\.project-manage\s*\{/);
});

test('计划页：项目内联子任务的勾选与标题编辑入口均提供至少 56rpx 热区', () => {
  const wxml = fs.readFileSync(plansWxmlPath, 'utf8');
  const wxss = fs.readFileSync(plansWxssPath, 'utf8');

  assert.equal(
    (wxml.match(/class="project-task-check" role="button" aria-label="\{\{task\.status === 'completed' \? '重新打开子任务' : '完成子任务'\}\}" data-id="\{\{task\.id\}\}" data-status="\{\{task\.status\}\}" bindtap="toggleTask"/g) || []).length,
    2
  );
  assert.equal(
    (wxml.match(/class="todo-title todo-title-button project-task-title-button" role="button" aria-label="编辑 TODO 标题"/g) || []).length,
    2
  );
  assert.match(wxss, /\.project-task-check\s*\{[^}]*width:\s*56rpx;[^}]*height:\s*56rpx;/s);
  assert.match(wxss, /\.project-task-title-button\s*\{[^}]*min-height:\s*56rpx;/s);
});

test('计划页：标题输入以 25 个 Unicode 码点截断', () => {
  const harness = createHarness();
  try {
    const emoji = '🙂';
    harness.page.onTitleField(inputEvent('taskTitle', emoji.repeat(26)));
    assert.equal(harness.page.data.taskTitle, emoji.repeat(25));

    const wxml = fs.readFileSync(plansWxmlPath, 'utf8');
    for (const key of [
      'wishTitle', 'projectTitle', 'taskTitle', 'projectEditorTitle'
    ]) {
      assert.match(wxml, new RegExp(`maxlength="-1"[^>]*data-key="${key}"[^>]*bindinput="onTitleField"`));
    }
    assert.match(wxml, /class="wish-title-input"[^>]*maxlength="-1"[^>]*bindinput="onWishTitleInput"/);
    assert.doesNotMatch(wxml, /maxlength="25"/);
  } finally {
    harness.restore();
  }
});

test('计划页：TODO 标题使用自动聚焦的内联输入，创建弹窗不再承担编辑职责', () => {
  const wxml = fs.readFileSync(plansWxmlPath, 'utf8');

  assert.match(wxml, /class="[^"]*todo-title[^"]*"[^>]*data-id="{{task.id}}"[^>]*bindtap="openTodoTitleEditor"/);
  assert.match(wxml, /<input wx:if="{{todoTitleEditTaskId === task.id && todoTitleEditSource === 'todo'}}" class="todo-title-input"[^>]*focus="{{true}}"[^>]*bindinput="onTodoTitleInput"[^>]*bindblur="saveTodoTitle"[^>]*bindconfirm="saveTodoTitle"/);
  assert.doesNotMatch(wxml, /bindtap="openTaskEditor"/);
  assert.doesNotMatch(wxml, /taskEditor\.mode/);
  assert.match(wxml, /<sheet-header title="新建 TODO"/);
  assert.match(wxml, /mode="selector" range="{{taskEditor.projectOptions}}" range-key="title"/);
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
  assert.match(deleteIconWxss, /\.delete-icon-body\s*\{[^}]*left:\s*50%;[^}]*border:\s*3rpx solid #9a5550;/s);
  assert.match(deleteIconWxss, /\.delete-icon-line\s*\{[^}]*width:\s*3rpx;/s);
  for (const part of ['handle', 'lid', 'body', 'lines']) {
    assert.match(deleteIconWxss, new RegExp(`\\.delete-icon-${part}\\s*\\{[^}]*left:\\s*50%;`, 's'));
  }
});

test('计划页：项目选择弹窗按关联状态显示标题和取消关联项', () => {
  const firstProject = { id: 'project_1', title: '项目一', status: 'active', deadlineAt: 1_700_100_000_000 };
  const secondProject = { id: 'project_2', title: '项目二', status: 'active', deadlineAt: 1_700_200_000_000 };
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
  const project = { id: 'project_1', title: '项目一', status: 'active', deadlineAt: 1_700_100_000_000 };
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
      projectTime: '09:00'
    });
    harness.page.addProject();
    assert.equal(harness.calls.createProject.length, 1);
    assert.deepEqual(harness.calls.updateTask.at(-1), ['task_unlinked', { projectId: 'project_created' }]);
  } finally {
    harness.restore();
  }
});

test('计划页：新建项目仅提交标题和截止日', () => {
  const harness = createHarness({ projects: [], tasks: [] });
  try {
    harness.page.setData({
      projectTitle: '新项目',
      projectDate: '2026-07-31',
      projectTime: '09:00'
    });
    harness.page.addProject();
    assert.equal(harness.calls.createProject.length, 1);
    assert.deepEqual(harness.calls.createProject[0], {
      title: '新项目',
      deadlineAt: new Date('2026-07-31T09:00:00').getTime()
    });
  } finally {
    harness.restore();
  }
});

test('计划页：项目卡和新建项目表单不再提供 OKR', () => {
  const wxml = fs.readFileSync(plansWxmlPath, 'utf8');

  assert.doesNotMatch(wxml, /OKR|目标|关键结果|objectives|objective|keyResults|keyResult|openKeyResult|okrEditor/);
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

test('计划页：项目卡默认预览前三条未完成项，两个展开状态相互独立', () => {
  const project = { id: 'project_1', title: '项目一', status: 'active', deadlineAt: 1_700_100_000_000 };
  const tasks = [
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `todo_${index + 1}`,
      title: `未完成 ${index + 1}`,
      status: TASK_STATUS.TODO,
      projectId: project.id,
      projectNameSnapshot: project.title
    })),
    ...Array.from({ length: 2 }, (_, index) => ({
      id: `completed_${index + 1}`,
      title: `已完成 ${index + 1}`,
      status: TASK_STATUS.COMPLETED,
      projectId: project.id,
      projectNameSnapshot: project.title
    }))
  ];
  const harness = createHarness({ projects: [project], tasks });
  try {
    harness.page.refresh();
    assert.deepEqual(harness.page.data.projectCards.map((card) => ({
      id: card.id,
      title: card.title,
      todoTasks: card.todoTasks.map((task) => task.id),
      completedTasks: card.completedTasks.map((task) => task.id),
      hasNoTodoTasks: card.hasNoTodoTasks,
      hasMoreTodoTasks: card.hasMoreTodoTasks,
      remainingTodoCount: card.remainingTodoCount,
      isTodoExpanded: card.isTodoExpanded,
      todoToggleText: card.todoToggleText,
      completedCount: card.completedCount,
      isCompletedExpanded: card.isCompletedExpanded,
      completedToggleText: card.completedToggleText
    })), [{
      id: 'project_1',
      title: '项目一',
      todoTasks: ['todo_1', 'todo_2', 'todo_3'],
      completedTasks: [],
      hasNoTodoTasks: false,
      hasMoreTodoTasks: true,
      remainingTodoCount: 2,
      isTodoExpanded: false,
      todoToggleText: '查看全部 2 项',
      completedCount: 2,
      isCompletedExpanded: false,
      completedToggleText: '已完成 2 项'
    }]);

    harness.page.toggleProjectTodoExpansion(event('project_1'));
    assert.deepEqual(harness.page.data.projectCards[0].todoTasks.map((task) => task.id), ['todo_1', 'todo_2', 'todo_3', 'todo_4', 'todo_5']);
    assert.equal(harness.page.data.projectCards[0].isCompletedExpanded, false);

    harness.page.toggleProjectCompletedExpansion(event('project_1'));
    assert.deepEqual(harness.page.data.projectCards[0].completedTasks.map((task) => task.id), ['completed_1', 'completed_2']);
    assert.equal(harness.page.data.projectCards[0].isTodoExpanded, true);
  } finally {
    harness.restore();
  }
});

test('计划页：勾选唯一项目未完成项后，项目卡显示无未完成项和已完成计数', () => {
  const harness = createHarness({
    tasks: [{ id: 'task_todo', title: '未完成', status: TASK_STATUS.TODO, projectId: 'project_1', projectNameSnapshot: '项目一' }]
  });
  try {
    harness.page.refresh();
    harness.page.toggleTask(event('task_todo', TASK_STATUS.TODO));
    assert.deepEqual(harness.calls.updateTask, [['task_todo', { status: TASK_STATUS.COMPLETED }]]);
    assert.equal(harness.page.data.projectCards[0].hasNoTodoTasks, true);
    assert.equal(harness.page.data.projectCards[0].completedCount, 1);
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

test('计划页：getWindowInfo 失败时使用 getSystemInfoSync 完成标题字号测量', () => {
  const tasks = [
    { id: 'task_long', title: '啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊', status: TASK_STATUS.TODO, projectId: null, projectNameSnapshot: '' }
  ];
  const harness = createHarness({ tasks });
  try {
    global.wx.getWindowInfo = () => { throw new Error('getWindowInfo unavailable'); };
    global.wx.getSystemInfoSync = () => ({ windowWidth: 375 });
    global.wx.createSelectorQuery = () => ({
      selectAll(selector) {
        this.selector = selector;
        return this;
      },
      boundingClientRect(callback) {
        callback(this.selector === '.todo-column'
          ? [{ left: 0, width: 210 }]
          : [{ width: 80 }]);
        return this;
      },
      exec() {}
    });

    assert.doesNotThrow(() => harness.page.refresh());
    assert.equal(harness.page.data.todoListColumns[0].tasks[0].todoTitleFontSize, 18);
  } finally {
    harness.restore();
  }
});

test('计划页：窗口宽度不可用时跳过字号测量且列与任务操作仍安全', () => {
  const tasks = [
    { id: 'task_todo', title: '保持默认字号', status: TASK_STATUS.TODO, projectId: null, projectNameSnapshot: '' }
  ];
  const harness = createHarness({ tasks });
  const selectors = [];
  try {
    global.wx.getWindowInfo = () => ({ windowWidth: 0 });
    global.wx.getSystemInfoSync = () => { throw new Error('legacy API unavailable'); };
    global.wx.createSelectorQuery = () => ({
      selectAll(selector) {
        selectors.push(selector);
        this.selector = selector;
        return this;
      },
      boundingClientRect(callback) {
        callback([{ left: 0, width: 210 }]);
        return this;
      },
      exec() {}
    });

    assert.doesNotThrow(() => harness.page.refresh());
    assert.deepEqual(selectors, ['.todo-column']);
    assert.equal(harness.page.data.todoListColumns[0].tasks[0].todoTitleFontSize, 32);
    assert.equal(harness.page.data.todoColumnStep, 210);

    assert.doesNotThrow(() => {
      harness.page.openStandaloneTask();
      harness.page.onTitleField(inputEvent('taskTitle', '低版本任务'));
      harness.page.saveTaskEditor();
    });
    assert.deepEqual(harness.calls.createTask.at(-1), { title: '低版本任务', projectId: null });
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

test('计划页：TODO 轻拖以固定时长单调回到原列', () => {
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

test('计划页：TODO 松手早于 scroll 事件时仍以固定时长单调回到原列', () => {
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

test('计划页：TODO 快速横划以固定时长单调吸附相邻目标列', () => {
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
    assert.deepEqual(scheduled.map((item) => item.delay), [16]);
    now += 300;
    scheduled.shift().callback();
    assert.ok(harness.page.data.todoScrollLeft > 160 && harness.page.data.todoScrollLeft < 240);
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
