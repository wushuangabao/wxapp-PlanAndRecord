# 文档与代码一致性修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让产品基线、领域模型、JSON 契约、计时与恢复、重复实例、日历重叠提示、页面编辑器及微信基础库配置遵守本轮逐项确认的统一验收标准。

**Architecture:** 先把已确认语义写入权威文档，再以领域校验函数作为所有创建、修改、导入和持久化路径的单一入口；页面只负责收集秒级输入和展示服务层结果。所有可能破坏本地数据的启动、导入和计时异常都在仓储事务边界内验证，失败保持零写入或回滚到原值。

**Tech Stack:** 微信小程序原生 JavaScript / WXML / WXSS / JSON、Node.js `node:test`、本地 `wx.*StorageSync` 与文件系统 API；不新增第三方运行时依赖。

## Global Constraints

> 兼容目标修订（2026-08-04）：原计划采用的 `2.19.4` 曾调整为 `2.19.6`；在该版本的开发者工具启动失败且随后移出当前可选清单后，用户已确认公共目标改为 `2.25.4`、当前回归目标改为 `3.16.2`。`2.19.4` 和 `2.19.6` 仅保留为历史目标说明，以下当前有效要求与验收步骤均以 `2.25.4 / 3.16.2` 为准；运行时双目标验证已完成，模拟器验收结果及剩余真机边界以 MVP 文档为准。

- 文档、界面文案和测试说明使用中文，标识符使用英文，文本文件使用 UTF-8。
- `docs/product-design.zh-CN.md` 是产品语义权威；先完成 Task 1 并通过文档检查，之后才能修改业务代码。
- `schemaVersion` 保持 `1`；项目未发布，不增加迁移层。`TimeLog` 或恢复预览缺少 `pausedDurationSeconds` 时按 `0` 规范化。
- 暂停时长以整秒入库：区间总秒数与累计暂停秒数都由各自总毫秒数向下取整；`durationMinutes = Math.ceil((intervalTotalSeconds - pausedDurationSeconds) / 60)`。
- 日志必须满足 `intervalTotalSeconds > pausedDurationSeconds >= 0`，暂停秒数必须是整数；相等、倒序或不足一整秒的区间均不得生成记录。
- 手工补录、最近记录编辑、恢复修正和日历日志编辑都提供独立的开始/结束日期、一个三列 `HH:mm:ss` 时间选择器和时/分/秒暂停输入；主动计时的暂停值只由计时状态计算，不允许用户改写。
- 未操作的时间控件必须保留原始毫秒时间戳；用户实际修改某一端后，该端按选择的秒值重建且毫秒归零，另一端仍保留原值。
- `pauseTimer`、`resumeTimer`、`finishTimer` 每次公开调用只捕获一次当前时间；墙钟倒退或暂停数据无效时不生成日志，原子地把根计时器置为 idle，并完整保留原计时器到恢复草稿。
- 存在恢复草稿时禁止开始新计时；用户只能修正后生成一条 `confirmed/source=timer` 日志，或放弃草稿。
- `candidate` 类型只表示已持久化的 `TimeLog(status="candidate")`。重复投影是 `type="plan", virtual=true`，恢复预览也不属于 candidate。
- 本地正常路径不创建 candidate；合法导入的 candidate 仍可展示、编辑确认、直接确认或作废，且保留原 `source`。
- JSON 稀疏 occurrence override 的缺失字段继承该逻辑实例唯一有效修订；显式 `null` 不等于缺失。导入后持久化完整 override，后续规则编辑不得反向改变它。
- 新建任务始终为 `status="todo", completedAt=null`；重复写入 completed 是幂等操作，重开清空 `completedAt`，再次完成记录新的时间。
- 所有用户可编辑标题统一 trim、拒绝纯空白，并限制为最多 25 个 Unicode code point；不能使用 JavaScript `String.length` 作为字符数。
- 保存日志时不再提示重叠，统计页不再列重叠；只在日历当前范围内标记所有相交的持久化 confirmed/candidate 日志。相邻区间不算重叠，暂停时长不参与交集扣除。
- 损坏或不支持版本的本地数据启动时零写入；独立恢复页只提供原始数据导出、从 Plan & Record JSON 覆盖恢复、二次确认清空，不提供“重新检测”、增量合并或冲突策略。
- `project.config.json` 的 `2.25.4` 是低版本兼容验证目标，`3.16.2` 是当前版本回归目标；后者不是最低支持版本。仓库不得跟踪个人 `project.private.config.json`。
- 不新增网络请求、登录、云开发、OCR、模型服务或小微 AI Handoff 变更。
- 每个写事务必须在落盘前验证完整候选快照；校验、临时文件清理或写入任一步失败都不得留下部分状态。
- 实施页面任务时必须使用 `ui-style`；执行微信开发者工具验证前先确认 `.local/wechatide-path.txt` 指向有效安装目录。
- 以下事项明确排除：OKR 管理、重复规则“此项及后续”的标题/修订链重叠、删除固定日程种子后重现、统一详情与来源追溯、例行临时导出清理自动重试。
- 不新增“纯本地架构守卫测试”，不调整开发环境 8 秒恢复窗口本身；因时长公式删除强制一分钟属于本计划的计时契约修复，不改变 8 秒阈值。
- “周起始日”及 `document-review-backlog.zh-CN.md` 中其余待复核事项不进入本计划。

---

## 已完成的审查收尾

以下改动已在制定本计划时完成，执行人员不得重复改造为业务功能：

- `docs/document-review-backlog.zh-CN.md` 已记录 5 个延期项：OKR 管理、重复修订语义、固定日程种子删除、统一详情/来源追溯、例行导出清理重试。
- `docs/product-design.zh-CN.md` 与 `docs/phase-1-mvp-development-plan.zh-CN.md` 已移除第一阶段 Memo/备忘录对象，并明确任务可独立创建或可选关联项目。
- `.agents/skills/ui-style/references/style-guide.zh-CN.md` 已改为共享删除图标的当前 `22rpx × 33rpx` 规格。
- 过时的 `docs/superpowers/plans/2026-07-30-remove-categories-and-unify-tags.md` 已删除。
- “纯本地架构守卫测试”和“开发环境 8 秒恢复窗口”不留延期任务。

## File Map

### 新增文件

| 文件 | 单一职责 |
| --- | --- |
| `miniprogram/domain/time-log-overlaps.js` | 按原始时间戳为持久化日志生成对端状态计数。 |
| `miniprogram/utils/log-time-editor.js` | 秒级时间选择值、独立日期、dirty 标志和暂停时分秒之间的纯函数转换。 |
| `miniprogram/utils/wechat-runtime.js` | 对高版本窗口信息 API 做能力检测和低版本降级。 |
| `miniprogram/components/second-time-picker/index.{js,wxml,wxss,json}` | 一个三列 `HH:mm:ss` 选择器，统一发出秒级时间字符串。 |
| `miniprogram/components/pause-duration-input/index.{js,wxml,wxss,json}` | 时/分/秒暂停输入及范围校验事件。 |
| `miniprogram/services/data-recovery-service.js` | 在 ApplicationService 不可用时导出原始值、准备/提交覆盖恢复及严格清空。 |
| `miniprogram/pages/data-recovery/index.{js,wxml,wxss,json}` | 损坏/高版本数据的独立只读恢复界面。 |
| `project.private.config.example.json` | 当前版本 `3.16.2` 的可复制本机配置示例。 |
| `tests/validation.test.js` | Unicode 标题和重复模式领域校验。 |
| `tests/time-contract.test.js` | 秒级日志时长与暂停值的纯领域契约。 |
| `tests/log-time-editor.test.js` | 未编辑保真、编辑归零毫秒、跨日与暂停拆合。 |
| `tests/time-log-overlaps.test.js` | confirmed/candidate 全组合、相邻和多方重叠。 |
| `tests/wechat-runtime.test.js` | 窗口信息新旧 API 降级。 |
| `tests/data-recovery-service.test.js` | 故障启动零写入、原始导出、覆盖恢复和清空原子性。 |
| `tests/data-recovery-page.test.js` | 恢复页文案、按钮边界、二次确认和文件分享手势。 |

### 修改文件

