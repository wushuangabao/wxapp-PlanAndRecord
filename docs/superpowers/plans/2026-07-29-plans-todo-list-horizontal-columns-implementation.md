# 计划页 TODO LIST 横向任务列 Implementation Plan（已完成）

> 状态：已完成并归档。控制器、WXML/WXSS 与自动化回归已于 2026-07-29 合并至提交 `d7593be`；本文是历史执行计划，不再作为当前待办。
>
> 当前交互以[产品设计基线](../../product-design.zh-CN.md#42-愿望项目视图)为准；新建任务插入开头，其余任务保持保存顺序。
>
> 勾选说明：`[x]` 表示最终产物或历史执行记录可复核；当时未保留输出的“先运行并确认失败”步骤不回填为完成。完整模拟器矩阵与真机验收继续保持未勾选。

**Goal:** 将计划页 TODO LIST 改为每列三条、仅横向拖动且按整列吸附的固定高度任务清单。

**Architecture:** 页面控制器继续从 `ApplicationService.snapshot()` 取得并排序任务，但额外把排序结果投影为三条一组的 `todoListColumns`。`scroll-view` 只接收横向手势；控制器根据已测量的列宽和触摸方向回写 `scroll-left`，从而把视觉位置吸附到整列起点。WXML 与 WXSS 只消费这一视图状态，不改变任务、项目或删除服务的领域语义。

**Tech Stack:** 微信小程序原生 `Page`、`scroll-view`、WXML、WXSS、Node.js 内置测试运行器 (`node --test`)。

## Global Constraints

- TODO 卡片总高保持 `420rpx`；列表区三条任务等高且填满固定高度。
- 排序保持“未完成在前、同状态按 `updatedAt` 倒序”；每三条构成一列。
- 禁止纵向滚动；每列宽 `60%`、列间距 `20%`，横向可见一整列与右侧下一列约三分之一，松手后必须对齐到整列起点。
- 不显示任务行分割线；关联项目仅在 `projectId` 存在时作为任务标题下的小字显示。
- 链接、垃圾桶使用无外部资源的 WXSS 线性图标；保留 `aria-label`、关联菜单、删除二次确认和稳定任务 ID 事件绑定。
- 当前未提交的 `miniprogram/pages/plans/index.wxml`、`miniprogram/pages/plans/index.wxss` 是本次实现的可直接改写基线，不需要保留其现有样式或文字按钮。
- 不改动任务、项目、日历或日志的数据模型、领域服务和产品设计文档。

---

### Task 1: 任务列投影与横向吸附控制器

**Files:**
- Modify: `tests/plans-page.test.js:20-61`
- Modify: `miniprogram/pages/plans/index.js:5-70`

**Interfaces:**
- Consumes: `sortTasks(tasks)` 的任务排序结果，任务对象至少含 `id`、`status` 与 `updatedAt`。
- Produces: `todoListColumns: Array<{ id: string, tasks: Task[] }>`、`todoColumnIndex: number`、`todoColumnStep: number`、`todoScrollLeft: number`，以及 `onTodoTouchStart(event)`、`onTodoScroll(event)`、`onTodoTouchEnd(event)`。

- [x] **Step 1: 写出任务分列和吸附的失败测试**

让 `createHarness` 接收可选 `tasks`，并让 `service.snapshot()` 返回该数组。新增以下测试；它以页面 `refresh()` 验证真实投影，而不导出页面内部辅助函数：

```js
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
    harness.page.onTodoTouchEnd({ changedTouches: [{ pageX: 110 }] });
    assert.deepEqual(
      { index: harness.page.data.todoColumnIndex, left: harness.page.data.todoScrollLeft },
      { index: 0, left: 0 }
    );
  } finally {
    harness.restore();
  }
});
```

- [ ] **Step 2: 运行定向测试并确认失败**

Run: `node --test tests/plans-page.test.js`

Expected: FAIL，`todoListColumns` 为 `undefined`，且页面没有 `onTodoTouchStart`。

- [x] **Step 3: 实现最小分列、测量和吸附状态**

在 `sortTasks` 下方定义常量和辅助函数：

```js
const TODO_COLUMN_SIZE = 3;
const TODO_SWIPE_DISTANCE = 18;

function buildTodoColumns(tasks) {
  return tasks.reduce((columns, task, index) => {
    const columnIndex = Math.floor(index / TODO_COLUMN_SIZE);
    if (!columns[columnIndex]) columns.push({ id: `todo_column_${columnIndex}`, tasks: [] });
    columns[columnIndex].tasks.push(task);
    return columns;
  }, []);
}

function clampTodoColumnIndex(index, columnCount) {
  if (columnCount <= 0) return 0;
  return Math.max(0, Math.min(index, columnCount - 1));
}
```

在 `data` 中新增 `todoListColumns: []`、`todoColumnIndex: 0`、`todoColumnStep: 0` 与 `todoScrollLeft: 0`。`refresh()` 先计算 `todoListTasks` 和 `todoListColumns`，再把现有索引夹在列数范围内；在 `setData` 回调中调用 `measureTodoColumn()`，以便任务增删后重新测量。

实现以下页面方法。`measureTodoColumn()` 在测试环境没有 `wx.createSelectorQuery` 时直接返回；在真机/模拟器中测量第一列的实际像素宽度并保持当前列对齐：

```js
measureTodoColumn() {
  if (!wx.createSelectorQuery) return;
  wx.createSelectorQuery()
    .selectAll('.todo-column')
    .boundingClientRect((rects) => {
      const first = rects && rects[0];
      if (!first || !first.width) return;
      const second = rects[1];
      const step = second ? second.left - first.left : first.width;
      const index = clampTodoColumnIndex(this.data.todoColumnIndex, this.data.todoListColumns.length);
      this.setData({ todoColumnStep: step, todoColumnIndex: index, todoScrollLeft: index * step });
    })
    .exec();
},

snapTodoColumn(index) {
  const nextIndex = clampTodoColumnIndex(index, this.data.todoListColumns.length);
  this.setData({
    todoColumnIndex: nextIndex,
    todoScrollLeft: this.data.todoColumnStep ? nextIndex * this.data.todoColumnStep : 0
  });
},

onTodoTouchStart(event) {
  const touch = event.touches && event.touches[0];
  this.todoTouchStartX = touch ? touch.pageX : null;
},

onTodoScroll(event) {
  this.todoScrollLeft = event.detail.scrollLeft;
},

onTodoTouchEnd(event) {
  const touch = event.changedTouches && event.changedTouches[0];
  const endX = touch ? touch.pageX : null;
  const deltaX = this.todoTouchStartX === null || endX === null ? 0 : this.todoTouchStartX - endX;
  const currentLeft = this.todoScrollLeft === undefined ? this.data.todoScrollLeft : this.todoScrollLeft;
  const nearestIndex = this.data.todoColumnStep ? Math.round(currentLeft / this.data.todoColumnStep) : this.data.todoColumnIndex;
  const nextIndex = Math.abs(deltaX) >= TODO_SWIPE_DISTANCE
    ? this.data.todoColumnIndex + (deltaX > 0 ? 1 : -1)
    : nearestIndex;
  this.todoTouchStartX = null;
  this.snapTodoColumn(nextIndex);
}
```

在 `onReady()` 中调用 `measureTodoColumn()`，使首屏加载后能取得真实列宽。

- [x] **Step 4: 运行定向测试并确认通过**

Run: `node --test tests/plans-page.test.js`

Expected: PASS，既有创建、关联、删除、勾选、项目分栏测试和新增三列/左右吸附测试全部通过。

- [x] **Step 5: 提交控制器与测试**

```bash
git add tests/plans-page.test.js miniprogram/pages/plans/index.js
git commit -m "feat(plans): add todo column snapping"
```

### Task 2: 横向三行列表、项目副标题和图标操作

**Files:**
- Modify: `tests/m2-m4-page-regression.test.js:16-28`
- Modify: `miniprogram/pages/plans/index.wxml:5-16`
- Modify: `miniprogram/pages/plans/index.wxss:10-20`

**Interfaces:**
- Consumes: Task 1 的 `todoListColumns`、`todoScrollLeft` 与触摸/滚动处理器。
- Produces: 仅横向滚动的 TODO `scroll-view`，每列最多三条任务，项目副标题和可访问的链接/垃圾桶图标按钮。

- [x] **Step 1: 为 WXML/WXSS 结构写失败静态回归**

在“计划页以 TODO LIST 和项目上下文入口替代任务收集表单”测试后新增：

```js
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
  assert.match(wxml, /todo-scroll-tail/);
  assert.match(wxss, /\.todo-columns\s*\{[^}]*column-gap:\s*20%/s);
  assert.match(wxss, /\.todo-column\s*\{[^}]*flex:\s*0 0 60%/s);
  assert.match(wxss, /\.todo-scroll-tail\s*\{[^}]*flex:\s*0 0 20%/s);
  assert.doesNotMatch(wxss, /\.todo-row\s*\{[^}]*border-top/s);
});
```

- [ ] **Step 2: 运行静态回归并确认失败**

Run: `node --test tests/m2-m4-page-regression.test.js`

Expected: FAIL，当前 WXML 启用了 `scroll-y`，且不存在列容器、横向事件和图标按钮。

- [x] **Step 3: 重写 TODO 区的 WXML 结构**

保留卡片标题、空态、任务完成事件、项目关联菜单和删除确认事件；将现有单层 `wx:for` 换为以下双层循环。按钮内不放可见文字，以 `aria-label` 提供操作名称：

```xml
<scroll-view wx:else class="todo-list" scroll-x="{{true}}" scroll-left="{{todoScrollLeft}}" scroll-with-animation="{{true}}" bindscroll="onTodoScroll" bindtouchstart="onTodoTouchStart" bindtouchend="onTodoTouchEnd">
  <view class="todo-columns">
    <view wx:for="{{todoListColumns}}" wx:for-item="column" wx:key="id" class="todo-column">
      <view wx:for="{{column.tasks}}" wx:for-item="task" wx:key="id" class="todo-row {{task.status === 'completed' ? 'is-completed' : ''}}">
        <view class="todo-check" data-id="{{task.id}}" data-status="{{task.status}}" bindtap="toggleTask">{{task.status === 'completed' ? '✓' : ''}}</view>
        <view class="todo-main"><view class="todo-title">{{task.title}}</view><view wx:if="{{task.projectId}}" class="todo-project">{{task.projectNameSnapshot}}</view></view>
        <button class="todo-icon-button todo-link-button" aria-label="关联项目" data-id="{{task.id}}" bindtap="chooseTaskProject"><view class="todo-link-icon"></view></button>
        <button class="todo-icon-button todo-delete-button" aria-label="删除" data-id="{{task.id}}" bindtap="confirmDeleteTask"><view class="todo-delete-icon"></view></button>
      </view>
    </view>
    <view class="todo-scroll-tail" aria-hidden="true"></view>
  </view>
</scroll-view>
```

- [x] **Step 4: 重写 TODO 相关 WXSS**

删除 `.todo-row` 的 `border-top` 与文字按钮宽度规则，使用以下尺寸关系：卡片内边距 `30rpx`、页头占 `64rpx`、列表区 `296rpx`；每列宽 `60%` 并以 `20%` 分隔，使操作图标与后一列完成方框拉开，同时保留约三分之一下一列预览。

```css
.todo-card { box-sizing: border-box; height: 420rpx; }
.todo-list, .todo-empty { height: 296rpx; }
.todo-columns { display: flex; column-gap: 20%; height: 100%; }
.todo-column { display: flex; flex: 0 0 60%; flex-direction: column; box-sizing: border-box; height: 100%; }
.todo-scroll-tail { flex: 0 0 20%; }
.todo-row { display: flex; flex: 0 0 33.333333%; align-items: center; box-sizing: border-box; min-height: 0; gap: 12rpx; }
.todo-main { display: flex; flex: 1; flex-direction: column; justify-content: center; min-width: 0; }
.todo-title, .todo-project { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.todo-title { color: #0f172a; font-size: 28rpx; font-weight: 600; }
.todo-project { margin-top: 4rpx; color: #64748b; font-size: 22rpx; }
.todo-icon-button { display: flex; flex: 0 0 56rpx; align-items: center; justify-content: center; width: 56rpx; height: 56rpx; margin: 0; padding: 0; border: 0; background: transparent; }
```

用 `.todo-link-icon` 的两个旋转圆角描边绘制链接，用 `.todo-delete-icon` 的盒体和顶盖绘制垃圾桶；绿色使用 `#15803d`，红色使用 `#dc2626`。完成态继续将标题与项目文字设为 `#94a3b8`，且仅完成态显示删除线。

- [x] **Step 5: 运行页面测试并确认通过**

Run: `node --test tests/plans-page.test.js tests/m2-m4-page-regression.test.js`

Expected: PASS，横向结构、无纵向滚动、列宽、无分割线、图标可访问名称以及原有任务操作测试全部通过。

- [x] **Step 6: 提交页面结构与样式**

```bash
git add tests/m2-m4-page-regression.test.js miniprogram/pages/plans/index.wxml miniprogram/pages/plans/index.wxss
git commit -m "feat(plans): render horizontal todo columns"
```

### Task 3: 完整回归与微信开发者工具验收

**Files:**
- Verify: `tests/plans-page.test.js`
- Verify: `tests/m2-m4-page-regression.test.js`
- Verify: `miniprogram/pages/plans/index.js`
- Verify: `miniprogram/pages/plans/index.wxml`
- Verify: `miniprogram/pages/plans/index.wxss`

**Interfaces:**
- Consumes: Task 1 的控制器和 Task 2 的页面结构。
- Produces: 自动化回归证据、模拟器视觉证据和明确的真机验收边界。

- [x] **Step 1: 运行全量自动化测试与差异检查**

Run: `npm test`

Expected: PASS，所有页面、领域服务、导入导出与静态回归测试通过。

Run: `git diff --check`

Expected: 无空白错误。

- [ ] **Step 2: 检查开发者工具路径并编译计划页**

先执行：

```powershell
$path = Get-Content -Raw -Encoding UTF8 .local/wechatide-path.txt
if (-not $path.Trim() -or -not (Test-Path $path.Trim())) { throw '微信开发者工具路径未配置或无效' }
```

路径有效时，按 `wechatide-skill` 的编译流程打开当前仓库根目录（不得硬编码盘符）、进入 `pages/plans/index` 并编译。路径无效时停止该步骤并报告阻塞，不把静态测试当作模拟器通过。

- [ ] **Step 3: 在模拟器完成视觉验收矩阵**

依次检查并记录截图：空 TODO、3 条 TODO、4 至 6 条 TODO、7 条 TODO、带项目副标题、长标题、完成态、向左/向右轻划后整列吸附、关联菜单、删除确认、TODO LIST 标题区新建按钮与底部安全区。真机只标记为“未验证”，除非实际在真机完成相同手势验收。

- [x] **Step 4: 记录最终工作树**

Run: `git status --short` and `git log --oneline -3`

Expected: 只显示本计划产生的改动或提交；不推送远端，除非用户另行要求。

## 执行记录（2026-07-29）

- 任务分列、列宽测量、横向吸附、尾随占位、图标操作和相关自动化回归已合并至提交 `d7593be`。
- 当次 `npm test` 全量通过；测试数量会随仓库演进变化，不在历史计划中固定。
- 完整模拟器场景矩阵与真机触控手感没有可复核的完整验收记录，仍保持未验证。
