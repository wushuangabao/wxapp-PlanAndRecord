const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const pagesRoot = path.join(__dirname, '../miniprogram/pages');
const miniprogramRoot = path.join(__dirname, '../miniprogram');

test('页面主头部在滚动时固定在顶部', () => {
  for (const page of ['timer', 'plans', 'profile']) {
    const source = fs.readFileSync(path.join(pagesRoot, page, 'index.wxss'), 'utf8');
    const wxml = fs.readFileSync(path.join(pagesRoot, page, 'index.wxml'), 'utf8');
    assert.match(source, /\.eyebrow\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;/s, page);
    assert.match(wxml, /<view class="page">\s*<view class="eyebrow">/s, page);
  }
  const calendarWxml = fs.readFileSync(path.join(pagesRoot, 'calendar/index.wxml'), 'utf8');
  const calendarWxss = fs.readFileSync(path.join(pagesRoot, 'calendar/index.wxss'), 'utf8');
  assert.match(calendarWxml, /<view class="page">\s*<view class="calendar-toolbar">/s);
  assert.match(calendarWxss, /\.calendar-toolbar\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;/s);
});

test('日历顶部提供当前范围、今天按钮、四种粒度、右对齐状态图例与循环筛选按钮', () => {
  const script = fs.readFileSync(path.join(pagesRoot, 'calendar/index.js'), 'utf8');
  const wxml = fs.readFileSync(path.join(pagesRoot, 'calendar/index.wxml'), 'utf8');
  const wxss = fs.readFileSync(path.join(pagesRoot, 'calendar/index.wxss'), 'utf8');
  assert.match(script, /formatRangeLabel\(range, this\.data\.view\)/);
  assert.match(script, /data:\s*\{[\s\S]*?view:\s*'day'/);
  assert.match(script, /views:\s*\['year', 'month', 'week', 'day'\]/);
  assert.match(wxml, /class="range-label"/);
  assert.match(wxml, /class="toolbar-left">[\s\S]*class="range-label"[\s\S]*wx:if="\{\{!hasTimelineItems\}\}" class="range-empty">\{\{rangeEmptyText\}\}/);
  assert.match(wxml, /class="today-button \{\{rangeIncludesToday \? 'is-current-range' : ''\}\}"[^>]*bindtap="goToday"/);
  assert.match(wxml, /class="toolbar-right">[\s\S]*class="view-tabs"[\s\S]*class="calendar-legend"/);
  assert.match(wxml, /class="legend-dot plan"[\s\S]*>计划<[\s\S]*class="legend-dot actual"[\s\S]*>记录<[\s\S]*class="legend-dot candidate"[\s\S]*>候选</);
  assert.match(wxml, /class="calendar-filter-button"[^>]*aria-label="切换日历显示内容，当前\{\{timelineFilterLabel\}\}，点击查看下一种"[^>]*bindtap="cycleTimelineFilter">[\s\S]*class="calendar-filter-label">\{\{timelineFilterLabel\}\}<\/text>[\s\S]*class="calendar-filter-switch-icon" aria-hidden="true">↻<\/text>[\s\S]*<\/view>/);
  assert.match(wxss, /\.range-label\s*\{[^}]*white-space:\s*nowrap;/s);
  assert.match(wxss, /\.toolbar-left,\s*\.toolbar-right\s*\{[^}]*grid-template-rows:\s*52rpx 44rpx;/s);
  assert.match(wxss, /\.toolbar-right\s*\{[^}]*justify-items:\s*end;/s);
  assert.match(wxss, /\.calendar-legend\s*\{[^}]*justify-content:\s*flex-end;/s);
  assert.match(wxss, /\.calendar-filter-button\s*\{[^}]*height:\s*44rpx;[^}]*margin-left:\s*2rpx;[^}]*border:\s*2rpx solid #78947f;[^}]*border-radius:\s*22rpx;[^}]*background:\s*#e6ece7;[^}]*box-shadow:/s);
  const switchIconStyle = wxss.match(/\.calendar-filter-switch-icon\s*\{[^}]*\}/s)[0];
  assert.match(switchIconStyle, /display:\s*flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*color:\s*#78947f;[^}]*line-height:\s*1;/s);
  assert.doesNotMatch(switchIconStyle, /border-radius|background:/);
  assert.match(wxss, /\.tab\s*\{[^}]*width:\s*54rpx;/s);
  assert.match(wxss, /\.today-button\s*\{[^}]*border:\s*0;/s);
  assert.match(wxss, /\.today-button\.is-current-range\s*\{[^}]*border:\s*4rpx solid #a9bdae;/s);
  assert.match(wxml, /class="calendar-scroll \{\{pageTurnClass\}\} \{\{isCreateOpen \? 'is-sheet-open' : ''\}\}"/);
  assert.match(wxml, /wx:if="\{\{currentTimeLineStyle\}\}" class="current-time-line" style="\{\{currentTimeLineStyle\}\}"/);
  assert.doesNotMatch(wxml, /class="calendar-empty"/);
  assert.doesNotMatch(wxml, /time-axis-terminal|24:00/);
  assert.match(script, /animateRangeChange\(deltaX < 0 \? 1 : -1\)/);
  assert.match(wxss, /@keyframes calendar-page-next/);
  assert.doesNotMatch(wxss, /\.calendar-toolbar\s*\{[^}]*min-height:/s);
  assert.match(wxss, /\.page\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s);
  assert.match(wxss, /\.calendar-scroll\s*\{[^}]*flex:\s*1 1 0;[^}]*height:\s*0;/s);
  assert.match(wxss, /\.calendar-scroll\.is-sheet-open\s*\{[^}]*transform:\s*none;[^}]*will-change:\s*auto;/s);
  assert.match(wxss, /\.time-row,\s*\.grid-row\s*\{[^}]*position:\s*absolute;/s);
  assert.match(wxml, /class="calendar-grid-bottom-line"/);
  assert.match(wxss, /\.calendar-grid-bottom-line\s*\{[^}]*bottom:\s*0;[^}]*background:\s*#dedad3;/s);
  assert.match(wxss, /\.calendar-scroll-safe-space\s*\{[^}]*background:\s*#f3f1ed;/s);
  assert.match(wxss, /\.calendar-scroll\s*\{[^}]*background:\s*#f3f1ed;/s);
  assert.doesNotMatch(wxml, /class="nav-button"/);
});

test('日历粗粒度视图使用定高内容块换行并允许时间格自然增高', () => {
  const script = fs.readFileSync(path.join(pagesRoot, 'calendar/index.js'), 'utf8');
  const wxml = fs.readFileSync(path.join(pagesRoot, 'calendar/index.wxml'), 'utf8');
  const wxss = fs.readFileSync(path.join(pagesRoot, 'calendar/index.wxss'), 'utf8');

  assert.match(wxml, /wx:if="\{\{view === 'day'\}\}" class="calendar-grid day-calendar-grid"/);
  assert.match(wxml, /wx:else class="calendar-grid coarse-calendar-grid"/);
  assert.match(wxml, /wx:for="\{\{timeRows\}\}"[^>]*wx:for-item="row"[^>]*class="coarse-calendar-row"[^>]*style="min-height: \{\{row\.coarseMinHeight\}\}rpx;"/);
  assert.match(wxml, /wx:for="\{\{row\.blocks\}\}"[^>]*wx:for-item="block"[^>]*class="calendar-block coarse-calendar-block \{\{block\.visualType\}\} \{\{block\.priorityClass\}\}[^>]*style="width: \{\{block\.coarseWidth\}\}rpx;"/);
  assert.match(wxml, /wx:if="\{\{currentTimeLineRowIndex === row\.index\}\}" class="current-time-line coarse-current-time-line" style="\{\{currentTimeLineStyle\}\}"/);
  assert.match(wxml, /wx:if="\{\{row\.restDayKind\}\}"[\s\S]*class="rest-day-corner rest-day-\{\{row\.restDayKind\}\}"/);
  assert.doesNotMatch(wxml.split('coarse-calendar-grid')[0], /rest-day-corner/);
  assert.match(wxml, /data-item="\{\{block\}\}"[^>]*bindtap="openItemDetail"/);
  assert.match(wxml, /class="coarse-time-label is-collapsible \{\{row\.isCollapsed \? 'is-collapsed' : ''\}\} \{\{view === 'week' \|\| view === 'month' \? 'is-week' : ''\}\}"[^>]*role="button"[^>]*bindtap="toggleCoarseRow"/);
  assert.match(wxml, /class="coarse-time-label-content"[\s\S]*class="coarse-time-label-text"[\s\S]*class="coarse-collapse-indicator"/);
  assert.match(wxml, /wx:for-item="block"[^>]*wx:if="\{\{!row\.isCollapsed \|\| block\.coarseLineIndex < row\.collapsedVisibleLineCount\}\}"/);

  const coarseRowStyle = wxss.match(/\.coarse-calendar-row\s*\{[^}]*\}/s)[0];
  assert.match(coarseRowStyle, /display:\s*flex;/);
  assert.doesNotMatch(coarseRowStyle, /(?:^|[;\s])height:/);
  assert.match(wxss, /\.coarse-block-list\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;[^}]*gap:/s);
  assert.match(wxss, /\.calendar-block\.coarse-calendar-block\s*\{[^}]*position:\s*relative;[^}]*display:\s*flex;[^}]*flex:\s*0 1 auto;[^}]*width:\s*auto;[^}]*max-width:\s*40vw;[^}]*height:\s*54rpx;[^}]*min-height:\s*54rpx;/s);
  assert.match(wxss, /\.coarse-time-label\.is-collapsible:active\s*\{[^}]*background:\s*#ece9e4;/s);
  assert.match(wxss, /\.coarse-time-label-content\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;/s);
  assert.match(wxss, /\.coarse-time-label\.is-week \.coarse-time-label-content\s*\{[^}]*flex-direction:\s*column;[^}]*align-items:\s*flex-end;/s);
  assert.match(wxss, /\.coarse-time-label\.is-week \.coarse-collapse-indicator\s*\{[^}]*margin:\s*12rpx 0 0;/s);
  assert.match(wxss, /\.coarse-collapse-indicator\s*\{[^}]*border-right:\s*2rpx solid #78947f;[^}]*border-bottom:\s*2rpx solid #78947f;/s);
  assert.match(wxss, /\.coarse-collapse-indicator\s*\{[^}]*margin:\s*0 3rpx 0 10rpx;/s);
  assert.match(wxss, /\.rest-day-corner\s*\{[^}]*right:\s*0;[^}]*bottom:\s*0;[^}]*border-width:\s*0 0 24rpx 24rpx;/s);
  assert.match(wxss, /\.rest-day-corner\.rest-day-weekend\s*\{[^}]*border-bottom-color:\s*#9a938a;/s);
  assert.match(wxss, /\.rest-day-corner\.rest-day-holiday\s*\{[^}]*border-bottom-color:\s*#c17b70;/s);
  assert.doesNotMatch(wxss, /\.coarse-time-label\.is-collapsed \.coarse-collapse-indicator\s*\{[^}]*margin-/s);

  assert.match(script, /buildCoarseCalendarRows/);
  assert.match(script, /coarseCollapsedVisibleLineCount\(this\.data\.view\)/);
  assert.match(script, /row\.coarseLineCount > collapsedVisibleLineCount/);
  assert.match(script, /collapsedVisibleLineCount,/);
  assert.match(script, /currentTimeLinePlacement/);
  assert.match(script, /this\.data\.view === 'day'[\s\S]*buildCalendarBlocks/);
  assert.doesNotMatch(script, /timeline\s*=\s*timeRows\.flatMap/);
  assert.doesNotMatch(script, /refreshCurrentTimeLine[\s\S]*?this\.data\.timeRows\.map/);
});

