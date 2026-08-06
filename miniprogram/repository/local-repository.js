const { APP_SCHEMA_VERSION, TIMER_STATUS } = require('../domain/constants');
const { DomainError, StorageError } = require('../domain/errors');
const { createInitialDatabase, clone } = require('../domain/entities');
const { isFiniteTimestamp } = require('../domain/time');
const { normalizeJsonSnapshot, validateJsonSnapshot } = require('./json-snapshot');
const { buildStorageUsage, isLikelyCapacityFailure } = require('./storage-capacity');
const {
  MIGRATION_STEPS,
  assertMigrationPath,
  migrateStepByStep
} = require('./migrations');

const STORAGE_KEY = 'plan-and-record.database';
const BACKUP_KEY = 'plan-and-record.database.pre-migration';

class LocalRepository {
  constructor(storage, options = {}) {
    if (!storage || typeof storage.has !== 'function') {
      throw new TypeError('LocalRepository 需要 storage.has(key)');
    }
    this.storage = storage;
    this.now = options.now || Date.now;
    this.migrations = options.migrations || MIGRATION_STEPS;
    this.cache = null;
  }

  initialize() {
    if (this.cache) {
      return clone(this.cache);
    }
    this.restoreInterruptedMigration();
    let stored;
    let hasStoredDatabase;
    try {
      hasStoredDatabase = this.storage.has(STORAGE_KEY);
      if (hasStoredDatabase) stored = this.storage.get(STORAGE_KEY);
    } catch (error) {
      throw new StorageError('DATA_CORRUPTED', '无法读取本地资料库，已停止写入以保护原始数据');
    }
    if (!hasStoredDatabase) {
      const initial = createInitialDatabase(this.now());
      this.write(initial);
      return clone(this.cache);
    }
    const database = this.decode(stored);
    this.cache = this.migrate(database, stored);
    return clone(this.cache);
  }

  restoreInterruptedMigration() {
    let hasBackup;
    try {
      hasBackup = this.storage.has(BACKUP_KEY);
    } catch (error) {
      throw new StorageError('DATA_CORRUPTED', '无法读取本地资料库，已停止写入以保护原始数据');
    }
    if (!hasBackup) return;

    let oldMain;
    let backup;
    try {
      oldMain = this.captureStoredValue(STORAGE_KEY);
      backup = { exists: true, value: clone(this.storage.get(BACKUP_KEY)) };
    } catch (error) {
      throw new StorageError(
        'MIGRATION_ROLLBACK_UNCERTAIN',
        '检测到未完成的数据升级，但无法安全读取原始备份，请立即导出核对'
      );
    }

    try {
      this.storage.set(STORAGE_KEY, clone(backup.value));
      this.storage.remove(BACKUP_KEY);
    } catch (error) {
      const mainRestored = this.restoreStoredValue(STORAGE_KEY, oldMain);
      const backupRestored = this.restoreStoredValue(BACKUP_KEY, backup);
      const message = mainRestored && backupRestored
        ? '检测到未完成的数据升级，已停止启动以便核对原始数据'
        : '检测到未完成的数据升级，无法确认原始数据是否完整，请立即导出核对';
      throw new StorageError('MIGRATION_ROLLBACK_UNCERTAIN', message);
    }
  }

  read() {
    return clone(this.initialize());
  }

  getStorageUsage(snapshot) {
    let measuredValue = snapshot;
    if (arguments.length === 0) {
      measuredValue = this.initialize();
      try {
        if (this.storage.has(STORAGE_KEY)) measuredValue = this.storage.get(STORAGE_KEY);
      } catch (error) {
        // 主键原始表示暂不可读时，降级使用已校验的内存快照估算。
      }
    }
    let storageInfo = {};
    if (typeof this.storage.info === 'function') {
      try {
        storageInfo = this.storage.info();
      } catch (error) {
        // 总容量元信息不可用时，主资料库字节数仍然可以安全计算。
      }
    }
    return buildStorageUsage(measuredValue, storageInfo);
  }

  assertWritableSize(next) {
    const usage = this.getStorageUsage(next);
    if (usage.exceeded) {
      throw new StorageError(
        'STORAGE_CAPACITY_EXCEEDED',
        '本地资料库已达到容量上限，请先导出备份并删除不再需要的历史记录',
        { usage }
      );
    }
    return usage;
  }

  transaction(mutator, options = {}) {
    const next = this.read();
    const result = mutator(next);
    next.updatedAt = options.updatedAt === undefined ? this.now() : options.updatedAt;
    validateJsonSnapshot(next);
    this.writeTransaction(next);
    return {
      result,
      database: clone(this.cache)
    };
  }

