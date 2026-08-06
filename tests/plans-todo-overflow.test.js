const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const plansWxssPath = path.join(__dirname, '../miniprogram/pages/plans/index.wxss');

test('计划页：长 TODO 标题不能撑宽横向任务列', () => {
  const wxss = fs.readFileSync(plansWxssPath, 'utf8');

  assert.match(wxss, /\.todo-column\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*60%;[^}]*overflow:\s*hidden;/s);
  assert.match(wxss, /\.todo-row\s*\{[^}]*min-width:\s*0;/s);
  assert.match(wxss, /\.todo-main\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/s);
});

test('计划页：第三条 TODO 的关联项目文字不受通用列表外边距裁切', () => {
  const wxss = fs.readFileSync(plansWxssPath, 'utf8');

  assert.match(wxss, /\.item\.todo-row\s*\{[^}]*margin:\s*0;/s);
});

test('计划页：TODO 行间留白不占用第三行内容区域', () => {
  const wxss = fs.readFileSync(plansWxssPath, 'utf8');

  assert.match(wxss, /\.todo-column\s*\{[^}]*row-gap:\s*18rpx;/s);
  assert.match(wxss, /\.todo-row\s*\{[^}]*flex:\s*0\s+0\s+calc\(33\.333333%\s*-\s*12rpx\);/s);
});

test('计划页：愿望标题和操作区不能撑宽横向愿望列', () => {
  const wxss = fs.readFileSync(plansWxssPath, 'utf8');

  assert.match(wxss, /\.wish-column\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*60%;[^}]*overflow:\s*hidden;/s);
  assert.match(wxss, /\.wish-row\s*\{[^}]*min-width:\s*0;/s);
  assert.match(wxss, /\.wish-main\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/s);
  assert.match(wxss, /\.wish-actions\s*\{[^}]*width:\s*112rpx;[^}]*min-width:\s*112rpx;/s);
});
