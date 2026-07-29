const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const calendarWxmlPath = path.join(__dirname, '../miniprogram/pages/calendar/index.wxml');
const plansWxmlPath = path.join(__dirname, '../miniprogram/pages/plans/index.wxml');
const plansWxssPath = path.join(__dirname, '../miniprogram/pages/plans/index.wxss');

test('M3：已归档项目可在页面中恢复', () => {
  const wxml = fs.readFileSync(plansWxmlPath, 'utf8');
  assert.match(wxml, /已归档项目/);
  assert.match(wxml, /restoreProject/);
});

test('M3：计划页以 TODO LIST 和项目上下文入口替代任务收集表单', () => {
  const wxml = fs.readFileSync(plansWxmlPath, 'utf8');
  assert.ok(wxml.indexOf('TODO LIST') < wxml.indexOf('活动项目'));
  assert.match(wxml, /openStandaloneTask/);
  assert.match(wxml, /openChildTask/);
  assert.match(wxml, /openProjectTasks/);
  assert.match(wxml, /openKeyResult/);
  assert.match(wxml, /wx:if="{{isProjectCreateOpen}}"/);
  assert.doesNotMatch(wxml, /任务 \/ 备忘录/);
  assert.doesNotMatch(wxml, /加入收集箱/);
  assert.doesNotMatch(wxml, /整理为待办/);
});

test('计划页：TODO 使用三行横向列和图标操作', () => {
  const wxml = fs.readFileSync(plansWxmlPath, 'utf8');
  const wxss = fs.readFileSync(plansWxssPath, 'utf8');
  assert.match(wxml, /scroll-x="{{true}}"/);
  assert.doesNotMatch(wxml, /scroll-y="true"/);
  assert.match(wxml, /todoListColumns/);
  assert.match(wxml, /bindtouchstart="onTodoTouchStart"/);
  assert.match(wxml, /bindtouchend="onTodoTouchEnd"/);
  assert.match(wxml, /aria-label="关联项目"/);
  assert.match(wxml, /aria-label="删除"/);
  assert.match(wxml, /class="todo-scroll-tail" aria-hidden="true"/);
  assert.match(wxss, /\.todo-columns\s*\{[^}]*column-gap:\s*20%/s);
  assert.match(wxss, /\.todo-column\s*\{[^}]*flex:\s*0 0 60%/s);
  assert.match(wxss, /\.todo-scroll-tail\s*\{[^}]*flex:\s*0 0 20%/s);
  assert.doesNotMatch(wxss, /\.todo-row\s*\{[^}]*border-top/s);
});

test('M3：TODO 和项目的右上角新建入口为无底色深灰加号，页面不再显示悬浮按钮', () => {
  const wxml = fs.readFileSync(plansWxmlPath, 'utf8');
  const wxss = fs.readFileSync(plansWxssPath, 'utf8');
  assert.match(wxml, /class="section-add todo-add" bindtap="openStandaloneTask"/);
  assert.match(wxml, /class="section-add project-add" bindtap="openProjectCreate"/);
  assert.match(wxml, /section-heading"><view class="section-title">活动项目/);
  assert.doesNotMatch(wxml, /todo-fab|右下角 \+/);
  assert.doesNotMatch(wxss, /\.todo-fab\s*\{/);
  assert.match(wxss, /\.section-header\s*\{[^}]*box-sizing:\s*border-box;[^}]*width:\s*100%/s);
  assert.match(wxss, /\.section-heading\s*\{[^}]*flex:\s*1;/s);
  assert.match(wxss, /\.section-add\s*\{[^}]*flex:\s*0 0 54rpx;[^}]*border-radius:\s*0;[^}]*background:\s*transparent;[^}]*color:\s*#475569;/s);
});

test('M4：日历提供计划块编辑删除入口，重复实例编辑弹层只渲染一次', () => {
  const wxml = fs.readFileSync(calendarWxmlPath, 'utf8');
  assert.match(wxml, /openPlanEditor/);
  assert.match(wxml, /deletePlan/);
  assert.match(wxml, /savePlanEditor/);
  assert.equal((wxml.match(/修改重复实例/g) || []).length, 1);
});
