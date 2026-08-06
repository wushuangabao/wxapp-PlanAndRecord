const { clone } = require('../domain/entities');
const { StorageError } = require('../domain/errors');

const MIGRATION_STEPS = Object.freeze({});

function assertMigrationPath(fromVersion, targetVersion, steps = MIGRATION_STEPS) {
  if (!Number.isSafeInteger(fromVersion) || fromVersion < 0) {
    throw new StorageError(
      'DATA_CORRUPTED',
      '本地资料库版本信息无效，已停止写入以保护原始数据'
    );
  }
  for (let version = fromVersion; version < targetVersion; version += 1) {
    if (typeof steps[version] !== 'function') {
      throw new StorageError(
        'MIGRATION_PATH_MISSING',
        '当前版本缺少所需的数据升级步骤，原始数据已保留',
        { fromVersion: version, targetVersion }
      );
    }
  }
}

function migrateStepByStep(database, targetVersion, steps = MIGRATION_STEPS) {
  const sourceVersion = database && database.schemaVersion;
  assertMigrationPath(sourceVersion, targetVersion, steps);
  let current = clone(database);
  while (current.schemaVersion < targetVersion) {
    const fromVersion = current.schemaVersion;
    let next;
    try {
      next = steps[fromVersion](clone(current));
    } catch (error) {
      throw new StorageError('MIGRATION_FAILED', '数据升级步骤执行失败，原始数据已保留');
    }
    if (!next || next.schemaVersion !== fromVersion + 1) {
      throw new StorageError('MIGRATION_FAILED', '数据升级步骤返回了无效版本，原始数据已保留');
    }
    current = clone(next);
  }
  return current;
}

module.exports = {
  MIGRATION_STEPS,
  assertMigrationPath,
  migrateStepByStep
};