test('日历计划优先级使用三档灰蓝色呈现，并与灰绿实际记录区分', () => {
  const script = fs.readFileSync(path.join(pagesRoot, 'calendar/index.js'), 'utf8');
  const wxml = fs.readFileSync(path.join(pagesRoot, 'calendar/index.wxml'), 'utf8');
  const wxss = fs.readFileSync(path.join(pagesRoot, 'calendar/index.wxss'), 'utf8');
  const editorWxss = fs.readFileSync(path.join(miniprogramRoot, 'components/plan-editor-sheet/index.wxss'), 'utf8');

  assert.match(wxml, /class="calendar-block \{\{item\.visualType\}\} \{\{item\.priorityClass\}\}/);
  assert.doesNotMatch(wxml, /detailItem\.displayPriority/);
  assert.doesNotMatch(script, /displayPriority:/);
  assert.match(script, /priorityAriaLabel/);
  assert.match(wxss, /\.legend-dot\.plan\s*\{[^}]*background:\s*#7f8ca1;/s);
  assert.match(wxss, /\.calendar-block\.plan\.plan-priority-1\s*\{[^}]*border-left-color:\s*#a7afbd;[^}]*background:\s*#eff1f4;[^}]*color:\s*#596577;/s);
  assert.match(wxss, /\.calendar-block\.plan\.plan-priority-2\s*\{[^}]*border-left-color:\s*#7f8ca1;[^}]*background:\s*#dde3ea;[^}]*color:\s*#47566b;/s);
  assert.match(wxss, /\.calendar-block\.plan\.plan-priority-3\s*\{[^}]*border-left-color:\s*#68788f;[^}]*background:\s*#c7ced8;[^}]*color:\s*#3f4d60;/s);
  assert.match(wxss, /\.calendar-block\.confirmed\s*\{[^}]*border-left:\s*7rpx solid #55725e;[^}]*background:\s*#d8e1da;[^}]*color:\s*#385846;/s);
  assert.match(editorWxss, /\.priority-1\s*\{\s*background:\s*#a7afbd;\s*\}/);
  assert.match(editorWxss, /\.priority-2\s*\{\s*background:\s*#7f8ca1;\s*\}/);
  assert.match(editorWxss, /\.priority-3\s*\{\s*background:\s*#68788f;\s*\}/);
});

test('所有自定义底部弹窗复用共享头部组件', () => {
  const expectedModalCounts = { plans: 5, calendar: 2 };
  const calendarModalBindings = [
    'closeItemDetail',
    'closeLogEditor'
  ];

  for (const page of ['timer', ...Object.keys(expectedModalCounts)]) {
    const pageDirectory = path.join(pagesRoot, page);
    const wxml = fs.readFileSync(path.join(pageDirectory, 'index.wxml'), 'utf8');
    const config = JSON.parse(fs.readFileSync(path.join(pageDirectory, 'index.json'), 'utf8'));
    const modalCount = (wxml.match(/class="modal(?:\s[^\"]*)?"/g) || []).length;
    const sheetHeaderCount = (wxml.match(/<sheet-header\b/g) || []).length;

    assert.equal(config.usingComponents['sheet-header'], '/components/sheet-header/index', page);
    if (expectedModalCounts[page] !== undefined) assert.equal(modalCount, expectedModalCounts[page], page);
    if (page === 'calendar') {
      assert.deepEqual(
        calendarModalBindings.filter((binding) => wxml.includes(`bindtap="${binding}"`)),
        calendarModalBindings
      );
    }
    assert.equal(sheetHeaderCount, modalCount, page);
    assert.doesNotMatch(wxml, /class="modal-title"/, page);
  }

  const planEditorWxml = fs.readFileSync(
    path.join(miniprogramRoot, 'components/plan-editor-sheet/index.wxml'),
    'utf8'
  );
  const planEditorModalCount = (planEditorWxml.match(/class="modal(?:\s[^\"]*)?"/g) || []).length;
  const planEditorSheetHeaderCount = (planEditorWxml.match(/<sheet-header\b/g) || []).length;
  assert.equal(planEditorModalCount, 2, 'plan-editor-sheet');
  assert.equal(planEditorSheetHeaderCount, planEditorModalCount, 'plan-editor-sheet');
  assert.match(planEditorWxml, /bindtap="cancel"/);
  assert.match(planEditorWxml, /bindtap="closeTaskPicker"/);
  assert.doesNotMatch(planEditorWxml, /class="modal-title"/);
});

test('日历详情弹窗危险操作左对齐、绿色主操作右对齐', () => {
  const wxml = fs.readFileSync(path.join(pagesRoot, 'calendar/index.wxml'), 'utf8');
  const wxss = fs.readFileSync(path.join(pagesRoot, 'calendar/index.wxss'), 'utf8');
  const startGroup = wxml.match(/class="detail-actions-start">([\s\S]*?)<\/view>\s*<view class="detail-actions-end">/)[1];
  const endGroup = wxml.match(/class="detail-actions-end">([\s\S]*?)<\/view>\s*<\/view>/)[1];

  assert.match(startGroup, /danger-action[\s\S]*deletePlan/);
  assert.match(startGroup, /danger-action[\s\S]*deleteRuleFollowing/);
  assert.match(startGroup, /danger-action[\s\S]*skipVirtualOccurrence/);
  assert.doesNotMatch(startGroup, /primary-action/);
  assert.match(endGroup, /primary-action[\s\S]*startTimerFromPlan">开始计时/);
  assert.match(endGroup, /detailItem\.virtual && detailItem\.canConfirmVirtual[^>]*bindtap="confirmItem">确认完成/);
  assert.match(endGroup, /detailItem\.type === 'candidate' && !detailItem\.virtual[^>]*bindtap="confirmItem">确认</);
  assert.doesNotMatch(endGroup, /danger-action/);
  assert.match(wxss, /\.detail-actions\s*\{[^}]*justify-content:\s*space-between;/s);
  assert.match(wxss, /\.detail-actions-start\s*\{[^}]*justify-content:\s*flex-start;/s);
  assert.match(wxss, /\.detail-actions-end\s*\{[^}]*justify-content:\s*flex-end;[^}]*margin-left:\s*auto;/s);
});

test('所有页面和共享控件使用莫兰迪绿色主色板', () => {
  const files = [
    path.join(miniprogramRoot, 'app.json'),
    path.join(miniprogramRoot, 'app.wxss'),
    path.join(miniprogramRoot, 'components/sheet-header/index.wxss')
  ];
  for (const page of ['timer', 'plans', 'calendar', 'profile']) {
    for (const extension of ['js', 'wxml', 'wxss']) {
      files.push(path.join(pagesRoot, page, `index.${extension}`));
    }
  }

  const source = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n').toLowerCase();
  const legacyColors = [
    '#22c55e', '#16a34a', '#15803d', '#166534', '#dcfce7', '#f0fdf4',
    '#86efac', '#bbf7d0', '#4ade80', '#3b82f6', '#2563eb', '#f59e0b',
    '#dc2626', '#b91c1c'
  ];
  for (const color of legacyColors) assert.doesNotMatch(source, new RegExp(color), color);

  assert.match(source, /#78947f/);
  assert.match(source, /#55725e/);
  assert.match(source, /#e6ece7/);
  assert.match(source, /#9a5550/);

});

test('用户页容量状态遵循安全百分比、灰琥珀预警和安全区布局', () => {
  const wxml = fs.readFileSync(path.join(pagesRoot, 'profile/index.wxml'), 'utf8');
  const wxss = fs.readFileSync(path.join(pagesRoot, 'profile/index.wxss'), 'utf8');
  const cloudButton = wxml.match(/<button[^>]*bindtap="openCloudStorage"[^>]*>/);

  assert.match(wxml, /style="width: \{\{storageUsage\.percent\}\}%;"/);
  assert.match(wxss, /\.storage-warning\s*\{[^}]*background:\s*#f5f0e6;[^}]*color:\s*#795d32;/s);
  assert.ok(cloudButton);
  assert.match(cloudButton[0], /class="[^"]*cloud-storage[^"]*"/);
  assert.doesNotMatch(cloudButton[0], /class="[^"]*\b(?:primary|danger)\b[^"]*"/);
  assert.match(wxss, /\.data-management-card\s*\{[^}]*safe-area-inset-bottom/s);
  assert.match(wxss, /\.storage-summary\s*\{[^}]*min-width:\s*0;/s);
  assert.match(wxss, /\.storage-value\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
});
