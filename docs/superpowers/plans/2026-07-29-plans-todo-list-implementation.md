# 计划页 TODO LIST 重构 Implementation Plan（已完成）

> 状态：已完成并归档。实现已于 2026-07-29 合并至提交 `d7593be`；本文是历史执行计划，不再作为当前待办或产品规则。
>
> 当前语义以[产品设计基线](../../product-design.zh-CN.md)为准：独立 TODO 入口最终位于 TODO LIST 标题区，单任务删除采用产品基线 5.2 的最终删除与历史保全规则。
>
> 勾选说明：`[x]` 表示最终产物或历史执行记录可复核；当时未保留输出的“先运行并确认失败”步骤不回填为完成。完整模拟器矩阵与真机验收继续保持未勾选。

**Goal:** 将计划页重构为“顶部 TODO LIST + 项目内子任务 + 右下角独立 TODO”，并彻底移除 `inbox` 状态与任务收集流程。

**Architecture:** 领域层将 `Task.status` 收敛为 `todo / completed`，由 `ApplicationService.deleteTask` 原子地删除任务并断开所有引用。计划页保持单页和现有底部弹层机制，使用稳定 ID 驱动项目、OKR 和子任务上下文；顶部滚动清单显示全部任务，页面只将新任务创建为 `todo`。

**Tech Stack:** 微信小程序原生 Page/WXML/WXSS、CommonJS、Node 内置 `node:test`、本地 `ApplicationService` / `LocalRepository`。

## Global Constraints

- 文案、注释和文档使用 UTF-8 中文；标识符保持英文。
- `Task.status` 只能是 `todo` 或 `completed`；不提供 `inbox` 的读取、迁移或导入兼容，旧本地开发快照需要清空。
- 任务删除必须二次确认，并保留日历、重复规则、例外、日志与计时草稿，清空失效 `taskId` 并保留任务名称快照。
- 删除任务不得清除其他有效 `projectId`；不得级联删除计划、重复规则或日志。
- 不修改 `miniprogram/pages/plans/index.json` 或 `miniprogram/app.json`，不新增第三方依赖。
- TODO LIST 卡片固定 `420rpx` 高；悬浮新增按钮必须避开原生 tabBar 与 `env(safe-area-inset-bottom)`。

---

## File Structure

- `miniprogram/domain/constants.js`：唯一的任务状态枚举来源，移除 `INBOX`。
- `miniprogram/services/application-service.js`：任务状态校验、默认 TODO 创建与原子 `deleteTask`。
- `docs/product-design.zh-CN.md`：任务状态、计划页入口、删除边界的权威定义。
- `miniprogram/pages/plans/index.js`：页面投影、底部弹层状态与所有计划页事件。
- `miniprogram/pages/plans/index.wxml`：TODO LIST、项目上下文入口、愿望池折叠和弹层结构。
- `miniprogram/pages/plans/index.wxss`：固定高度列表、紧凑行、悬浮按钮与折叠/弹层样式。
- `tests/application-service.test.js`：任务状态与删除断链服务回归。
- `tests/json-snapshot.test.js`：`inbox` 快照被拒绝的协议回归。
- `tests/plans-page.test.js`：计划页控制器的任务入口、关联、删除和子任务投影测试。
- `tests/m2-m4-page-regression.test.js`：页面结构和已移除旧入口的静态回归。

## Task 1: 收敛任务状态并实现原子删除服务

**Files:**
- Modify: `miniprogram/domain/constants.js:29-33`
- Modify: `miniprogram/services/application-service.js:147-191,440-479`
- Modify: `tests/application-service.test.js`
- Modify: `tests/json-snapshot.test.js`

**Interfaces:**
- Produces: `TASK_STATUS = { TODO: 'todo', COMPLETED: 'completed' }`。
- Produces: `ApplicationService.deleteTask(id: string, confirmed: boolean): { id: string, title: string }`。
- Produces: `createTask(input)` 默认写入 `TASK_STATUS.TODO`；`updateTask` 拒绝未定义状态。

- [x] **Step 1: 写出状态与删除断链的失败测试**

在 `tests/application-service.test.js` 增加以下场景：默认新任务为 TODO；非法状态抛 `TASK_STATUS_INVALID`；未确认删除抛 `TASK_DELETE_CONFIRMATION_REQUIRED`；确认删除后任务被移除，而事件、规则 revision、例外 override、日志、运行中 timer draft 和 recovery draft 的 `taskId` 都为 `null`、名称快照为任务标题、其 `projectId` 保持不变。