| 文件组 | 责任 |
| --- | --- |
| `docs/product-design.zh-CN.md`、`docs/phase-1-mvp-development-plan.zh-CN.md` | 写入本计划全部已确认产品契约、里程碑归属和验收矩阵。 |
| `miniprogram/domain/validation.js`、`time.js`、`entities.js`、`recurrence.js` | 标题、重复规则、日志时长、暂停值与虚拟实例的领域权威。 |
| `miniprogram/repository/json-snapshot.js`、`json-import.js`、`local-repository.js`、`storage-adapter.js` | 默认值、完整快照校验、稀疏 override 复原、写前校验和启动零写入。 |
| `miniprogram/services/application-service.js`、`bootstrap.js` | 任务状态机、计时转换、重复实例确认、日历重叠读模型和启动模式。 |
| `miniprogram/pages/timer/index.{js,wxml,wxss,json}` | 秒级补录/编辑/恢复表单及异常计时结果处理。 |
| `miniprogram/pages/calendar/index.{js,wxml,wxss,json}` | 跨日秒级日志编辑、虚拟计划语义和重叠标记。 |
| `miniprogram/pages/plans/index.{js,wxml}` | 标题码点限制、任务创建状态及窗口 API 降级。 |
| `miniprogram/pages/profile/index.{js,wxml,wxss}`、`miniprogram/domain/statistics.js` | 删除旧重叠统计和警告块，保持其他统计不变。 |
| `miniprogram/utils/page.js`、`miniprogram/app.js`、`miniprogram/app.json` | 正常服务与恢复服务分流、故障启动路由。 |
| `.gitignore`、`project.config.json` | 私有配置隔离并固定公共低版本验证目标。 |
| `tests/application-service.test.js`、`bootstrap.test.js`、`json-snapshot.test.js`、`json-import.test.js`、`local-repository-data-management.test.js` | 服务、仓储、导入和启动契约回归。 |
| `tests/timer-page.test.js`、`m2-m4-page-regression.test.js`、`plans-page.test.js`、`profile-data-management.test.js`、`statistics.test.js`、`m0-baseline.test.js` | 页面、统计、配置与主路径回归。 |

### 停止跟踪

- `project.private.config.json`：只从 Git 索引移除，必须保留执行人员本机文件；不要删除用户的本地配置。

## Dependency Order

`Task 1 → Task 2/3 → Task 4/5 → Task 6/7 → Task 8/9/10/11 → Task 12`

Task 8 依赖 Task 3 和 Task 6；Task 7 依赖 Task 5；Task 10 依赖 Task 3 与 Task 5 的完整快照校验；Task 12 必须等其余任务全部通过各自测试。

### Task 1: 固化权威产品契约与实施边界

**Files:**
- Modify: `docs/product-design.zh-CN.md`
- Modify: `docs/phase-1-mvp-development-plan.zh-CN.md`
- Test: `tests/m0-baseline.test.js`

**Interfaces:**
- Consumes: 本计划 `Global Constraints` 的全部已确认规则。
- Produces: 后续任务唯一可引用的产品契约；不产生运行时代码接口。

- [ ] **Step 1: 记录当前文档中的旧口径**

Run:

```powershell
rg -n "即时记录|同起止|候选计划|虚拟候选|重叠|恢复|schemaVersion|基础库" docs/product-design.zh-CN.md docs/phase-1-mvp-development-plan.zh-CN.md
```

Expected: 能定位“同起止/候选/保存时重叠或统计重叠”等旧描述；命令只读，不修改文件。

- [ ] **Step 2: 在产品基线写入完整契约**

在 `TimeLog`、计时恢复、重复规则、JSON 导入、日历、数据恢复与标题校验对应章节写入以下等价原文，不在其他文档复制第二份完整定义：

```markdown
- TimeLog 新增 pausedDurationSeconds：非负整数，缺失按 0。
- intervalTotalSeconds = floor((endedAt - startedAt) / 1000)。
- pausedDurationSeconds = floor(累计暂停毫秒 / 1000)。
- 必须满足 intervalTotalSeconds > pausedDurationSeconds。
- durationMinutes = ceil((intervalTotalSeconds - pausedDurationSeconds) / 60)。
- candidate 仅指持久化 TimeLog(status="candidate")；重复实例是 virtual plan。
- occurrence override 缺失字段继承唯一有效修订，显式 null 不继承；导入后保存完整快照。
- 损坏或不支持版本启动时零写入，恢复页无“重新检测”、无增量合并。
- 重叠只在日历逐卡标记，不在保存时提示，不进入统计。
- 用户可编辑标题 trim 后最多 25 个 Unicode code point。
```

同时删除“同起止仍生成一分钟”“允许零分钟”“虚拟实例属于 candidate”“统计页展示重叠分钟”等冲突表述。

- [ ] **Step 3: 同步 MVP 里程碑与验收归属**

把秒级暂停/时间编辑和计时异常归入 M2，把虚拟计划/override/日历重叠归入 M4，把恢复页、双基础库目标和私有配置隔离归入 M6；明确 `3.16.2` 不是最低支持版本。延期项只链接 `document-review-backlog.zh-CN.md`，不写入当前里程碑。

- [ ] **Step 4: 加入文档基线断言并运行**

在 `tests/m0-baseline.test.js` 增加读取两份文档的断言，至少检查公式、`pausedDurationSeconds`、`virtual plan`、`2.25.4`、`3.16.2`，并拒绝旧的“同起止即时记录”和“保存时重叠提醒”。

Run: `node tests/m0-baseline.test.js`

Expected: PASS；`fail 0`。

- [ ] **Step 5: 检查格式并提交**

Run: `git diff --check`

Expected: 无输出，退出码 0。

```powershell
git add docs/product-design.zh-CN.md docs/phase-1-mvp-development-plan.zh-CN.md tests/m0-baseline.test.js
git commit -m "docs: 固化一致性修复契约"
```

### Task 2: 统一 Unicode 标题校验与页面输入

**Files:**
- Create: `tests/validation.test.js`
- Modify: `miniprogram/domain/validation.js`
- Modify: `miniprogram/repository/json-snapshot.js`
- Modify: `miniprogram/services/application-service.js`
- Modify: `miniprogram/pages/plans/index.js`
- Modify: `miniprogram/pages/plans/index.wxml`
- Modify: `miniprogram/pages/calendar/index.js`
- Modify: `miniprogram/pages/calendar/index.wxml`
- Test: `tests/json-snapshot.test.js`
- Test: `tests/plans-page.test.js`
- Test: `tests/m2-m4-page-regression.test.js`

**Interfaces:**
- Consumes: `MAX_TITLE_LENGTH = 25`。
- Produces: `requiredTitle(value, label): string`、`limitTitleCodePoints(value): string`、`normalizeSnapshotTitles(database): database`。

`normalizeSnapshotTitles` 返回深拷贝后的 snapshot：只规范化八类真实标题字段，缺失的 override title 继续缺失，显式 null 继续保留给校验器拒绝；不得就地修改导入调用方传入的对象。

- [ ] **Step 1: 写失败的领域测试**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  requiredTitle,
  limitTitleCodePoints
} = require('../miniprogram/domain/validation');

test('标题按 Unicode code point 限制为 25 个', () => {
  assert.equal(requiredTitle('😀'.repeat(25)), '😀'.repeat(25));
  assert.throws(
    () => requiredTitle('😀'.repeat(26)),
    (error) => error.code === 'TITLE_TOO_LONG'
  );
});

test('标题必须是非空字符串并在保存前 trim', () => {
  assert.equal(requiredTitle('  任务  '), '任务');
  assert.throws(() => requiredTitle('   '));
  assert.throws(() => requiredTitle(123));
});

test('页面截断不拆开代理对', () => {
  assert.equal(limitTitleCodePoints('😀'.repeat(26)), '😀'.repeat(25));
});
```

Run: `node tests/validation.test.js`

Expected: FAIL，原因是 `limitTitleCodePoints` 尚未导出，且 25 个 emoji 被现有 `String.length` 错误拒绝。

- [ ] **Step 2: 实现单一标题规则**

在 `validation.js` 使用：

```js
function limitTitleCodePoints(value) {
  return Array.from(typeof value === 'string' ? value : '')
    .slice(0, MAX_TITLE_LENGTH)
    .join('');
}