  replace(next, { clearMigrationBackup = false } = {}) {
    const candidate = clone(next);
    validateJsonSnapshot(candidate);
    const usage = this.assertWritableSize(candidate);

    const oldCache = this.cache === null ? null : clone(this.cache);
    let oldMain;
    let oldBackup;
    try {
      oldMain = this.captureStoredValue(STORAGE_KEY);
      oldBackup = this.captureStoredValue(BACKUP_KEY);
    } catch (error) {
      throw new StorageError('WRITE_FAILED', '无法读取本地保存状态，未执行数据替换，请重新进入后重试');
    }

    let mainWriteAttempted = false;
    let failedDuringMainWrite = true;

    try {
      mainWriteAttempted = true;
      this.storage.set(STORAGE_KEY, clone(candidate));
      failedDuringMainWrite = false;
      if (clearMigrationBackup) {
        this.storage.remove(BACKUP_KEY);
      }
      this.cache = clone(candidate);
      return clone(this.cache);
    } catch (error) {
      let restorationComplete = true;
      if (mainWriteAttempted) {
        const mainRestored = this.restoreStoredValue(STORAGE_KEY, oldMain);
        const backupRestored = this.restoreStoredValue(BACKUP_KEY, oldBackup);
        restorationComplete = mainRestored && backupRestored;
      }
      this.cache = oldCache;
      const message = restorationComplete
        ? '本地保存失败，已保留当前数据，请重试或导出已有数据'
        : '本地保存失败，无法确认原数据是否完整保留，请重新进入核对并尽快导出';
      const code = restorationComplete
        && failedDuringMainWrite
        && isLikelyCapacityFailure(error, usage.databaseBytes)
        ? 'STORAGE_CAPACITY_EXCEEDED'
        : 'WRITE_FAILED';
      throw new StorageError(code, message, code === 'STORAGE_CAPACITY_EXCEEDED' ? { usage } : null);
    }
  }

  reset() {
    return this.replace(createInitialDatabase(this.now()), {
      clearMigrationBackup: true
    });
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

  migrate(database, rawStoredValue = database) {
    if (!Number.isSafeInteger(database.schemaVersion) || database.schemaVersion < 0) {
      throw new StorageError('DATA_CORRUPTED', '本地资料库缺少版本信息，已停止写入以保护原始数据');
    }
    if (database.schemaVersion > APP_SCHEMA_VERSION) {
      throw new StorageError('DATA_VERSION_UNSUPPORTED', '数据版本较新，当前版本不会覆盖原有数据');
    }
    if (database.schemaVersion === APP_SCHEMA_VERSION) {
      const compatibleDatabase = normalizeJsonSnapshot(database);
      this.validateStoredSnapshot(compatibleDatabase);
      return compatibleDatabase;
    }
    return this.migrateStoredDatabase(database, rawStoredValue);
  }

  migrateStoredDatabase(database, rawStoredValue) {
    assertMigrationPath(database.schemaVersion, APP_SCHEMA_VERSION, this.migrations);
    const oldMain = { exists: true, value: clone(rawStoredValue) };
    const oldBackup = { exists: false, value: null };
    let backupWriteAttempted = false;
    let mainWriteAttempted = false;

    try {
      backupWriteAttempted = true;
      this.storage.set(BACKUP_KEY, clone(rawStoredValue));

      const migrated = migrateStepByStep(database, APP_SCHEMA_VERSION, this.migrations);
      const compatibleDatabase = normalizeJsonSnapshot(migrated);
      this.validateStoredSnapshot(compatibleDatabase);
      this.assertWritableSize(compatibleDatabase);

      mainWriteAttempted = true;
      this.storage.set(STORAGE_KEY, clone(compatibleDatabase));
      this.storage.remove(BACKUP_KEY);
      this.cache = clone(compatibleDatabase);
      return clone(this.cache);
    } catch (error) {
      const mainRestored = !mainWriteAttempted
        || this.restoreStoredValue(STORAGE_KEY, oldMain);
      const backupRestored = !backupWriteAttempted
        || (mainWriteAttempted && !mainRestored
          ? this.restoreStoredValue(BACKUP_KEY, {
            exists: true,
            value: rawStoredValue
          })
          : this.restoreStoredValue(BACKUP_KEY, oldBackup));
      this.cache = null;
      if (!mainRestored || !backupRestored) {
        throw new StorageError(
          'MIGRATION_ROLLBACK_UNCERTAIN',
          '数据升级中断，无法确认原始数据是否完整，请立即导出核对'
        );
      }
      if (error instanceof StorageError && error.code === 'MIGRATION_PATH_MISSING') {
        throw error;
      }
      throw new StorageError('MIGRATION_FAILED', '数据升级未完成，原始数据已恢复且不会被覆盖');
    }
  }

  validateStoredSnapshot(database) {
    try {
      const snapshotForValidation = clone(database);
      const timerStatus = database && database.timer && database.timer.status;
      if (timerStatus === TIMER_STATUS.RUNNING || timerStatus === TIMER_STATUS.PAUSED) {
        snapshotForValidation.timer = this.normalizeRecoverableTimerForValidation(database.timer);
      }
      if (database && database.recoveryDraft && Object.prototype.hasOwnProperty.call(database.recoveryDraft, 'timer')) {
        const hasCandidatePreview = Object.prototype.hasOwnProperty.call(
          database.recoveryDraft,
          'candidatePreview'
        );
        if (!hasCandidatePreview) {
          snapshotForValidation.recoveryDraft.timer = this.normalizeRecoverableTimerForValidation(
            database.recoveryDraft.timer
          );
        }
      }
      validateJsonSnapshot(snapshotForValidation);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'IMPORT_SCHEMA_UNSUPPORTED') {
        throw new StorageError('DATA_VERSION_UNSUPPORTED', '数据版本不受支持，当前版本不会覆盖原有数据');
      }
      throw new StorageError('DATA_CORRUPTED', '本地资料库已损坏，已停止写入以保护原始数据');
    }
  }

