# 删除分类并统一为日志标签 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从首版协议中彻底删除 `Category`，让可为空的 `TimeLog.tags` 成为唯一的用户自定义投入维度，并保持计时、日志编辑、统计和 JSON 数据管理闭环一致。

**Architecture:** 新增独立的领域标签模块，统一负责 NFKC 规范化、空白折叠、精确去重和用户写入限制；应用服务只在用户新建或实际修改标签时执行限制，JSON 解析则只规范化而不限制数量或长度。根级资料库、日志、计时草稿、导入合并、统计和页面全部删除分类字段；统计按每个标签独立汇总日志，并为 `tags = []` 生成派生的“无标签”桶。

**Tech Stack:** 微信小程序原生 JavaScript / WXML / WXSS、Node.js `node:test`、本地 JSON 快照仓储。

## Global Constraints

- `APP_SCHEMA_VERSION` 保持 `1`；当前项目尚未发布，不实现旧分类协议的迁移或兼容层。
- `TimeLog.tags` 是字符串数组，允许为空，不新增独立 `Tag` 实体。
- `MAX_TAGS_PER_LOG = 10`，`MAX_TAG_LENGTH = 5`，都在领域常量中维护。
- 标签规范化使用 Unicode NFKC、去除首尾空白、把连续空白折叠为一个半角空格；大小写不等价。
- 用户新建或修改标签时，规范化、去空、按规范化结果精确去重，再校验数量和长度。
- JSON 导入规范化、去空、去重，但允许超过用户写入的数量和长度上限。
- 用户只编辑导入日志的非标签字段时保留超限标签；一旦标签实际发生变化，整个标签集合必须满足当前上限。
- “无标签”只是一项派生统计桶，不是实体或必须选择的默认值。
- 不自动创建提交；完成后保持改动供用户检查。

---

### Task 1: 固化权威产品协议

**Files:**
- Modify: `docs/product-design.zh-CN.md`
- Modify: `docs/phase-1-mvp-development-plan.zh-CN.md`

**Interfaces:**
- Consumes: 用户确认的七项标签规则和后续确认的导入超限编辑规则。
- Produces: 领域、JSON、统计和页面实现唯一遵循的首版产品口径。

- [ ] **Step 1: 改写产品领域模型**

删除 `Category` 对象、`categoryId`、`categoryNameSnapshot`、系统“未分类”、分类管理和分类关系；把日志字段定义为必有 `tags` 数组但允许空数组。

- [ ] **Step 2: 明确标签领域规则**

写明用户输入限制、NFKC 与空白规范化、大小写区分、精确去重、JSON 导入例外、导入超限日志编辑行为，以及标签规则只能由领域层实现。

- [ ] **Step 3: 改写统计和数据管理口径**

标签统计对每个标签分别汇总包含它的纳入范围日志，同一日志在同一标签下最多计一次；空标签数组进入“无标签”桶。JSON 根集合不再包含 `categories`，清空后只建立空资料库。

- [ ] **Step 4: 清理分期文档**

把 MVP 范围、验收路径、OCR/文本 AI 草稿、计时草稿、统计和设置中的“分类”全部改为标签或删除。

- [ ] **Step 5: 检查权威术语**

Run: `rg -n "分类|Category|categories|categoryId|categoryNameSnapshot|DEFAULT_CATEGORY" docs/product-design.zh-CN.md docs/phase-1-mvp-development-plan.zh-CN.md`

Expected: 无输出。

### Task 2: 建立领域标签策略

**Files:**
- Create: `miniprogram/domain/tags.js`
- Modify: `miniprogram/domain/constants.js`
- Create: `tests/tags.test.js`
- Modify: `tests/m0-baseline.test.js`

**Interfaces:**
- Produces: `normalizeTag(value) -> string`、`normalizeTags(tags, { enforceLimits }) -> string[]`、`parseTagsText(value) -> string[]`、`formatTagsText(tags) -> string`、`tagsEqual(first, second) -> boolean`。
- Produces: `MAX_TAGS_PER_LOG`、`MAX_TAG_LENGTH`。

- [ ] **Step 1: 写规范化失败测试**

