const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { calendarRelativeLabel } = require('../miniprogram/utils/calendar-relative-label');
const { markPageVisible } = require('../miniprogram/utils/page');

const calendarWxmlPath = path.join(__dirname, '../miniprogram/pages/calendar/index.wxml');
const calendarWxssPath = path.join(__dirname, '../miniprogram/pages/calendar/index.wxss');
const timerWxssPath = path.join(__dirname, '../miniprogram/pages/timer/index.wxss');
const calendarPagePath = require.resolve('../miniprogram/pages/calendar/index.js');
const pagesRoot = path.join(__dirname, '../miniprogram/pages');

function loadCalendarPage() {
  const originalPage = global.Page;
  let page;
  global.Page = (definition) => { page = definition; };
  delete require.cache[calendarPagePath];
  require(calendarPagePath);
  global.Page = originalPage;
  page.setData = (updates, callback) => {
    Object.assign(page.data, updates);
    if (callback) callback();
  };
  return page;
}

test('日历翻页关系文案按本地日周月年粒度计算', () => {
  const now = new Date(2026, 7, 22, 12, 0).getTime();

  assert.equal(calendarRelativeLabel(new Date(2026, 7, 21, 8, 0).getTime(), 'day', now), '昨天');
  assert.equal(calendarRelativeLabel(new Date(2026, 7, 20, 22, 0).getTime(), 'day', now), '前天');
  assert.equal(calendarRelativeLabel(new Date(2026, 7, 19, 12, 0).getTime(), 'day', now), '3天前');
  assert.equal(calendarRelativeLabel(new Date(2026, 7, 24, 12, 0).getTime(), 'day', now), '后天');

  assert.equal(calendarRelativeLabel(new Date(2026, 7, 16, 12, 0).getTime(), 'week', now), '上周');
  assert.equal(calendarRelativeLabel(new Date(2026, 7, 31, 12, 0).getTime(), 'week', now), '2周后');

  assert.equal(calendarRelativeLabel(new Date(2026, 6, 31, 12, 0).getTime(), 'month', now), '上个月');
  assert.equal(calendarRelativeLabel(new Date(2026, 9, 1, 12, 0).getTime(), 'month', now), '2个月后');

  assert.equal(calendarRelativeLabel(new Date(2025, 11, 31, 12, 0).getTime(), 'year', now), '去年');
  assert.equal(calendarRelativeLabel(new Date(2028, 0, 1, 12, 0).getTime(), 'year', now), '2年后');
});

test('所有可见页面登记当前路由，供日历精确识别跨页面进入', () => {
  const originalGetApp = global.getApp;
  const app = { globalData: {} };
  global.getApp = () => app;
  try {
    assert.equal(markPageVisible('pages/calendar/index'), '');
    assert.equal(markPageVisible('pages/timer/index'), 'pages/calendar/index');
    assert.equal(app.globalData.visiblePageRoute, 'pages/timer/index');

    [
      ['calendar', 'pages/calendar/index'],
      ['timer', 'pages/timer/index'],
      ['plans', 'pages/plans/index'],
      ['profile', 'pages/profile/index'],
      ['data-recovery', 'pages/data-recovery/index']
    ].forEach(([directory, route]) => {
      const script = fs.readFileSync(path.join(pagesRoot, directory, 'index.js'), 'utf8');
      assert.match(script, new RegExp(`markPageVisible\\('${route.replaceAll('/', '\\/')}\\'\\)`));
    });
  } finally {
    global.getApp = originalGetApp;
  }
});