function requiredTitle(value, label = '标题') {
  if (typeof value !== 'string') {
    throw new DomainError('TITLE_REQUIRED', label + '不能为空');
  }
  const title = value.trim();
  if (!title) {
    throw new DomainError('TITLE_REQUIRED', label + '不能为空');
  }
  if (Array.from(title).length > MAX_TITLE_LENGTH) {
    throw new DomainError(
      'TITLE_TOO_LONG',
      label + '不能超过 ' + MAX_TITLE_LENGTH + ' 个字符'
    );
  }
  return title;
}
```

所有 Wish、Project、Objective、KeyResult、Task、CalendarEvent、RepeatRule 和已提供的 override title 都调用该函数；非标题快照字段不扩大范围。

- [ ] **Step 3: 让 JSON 先规范化标题再校验**

`normalizeJsonSnapshot` 对每个真实标题执行 trim；override 没有 `title` 时保持缺失，显式 `title: null` 保留到校验阶段并整次拒绝。任一嵌套标题非法时，`parseJsonSnapshot` 必须抛 `IMPORT_SCHEMA_INVALID`，不得返回预览。

在 `tests/json-snapshot.test.js` 用现有 `copySnapshot()/validProject()/validTask()/validEvent()/validRule()` 增加以下具名用例：

- 25 个 emoji 的每类标题可导入，26 个拒绝。
- Objective 和 KeyResult 的纯空白标题拒绝。
- override 缺标题仍保留“缺失”语义，显式 null 拒绝。
- 任一非法标题导致整个快照拒绝，没有部分规范化结果泄露给调用方。

- [ ] **Step 4: 页面输入按码点截断，领域层仍负责最终拒绝**

计划页和日历页持久化标题输入使用 `maxlength="-1"`，input handler 调用 `limitTitleCodePoints(event.detail.value)`。不能依赖 WXML `maxlength="25"`，因为 emoji 会按 UTF-16 code unit 被提前截断。

Run:

```powershell
node tests/validation.test.js
node tests/json-snapshot.test.js
node tests/plans-page.test.js
node tests/m2-m4-page-regression.test.js
```

Expected: 四个文件全部 PASS，`fail 0`。

- [ ] **Step 5: 提交**

```powershell
git add miniprogram/domain/validation.js miniprogram/repository/json-snapshot.js miniprogram/services/application-service.js miniprogram/pages/plans/index.js miniprogram/pages/plans/index.wxml miniprogram/pages/calendar/index.js miniprogram/pages/calendar/index.wxml tests/validation.test.js tests/json-snapshot.test.js tests/plans-page.test.js tests/m2-m4-page-regression.test.js
git commit -m "fix: 统一标题码点校验"
```

### Task 3: 建立秒级 TimeLog 与暂停时长数据契约

**Files:**
- Create: `tests/time-contract.test.js`
- Modify: `miniprogram/domain/time.js`
- Modify: `miniprogram/domain/validation.js`
- Modify: `miniprogram/domain/entities.js`
- Modify: `miniprogram/repository/json-snapshot.js`
- Modify: `miniprogram/repository/local-repository.js`
- Modify: `miniprogram/services/application-service.js`
- Test: `tests/json-snapshot.test.js`
- Test: `tests/json-import.test.js`
- Test: `tests/local-repository-data-management.test.js`
- Test: `tests/application-service.test.js`

**Interfaces:**
- Consumes: Task 2 的标题规范化和现有 `isFiniteTimestamp`。
- Produces: `calculateIntervalTotalSeconds(startedAt, endedAt): number`、`calculatePausedDurationSeconds(pauses): number`、`calculateLogTiming(startedAt, endedAt, pausedDurationSeconds): LogTiming`、`validLogTiming(...): LogTiming`。
- `LogTiming = { intervalTotalSeconds, pausedDurationSeconds, activeDurationSeconds, durationMinutes }`。

- [ ] **Step 1: 写失败的纯领域测试**

```js
test('20 秒记录向上取整为 1 分钟', () => {
  assert.deepEqual(calculateLogTiming(1_000, 21_000, 0), {
    intervalTotalSeconds: 20,
    pausedDurationSeconds: 0,
    activeDurationSeconds: 20,
    durationMinutes: 1
  });
});

test('暂停秒数从区间总秒数扣除', () => {
  assert.equal(calculateLogTiming(1_000, 121_999, 61).durationMinutes, 1);
});

test('区间总秒数必须严格大于暂停秒数', () => {
  assert.throws(() => validLogTiming(1_000, 61_000, 60));
  assert.throws(() => validLogTiming(1_000, 1_999, 0));
});

test('暂停累计毫秒统一向下取整', () => {
  assert.equal(calculatePausedDurationSeconds([
    { startedAt: 1_000, endedAt: 1_999 },
    { startedAt: 2_000, endedAt: 3_001 }
  ]), 2);
});
```

Run: `node tests/time-contract.test.js`

Expected: FAIL，原因是新接口尚不存在。

- [ ] **Step 2: 实现唯一时长计算**

```js
const SECOND_MS = 1000;

function calculateIntervalTotalSeconds(startedAt, endedAt) {
  if (!isFiniteTimestamp(startedAt) || !isFiniteTimestamp(endedAt)) return 0;
  return Math.floor((endedAt - startedAt) / SECOND_MS);
}

function calculatePausedDurationSeconds(pauses) {
  const milliseconds = (pauses || []).reduce(
    (total, pause) => total + (pause.endedAt - pause.startedAt),
    0
  );
  return Math.floor(milliseconds / SECOND_MS);
}

function calculateLogTiming(startedAt, endedAt, pausedDurationSeconds = 0) {
  const intervalTotalSeconds =
    calculateIntervalTotalSeconds(startedAt, endedAt);
  const activeDurationSeconds =
    intervalTotalSeconds - pausedDurationSeconds;
  return {
    intervalTotalSeconds,
    pausedDurationSeconds,
    activeDurationSeconds,
    durationMinutes: Math.ceil(activeDurationSeconds / 60)
  };
}
```

`validLogTiming` 必须先校验两个时间戳、暂停值为非负整数以及严格不等式，再返回上述对象；删除 `calculateLogDurationMinutes` 对同起止强制 1 分钟和手工记录四舍五入分支。

- [ ] **Step 3: 让实体与服务只保存派生结果**

`createTimeLog(input)` 从 `startedAt/endedAt/pausedDurationSeconds` 调用 `validLogTiming`，显式写入 `pausedDurationSeconds` 和派生的 `durationMinutes`，忽略调用方伪造的分钟值。`createManualLog` 默认暂停为 0；`updateLog` 未传暂停值时保留旧值，缩短区间导致旧暂停值非法时整次失败。

- [ ] **Step 4: 同版本默认值与完整快照写前校验**

`normalizeTimeLog` 使用：

```js
pausedDurationSeconds: hasOwn(log, 'pausedDurationSeconds')
  ? log.pausedDurationSeconds
  : 0
```

`validateTimeLog` 要求字段存在、为非负整数、严格小于区间总秒数，且 `durationMinutes` 与 `validLogTiming` 完全相等。`LocalRepository.transaction` 在 `write(next)` 前调用 `validateJsonSnapshot(next)`；用于构造损坏状态的测试改为直接预置 storage，不能绕过生产写入边界。

本地 `schemaVersion=1` 快照在读入 cache 时规范化缺失字段但不立即回写、不创建迁移备份；下一次正常事务自然持久化显式 0。

- [ ] **Step 5: 补齐持久化测试矩阵**

在现有测试中加入：

- 缺字段读取为 0，版本仍为 1，初始化写入次数为 0。
- 导出一定包含显式 `pausedDurationSeconds`。
- 负数、小数、字符串、等于或大于区间秒数均拒绝。
- 分钟数高于或低于公式值均拒绝。
- 缺字段与显式 0 经规范化后 `persistedValueEquals` 相等。
- updateLog 不传暂停值会保留，传入合法新值会重算，非法更新零写入。

Run:

```powershell
node tests/time-contract.test.js
node tests/json-snapshot.test.js
node tests/json-import.test.js
node tests/local-repository-data-management.test.js
node tests/application-service.test.js
```

Expected: 五个文件全部 PASS，`fail 0`。

- [ ] **Step 6: 提交**

```powershell
git add miniprogram/domain/time.js miniprogram/domain/validation.js miniprogram/domain/entities.js miniprogram/repository/json-snapshot.js miniprogram/repository/local-repository.js miniprogram/services/application-service.js tests/time-contract.test.js tests/json-snapshot.test.js tests/json-import.test.js tests/local-repository-data-management.test.js tests/application-service.test.js
git commit -m "feat: 持久化秒级暂停时长"
```

### Task 4: 收紧任务完成状态机

**Files:**
- Modify: `miniprogram/services/application-service.js`
- Modify: `miniprogram/repository/json-snapshot.js`
- Modify: `miniprogram/pages/plans/index.js`
- Test: `tests/application-service.test.js`
- Test: `tests/json-snapshot.test.js`
- Test: `tests/plans-page.test.js`

**Interfaces:**
- Consumes: `TASK_STATUS.TODO`、`TASK_STATUS.COMPLETED`。
- Produces: 保持 `createTask(input): Task` 和 `updateTask(id, input): Task` 签名；创建调用方不再控制状态。

- [ ] **Step 1: 写状态转换失败测试**

```js
test('任务只能以 todo 创建，重复完成保持原 completedAt', () => {
  const { service, setNow } = createHarness();
  const task = service.createTask({ title: '任务', status: 'completed' });
  assert.equal(task.status, 'todo');
  assert.equal(task.completedAt, null);

  setNow(NOW + 1_000);
  const first = service.updateTask(task.id, { status: 'completed' });
  setNow(NOW + 2_000);
  const second = service.updateTask(task.id, { status: 'completed' });
  assert.equal(second.completedAt, first.completedAt);

  service.updateTask(task.id, { status: 'todo' });
  assert.equal(service.snapshot().tasks[0].completedAt, null);
});
```

JSON 测试分别拒绝 `todo + 非 null completedAt` 与 `completed + null completedAt`。

Run: `node tests/application-service.test.js`

Expected: FAIL，现实现允许直接创建 completed，且重复完成会改写时间。

- [ ] **Step 2: 实现幂等状态机**

```js
// createTask
status: TASK_STATUS.TODO,
completedAt: null

// updateTask
const nextStatus = this.requireTaskStatus(input.status);
if (nextStatus === TASK_STATUS.COMPLETED) {
  if (task.status !== TASK_STATUS.COMPLETED) {
    task.completedAt = now;
  }
} else {
  task.completedAt = null;
}
task.status = nextStatus;
```

计划页创建任务时不再传 `status`。导入校验必须满足：

```js
const validCompletionState =
  (task.status === TASK_STATUS.TODO && task.completedAt === null)
  || (task.status === TASK_STATUS.COMPLETED
    && isFiniteTimestamp(task.completedAt));