```js
test('标签按 NFKC 和空白规则规范化且大小写不合并', () => {
  assert.deepEqual(
    normalizeTags([' ＡＩ ', '深  度', 'AI', 'ＡＩ', '']),
    ['AI', '深 度']
  );
});
```

- [ ] **Step 2: 写用户限制失败测试**

```js
test('用户标签最多十个且每个最多五个 Unicode 字符', () => {
  assert.throws(() => normalizeTags(['一二三四五六']), error => error.code === 'TAG_TOO_LONG');
  assert.throws(
    () => normalizeTags(Array.from({ length: 11 }, (_, index) => String(index))),
    error => error.code === 'TAG_COUNT_EXCEEDED'
  );
});
```

- [ ] **Step 3: 运行并确认 RED**

Run: `node --test tests/tags.test.js tests/m0-baseline.test.js`

Expected: FAIL，原因是标签模块与新常量尚不存在。

- [ ] **Step 4: 实现领域标签模块**

```js
function normalizeTag(value) {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

function normalizeTags(tags, { enforceLimits = true } = {}) {
  // 严格要求字符串数组；规范化、去空、保持顺序并精确去重；
  // enforceLimits=true 时使用两个领域常量校验。
}
```

长度使用 `Array.from(tag).length` 计算 Unicode 码点数，大小写原样保留。

- [ ] **Step 5: 运行并确认 GREEN**

Run: `node --test tests/tags.test.js tests/m0-baseline.test.js`

Expected: PASS。

### Task 3: 删除分类持久化协议并规范化 JSON 标签

**Files:**
- Modify: `miniprogram/domain/entities.js`
- Modify: `miniprogram/repository/json-snapshot.js`
- Modify: `miniprogram/repository/json-import.js`
- Modify: `tests/json-snapshot.test.js`
- Modify: `tests/json-import.test.js`
- Modify: `tests/local-repository-data-management.test.js`

**Interfaces:**
- Consumes: `normalizeTags(tags, { enforceLimits: false })`。
- Produces: 不含 `categories`、`categoryId`、`categoryNameSnapshot` 的 schema v1 快照。

- [ ] **Step 1: 更新快照测试为新根结构**

根必填集合只包含 `wishes/projects/tasks/calendarEvents/repeatRules/occurrenceExceptions/timeLogs`；日志不含分类字段，仍要求 `tags`。

- [ ] **Step 2: 添加 JSON 导入规范化失败测试**

```js
test('JSON 导入规范化去空去重但允许超长和超过十个标签', () => {
  const database = completeSnapshot();
  database.timeLogs.push({
    ...validLog(),
    tags: [' ＡＩ ', '', 'AI', '超过五个字符', ...Array.from({ length: 11 }, (_, i) => `标签${i}`)]
  });
  const parsed = parseJsonSnapshot(JSON.stringify(database));
  assert.equal(parsed.timeLogs[0].tags[0], 'AI');
  assert.equal(parsed.timeLogs[0].tags.includes(''), false);
  assert.ok(parsed.timeLogs[0].tags.length > MAX_TAGS_PER_LOG);
});
```

- [ ] **Step 3: 运行并确认 RED**

Run: `node --test tests/json-snapshot.test.js tests/json-import.test.js tests/local-repository-data-management.test.js`

Expected: FAIL，原因是快照仍要求分类集合和字段，且导入尚未调用标签规范化。

- [ ] **Step 4: 重构实体和快照协议**

`createInitialDatabase()` 删除 `categories`；`createTimeLog()` 删除两个分类字段。JSON 已知根集合和日志/草稿字段同步删除分类；解析日志及计时草稿时以 `enforceLimits: false` 规范化标签；持久化校验要求标签已经规范化、非空、无重复，但不检查数量与长度。根计时器处于非 `idle` 状态时，草稿必须持久化 `tags` 数组（允许为空）。

- [ ] **Step 5: 重构导入集合与引用修复**

`ENTITY_COLLECTIONS` 删除 `categories`；删除分类合并计数和缺失分类修复。其他计划、任务、规则引用修复保持不变。