```js
test('M3：任务仅有 todo/completed 状态，删除任务只断开引用', () => {
  const { service, repository, now } = createHarness();
  const project = service.createProject({ title: '项目', deadlineAt: now() + 86_400_000, objectives: requiredObjectives() });
  const task = service.createTask({ title: '任务', projectId: project.id });
  assert.equal(task.status, 'todo');
  assert.throws(() => service.updateTask(task.id, { status: 'inbox' }), (error) => error.code === 'TASK_STATUS_INVALID');
  assert.throws(() => service.deleteTask(task.id, false), (error) => error.code === 'TASK_DELETE_CONFIRMATION_REQUIRED');
  // 建立 event / rule revision / override / log / timer / recoveryDraft 对 task 的引用后调用：
  service.deleteTask(task.id, true);
  const snapshot = service.snapshot();
  assert.equal(snapshot.tasks.some((item) => item.id === task.id), false);
  assert.equal(snapshot.calendarEvents[0].taskId, null);
  assert.equal(snapshot.calendarEvents[0].taskNameSnapshot, '任务');
  assert.equal(snapshot.calendarEvents[0].projectId, project.id);
});
```

在 `tests/json-snapshot.test.js` 增加：将 `validTask().status` 改为 `inbox` 后 `parseJsonSnapshot` 抛 `IMPORT_SCHEMA_INVALID`。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/application-service.test.js tests/json-snapshot.test.js`

Expected: FAIL，缺少 `deleteTask`，且现有枚举仍接受 `inbox`。

- [x] **Step 3: 实现最小状态收敛和断链逻辑**

在 `constants.js` 改为：

```js
const TASK_STATUS = {
  TODO: 'todo',
  COMPLETED: 'completed'
};
```

在 `ApplicationService` 添加两个内部方法。`createTask` 必须用 `const status = input.status === undefined ? TASK_STATUS.TODO : this.requireTaskStatus(input.status);` 后写入 `status`；`updateTask` 必须在 `input.status !== undefined` 时经过 `requireTaskStatus`，避免空字符串绕过校验：

```js
requireTaskStatus(status) {
  if (!Object.values(TASK_STATUS).includes(status)) {
    throw new DomainError('TASK_STATUS_INVALID', '任务状态无效');
  }
  return status;
}

