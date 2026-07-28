const { APP_SCHEMA_VERSION } = require('../domain/constants');
const { StorageError } = require('../domain/errors');
const { createInitialDatabase, clone } = require('../domain/entities');

const STORAGE_KEY = 'plan-and-record.database';
const BACKUP_KEY = 'plan-and-record.database.pre-migration';

class LocalRepository {
  constructor(storage, options = {}) {
    this.storage = storage;
    this.now = options.now || Date.now;
    this.cache = null;
  }

  initialize() {
    if (this.cache) {
      return clone(this.cache);
    }
    const stored = this.storage.get(STORAGE_KEY);
    if (!stored) {
      const initial = createInitialDatabase(this.now());
      this.write(initial);
      return clone(this.cache);
    }
    const database = this.decode(stored);
    this.cache = this.migrate(database);
    return clone(this.cache);
  }

  read() {
    return clone(this.initialize());
  }

  transaction(mutator) {
    const next = this.read();
    const result = mutator(next);
    next.updatedAt = this.now();
    this.write(next);
    return {
      result,
      database: clone(this.cache)
    };
  }

  replace(next) {
    this.write(next);
    return this.read();
  }

  exportSnapshot() {
    return this.read();
  }

  decode(stored) {
    if (typeof stored === 'string') {
      try {
        return JSON.parse(stored);
      } catch (error) {
        throw new StorageError('DATA_CORRUPTED', '本地资料库已损坏，已停止写入以保护原始数据');
      }
    }
    if (!stored || typeof stored !== 'object') {
      throw new StorageError('DATA_CORRUPTED', '本地资料库格式无效，已停止写入以保护原始数据');
    }
    return stored;
  }

  migrate(database) {
    if (!Number.isInteger(database.schemaVersion)) {
      throw new StorageError('DATA_CORRUPTED', '本地资料库缺少版本信息，已停止写入以保护原始数据');
    }
    if (database.schemaVersion > APP_SCHEMA_VERSION) {
      throw new StorageError('DATA_VERSION_UNSUPPORTED', '数据版本较新，当前版本不会覆盖原有数据');
    }
    if (database.schemaVersion === APP_SCHEMA_VERSION) {
      return database;
    }
    try {
      this.storage.set(BACKUP_KEY, clone(database));
      throw new StorageError('DATA_VERSION_UNSUPPORTED', '当前版本不支持该历史数据迁移，原始数据已保留');
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError('MIGRATION_BACKUP_FAILED', '无法创建迁移前快照，已停止写入');
    }
  }

  write(next) {
    try {
      this.storage.set(STORAGE_KEY, clone(next));
      this.cache = clone(next);
    } catch (error) {
      throw new StorageError('WRITE_FAILED', '本地保存失败，已保留当前表单内容，请重试或导出已有数据');
    }
  }
}

module.exports = {
  LocalRepository,
  STORAGE_KEY,
  BACKUP_KEY
};