- [ ] **Step 6: 更新 reset 和损坏保护测试**

reset 断言空资料库不具有 `categories`；重复 ID 损坏测试改用其他顶层实体。

- [ ] **Step 7: 运行并确认 GREEN**

Run: `node --test tests/json-snapshot.test.js tests/json-import.test.js tests/local-repository-data-management.test.js`

Expected: PASS。

### Task 4: 应用服务统一执行用户标签规则

**Files:**
- Modify: `miniprogram/services/application-service.js`
- Modify: `tests/application-service.test.js`

**Interfaces:**
- Consumes: `normalizeTags`、`tagsEqual`。
- Produces: 所有日志与计时器写入口统一执行标签规则；非标签编辑保留导入的超限标签。

- [ ] **Step 1: 添加新建和计时写入失败测试**

覆盖 `createManualLog`、`confirmVirtualOccurrence`、`startTimer`、`updateTimerDraft`、`createRecoveryCandidate`：规范化后保存；超过用户限制时返回 `TAG_TOO_LONG` 或 `TAG_COUNT_EXCEEDED`。

- [ ] **Step 2: 添加导入超限标签编辑失败测试**

```js
test('非标签编辑保留导入超限标签，实际改标签后执行完整限制', () => {
  // 直接把合法字符串但超限的导入日志放入资料库。
  // updateLog(id, { note: '只改备注' }) 成功并保留 tags。
  // updateLog(id, { tags: 原数组副本 }) 视为未变化并保留。
  // updateLog(id, { tags: 原数组.concat('新增') }) 抛 TAG_COUNT_EXCEEDED。
});
```

- [ ] **Step 3: 运行并确认 RED**

Run: `node --test tests/application-service.test.js`

Expected: FAIL，原因是服务仍依赖分类且未执行领域标签策略。

- [ ] **Step 4: 删除分类应用服务**

删除默认分类导入、分类 CRUD、分类关联解析与保留逻辑；`resolveNewRecordAssociations` 和 `resolveRecordUpdateAssociations` 只处理计划关系。

- [ ] **Step 5: 接入所有标签写入口**

新建日志和计时草稿使用 `normalizeTags(..., { enforceLimits: true })`。更新日志时先以不限额方式规范化输入并与当前标签逐项比较；相同则保留当前值，不同则执行完整用户限制。

- [ ] **Step 6: 运行并确认 GREEN**

Run: `node --test tests/application-service.test.js`

Expected: PASS。

### Task 5: 将分类统计替换为标签统计

**Files:**
- Modify: `miniprogram/domain/statistics.js`
- Modify: `tests/statistics.test.js`

**Interfaces:**
- Produces: `buildStatistics(...).tags`，每项包含稳定页面 key、标签值或 `null`、显示名称、`isUntagged`、`durationMinutes` 和 `count`。

- [ ] **Step 1: 添加标签与无标签统计失败测试**

```js
test('每个标签独立汇总且同一日志在同一标签只计一次', () => {
  // 60 分钟 [工作, 写作]，30 分钟 [工作]，20 分钟 []
  // 工作=90、写作=60、无标签=20，总投入=110。
});
```

同时覆盖 candidate 开关，并确认项目统计和计划偏差不受标签影响。

- [ ] **Step 2: 运行并确认 RED**

Run: `node --test tests/statistics.test.js`

Expected: FAIL，原因是返回值仍为 `categories`。

- [ ] **Step 3: 实现标签统计**

对每条纳入日志使用其唯一标签集合；空数组使用 `null` 作为派生桶键。每个标签独立累加整条日志时长，不改变 `totalMinutes`。

- [ ] **Step 4: 运行并确认 GREEN**

Run: `node --test tests/statistics.test.js`

Expected: PASS。

### Task 6: 删除页面分类状态并统一标签输入

