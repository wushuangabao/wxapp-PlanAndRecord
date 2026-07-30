# `ui-style` 参数与示例

本文件归纳可复用的视觉参数。新页面的样式应先以这些参数为默认值，再通过用户验收确定是否需要扩展。

## 1. 风格主张

**安静、轻手账式的个人记录界面。**

页面优先帮助用户聚焦于完成一件事；留白、低对比容器和短句文案避免注意力分散。用深绿色文字、绿色填充、无边框的实心按钮表示“我准备继续”；浅绿色填充配深绿色文字表示次要操作。

### 主要参数

| 项目 | 当前值 |
| --- | --- |
| 产品气质 | 克制、温和、清晰 |
| 强调色 | 主操作 `#22c55e`，文字 `#052e16` |
| 圆角 | 常规按钮 `14rpx`，计时页按钮/描边按钮 `16rpx`，输入框 `12rpx`，卡片 `24rpx` |
| 视觉密度 | 一屏一个主任务，卡片少而大 |
| 动效 | 短按压反馈；默认无装饰性自动动画 |

### 现有页面的按钮基线

| 语义 | 填充 / 边界 | 文字 | 圆角 | 已有使用 |
| --- | --- | --- | --- | --- |
| 主要确认 | `#22c55e`，无边框 | `#052e16` | `14rpx`；计时页 `16rpx` | 创建、保存、开始、导出 |
| 常规次要 | `#dcfce7`，无边框 | `#166534` | `14rpx` | 收集、导入、只修改此项 |
| 计时场景次要 | `#e2e8f0`，无边框 | `#334155` | `16rpx` | 结束计时、取消 |
| 计时卡内次要 | `#166534`，无边框 | `#dcfce7` | `16rpx` | 深绿色计时卡内的结束操作 |
| 绿色描边次要 | `1rpx solid #22c55e`，`#f0fdf4` | `#166534` | `16rpx` | 手工补录 |
| 危险实心 | `#fee2e2`，无边框 | `#b91c1c` | `14rpx` | 清空数据 |
| 文本操作 / 危险文本 | 透明背景 | 常规 `#15803d`；危险 `#dc2626` | 不依赖圆角 | 编辑、归档、删除、作废 |

## 2. 色彩与文字

以下值是起点，不是必须写入全局样式的硬编码。改色时同时校验文字对比度与选中状态。

```css
page {
  --ui-page: #f8fafc;
  --ui-surface: #ffffff;
  --ui-surface-pressed: #f1f5f9;
  --ui-text: #0f172a;
  --ui-text-secondary: #64748b;
  --ui-accent: #22c55e;
  --ui-on-accent: #052e16;
  --ui-accent-weak: #f0fdf4;
  --ui-accent-dark: #166534;
  --ui-secondary: #dcfce7;
  --ui-on-secondary: #166534;
  --ui-secondary-neutral: #e2e8f0;
  --ui-on-secondary-neutral: #334155;
  --ui-danger-surface: #fee2e2;
  --ui-on-danger: #b91c1c;
  --ui-danger-link: #dc2626;
  --ui-link: #15803d;
  --ui-divider: #e2e8f0;
}
```

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

- 共享组件固定实现“左侧标题 + 右侧紧凑确定 + 取消”：标题为 `36rpx`、`700`、`#0f172a`；确定为 `80rpx × 52rpx` 的绿色主操作；取消为 `56rpx × 52rpx` 的无背景绿色文本操作。
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
