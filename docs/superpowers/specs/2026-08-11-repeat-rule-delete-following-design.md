# 固定日程删除本次及后续设计

## 目标

固定日程不再提供“修改本次”或“修改本次及后续”。用户需要调整标题、时间、频率、间隔、星期、日期、任务或优先级时，必须从选中实例起删除本次及后续计划，再创建新的固定日程。

本设计新增“删除本次及后续”危险操作，并删除固定日程的用户编辑契约。它取代 [固定日程仅保存重复规则设计](./2026-08-10-repeat-rule-only-creation-design.md) 中关于重复实例提供两种修改操作的页面行为。

## 已确认边界

- 产品视为从未产生过本地数据，不兼容、不迁移旧 revision 链、旧 override 或旧导出文件。
- 保持 `schemaVersion = 1`，不增加迁移器或兼容分支。
- 删除范围内已有的 `candidate` 和 `confirmed` 日志必须保留；解除计划关联后作为“计划外”记录参与统计。
- 删除选中实例之前的固定日程投影、计划统计和日志关联保持不变。
- 普通非重复 `CalendarEvent` 的创建、编辑和删除不变。
- 固定日程的“从此开始计时”“确认”和“跳过”能力不变。
- 所有删除操作必须二次确认并在单个 `LocalRepository.transaction` 中原子完成。

## 首版固定日程契约

### RepeatRule

- 一个 `RepeatRule` 只允许一个 revision。
- revision 继续保存 `effectiveFrom` 和可空的 `effectiveUntil`：
  - `effectiveFrom` 是规则第一次可投影的逻辑槽位；
  - `effectiveUntil = null` 表示规则没有结束；
  - “删除本次及后续”通过设置 `effectiveUntil = occurrenceStart - 1` 截止规则。
- 创建后不得再修改 revision 的标题、时间、频率、间隔、每周日期、每月日期、任务或优先级。
- JSON 快照中 revision 数量不是 1 时属于当前 v1 数据结构无效，不进行迁移或修复。

### OccurrenceException

- `OccurrenceException.kind` 只允许 `skip`。
- 删除 `override` 类型、override 数据结构、稀疏 override 规范化和物化逻辑。
- JSON 快照出现 `override` 时按当前 v1 数据结构无效处理，不提供兼容导入。

### 应用服务写入口

- 删除 `reviseRuleFollowing()`。
- 删除 `overrideOccurrence()`。
- 保留 `skipOccurrence()`。
- 新增 `deleteRuleFollowing(ruleId, occurrenceStart, confirmed)`。

## 删除本次及后续

### 输入校验

- `confirmed` 必须为 `true`，否则返回删除确认错误。
- `ruleId` 必须指向现存重复规则。
- `occurrenceStart` 必须是该规则当前能够投影出的真实逻辑实例；不能用任意时间戳截断规则。
- 删除边界按逻辑 `occurrenceStart` 判断，不按界面调时后的 `startedAt` 判断。

### 规则处理

- 如果删除边界之前不存在任何符合频率与日期规则的逻辑实例，从 `repeatRules` 删除整条规则；不能简单比较 `occurrenceStart === effectiveFrom`，因为每周或每月规则的第一次实际发生可能晚于 `effectiveFrom`。
- 如果删除边界之前至少存在一个逻辑实例，将 revision 的 `effectiveUntil` 设置为 `occurrenceStart - 1`，保留此前投影。
- 删除该规则中 `occurrenceStart >= 删除边界` 的全部 skip 例外。
- 删除后不得再投影选中实例及任何未来实例；过去实例仍由同一规则和 revision 投影。

### 日志处理

对满足以下条件的每条 `TimeLog` 处理：

- `originRuleId === ruleId`；
- 从 `originOccurrenceId` 解析出的逻辑发生时间大于或等于删除边界。

处理方式：

- 保留日志本身、状态、时长、标签、备注、来源和其他历史快照；
- 若 `originRuleSummarySnapshot` 为空，写入删除前的规则标题；
- 清空 `originRuleId`；
- 保留 `originOccurrenceId` 作为历史来源追溯；
- 日志随后不再构成计划关联，在偏差统计中作为“计划外”，也不再沿计划关系派生当前任务或项目。