```

- [ ] **Step 3: 更新只为测试而直接创建 completed 的 fixture**

所有需要完成态的测试先创建 todo，再调用 `updateTask(id, { status: 'completed' })`；JSON 校验 fixture 可以直接构造合法 completed 组合，因为它测试导入边界。

Run:

```powershell
node tests/application-service.test.js
node tests/json-snapshot.test.js
node tests/plans-page.test.js
```

Expected: 三个文件全部 PASS，`fail 0`。

- [ ] **Step 4: 提交**

```powershell
git add miniprogram/services/application-service.js miniprogram/repository/json-snapshot.js miniprogram/pages/plans/index.js tests/application-service.test.js tests/json-snapshot.test.js tests/plans-page.test.js
git commit -m "fix: 收紧任务完成状态机"
```

### Task 5: 统一重复模式并复原 JSON 稀疏 override

**Files:**
- Modify: `miniprogram/domain/validation.js`
- Modify: `miniprogram/domain/entities.js`
- Modify: `miniprogram/domain/recurrence.js`
- Modify: `miniprogram/repository/json-snapshot.js`
- Modify: `miniprogram/repository/json-import.js`
- Modify: `miniprogram/services/application-service.js`
- Test: `tests/validation.test.js`
- Test: `tests/json-snapshot.test.js`
- Test: `tests/json-import.test.js`
- Test: `tests/application-service.test.js`
- Test: `tests/local-repository-data-management.test.js`

**Interfaces:**
- Consumes: Task 2 的 `requiredTitle`、Task 3 的写前完整快照校验，以及现有 `projectRevisionStartedAt(revision, occurrenceStart)`。
- Produces: `canonicalizeRepeatPattern(input): RepeatPattern`、`findUniqueRevisionAt(revisions, occurrenceStart): RepeatRevision`、`materializeOccurrenceOverride(rule, exception): FullOccurrenceOverride`。
- `FullOccurrenceOverride` 固定包含 `title, startedAt, endedAt, priority, projectId, projectNameSnapshot, taskId, taskNameSnapshot`。

- [ ] **Step 1: 写重复模式失败测试**

```js
test('重复模式按频率规范化无关字段', () => {
  assert.deepEqual(canonicalizeRepeatPattern({
    frequency: 'daily', interval: 2, weekdays: [1], monthDay: 9
  }), {
    frequency: 'daily', interval: 2, weekdays: [], monthDay: null
  });
  assert.deepEqual(canonicalizeRepeatPattern({
    frequency: 'weekly', interval: 1, weekdays: [5, 1], monthDay: 9
  }), {
    frequency: 'weekly', interval: 1, weekdays: [1, 5], monthDay: null
  });
});

