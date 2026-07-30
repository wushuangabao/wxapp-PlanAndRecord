const test = require('node:test');
const assert = require('node:assert/strict');

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

test('M0：sitemap 允许微信搜索收录所有页面', () => {
  const sitemap = require('../miniprogram/sitemap.json');

  assert.deepEqual(sitemap.rules, [
    {
      action: 'allow',
      page: '*'
    }
  ]);
});
