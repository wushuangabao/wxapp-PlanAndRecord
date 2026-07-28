const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const calendarWxmlPath = path.join(__dirname, '../miniprogram/pages/calendar/index.wxml');
const plansWxmlPath = path.join(__dirname, '../miniprogram/pages/plans/index.wxml');

test('M3：已归档项目可在页面中恢复', () => {
  const wxml = fs.readFileSync(plansWxmlPath, 'utf8');
  assert.match(wxml, /已归档项目/);
  assert.match(wxml, /restoreProject/);
});

test('M4：日历提供计划块编辑删除入口，重复实例编辑弹层只渲染一次', () => {
  const wxml = fs.readFileSync(calendarWxmlPath, 'utf8');
  assert.match(wxml, /openPlanEditor/);
  assert.match(wxml, /deletePlan/);
  assert.match(wxml, /savePlanEditor/);
  assert.equal((wxml.match(/修改重复实例/g) || []).length, 1);
});