test('周重复和月重复拒绝不完整或含糊值', () => {
  assert.throws(() => canonicalizeRepeatPattern({
    frequency: 'weekly', interval: 1, weekdays: []
  }));
  assert.throws(() => canonicalizeRepeatPattern({
    frequency: 'weekly', interval: 1, weekdays: [1, 1]
  }));
  assert.throws(() => canonicalizeRepeatPattern({
    frequency: 'monthly', interval: 1, monthDay: 32
  }));
});
```

Run: `node tests/validation.test.js`

Expected: FAIL，`canonicalizeRepeatPattern` 尚不存在。

- [ ] **Step 2: 建立 create/revise/JSON 共用规范化**

每日强制 `weekdays=[]/monthDay=null`；每周要求非空、唯一、0–6 整数并排序，`monthDay=null`；每月要求 1–31 整数并强制 `weekdays=[]`；所有频率的 `interval` 均为正整数。

`createRepeatRule`、`reviseRuleFollowing` 和 `normalizeRevision` 都消费同一函数。本任务不得改变延期的“此项及后续”标题归属、未来修订替换或重叠裁剪语义。

- [ ] **Step 3: 写稀疏 override 失败测试**

在 `tests/json-snapshot.test.js` 和 `tests/json-import.test.js` 分别覆盖：

- 依次缺少 title、startedAt、endedAt、priority、四个关联字段时，从唯一有效修订/规则继承。
- 显式 `null` 的可空关联字段保留为 null；title、startedAt、endedAt、priority 显式 null 整次拒绝。
- 缺少规则、没有有效修订、同时命中多条修订、补全后结束不晚于开始，均整次拒绝。
- 完整 override 导出再导入后语义相等。
- 增量冲突处理后的最终规则链若不能唯一覆盖 override，整次拒绝。

Run: `node tests/json-import.test.js`

Expected: FAIL，当前缺规则 override 会被静默丢弃，稀疏字段也不会补全。

- [ ] **Step 4: 实现完整 override 物化**

```js
function materializeOccurrenceOverride(rule, exception) {
  const revision = findUniqueRevisionAt(
    rule.revisions,
    exception.occurrenceStart
  );
  const startedAt = projectRevisionStartedAt(
    revision,
    exception.occurrenceStart
  );
  const inherited = {
    title: rule.title,
    startedAt,
    endedAt: startedAt + revision.endedAt - revision.startedAt,
    priority: revision.priority,
    projectId: revision.projectId,
    projectNameSnapshot: revision.projectNameSnapshot,
    taskId: revision.taskId,
    taskNameSnapshot: revision.taskNameSnapshot
  };
  const override = {};
  Object.keys(inherited).forEach((field) => {
    override[field] = Object.prototype.hasOwnProperty.call(
      exception.override,
      field
    ) ? exception.override[field] : inherited[field];
  });
  validateFullOccurrenceOverride(override);
  return override;
}
```

`findUniqueRevisionAt` 只接受 `effectiveFrom <= occurrenceStart` 且 `effectiveUntil === null || occurrenceStart <= effectiveUntil` 的修订；命中数量不是 1 时抛 `IMPORT_SCHEMA_INVALID`。`validateFullOccurrenceOverride` 是本任务新增的内部校验器，逐项调用 `requiredTitle`、`validTimeRange`、`validPriority` 和 nullable-string 校验，不对缺失值做第二次继承。

`normalizeJsonSnapshot` 在规则和例外结构规范化后做第二遍物化并存回完整对象。`json-import.js` 在合并冲突后、失效关联修复前再次校验 override 的规则/修订唯一性；缺规则的 `kind="override"` 不得进入 `discardedExceptionCount`，必须抛错。缺规则的 `skip` 保持现有可修复策略。

- [ ] **Step 5: 运行领域、导入和仓储测试**

```powershell
node tests/validation.test.js
node tests/json-snapshot.test.js
node tests/json-import.test.js
node tests/application-service.test.js
node tests/local-repository-data-management.test.js
```

Expected: 五个文件全部 PASS，`fail 0`；规范化后的持久化 override 始终包含八个字段。

- [ ] **Step 6: 提交**

```powershell
git add miniprogram/domain/validation.js miniprogram/domain/entities.js miniprogram/domain/recurrence.js miniprogram/repository/json-snapshot.js miniprogram/repository/json-import.js miniprogram/services/application-service.js tests/validation.test.js tests/json-snapshot.test.js tests/json-import.test.js tests/application-service.test.js tests/local-repository-data-management.test.js
git commit -m "fix: 规范重复规则与稀疏实例覆盖"
```

### Task 6: 统一计时转换的单时刻校验与恢复草稿

**Files:**
- Modify: `miniprogram/domain/time.js`
- Modify: `miniprogram/repository/json-snapshot.js`
- Modify: `miniprogram/services/application-service.js`
- Modify: `miniprogram/services/bootstrap.js`
- Test: `tests/application-service.test.js`
- Test: `tests/bootstrap.test.js`
- Test: `tests/json-snapshot.test.js`

**Interfaces:**
- Consumes: Task 3 的 `validLogTiming`、`calculatePausedDurationSeconds` 和 `createTimeLog`。
- Produces: `validOrderedPauses(pauses, startedAt, capturedNow): boolean`、`validActivePause(timer, capturedNow): boolean`、`inspectTimerAt(timer, capturedNow): TimerInspection`、`moveTimerToRecoveryDraft(database, timer, capturedNow, reason): RecoveryResult`。
- `RecoveryResult = { state: "draft", recoveryDraft }`；正常 `finishTimer` 返回 `{ log }`。

- [ ] **Step 1: 用底层 storage 写入异常计时并编写失败测试**

覆盖以下精确场景：

- pause 时 `capturedNow < startedAt`。
- resume 时 `capturedNow < pausedAt`。
- finish 时暂停区间倒序、相互重叠或结束晚于 `capturedNow`。
- 每个公开操作的 `now` mock 第二次调用会抛错，以证明只捕获一次。
- 异常分支没有新增 TimeLog，根 timer 变 idle，草稿完整保留原 timer。
- 恢复草稿存在时 `startTimer` 抛 `RECOVERY_DRAFT_PENDING`。
- 正常暂停一小时的日志显式保存 `pausedDurationSeconds=3600`。
- 调用方伪造 `finishTimer({ pausedDurationSeconds: 999 })` 不影响自动值。

Run: `node tests/application-service.test.js`

Expected: FAIL，现有 pause/resume/finish 没有共享完整校验。

- [ ] **Step 2: 实现单一计时检查器**

```js
function inspectTimerAt(timer, capturedNow) {
  if (!isFiniteTimestamp(timer.startedAt)
    || capturedNow < timer.startedAt) {
    return { valid: false, reason: 'CLOCK_ROLLBACK' };
  }
  if (!validOrderedPauses(timer.pauses, timer.startedAt, capturedNow)) {
    return { valid: false, reason: 'PAUSES_INVALID' };
  }
  if (timer.status === TIMER_STATUS.RUNNING && timer.pausedAt !== null) {
    return { valid: false, reason: 'TIMER_STATE_INVALID' };
  }
  if (timer.status === TIMER_STATUS.PAUSED
    && !validActivePause(timer, capturedNow)) {
    return { valid: false, reason: 'ACTIVE_PAUSE_INVALID' };
  }
  return { valid: true };
}
```

`validOrderedPauses` 必须检查时间戳有效、`endedAt >= startedAt`、按顺序不重叠、均不晚于 capturedNow；paused 状态的 `pausedAt` 不早于最后一次完整暂停结束且不晚于 capturedNow。

- [ ] **Step 3: 在一个事务中转入恢复草稿**

```js
moveTimerToRecoveryDraft(database, timer, capturedNow, reason) {
  database.timer = createIdleTimer();
  database.recoveryDraft = {
    reason,
    timer: clone(timer),
    createdAt: capturedNow
  };
  return {
    state: 'draft',
    recoveryDraft: clone(database.recoveryDraft)
  };
}
```

`pauseTimer/resumeTimer/finishTimer` 在各自事务开头调用 `inspectTimerAt`；失败立即返回上述结果，不解析关联、不闭合暂停、不创建日志。正常 finish 先闭合活动暂停，计算 `pausedDurationSeconds`，再创建唯一日志。

- [ ] **Step 4: 收紧冷启动恢复**

`recoverTimer(capturedNow)` 复用检查器。墙钟倒退/暂停无效的草稿没有恢复预览；超过恢复窗口但时间状态有效时，只有满足严格时长公式才写 `recoveryPreview`。有效投入为 0 时只保留可修正草稿，不伪造 1 分钟。

删除 `minimumRecoveryDurationMinutes` 配置和断言，但保持 `DEVELOPMENT_RECOVERY_TIMER_SPAN_MS = 8 * 1000` 不变；trial/release/未知环境仍使用 `MAX_TIMER_SPAN_MS`。

- [ ] **Step 5: 验证修正与放弃只消费一次草稿**

增加测试：

- 修正输入包含独立起止时间和暂停秒数，成功创建一条 `confirmed/source=timer`，然后清空草稿。
- 第二次提交同一草稿失败且不新增日志。
- 放弃清空草稿，不创建日志。
- 时间或暂停校验失败保留草稿原值。
- 恢复预览缺暂停字段按 0，导出时显式写出。

Run:

```powershell
node tests/application-service.test.js
node tests/bootstrap.test.js
node tests/json-snapshot.test.js
```

Expected: 三个文件全部 PASS，`fail 0`。

- [ ] **Step 6: 提交**

```powershell
git add miniprogram/domain/time.js miniprogram/repository/json-snapshot.js miniprogram/services/application-service.js miniprogram/services/bootstrap.js tests/application-service.test.js tests/bootstrap.test.js tests/json-snapshot.test.js
git commit -m "fix: 原子处理计时异常恢复"
```

### Task 7: 分离虚拟重复计划与持久化 candidate

**Files:**
- Modify: `miniprogram/domain/recurrence.js`
- Modify: `miniprogram/services/application-service.js`
- Modify: `miniprogram/pages/calendar/index.js`
- Modify: `miniprogram/pages/calendar/index.wxml`
- Modify: `miniprogram/pages/calendar/index.wxss`
- Test: `tests/application-service.test.js`
- Test: `tests/m2-m4-page-regression.test.js`
- Test: `tests/timer-page.test.js`
- Test: `tests/statistics.test.js`

**Interfaces:**
- Consumes: Task 5 的完整 override、Task 3 的日志创建契约。
- Produces: `projectRule(...): VirtualPlan[]`，其中 `type="plan", virtual=true`；`overrideOccurrence(...): { exception, log }`。
- `confirmVirtualOccurrence(input): TimeLog` 保持公共名称，返回一条 `confirmed/source=rule` 日志。

- [ ] **Step 1: 写虚拟计划语义失败测试**

断言：

```js
const [occurrence] = projectRule(rule, rangeStart, rangeEnd, []);
assert.equal(occurrence.type, 'plan');
assert.equal(occurrence.virtual, true);
assert.notEqual(occurrence.type, 'candidate');
```

服务测试分别确认：

- 直接确认虚拟实例只生成一条 confirmed rule 日志。
- 单次修改在同一个 transaction 中写一条完整 override 和一条 confirmed rule 日志。
- 任一写入失败时 override 与日志都不存在。
- 重复确认或重复编辑同一逻辑实例不会生成第二条日志。
- 本地 create/manual/timer/rule 正常路径都不生成 candidate。
- 导入的合法 candidate 仍能直接确认、编辑确认和作废，`source` 不变。

Run: `node tests/application-service.test.js`

Expected: FAIL，当前投影 `type` 是 candidate，单次 override 只保存例外。

- [ ] **Step 2: 修改领域投影和原子单次编辑**

`projectRule` 返回：

```js
{
  type: 'plan',
  virtual: true,
  ruleId: rule.id,
  occurrenceStart,
  originRuleId: rule.id,
  originOccurrenceId,
  title,
  startedAt,
  endedAt,
  priority,
  projectId,
  projectNameSnapshot,
  taskId,
  taskNameSnapshot
}
```

`overrideOccurrence` 在同一仓储事务内：定位唯一实例、拒绝已物化实例、保存 Task 5 的完整 override、按 override 重新投影、创建一条 confirmed/source=rule 日志，返回 `{ exception, log }`。本任务不改变延期的 `reviseRuleFollowing` 修订链语义。

- [ ] **Step 3: 更新日历显示与操作条件**

日历文案固定为：

- `virtual === true`：`重复计划·待确认`，提供确认、修改、跳过。
- `type === "candidate"`：`候选记录`，提供确认、编辑确认、作废。
- `type === "plan" && !virtual`：`计划`。
- `type === "confirmed"`：`实际记录`。

删除计划按钮只对 `type === "plan" && !virtual` 显示；虚拟计划使用计划色，不复用 candidate 色。`includeCandidates` 只筛选持久化 TimeLog，不影响虚拟计划和恢复预览。

- [ ] **Step 4: 运行页面与统计回归**

```powershell
node tests/application-service.test.js
node tests/m2-m4-page-regression.test.js
node tests/timer-page.test.js
node tests/statistics.test.js
```

Expected: 四个文件全部 PASS，`fail 0`；页面源码不再把 `virtual` 映射成 candidate。

- [ ] **Step 5: 提交**

```powershell
git add miniprogram/domain/recurrence.js miniprogram/services/application-service.js miniprogram/pages/calendar/index.js miniprogram/pages/calendar/index.wxml miniprogram/pages/calendar/index.wxss tests/application-service.test.js tests/m2-m4-page-regression.test.js tests/timer-page.test.js tests/statistics.test.js
git commit -m "fix: 分离虚拟计划与候选日志"
```

### Task 8: 提供可复用的秒级时间与暂停编辑器

**Files:**
- Create: `miniprogram/utils/log-time-editor.js`
- Create: `miniprogram/components/second-time-picker/index.js`
- Create: `miniprogram/components/second-time-picker/index.wxml`
- Create: `miniprogram/components/second-time-picker/index.wxss`
- Create: `miniprogram/components/second-time-picker/index.json`
- Create: `miniprogram/components/pause-duration-input/index.js`
- Create: `miniprogram/components/pause-duration-input/index.wxml`
- Create: `miniprogram/components/pause-duration-input/index.wxss`
- Create: `miniprogram/components/pause-duration-input/index.json`
- Create: `tests/log-time-editor.test.js`
- Modify: `miniprogram/pages/timer/index.{js,wxml,wxss,json}`
- Modify: `miniprogram/pages/calendar/index.{js,wxml,wxss,json}`
- Test: `tests/timer-page.test.js`
- Test: `tests/m2-m4-page-regression.test.js`

**Interfaces:**
- Consumes: Task 3 的 `pausedDurationSeconds`、Task 6 的 `RecoveryResult`。
- Produces: `timePickerState(timestamp)`、`resolveEditedTimestamp(input)`、`splitDurationSeconds(total)`、`joinDurationSeconds(parts)`。
- `second-time-picker` 接收 `value="HH:mm:ss"`，发出 `change.detail.value`；`pause-duration-input` 接收总秒数，发出 `change.detail.value`。

`timePickerState(timestamp)` 返回 `{ value: "HH:mm:ss", indices: [hour, minute, second] }`；`resolveEditedTimestamp` 返回 number timestamp；`splitDurationSeconds` 返回 `{ hours, minutes, seconds }`；`joinDurationSeconds` 返回非负整数秒。

- [ ] **Step 1: 写纯函数失败测试**

```js
test('未编辑的时间保留原毫秒', () => {
  assert.equal(resolveEditedTimestamp({
    originalTimestamp: 1_700_000_000_987,
    edited: false,
    dateValue: '2026-08-03',
    timeValue: '12:34:56'
  }), 1_700_000_000_987);
});

