const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { TASK_STATUS } = require('../miniprogram/domain/constants');
const { LocalPreferenceStore } = require('../miniprogram/services/local-preference-store');

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

function createHarness({
  tasks: providedTasks,
  projects: providedProjects,
  wishes: providedWishes,
  planStates: providedPlanStates,
  storage: providedStorage,
  preferenceStore: providedPreferenceStore,
  profileId: initialProfileId = 'profile_plans'
} = {}) {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const project = { id: 'project_1', title: '项目一', status: 'active', deadlineAt: 1_700_100_000_000, deadlineText: '2023-11-15 00:00' };
  const projects = providedProjects || [project];
  const tasks = providedTasks || [
    { id: 'task_todo', title: '未完成', status: TASK_STATUS.TODO, projectId: project.id, projectNameSnapshot: project.title, updatedAt: 20 },
    { id: 'task_done', title: '已完成', status: TASK_STATUS.COMPLETED, projectId: project.id, projectNameSnapshot: project.title, updatedAt: 10 }
  ];
  const wishes = providedWishes || [];
  const storage = providedStorage || {};
  let profileId = initialProfileId;
  const preferenceStore = providedPreferenceStore || new LocalPreferenceStore({
    has: (key) => Object.prototype.hasOwnProperty.call(storage, key),
    get: (key) => (Object.prototype.hasOwnProperty.call(storage, key)
      ? structuredClone(storage[key])
      : ''),
    set: (key, value) => { storage[key] = structuredClone(value); },
    remove: (key) => { delete storage[key]; }
  });
  const calls = {
    createProject: [], createTask: [], updateTask: [], deleteTask: [],
    createWish: [], updateWish: [], deleteWish: [], convertWishToProject: [],
    startTaskPlanTimer: [], reopenTaskByRemovingCompletionLog: [],
    refreshTaskPlanStatuses: []
  };
  const planStates = providedPlanStates || new Map();
  const wxState = {};
  const service = {
    snapshot() { return { localProfile: { id: profileId }, projects, wishes, tasks }; },
    taskPlanStates() { return planStates; },
    refreshTaskPlanStatuses() { calls.refreshTaskPlanStatuses.push(true); return []; },
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
    startTaskPlanTimer(id, candidateId) {
      calls.startTaskPlanTimer.push([id, candidateId]);
      return { status: 'running' };
    },
    taskCompletionUndoPreview(id) {
      const state = planStates.get(id);
      if (!state || !state.completionUndoLog) throw new Error('没有完成证据');
      return state.completionUndoLog;
    },
    reopenTaskByRemovingCompletionLog(id, logId, confirmed) {
      calls.reopenTaskByRemovingCompletionLog.push([id, logId, confirmed]);
    },
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

  global.getApp = () => ({
    globalData: { bootstrap: { applicationService: service, preferences: preferenceStore } }
  });
  global.wx = {
    showToast(config) { wxState.toast = config; },
    showActionSheet(config) { wxState.actionSheet = config; },
    showModal(config) { wxState.modal = config; },
    switchTab(config) { wxState.switchTab = config; },
    getStorageSync(key) { return Object.hasOwn(storage, key) ? storage[key] : ''; },
    setStorageSync(key, value) { storage[key] = value; }
  };
  page.data = { ...page.data, activeProjects: projects.filter((item) => item.status === 'active'), tasks };
  page.setData = (updates, callback) => {
    Object.assign(page.data, updates);
    if (callback) callback();
  };

  return {
    page,
    calls,
    storage,
    setProfileId(value) { profileId = value; },
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

test('计划页：愿望池和 TODO LIST 在空、单条与两条时收缩列表与卡片高度，三条起保留最大高度', () => {
  const wxml = fs.readFileSync(plansWxmlPath, 'utf8');
  const wxss = fs.readFileSync(plansWxssPath, 'utf8');

  assert.match(wxml, /class="wish-empty is-one-row"/);
  assert.match(wxml, /class="wish-list \{\{wishes\.length === 1 \? 'is-one-row' : \(wishes\.length === 2 \? 'is-two-rows' : ''\)\}\}"/);
  assert.match(wxml, /class="card todo-card \{\{todoListTasks\.length < 2 \? 'is-one-row' : \(todoListTasks\.length === 2 \? 'is-two-rows' : ''\)\}\}"/);
  assert.match(wxml, /class="todo-empty is-one-row"/);
  assert.match(wxml, /class="todo-list \{\{todoListTasks\.length === 1 \? 'is-one-row' : \(todoListTasks\.length === 2 \? 'is-two-rows' : ''\)\}\}"/);
  assert.match(wxss, /\.todo-card\s*\{[^}]*height:\s*420rpx;/s);
  assert.match(wxss, /\.todo-card\.is-one-row\s*\{[^}]*height:\s*224rpx;/s);
  assert.match(wxss, /\.todo-card\.is-two-rows\s*\{[^}]*height:\s*322rpx;/s);
  assert.match(wxss, /\.todo-list\.is-one-row, \.todo-empty\.is-one-row\s*\{[^}]*height:\s*100rpx;/s);
  assert.match(wxss, /\.todo-list\.is-two-rows\s*\{[^}]*height:\s*198rpx;/s);
  assert.match(wxss, /\.wish-list\.is-one-row, \.wish-empty\.is-one-row\s*\{[^}]*height:\s*116rpx;/s);
  assert.match(wxss, /\.wish-list\.is-two-rows\s*\{[^}]*height:\s*214rpx;/s);
  assert.match(wxss, /\.todo-list\.is-one-row \.todo-columns\s*\{[^}]*height:\s*80rpx;/s);
  assert.match(wxss, /\.todo-list\.is-two-rows \.todo-columns\s*\{[^}]*height:\s*178rpx;/s);
  assert.match(wxss, /\.wish-list\.is-one-row \.wish-row[^}]*flex-basis:\s*80rpx;/s);
  assert.match(wxss, /\.wish-list\.is-two-rows \.wish-row[^}]*flex-basis:\s*80rpx;/s);
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

test('计划页：新建 TODO 的关联由入口决定，表单不提供项目选择', () => {
  const harness = createHarness();
  try {
    harness.page.openStandaloneTask();
    assert.equal(harness.page.data.taskEditor.projectId, null);
    harness.page.onField(inputEvent('taskTitle', '独立任务'));
    harness.page.saveTaskEditor();
    assert.deepEqual(harness.calls.createTask[0], { title: '独立任务', projectId: null });

    harness.page.openChildTask(event('project_1'));
    assert.equal(harness.page.data.taskEditor.projectId, 'project_1');
    harness.page.onField(inputEvent('taskTitle', '项目子任务'));
    harness.page.saveTaskEditor();
    assert.deepEqual(harness.calls.createTask[1], { title: '项目子任务', projectId: 'project_1' });
  } finally {
    harness.restore();
  }
});

test('计划页：新建 TODO 提供设定时间并切换到复用计划弹窗', () => {
  const wxml = fs.readFileSync(plansWxmlPath, 'utf8');
  const wxss = fs.readFileSync(plansWxssPath, 'utf8');
  const json = JSON.parse(fs.readFileSync(plansJsonPath, 'utf8'));
  assert.equal(json.usingComponents['plan-editor-sheet'], '/components/plan-editor-sheet/index');
  assert.match(wxml, /aria-label="设定时间"[^>]*bindtap="openPlanFromTodo"/);
  assert.match(wxml, /设定时间/);
  assert.match(wxss, /\.todo-set-time\s*\{[^}]*color:\s*#4d695b;/s);
  assert.match(wxml, /variant="plans-todo"/);
  assert.match(wxml, /visible="\{\{isPlanSheetOpen\}\}"/);
});

test('计划页：设定时间预填标题，取消恢复 TODO 名，成功后清理编辑态', () => {
  const harness = createHarness();
  try {
    harness.page.openStandaloneTask();
    harness.page.onTitleField(inputEvent('taskTitle', 'A'));
    harness.page.openPlanFromTodo();
    assert.equal(harness.page.data.isTaskEditorOpen, false);
    assert.equal(harness.page.data.isPlanSheetOpen, true);
    assert.equal(harness.page.data.planEditorInitialValue.title, 'A');
    assert.equal(harness.page.data.planEditorInitialValue.newTaskProjectId, null);
    assert.equal(harness.page.data.todoEditorSnapshot.taskTitle, 'A');

    harness.page.onPlanEditorCancel();
    assert.equal(harness.page.data.isPlanSheetOpen, false);
    assert.equal(harness.page.data.isTaskEditorOpen, true);
    assert.equal(harness.page.data.taskTitle, 'A');

    harness.page.openPlanFromTodo();
    const callbacks = [];
    const refreshCalls = [];
    harness.page.setData = (updates, callback) => {
      Object.assign(harness.page.data, updates);
      if (callback) callbacks.push(callback);
    };
    harness.page.refresh = (options) => refreshCalls.push(options);
    harness.page.onPlanEditorSuccess({
      detail: {
        operation: 'create-event',
        result: { task: { id: 't1', title: 'B' }, event: { id: 'e1', title: 'B' } },
        revealTarget: { id: 'e1' }
      }
    });
    assert.equal(harness.page.data.isPlanSheetOpen, false);
    assert.equal(harness.page.data.isTaskEditorOpen, false);
    assert.equal(harness.page.data.taskEditor, null);
    assert.deepEqual(refreshCalls, []);
    assert.equal(harness.wxState.toast, undefined);
    assert.equal(callbacks.length, 1);
    callbacks[0]();
    assert.deepEqual(refreshCalls, [{ resetTodoColumn: true }]);
    assert.equal(harness.wxState.toast.title, '计划块已创建');
  } finally {
    harness.restore();
  }
});

test('计划页：项目入口设定时间携带 newTaskProjectId', () => {
  const harness = createHarness();
  try {
    harness.page.openChildTask(event('project_1'));
    harness.page.onTitleField(inputEvent('taskTitle', '子任务'));
    harness.page.openPlanFromTodo();
    assert.equal(harness.page.data.planEditorInitialValue.newTaskProjectId, 'project_1');
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

test('计划页：迟到的旧标题 blur 只保存原任务，不覆盖新聚焦任务', () => {
  const tasks = [
    { id: 'task_a', title: '标题 A', status: TASK_STATUS.TODO, projectId: null, updatedAt: 20 },
    { id: 'task_b', title: '标题 B', status: TASK_STATUS.TODO, projectId: null, updatedAt: 10 }
  ];
  const harness = createHarness({ tasks });
  try {
    harness.page.openTodoTitleEditor({
      currentTarget: { dataset: { id: 'task_a', editSource: 'todo' } }
    });
    harness.page.openTodoTitleEditor({
      currentTarget: { dataset: { id: 'task_b', editSource: 'todo' } }
    });

    harness.page.onTodoTitleInput({
      currentTarget: { dataset: { id: 'task_a', editSource: 'todo' } },
      detail: { value: '标题 A' }
    });
    harness.page.saveTodoTitle({
      currentTarget: { dataset: { id: 'task_a', editSource: 'todo' } },
      detail: { value: '标题 A' }
    });

    assert.deepEqual(harness.calls.updateTask, []);
    assert.equal(tasks[1].title, '标题 B');
    assert.equal(harness.page.data.todoTitleEditTaskId, 'task_b');
    assert.equal(harness.page.data.todoTitleEditValue, '标题 B');
    assert.equal(harness.page.data.todoTitleEditSource, 'todo');
    assert.equal(harness.wxState.toast, undefined);

    harness.page.openTodoTitleEditor({
      currentTarget: { dataset: { id: 'task_a', editSource: 'todo' } }
    });
    harness.page.onTodoTitleInput({
      currentTarget: { dataset: { id: 'task_a', editSource: 'todo' } },
      detail: { value: '标题 A 已修改' }
    });
    harness.page.openTodoTitleEditor({
      currentTarget: { dataset: { id: 'task_b', editSource: 'todo' } }
    });
    harness.page.saveTodoTitle({
      currentTarget: { dataset: { id: 'task_a', editSource: 'todo' } },
      detail: { value: '标题 A 已修改' }
    });

    assert.deepEqual(harness.calls.updateTask, [['task_a', { title: '标题 A 已修改' }]]);
    assert.equal(tasks[0].title, '标题 A 已修改');
    assert.equal(tasks[1].title, '标题 B');
    assert.equal(harness.page.data.todoTitleEditTaskId, 'task_b');
    assert.equal(harness.page.data.todoTitleEditValue, '标题 B');
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
    assert.match(wxml, /todoTitleEditSource === 'todo'\}\}" class="todo-title-input" data-id="\{\{task\.id\}\}" data-edit-source="todo"/);
    assert.equal(
      (wxml.match(/todoTitleEditSource === 'project'\}\}" class="todo-title-input" data-id="\{\{task\.id\}\}" data-edit-source="project"/g) || []).length,
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

test('计划页：项目任务区以待处理和可展开的已完成列组织', () => {
  const wxml = fs.readFileSync(plansWxmlPath, 'utf8');
  const wxss = fs.readFileSync(plansWxssPath, 'utf8');

  assert.match(wxml, /class="project-task-columns \{\{item\.completedCount \? \(item\.isCompletedExpanded \? 'has-completed' : 'is-completed-collapsed'\) : ''\}\}"/);
  assert.match(wxml, /<view wx:if="\{\{!item\.hasNoTodoTasks\}\}" class="project-column-heading">待处理<\/view>/);
  assert.match(wxml, /class="project-todo-footer">[\s\S]*class="project-add-task"/);
  assert.match(wxml, /class="project-inline-link project-completed-toggle" role="button" aria-label="\{\{item\.isCompletedExpanded \? '收起已完成项' : '展开已完成项'\}\}"/);
  assert.match(wxml, /\{\{item\.completedToggleText\}\}/);
  assert.match(wxml, /class="project-completed-list"/);
  assert.match(wxss, /\.project-task-columns\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*stretch;[^}]*margin-top:\s*14rpx;/s);
  assert.match(wxss, /\.project-task-column\s*\{[^}]*flex:\s*1 1 0;[^}]*min-width:\s*0;/s);
  assert.match(wxss, /\.project-task-columns\.has-completed \.project-todo-column\s*\{[^}]*flex-basis:\s*56%;[^}]*padding-right:\s*24rpx;/s);
  assert.match(wxss, /\.project-task-columns\.has-completed \.project-completed-column::before\s*\{[^}]*width:\s*1rpx;[^}]*background:\s*#dedad3;/s);
  assert.match(wxss, /\.project-task-columns\.is-completed-collapsed\s*\{[^}]*align-items:\s*flex-start;/s);
  assert.match(wxss, /\.project-task-columns\.is-completed-collapsed \.project-completed-column\s*\{[^}]*flex:\s*0 0 auto;[^}]*align-self:\s*flex-start;[^}]*margin-left:\s*auto;/s);
  assert.match(wxss, /\.project-completed-column\s*\{[^}]*align-items:\s*flex-end;/s);
  assert.match(wxss, /\.project-completed-toggle\s*\{[^}]*justify-content:\s*flex-end;[^}]*width:\s*auto;/s);
  assert.match(wxss, /\.project-column-heading, \.project-completed-toggle\s*\{[^}]*color:\s*#4d695b;[^}]*font-size:\s*25rpx;/s);
  assert.match(wxss, /\.project-completed-list\s*\{[^}]*padding:\s*8rpx 10rpx;/s);
  assert.doesNotMatch(wxss, /\.project-completed-list\s*\{[^}]*background:/s);
  assert.match(wxss, /\.project-todo-column\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s);
  assert.match(wxss, /\.project-todo-footer\s*\{[^}]*margin-top:\s*auto;[^}]*padding-top:\s*10rpx;/s);
  assert.match(wxss, /\.project-task-empty\s*\{[^}]*display:\s*flex;[^}]*flex:\s*1;[^}]*align-items:\s*center;/s);
  assert.match(wxss, /\.project-task-row \.todo-title\s*\{[^}]*white-space:\s*normal;[^}]*word-break:\s*break-word;/s);
});

test('计划页：项目内联子任务的勾选与标题编辑入口均提供至少 56rpx 热区', () => {
  const wxml = fs.readFileSync(plansWxmlPath, 'utf8');
  const wxss = fs.readFileSync(plansWxssPath, 'utf8');

  assert.equal(
    (wxml.match(/class="project-task-check" role="button"[^>]*data-id="\{\{task\.id\}\}" data-status="\{\{task\.status\}\}" bindtap="toggleTask"/g) || []).length,
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
  const wxss = fs.readFileSync(plansWxssPath, 'utf8');

  assert.match(wxml, /class="[^"]*todo-title[^"]*"[^>]*data-id="{{task.id}}"[^>]*bindtap="openTodoTitleEditor"/);
  assert.match(wxml, /<input wx:if="{{todoTitleEditTaskId === task.id && todoTitleEditSource === 'todo'}}" class="todo-title-input"[^>]*focus="{{true}}"[^>]*bindinput="onTodoTitleInput"[^>]*bindblur="saveTodoTitle"[^>]*bindconfirm="saveTodoTitle"/);
  assert.doesNotMatch(wxml, /bindtap="openTaskEditor"/);
  assert.doesNotMatch(wxml, /taskEditor\.mode/);
  assert.match(wxml, /<sheet-header title="新建 TODO"/);
  assert.doesNotMatch(wxml, /taskEditor\.projectOptions|taskEditor\.projectIndex|taskEditor\.projectTitle|onTaskProjectChange/);
  assert.doesNotMatch(wxss, /\.task-project-picker\s*\{/);
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

test('计划页：顶部 TODO 隐藏今天不发生的纯固定日程，但项目卡仍保留任务', () => {
  const tasks = [
    { id: 'task_hidden', title: '周末任务', status: TASK_STATUS.TODO, projectId: 'project_1', updatedAt: 1 },
    { id: 'task_visible', title: '普通任务', status: TASK_STATUS.TODO, projectId: 'project_1', updatedAt: 2 }
  ];
  const planStates = new Map([
    ['task_hidden', {
      topVisible: false,
      controlKind: 'schedule',
      candidates: [],
      entityPlans: [],
      repeatRules: [{ id: 'rule_weekend' }],
      activeRepeatRules: [{ id: 'rule_weekend' }]
    }]
  ]);
  const harness = createHarness({ tasks, planStates });
  try {
    harness.page.refresh();
    assert.deepEqual(harness.page.data.todoListTasks.map((task) => task.id), ['task_visible']);
    assert.equal(harness.page.data.projectCards[0].todoTasks.some((task) => task.id === 'task_hidden'), true);
    assert.equal(harness.page.data.projectCards[0].todoTasks.find((task) => task.id === 'task_hidden').controlKind, 'schedule');
  } finally {
    harness.restore();
  }
});

test('计划页：保持前台跨过本地零点时刷新计划派生状态并在隐藏时清理定时器', () => {
  const harness = createHarness();
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const originalDateNow = Date.now;
  const scheduled = [];
  const cleared = [];
  let timerId = 0;
  Date.now = () => new Date(2026, 7, 12, 23, 59, 59, 900).getTime();
  global.setTimeout = (callback, delay) => {
    timerId += 1;
    scheduled.push({ id: timerId, callback, delay });
    return timerId;
  };
  global.clearTimeout = (id) => { cleared.push(id); };
  try {
    harness.page.onShow();
    assert.equal(harness.calls.refreshTaskPlanStatuses.length, 1);
    assert.equal(scheduled.length, 1);
    assert.ok(scheduled[0].delay >= 100 && scheduled[0].delay <= 200);

    scheduled[0].callback();
    assert.equal(harness.calls.refreshTaskPlanStatuses.length, 2);
    assert.equal(scheduled.length, 2);

    harness.page.onHide();
    assert.equal(cleared.includes(scheduled[1].id), true);
  } finally {
    harness.page.clearNextLocalDayRefresh();
    Date.now = originalDateNow;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    harness.restore();
  }
});

test('计划页：计划任务单候选直接计时，多候选先选择，同一任务计时中直接前往计时页', () => {
  const tasks = [{ id: 'task_plan', title: '计划任务', status: TASK_STATUS.TODO, projectId: null, updatedAt: 1 }];
  const state = {
    topVisible: true,
    controlKind: 'timer',
    timerMatchesTask: false,
    timerStatus: 'idle',
    candidates: [{ id: 'event:event_1', title: '上午计划', startedAt: 1, endedAt: 2 }],
    entityPlans: [{ id: 'event_1' }],
    repeatRules: [],
    activeRepeatRules: []
  };
  const planStates = new Map([['task_plan', state]]);
  const harness = createHarness({ tasks, planStates });
  try {
    harness.page.refresh();
    harness.page.toggleTask(event('task_plan', TASK_STATUS.TODO));
    assert.deepEqual(harness.calls.startTaskPlanTimer, [['task_plan', 'event:event_1']]);
    assert.deepEqual(harness.wxState.switchTab, { url: '/pages/timer/index' });

    state.candidates = [
      { id: 'event:event_1', title: '上午计划', startedAt: 1, endedAt: 2 },
      { id: 'event:event_2', title: '下午计划', startedAt: 3, endedAt: 4 }
    ];
    harness.page.refresh();
    harness.page.toggleTask(event('task_plan', TASK_STATUS.TODO));
    assert.deepEqual(harness.wxState.actionSheet.itemList, ['上午计划', '下午计划']);
    harness.wxState.actionSheet.success({ tapIndex: 1 });
    assert.deepEqual(harness.calls.startTaskPlanTimer.at(-1), ['task_plan', 'event:event_2']);

    state.timerMatchesTask = true;
    state.timerStatus = 'paused';
    harness.page.refresh();
    harness.calls.startTaskPlanTimer.length = 0;
    harness.page.toggleTask(event('task_plan', TASK_STATUS.TODO));
    assert.equal(harness.calls.startTaskPlanTimer.length, 0);
    assert.deepEqual(harness.wxState.switchTab, { url: '/pages/timer/index' });
  } finally {
    harness.restore();
  }
});

test('计划页：自动完成任务取消勾选前确认删除完成证据，删除提示汇总全部计划关联', () => {
  const undoLog = {
    id: 'log_trigger',
    taskNameSnapshot: '完成任务',
    note: '收尾复盘',
    startedAt: new Date(2026, 7, 12, 9, 5).getTime(),
    endedAt: new Date(2026, 7, 12, 9, 35).getTime()
  };
  const tasks = [{ id: 'task_done_plan', title: '完成任务', status: TASK_STATUS.COMPLETED, projectId: null, updatedAt: 1 }];
  const planStates = new Map([['task_done_plan', {
    topVisible: true,
    controlKind: 'checkbox',
    candidates: [],
    entityPlans: [{ id: 'event_1' }, { id: 'event_2' }],
    repeatRules: [{ id: 'rule_1' }],
    activeRepeatRules: [],
    completionUndoLog: undoLog
  }]]);
  const harness = createHarness({ tasks, planStates });
  try {
    harness.page.refresh();
    harness.page.toggleTask(event('task_done_plan', TASK_STATUS.COMPLETED));
    assert.equal(
      harness.wxState.modal.content,
      '重新打开会删除以下时间记录：\n完成任务\n2026-08-12 09:05 – 2026-08-12 09:35\n是否继续？'
    );
    harness.wxState.modal.success({ confirm: true });
    assert.deepEqual(harness.calls.reopenTaskByRemovingCompletionLog, [['task_done_plan', 'log_trigger', true]]);

    harness.page.confirmDeleteTask(event('task_done_plan'));
    assert.match(harness.wxState.modal.content, /2 个实体计划/);
    assert.match(harness.wxState.modal.content, /1 个固定日程/);
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
    assert.equal(harness.page.data.projectCards[0].completedToggleText, '收起已完成项');
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

test('计划页：TODO 默认按创建时间最新在前排序', () => {
  const tasks = [
    { id: 'task_early', title: '较早创建', status: TASK_STATUS.TODO, projectId: null, projectNameSnapshot: '', createdAt: 100 },
    { id: 'task_latest', title: '最新创建', status: TASK_STATUS.TODO, projectId: null, projectNameSnapshot: '', createdAt: 300 },
    { id: 'task_middle', title: '中间创建', status: TASK_STATUS.TODO, projectId: null, projectNameSnapshot: '', createdAt: 200 }
  ];
  const harness = createHarness({ tasks });
  try {
    harness.page.refresh();

    assert.deepEqual(harness.page.data.todoSortCriteria, [{ field: 'createdAt', direction: 'desc' }]);
    assert.deepEqual(harness.page.data.todoListTasks.map((task) => task.id), ['task_latest', 'task_middle', 'task_early']);
  } finally {
    harness.restore();
  }
});

test('计划页：TODO 可按名称正序或倒序排序', () => {
  const tasks = [
    { id: 'task_bravo', title: 'Bravo', status: TASK_STATUS.TODO, projectId: null, projectNameSnapshot: '', createdAt: 100 },
    { id: 'task_alpha', title: 'Alpha', status: TASK_STATUS.TODO, projectId: null, projectNameSnapshot: '', createdAt: 300 },
    { id: 'task_charlie', title: 'Charlie', status: TASK_STATUS.TODO, projectId: null, projectNameSnapshot: '', createdAt: 200 }
  ];
  const harness = createHarness({ tasks });
  try {
    harness.page.setData({ todoSortCriteria: [{ field: 'title', direction: 'asc' }] });
    harness.page.refresh();
    assert.deepEqual(harness.page.data.todoListTasks.map((task) => task.id), ['task_alpha', 'task_bravo', 'task_charlie']);

    harness.page.setData({ todoSortCriteria: [{ field: 'title', direction: 'desc' }] });
    harness.page.refresh();
    assert.deepEqual(harness.page.data.todoListTasks.map((task) => task.id), ['task_charlie', 'task_bravo', 'task_alpha']);
  } finally {
    harness.restore();
  }
});

test('计划页：TODO 使用当前项目标题展示，失效关系只显示原项目快照', () => {
  const currentProject = {
    id: 'project_current',
    title: '新项目名',
    status: 'active',
    deadlineAt: 1_700_100_000_000
  };
  const tasks = [
    { id: 'task_todo', title: '未完成', status: TASK_STATUS.TODO, projectId: currentProject.id, projectNameSnapshot: '旧项目名', createdAt: 400 },
    { id: 'task_done', title: '已完成', status: TASK_STATUS.COMPLETED, projectId: currentProject.id, projectNameSnapshot: '旧项目名', createdAt: 300 },
    { id: 'task_historical', title: '历史任务', status: TASK_STATUS.COMPLETED, projectId: null, projectNameSnapshot: '已放弃项目', createdAt: 200 },
    { id: 'task_unlinked', title: '独立任务', status: TASK_STATUS.TODO, projectId: null, projectNameSnapshot: null, createdAt: 100 }
  ];
  const harness = createHarness({ projects: [currentProject], tasks });
  try {
    harness.page.refresh();

    const tasksById = new Map(harness.page.data.todoListTasks.map((task) => [task.id, task]));
    assert.deepEqual(
      [tasksById.get('task_todo').projectDisplayName, tasksById.get('task_todo').hasCurrentProject],
      ['新项目名', true]
    );
    assert.deepEqual(
      [tasksById.get('task_done').projectDisplayName, tasksById.get('task_done').hasCurrentProject],
      ['新项目名', true]
    );
    assert.deepEqual(
      [tasksById.get('task_historical').projectDisplayName, tasksById.get('task_historical').hasCurrentProject],
      ['原项目：已放弃项目', false]
    );
    assert.deepEqual(
      [tasksById.get('task_unlinked').projectDisplayName, tasksById.get('task_unlinked').hasCurrentProject],
      ['', false]
    );
    assert.equal(tasksById.get('task_todo').projectNameSnapshot, '旧项目名');

    const wxml = fs.readFileSync(plansWxmlPath, 'utf8');
    assert.match(wxml, /wx:if="\{\{task\.projectDisplayName\}\}" class="todo-project">\{\{task\.projectDisplayName\}\}<\/view>/);
  } finally {
    harness.restore();
  }
});

test('计划页：项目排序使用当前项目标题，历史快照与未关联任务同组', () => {
  const projects = [
    { id: 'project_a', title: 'Z 项目', status: 'active', deadlineAt: 1_700_100_000_000 },
    { id: 'project_b', title: 'A 项目', status: 'active', deadlineAt: 1_700_200_000_000 }
  ];
  const tasks = [
    { id: 'task_unlinked', title: 'Zulu', status: TASK_STATUS.TODO, projectId: null, projectNameSnapshot: '', createdAt: 500 },
    { id: 'task_historical', title: 'Alpha', status: TASK_STATUS.COMPLETED, projectId: null, projectNameSnapshot: '历史 A 项目', createdAt: 400 },
    { id: 'task_beta', title: 'Beta', status: TASK_STATUS.TODO, projectId: 'project_a', projectNameSnapshot: 'A 项目', createdAt: 300 },
    { id: 'task_alpha', title: 'Alpha', status: TASK_STATUS.TODO, projectId: 'project_a', projectNameSnapshot: 'A 项目', createdAt: 200 },
    { id: 'task_project_b', title: '任意标题', status: TASK_STATUS.TODO, projectId: 'project_b', projectNameSnapshot: 'Z 项目', createdAt: 100 }
  ];
  const harness = createHarness({ projects, tasks });
  try {
    harness.page.setData({
      todoSortCriteria: [{ field: 'project', direction: 'asc' }, { field: 'title', direction: 'asc' }]
    });
    harness.page.refresh();
    assert.deepEqual(harness.page.data.todoListTasks.map((task) => task.id), [
      'task_project_b', 'task_alpha', 'task_beta', 'task_historical', 'task_unlinked'
    ]);

    harness.page.setData({
      todoSortCriteria: [{ field: 'project', direction: 'desc' }, { field: 'title', direction: 'asc' }]
    });
    harness.page.refresh();
    assert.deepEqual(harness.page.data.todoListTasks.map((task) => task.id), [
      'task_historical', 'task_unlinked', 'task_alpha', 'task_beta', 'task_project_b'
    ]);
  } finally {
    harness.restore();
  }
});

test('计划页：完成情况排序固定将未完成 TODO 排在前面', () => {
  const tasks = [
    { id: 'task_done_alpha', title: 'Alpha', status: TASK_STATUS.COMPLETED, projectId: null, projectNameSnapshot: '', createdAt: 400 },
    { id: 'task_todo_bravo', title: 'Bravo', status: TASK_STATUS.TODO, projectId: null, projectNameSnapshot: '', createdAt: 300 },
    { id: 'task_todo_alpha', title: 'Alpha', status: TASK_STATUS.TODO, projectId: null, projectNameSnapshot: '', createdAt: 200 },
    { id: 'task_done_bravo', title: 'Bravo', status: TASK_STATUS.COMPLETED, projectId: null, projectNameSnapshot: '', createdAt: 100 }
  ];
  const harness = createHarness({ tasks });
  try {
    harness.page.setData({
      todoSortCriteria: [{ field: 'status', direction: 'asc' }, { field: 'title', direction: 'asc' }]
    });
    harness.page.refresh();

    assert.deepEqual(harness.page.data.todoListTasks.map((task) => task.id), [
      'task_todo_alpha', 'task_todo_bravo', 'task_done_alpha', 'task_done_bravo'
    ]);
  } finally {
    harness.restore();
  }
});

test('计划页：排序面板暂存多级条件，确认后持久化并回到首列', () => {
  const storage = {};
  const firstHarness = createHarness({ storage });
  try {
    firstHarness.page.onLoad();
    firstHarness.page.setData({ todoColumnIndex: 1, todoScrollLeft: 0 });
    firstHarness.page.openTodoSort();

    assert.equal(firstHarness.page.data.isTodoSortOpen, true);
    assert.deepEqual(firstHarness.page.data.todoSortEditorCriteria, [{ field: 'createdAt', direction: 'desc' }]);

    firstHarness.page.addTodoSortCriterion({ currentTarget: { dataset: { field: 'title' } } });
    firstHarness.page.toggleTodoSortDirection({ currentTarget: { dataset: { index: 1 } } });
    firstHarness.page.saveTodoSort();

    assert.equal(firstHarness.page.data.isTodoSortOpen, false);
    assert.equal(firstHarness.page.data.todoColumnIndex, 0);
    assert.deepEqual(firstHarness.page.data.todoSortCriteria, [
      { field: 'createdAt', direction: 'desc' },
      { field: 'title', direction: 'desc' }
    ]);
    assert.deepEqual(storage['plan-and-record.todo-sort.v1'], {
      version: 1,
      profileId: 'profile_plans',
      value: [
        { field: 'createdAt', direction: 'desc' },
        { field: 'title', direction: 'desc' }
      ]
    });
  } finally {
    firstHarness.restore();
  }

  const secondHarness = createHarness({ storage });
  try {
    secondHarness.page.onLoad();
    assert.deepEqual(secondHarness.page.data.todoSortCriteria, [
      { field: 'createdAt', direction: 'desc' },
      { field: 'title', direction: 'desc' }
    ]);
  } finally {
    secondHarness.restore();
  }
});

test('计划页：偏好写入失败时当前会话排序仍生效', () => {
  const preferenceStore = {
    read(name, profileId, fallback) { return structuredClone(fallback); },
    write() { return false; }
  };
  const harness = createHarness({ preferenceStore });
  try {
    harness.page.onLoad();
    harness.page.setData({
      todoSortEditorCriteria: [{ field: 'title', direction: 'asc' }]
    });

    harness.page.saveTodoSort();

    assert.deepEqual(harness.page.data.todoSortCriteria, [{ field: 'title', direction: 'asc' }]);
    assert.equal(harness.wxState.toast.title, '本次设置仅在当前会话生效');
  } finally {
    harness.restore();
  }
});

test('计划页：localProfile 变化时重读偏好并回退新资料库默认值', () => {
  const storage = {};
  const first = createHarness({ storage, profileId: 'profile_a' });
  try {
    first.page.onLoad();
    first.page.setData({ todoSortEditorCriteria: [{ field: 'title', direction: 'asc' }] });
    first.page.saveTodoSort();
    assert.deepEqual(first.page.data.todoSortCriteria, [{ field: 'title', direction: 'asc' }]);

    first.setProfileId('profile_b');
    first.page.refresh();

    assert.deepEqual(first.page.data.todoSortCriteria, [{ field: 'createdAt', direction: 'desc' }]);
    assert.deepEqual(first.page.data.collapsedProjectIds, []);
  } finally {
    first.restore();
  }
});

test('计划页：排序面板只提供未使用条件，并可调整优先级、移除和重置', () => {
  const harness = createHarness();
  try {
    harness.page.openTodoSort();
    assert.deepEqual(harness.page.data.todoSortAvailableFields.map((field) => field.field), ['title', 'project', 'status']);

    harness.page.addTodoSortCriterion({ currentTarget: { dataset: { field: 'title' } } });
    harness.page.addTodoSortCriterion({ currentTarget: { dataset: { field: 'project' } } });
    harness.page.moveTodoSortCriterion({ currentTarget: { dataset: { index: 2, direction: 'up' } } });
    assert.deepEqual(harness.page.data.todoSortEditorCriteria.map((criterion) => criterion.field), ['createdAt', 'project', 'title']);

    harness.page.removeTodoSortCriterion({ currentTarget: { dataset: { index: 1 } } });
    assert.deepEqual(harness.page.data.todoSortEditorCriteria.map((criterion) => criterion.field), ['createdAt', 'title']);

    harness.page.resetTodoSort();
    assert.deepEqual(harness.page.data.todoSortEditorCriteria, [{ field: 'createdAt', direction: 'desc' }]);
    assert.deepEqual(harness.page.data.todoSortEditorItems, [{
      field: 'createdAt', direction: 'desc', label: '创建时间', directionLabel: '最新在前', canMoveUp: false, canMoveDown: false, canRemove: false
    }]);
  } finally {
    harness.restore();
  }
});

test('计划页：TODO 排序入口和多级排序面板使用共享弹窗头部', () => {
  const wxml = fs.readFileSync(plansWxmlPath, 'utf8');
  const wxss = fs.readFileSync(plansWxssPath, 'utf8');

  assert.match(wxml, /class="todo-sort-button" role="button" aria-label="调整 TODO 排序" bindtap="openTodoSort"/);
  assert.match(wxml, /wx:if="{{isTodoSortOpen}}" class="modal-mask" bindtap="dismissTodoSort"><view class="modal todo-sort-modal" catchtap="noop"><sheet-header title="TODO 排序" show-confirm="{{true}}" bind:confirm="saveTodoSort" bind:cancel="dismissTodoSort"/);
  assert.match(wxml, /wx:for="{{todoSortEditorItems}}" wx:for-item="criterion"/);
  assert.match(wxml, /bindtap="toggleTodoSortDirection"/);
  assert.match(wxml, /bindtap="moveTodoSortCriterion"/);
  assert.match(wxml, /bindtap="removeTodoSortCriterion"/);
  assert.match(wxml, /bindtap="resetTodoSort"/);
  assert.match(wxml, /wx:for="{{todoSortAvailableFields}}" wx:for-item="field"/);
  assert.match(wxml, /data-field="{{field.field}}" bindtap="addTodoSortCriterion"/);
  assert.match(wxss, /\.todo-header-actions\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;/s);
  assert.match(wxss, /\.todo-sort-modal\s*\{[^}]*padding-bottom:\s*calc\(36rpx \+ env\(safe-area-inset-bottom\)\);/s);
  assert.match(wxss, /\.todo-sort-row\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;/s);
});

test('计划页：TODO LIST 在排序按钮左侧提供计划关联循环筛选', () => {
  const wxml = fs.readFileSync(plansWxmlPath, 'utf8');
  const wxss = fs.readFileSync(plansWxssPath, 'utf8');
  assert.match(wxml, /class="todo-header-actions"><view class="todo-filter-button"[^>]*aria-label="切换 TODO 显示内容，当前\{\{todoPlanFilterLabel\}\}，点击查看下一种"[^>]*bindtap="cycleTodoPlanFilter"[\s\S]*class="todo-sort-button"[\s\S]*class="section-add todo-add"/);
  assert.match(wxml, /class="todo-filter-label">\{\{todoPlanFilterLabel\}\}<\/text>/);
  assert.match(wxml, /class="todo-filter-switch-icon" aria-hidden="true">↻<\/text>/);
  assert.match(wxml, /class="todo-empty is-one-row">\{\{todoEmptyText\}\}<\/view>/);
  assert.match(wxss, /\.todo-filter-button\s*\{[^}]*height:\s*44rpx;[^}]*border:\s*2rpx solid #78947f;[^}]*border-radius:\s*22rpx;[^}]*background:\s*#e6ece7;[^}]*box-shadow:/s);
  const switchIconStyle = wxss.match(/\.todo-filter-switch-icon\s*\{[^}]*\}/s)[0];
  assert.match(switchIconStyle, /display:\s*flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*color:\s*#78947f;[^}]*line-height:\s*1;/s);
  assert.doesNotMatch(switchIconStyle, /border-radius|background:/);
});

test('计划页：TODO 可按是否关联计划循环筛选，且不影响项目卡片', () => {
  const tasks = [
    { id: 'task_plain', title: '普通任务', status: TASK_STATUS.TODO, projectId: 'project_1', updatedAt: 1 },
    { id: 'task_plan', title: '计划任务', status: TASK_STATUS.TODO, projectId: 'project_1', updatedAt: 2 },
    { id: 'task_hidden', title: '周末任务', status: TASK_STATUS.TODO, projectId: 'project_1', updatedAt: 3 }
  ];
  const planStates = new Map([
    ['task_plan', {
      topVisible: true,
      controlKind: 'timer',
      candidates: [{ id: 'event:event_1' }],
      entityPlans: [{ id: 'event_1' }],
      repeatRules: [],
      activeRepeatRules: [],
      hasPlanAssociations: true
    }],
    ['task_hidden', {
      topVisible: false,
      controlKind: 'schedule',
      candidates: [],
      entityPlans: [],
      repeatRules: [{ id: 'rule_weekend' }],
      activeRepeatRules: [{ id: 'rule_weekend' }],
      hasPlanAssociations: true
    }]
  ]);
  const harness = createHarness({ tasks, planStates });
  try {
    harness.page.refresh();
    assert.equal(harness.page.data.todoPlanFilter, 'all');
    assert.equal(harness.page.data.todoPlanFilterLabel, '查看全部');
    assert.equal(harness.page.data.todoEmptyText, '还没有 TODO，点右上角 + 创建一条。');
    assert.deepEqual(harness.page.data.todoListTasks.map((task) => task.id), ['task_plain', 'task_plan']);

    harness.page.cycleTodoPlanFilter();
    assert.equal(harness.page.data.todoPlanFilter, 'plan');
    assert.equal(harness.page.data.todoPlanFilterLabel, '只看计划');
    assert.deepEqual(harness.page.data.todoListTasks.map((task) => task.id), ['task_plan']);
    assert.equal(harness.page.data.projectCards[0].todoTasks.some((task) => task.id === 'task_plain'), true);
    assert.equal(harness.page.data.projectCards[0].todoTasks.some((task) => task.id === 'task_hidden'), true);

    harness.page.cycleTodoPlanFilter();
    assert.equal(harness.page.data.todoPlanFilter, 'unplanned');
    assert.equal(harness.page.data.todoPlanFilterLabel, '不看计划');
    assert.deepEqual(harness.page.data.todoListTasks.map((task) => task.id), ['task_plain']);

    harness.page.cycleTodoPlanFilter();
    assert.equal(harness.page.data.todoPlanFilter, 'all');
    assert.equal(harness.page.data.todoPlanFilterLabel, '查看全部');
    assert.deepEqual(harness.page.data.todoListTasks.map((task) => task.id), ['task_plain', 'task_plan']);
  } finally {
    harness.restore();
  }
});

test('计划页：TODO 筛选为空时使用对应空态文案，并回到首列', () => {
  const tasks = [
    { id: 'task_plain', title: '普通任务', status: TASK_STATUS.TODO, projectId: null, updatedAt: 1 }
  ];
  const harness = createHarness({ tasks });
  try {
    harness.page.setData({ todoColumnIndex: 2, todoScrollLeft: 240 });
    harness.page.refresh();
    harness.page.cycleTodoPlanFilter();
    assert.equal(harness.page.data.todoPlanFilterLabel, '只看计划');
    assert.deepEqual(harness.page.data.todoListTasks, []);
    assert.equal(harness.page.data.todoEmptyText, '当前没有关联计划的 TODO。');
    assert.equal(harness.page.data.todoColumnIndex, 0);

    harness.page.cycleTodoPlanFilter();
    assert.equal(harness.page.data.todoPlanFilterLabel, '不看计划');
    assert.deepEqual(harness.page.data.todoListTasks.map((task) => task.id), ['task_plain']);
    assert.equal(harness.page.data.todoEmptyText, '当前没有未关联计划的 TODO。');
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
  try {
    global.wx.getWindowInfo = () => ({ windowWidth: 0 });
    global.wx.getSystemInfoSync = () => { throw new Error('legacy API unavailable'); };
    global.wx.createSelectorQuery = () => ({
      selectAll(selector) {
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