  normalizeRecoverableTimerForValidation(timer) {
    const isPlainObject = timer && typeof timer === 'object' && !Array.isArray(timer)
      && [Object.prototype, null].includes(Object.getPrototypeOf(timer));
    const requiredFields = ['status', 'startedAt', 'pausedAt', 'pauses', 'draft'];
    const hasRequiredFields = isPlainObject
      && requiredFields.every((field) => Object.prototype.hasOwnProperty.call(timer, field));
    const validStatus = hasRequiredFields && Object.values(TIMER_STATUS).includes(timer.status);
    const validNullableTimestamp = (value) => value === null || isFiniteTimestamp(value);
    const validTimestamps = hasRequiredFields
      && validNullableTimestamp(timer.startedAt)
      && validNullableTimestamp(timer.pausedAt);
    const validPauses = hasRequiredFields && Array.isArray(timer.pauses)
      && timer.pauses.every((pause) => {
        const pauseIsPlainObject = pause && typeof pause === 'object' && !Array.isArray(pause)
          && [Object.prototype, null].includes(Object.getPrototypeOf(pause));
        return pauseIsPlainObject
          && Object.prototype.hasOwnProperty.call(pause, 'startedAt')
          && Object.prototype.hasOwnProperty.call(pause, 'endedAt')
          && isFiniteTimestamp(pause.startedAt)
          && isFiniteTimestamp(pause.endedAt);
      });
    if (!validStatus || !validTimestamps || !validPauses) {
      throw new DomainError('IMPORT_SCHEMA_INVALID', '本地活动计时结构无效');
    }

    const normalized = clone(timer);
    normalized.pauses = [];
    normalized.startedAt = timer.status === TIMER_STATUS.IDLE ? null : 1;
    normalized.pausedAt = timer.status === TIMER_STATUS.PAUSED ? 2 : null;
    return normalized;
  }

  write(next) {
    const usage = this.assertWritableSize(next);
    try {
      this.storage.set(STORAGE_KEY, clone(next));
      this.cache = clone(next);
    } catch (error) {
      if (isLikelyCapacityFailure(error, usage.databaseBytes)) {
        throw new StorageError(
          'STORAGE_CAPACITY_EXCEEDED',
          '本地资料库可能已达到容量上限，请先导出备份并删除不再需要的历史记录',
          { usage }
        );
      }
      throw new StorageError('WRITE_FAILED', '本地保存失败，已保留当前表单内容，请重试或导出已有数据');
    }
  }

  writeTransaction(next) {
    const usage = this.assertWritableSize(next);
    const oldCache = this.cache === null ? null : clone(this.cache);
    let oldMain;
    try {
      const exists = this.storage.has(STORAGE_KEY);
      oldMain = {
        exists,
        value: exists ? clone(oldCache) : null
      };
    } catch (error) {
      throw new StorageError('WRITE_FAILED', '无法读取本地保存状态，未执行事务写入，请重新进入后重试');
    }

    let mainWriteAttempted = false;
    try {
      mainWriteAttempted = true;
      this.storage.set(STORAGE_KEY, clone(next));
      this.cache = clone(next);
    } catch (error) {
      const restorationComplete = !mainWriteAttempted
        || this.restoreStoredValue(STORAGE_KEY, oldMain);
      this.cache = oldCache;
      const message = restorationComplete
        ? '本地保存失败，已保留当前数据，请重试或导出已有数据'
        : '本地保存失败，无法确认原数据是否完整保留，请重新进入核对并尽快导出';
      const code = restorationComplete && isLikelyCapacityFailure(error, usage.databaseBytes)
        ? 'STORAGE_CAPACITY_EXCEEDED'
        : 'WRITE_FAILED';
      throw new StorageError(code, message, code === 'STORAGE_CAPACITY_EXCEEDED' ? { usage } : null);
    }
  }

  captureStoredValue(key) {
    const exists = this.storage.has(key);
    return {
      exists,
      value: exists ? clone(this.storage.get(key)) : null
    };
  }

  restoreStoredValue(key, captured) {
    try {
      if (captured.exists) {
        this.storage.set(key, clone(captured.value));
      } else {
        this.storage.remove(key);
      }
      return true;
    } catch (error) {
      // 写入失败后的补偿必须尽力而为，不能泄露原始数据内容。
      return false;
    }
  }
}

module.exports = {
  LocalRepository,
  STORAGE_KEY,
  BACKUP_KEY
};
