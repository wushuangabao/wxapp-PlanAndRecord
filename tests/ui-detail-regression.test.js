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

test('日历顶部提供当前范围、今天按钮、四种粒度与右对齐状态图例', () => {
  const script = fs.readFileSync(path.join(pagesRoot, 'calendar/index.js'), 'utf8');
  const wxml = fs.readFileSync(path.join(pagesRoot, 'calendar/index.wxml'), 'utf8');
  const wxss = fs.readFileSync(path.join(pagesRoot, 'calendar/index.wxss'), 'utf8');
  assert.match(script, /formatRangeLabel\(range, this\.data\.view\)/);
  assert.match(script, /data:\s*\{[\s\S]*?view:\s*'day'/);
  assert.match(script, /views:\s*\['year', 'month', 'week', 'day'\]/);
  assert.match(wxml, /class="range-label"/);
  assert.match(wxml, /class="toolbar-left">[\s\S]*class="range-label"[\s\S]*wx:if="\{\{!timeline\.length\}\}" class="range-empty"/);
  assert.match(wxml, /class="today-button \{\{rangeIncludesToday \? 'is-current-range' : ''\}\}"[^>]*bindtap="goToday"/);
  assert.match(wxml, /class="toolbar-right">[\s\S]*class="view-tabs"[\s\S]*class="calendar-legend"/);
  assert.match(wxml, /class="legend-dot plan"[\s\S]*>计划<[\s\S]*class="legend-dot candidate"[\s\S]*>候选<[\s\S]*class="legend-dot actual"[\s\S]*>实际</);
  assert.match(wxss, /\.range-label\s*\{[^}]*white-space:\s*nowrap;/s);
  assert.match(wxss, /\.toolbar-left,\s*\.toolbar-right\s*\{[^}]*grid-template-rows:\s*52rpx 20rpx;/s);
  assert.match(wxss, /\.toolbar-right\s*\{[^}]*justify-items:\s*end;/s);
  assert.match(wxss, /\.calendar-legend\s*\{[^}]*justify-content:\s*flex-end;/s);
  assert.match(wxss, /\.tab\s*\{[^}]*width:\s*54rpx;/s);
  assert.match(wxss, /\.today-button\s*\{[^}]*border:\s*0;/s);
  assert.match(wxss, /\.today-button\.is-current-range\s*\{[^}]*border:\s*4rpx solid #a9bdae;/s);
  assert.match(wxml, /class="calendar-scroll \{\{pageTurnClass\}\}"/);
  assert.match(wxml, /wx:if="\{\{currentTimeLineStyle\}\}" class="current-time-line" style="\{\{currentTimeLineStyle\}\}"/);
  assert.doesNotMatch(wxml, /class="calendar-empty"/);
  assert.doesNotMatch(wxml, /time-axis-terminal|24:00/);
  assert.match(script, /animateRangeChange\(deltaX < 0 \? 1 : -1\)/);
  assert.match(wxss, /@keyframes calendar-page-next/);
  assert.doesNotMatch(wxss, /\.calendar-toolbar\s*\{[^}]*min-height:/s);
  assert.match(wxss, /\.page\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s);
  assert.match(wxss, /\.calendar-scroll\s*\{[^}]*flex:\s*1 1 0;[^}]*height:\s*0;/s);
  assert.match(wxss, /\.time-row,\s*\.grid-row\s*\{[^}]*position:\s*absolute;/s);
  assert.match(wxml, /class="calendar-grid-bottom-line"/);
  assert.match(wxss, /\.calendar-grid-bottom-line\s*\{[^}]*bottom:\s*0;[^}]*background:\s*#dedad3;/s);
  assert.match(wxss, /\.calendar-scroll-safe-space\s*\{[^}]*background:\s*#f3f1ed;/s);
  assert.match(wxss, /\.calendar-scroll\s*\{[^}]*background:\s*#f3f1ed;/s);
  assert.doesNotMatch(wxml, /class="nav-button"/);
});

test('所有自定义底部弹窗复用共享头部组件', () => {
  const expectedModalCounts = { plans: 5, calendar: 4 };
  const calendarModalBindings = [
    'closeCreatePlan',
    'closeTaskPicker',
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
