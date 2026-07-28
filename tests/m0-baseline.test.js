const test = require('node:test');
const assert = require('node:assert/strict');

const { APP_SCHEMA_VERSION, MAX_ACTIVE_PROJECTS, MAX_PLAN_PRIORITY, DEFAULT_CATEGORY_NAME } = require('../miniprogram/domain/constants');

test('M0：领域常量固定为产品基线要求的值', () => {
  assert.equal(APP_SCHEMA_VERSION, 1);
  assert.equal(MAX_ACTIVE_PROJECTS, 5);
  assert.equal(MAX_PLAN_PRIORITY, 3);
  assert.equal(DEFAULT_CATEGORY_NAME, '未分类');
});

test('M0：源码保持纯本地架构，不声明云端依赖', () => {
  const packageConfig = require('../package.json');

  assert.deepEqual(Object.keys(packageConfig.dependencies || {}), []);
});
