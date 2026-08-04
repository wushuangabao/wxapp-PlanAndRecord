# `ui-style` 参数与示例

本文件归纳可复用的视觉参数。新页面的样式应先以这些参数为默认值，再通过用户验收确定是否需要扩展。

## 1. 风格主张

**安静、轻手账式的莫兰迪个人记录界面。**

页面优先帮助用户聚焦于完成一件事；用暖灰白留白、低对比容器和短句文案避免注意力分散。主色采用低饱和灰绿：灰绿色填充配暖白文字表示“我准备继续”，浅灰绿配深灰绿文字表示次要操作。计划、候选、实际与危险状态分别使用灰蓝、灰琥珀、灰绿与灰玫瑰，依靠色相和明度共同区分，不使用高饱和荧光色。

### 主要参数

| 项目 | 当前值 |
| --- | --- |
| 产品气质 | 克制、温和、清晰、轻手账感 |
| 页面基底 | 暖灰白 `#f3f1ed`，内容面 `#faf9f7` |
| 强调色 | 莫兰迪灰绿 `#78947f`，文字 `#faf9f7` |
| 状态色 | 计划 `#7b918b`；候选 `#a58454`；实际 `#55725e`；危险 `#9a5550` |
| 圆角 | 常规按钮 `14rpx`，计时页按钮/描边按钮 `16rpx`，输入框 `12rpx`，卡片 `24rpx` |
| 视觉密度 | 一屏一个主任务，卡片少而大 |
| 动效 | 短按压反馈；默认无装饰性自动动画 |

### 现有页面的按钮基线

| 语义 | 填充 / 边界 | 文字 | 圆角 | 已有使用 |
| --- | --- | --- | --- | --- |
| 主要确认 | `#78947f`，无边框 | `#faf9f7` | `14rpx`；计时页 `16rpx` | 创建、保存、开始、导出 |
| 常规次要 | `#d8e1da`，无边框 | `#486455` | `14rpx` | 收集、导入、只修改此项 |
| 计时场景次要 | `#e5e2dc`，无边框 | `#505a54` | `16rpx` | 取消 |
| 计时卡内次要 | `#faf9f7`，`1rpx solid #c2d0c5` | `#486455` | `16rpx` | 灰绿计时卡内的结束操作 |
| 灰绿描边次要 | `1rpx solid #78947f`，`#e6ece7` | `#486455` | `16rpx` | 手工补录 |
| 危险实心 | `#f2e3e1`，无边框 | `#8a4945` | `14rpx` | 清空数据 |
| 文本操作 / 危险文本 | 透明背景 | 常规 `#4d695b`；危险 `#9a5550` | 不依赖圆角 | 编辑、归档、删除、作废 |

## 2. 色彩与文字

以下值是起点，不是必须写入全局样式的硬编码。改色时同时校验文字对比度与选中状态。

```css
page {
  --ui-page: #f3f1ed;
  --ui-surface: #faf9f7;
  --ui-surface-pressed: #ece9e4;
  --ui-text: #343a36;
  --ui-text-secondary: #626b65;
  --ui-text-muted: #737b75;
  --ui-accent: #78947f;
  --ui-on-accent: #faf9f7;
  --ui-accent-weak: #e6ece7;
  --ui-accent-soft: #d8e1da;
  --ui-accent-dark: #486455;
  --ui-link: #4d695b;
  --ui-accent-border: #a9bdae;
  --ui-border: #d0cdc6;
  --ui-divider: #dedad3;
  --ui-neutral-surface: #e5e2dc;
  --ui-on-neutral: #505a54;
  --ui-timer-surface: #e7eee9;
  --ui-on-timer: #385846;
  --ui-timer-status: #486455;
  --ui-timer-action: #faf9f7;
  --ui-timer-action-border: #c2d0c5;
  --ui-warning-surface: #f5f0e6;
  --ui-on-warning: #795d32;
  --ui-warning-accent: #a58454;
  --ui-danger-surface: #f2e3e1;
  --ui-on-danger: #8a4945;
  --ui-danger-link: #9a5550;
  --ui-plan: #7b918b;
  --ui-candidate: #a58454;
  --ui-actual: #55725e;
  --ui-overlay: rgba(52, 58, 54, .42);
}
```

### 状态色使用

| 语义 | 颜色 | 使用边界 |
| --- | --- | --- |
| 计划 | `#7b918b` | 时间轴计划图例、计划状态标记；使用偏青绿的灰调 |
| 候选 / 提醒 | `#a58454`；文字 `#795d32`；底色 `#f5f0e6` | 待核实记录、恢复草稿、非阻断提醒 |
| 实际 / 已确认 | `#55725e` | 已确认时间轴标记、当前选择与完成状态 |
| 危险 | `#9a5550`；深文字 `#8a4945`；底色 `#f2e3e1` | 删除、放弃、清空等不可逆操作 |

- 不仅依赖颜色表达状态：计划、候选、实际仍保留文字、边框形态或布局标记。
- 绿色优先表达主操作、当前选择与实际记录；灰蓝不用于主操作，灰琥珀不用于确认成功，灰玫瑰不用于普通取消。
- 低饱和不等于低对比。正文、辅助文字和按钮文字须先满足可读性，再微调色相和明度。

