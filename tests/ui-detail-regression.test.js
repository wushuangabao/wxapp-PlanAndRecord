const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const pagesRoot = path.join(__dirname, '../miniprogram/pages');

test('四个页面的英文眉题在滚动时固定在顶部', () => {
  for (const page of ['timer', 'plans', 'calendar', 'profile']) {
    const source = fs.readFileSync(path.join(pagesRoot, page, 'index.wxss'), 'utf8');
    const wxml = fs.readFileSync(path.join(pagesRoot, page, 'index.wxml'), 'utf8');
    assert.match(source, /\.eyebrow\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;/s, page);
    assert.match(wxml, /<view class="page">\s*<view class="eyebrow">/s, page);
  }
});

test('日历日视图显示单个日期，范围标签始终单行显示', () => {
  const script = fs.readFileSync(path.join(pagesRoot, 'calendar/index.js'), 'utf8');
  const wxml = fs.readFileSync(path.join(pagesRoot, 'calendar/index.wxml'), 'utf8');
  const wxss = fs.readFileSync(path.join(pagesRoot, 'calendar/index.wxss'), 'utf8');
  assert.match(script, /this\.data\.view === 'day'/);
  assert.match(wxml, /class="range-label"/);
  assert.match(wxss, /\.range-label\s*\{[^}]*white-space:\s*nowrap;/s);
  assert.match(wxss, /\.nav-button\s*\{[^}]*width:\s*44rpx;/s);
});

test('所有自定义底部弹窗复用共享头部组件', () => {
  const expectedModalCounts = { timer: 1, plans: 6, calendar: 3 };

  for (const [page, expectedModalCount] of Object.entries(expectedModalCounts)) {
    const pageDirectory = path.join(pagesRoot, page);
    const wxml = fs.readFileSync(path.join(pageDirectory, 'index.wxml'), 'utf8');
    const config = JSON.parse(fs.readFileSync(path.join(pageDirectory, 'index.json'), 'utf8'));
    const modalCount = (wxml.match(/class="modal(?:\s[^\"]*)?"/g) || []).length;
    const sheetHeaderCount = (wxml.match(/<sheet-header\b/g) || []).length;

    assert.equal(config.usingComponents['sheet-header'], '/components/sheet-header/index', page);
    assert.equal(modalCount, expectedModalCount, page);
    assert.equal(sheetHeaderCount, modalCount, page);
    assert.doesNotMatch(wxml, /class="modal-title"/, page);
  }
});