test('编辑后的时间精确到秒且毫秒归零', () => {
  const value = resolveEditedTimestamp({
    originalTimestamp: 1,
    edited: true,
    dateValue: '2026-08-04',
    timeValue: '01:02:03'
  });
  assert.equal(new Date(value).getMilliseconds(), 0);
});

test('暂停时分秒严格拆合', () => {
  assert.deepEqual(splitDurationSeconds(3723), {
    hours: 1, minutes: 2, seconds: 3
  });
  assert.equal(joinDurationSeconds({
    hours: 1, minutes: 2, seconds: 3
  }), 3723);
  assert.throws(() => joinDurationSeconds({
    hours: 0, minutes: 60, seconds: 0
  }));
});
```

Run: `node tests/log-time-editor.test.js`

Expected: FAIL，新工具尚不存在。

- [ ] **Step 2: 实现转换工具**

`resolveEditedTimestamp` 在 `edited=false` 且原始时间有效时直接返回原值；否则严格解析 `YYYY-MM-DD` 与 `HH:mm:ss`，构造本地时间并把毫秒设为 0。`joinDurationSeconds` 要求 hours 为非负整数，minutes/seconds 为 0–59 整数。

- [ ] **Step 3: 实现一个三列时间选择器**

`second-time-picker/index.wxml` 只包含一个：

```xml
<picker
  mode="multiSelector"
  range="{{columns}}"
  value="{{indices}}"
  bindchange="onChange">
  <view class="second-time-field">{{value}}</view>
</picker>
```

三列分别为 `00–23`、`00–59`、`00–59`；组件同步外部 value，change 时一次性发出完整 `HH:mm:ss`。不得把秒拆成旁边的文本输入框。

`pause-duration-input` 使用三个 number input；hours 不设上限，minutes/seconds 在 blur/change 时拒绝或归还上次合法值，最终事件只发合法总秒数。两组件样式遵守 `ui-style` 的表单间距、字号、触控区和错误态规范。

- [ ] **Step 4: 改造计时页三个可编辑入口**

手工补录默认暂停 0；最近记录编辑读取日志当前暂停值；恢复修正读取恢复预览/草稿建议值。三个入口都有独立的开始日期、开始 `HH:mm:ss`、结束日期、结束 `HH:mm:ss` 和暂停时分秒。

页面保存时分别调用 `resolveEditedTimestamp`；只改开始端不得改变结束端原始秒/毫秒。主动计时主卡不显示暂停输入。`onFinishTimer` 收到 `{ state: "draft" }` 时刷新恢复卡片，不显示“记录已生成”，也不读取 `result.log.id`。

- [ ] **Step 5: 改造日历日志编辑器**

把单一 `logDate/logStart/logEnd` 改成：

```js
logStartDate,
logStartTimeValue,
logStartTimeEdited,
logEndDate,
logEndTimeValue,
logEndTimeEdited,
logPausedDurationSeconds
```

保存时支持跨日、跨月和跨年；只改备注时原始起止毫秒和暂停秒数完全不变。日历计划编辑不引入暂停输入，只有 TimeLog 编辑使用它。

- [ ] **Step 6: 页面测试和组件注册检查**

测试必须覆盖：

- 两页 WXML 均使用两个独立 date picker 和两个 `second-time-picker`。
- 页面不存在“时间选择器 + 秒输入框”的混合布局。
- 手工补录与日历编辑跨日成功。
- 最近记录、恢复修正、日历日志未改控件时保留秒和毫秒。
- 只改一端时另一端保持。
- 暂停 h/m/s 合成正确；minutes/seconds=60 拒绝。
- 主动计时主卡无暂停编辑器。
- 两个页面 JSON 均注册两个共享组件。

Run:

```powershell
node tests/log-time-editor.test.js
node tests/timer-page.test.js
node tests/m2-m4-page-regression.test.js
```

Expected: 三个文件全部 PASS，`fail 0`。

- [ ] **Step 7: 编译相关页面并提交**

确认 `.local/wechatide-path.txt` 有效后，使用 `compiler` skill 分别编译/打开计时页和日历页。Expected: WXML/WXSS 无编译错误，两个 `HH:mm:ss` 选择器可滚动三列，暂停输入不挤压表单。

```powershell
git add miniprogram/utils/log-time-editor.js miniprogram/components/second-time-picker miniprogram/components/pause-duration-input miniprogram/pages/timer miniprogram/pages/calendar tests/log-time-editor.test.js tests/timer-page.test.js tests/m2-m4-page-regression.test.js
git commit -m "feat: 增加秒级时间与暂停编辑"
```

### Task 9: 把重叠提示迁移为日历日志标记

**Files:**
- Create: `miniprogram/domain/time-log-overlaps.js`
- Create: `tests/time-log-overlaps.test.js`
- Modify: `miniprogram/services/application-service.js`
- Modify: `miniprogram/domain/statistics.js`
- Modify: `miniprogram/domain/time.js`
- Modify: `miniprogram/pages/timer/index.js`
- Modify: `miniprogram/pages/calendar/index.{js,wxml,wxss}`
- Modify: `miniprogram/pages/profile/index.{js,wxml,wxss}`
- Test: `tests/application-service.test.js`
- Test: `tests/timer-page.test.js`
- Test: `tests/m2-m4-page-regression.test.js`
- Test: `tests/profile-data-management.test.js`
- Test: `tests/statistics.test.js`

**Interfaces:**
- Consumes: Task 7 的 timeline 类型语义。
- Produces: `buildTimeLogOverlapMetadata(logs): Map<logId, OverlapMeta>`。
- `OverlapMeta = { totalCount, confirmedCount, candidateCount }`。

- [ ] **Step 1: 写重叠矩阵失败测试**

```js
test('原始时间戳相交并统计对端类型', () => {
  const metadata = buildTimeLogOverlapMetadata([
    log('a', 'confirmed', 0, 10_000),
    log('b', 'candidate', 9_000, 20_000),
    log('c', 'confirmed', 9_500, 30_000)
  ]);
  assert.deepEqual(metadata.get('a'), {
    totalCount: 2,
    confirmedCount: 1,
    candidateCount: 1
  });
});

