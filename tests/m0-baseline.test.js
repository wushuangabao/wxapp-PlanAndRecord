const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  APP_SCHEMA_VERSION,
  MAX_ACTIVE_PROJECTS,
  MAX_PLAN_PRIORITY,
  MAX_TAGS_PER_LOG,
  MAX_TAG_LENGTH
} = require('../miniprogram/domain/constants');

test('M0：领域常量固定为产品基线要求的值', () => {
  assert.equal(APP_SCHEMA_VERSION, 1);
  assert.equal(MAX_ACTIVE_PROJECTS, 5);
  assert.equal(MAX_PLAN_PRIORITY, 3);
  assert.equal(MAX_TAGS_PER_LOG, 10);
  assert.equal(MAX_TAG_LENGTH, 5);
});

test('M0：源码保持纯本地架构，不声明云端依赖', () => {
  const packageConfig = require('../package.json');

  assert.deepEqual(Object.keys(packageConfig.dependencies || {}), []);
});

test('M0：sitemap 仅收录业务页面，明确禁止收录数据恢复页', () => {
  const sitemap = require('../miniprogram/sitemap.json');

  assert.deepEqual(sitemap.rules, [
    {
      action: 'allow',
      page: 'pages/timer/index'
    },
    {
      action: 'disallow',
      page: 'pages/data-recovery/index'
    },
    {
      action: 'allow',
      page: 'pages/plans/index'
    },
    {
      action: 'allow',
      page: 'pages/calendar/index'
    },
    {
      action: 'allow',
      page: 'pages/profile/index'
    }
  ]);
});

test('M0：启动页为日历，数据恢复页已注册且不属于 tabBar', () => {
  const appConfig = require('../miniprogram/app.json');
  assert.equal(appConfig.pages[0], 'pages/calendar/index');
  assert.ok(appConfig.pages.includes('pages/data-recovery/index'));
  assert.equal(
    appConfig.tabBar.list.some((item) => item.pagePath === 'pages/data-recovery/index'),
    false
  );
});

test('M0：公共基础库与合法域名校验固定且私有高版本配置只提供未跟踪示例', () => {
  const projectConfig = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../project.config.json'),
    'utf8'
  ));
  const privateConfigExample = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../project.private.config.example.json'),
    'utf8'
  ));
  const gitignore = fs.readFileSync(path.join(__dirname, '../.gitignore'), 'utf8');

  assert.equal(projectConfig.libVersion, '2.25.4');
  assert.equal(projectConfig.setting.urlCheck, true);
  assert.deepEqual(privateConfigExample, {
    libVersion: '3.16.2',
    projectname: 'wxapp-PlanAndRecord',
    condition: {}
  });
  assert.match(gitignore, /^\/project\.private\.config\.json$/m);
});