**Files:**
- Modify: `miniprogram/pages/timer/index.js`
- Modify: `miniprogram/pages/timer/index.wxml`
- Inspect unchanged: `miniprogram/pages/timer/index.wxss`
- Inspect unchanged: `miniprogram/pages/timer/index.json`
- Modify: `miniprogram/pages/calendar/index.js`
- Modify: `miniprogram/pages/calendar/index.wxml`
- Inspect unchanged: `miniprogram/pages/calendar/index.wxss`
- Inspect unchanged: `miniprogram/pages/calendar/index.json`
- Modify: `miniprogram/pages/profile/index.js`
- Modify: `miniprogram/pages/profile/index.wxml`
- Modify: `miniprogram/pages/profile/index.wxss`
- Inspect unchanged: `miniprogram/pages/profile/index.json`
- Inspect unchanged: `miniprogram/app.json`
- Modify: `miniprogram/utils/page.js`
- Modify: `tests/timer-page.test.js`
- Modify: `tests/m2-m4-page-regression.test.js`
- Modify: `tests/profile-data-management.test.js`

**Interfaces:**
- Consumes: `parseTagsText`、`buildStatistics(...).tags`。
- Produces: 不展示或提交任何分类字段的计时、补录、日志编辑和用户统计页面。

- [ ] **Step 1: 更新页面回归测试**

断言计时和日志编辑只提交标签与可选计划块；WXML 不包含“分类：”、`categoryIndex`、`logCategories`；用户页包含“标签投入”和“无标签”展示，不包含“分类管理”。

- [ ] **Step 2: 运行并确认 RED**

Run: `node --test tests/timer-page.test.js tests/m2-m4-page-regression.test.js tests/profile-data-management.test.js`

Expected: FAIL，原因是页面仍渲染并提交分类。

- [ ] **Step 3: 重构计时页**

删除分类 data、快照筛选、picker、索引和恢复逻辑；所有标签文本经领域 `parseTagsText` 处理。标签提示明确“逗号分隔，最多 10 个，每个 5 字”。

- [ ] **Step 4: 重构日历日志编辑**

删除分类 map、picker、编辑状态和提交字段；保留计划块、备注和标签。编辑器始终提交规范化后的标签，应用服务负责识别导入超限标签是否实际变化。

- [ ] **Step 5: 重构用户页**

把 `categoryStats` 改为 `tagStats`，删除分类管理状态、事件和样式；真实标签显示 `#标签名`，派生桶显示“无标签”，避免与字面标签混淆。

- [ ] **Step 6: 清理公共页面投影**

`miniprogram/utils/page.js` 不再从快照派生活动分类。

- [ ] **Step 7: 运行并确认 GREEN**

Run: `node --test tests/timer-page.test.js tests/m2-m4-page-regression.test.js tests/profile-data-management.test.js`

Expected: PASS。

### Task 7: 全量回归和小程序验收

**Files:**
- Verify: all modified files

**Interfaces:**
- Consumes: Tasks 1-6 的完整新协议。
- Produces: 自动化、静态和模拟器验证证据。

- [ ] **Step 1: 禁用词和结构扫描**

Run: `rg -n "分类|Category|categories|categoryId|categoryNameSnapshot|DEFAULT_CATEGORY" miniprogram docs/product-design.zh-CN.md docs/phase-1-mvp-development-plan.zh-CN.md`

Expected: 无输出；实施计划中的删除说明和测试中的旧字段负向断言不属于生产协议残留。

- [ ] **Step 2: 格式检查**

Run: `git diff --check`

Expected: 无输出。

- [ ] **Step 3: 全量自动测试**

Run: `npm test`

Expected: 退出码 0、零失败；若沙箱出现 `spawn EPERM`，在已获授权的沙箱外重跑同一命令。

- [ ] **Step 4: 页面静态检查**

确认三个目标页面仍在 `app.json` 注册；WXML 的事件绑定都存在于对应 JS；页面 JSON 合法；WXSS 不再包含只服务于分类管理的样式。

- [ ] **Step 5: 检查开发者工具路径**

检查 `.local/wechatide-path.txt` 存在、非空且指向有效目录。无效时把编译和截图标记为未验证，不猜测路径。

- [ ] **Step 6: 可用时编译和截图**

通过 `wechatide-skill` 编译计时页、日历页和用户页；验证空标签、达到限制、超限提示、无标签统计、普通标签统计以及页面底部安全区。模拟器结果与真机结果分开报告。
