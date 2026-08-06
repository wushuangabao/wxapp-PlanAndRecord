const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { TIMER_STATUS } = require('../miniprogram/domain/constants');
const { LocalPreferenceStore } = require('../miniprogram/services/local-preference-store');

const timerPagePath = require.resolve('../miniprogram/pages/timer/index.js');
const timerWxmlPath = path.join(__dirname, '../miniprogram/pages/timer/index.wxml');
const timerWxssPath = path.join(__dirname, '../miniprogram/pages/timer/index.wxss');
const timerJsonPath = path.join(__dirname, '../miniprogram/pages/timer/index.json');
const editIconWxmlPath = path.join(__dirname, '../miniprogram/components/edit-icon/index.wxml');
const editIconWxssPath = path.join(__dirname, '../miniprogram/components/edit-icon/index.wxss');
const NOW = 1_700_000_000_000;

function preferenceStoreForMap(values) {
  return new LocalPreferenceStore({
    has: (key) => values.has(key),
    get: (key) => (values.has(key) ? structuredClone(values.get(key)) : ''),
    set: (key, value) => values.set(key, structuredClone(value)),
    remove: (key) => values.delete(key)
  });
}

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
    pausedAt: null,
    pauses: [],
    draft: { tags: [] }
  });
  try {
    harness.page.updateElapsed();
    assert.equal(harness.page.data.elapsed, '00:00:05');
    assert.equal(harness.page.data.elapsedMinutes, 1);
    assert.equal(harness.page.data.statusLabel, '计时中（1分钟）');

    harness.setNow(NOW + 26_000);
    harness.page.updateElapsed();
    assert.equal(harness.page.data.elapsed, '00:00:31');
    assert.equal(harness.page.data.elapsedMinutes, 1);

    harness.setNow(NOW + 56_000);
    harness.page.updateElapsed();
    assert.equal(harness.page.data.elapsed, '00:01:01');
    assert.equal(harness.page.data.elapsedMinutes, 2);
    assert.equal(harness.page.data.statusLabel, '计时中（2分钟）');
  } finally {
    harness.restore();
  }
});

test('M2：暂停时只显示已暂停', () => {
  const harness = createHarness({
    status: TIMER_STATUS.PAUSED,
    startedAt: NOW - 120_000,
    pausedAt: NOW - 30_000,
    pauses: [],
    draft: { tags: [] }
  });
  try {
    harness.page.updateElapsed();
    assert.equal(harness.page.data.statusLabel, '已暂停');

  } finally {
    harness.restore();
  }
});

