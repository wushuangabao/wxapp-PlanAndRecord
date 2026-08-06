const test = require('node:test');
const assert = require('node:assert/strict');

const { StorageError } = require('../miniprogram/domain/errors');
const {
  MIGRATION_STEPS,
  assertMigrationPath,
  migrateStepByStep
} = require('../miniprogram/repository/migrations');

test('生产迁移注册表默认为空且不可变', () => {
  assert.deepEqual(MIGRATION_STEPS, {});
  assert.equal(Object.isFrozen(MIGRATION_STEPS), true);
});

test('逐级迁移严格执行 1 -> 2 -> 3 且不修改输入', () => {
  const source = { schemaVersion: 1, values: [] };
  const migrated = migrateStepByStep(source, 3, {
    1: (value) => ({ ...value, schemaVersion: 2, values: value.values.concat('v2') }),
    2: (value) => ({ ...value, schemaVersion: 3, values: value.values.concat('v3') })
  });

  assert.deepEqual(migrated, { schemaVersion: 3, values: ['v2', 'v3'] });
  assert.deepEqual(source, { schemaVersion: 1, values: [] });
});

test('迁移缺口显式报告起始版本且不会执行后续步骤', () => {
  let calls = 0;
  assert.throws(
    () => migrateStepByStep({ schemaVersion: 1 }, 3, {
      2: (value) => { calls += 1; return { ...value, schemaVersion: 3 }; }
    }),
    (error) => error instanceof StorageError
      && error.code === 'MIGRATION_PATH_MISSING'
      && error.details.fromVersion === 1
      && error.details.targetVersion === 3
  );
  assert.equal(calls, 0);
});

test('迁移路径拒绝不安全或负数版本，避免无界循环', () => {
  for (const version of [-1, Number.MIN_SAFE_INTEGER - 1]) {
    assert.throws(
      () => assertMigrationPath(version, 1, {}),
      (error) => error instanceof StorageError && error.code === 'DATA_CORRUPTED'
    );
  }
});

test('迁移步骤抛错或越级时只返回安全失败信息', () => {
  const sentinel = 'private-migration-sentinel';
  for (const steps of [
    { 1: () => { throw new Error(sentinel); } },
    { 1: (value) => ({ ...value, schemaVersion: 3 }) }
  ]) {
    assert.throws(
      () => migrateStepByStep({ schemaVersion: 1 }, 2, steps),
      (error) => error instanceof StorageError
        && error.code === 'MIGRATION_FAILED'
        && !error.message.includes(sentinel)
    );
  }
});
