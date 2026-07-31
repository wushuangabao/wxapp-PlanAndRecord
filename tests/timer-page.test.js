const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { TIMER_STATUS } = require('../miniprogram/domain/constants');

const timerPagePath = require.resolve('../miniprogram/pages/timer/index.js');
const timerWxmlPath = path.join(__dirname, '../miniprogram/pages/timer/index.wxml');
const timerWxssPath = path.join(__dirname, '../miniprogram/pages/timer/index.wxss');
const NOW = 1_700_000_000_000;

function loadTimerPage() {
  const originalPage = global.Page;
  let page;
  global.Page = (definition) => { page = definition; };
  delete require.cache[timerPagePath];
  require(timerPagePath);
  global.Page = originalPage;
  return page;
}

function createHarness(timer) {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const originalDateNow = Date.now;
  let currentNow = NOW;
  const page = loadTimerPage();

  global.getApp = () => ({ globalData: { bootstrap: { applicationService: {} } } });
  global.wx = { showToast() {} };
  Date.now = () => currentNow;
  page.data = {
    ...page.data,
    timer,
    elapsed: '00:00:00',
    elapsedMinutes: 0
  };
  page.setData = (updates, callback) => {
    Object.assign(page.data, updates);
    if (callback) callback();
  };

  return {
    page,
    setNow(value) { currentNow = value; },
    restore() {
      global.getApp = originalGetApp;
      global.wx = originalWx;
      Date.now = originalDateNow;
    }
  };
}

test('M2：计时页按秒刷新显示，并预览向上取整后的记录分钟数', () => {
  const harness = createHarness({
    status: TIMER_STATUS.RUNNING,
    startedAt: NOW - 5_000,
    endedAt: null,
    pausedAt: null,
    pauses: [],
    draft: { tags: [] }
  });
  try {
    harness.page.updateElapsed();
    assert.equal(harness.page.data.elapsed, '00:00:05');
    assert.equal(harness.page.data.elapsedMinutes, 1);

    harness.setNow(NOW + 26_000);
    harness.page.updateElapsed();
    assert.equal(harness.page.data.elapsed, '00:00:31');
    assert.equal(harness.page.data.elapsedMinutes, 1);

    harness.setNow(NOW + 56_000);
    harness.page.updateElapsed();
    assert.equal(harness.page.data.elapsed, '00:01:01');
    assert.equal(harness.page.data.elapsedMinutes, 2);
  } finally {
    harness.restore();
  }
});

test('M2：计时页提供跨日期补录和恢复草稿修正入口', () => {
  const wxml = fs.readFileSync(timerWxmlPath, 'utf8');
  assert.match(wxml, /manualStartDate/);
  assert.match(wxml, /manualEndDate/);
  assert.match(wxml, /openRecoveryManual/);
  assert.match(wxml, /时 : 分 : 秒/);
});