detachTaskReference(target, task) {
  if (!target || target.taskId !== task.id) return false;
  target.taskId = null;
  target.taskNameSnapshot = target.taskNameSnapshot || task.title;
  return true;
}
```

紧接在 `updateTask` 后实现 `deleteTask`。它必须先验证 `confirmed === true`，然后在同一 `repository.transaction` 内：对 `calendarEvents`、每个 `repeatRules[].revisions`、每个 `occurrenceExceptions[].override`、`timeLogs`、`timer.draft` 与 `recoveryDraft.timer.draft` 调用 `detachTaskReference`；对持久实体写入 `updatedAt = now`；最后从 `database.tasks` 移除目标并返回 `{ id: task.id, title: task.title }`。规则仅在任何 revision 改动时更新 `rule.updatedAt`，例外仅在 override 改动时更新 `exception.updatedAt`。不得改动这些对象的 `projectId`。

`json-snapshot.js` 无需单独硬编码任务状态；它已通过 `validEnum(task.status, TASK_STATUS)` 校验，枚举更新后会自动拒绝 `inbox`。

- [x] **Step 4: 运行定向测试确认通过**

Run: `node --test tests/application-service.test.js tests/json-snapshot.test.js`

Expected: PASS，新增状态和删除测试通过，既有 JSON 协议测试仍通过。

- [x] **Step 5: 提交领域服务变更**

```bash
git add miniprogram/domain/constants.js miniprogram/services/application-service.js tests/application-service.test.js tests/json-snapshot.test.js
git commit -m "feat(tasks): remove inbox and add safe task deletion"
```

## Task 2: 更新权威产品设计与任务协议说明

**Files:**
- Modify: `docs/product-design.zh-CN.md:63-68,116-120,159-174,240-249`

**Interfaces:**
- Consumes: Task 1 的双状态契约与 `deleteTask` 断链语义。
- Produces: 计划页、任务状态和删除边界的单一权威定义。

- [x] **Step 1: 将任务定义替换为双状态 TODO**

把对象表中的“备忘录是尚未整理的收集状态”替换为“任务是可选关联项目的 TODO”；把 3.3 的状态约束改为：`Task.status` 只使用 `todo / completed`，两个新增入口都创建 `todo`，完成任务可重新打开为 `todo`。

- [x] **Step 2: 重写 4.2 的任务交互段落**

在愿望/项目视图定义中写明：页眉之后先放固定 `420rpx` TODO LIST，活动项目位于其后；TODO 行包含勾选、标题、可选项目小字、关联项目、删除；关联菜单第一项为“取消关联”；右下角悬浮 `+` 创建无关联 TODO；项目条目的 `+子任务` 创建关联 TODO，标题打开按未完成/已完成分页的任务弹层；删除旧的任务收集/inbox 整理流程说明。

- [x] **Step 3: 补充 5.2 的单任务删除边界**

新增一条：显式删除任务需要确认，删除任务实体后保留事件、规则、例外、日志与计时草稿，清除其中 `taskId` 并保留 `taskNameSnapshot`；不删除其他实体，也不清除其有效项目关联。

- [x] **Step 4: 检查文档一致性**

Run: `rg -n "inbox|收集箱|整理为待办|任务 / 备忘录" docs/product-design.zh-CN.md`

Expected: 不出现已废弃的任务状态或收集流程；若出现的是导入历史说明，必须同步改为不兼容旧 `inbox` 协议。

- [x] **Step 5: 提交权威文档变更**

```bash
git add docs/product-design.zh-CN.md
git commit -m "docs(product): define direct todo task flow"
```

## Task 3: 为计划页交互写失败测试

**Files:**
- Create: `tests/plans-page.test.js`
- Modify: `tests/m2-m4-page-regression.test.js`

**Interfaces:**
- Consumes: `createTask({ title, projectId?, status })`、`updateTask`、`deleteTask`。
- Produces: 计划页控制器和 WXML 结构的可执行回归保护。

- [x] **Step 1: 建立页面测试 harness 与失败断言**

仿照 `tests/timer-page.test.js` 劫持 `global.Page` 加载 `pages/plans/index.js`；提供 `setData`、`global.getApp`、`global.wx.showToast/showModal/showActionSheet` 的可控替身。测试至少覆盖：

```js
test('计划页：悬浮入口创建无项目 todo，项目入口创建关联 todo', () => {
  page.openStandaloneTask();
  page.onField(inputEvent('taskTitle', '独立任务'));
  page.saveTaskEditor();
  assert.deepEqual(calls.createTask[0], { title: '独立任务', status: TASK_STATUS.TODO });

  page.openChildTask({ currentTarget: { dataset: { id: 'project_1' } } });
  page.onField(inputEvent('taskTitle', '子任务'));
  page.saveTaskEditor();
  assert.deepEqual(calls.createTask[1], { title: '子任务', projectId: 'project_1', status: TASK_STATUS.TODO });
});

test('计划页：关联菜单首项取消关联，删除需确认', () => {
  page.chooseTaskProject(taskEvent('task_1'));
  assert.deepEqual(wxState.actionSheet.itemList, ['取消关联', '项目一']);
  wxState.actionSheet.success({ tapIndex: 0 });
  assert.deepEqual(calls.updateTask.at(-1), ['task_1', { projectId: null }]);
  page.confirmDeleteTask(taskEvent('task_1'));
  wxState.modal.success({ confirm: true });
  assert.deepEqual(calls.deleteTask.at(-1), ['task_1', true]);
});
```

另加 `openProjectTasks` 的未完成/已完成分组断言和 `toggleTask` 的 `completed ↔ todo` 断言。

- [x] **Step 2: 扩充静态结构回归**

在 `m2-m4-page-regression.test.js` 增加：`TODO LIST` 出现在“活动项目”之前；存在 `openStandaloneTask`、`openChildTask`、`openProjectTasks` 与 `openKeyResult`；不存在“任务 / 备忘录”“加入收集箱”“整理为待办”；新建项目表单在弹层条件内而非首屏常驻。

- [ ] **Step 3: 运行测试确认失败**

Run: `node --test tests/plans-page.test.js tests/m2-m4-page-regression.test.js`

Expected: FAIL，当前页面没有新事件、TODO LIST 或新增测试所需状态。

## Task 4: 重构计划页为 TODO LIST 与项目上下文弹层

**Files:**
- Modify: `miniprogram/pages/plans/index.js`
- Modify: `miniprogram/pages/plans/index.wxml`
- Modify: `miniprogram/pages/plans/index.wxss`
- Test: `tests/plans-page.test.js`, `tests/m2-m4-page-regression.test.js`

**Interfaces:**
- Consumes: `ApplicationService.deleteTask(id, true)`、Task 1 的两状态枚举。
- Produces: 由稳定项目/任务 ID 驱动的计划页 UI，不再存在全局任务收集表单。

- [x] **Step 1: 替换页面状态与投影函数**

删除 `taskProjectIndex`、`okrProjectIndex`、`addTask`、`organizeTask` 和全局 `addKeyResult` 依赖的索引选择。保留原始 `tasks`，新增如下状态并在 `refresh()` 中生成 `todoListTasks`：

```js
isWishExpanded: false,
isProjectCreateOpen: false,
taskEditor: null, // { mode: 'standalone' | 'child', projectId: string | null, projectTitle: string }
okrEditor: null, // 当前项目对象
projectTaskPanel: null, // { projectId, projectTitle, activeTasks, completedTasks, tab }

