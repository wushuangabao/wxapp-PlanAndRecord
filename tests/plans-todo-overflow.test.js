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