test('首尾相邻不算重叠', () => {
  const metadata = buildTimeLogOverlapMetadata([
    log('a', 'confirmed', 0, 10_000),
    log('b', 'confirmed', 10_000, 20_000)
  ]);
  assert.equal(metadata.size, 0);
});
```

补 confirmed↔confirmed、confirmed↔candidate、candidate↔candidate、1 秒相交、三条同时相交、范围外不参与、零时长不产生假重叠。

Run: `node tests/time-log-overlaps.test.js`

Expected: FAIL，新模块尚不存在。

- [ ] **Step 2: 实现纯重叠元数据**

```js
function intersects(first, second) {
  return first.startedAt < second.endedAt
    && second.startedAt < first.endedAt;
}
```

对每对日志只比较一次，并在两端分别累计“对方”的状态。只接受 confirmed/candidate TimeLog；不使用 `durationMinutes`，不扣除 `pausedDurationSeconds`。

- [ ] **Step 3: timeline 只给范围内持久化日志附加标记**

`ApplicationService.timeline(rangeStart, rangeEnd)` 先用 `intervalIntersectsRange` 取范围内 `database.timeLogs`，生成一次 Map，再只给这些 log entry 附加 `overlapMeta`。CalendarEvent、virtual plan、恢复预览都不含该字段。

- [ ] **Step 4: 删除保存提示与统计重叠**

删除 `ApplicationService.hasOverlap`；`createManualLog/updateLog/finishTimer` 只返回 `{ log }`。计时页保存文案固定为正常成功文案，不再分支提示重叠。

删除 `statistics.findOverlaps`、`buildStatistics().overlaps`、`time.overlapMinutes` 及用户页 warning 状态/WXML/WXSS；项目、标签、总投入、偏差和计划外统计结果必须保持原值。

- [ ] **Step 5: 在日历卡片显示低干扰标记**

有元数据的日志卡片增加低饱和边线/底纹和文本：

```text
与其他记录重叠：实际 2 条、候选 1 条
```

计数为 0 的类别不显示；标记不覆盖原状态色，不改变排序、日志状态、时长或统计。

Run:

```powershell
node tests/time-log-overlaps.test.js
node tests/application-service.test.js
node tests/timer-page.test.js
node tests/m2-m4-page-regression.test.js
node tests/profile-data-management.test.js
node tests/statistics.test.js
```

Expected: 六个文件全部 PASS，`fail 0`；`buildStatistics()` 不再有 `overlaps`。

- [ ] **Step 6: 编译日历/用户页并提交**

使用 `compiler` skill 打开日历页和用户页。Expected: 重叠日志逐卡有清晰但不抢占状态色的标记，用户页无重叠警告空白区域。

```powershell
git add miniprogram/domain/time-log-overlaps.js miniprogram/domain/time.js miniprogram/domain/statistics.js miniprogram/services/application-service.js miniprogram/pages/timer/index.js miniprogram/pages/calendar miniprogram/pages/profile tests/time-log-overlaps.test.js tests/application-service.test.js tests/timer-page.test.js tests/m2-m4-page-regression.test.js tests/profile-data-management.test.js tests/statistics.test.js
git commit -m "fix: 在日历标记日志重叠"
```

### Task 10: 增加启动期独立数据恢复界面

**Files:**
- Create: `miniprogram/services/data-recovery-service.js`
- Create: `miniprogram/pages/data-recovery/index.{js,wxml,wxss,json}`
- Create: `tests/data-recovery-service.test.js`
- Create: `tests/data-recovery-page.test.js`
- Modify: `miniprogram/repository/storage-adapter.js`
- Modify: `miniprogram/repository/local-repository.js`
- Modify: `miniprogram/services/bootstrap.js`
- Modify: `miniprogram/utils/page.js`
- Modify: `miniprogram/app.js`
- Modify: `miniprogram/app.json`
- Test: `tests/local-repository-data-management.test.js`
- Test: `tests/bootstrap.test.js`
- Test: `tests/m0-baseline.test.js`

**Interfaces:**
- Consumes: Task 3 的完整快照校验、Task 5 的 JSON 规范化与 replacement import。
- Produces: `DataRecoveryService`、`getRecoveryService()`、两种 bootstrap mode：`ready` 与 `data-recovery`。

- [ ] **Step 1: 写“故障启动零写入”失败测试**

使用带 `has/get/set/remove` 计数的 storage，覆盖已存在的 `""`、`0`、`false`、`null`、非法 JSON、缺字段对象、低于版本和高于版本。每个案例都必须抛 `DATA_CORRUPTED` 或 `DATA_VERSION_UNSUPPORTED`，且 set/remove 次数均为 0。

Run: `node tests/local-repository-data-management.test.js`

Expected: FAIL，现有 `if (!stored)` 会覆盖假值，低版本路径会写 migration backup。

- [ ] **Step 2: 显式区分“键不存在”与“值损坏”**

```js
if (!this.storage.has(STORAGE_KEY)) {
  const initial = createInitialDatabase(this.now());
  this.write(initial);
  return clone(this.cache);
}
const stored = this.storage.get(STORAGE_KEY);
```

`MemoryStorageAdapter.has` 使用 `Map.has`；`WxStorageAdapter.has` 使用 `wx.getStorageInfoSync().keys.includes(key)`。删除不支持版本路径的预迁移备份写入；读取/枚举失败统一停止启动且零写入。

- [ ] **Step 3: 写恢复服务失败测试并实现接口**

```js
class DataRecoveryService {
  constructor({ repository, storage, exportTempFileStore, now }) {}
  exportRawData() {}
  prepareReplacement(jsonText) {}
  commitReplacement(token) {}
  cancelReplacement(token) {}
  clearAllData(confirmed) {}
}
```

行为固定为：

- `exportRawData` 直接读取 storage 原值，不调用 repository initialize/read/exportSnapshot；字符串原样输出，其他值用 `JSON.stringify(value, null, 2)`，无法 stringify 时用 `String(value)`。
- `prepareReplacement` 对 JSON 调用 `parseJsonSnapshot`，再以 `createInitialDatabase(now)` 和 `IMPORT_MODE.REPLACE` 创建分析；不读取损坏本地库，不提供 merge/冲突策略。
- `commitReplacement(token)` 只提交已校验 token 对应的 database，调用 `repository.replace(database, { clearMigrationBackup: true })`；token 一次性。
- `clearAllData(true)` 先调用 `exportTempFileStore.removeAllStrict()`，再 replacement 新库；任一步失败保留旧主数据。`false` 必须拒绝。

`prepareReplacement` 返回预览包含 schemaVersion、addedCounts、repairedReferenceCount、discardedExceptionCount 和 `resetsRuntime: true`。

- [ ] **Step 4: 建立可分流的 bootstrap**

```js
try {
  repository.initialize();
  const applicationService = new ApplicationService(repository, options);
  return {
    mode: 'ready',
    applicationService,
    recovery: applicationService.initialize()
  };
} catch (error) {
  if (!['DATA_CORRUPTED', 'DATA_VERSION_UNSUPPORTED'].includes(error.code)) {
    throw error;
  }
  return {
    mode: 'data-recovery',
    recoveryReason: error.code,
    recoveryService: new DataRecoveryService(recoveryOptions)
  };
}
```

只有 repository 初始化成功后才构造 ApplicationService。`app.onLaunch` 遇到恢复模式 `wx.reLaunch({ url: '/pages/data-recovery/index' })`；`onShow` 只在 ready 模式调用 recoverTimer。`getService` 拒绝恢复模式，新增 `getRecoveryService` 只接受恢复模式。

- [ ] **Step 5: 实现无“重新检测”的恢复页**

页面只显示：

1. 根据错误码区分“本地数据损坏”与“数据来自较新版本”。
2. “导出原始数据”：先异步写入 rescue 文本文件，写完后显示第二个“发送救援文件”按钮；`wx.shareFileMessage` 只在第二次用户点击中直接调用。
3. “从 Plan & Record JSON 覆盖恢复”：选择文件、读取、prepare、显示预览、用户确认后 commit。
4. “清空并重新开始”：连续两次确认，第二次后才调用 `clearAllData(true)`。

页面源码不得包含“重新检测”、incremental、merge、冲突策略入口。覆盖或清空成功后重建 bootstrap 并 reLaunch 到 `/pages/timer/index`；失败停留当前页并保留原始数据。

- [ ] **Step 6: 运行故障矩阵**

必须覆盖：

- 合法恢复文件产生预览，提交后新 profile、timer idle、recoveryDraft null。
- 非法文件不产生 token、不写入。
- replace 的主数据写、备份清理和补偿失败分支不误报成功。
- 原始导出不执行规范化。
- 清空取消、严格临时文件清理失败、资料库写失败都不清空。
- 两种故障文案不同；页面没有“重新检测”。
- 故障启动不会构造 ApplicationService。

Run:

```powershell
node tests/data-recovery-service.test.js
node tests/data-recovery-page.test.js
node tests/local-repository-data-management.test.js
node tests/bootstrap.test.js
node tests/m0-baseline.test.js
```

Expected: 五个文件全部 PASS，`fail 0`。

- [ ] **Step 7: 编译恢复页并提交**

使用 `compiler` skill 打开 `pages/data-recovery/index`。Expected: 页面不依赖 tab 页服务即可加载，三个动作边界清楚，清空需要二次确认，覆盖恢复没有增量选项。

```powershell
git add miniprogram/services/data-recovery-service.js miniprogram/pages/data-recovery miniprogram/repository/storage-adapter.js miniprogram/repository/local-repository.js miniprogram/services/bootstrap.js miniprogram/utils/page.js miniprogram/app.js miniprogram/app.json tests/data-recovery-service.test.js tests/data-recovery-page.test.js tests/local-repository-data-management.test.js tests/bootstrap.test.js tests/m0-baseline.test.js
git commit -m "feat: 增加本地数据恢复入口"
```

### Task 11: 隔离私有基础库配置并增加低版本降级

**Files:**
- Create: `miniprogram/utils/wechat-runtime.js`
- Create: `tests/wechat-runtime.test.js`
- Create: `project.private.config.example.json`
- Modify: `miniprogram/pages/plans/index.js`
- Modify: `.gitignore`
- Verify unchanged: `project.config.json`
- Stop tracking: `project.private.config.json`
- Test: `tests/plans-page.test.js`
- Test: `tests/m0-baseline.test.js`
- Modify: `docs/phase-1-mvp-development-plan.zh-CN.md`

**Interfaces:**
- Consumes: 公共目标 `2.25.4`、当前回归目标 `3.16.2`。
- Produces: `getRuntimeWindowWidth(wxApi): number|null`。

- [ ] **Step 1: 写 API 降级失败测试**

```js
test('窗口宽度优先使用新 API', () => {
  assert.equal(getRuntimeWindowWidth({
    getWindowInfo: () => ({ windowWidth: 375 }),
    getSystemInfoSync: () => ({ windowWidth: 320 })
  }), 375);
});

test('新 API 缺失、抛错或无效时退回旧 API', () => {
  assert.equal(getRuntimeWindowWidth({
    getWindowInfo: () => { throw new Error('unsupported'); },
    getSystemInfoSync: () => ({ windowWidth: 320 })
  }), 320);
});