const todoListTasks = snapshot.tasks.slice().sort((left, right) => {
  const leftDone = left.status === TASK_STATUS.COMPLETED ? 1 : 0;
  const rightDone = right.status === TASK_STATUS.COMPLETED ? 1 : 0;
  return leftDone - rightDone || right.updatedAt - left.updatedAt;
});
```

`refresh()` 若有 `projectTaskPanel`，必须用其 `projectId` 从新快照重新构造两个任务数组，不能使用显示名称或旧数组下标。

- [x] **Step 2: 实现上下文事件**

新增并使用以下事件：

```js
openStandaloneTask() { this.setData({ taskEditor: { mode: 'standalone', projectId: null, projectTitle: '' }, taskTitle: '' }); }
openChildTask(event) {
  const project = this.data.activeProjects.find((item) => item.id === event.currentTarget.dataset.id);
  if (project) this.setData({ taskEditor: { mode: 'child', projectId: project.id, projectTitle: project.title }, taskTitle: '' });
}
saveTaskEditor() {
  const editor = this.data.taskEditor;
  const input = { title: this.data.taskTitle, status: TASK_STATUS.TODO };
  if (editor.mode === 'child') input.projectId = editor.projectId;
  getService().createTask(input);
  this.setData({ taskEditor: null, taskTitle: '' });
  this.refresh();
}
```

实现 `openProjectTasks`、`switchProjectTaskTab`、`openKeyResult`、`saveKeyResult`、`toggleWishSection`。`saveKeyResult` 每次从 `getService().snapshot().projects` 按 `okrEditor.id` 读取最新项目，再整体提交 objectives。`chooseTaskProject` 通过 `wx.showActionSheet({ itemList: ['取消关联'].concat(activeProjects.map((item) => item.title)) })`，首项调用 `updateTask(id, { projectId: null })`；其余项按索引取得项目 ID。`confirmDeleteTask` 用 `wx.showModal` 的确认回调调用 `deleteTask(id, true)`。

- [x] **Step 3: 重写 WXML 的页面层级**

主内容必须依次渲染：TODO LIST 卡片、活动项目卡片、归档项目卡片、可折叠愿望池。TODO 行采用以下绑定结构，确保事件都有稳定 ID：

```xml
<scroll-view class="todo-list" scroll-y="true">
  <view wx:for="{{todoListTasks}}" wx:key="id" class="todo-row {{item.status === 'completed' ? 'is-completed' : ''}}">
    <view class="todo-check" data-id="{{item.id}}" data-status="{{item.status}}" bindtap="toggleTask">{{item.status === 'completed' ? '✓' : ''}}</view>
    <view class="todo-title">{{item.title}}</view>
    <view wx:if="{{item.projectId}}" class="todo-project">{{item.projectNameSnapshot}}</view>
    <button class="text-button" data-id="{{item.id}}" bindtap="chooseTaskProject">关联</button>
    <button class="danger-button" data-id="{{item.id}}" bindtap="confirmDeleteTask">删除</button>
  </view>
