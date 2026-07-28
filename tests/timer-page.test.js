const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { TIMER_STATUS } = require('../miniprogram/domain/constants');

const timerPagePath = require.resolve('../miniprogram/pages/timer/index.js');
const timerWxmlPath = path.join(__dirname, '../miniprogram/pages/timer/index.wxml');
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
    draft: {}
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