test('两种 API 均不可用时安全返回 null', () => {
  assert.equal(getRuntimeWindowWidth({}), null);
});
```

Run: `node tests/wechat-runtime.test.js`

Expected: FAIL，新模块尚不存在。

- [ ] **Step 2: 实现能力检测并接入计划页**

```js
function getRuntimeWindowWidth(wxApi) {
  try {
    if (typeof wxApi.getWindowInfo === 'function') {
      const value = wxApi.getWindowInfo();
      if (Number.isFinite(value.windowWidth) && value.windowWidth > 0) {
        return value.windowWidth;
      }
    }
  } catch (error) {}

  try {
    if (typeof wxApi.getSystemInfoSync === 'function') {
      const value = wxApi.getSystemInfoSync();
      if (Number.isFinite(value.windowWidth) && value.windowWidth > 0) {
        return value.windowWidth;
      }
    }
  } catch (error) {}

  return null;
}
```

计划页仍检查 `createSelectorQuery`；宽度为 null 时跳过动态字号测量，不影响标题显示、横向列或任务操作。

- [ ] **Step 3: 隔离个人配置**

`.gitignore` 增加：

```gitignore
/project.private.config.json
```

新增示例：

```json
{
  "libVersion": "3.16.2",
  "projectname": "wxapp-PlanAndRecord",
  "condition": {}
}
```

保持 `project.config.json` 的 `"libVersion": "2.25.4"` 不变。执行：

```powershell
git rm --cached -- project.private.config.json
```

Expected: Git 停止跟踪，工作区本机文件仍存在。不得运行删除命令。

- [ ] **Step 4: 加入配置与页面回归断言**

`m0-baseline` 检查公共版本固定 2.25.4、示例固定 3.16.2、私有配置命中 ignore；`plans-page` 检查新 API 缺失/抛错/无效时页面不崩溃且走旧 API。

Run:

```powershell
node tests/wechat-runtime.test.js
node tests/plans-page.test.js
node tests/m0-baseline.test.js
git check-ignore project.private.config.json
git ls-files --error-unmatch project.private.config.json
```

Expected: 三个测试 PASS；`git check-ignore` 退出码 0；最后一条退出码非 0，表示文件已不受跟踪。

- [ ] **Step 5: 完成双目标开发者工具验证**

先在没有个人覆盖的隔离工作树中以公共 `2.25.4` 编译四个 tab 页和恢复页，验证计划页走 `getSystemInfoSync` 降级；再用未跟踪本机 private 配置选择 `3.16.2` 重复编译和主路径回归。两轮都不得修改公共 `project.config.json`。

在 MVP 文档记录两轮实际结果、开发者工具版本和未覆盖的真机边界；只有发现不可能力检测且不可安全降级的必需 API 时，另行提议提高公共目标，本任务不得自行提高。

- [ ] **Step 6: 提交**

```powershell
git add .gitignore project.private.config.example.json project.config.json miniprogram/utils/wechat-runtime.js miniprogram/pages/plans/index.js tests/wechat-runtime.test.js tests/plans-page.test.js tests/m0-baseline.test.js docs/phase-1-mvp-development-plan.zh-CN.md
git commit -m "chore: 隔离基础库私有配置"
```

提交前 `git diff --cached --name-status` 应显示 `project.private.config.json` 为索引删除、示例文件为新增；本机原文件可由 `Test-Path project.private.config.json` 确认为存在。

### Task 12: 全量回归、文档回看与人工验收

**Files:**
- Modify only if verification facts changed: `docs/phase-1-mvp-development-plan.zh-CN.md`
- Verify: 本计划 File Map 中全部源文件、页面、配置和测试
- No production feature additions

**Interfaces:**
- Consumes: Tasks 1–11 的全部接口。
- Produces: 可审计的自动化、开发者工具和人工验收记录；不产生新领域接口。

- [ ] **Step 1: 逐文件运行全部 Node 测试**

受限环境中 `npm test` 可能因聚合运行器创建子进程而报 `spawn EPERM`；先使用不会并行派生子进程的 PowerShell 循环：

```powershell
Get-ChildItem tests -Filter *.test.js |
  Sort-Object Name |
  ForEach-Object {
    node $_.FullName
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
```

Expected: 每个测试文件 `fail 0`，最终退出码 0。可派生子进程的正常环境再运行 `npm test`，Expected: 全量 PASS。

- [ ] **Step 2: 执行静态一致性检查**

Run:

```powershell
git diff --check
rg -n "pausedDurationSeconds|intervalTotalSeconds|重复计划·待确认|DATA_VERSION_UNSUPPORTED|overlapMeta" docs miniprogram tests
rg -n "存在重叠时间|发现重叠时间|虚拟候选|重新检测" miniprogram docs/product-design.zh-CN.md docs/phase-1-mvp-development-plan.zh-CN.md
git status --short
```

Expected:

- `git diff --check` 无输出。
- 第一条搜索在文档、实现和测试都有对应命中。
- 第二条搜索无命中，退出码 1 是预期结果。
- 状态只包含本计划文件及制定计划时已经确认的文档收尾，不含延期项业务实现。

- [ ] **Step 3: 在 2.25.4 与 3.16.2 编译全部页面**

使用 `compiler` skill，两种基础库目标分别编译：

- `pages/timer/index`
- `pages/plans/index`
- `pages/calendar/index`
- `pages/profile/index`
- `pages/data-recovery/index`

Expected: WXML/WXSS/JSON 无错误、无未注册组件、无高版本 API 导致的启动失败。

- [ ] **Step 4: 按用户可见主路径人工验收**

逐条记录通过/失败和截图：

1. 20 秒补录生成 1 分钟；暂停等于区间秒数被拒绝。
2. 跨日开始/结束和 `HH:mm:ss` 三列选择器；只改一端保留另一端毫秒。
3. 活动计时正常暂停/恢复/结束，暂停秒数自动入库且不可编辑。
4. 模拟墙钟倒退/暂停损坏后无日志、出现恢复草稿、禁止新计时；修正只生成一条日志，放弃不生成。
5. 虚拟重复计划显示“重复计划·待确认”，确认和单次修改各只产生一条 confirmed rule 日志。
6. 导入稀疏 override 后导出为完整 override；缺规则/含糊修订整次拒绝。
7. candidate 只来自导入并可确认/作废；关闭 includeCandidates 不隐藏虚拟计划。
8. 日历对 confirmed-confirmed、confirmed-candidate、candidate-candidate 逐卡标记；相邻记录不标记；保存与用户统计页无重叠提醒。
9. 损坏和高版本数据分别进入不同恢复文案；原始导出、覆盖恢复、二次清空可用且没有“重新检测”。
10. 2.25.4 下计划页正常降级，3.16.2 下主路径一致。

- [ ] **Step 5: 复核明确排除项没有被顺带实现**

Run:

```powershell
git diff --name-only
git diff -- docs/document-review-backlog.zh-CN.md miniprogram/pages/plans miniprogram/domain/recurrence.js miniprogram/services/export-temp-file-store.js
```

Expected: backlog 延期内容仍在；没有新增 OKR 管理、种子删除语义、统一详情页、例行清理自动重试或“此项及后续”修订链重写。recurrence 的变化只涉及本计划的校验、完整 override 和 virtual plan 类型。

- [ ] **Step 6: 最终文档同步并提交验证记录**

只有在实际完成两轮编译/人工验收后，才在 `phase-1-mvp-development-plan.zh-CN.md` 写入日期、工具版本、已通过项和明确未验证的真机边界；不得把本地 mock 写成生产验收。

```powershell
git add docs/phase-1-mvp-development-plan.zh-CN.md
git commit -m "test: 记录一致性修复验收结果"
```

- [ ] **Step 7: 请求最终代码审查**

使用 `superpowers:requesting-code-review` 对照本计划 Global Constraints、12 个任务和排除项审查。任何 P1/P2 发现先修复并重跑对应测试与 Task 12；全部通过后再使用 `superpowers:finishing-a-development-branch` 决定合并、PR 或保留分支，不自动发布。

## Self-Review Record

- **Spec coverage:** 暂停入库/秒级公式、严格不等式、跨日秒级编辑、计时异常、候选语义、重复规则校验、稀疏 override、任务状态机、日历重叠、数据恢复、标题规则和双基础库目标均有独立任务与测试。
- **Scope coverage:** 5 个延期项、2 个明确不处理项、周起始日及其他 backlog 条目都写入 Global Constraints，并在 Task 12 设反向检查。
- **Type consistency:** `pausedDurationSeconds`、`LogTiming`、`RecoveryResult`、`FullOccurrenceOverride`、`OverlapMeta` 和 bootstrap mode 的名称在生产代码、页面与测试任务中一致。
- **Placeholder scan:** 文档没有未决实现占位；出现的 `TASK_STATUS.TODO` 仅是既有领域枚举，不表示待补工作。
- **Atomicity:** timer 异常、单次 override+log、JSON replacement、清空和 repository transaction 都有失败零写入或回滚验收。