</scroll-view>
```

活动项目标题和列表末尾 `+` 分别绑定 `openProjectTasks` 与 `openProjectCreate`；每项目添加 `openKeyResult`、`openChildTask` 和低频 `openProjectManage`。删除旧的任务收集 WXML 与全局 KR 表单。新增 `taskEditor`、项目任务面板、OKR、新建项目、项目编辑的底部弹层；每个弹层带 `catchtap="noop"`、取消操作和安全区 padding。页末固定添加 `<button class="todo-fab" bindtap="openStandaloneTask">+</button>`。

- [x] **Step 4: 重写 WXSS，保证紧凑但可操作**

新增 `.todo-card { height: 420rpx; }`、`.todo-list { height: 340rpx; }`、`.todo-row { min-height: 84rpx; display: flex; align-items: center; gap: 12rpx; }`、`.todo-check` 的 36rpx 方框与 `.is-completed` 低对比状态。任务标题使用 `flex: 1; min-width: 0;`，项目名称使用小号绿色/灰色文字；“关联”“删除”保持文本按钮，不再新增卡片。悬浮按钮必须使用：

```css
.todo-fab {
  position: fixed;
  z-index: 10;
  right: 32rpx;
  bottom: calc(112rpx + env(safe-area-inset-bottom));
  width: 96rpx;
  height: 96rpx;
  padding: 0;
  border-radius: 50%;
  background: #22c55e;
  color: #052e16;
  font-size: 52rpx;
  line-height: 88rpx;
}
```

将页面底部 padding 调整到至少 `calc(176rpx + env(safe-area-inset-bottom))`，防止愿望池被悬浮按钮遮挡。

- [x] **Step 5: 运行计划页测试确认通过**

Run: `node --test tests/plans-page.test.js tests/m2-m4-page-regression.test.js`

Expected: PASS，任务创建、勾选、关联/取消关联、确认删除、子任务分组和新 WXML 层级均通过。

- [x] **Step 6: 提交页面重构**

```bash
git add miniprogram/pages/plans/index.js miniprogram/pages/plans/index.wxml miniprogram/pages/plans/index.wxss tests/plans-page.test.js tests/m2-m4-page-regression.test.js
git commit -m "feat(plans): add todo list and contextual task actions"
```

## Task 5: 全量回归与微信开发者工具验证

**Files:**
- Verify: 以上所有文件

**Interfaces:**
- Consumes: 完整领域、页面和文档变更。
- Produces: 自动化测试证据和模拟器验证矩阵。

- [x] **Step 1: 运行完整自动化回归与静态检查**

Run: `npm test`

Expected: PASS，包含 JSON 快照、导入导出、服务、页面静态回归和 WXSS 兼容性测试。

- [ ] **Step 2: 检查微信开发者工具路径并编译计划页**

先确认 `.local/wechatide-path.txt` 非空且指向有效目录；按 `wechatide-skill` 的 compiler scene 打开当前仓库根目录（不得硬编码盘符），进入 `pages/plans/index` 并编译。

Expected: 编译成功，无 WXML/WXSS/事件绑定错误。

- [ ] **Step 3: 截图并完成模拟器验证矩阵**

至少验证：空 TODO、长标题、TODO 内滚动、完成/重新打开、关联/取消关联、删除确认/取消、独立/子任务弹层、项目子任务双页签、5 个项目、愿望池折叠、底部安全区与 tabBar 避让。模拟器无法证明真机触控时，将真机项标为“未验证”。

- [x] **Step 4: 检查最终工作树并报告**

Run: `git status --short` 和 `git log --oneline -4`

Expected: 只包含本计划的已提交改动；报告实际验证结果、未验证的真机体验和旧 `inbox` 快照不兼容边界。

## 执行记录（2026-07-29）

- 已完成任务状态收敛、任务删除断链、权威产品文档和计划页重构；`inbox` 不再兼容。
- 自动化回归：当次 `npm test` 全量通过；包含任务状态、删除断链、项目内子任务、取消关联、删除确认与弹层层级回归。测试数量会随仓库演进变化，不在历史计划中固定。
- 微信开发者工具：历史执行记录曾记载计划页 WXML/WXSS 单页编译及空 TODO、独立 TODO 弹层截图；本轮文档治理未能重新复核完整模拟器矩阵，因此不把上述记录视作完整模拟器验收。
- 未验证：完整模拟器场景矩阵、真机触控、长标题、清单滚动、五项目上限及所有任务操作的全组合手工体验，仍需在目标设备上验收。