test('M2：计时页提供跨日期补录和恢复草稿修正入口', () => {
  const wxml = fs.readFileSync(timerWxmlPath, 'utf8');
  assert.match(wxml, /manualStartDate/);
  assert.match(wxml, /manualEndDate/);
  assert.match(wxml, /openRecoveryManual/);
  assert.doesNotMatch(wxml, /记录时长/);
  assert.match(wxml, /class="timer-actions/);
  assert.match(wxml, /wx:if="\{\{timer\.status !== 'idle'\}\}"/);
  assert.match(wxml, /<button wx:if="\{\{!recoveryDraft \|\| timer\.status !== 'idle'\}\}" class="primary" bindtap="onPrimary">/);
  assert.doesNotMatch(wxml, /timer\.status !== 'ended'/);
});

test('恢复草稿存在时计时页不再发起新的开始计时请求', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  let startCalls = 0;
  global.getApp = () => ({ globalData: { bootstrap: { applicationService: {
    startTimer() { startCalls += 1; }
  } } } });
  global.wx = { showToast() {} };
  try {
    const page = loadTimerPage();
    page.setData = (updates, callback) => {
      Object.assign(page.data, updates);
      if (callback) callback();
    };
    page.data.timer = { status: TIMER_STATUS.IDLE };
    page.data.recoveryDraft = { reason: '待处理' };

    page.onPrimary();

    assert.equal(startCalls, 0);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('恢复草稿手工保存会确认记录而非创建待核实候选', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const calls = [];
  const refreshCalls = [];
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
    page.refresh = (options) => { refreshCalls.push(options); };

    page.onManualSave();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].note, '已核实恢复记录');
    assert.deepEqual(calls[0].tags, ['复盘']);
    assert.deepEqual(refreshCalls, [{ newLogId: 'recovered_log' }]);
    assert.equal(toasts.at(-1).title, '恢复记录已确认');
    const wxml = fs.readFileSync(timerWxmlPath, 'utf8');
    assert.match(wxml, /\{\{recoveryDraft\.displayTitle\}\}/);
    assert.match(wxml, /\{\{recoveryDraft\.confirmLabel\}\}/);
    assert.match(wxml, /放弃并删除记录/);
    assert.match(wxml, /bindtap="onDiscardRecoveryDraft"/);
    assert.doesNotMatch(wxml, /confirmCandidateLog|discardCandidate/);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('手工补录会替换最近记录的 new 标记', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const refreshCalls = [];
  const toasts = [];
  global.getApp = () => ({
    globalData: {
      bootstrap: {
        applicationService: {
          createManualLog() {
            return { log: { id: 'manual_log' }, hasOverlap: true };
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
      manualMode: 'manual',
      manualStartDate: '2023-11-14',
      manualStartTime: '09:00',
      manualEndDate: '2023-11-14',
      manualEndTime: '09:30',
      manualNote: '补录',
      manualTags: [],
      manualEvents: [{ id: '', associationType: 'none', title: '计划外' }],
      manualEventIndex: 0
    });
    page.refresh = (options) => { refreshCalls.push(options); };

    page.onManualSave();

    assert.deepEqual(refreshCalls, [{ newLogId: 'manual_log' }]);
    assert.equal(toasts.at(-1).title, '补录已保存');
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('核实自动恢复候选预览且未修改时间时保留其秒级区间', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const calls = [];
  const refreshCalls = [];
  const candidatePreview = {
    startedAt: NOW + 8_000,
    endedAt: NOW + 16_000,
    pausedDurationSeconds: 3,
    durationMinutes: 1,
    source: 'timer'
  };
  const snapshot = {
    projects: [], tasks: [], calendarEvents: [], timeLogs: [],
    timer: { status: TIMER_STATUS.IDLE, draft: {} },
    recoveryDraft: {
      reason: '计时超过恢复时间窗口，系统已生成候选，请核实后确认记录',
      timer: { status: TIMER_STATUS.IDLE, draft: { note: '自动恢复', tags: [] } },
      candidatePreview
    }
  };
  const service = {
    snapshot() { return snapshot; },
    planAssociationCandidates() { return []; },
    createRecoveryConfirmedLog(input) {
      calls.push(input);
      return { id: 'confirmed_from_preview' };
    }
  };
  global.getApp = () => ({ globalData: { bootstrap: { applicationService: service } } });
  global.wx = { showToast() {} };
  try {
    const page = loadTimerPage();
    page.setData = (updates, callback) => {
      Object.assign(page.data, updates);
      if (callback) callback();
    };
    page.currentService = service;
    page.currentSnapshot = snapshot;
    page.data.recoveryDraft = snapshot.recoveryDraft;
    page.refresh = (options) => { refreshCalls.push(options); };

    page.openRecoveryManual();
    page.onManualSave();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].startedAt, candidatePreview.startedAt);
    assert.equal(calls[0].endedAt, candidatePreview.endedAt);
    assert.equal(calls[0].pausedDurationSeconds, 3);
    assert.deepEqual(refreshCalls, [{ newLogId: 'confirmed_from_preview' }]);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('手工补录支持跨日秒级区间与暂停秒数', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  let received;
  global.getApp = () => ({ globalData: { bootstrap: { applicationService: {
    createManualLog(input) {
      received = input;
      return { log: { id: 'manual_cross_day' }, hasOverlap: false };
    }
  } } } });
  global.wx = { showToast() {} };
  try {
    const page = loadTimerPage();
    page.setData = (values, callback) => {
      Object.assign(page.data, values);
      if (callback) callback();
    };
    Object.assign(page.data, {
      manualMode: 'manual',
      manualStartDate: '2026-08-04',
      manualStartTime: '23:59:58',
      manualStartTimeEdited: true,
      manualEndDate: '2026-08-05',
      manualEndTime: '00:01:02',
      manualEndTimeEdited: true,
      manualPausedDurationSeconds: 4,
      manualNote: '跨日补录',
      manualTags: [],
      manualEvents: [{ id: '', associationType: 'none' }],
      manualEventIndex: 0
    });
    page.refresh = () => {};

    page.onManualSave();

    assert.equal(received.startedAt, new Date(2026, 7, 4, 23, 59, 58, 0).getTime());
    assert.equal(received.endedAt, new Date(2026, 7, 5, 0, 1, 2, 0).getTime());
    assert.equal(received.pausedDurationSeconds, 4);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('放弃恢复草稿须经确认后删除草稿', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const calls = [];
  const toasts = [];
  global.getApp = () => ({
    globalData: {
      bootstrap: {
        applicationService: {
          discardRecoveryDraft() { calls.push('discard'); }
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
    page.data.recoveryDraft = { reason: '时间戳无法还原' };
    page.refresh = () => { calls.push('refresh'); };

    page.onDiscardRecoveryDraft();

    assert.equal(page.data.showDiscardRecoveryConfirm, true);
    assert.deepEqual(calls, []);
    page.confirmDiscardRecoveryDraft();
    assert.equal(page.data.showDiscardRecoveryConfirm, false);
    assert.deepEqual(calls, ['discard', 'refresh']);
    assert.equal(toasts.at(-1).title, '已放弃并删除恢复草稿');
    const wxml = fs.readFileSync(timerWxmlPath, 'utf8');
    assert.match(wxml, /showDiscardRecoveryConfirm/);
    assert.match(wxml, /bind:confirm="confirmDiscardRecoveryDraft"/);
    assert.match(wxml, /bind:cancel="cancelDiscardRecoveryDraft"/);
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

    assert.equal(page.data.recoveryDraft.displayTitle, '有一条待修正的恢复草稿');
    assert.equal(page.data.recoveryDraft.confirmLabel, '修正并确认记录');
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

test('计时页最近记录展示备注、时间、标签、自动标识与操作按钮', () => {
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
    page.refresh({ newLogId: 'log_candidate' });
    assert.equal(page.data.recentLogs[0].displayNote, '自动整理会议纪要');
    assert.deepEqual(page.data.recentLogs[0].tags, ['工作', '复盘']);
    assert.equal(page.data.recentLogs[0].isCandidate, true);
    assert.equal(page.data.recentLogs[0].isNew, true);

    snapshot.timeLogs[0].note = '\u200B  ';
    page.refresh();
    assert.equal(page.data.recentLogs[0].displayNote, '未命名记录');

    const wxml = fs.readFileSync(timerWxmlPath, 'utf8');
    const wxss = fs.readFileSync(timerWxssPath, 'utf8');
    const timerJson = JSON.parse(fs.readFileSync(timerJsonPath, 'utf8'));
    const editIconWxml = fs.readFileSync(editIconWxmlPath, 'utf8');
    const editIconWxss = fs.readFileSync(editIconWxssPath, 'utf8');
    assert.match(wxml, /\{\{item\.displayNote \|\| '未命名记录'\}\}/);
    assert.match(wxml, /class="recent-log-note"/);
    assert.match(wxml, /class="recent-log-time muted"/);
    assert.match(wxml, /<view class="recent-log-tags" data-index="\{\{index\}\}" catchtouchstart="onRecentTagTouchStart" catchtouchmove="onRecentTagTouchMove" catchtouchend="onRecentTagTouchEnd" catchtouchcancel="onRecentTagTouchEnd" aria-label="标签">/);
    assert.match(wxml, /class="recent-log-tags-content"/);
    assert.match(wxml, /style="transform: translateX\(-\{\{item\.tagScrollLeft\}\}px\);"/);
    assert.match(wxml, /wx:for="\{\{item.tags\}\}"/);
    assert.match(wxml, /wx:if="\{\{item\.isCandidate\}\}" class="recent-auto-badge" aria-label="自动生成，待确认">auto<\/text>/);
    assert.match(wxml, /wx:if="\{\{item\.isNew\}\}" class="recent-new-badge" aria-label="新记录">new<\/text>/);
    assert.match(wxml, /<view class="recent-icon-button recent-edit-button" role="button" aria-label="编辑记录" data-id="\{\{item\.id\}\}" bindtap="openRecentLogEditor"><edit-icon\s*\/><\/view>/);
    assert.match(wxml, /<view class="recent-icon-button recent-delete-button" role="button" aria-label="删除记录" data-id="\{\{item\.id\}\}" bindtap="confirmDeleteRecentLog"><delete-icon\s*\/><\/view>/);
    assert.doesNotMatch(wxml, /<button class="recent-icon-button/);
    assert.equal(timerJson.usingComponents['delete-icon'], '/components/delete-icon/index');
    assert.equal(timerJson.usingComponents['edit-icon'], '/components/edit-icon/index');
    assert.match(editIconWxml, /class="edit-pencil-tip"/);
    assert.match(editIconWxml, /class="edit-pencil-nib"/);
    assert.match(editIconWxml, /class="edit-pencil-body"/);
    assert.match(editIconWxml, /class="edit-pencil-cap"/);
    assert.match(editIconWxml, /class="edit-pencil-stroke"/);
    assert.match(editIconWxss, /\.edit-pencil-tip\s*\{[^}]*border-right:\s*7rpx solid #4d695b;/s);
    assert.match(editIconWxss, /\.edit-pencil-body\s*\{[^}]*width:\s*17rpx;[^}]*height:\s*10rpx;/s);
    assert.match(editIconWxss, /\.edit-pencil-cap\s*\{[^}]*background:\s*#78947f;/s);
    assert.match(editIconWxss, /\.edit-pencil-stroke\s*\{[^}]*left:\s*2rpx;[^}]*right:\s*2rpx;/s);
    assert.doesNotMatch(wxss, /recent-edit-icon/);
    assert.doesNotMatch(wxss, /recent-delete-icon|recent-delete-lines/);
    assert.match(wxss, /\.recent-log-actions\s*\{[^}]*flex:\s*0 0 104rpx;[^}]*width:\s*104rpx;/s);
    assert.match(wxss, /\.recent-icon-button\s*\{[^}]*flex:\s*0 0 52rpx;[^}]*width:\s*52rpx;[^}]*margin:\s*0;/s);
    assert.doesNotMatch(wxml, /\{\{item\.status === 'candidate' \? '候选' : '实际'\}\}/);
    assert.match(wxss, /\.recent-log-row\s*\{[^}]*border-bottom:\s*0;/s);
    assert.doesNotMatch(wxss, /\.recent-logs\s*\{[^}]*height:/s);
    assert.match(wxss, /\.recent-log-row\s*\{[^}]*padding:\s*12rpx\s+0\s+0;/s);
    assert.match(wxss, /\.recent-log-note-text\s*\{[^}]*flex:\s*1;[^}]*min-width:\s*0;/s);
    assert.match(wxss, /\.recent-auto-badge,\s*\.recent-new-badge\s*\{[^}]*top:\s*-6rpx;[^}]*font-weight:\s*400;/s);
    assert.match(wxss, /\.recent-auto-badge\s*\{[^}]*color:\s*#795d32;/s);
    assert.match(wxss, /\.recent-new-badge\s*\{[^}]*color:\s*#9a5550;/s);
    assert.doesNotMatch(wxss, /recent-candidate-icon/);
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

test('计时页可编辑最近记录，并将候选记录确认后保存', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const updateCalls = [];
  const refreshCalls = [];
  const toasts = [];
  global.getApp = () => ({ globalData: { bootstrap: { applicationService: {
    snapshot() { return { projects: [], tasks: [], calendarEvents: [], timeLogs: [], timer: { status: TIMER_STATUS.IDLE, draft: {} } }; },
    planAssociationCandidates() { return []; },
    updateLog(id, input) {
      updateCalls.push({ id, input });
      return { log: { id }, hasOverlap: false };
    }
  } } } });
  global.wx = { showToast(options) { toasts.push(options); } };
  try {
    const page = loadTimerPage();
    page.setData = (updates, callback) => {
      Object.assign(page.data, updates);
      if (callback) callback();
    };
    page.currentService = getApp().globalData.bootstrap.applicationService;
    page.currentSnapshot = page.currentService.snapshot();
    page.eventById = new Map();
    page.setData({
      recentLogs: [{
        id: 'candidate_log',
        startedAt: NOW,
        endedAt: NOW + 30 * 60_000,
        note: '自动整理会议纪要',
        tags: ['工作'],
        status: 'candidate',
        isCandidate: true
      }]
    });
    page.openRecentLogEditor({ currentTarget: { dataset: { id: 'candidate_log' } } });
    assert.equal(page.data.manualMode, 'edit');
    assert.equal(page.data.manualLogId, 'candidate_log');
    assert.equal(page.data.manualNote, '自动整理会议纪要');
    assert.deepEqual(page.data.manualTags, ['工作']);

    page.refresh = (options) => { refreshCalls.push(options); };
    page.onManualSave();

    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0].id, 'candidate_log');
    assert.equal(updateCalls[0].input.note, '自动整理会议纪要');
    assert.deepEqual(updateCalls[0].input.tags, ['工作']);
    assert.deepEqual(refreshCalls, [{ newLogId: 'candidate_log' }]);
    assert.equal(toasts.at(-1).title, '候选已编辑并确认');
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('计时页删除最近记录前要求二次确认', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const deleteCalls = [];
  const refreshCalls = [];
  const modals = [];
  global.getApp = () => ({ globalData: { bootstrap: { applicationService: {
    deleteLog(id, confirmed) { deleteCalls.push({ id, confirmed }); }
  } } } });
  global.wx = {
    showToast() {},
    showModal(config) { modals.push(config); }
  };
  try {
    const page = loadTimerPage();
    page.setData = (updates, callback) => {
      Object.assign(page.data, updates);
      if (callback) callback();
    };
    page.setData({ recentLogs: [{ id: 'confirmed_log', isCandidate: false }] });
    page.confirmDeleteRecentLog({ currentTarget: { dataset: { id: 'confirmed_log' } } });
    assert.equal(modals.length, 1);
    assert.equal(modals[0].title, '删除时间记录');
    assert.equal(modals[0].content, '删除后这条记录将无法恢复。');
    assert.equal(modals[0].confirmColor, '#9a5550');

    modals[0].success({ confirm: false });
    assert.deepEqual(deleteCalls, []);

    page.refresh = (options) => { refreshCalls.push(options); };
    modals[0].success({ confirm: true });

    assert.deepEqual(deleteCalls, [{ id: 'confirmed_log', confirmed: true }]);
    assert.deepEqual(refreshCalls, [undefined]);

    const wxml = fs.readFileSync(timerWxmlPath, 'utf8');
    assert.doesNotMatch(wxml, /pendingDeleteLog|deleteRecentLog|cancelDeleteRecentLog/);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('计时页将关联计划块选择器置于本次记录标题右侧', () => {
  const wxml = fs.readFileSync(timerWxmlPath, 'utf8');
  const wxss = fs.readFileSync(timerWxssPath, 'utf8');
  assert.match(wxml, /<view class="record-header">[\s\S]*?<view class="section-title record-title">本次记录<\/view>[\s\S]*?<view class="picker-row record-plan-picker">/);
  assert.match(wxml, /class="record-plan-picker-value">\{\{events\[eventIndex\]\.title \|\| '计划外'\}\}<\/view>/);
  assert.match(wxss, /\.record-header\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;/s);
  assert.match(wxss, /\.record-plan-picker\s*\{[^}]*flex:\s*1;[^}]*min-width:\s*0;/s);
});

test('计时页将自动恢复候选预览展示为待审核草稿', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const snapshot = {
    projects: [],
    tasks: [],
    calendarEvents: [],
    timeLogs: [],
    timer: { status: TIMER_STATUS.IDLE, draft: {} },
    recoveryDraft: {
      reason: '计时超过恢复时间窗口，系统已生成候选，请核实后确认记录',
      timer: { status: TIMER_STATUS.IDLE, draft: {} },
      candidatePreview: {
        startedAt: NOW,
        endedAt: NOW + 8_000,
        durationMinutes: 1,
        source: 'timer'
      }
    }
  };
  global.getApp = () => ({ globalData: { bootstrap: { applicationService: {
    snapshot() { return snapshot; },
    planAssociationCandidates() { return []; }
  } } } });
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

    assert.equal(page.data.recoveryDraft.displayTitle, '有一条待审核的自动恢复记录');
    assert.equal(page.data.recoveryDraft.confirmLabel, '核实并确认记录');
    assert.match(page.data.recoveryDraft.displayReason, /系统候选：/);
    assert.match(page.data.recoveryDraft.displayReason, /共 1 分钟/);
    const wxml = fs.readFileSync(timerWxmlPath, 'utf8');
    assert.match(wxml, /\{\{recoveryDraft\.displayTitle\}\}/);
    assert.match(wxml, /\{\{recoveryDraft\.confirmLabel\}\}/);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('新生成的最近记录置顶、标记为 new 并自动回到第一页，直到更新记录插入', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const localStorage = new Map();
  const preferences = preferenceStoreForMap(localStorage);
  const snapshot = {
    localProfile: { id: 'profile_recent', createdAt: NOW, updatedAt: NOW },
    projects: [],
    tasks: [],
    calendarEvents: [],
    timeLogs: [
      { id: 'log_old', startedAt: NOW - 60_000, durationMinutes: 1, note: '旧记录', tags: [], status: 'confirmed' },
      { id: 'log_new', startedAt: NOW, durationMinutes: 1, note: '新记录', tags: [], status: 'confirmed' }
    ],
    timer: { status: TIMER_STATUS.IDLE, draft: {} },
    recoveryDraft: null
  };
  global.getApp = () => ({
    globalData: {
      bootstrap: {
        preferences,
        applicationService: {
          snapshot() { return snapshot; },
          planAssociationCandidates() { return []; }
        }
      }
    }
  });
  global.wx = {
    showToast() {},
    getStorageSync(key) { return localStorage.has(key) ? localStorage.get(key) : ''; },
    setStorageSync(key, value) { localStorage.set(key, value); }
  };
  try {
    const page = loadTimerPage();
    page.setData = (updates, callback) => {
      Object.assign(page.data, updates);
      if (callback) callback();
    };
    Object.assign(page.data, {
      recentColumnIndex: 1,
      recentColumnStep: 240,
      recentScrollLeft: 240,
      recentBoundaryOffset: 18,
      recentBoundaryIsDragging: true
    });
    page.updateElapsed = () => {};
    page.startTicker = () => {};

    page.refresh({ newLogId: 'log_new' });

    assert.deepEqual(page.data.recentLogs.map((log) => log.id), ['log_new', 'log_old']);
    assert.equal(page.data.recentLogs[0].isNew, true);
    assert.equal(page.data.recentLogs[1].isNew, false);
    assert.equal(page.data.recentColumnIndex, 0);
    assert.equal(page.data.recentScrollLeft, 0);
    assert.equal(page.data.recentBoundaryOffset, 0);
    assert.equal(page.data.recentBoundaryIsDragging, false);
    assert.deepEqual(localStorage.get('plan-and-record.recent-log-highlight'), {
      version: 1,
      profileId: 'profile_recent',
      value: { logId: 'log_new' }
    });

    page.setData({ recentColumnIndex: 1, recentScrollLeft: 240 });
    page.refresh();
    assert.equal(page.data.recentLogs[0].isNew, true);
    assert.equal(page.data.recentColumnIndex, 1);
    assert.equal(page.data.recentScrollLeft, 240);

    const coldStartPage = loadTimerPage();
    coldStartPage.setData = (updates, callback) => {
      Object.assign(coldStartPage.data, updates);
      if (callback) callback();
    };
    coldStartPage.updateElapsed = () => {};
    coldStartPage.startTicker = () => {};
    coldStartPage.onLoad();
    coldStartPage.setData({ recentColumnIndex: 1, recentColumnStep: 240, recentScrollLeft: 240 });
    coldStartPage.refresh();
    assert.equal(coldStartPage.data.recentLogs[0].isNew, true);
    assert.equal(coldStartPage.data.recentColumnIndex, 0);
    assert.equal(coldStartPage.data.recentScrollLeft, 0);

    coldStartPage.setData({ recentColumnIndex: 1, recentScrollLeft: 240 });
    coldStartPage.refresh();
    assert.equal(coldStartPage.data.recentColumnIndex, 1);
    assert.equal(coldStartPage.data.recentScrollLeft, 240);

    snapshot.timeLogs.push({ id: 'log_newer', startedAt: NOW + 60_000, durationMinutes: 1, note: '更新记录', tags: [], status: 'confirmed' });
    coldStartPage.refresh({ newLogId: 'log_newer' });
    assert.deepEqual(coldStartPage.data.recentLogs.map((log) => log.id), ['log_newer', 'log_new', 'log_old']);
    assert.equal(coldStartPage.data.recentLogs[0].isNew, true);
    assert.equal(coldStartPage.data.recentLogs[1].isNew, false);
    assert.equal(coldStartPage.data.recentColumnIndex, 0);
    assert.equal(coldStartPage.data.recentScrollLeft, 0);
    assert.deepEqual(localStorage.get('plan-and-record.recent-log-highlight'), {
      version: 1,
      profileId: 'profile_recent',
      value: { logId: 'log_newer' }
    });
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('计时页重新显示时只刷新，不将恢复草稿标记为新记录', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const bootstrap = { applicationService: {} };
  const refreshCalls = [];
  global.getApp = () => ({ globalData: { bootstrap } });
  global.wx = { showToast() {} };
  try {
    const page = loadTimerPage();
    page.refresh = (options) => { refreshCalls.push(options); };

    page.onShow();
    page.onShow();

    assert.deepEqual(refreshCalls, [undefined, undefined]);
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

test('计时页最近记录轻拖或快速横划时以固定时长单调吸附目标列', () => {
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
    assert.deepEqual(scheduled.map((item) => item.delay), [16]);
    now += 300;
    scheduled.shift().callback();
    assert.ok(page.data.recentScrollLeft > 160 && page.data.recentScrollLeft < 240);
    now += 120;
    scheduled.shift().callback();
    assert.equal(page.data.recentScrollLeft, 240);
  } finally {
    Date.now = originalDateNow;
    global.setTimeout = originalSetTimeout;
    page.clearRecentScrollAnimation();
  }
});

test('计时页最近记录松手早于 scroll 事件时仍以固定时长单调回到原列', () => {
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

test('结束计时会直接创建记录并提交当前记录字段', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const calls = [];
  const toasts = [];
  global.getApp = () => ({
    globalData: {
      bootstrap: {
        applicationService: {
          finishTimer(input) {
            calls.push(['finish', input]);
            return { log: { id: 'log_new' }, hasOverlap: true };
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
      timer: { status: TIMER_STATUS.RUNNING },
      events: [
        { id: '', associationType: 'none', title: '计划外' },
        { id: 'event_focus', associationType: 'event', title: '专注计划' }
      ],
      eventIndex: 1,
      note: '补充备注',
      tags: ['工作', '复盘']
    });
    page.refresh = (options) => { calls.push(['refresh', options]); };

    page.onFinishTimer();

    assert.deepEqual(calls, [
      ['finish', { calendarEventId: 'event_focus', note: '补充备注', tags: ['工作', '复盘'] }],
      ['refresh', { newLogId: 'log_new' }]
    ]);
    assert.equal(toasts.at(-1).title, '记录已生成');
    assert.doesNotMatch(fs.readFileSync(timerPagePath, 'utf8'), /hasOverlap|存在重叠时间/);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('计时期间修改本次字段会同步写入计时草稿，暂停刷新后保持一致', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const snapshot = {
    projects: [],
    tasks: [],
    calendarEvents: [],
    timeLogs: [],
    timer: {
      status: TIMER_STATUS.RUNNING,
      startedAt: NOW,
      pausedAt: null,
      pauses: [],
      draft: { calendarEventId: null, note: '开始时的备注', tags: ['开始'] }
    },
    recoveryDraft: null
  };
  const updateDraftCalls = [];
  global.getApp = () => ({
    globalData: {
      bootstrap: {
        applicationService: {
          snapshot() { return snapshot; },
          planAssociationCandidates() { return []; },
          pauseTimer() { snapshot.timer.status = TIMER_STATUS.PAUSED; },
          updateTimerDraft(input) {
            updateDraftCalls.push(input);
            snapshot.timer.draft = { ...snapshot.timer.draft, ...input };
          }
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
    page.data.timer = snapshot.timer;
    page.data.events = [
      { id: '', associationType: 'none', title: '计划外' },
      { id: 'event_plan', associationType: 'event', title: '写方案' }
    ];
    page.data.eventIndex = 0;
    page.data.note = '开始时的备注';
    page.data.tags = ['开始'];

    page.onNoteInput({ detail: { value: '结束前填写的备注' } });
    page.openTagInput({ currentTarget: { dataset: { inputVisibleKey: 'tagInputVisible' } } });
    page.addTag({
      currentTarget: { dataset: { tagsKey: 'tags', inputVisibleKey: 'tagInputVisible' } },
      detail: { value: '结束前标签' }
    });
    page.onPickerChange({ currentTarget: { dataset: { key: 'eventIndex' } }, detail: { value: 1 } });
    page.onPrimary();

    assert.deepEqual(updateDraftCalls.at(-1), {
      calendarEventId: 'event_plan',
      note: '结束前填写的备注',
      tags: ['开始', '结束前标签']
    });
    assert.deepEqual(snapshot.timer.draft, {
      calendarEventId: 'event_plan',
      note: '结束前填写的备注',
      tags: ['开始', '结束前标签']
    });
    assert.equal(page.data.timer.status, TIMER_STATUS.PAUSED);
    assert.equal(page.data.note, '结束前填写的备注');
    assert.deepEqual(page.data.tags, ['开始', '结束前标签']);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('连续备注输入只安排一次草稿写入，隐藏页面时立即提交最新值', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const updateTimerDraft = [];
  const timers = new Map();
  const delays = [];
  let nextTimerId = 1;
  global.setTimeout = (callback, delay) => {
    const id = nextTimerId;
    nextTimerId += 1;
    timers.set(id, callback);
    delays.push(delay);
    return id;
  };
  global.clearTimeout = (id) => timers.delete(id);
  global.getApp = () => ({
    globalData: {
      bootstrap: {
        applicationService: {
          updateTimerDraft(input) { updateTimerDraft.push(input); }
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
      events: [{ id: '', associationType: 'none', title: '计划外' }],
      eventIndex: 0,
      note: '',
      tags: []
    });

    page.onNoteInput({ detail: { value: '第' } });
    page.onNoteInput({ detail: { value: '第二' } });
    page.onNoteInput({ detail: { value: '第二版' } });

    assert.deepEqual(updateTimerDraft, []);
    assert.deepEqual(delays, [300, 300, 300]);
    assert.equal(timers.size, 1);

    page.onHide();

    assert.equal(timers.size, 0);
    assert.equal(updateTimerDraft.length, 1);
    assert.equal(updateTimerDraft[0].note, '第二版');
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test('备注 setData 渲染回调晚于 onHide 时仍立即保存且不留下迟到定时器', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const updateTimerDraft = [];
  const timers = new Map();
  const renderCallbacks = [];
  let nextTimerId = 1;
  global.setTimeout = (callback) => {
    const id = nextTimerId;
    nextTimerId += 1;
    timers.set(id, callback);
    return id;
  };
  global.clearTimeout = (id) => timers.delete(id);
  global.getApp = () => ({
    globalData: {
      bootstrap: {
        applicationService: {
          updateTimerDraft(input) { updateTimerDraft.push(input); }
        }
      }
    }
  });
  global.wx = { showToast() {} };

  try {
    const page = loadTimerPage();
    page.setData = (updates, callback) => {
      Object.assign(page.data, updates);
      if (callback) renderCallbacks.push(callback);
    };
    Object.assign(page.data, {
      timer: { status: TIMER_STATUS.RUNNING },
      events: [{ id: '', associationType: 'none', title: '计划外' }],
      eventIndex: 0,
      note: '',
      tags: []
    });

    page.onNoteInput({ detail: { value: '切后台前的最新备注' } });
    assert.equal(timers.size, 1);

    page.onHide();
    assert.equal(timers.size, 0);
    assert.deepEqual(updateTimerDraft, [{
      calendarEventId: null,
      note: '切后台前的最新备注',
      tags: []
    }]);

    renderCallbacks.forEach((callback) => callback());
    assert.equal(timers.size, 0);
    assert.equal(updateTimerDraft.length, 1);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test('结束计时使用最新备注并取消尚未触发的防抖写入', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const timers = new Map();
  const finishCalls = [];
  let nextTimerId = 1;
  global.setTimeout = (callback) => {
    const id = nextTimerId;
    nextTimerId += 1;
    timers.set(id, callback);
    return id;
  };
  global.clearTimeout = (id) => timers.delete(id);
  global.getApp = () => ({
    globalData: {
      bootstrap: {
        applicationService: {
          finishTimer(input) {
            finishCalls.push(input);
            return { log: { id: 'log_finished' } };
          }
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
    page.refresh = () => {};
    Object.assign(page.data, {
      timer: { status: TIMER_STATUS.RUNNING },
      events: [{ id: '', associationType: 'none', title: '计划外' }],
      eventIndex: 0,
      note: '',
      tags: []
    });

    page.onNoteInput({ detail: { value: '最终备注' } });
    assert.equal(timers.size, 1);

    page.onFinishTimer();

    assert.equal(timers.size, 0);
    assert.equal(finishCalls.length, 1);
    assert.equal(finishCalls[0].note, '最终备注');
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test('出现恢复草稿后清空本次记录表单，恢复编辑仍使用持久化草稿', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const recoveryTimer = {
    status: TIMER_STATUS.IDLE,
    startedAt: NOW - 60_000,
    pausedAt: null,
    pauses: [],
    draft: {
      calendarEventId: 'event_plan',
      note: '应在恢复记录中保留的备注',
      tags: ['恢复标签']
    }
  };
  const snapshot = {
    projects: [],
    tasks: [],
    calendarEvents: [{ id: 'event_plan', title: '写方案', taskId: 'task_plan' }],
    timeLogs: [],
    timer: { status: TIMER_STATUS.IDLE, startedAt: null, pausedAt: null, pauses: [], draft: {} },
    recoveryDraft: {
      reason: '计时超过恢复时间窗口，系统已生成候选，请核实后确认记录',
      timer: recoveryTimer,
      candidatePreview: {
        startedAt: NOW - 60_000,
        endedAt: NOW,
        durationMinutes: 1,
        source: 'timer'
      }
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
    Object.assign(page.data, {
      timer: recoveryTimer,
      events: [{ id: 'event_plan', associationType: 'event', title: '写方案' }],
      eventIndex: 0,
      note: '残留在本次记录中的备注',
      tags: ['残留标签'],
      tagInputVisible: true,
      tagInputAutoFocus: true
    });
    page.hasUncommittedTimerForm = true;

    page.refresh();

    assert.equal(page.hasUncommittedTimerForm, false);
    assert.equal(page.data.note, '');
    assert.deepEqual(page.data.tags, []);
    assert.equal(page.data.eventIndex, 0);
    assert.equal(page.data.tagInputVisible, false);
    assert.equal(page.data.tagInputAutoFocus, false);

    page.openRecoveryManual();
    assert.equal(page.data.manualNote, '应在恢复记录中保留的备注');
    assert.deepEqual(page.data.manualTags, ['恢复标签']);
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

  const wxml = fs.readFileSync(timerWxmlPath, 'utf8');
  assert.match(wxml, /<view class="manual-field-label">开始时间<\/view>/);
  assert.match(wxml, /<view class="manual-field-label">结束时间<\/view>/);
  assert.match(wxml, /<view class="manual-field-label">计划块<\/view>/);
  assert.match(wxml, /class="manual-date-picker" mode="date" value="\{\{manualStartDate\}\}"[\s\S]*?<second-time-picker[^>]*value="\{\{manualStartTime\}\}"/);
  assert.match(wxml, /class="manual-date-picker" mode="date" value="\{\{manualEndDate\}\}"[\s\S]*?<second-time-picker[^>]*value="\{\{manualEndTime\}\}"/);
  assert.doesNotMatch(wxml, /开始日期：|开始：|结束日期：|结束：|计划块：/);
  assert.doesNotMatch(wxml, /分类：|项目：|任务：/);
  assert.match(wxml, /wx:for="\{\{tags\}\}"/);
  assert.match(wxml, /class="tag-chip tag-add"/);
  assert.equal((wxml.match(/class="tag-input"[^>]*maxlength="10"/g) || []).length, 2);
  assert.doesNotMatch(wxml, /逗号分隔/);
  assert.doesNotMatch(wxml, /保存本次字段|onSaveTimerDraft/);
});

test('计时页秒级编辑器为开始和结束分别提供日期、三列时间与暂停时长', () => {
  const wxml = fs.readFileSync(timerWxmlPath, 'utf8');
  const config = JSON.parse(fs.readFileSync(timerJsonPath, 'utf8'));
  const manualMarkup = wxml.slice(wxml.indexOf('wx:if="{{showManual}}"'));

  assert.equal((manualMarkup.match(/mode="date"/g) || []).length, 2);
  assert.equal((manualMarkup.match(/<second-time-picker\b/g) || []).length, 2);
  assert.equal((manualMarkup.match(/<pause-duration-input\b/g) || []).length, 1);
  assert.doesNotMatch(manualMarkup, /mode="time"/);
  assert.equal(config.usingComponents['second-time-picker'], '/components/second-time-picker/index');
  assert.equal(config.usingComponents['pause-duration-input'], '/components/pause-duration-input/index');

  const timerCard = wxml.slice(wxml.indexOf('class="timer-card"'), wxml.indexOf('class="text-input"'));
  assert.doesNotMatch(timerCard, /pause-duration-input|暂停时长/);
});

test('最近记录只改开始端时，结束毫秒与暂停秒保持原值', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const updates = [];
  const startedAt = new Date(2026, 7, 4, 9, 8, 7, 987).getTime();
  const endedAt = new Date(2026, 7, 5, 10, 9, 8, 654).getTime();
  const snapshot = { projects: [], tasks: [], calendarEvents: [], timeLogs: [] };
  const service = {
    snapshot() { return snapshot; },
    planAssociationCandidates() { return []; },
    updateLog(id, input) {
      updates.push({ id, input });
      return { log: { id }, hasOverlap: false };
    }
  };
  global.getApp = () => ({ globalData: { bootstrap: { applicationService: service } } });
  global.wx = { showToast() {} };
  try {
    const page = loadTimerPage();
    page.setData = (values, callback) => {
      Object.assign(page.data, values);
      if (callback) callback();
    };
    page.currentService = service;
    page.currentSnapshot = snapshot;
    page.eventById = new Map();
    page.data.recentLogs = [{
      id: 'log_seconds',
      status: 'confirmed',
      startedAt,
      endedAt,
      pausedDurationSeconds: 3723,
      note: '原记录',
      tags: []
    }];
    page.refresh = () => {};

    page.openRecentLogEditor({ currentTarget: { dataset: { id: 'log_seconds' } } });
    assert.equal(page.data.manualStartTime, '09:08:07');
    assert.equal(page.data.manualEndTime, '10:09:08');
    assert.equal(page.data.manualPausedDurationSeconds, 3723);
    page.onManualTimeChange({
      currentTarget: { dataset: { key: 'manualStartTime', editedKey: 'manualStartTimeEdited' } },
      detail: { value: '11:12:13' }
    });
    page.onManualSave();

    assert.equal(updates[0].input.startedAt, new Date(2026, 7, 4, 11, 12, 13, 0).getTime());
    assert.equal(updates[0].input.endedAt, endedAt);
    assert.equal(updates[0].input.pausedDurationSeconds, 3723);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('结束计时降级为恢复草稿时只刷新恢复卡，不读取日志 ID 或提示生成成功', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const toasts = [];
  global.getApp = () => ({ globalData: { bootstrap: { applicationService: {
    finishTimer() { return { state: 'draft', recoveryDraft: { reason: '待修正' } }; }
  } } } });
  global.wx = { showToast(options) { toasts.push(options); } };
  try {
    const page = loadTimerPage();
    page.setData = (values, callback) => {
      Object.assign(page.data, values);
      if (callback) callback();
    };
    Object.assign(page.data, {
      timer: { status: TIMER_STATUS.RUNNING },
      events: [{ id: '', associationType: 'none' }],
      eventIndex: 0,
      tags: []
    });
    let refreshCalls = 0;
    page.refresh = () => { refreshCalls += 1; };

    page.onFinishTimer();

    assert.equal(refreshCalls, 1);
    assert.equal(toasts.some((item) => item.title === '记录已生成'), false);
    assert.equal(toasts.some((item) => /log/.test(item.title)), false);
  } finally {
    global.getApp = originalGetApp;
    global.wx = originalWx;
  }
});

test('计时页标签只允许点击叉号移除，不响应标签胶囊点击', () => {
  const wxml = fs.readFileSync(timerWxmlPath, 'utf8');
  const wxss = fs.readFileSync(timerWxssPath, 'utf8');
  const removeControls = wxml.match(/<view class="tag-chip-remove"[^>]*catchtap="removeTag"[^>]*>/g) || [];

  assert.equal(removeControls.length, 2);
  assert.doesNotMatch(
    wxml,
    /class="tag-chip tag-chip-removable"[^>]*(?:bindtap|catchtap)="removeTag"/
  );
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

    page.addTag({
      currentTarget: { dataset: { tagsKey: 'tags', inputVisibleKey: 'tagInputVisible' } },
      detail: { value: '超过五个汉字标签' }
    });
    assert.equal(page.data.tagInputVisible, true);

    page.removeTag({ currentTarget: { dataset: { tagsKey: 'tags', index: 0 } } });
    assert.deepEqual(page.data.tags, []);
  } finally {
    global.wx = originalWx;
  }
});

test('计时页候选标签支持一键添加，并在移除后重新进入候选队列', () => {
  const originalWx = global.wx;
  global.wx = { showToast() {} };
  try {
    const page = loadTimerPage();
    page.setData = (updates) => Object.assign(page.data, updates);
    page.tagCandidateQueue = ['复盘', '工作'];
    Object.assign(page.data, {
      tags: [],
      tagCandidates: ['复盘', '工作'],
      tagInputVisible: false
    });

    page.selectTagCandidate({
      currentTarget: {
        dataset: {
          tagsKey: 'tags',
          inputVisibleKey: 'tagInputVisible',
          tag: '复盘'
        }
      }
    });
    assert.deepEqual(page.data.tags, ['复盘']);
    assert.deepEqual(page.data.tagCandidates, ['工作']);

    page.removeTag({ currentTarget: { dataset: { tagsKey: 'tags', index: 0 } } });
    assert.deepEqual(page.data.tags, []);
    assert.deepEqual(page.data.tagCandidates, ['复盘', '工作']);
  } finally {
    global.wx = originalWx;
  }
});

test('计时页横滑候选标签时不添加，轻点时才添加', () => {
  const originalWx = global.wx;
  global.wx = { showToast() {} };
  try {
    const page = loadTimerPage();
    page.setData = (updates) => Object.assign(page.data, updates);
    page.tagCandidateQueue = ['复盘', '工作'];
    Object.assign(page.data, {
      tags: [],
      tagCandidates: ['复盘', '工作'],
      tagInputVisible: true
    });
    const currentTarget = {
      dataset: {
        tagsKey: 'tags',
        inputVisibleKey: 'tagInputVisible'
      }
    };
    const target = { dataset: { tag: '复盘' } };
    const inputTarget = { dataset: { inputVisibleKey: 'tagInputVisible' } };

    page.onTagCandidateTouchStart({ currentTarget, target, touches: [{ clientX: 160, clientY: 40 }] });
    page.onTagInputBlur({ currentTarget: inputTarget, detail: { value: '' } });
    assert.equal(page.data.tagInputVisible, true);
    page.onTagCandidateTouchMove({ touches: [{ clientX: 80, clientY: 42 }] });
    page.onTagCandidateTouchEnd({ changedTouches: [{ clientX: 80, clientY: 42 }] });
    assert.deepEqual(page.data.tags, []);
    assert.equal(page.data.tagInputVisible, true);

    page.onTagCandidateTouchStart({ currentTarget, target, touches: [{ clientX: 80, clientY: 40 }] });
    page.onTagCandidateTouchEnd({ changedTouches: [{ clientX: 83, clientY: 42 }] });
    assert.deepEqual(page.data.tags, ['复盘']);
    assert.equal(page.data.tagInputVisible, false);

    const wxml = fs.readFileSync(timerWxmlPath, 'utf8');
    assert.equal((wxml.match(/bindtouchstart="onTagCandidateTouchStart"/g) || []).length, 2);
    assert.equal((wxml.match(/bindtouchmove="onTagCandidateTouchMove"/g) || []).length, 2);
    assert.equal((wxml.match(/bindtouchend="onTagCandidateTouchEnd"/g) || []).length, 2);
    assert.doesNotMatch(wxml, /class="tag-candidate-chip"[^>]*bindtap="selectTagCandidate"/);
  } finally {
    global.wx = originalWx;
  }
});

test('计时页常用标签仅在对应手动输入框打开时展示', () => {
  const wxml = fs.readFileSync(timerWxmlPath, 'utf8');

  assert.match(wxml, /wx:if="\{\{tagCandidates\.length && tagInputVisible\}\}" class="tag-candidates"/);
  assert.match(wxml, /wx:if="\{\{manualTagCandidates\.length && manualTagInputVisible\}\}" class="tag-candidates"/);
  assert.doesNotMatch(wxml, /wx:if="\{\{(?:tagCandidates|manualTagCandidates)\.length\}\}" class="tag-candidates"/);
});

test('计时页仅在候选标签为空时自动聚焦新标签输入框', () => {
  const page = loadTimerPage();
  page.setData = (updates) => Object.assign(page.data, updates);

  Object.assign(page.data, { tagCandidates: [], manualTagCandidates: [] });
  page.openTagInput({ currentTarget: { dataset: { inputVisibleKey: 'tagInputVisible' } } });
  assert.equal(page.data.tagInputVisible, true);
  assert.equal(page.data.tagInputAutoFocus, true);

  page.setData({ tagInputVisible: false, tagCandidates: ['复盘'] });
  page.openTagInput({ currentTarget: { dataset: { inputVisibleKey: 'tagInputVisible' } } });
  assert.equal(page.data.tagInputAutoFocus, false);

  page.openTagInput({ currentTarget: { dataset: { inputVisibleKey: 'manualTagInputVisible' } } });
  assert.equal(page.data.manualTagInputVisible, true);
  assert.equal(page.data.manualTagInputAutoFocus, true);

  page.setData({ manualTagInputVisible: false, manualTagCandidates: ['工作'] });
  page.openTagInput({ currentTarget: { dataset: { inputVisibleKey: 'manualTagInputVisible' } } });
  assert.equal(page.data.manualTagInputAutoFocus, false);

});

test('计时页候选标签来自其他记录、按最近使用排序，并跳过不可直接添加的导入标签', () => {
  const originalGetApp = global.getApp;
  const originalWx = global.wx;
  const snapshot = {
    projects: [],
    tasks: [],
    calendarEvents: [],
    timeLogs: [{
      id: 'log_old',
      startedAt: NOW - 120_000,
      endedAt: NOW - 60_000,
      durationMinutes: 1,
      note: '旧记录',
      tags: ['工作'],
      status: 'confirmed'
    }, {
      id: 'log_middle',
      startedAt: NOW - 60_000,
      endedAt: NOW,
      durationMinutes: 1,
      note: '中间记录',
      tags: ['复盘', '工作'],
      status: 'confirmed'
    }, {
      id: 'log_new',
      startedAt: NOW,
      endedAt: NOW + 60_000,
      durationMinutes: 1,
      note: '新记录',
      tags: ['写作', '复盘', '超过五个字符'],
      status: 'confirmed'
    }],
    timer: { status: TIMER_STATUS.IDLE, draft: {} },
    recoveryDraft: null
  };
  const service = {
    snapshot() { return snapshot; },
    planAssociationCandidates() { return []; }
  };
  global.getApp = () => ({ globalData: { bootstrap: { applicationService: service } } });
  global.wx = { showToast() {} };
  try {
    const page = loadTimerPage();
    page.setData = (updates, callback) => {
      Object.assign(page.data, updates);
      if (callback) callback();
    };

    page.refresh();
    assert.deepEqual(page.data.tagCandidates, ['写作', '复盘', '工作']);

    page.openRecentLogEditor({ currentTarget: { dataset: { id: 'log_new' } } });
    assert.deepEqual(page.data.manualTagCandidates, ['工作']);

    const wxml = fs.readFileSync(timerWxmlPath, 'utf8');
    const wxss = fs.readFileSync(timerWxssPath, 'utf8');
    assert.match(wxml, /data-tags-key="tags" data-input-visible-key="tagInputVisible"[^>]*bindtouchend="onTagCandidateTouchEnd"[\s\S]*?wx:for="\{\{tagCandidates\}\}"/);
    assert.match(wxml, /data-tags-key="manualTags" data-input-visible-key="manualTagInputVisible"[^>]*bindtouchend="onTagCandidateTouchEnd"[\s\S]*?wx:for="\{\{manualTagCandidates\}\}"/);
    assert.ok(wxml.indexOf('wx:for="{{tagCandidates}}"') < wxml.indexOf('wx:if="{{tagInputVisible}}"'));
    assert.ok(wxml.indexOf('wx:for="{{manualTagCandidates}}"') < wxml.indexOf('wx:if="{{manualTagInputVisible}}"'));
    assert.match(wxml, /class="tag-candidate-title">常用标签<\/text>/);
    assert.match(wxss, /\.tag-candidate-scroll\s*\{[^}]*white-space:\s*nowrap;/s);
    assert.match(wxss, /\.tag-candidate-chip\s*\{[^}]*border-radius:\s*999rpx;/s);
  } finally {
    global.getApp = originalGetApp;
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
        draft: {
          originRuleId: 'rule_repeat',
          originOccurrenceId: 'rule_repeat:1:1700000000000',
          originRuleSummarySnapshot: '每日整理',
          note: '',
          tags: ['恢复,一', '复,盘']
        }
      },
      candidatePreview: {
        startedAt: NOW,
        endedAt: NOW + 90_000,
        durationMinutes: 2,
        source: 'timer'
      }
    };
    page.openRecoveryManual();
    assert.deepEqual(page.recoveryCandidatePreview, page.data.recoveryDraft.candidatePreview);
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
