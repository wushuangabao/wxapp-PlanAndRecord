const { createInitialDatabase, clone } = require('../domain/entities');
const { DomainError } = require('../domain/errors');
const { createId } = require('../domain/id');
const { IMPORT_MODE, createImportAnalysis, resolveImportAnalysis } = require('../repository/json-import');
const { parseJsonSnapshot } = require('../repository/json-snapshot');
const { BACKUP_KEY, STORAGE_KEY } = require('../repository/local-repository');

class DataRecoveryService {
  constructor({ repository, storage, exportTempFileStore, preferenceStore = null, now = Date.now }) {
    this.repository = repository;
    this.storage = storage;
    this.exportTempFileStore = exportTempFileStore;
    this.preferenceStore = preferenceStore;
    this.now = now;
    this.pendingReplacements = new Map();
  }

  exportRawData() {
    let exportKey = STORAGE_KEY;
    if (typeof this.storage.has === 'function') {
      try {
        if (this.storage.has(BACKUP_KEY)) exportKey = BACKUP_KEY;
      } catch (error) {
        // 无法枚举键时仍尽力导出当前主键原始值。
      }
    }
    const rawValue = this.storage.get(exportKey);
    if (typeof rawValue === 'string') return rawValue;
    try {
      const jsonText = JSON.stringify(rawValue, null, 2);
      return jsonText === undefined ? String(rawValue) : jsonText;
    } catch (error) {
      return String(rawValue);
    }
  }

  prepareReplacement(jsonText) {
    const importedDatabase = parseJsonSnapshot(jsonText);
    const now = this.now();
    const analysis = createImportAnalysis(
      createInitialDatabase(now),
      importedDatabase,
      { mode: IMPORT_MODE.REPLACE, now }
    );
    const resolved = resolveImportAnalysis(analysis);
    const token = createId('recovery-replacement', now);
    this.pendingReplacements.set(token, clone(resolved.database));
    return {
      token,
      schemaVersion: importedDatabase.schemaVersion,
      addedCounts: clone(resolved.summary.addedCounts),
      repairedReferenceCount: resolved.summary.repairedReferenceCount,
      discardedExceptionCount: resolved.summary.discardedExceptionCount,
      resetsRuntime: true
    };
  }

  requireReplacement(token) {
    const database = this.pendingReplacements.get(token);
    if (!database) {
      throw new DomainError('RECOVERY_REPLACEMENT_NOT_FOUND', '恢复预览已失效，请重新选择 JSON 文件');
    }
    return database;
  }

  commitReplacement(token) {
    const database = this.requireReplacement(token);
    this.pendingReplacements.delete(token);
    this.repository.replace(database, { clearMigrationBackup: true });
    if (this.preferenceStore
      && typeof this.preferenceStore.clearAllBestEffort === 'function') {
      this.preferenceStore.clearAllBestEffort();
    }
    return { replaced: true };
  }

  cancelReplacement(token) {
    this.pendingReplacements.delete(token);
  }

  clearAllData(confirmed) {
    if (confirmed !== true) {
      throw new DomainError('CLEAR_CONFIRMATION_REQUIRED', '清空全部本地数据需要明确确认');
    }
    if (!this.exportTempFileStore || typeof this.exportTempFileStore.removeAllStrict !== 'function') {
      throw new DomainError(
        'EXPORT_TEMP_FILE_STORE_UNAVAILABLE',
        '无法确认临时导出文件已清理，数据未清空，请重试'
      );
    }
    this.exportTempFileStore.removeAllStrict();
    const database = createInitialDatabase(this.now());
    const capturedPreferences = this.preferenceStore
      && typeof this.preferenceStore.clearAllStrict === 'function'
      ? this.preferenceStore.clearAllStrict()
      : null;
    try {
      this.repository.replace(database, { clearMigrationBackup: true });
    } catch (error) {
      const preferencesRestored = !capturedPreferences
        || (typeof this.preferenceStore.restoreAllBestEffort === 'function'
          && this.preferenceStore.restoreAllBestEffort(capturedPreferences));
      if (!preferencesRestored) {
        if (error && typeof error.code === 'string' && typeof error.message === 'string') {
          error.message = `${error.message}；界面设置可能已重置，请重新进入核对`;
          throw error;
        }
        throw new DomainError(
          'CLEAR_PREFERENCE_RESTORE_UNCERTAIN',
          '业务资料库清空未完成，界面设置可能已重置，请重新进入核对并尽快导出'
        );
      }
      throw error;
    }
    this.pendingReplacements.clear();
    return {
      cleared: true,
      localProfileId: database.localProfile.id
    };
  }
}

module.exports = {
  DataRecoveryService
};