删除边界之前的日志关联不得变化。

### 活动草稿处理

运行中的计时草稿和恢复草稿不允许只保留 `originOccurrenceId`。若其关联实例位于删除范围内：

- 保留重复规则标题摘要；
- 同时清空 `originRuleId` 和 `originOccurrenceId`；
- 保留计时状态、时间、标签和备注，不结束计时、不创建日志。

### 原子性

规则截止或删除、skip 清理、日志解除关联、活动草稿解除关联必须在同一个事务中完成。任一步校验或写入失败时，资料库保持操作前状态，页面不得显示成功提示。

## 日历页面行为

- 重复实例详情移除“修改本次”和“修改本次及后续”。
- 移除对应的编辑弹窗、页面状态、字段处理和提交函数。
- 重复实例详情新增危险操作“删除本次及后续”。
- 点击后显示二次确认：
  - 标题：`删除本次及后续`
  - 内容：`将删除本次及之后的固定日程。已有时间记录会保留，但会解除计划关联。`
  - 确认按钮：`删除`
- 用户确认后调用 `deleteRuleFollowing()`；成功提示为“本次及后续已删除”，随后关闭详情并刷新当前范围。
- 用户取消、服务校验失败或存储写入失败时不改变页面数据，并沿用现有错误提示机制。

## 查询、统计与导入

- 时间轴、计划选择器和统计只投影 revision 有效区间内的实例。
- 截止边界之前的计划与实际偏差保持不变。
- 截止边界及之后不再产生计划时长；被保留并解除关联的日志计入计划外实际投入。
- JSON 规范化、校验、导入、导出删除多 revision 和 override 契约；不识别旧结构、不生成修复摘要。
- 删除规则后单独保留 `originOccurrenceId` 的日志仍是当前协议允许的历史来源追溯结构。

## 权威文档同步

实施时同步更新：

- `docs/product-design.zh-CN.md`：固定日程操作、重复规则、例外、JSON 和首版范围。
- `docs/phase-1-mvp-development-plan.zh-CN.md`：M4 交付和退出条件。
- `docs/calendar-view-layout-spec-review.zh-CN.md`：重复实例详情操作。
- `docs/document-review-backlog.zh-CN.md`：删除已经取消的后续修订延期议题，避免继续把它列为待实现能力。

同一规则只在产品设计基线中维护完整定义，其余文档简述并链接。

## 测试要求

实施遵循测试驱动，至少覆盖：

1. 页面不再包含两个修改入口、编辑弹窗或相关提交函数，只包含“删除本次及后续”。
2. 未二次确认时拒绝删除且资料库不变。
3. 从第一次实际发生删除时移除整条规则，包含 `effectiveFrom` 本身不命中每周或每月日期的情况；未来不再投影。
4. 从中间实例删除时保留过去、删除当前及未来，并正确设置 `effectiveUntil`。
5. 删除范围内的 skip 例外被清理，过去的 skip 保留。
6. 删除范围内的 candidate/confirmed 日志保留、解除关联、保留摘要并转入计划外统计；过去日志关联不变。
7. 运行中计时草稿和恢复草稿解除两个 origin ID，但计时内容和状态保留。
8. 非真实实例时间戳、未知规则和未确认请求均失败且不写入。
9. 任一事务写入失败时完整回滚。
10. JSON 拒绝多 revision 和 override；新建、导出、导入只产生单 revision 与 skip。
11. 完整 `npm test`、变更 JS 的 `node --check`、JSON 解析和 `git diff --check` 通过。
12. 微信开发者工具中验证重复实例详情、删除确认、取消、成功刷新和失败提示；模拟器与真机证据分开报告。

## 不在本次范围

- 不增加“撤销删除”、回收站或删除历史。
- 不删除候选或实际日志。
- 不为旧 revision 链、旧 override 或旧导出文件提供迁移。
- 不改变普通计划、任务、项目、标签、计时和统计的其他语义。
- 不新增云同步、多端冲突或服务端删除协议。