test('恢复草稿手工保存会确认记录而非创建待核实候选', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const calls = [];
  const toasts = [];
  global.getApp = () => ({
    globalData: {
      bootstrap: {
        applicationService: {
          createRecoveryConfirmedLog(input) {
            calls.push(input);
            return { id: 'recovered_log' };
          }
        }
      }
    }
  });
  global.wx = { showToast(options) { toasts.push(options); } };
  try {
    const page = loadTimerPage();
    page.setData = (updates, callback) => {
      Object.assign(page.data, updates);
      if (callback) callback();
    };
    Object.assign(page.data, {
      manualMode: 'recovery',
      manualStartDate: '2023-11-14',
      manualStartTime: '09:00',
      manualEndDate: '2023-11-14',
      manualEndTime: '09:30',
      manualNote: '已核实恢复记录',
      manualTags: ['复盘'],
      manualEvents: [{ id: '', associationType: 'none', title: '计划外' }],
      manualEventIndex: 0
    });
    page.refresh = () => {};

    page.onManualSave();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].note, '已核实恢复记录');
    assert.deepEqual(calls[0].tags, ['复盘']);
    assert.equal(toasts.at(-1).title, '恢复记录已确认');
    const wxml = fs.readFileSync(timerWxmlPath, 'utf8');
    assert.match(wxml, /有一条待修正的恢复草稿/);
    assert.match(wxml, /修正并确认记录/);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('既有恢复草稿以新确认语义展示旧版原因文案', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const snapshot = {
    projects: [],
    tasks: [],
    calendarEvents: [],
    timeLogs: [],
    timer: { status: TIMER_STATUS.IDLE, draft: {} },
    recoveryDraft: {
      reason: '时间戳无法还原，请手工修正后再创建候选记录',
      timer: { status: TIMER_STATUS.IDLE, draft: {} }
    }
  };
  global.getApp = () => ({
    globalData: {
      bootstrap: {
        applicationService: {
          snapshot() { return snapshot; },
          planAssociationCandidates() { return []; }
        }
      }
    }
  });
  global.wx = { showToast() {} };
  try {
    const page = loadTimerPage();
    page.setData = (updates, callback) => {
      Object.assign(page.data, updates);
      if (callback) callback();
    };
    page.updateElapsed = () => {};
    page.startTicker = () => {};

    page.refresh();

    assert.equal(page.data.recoveryDraft.displayReason, '时间戳无法还原，请手工修正并确认记录');
    const wxml = fs.readFileSync(timerWxmlPath, 'utf8');
    assert.match(wxml, /\{\{recoveryDraft\.displayReason\}\}/);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('计时页把恢复草稿放在最近记录之后、计时器之前', () => {
  const wxml = fs.readFileSync(timerWxmlPath, 'utf8');
  const recentIndex = wxml.indexOf('class="section recent-section"');
  const recoveryIndex = wxml.indexOf('class="recovery-draft"');
  const timerIndex = wxml.indexOf('class="timer-card"');

  assert.ok(recentIndex >= 0);
  assert.ok(recoveryIndex > recentIndex);
  assert.ok(timerIndex > recoveryIndex);
});

test('计时页开发调试工具只在开发环境显示，并可贴边收起后构造恢复草稿', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const toasts = [];
  let debugCalls = 0;
  let refreshCalls = 0;
  global.getApp = () => ({
    globalData: {
      bootstrap: {
        applicationService: {
          simulateTimerRecoveryFailureForDebug() { debugCalls += 1; }
        }
      }
    }
  });
  global.wx = {
    getAccountInfoSync() { return { miniProgram: { envVersion: 'develop' } }; },
    showToast(options) { toasts.push(options); }
  };
  try {
    const page = loadTimerPage();
    page.setData = (updates, callback) => {
      Object.assign(page.data, updates);
      if (callback) callback();
    };
    page.onLoad();
    assert.equal(page.data.showDebugTools, true);

    page.onDebugDockTouchStart({ touches: [{ pageX: 100 }] });
    page.onDebugDockTouchEnd({ changedTouches: [{ pageX: 140 }] });
    assert.equal(page.data.debugPanelDock, 'left');
    assert.equal(page.data.debugPanelExpanded, false);
    page.toggleDebugPanel();
    assert.equal(page.data.debugPanelExpanded, false);
    page.toggleDebugPanel();
    assert.equal(page.data.debugPanelExpanded, true);

    page.refresh = () => { refreshCalls += 1; };
    page.onDebugTimerFailure();
    assert.equal(debugCalls, 1);
    assert.equal(refreshCalls, 1);
    assert.equal(page.data.debugPanelExpanded, false);
    assert.equal(toasts.at(-1).title, '已创建待修正的恢复草稿');

    page.setData({ showDebugTools: false });
    page.onDebugTimerFailure();
    assert.equal(debugCalls, 1);

    global.wx.getAccountInfoSync = () => ({ miniProgram: { envVersion: 'trial' } });
    const trialPage = loadTimerPage();
    trialPage.setData = (updates, callback) => {
      Object.assign(trialPage.data, updates);
      if (callback) callback();
    };
    trialPage.onLoad();
    assert.equal(trialPage.data.showDebugTools, false);

    const wxml = fs.readFileSync(timerWxmlPath, 'utf8');
    const wxss = fs.readFileSync(timerWxssPath, 'utf8');
    assert.match(wxml, /wx:if="\{\{showDebugTools\}\}"/);
    assert.match(wxml, /测试计时失败/);
    assert.match(wxml, /会立即创建一条待修正的恢复草稿。/);
    assert.match(wxml, /bindtouchend="onDebugDockTouchEnd"/);
    assert.match(wxss, /\.debug-dock--left/);
    assert.match(wxss, /\.debug-dock--right/);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('计时页最近记录以单条横向列展示并保留滑动尾部空间', () => {
  const wxml = fs.readFileSync(timerWxmlPath, 'utf8');
  const wxss = fs.readFileSync(timerWxssPath, 'utf8');

  assert.match(wxml, /<scroll-view wx:else class="recent-logs" scroll-x="\{\{recentScrollEnabled\}\}"[^>]*scroll-left="\{\{recentScrollLeft\}\}"[^>]*bindtouchend="onRecentTouchEnd">/);
  assert.match(wxml, /wx:for="\{\{recentLogs\}\}" wx:key="id" class="recent-column"/);
  assert.match(wxml, /class="recent-scroll-tail"/);
  assert.match(wxss, /\.recent-columns\s*\{[^}]*display:\s*flex;[^}]*column-gap:\s*20%;/s);
  assert.match(wxss, /\.recent-column\s*\{[^}]*flex:\s*0\s+0\s+60%;[^}]*max-width:\s*60%;/s);
  assert.match(wxss, /\.recent-scroll-tail\s*\{[^}]*flex:\s*0\s+0\s+20%;/s);
});

test('计时页最近记录展示备注、时间、标签和候选图标', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const snapshot = {
    projects: [],
    tasks: [],
    calendarEvents: [],
    timeLogs: [{
      id: 'log_candidate',
      startedAt: NOW,
      durationMinutes: 25,
      note: '自动整理会议纪要',
      tags: ['工作', '复盘'],
      status: 'candidate'
    }],
    timer: { status: TIMER_STATUS.IDLE, draft: {} },
    recoveryDraft: null
  };
  global.getApp = () => ({
    globalData: {
      bootstrap: {
        applicationService: {
          snapshot() { return snapshot; },
          planAssociationCandidates() { return []; }
        }
      }
    }
  });
  global.wx = { showToast() {} };
  const page = loadTimerPage();
  page.setData = (updates, callback) => {
    Object.assign(page.data, updates);
    if (callback) callback();
  };
  page.updateElapsed = () => {};
  page.startTicker = () => {};

  try {
    page.refresh();
    assert.equal(page.data.recentLogs[0].displayNote, '自动整理会议纪要');
    assert.deepEqual(page.data.recentLogs[0].tags, ['工作', '复盘']);
    assert.equal(page.data.recentLogs[0].isCandidate, true);

    const wxml = fs.readFileSync(timerWxmlPath, 'utf8');
    const wxss = fs.readFileSync(timerWxssPath, 'utf8');
    assert.match(wxml, /class="recent-log-note"/);
    assert.match(wxml, /class="recent-log-time muted"/);
    assert.match(wxml, /<view class="recent-log-tags" data-index="\{\{index\}\}" catchtouchstart="onRecentTagTouchStart" catchtouchmove="onRecentTagTouchMove" catchtouchend="onRecentTagTouchEnd" catchtouchcancel="onRecentTagTouchEnd" aria-label="标签">/);
    assert.match(wxml, /class="recent-log-tags-content"/);
    assert.match(wxml, /style="transform: translateX\(-\{\{item\.tagScrollLeft\}\}px\);"/);
    assert.match(wxml, /wx:for="\{\{item.tags\}\}"/);
    assert.match(wxml, /class="recent-candidate-icon" role="img" aria-label="自动生成，待确认"/);
    assert.doesNotMatch(wxml, /\{\{item\.status === 'candidate' \? '候选' : '实际'\}\}/);
    assert.match(wxss, /\.recent-log-row\s*\{[^}]*border-bottom:\s*0;/s);
    assert.doesNotMatch(wxss, /\.recent-logs\s*\{[^}]*height:/s);
    assert.match(wxss, /\.recent-log-row\s*\{[^}]*padding:\s*12rpx\s+0\s+0;/s);
    assert.match(wxss, /\.recent-log-note,\s*\.recent-log-time,\s*\.recent-log-tags\s*\{[^}]*flex:\s*0\s+0\s+auto;/s);
    assert.match(wxss, /\.recent-log-time\s*\{[^}]*height:\s*37rpx;/s);
    assert.match(wxss, /\.recent-log-tags\s*\{[^}]*height:\s*32rpx;/s);
    assert.match(wxss, /\.recent-log-tags\s*\{[^}]*overflow:\s*hidden;/s);
    assert.match(wxss, /\.recent-log-tags-content\s*\{[^}]*display:\s*inline-block;[^}]*min-width:\s*100%;[^}]*white-space:\s*nowrap;/s);
    assert.match(wxss, /\.recent-log-tag\s*\{[^}]*display:\s*inline-block;[^}]*margin-right:\s*10rpx;/s);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('计时页标签横滑期间暂停外层最近记录翻页，并在标签范围内平移', () => {
  const page = loadTimerPage();
  page.setData = (updates, callback) => {
    Object.assign(page.data, updates);
    if (callback) callback();
  };
  page.setData({
    recentScrollEnabled: true,
    recentLogs: [{ id: 'log_1', tagScrollLeft: 0, tagMaxScrollLeft: 60 }]
  });

  page.onRecentTagTouchStart({
    currentTarget: { dataset: { index: 0 } },
    touches: [{ pageX: 180 }]
  });
  assert.equal(page.data.recentScrollEnabled, false);
  page.onRecentTagTouchMove({ touches: [{ pageX: 40 }] });
  assert.equal(page.data.recentLogs[0].tagScrollLeft, 60);
  page.onRecentTagTouchMove({ touches: [{ pageX: 220 }] });
  assert.equal(page.data.recentLogs[0].tagScrollLeft, 0);
  page.onRecentTagTouchEnd();
  assert.equal(page.data.recentScrollEnabled, true);
});

test('计时页最近记录按整列吸附，首列右拖后回弹', () => {
  const page = loadTimerPage();
  page.setData = (updates, callback) => {
    Object.assign(page.data, updates);
    if (callback) callback();
  };
  Object.assign(page.data, {
    recentLogs: [{ id: 'log_1' }, { id: 'log_2' }, { id: 'log_3' }],
    recentColumnIndex: 0,
    recentColumnStep: 240,
    recentScrollLeft: 0,
    recentScrollWithAnimation: true,
    recentBoundaryOffset: 0,
    recentBoundaryIsDragging: false
  });

  assert.equal(typeof page.snapRecentColumn, 'function');
  page.snapRecentColumn(9);
  assert.equal(page.data.recentColumnIndex, 2);
  assert.equal(page.data.recentScrollLeft, 480);

  page.setData({ recentColumnIndex: 0, recentScrollLeft: 0 });
  page.onRecentTouchStart({ touches: [{ pageX: 200 }] });
  page.onRecentTouchMove({ touches: [{ pageX: 260 }] });
  assert.equal(page.data.recentBoundaryOffset, 27);
  page.onRecentTouchEnd({ changedTouches: [{ pageX: 260 }] });
  assert.equal(page.data.recentBoundaryOffset, 0);
  assert.equal(page.data.recentScrollLeft, 0);
  page.clearRecentScrollAnimation();
});

test('计时页最近记录轻拖回弹，快速横划只进入相邻列', () => {
  const page = loadTimerPage();
  const originalDateNow = Date.now;
  const originalSetTimeout = global.setTimeout;
  const scheduled = [];
  let now = NOW;
  Date.now = () => now;
  global.setTimeout = (callback, delay) => {
    scheduled.push({ callback, delay });
    return scheduled.length;
  };
  page.setData = (updates, callback) => {
    Object.assign(page.data, updates);
    if (callback) callback();
  };
  Object.assign(page.data, {
    recentLogs: [{ id: 'log_1' }, { id: 'log_2' }, { id: 'log_3' }],
    recentColumnIndex: 0,
    recentColumnStep: 240,
    recentScrollLeft: 0,
    recentScrollWithAnimation: true,
    recentBoundaryOffset: 0,
    recentBoundaryIsDragging: false
  });
  try {
    page.onRecentTouchStart({ touches: [{ pageX: 200 }] });
    page.onRecentScroll({ detail: { scrollLeft: 24 } });
    page.onRecentTouchEnd({ changedTouches: [{ pageX: 180 }] });
    assert.deepEqual(
      { index: page.data.recentColumnIndex, left: page.data.recentScrollLeft, nativeAnimation: page.data.recentScrollWithAnimation },
      { index: 0, left: 20, nativeAnimation: false }
    );
    assert.deepEqual(scheduled.map((item) => item.delay), [16]);

    now += 300;
    scheduled.shift().callback();
    assert.ok(page.data.recentScrollLeft >= 0 && page.data.recentScrollLeft < 20);
    now += 120;
    scheduled.shift().callback();
    assert.equal(page.data.recentScrollLeft, 0);

    page.setData({ recentColumnIndex: 0, recentScrollLeft: 0 });
    page.onRecentTouchStart({ touches: [{ pageX: 240 }] });
    page.onRecentScroll({ detail: { scrollLeft: 510 } });
    page.onRecentTouchEnd({ changedTouches: [{ pageX: 80 }] });
    assert.deepEqual(
      { index: page.data.recentColumnIndex, left: page.data.recentScrollLeft, nativeAnimation: page.data.recentScrollWithAnimation },
      { index: 1, left: 160, nativeAnimation: false }
    );
    now += 300;
    scheduled.shift().callback();
    assert.ok(page.data.recentScrollLeft > 240);
    now += 120;
    scheduled.shift().callback();
    assert.equal(page.data.recentScrollLeft, 240);
  } finally {
    Date.now = originalDateNow;
    global.setTimeout = originalSetTimeout;
    page.clearRecentScrollAnimation();
  }
});

test('计时页最近记录松手早于 scroll 事件时仍从手势位移平滑回弹', () => {
  const page = loadTimerPage();
  const originalDateNow = Date.now;
  const originalSetTimeout = global.setTimeout;
  const scheduled = [];
  let now = NOW;
  Date.now = () => now;
  global.setTimeout = (callback, delay) => {
    scheduled.push({ callback, delay });
    return scheduled.length;
  };
  page.setData = (updates, callback) => {
    Object.assign(page.data, updates);
    if (callback) callback();
  };
  Object.assign(page.data, {
    recentLogs: [{ id: 'log_1' }, { id: 'log_2' }],
    recentColumnIndex: 0,
    recentColumnStep: 240,
    recentScrollLeft: 0,
    recentScrollWithAnimation: true,
    recentBoundaryOffset: 0,
    recentBoundaryIsDragging: false
  });
  try {
    page.onRecentTouchStart({ touches: [{ pageX: 200 }] });
    page.onRecentTouchMove({ touches: [{ pageX: 180 }] });
    page.onRecentTouchEnd({ changedTouches: [{ pageX: 180 }] });

    assert.deepEqual(
      { index: page.data.recentColumnIndex, left: page.data.recentScrollLeft, nativeAnimation: page.data.recentScrollWithAnimation },
      { index: 0, left: 20, nativeAnimation: false }
    );
    assert.deepEqual(scheduled.map((item) => item.delay), [16]);

    page.onRecentScroll({ detail: { scrollLeft: 20 } });
    now += 420;
    scheduled.shift().callback();
    assert.equal(page.data.recentScrollLeft, 0);
  } finally {
    Date.now = originalDateNow;
    global.setTimeout = originalSetTimeout;
    page.clearRecentScrollAnimation();
  }
});

test('结束计时会先持久化当前记录字段', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const calls = [];
  global.getApp = () => ({
    globalData: {
      bootstrap: {
        applicationService: {
          updateTimerDraft(input) { calls.push(['update', input]); },
          finishTimer() { calls.push(['finish']); }
        }
      }
    }
  });
  global.wx = { showToast() {} };
  try {
    const page = loadTimerPage();
    page.setData = (updates, callback) => {
      Object.assign(page.data, updates);
      if (callback) callback();
    };
    Object.assign(page.data, {
      timer: { status: TIMER_STATUS.RUNNING },
      events: [
        { id: '', associationType: 'none', title: '计划外' },
        { id: 'event_focus', associationType: 'event', title: '专注计划' }
      ],
      eventIndex: 1,
      note: '补充备注',
      tags: ['工作', '复盘']
    });
    page.refresh = () => { calls.push(['refresh']); };

    page.onFinishTimer();

    assert.deepEqual(calls, [
      ['update', { calendarEventId: 'event_focus', note: '补充备注', tags: ['工作', '复盘'] }],
      ['finish'],
      ['refresh']
    ]);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('计时页只提交可选标签和计划块，不暴露分类、项目或任务选择器', () => {
  const page = loadTimerPage();
  page.data = {
    ...page.data,
    events: [{ id: '', title: '计划外' }, { id: 'event_plan', title: '写方案' }],
    eventIndex: 1,
    note: '按计划执行',
    tags: ['深度', '写作', 'AI']
  };
  assert.deepEqual(page.selectedInput(), {
    calendarEventId: 'event_plan',
    note: '按计划执行',
    tags: ['深度', '写作', 'AI']
  });
  assert.equal(page.data.maxTagsPerLog, 10);
  assert.equal(page.data.maxTagLength, 5);

  const wxml = fs.readFileSync(timerWxmlPath, 'utf8');
  assert.match(wxml, /计划块：/);
  assert.doesNotMatch(wxml, /分类：|项目：|任务：/);
  assert.match(wxml, /wx:for="\{\{tags\}\}"/);
  assert.match(wxml, /class="tag-chip tag-add"/);
  assert.match(wxml, /bindtap="removeTag"/);
  assert.doesNotMatch(wxml, /逗号分隔/);
});

test('计时页保留导入的超限标签交给应用服务按领域规则判断', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const calls = [];
  const toasts = [];
  global.getApp = () => ({
    globalData: {
      bootstrap: {
        applicationService: {
          startTimer(input) {
            calls.push(input);
            const error = new Error('一条记录最多添加 10 个标签');
            error.code = 'TAG_COUNT_EXCEEDED';
            throw error;
          }
        }
      }
    }
  });
  global.wx = {
    showToast(options) { toasts.push(options); }
  };
  try {
    const page = loadTimerPage();
    page.setData = (updates) => Object.assign(page.data, updates);
    page.refresh = () => {};
    Object.assign(page.data, {
      timer: { status: TIMER_STATUS.IDLE },
      events: [{ id: '', title: '计划外', associationType: 'none' }],
      eventIndex: 0,
      tags: ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一']
    });

    page.onPrimary();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].tags.length, 11);
    assert.equal(toasts.at(-1).title, '一条记录最多添加 10 个标签');
    assert.equal(toasts.at(-1).icon, 'none');
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('计时页保留导入的超限标签数组，由应用服务按规范化结果判断是否实际修改', () => {
  const page = loadTimerPage();
  const importedTags = Array.from({ length: 11 }, (_, index) => `标签${index}`);
  Object.assign(page.data, {
    events: [{ id: '', title: '计划外', associationType: 'none' }],
    eventIndex: 0,
    tags: importedTags,
    manualEvents: [{ id: '', title: '计划外', associationType: 'none' }],
    manualEventIndex: 0,
    manualTags: importedTags
  });

  assert.deepEqual(page.selectedInput().tags, importedTags);
  assert.deepEqual(page.selectedManualInput().tags, importedTags);
});

test('计时页以标签块添加、规范化和移除标签', () => {
  const originalWx = global.wx;
  const toasts = [];
  global.wx = { showToast(options) { toasts.push(options); } };
  try {
    const page = loadTimerPage();
    page.setData = (updates) => Object.assign(page.data, updates);
    page.openTagInput({ currentTarget: { dataset: { inputVisibleKey: 'tagInputVisible' } } });
    page.addTag({
      currentTarget: { dataset: { tagsKey: 'tags', inputVisibleKey: 'tagInputVisible' } },
      detail: { value: ' ＡＩ ' }
    });
    assert.deepEqual(page.data.tags, ['AI']);
    assert.equal(page.data.tagInputVisible, false);

    page.openTagInput({ currentTarget: { dataset: { inputVisibleKey: 'tagInputVisible' } } });
    page.addTag({
      currentTarget: { dataset: { tagsKey: 'tags', inputVisibleKey: 'tagInputVisible' } },
      detail: { value: 'AI' }
    });
    assert.equal(toasts.at(-1).title, '标签已存在');
    assert.equal(page.data.tagInputVisible, true);

    page.removeTag({ currentTarget: { dataset: { tagsKey: 'tags', index: 0 } } });
    assert.deepEqual(page.data.tags, []);
  } finally {
    global.wx = originalWx;
  }
});

test('计时页会显示并保留当前重复计划，已有同源日志后仍可再次选择该实例', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const page = loadTimerPage();
  const ranges = [];
  const snapshot = {
    projects: [],
    tasks: [{ id: 'task_repeat', title: '重复任务', status: 'todo' }],
    calendarEvents: [],
    timeLogs: [{
      id: 'log_existing_origin',
      originRuleId: 'rule_choice',
      originOccurrenceId: 'rule_choice:1:1700000000000'
    }],
    timer: {
      status: TIMER_STATUS.RUNNING,
      startedAt: NOW,
      endedAt: null,
      pausedAt: null,
      pauses: [],
      draft: {
        calendarEventId: null,
        originRuleId: 'rule_repeat',
        originOccurrenceId: 'rule_repeat:1:1700000000000',
        originRuleSummarySnapshot: '每日整理',
        note: '',
        tags: ['a,b', '复,盘']
      }
    },
    recoveryDraft: null
  };
  const service = {
    snapshot() { return snapshot; },
    timeline() {
      throw new Error('计划选择器不应使用会按日志去重的 timeline');
    },
    planAssociationCandidates(start, end) {
      ranges.push({ start, end });
      return [{
        id: 'event_near',
        type: 'plan',
        virtual: false,
        taskId: 'task_repeat',
        title: '具体计划',
        startedAt: NOW,
        endedAt: NOW + 60_000
      }, {
        id: 'rule_choice:1:1700000000000',
        type: 'candidate',
        virtual: true,
        ruleId: 'rule_choice',
        originOccurrenceId: 'rule_choice:1:1700000000000',
        taskId: 'task_repeat',
        title: '可选循环计划',
        startedAt: NOW,
        endedAt: NOW + 60_000
      }, {
        id: 'rule_taskless:1:1700000000000',
        type: 'candidate',
        virtual: true,
        ruleId: 'rule_taskless',
        originOccurrenceId: 'rule_taskless:1:1700000000000',
        taskId: 'deleted_task',
        title: '失效循环计划',
        startedAt: NOW,
        endedAt: NOW + 60_000
      }];
    }
  };
  global.getApp = () => ({
    globalData: {
      bootstrap: {
        applicationService: service
      }
    }
  });
  global.wx = { showToast() {} };
  page.setData = (updates, callback) => {
    Object.assign(page.data, updates);
    if (callback) callback();
  };
  page.updateElapsed = () => {};
  page.startTicker = () => {};
  try {
    page.refresh();
    assert.equal(page.data.events[page.data.eventIndex].associationType, 'current-origin');
    assert.equal(page.data.events.some((item) => item.associationType === 'event'), true);
    assert.equal(page.data.events.some((item) => item.originRuleId === 'rule_choice'), true);
    assert.equal(page.data.events.some((item) => item.originRuleId === 'rule_taskless'), false);
    assert.ok(ranges.every((range) => range.end - range.start <= 3 * 24 * 60 * 60 * 1_000));
    assert.deepEqual(page.data.tags, ['a,b', '复,盘']);
    assert.deepEqual(page.selectedInput(), {
      note: '',
      tags: ['a,b', '复,盘']
    });
    page.data.tags = page.data.tags.concat('新增');
    assert.deepEqual(page.selectedInput().tags, ['a,b', '复,盘', '新增']);
    page.data.tags = ['a,b', '复,盘'];
    const virtualIndex = page.data.events.findIndex(
      (item) => item.originRuleId === 'rule_choice'
    );
    page.data.eventIndex = virtualIndex;
    assert.deepEqual(page.selectedInput(), {
      originRuleId: 'rule_choice',
      originOccurrenceId: 'rule_choice:1:1700000000000',
      note: '',
      tags: ['a,b', '复,盘']
    });
    page.data.eventIndex = 0;
    assert.equal(page.selectedInput().calendarEventId, null);

    page.data.recoveryDraft = {
      timer: {
        startedAt: NOW,
        endedAt: NOW + 60_000,
        draft: {
          originRuleId: 'rule_repeat',
          originOccurrenceId: 'rule_repeat:1:1700000000000',
          originRuleSummarySnapshot: '每日整理',
          note: '',
          tags: ['恢复,一', '复,盘']
        }
      }
    };
    page.openRecoveryManual();
    assert.equal(
      page.data.manualEvents[page.data.manualEventIndex].associationType,
      'current-origin'
    );
    assert.equal(
      page.data.manualEvents.some((item) => item.originRuleId === 'rule_choice'),
      true
    );
    assert.equal(
      page.data.manualEvents.some((item) => item.calendarEventId === 'event_near'),
      true
    );
    assert.deepEqual(page.selectedManualInput(), {
      tags: ['恢复,一', '复,盘']
    });
    page.data.manualEventIndex = 0;
    assert.equal(page.selectedManualInput().calendarEventId, null);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('手工补录按记录区间有限投影具体与重复计划候选', () => {
  const page = loadTimerPage();
  const ranges = [];
  const snapshot = {
    projects: [],
    tasks: [{ id: 'task_live', title: '有效任务', status: 'todo' }],
    calendarEvents: [],
    timeLogs: [],
    timer: { status: TIMER_STATUS.IDLE, draft: {} },
    recoveryDraft: null
  };
  const service = {
    snapshot() { return snapshot; },
    timeline() {
      throw new Error('计划选择器不应使用会按日志去重的 timeline');
    },
    planAssociationCandidates(start, end) {
      ranges.push({ start, end });
      return [{
        id: 'event_manual',
        type: 'plan',
        virtual: false,
        taskId: 'task_live',
        title: '补录具体计划',
        startedAt: new Date(2026, 6, 30, 9, 0).getTime(),
        endedAt: new Date(2026, 6, 30, 9, 30).getTime()
      }, {
        id: 'rule_manual:1:123',
        type: 'candidate',
        virtual: true,
        ruleId: 'rule_manual',
        originOccurrenceId: 'rule_manual:1:123',
        taskId: 'task_live',
        title: '补录循环计划',
        startedAt: new Date(2026, 6, 30, 9, 30).getTime(),
        endedAt: new Date(2026, 6, 30, 10, 0).getTime()
      }];
    }
  };
  page.setData = (updates, callback) => {
    Object.assign(page.data, updates);
    if (callback) callback();
  };
  Object.assign(page.data, {
    events: [{ id: '', title: '计划外', associationType: 'none' }],
    eventIndex: 0,
    manualStartDate: '2026-07-30',
    manualStartTime: '09:00',
    manualEndDate: '2026-07-30',
    manualEndTime: '10:00'
  });
  page.currentSnapshot = snapshot;
  page.currentService = service;

  page.openManual();
  const virtualIndex = page.data.manualEvents.findIndex(
    (item) => item.originRuleId === 'rule_manual'
  );
  assert.ok(virtualIndex > 0);
  assert.equal(
    page.data.manualEvents.some((item) => item.calendarEventId === 'event_manual'),
    true
  );
  page.data.manualEventIndex = virtualIndex;
  assert.deepEqual(page.selectedManualInput(), {
    originRuleId: 'rule_manual',
    originOccurrenceId: 'rule_manual:1:123',
    tags: []
  });
  assert.equal(
    ranges[0].start,
    new Date(2026, 6, 30, 9, 0).getTime() - 24 * 60 * 60 * 1_000
  );
  assert.ok(ranges[0].end - ranges[0].start <= 3 * 24 * 60 * 60 * 1_000);

  const before = ranges.length;
  page.onManualField({
    currentTarget: { dataset: { key: 'manualStartTime' } },
    detail: { value: '08:30' }
  });
  assert.equal(ranges.length, before + 1);
});