test('翻页关系提示悬浮在日历顶部并复用最近记录 new 的颜色', () => {
  const wxml = fs.readFileSync(calendarWxmlPath, 'utf8');
  const wxss = fs.readFileSync(calendarWxssPath, 'utf8');
  const timerWxss = fs.readFileSync(timerWxssPath, 'utf8');
  const newColor = timerWxss.match(/\.recent-new-badge\s*\{[^}]*color:\s*(#[0-9a-f]{6})/i)[1];
  const relativeLabelStyle = wxss.match(/\.page-turn-relative-label\s*\{[^}]*\}/s)[0];

  assert.match(wxml, /wx:if="\{\{pageTurnRelativeLabel\}\}"[\s\S]*class="page-turn-relative-label"/);
  assert.match(relativeLabelStyle, /position:\s*absolute/);
  assert.match(relativeLabelStyle, /top:\s*156rpx/);
  assert.match(relativeLabelStyle, /left:\s*50%/);
  assert.match(relativeLabelStyle, /font-size:\s*52rpx/);
  assert.match(relativeLabelStyle, /font-weight:\s*700/);
  assert.match(relativeLabelStyle, /background:\s*transparent/);
  assert.match(relativeLabelStyle, new RegExp(`color:\\s*${newColor}`, 'i'));
  assert.match(relativeLabelStyle, /pointer-events:\s*none/);
});

test('连续翻页会更新关系文案并把三秒消失计时重新开始', () => {
  const originalNow = Date.now;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const scheduled = [];

  Date.now = () => new Date(2026, 7, 22, 12, 0).getTime();
  global.setTimeout = (callback, delay) => {
    const timer = { callback, delay, active: true };
    scheduled.push(timer);
    return timer;
  };
  global.clearTimeout = (timer) => {
    if (timer) timer.active = false;
  };

  try {
    const page = loadCalendarPage();
    page.data.anchor = Date.now();
    page.data.view = 'day';
    page.refresh = () => {};

    page.animateRangeChange(1);
    scheduled.find((timer) => timer.delay === 140 && timer.active).callback();
    scheduled.find((timer) => timer.delay === 280 && timer.active).callback();
    const firstLabelTimer = scheduled.find((timer) => timer.delay === 3000);
    assert.equal(page.data.pageTurnRelativeLabel, '明天');

    page.animateRangeChange(1);
    scheduled.filter((timer) => timer.delay === 140 && timer.active).at(-1).callback();
    const labelTimers = scheduled.filter((timer) => timer.delay === 3000);
    assert.equal(firstLabelTimer.active, false);
    assert.equal(labelTimers.at(-1).active, true);
    assert.equal(page.data.pageTurnRelativeLabel, '后天');

    labelTimers.at(-1).callback();
    assert.equal(page.data.pageTurnRelativeLabel, '');
  } finally {
    Date.now = originalNow;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test('切换年、月、周、日视图时复用翻页关系提示', () => {
  const originalNow = Date.now;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const scheduled = [];

  Date.now = () => new Date(2026, 7, 22, 12, 0).getTime();
  global.setTimeout = (callback, delay) => {
    const timer = { callback, delay, active: true };
    scheduled.push(timer);
    return timer;
  };
  global.clearTimeout = (timer) => {
    if (timer) timer.active = false;
  };

  try {
    const page = loadCalendarPage();
    page.data.anchor = Date.now();
    page.data.view = 'day';
    page.refresh = (afterRefresh) => {
      if (afterRefresh) afterRefresh();
    };
    page.focusCurrentTime = () => {};

    [
      ['year', '今年'],
      ['month', '本月'],
      ['week', '本周'],
      ['day', '今天']
    ].forEach(([view, label]) => {
      page.changeView({ currentTarget: { dataset: { view } } });
      assert.equal(page.data.pageTurnRelativeLabel, label);
    });

    const labelTimers = scheduled.filter((timer) => timer.delay === 3000);
    assert.equal(labelTimers.length, 4);
    assert.deepEqual(labelTimers.map((timer) => timer.active), [false, false, false, true]);

    labelTimers.at(-1).callback();
    assert.equal(page.data.pageTurnRelativeLabel, '');
  } finally {
    Date.now = originalNow;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test('从其他页面切回日历时显示当前范围关系，首次冷启动不提示', () => {
  const originalGetApp = global.getApp;
  const originalNow = Date.now;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const app = { globalData: { calendarHandoff: null, visiblePageRoute: null } };
  const scheduled = [];

  global.getApp = () => app;
  Date.now = () => new Date(2026, 7, 22, 12, 0).getTime();
  global.setTimeout = (callback, delay) => {
    const timer = { callback, delay, active: true };
    scheduled.push(timer);
    return timer;
  };
  global.clearTimeout = (timer) => {
    if (timer) timer.active = false;
  };

  try {
    const page = loadCalendarPage();
    page.data.anchor = new Date(2026, 7, 31, 12, 0).getTime();
    page.data.view = 'week';
    page.refresh = (afterRefresh) => {
      if (afterRefresh) afterRefresh();
    };
    page.startCurrentTimeTicker = () => {};

    page.onShow();
    assert.equal(page.data.pageTurnRelativeLabel, '');

    page.onShow();
    assert.equal(page.data.pageTurnRelativeLabel, '');

    app.globalData.visiblePageRoute = 'pages/timer/index';
    page.onShow();
    assert.equal(page.data.pageTurnRelativeLabel, '2周后');
    const labelTimer = scheduled.find((timer) => timer.delay === 3000 && timer.active);
    assert.ok(labelTimer);

    labelTimer.callback();
    assert.equal(page.data.pageTurnRelativeLabel, '');
  } finally {
    global.getApp = originalGetApp;
    Date.now = originalNow;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test('携带定位目标切回日历时等待目标范围刷新后再显示关系提示', () => {
  const originalGetApp = global.getApp;
  const originalNow = Date.now;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const targetStart = new Date(2026, 7, 23, 9, 0).getTime();
  const app = { globalData: {
    visiblePageRoute: 'pages/plans/index',
    calendarHandoff: {
      type: 'reveal-record',
      id: 'log_target',
      startedAt: targetStart,
      endedAt: targetStart + 60 * 60 * 1000
    }
  } };

  global.getApp = () => app;
  Date.now = () => new Date(2026, 7, 22, 12, 0).getTime();
  global.setTimeout = () => ({ active: true });
  global.clearTimeout = () => {};

  try {
    const page = loadCalendarPage();
    page.data.anchor = new Date(2026, 6, 1, 12, 0).getTime();
    page.data.view = 'month';
    page.startCurrentTimeTicker = () => {};
    page.revealCreatedPlan = (target, afterReveal) => {
      page.data.anchor = target.startedAt;
      if (afterReveal) afterReveal();
    };

    page.onShow();

    assert.equal(page.data.view, 'day');
    assert.equal(page.data.anchor, targetStart);
    assert.equal(page.data.pageTurnRelativeLabel, '明天');
    assert.equal(app.globalData.calendarHandoff, null);
  } finally {
    global.getApp = originalGetApp;
    Date.now = originalNow;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});