| 层级 | 建议 | 用途 |
| --- | --- | --- |
| 任务提问 | `36rpx`，`400` | 当前步骤的短问题 |
| 核心反馈 | `48rpx`，`500` | 一条结果或当前心情 |
| 选项文字 | `32rpx`，`400` | 胶囊/卡片内标签 |
| 辅助说明 | `26rpx`，`400` | 解释、提示、次级元数据 |

优先使用系统字体。中文标题保持短句；说明文字允许两行，但不把长段文字压进狭窄的选项按钮。

## 3. 布局节奏

- 页面横向留白默认 `48rpx`；密集列表可降至 `32rpx`。
- 标题到主内容保持 `48rpx` 以上；内容区块之间用 `32rpx` 或 `48rpx` 分隔。
- 流程型页面将主操作锚定在底部，使用 `padding-bottom: calc(32rpx + env(safe-area-inset-bottom))`。
- 插画展示区域通常为 `240rpx` 到 `360rpx` 高，四周预留空气；不要用插画塞满首屏。
- 并列选项采用等宽网格或自然换行；每项文字必须完整可见，不能依赖省略号隐藏核心差异。

## 4. 底部弹窗头部标准

所有底部弹窗头部必须使用项目共享组件 `miniprogram/components/sheet-header/`。组件是标题、紧凑 `确定` 和 `取消` 的唯一视觉来源；页面不得再复制其 WXML、WXSS 或用未约束宽度的原生 `<button>` 重建该组合。

- 共享组件固定实现“左侧标题 + 右侧紧凑确定 + 取消”：标题为 `36rpx`、`700`、`#343a36`；确定为 `80rpx × 52rpx` 的灰绿色主操作；取消为 `56rpx × 52rpx` 的无背景深灰绿文本操作。
- 仅有关闭语义的选择类弹窗不显示确定，但仍使用同一组件显示标题和取消。
- 页面不得覆盖 `.sheet-header`、`.sheet-title`、`.sheet-confirm` 或 `.sheet-cancel` 的布局与尺寸。需要调整全局视觉时，只修改共享组件并回归所有使用页面。
- 组件只负责展示和发出事件，不读取或写入表单数据；创建、保存、关闭等业务逻辑必须继续由页面处理。
- 弹窗遮罩使用 `bindtap` 关闭时，弹窗内容容器应使用 `catchtap="noop"`，避免头部点击冒泡到遮罩层。

在使用页面的 JSON 中注册组件：

```json
{
  "usingComponents": {
    "sheet-header": "/components/sheet-header/index"
  }
}
```

需要确认的表单弹窗使用如下结构：

```wxml
<sheet-header
  title="新建项目"
  show-confirm="{{true}}"
  bind:confirm="addProject"
  bind:cancel="closeProjectCreate"
/>
```

仅需关闭的选择类弹窗省略 `show-confirm`：

```wxml
<sheet-header
  title="{{taskProjectPicker.title}}"
  bind:cancel="closeTaskProjectPicker"
/>
```

组件属性为 `title`、`showConfirm`、`confirmText` 和 `cancelText`；其中 `showConfirm` 默认 `false`，两个文案默认分别为“确定”和“取消”。组件分别触发 `confirm` 和 `cancel` 事件。

## 5. 通用删除图标标准

列表中的垃圾桶图标统一使用共享组件 `miniprogram/components/delete-icon/`，TODO LIST 和最近记录不得在页面 WXSS 中分别绘制或覆盖图标外观。

- 图标以共享组件的当前规格为准：使用 `22rpx × 33rpx` 画布且不缩放，抓手为 `6rpx × 3rpx`、盖子横杆为 `22rpx × 3rpx`、桶身为 `18rpx × 26rpx`、桶身两道竖线均为 `3rpx × 15rpx`；桶身使用 `3rpx` 边框、取消上边框并保留 `3rpx` 底部圆角，线条使用危险灰玫红 `#9a5550`。盖子横杆、抓手与桶身两道竖线必须共用 `50%` 中轴，双竖线对称分布。
- 组件只负责图标展示；外层页面按钮继续负责点击热区、`aria-label`、业务 ID、删除事件和二次确认。
- 页面 JSON 使用 `"delete-icon": "/components/delete-icon/index"` 注册，并在删除按钮内部放置 `<delete-icon />`。

## 6. 通用编辑图标标准

列表中的铅笔编辑图标统一使用共享组件 `miniprogram/components/edit-icon/`，页面不得在 WXSS 中重复绘制或覆盖图标外观。

- 图标使用 `30rpx × 30rpx` 画布，以灰绿 `#4d695b` 为主体，明确区分笔尖、笔身、尾帽和书写短线；书写线左右各留 `2rpx`，右端与铅笔右上视觉边界对齐，避免只用旋转矩形表达铅笔。
- 组件只负责图标展示；外层页面按钮继续负责点击热区、`aria-label`、业务 ID 和编辑事件。
- 页面 JSON 使用 `"edit-icon": "/components/edit-icon/index"` 注册，并在编辑按钮内部放置 `<edit-icon />`。
